import { describe, it, expect, afterEach, spyOn } from "bun:test";
import { enforceApiKey } from "../src/guards/api-key.ts";
import { getRequestKeyId } from "../src/domain/api-keys.ts";
import * as storage from "../src/observability/storage.ts";
import * as logger from "../src/observability/logger.ts";
import type { ApiKeyRecord } from "../src/observability/types.ts";

// enforceApiKey reads REQUIRE_API_KEY + API_KEY_PEPPER at call time. Save and
// restore the env, and restore any spies, after every test.
const savedRequire = Bun.env.REQUIRE_API_KEY;
const savedPepper = Bun.env.API_KEY_PEPPER;
let spies: Array<{ mockRestore: () => void }> = [];

afterEach(() => {
  for (const s of spies) s.mockRestore();
  spies = [];
  if (savedRequire === undefined) delete Bun.env.REQUIRE_API_KEY;
  else Bun.env.REQUIRE_API_KEY = savedRequire;
  if (savedPepper === undefined) delete Bun.env.API_KEY_PEPPER;
  else Bun.env.API_KEY_PEPPER = savedPepper;
});

function enable() {
  Bun.env.REQUIRE_API_KEY = "true";
  Bun.env.API_KEY_PEPPER = "test-pepper";
}

function stubKeyLookup(record: ApiKeyRecord | null) {
  const spy = spyOn(storage, "getApiKeyByHash").mockReturnValue(record);
  spies.push(spy);
  return spy;
}

function spyEmit() {
  const spy = spyOn(logger, "emit").mockImplementation(() => {});
  spies.push(spy);
  return spy;
}

const req = (path: string, headers: Record<string, string> = {}) =>
  new Request(`http://localhost${path}`, { headers });

const ACTIVE_KEY: ApiKeyRecord = {
  id: 7,
  prefix: "cpk_deadbeef",
  key_hash: "stored-digest",
  label: "ci-runner",
  created_at: "2026-01-01T00:00:00Z",
  revoked_at: null,
};

// ---------------------------------------------------------------------------
// Enforcement disabled → always pass  (401 Enforcement Gate: flag disabled)
// ---------------------------------------------------------------------------

describe("guard — enforceApiKey: REQUIRE_API_KEY=false", () => {
  it("passes (null) a gated route with no key when enforcement is off", () => {
    delete Bun.env.REQUIRE_API_KEY; // default = disabled
    const lookup = stubKeyLookup(null);
    expect(enforceApiKey(req("/v1/chat/completions"))).toBeNull();
    // Enforcement off must short-circuit BEFORE any storage lookup.
    expect(lookup).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Exempt routes → pass even when enforcement is on  (Exempt Routes)
// ---------------------------------------------------------------------------

describe("guard — enforceApiKey: exempt routes", () => {
  it("passes (null) GET /health with no key even when enforcement is on", () => {
    enable();
    const lookup = stubKeyLookup(null);
    expect(enforceApiKey(req("/health"))).toBeNull();
    expect(lookup).not.toHaveBeenCalled();
  });

  it("passes (null) the SPA root `/` and `/assets/*` with no key", () => {
    enable();
    stubKeyLookup(null);
    expect(enforceApiKey(req("/"))).toBeNull();
    expect(enforceApiKey(req("/assets/app.js"))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Gated routes, missing / invalid / revoked → 401  (401 Enforcement Gate)
// ---------------------------------------------------------------------------

describe("guard — enforceApiKey: gated rejection → 401", () => {
  it("rejects a gated /v1/* route with no key (401 JSON) and logs auth.rejected", () => {
    enable();
    stubKeyLookup(null);
    const emit = spyEmit();

    const res = enforceApiKey(req("/v1/chat/completions"));
    expect(res).toBeInstanceOf(Response);
    expect(res!.status).toBe(401);
    expect(res!.headers.get("content-type")).toContain("application/json");
    expect(emit).toHaveBeenCalledWith(
      "warn",
      "auth.rejected",
      expect.objectContaining({ path: "/v1/chat/completions" })
    );
  });

  it("gates the /api/* telemetry surface too (metrics with no key → 401)", () => {
    enable();
    stubKeyLookup(null);
    const res = enforceApiKey(req("/api/telemetry/metrics"));
    expect(res!.status).toBe(401);
  });

  it("rejects an unknown key with 401 (lookup returns null)", () => {
    enable();
    const lookup = stubKeyLookup(null);
    const res = enforceApiKey(
      req("/v1/chat/completions", { Authorization: "Bearer cpk_x.unknown-secret" })
    );
    expect(res!.status).toBe(401);
    // The presented key WAS hashed and looked up (unlike the missing-key path).
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("rejects a revoked key with 401 (active-only lookup returns null)", () => {
    enable();
    // getApiKeyByHash filters `revoked_at IS NULL`, so a revoked key yields null.
    stubKeyLookup(null);
    const res = enforceApiKey(
      req("/api/telemetry/usage", { "X-API-Key": "cpk_x.revoked-secret" })
    );
    expect(res!.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Gated route, valid active key → pass + attributed  (Fast Hash Validation)
// ---------------------------------------------------------------------------

describe("guard — enforceApiKey: gated valid key", () => {
  it("passes (null) and attributes the key id to the request via the WeakMap", () => {
    enable();
    stubKeyLookup(ACTIVE_KEY);
    const request = req("/v1/chat/completions", { Authorization: "Bearer cpk_deadbeef.good" });

    const res = enforceApiKey(request);
    expect(res).toBeNull();
    // Attribution: the validated api_keys.id is stashed for withObservability.
    expect(getRequestKeyId(request)).toBe(7);
  });

  it("accepts the key from X-API-Key as well as Bearer", () => {
    enable();
    stubKeyLookup(ACTIVE_KEY);
    const request = req("/api/telemetry/usage", { "X-API-Key": "cpk_deadbeef.good" });
    expect(enforceApiKey(request)).toBeNull();
    expect(getRequestKeyId(request)).toBe(7);
  });
});
