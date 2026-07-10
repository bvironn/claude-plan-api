import { describe, it, expect, afterEach, spyOn } from "bun:test";
import { handleRequest } from "../src/http/server.ts";
import * as storage from "../src/observability/storage.ts";
import * as modelsDomain from "../src/domain/models.ts";
import type { ApiKeyRecord } from "../src/observability/types.ts";

/**
 * Dispatch-level integration test. Unlike `__tests__/observability.spec.ts`
 * (which spawns the real server via `Bun.spawn`), this drives the exported
 * `handleRequest(req)` in-process with real `Request` objects (design decision
 * #8). It proves the pre-dispatch `enforceApiKey` gate is LIVE: gated routes
 * 401 without a key, exempt routes bypass, a valid key authenticates AND is
 * attributed to the observability row, and `REQUIRE_API_KEY=false` leaves
 * dispatch completely unchanged.
 *
 * enforceApiKey reads REQUIRE_API_KEY + API_KEY_PEPPER at call time; save and
 * restore the env, and restore all spies, after every test.
 */
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

function push<T extends { mockRestore: () => void }>(spy: T): T {
  spies.push(spy);
  return spy;
}

function enable() {
  Bun.env.REQUIRE_API_KEY = "true";
  Bun.env.API_KEY_PEPPER = "test-pepper";
}

function stubKeyLookup(record: ApiKeyRecord | null) {
  return push(spyOn(storage, "getApiKeyByHash").mockReturnValue(record));
}

// Keep the observability write out of the real DB and let us inspect the row.
function stubInsertRequest() {
  return push(spyOn(storage, "insertRequest").mockImplementation(() => {}));
}
function stubUpdateRequest() {
  return push(spyOn(storage, "updateRequest").mockImplementation(() => {}));
}
// Avoid an upstream network call from GET /v1/models — deterministic catalog.
function stubModelRegistry() {
  return push(spyOn(modelsDomain, "refreshRegistry").mockResolvedValue([]));
}

const ACTIVE_KEY: ApiKeyRecord = {
  id: 7,
  prefix: "cpk_deadbeef",
  key_hash: "stored-digest",
  label: "ci-runner",
  created_at: "2026-01-01T00:00:00Z",
  revoked_at: null,
};

// ---------------------------------------------------------------------------
// REQUIRE_API_KEY=true → gated routes reject with 401 before observability
// ---------------------------------------------------------------------------

describe("dispatch — enforcement ON: gated routes → 401", () => {
  it("rejects POST /v1/chat/completions with no key (401) and never writes a request row", async () => {
    enable();
    stubKeyLookup(null);
    const ins = stubInsertRequest();
    stubUpdateRequest();

    const res = await handleRequest(
      new Request("http://localhost/v1/chat/completions", { method: "POST" })
    );

    expect(res.status).toBe(401);
    // Design decision #1: the 401 short-circuits BEFORE withObservability's
    // insertRequest ever fires for a rejected request.
    expect(ins).not.toHaveBeenCalled();
  });

  it("gates the telemetry surface: GET /api/telemetry/metrics with no key → 401", async () => {
    enable();
    stubKeyLookup(null);
    const res = await handleRequest(
      new Request("http://localhost/api/telemetry/metrics")
    );
    expect(res.status).toBe(401);
  });

  it("gates the NEW usage route: GET /api/telemetry/usage with no key → 401", async () => {
    enable();
    stubKeyLookup(null);
    const res = await handleRequest(
      new Request("http://localhost/api/telemetry/usage")
    );
    expect(res.status).toBe(401);
  });

  it("rejects an unknown/revoked key on a gated route → 401", async () => {
    enable();
    // active-only lookup returns null for unknown OR revoked keys.
    stubKeyLookup(null);
    const res = await handleRequest(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: "Bearer cpk_x.unknown-or-revoked" },
      })
    );
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// REQUIRE_API_KEY=true → exempt routes bypass the gate (no key needed)
// ---------------------------------------------------------------------------

describe("dispatch — enforcement ON: exempt routes bypass", () => {
  it("serves GET /health with no key (200) even when enforcement is on", async () => {
    enable();
    const lookup = stubKeyLookup(null);

    const res = await handleRequest(new Request("http://localhost/health"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
    // /health is not gated → the guard never consults the key store.
    expect(lookup).not.toHaveBeenCalled();
  });

  it("serves a static asset path with no key (404 miss, NOT 401) — proves the asset surface is un-gated", async () => {
    enable();
    const lookup = stubKeyLookup(null);

    // No UI build in test → a missing /assets/* file returns 404 from
    // serveStatic. The point: it is 404 (route logic ran), NOT 401 (gate).
    const res = await handleRequest(
      new Request("http://localhost/assets/nonexistent.js")
    );

    expect(res.status).toBe(404);
    expect(res.status).not.toBe(401);
    expect(lookup).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// REQUIRE_API_KEY=true → valid key authenticates AND is attributed
// ---------------------------------------------------------------------------

describe("dispatch — enforcement ON: valid key authenticates + attributes", () => {
  it("passes a valid Bearer key to the handler (200) and attributes api_key_id on the request row", async () => {
    enable();
    stubKeyLookup(ACTIVE_KEY);
    stubModelRegistry();
    stubUpdateRequest();
    let captured: { api_key_id?: number } | null = null;
    push(
      spyOn(storage, "insertRequest").mockImplementation((rec) => {
        captured = rec as { api_key_id?: number };
      })
    );

    const res = await handleRequest(
      new Request("http://localhost/v1/models", {
        headers: { Authorization: "Bearer cpk_deadbeef.good-secret" },
      })
    );

    expect(res.status).toBe(200);
    // Attribution flows guard.setRequestKeyId(req) → withObservability get →
    // insertRequest({ api_key_id }). The SAME req identity carries the id.
    expect(captured).not.toBeNull();
    expect(captured!.api_key_id).toBe(7);
  });

  it("accepts the key via X-API-Key as well as Bearer (200 + attributed)", async () => {
    enable();
    stubKeyLookup(ACTIVE_KEY);
    stubModelRegistry();
    stubUpdateRequest();
    let captured: { api_key_id?: number } | null = null;
    push(
      spyOn(storage, "insertRequest").mockImplementation((rec) => {
        captured = rec as { api_key_id?: number };
      })
    );

    const res = await handleRequest(
      new Request("http://localhost/v1/models", {
        headers: { "X-API-Key": "cpk_deadbeef.good-secret" },
      })
    );

    expect(res.status).toBe(200);
    expect(captured!.api_key_id).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// REQUIRE_API_KEY=false (default) → dispatch is completely unchanged
// ---------------------------------------------------------------------------

describe("dispatch — enforcement OFF: gate is a no-op", () => {
  it("dispatches a gated route with NO key (200) and never consults the key store", async () => {
    delete Bun.env.REQUIRE_API_KEY; // default = disabled
    const lookup = stubKeyLookup(ACTIVE_KEY);
    stubModelRegistry();
    stubInsertRequest();
    stubUpdateRequest();

    const res = await handleRequest(new Request("http://localhost/v1/models"));

    expect(res.status).toBe(200);
    // Enforcement off → the guard short-circuits before any lookup, so dispatch
    // behaves exactly as it did before this PR.
    expect(lookup).not.toHaveBeenCalled();
  });
});
