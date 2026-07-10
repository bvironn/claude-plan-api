import { describe, it, expect, afterEach, spyOn } from "bun:test";
import {
  handleKeysList,
  handleKeysCreate,
  handleKeysRevoke,
} from "../src/http/routes/keys.ts";
import * as storage from "../src/observability/storage.ts";
import type { ApiKeyMeta, ApiKeyRecord } from "../src/observability/types.ts";

/**
 * Route-level test for the API-key admin endpoints. Mirrors
 * `telemetry-usage-route.spec.ts`: `spyOn(storage)` + real `Request` objects so
 * the assertions cover only the route's own shaping/guard behavior, not the DB.
 *
 * Unlike the telemetry routes, `/api/keys` is NOT a SILENT_PATH_PREFIX, so the
 * `withObservability` wrapper runs fully — but with no `initStorage()` its
 * `insertRequest`/`updateRequest` are `if (!db) return` no-ops, so calling the
 * wrapped handlers directly is still deterministic.
 *
 * The create handler reads `API_KEY_PEPPER` at call time (fail-fast guardrail),
 * so save/restore the env after every test.
 */
const savedPepper = Bun.env.API_KEY_PEPPER;
let spies: Array<{ mockRestore: () => void }> = [];

afterEach(() => {
  for (const s of spies) s.mockRestore();
  spies = [];
  if (savedPepper === undefined) delete Bun.env.API_KEY_PEPPER;
  else Bun.env.API_KEY_PEPPER = savedPepper;
});

function push<T extends { mockRestore: () => void }>(spy: T): T {
  spies.push(spy);
  return spy;
}

const SAMPLE_META: ApiKeyMeta[] = [
  { id: 2, prefix: "cpk_newer", label: "newer", created_at: "2026-03-01T00:00:00Z", revoked_at: null, is_admin: 1 },
  { id: 1, prefix: "cpk_older", label: "older", created_at: "2026-01-01T00:00:00Z", revoked_at: "2026-02-01T00:00:00Z", is_admin: 0 },
];

// ---------------------------------------------------------------------------
// GET /api/keys
// ---------------------------------------------------------------------------

describe("route — GET /api/keys", () => {
  it("returns { keys: ApiKeyMeta[] } exactly as listApiKeys provides, and no item exposes key_hash", async () => {
    const spy = push(spyOn(storage, "listApiKeys").mockReturnValue(SAMPLE_META));

    const res = await handleKeysList(new Request("http://localhost/api/keys"));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");

    const body = (await res.json()) as { keys: ApiKeyMeta[] };
    expect(body.keys).toEqual(SAMPLE_META);
    expect(spy).toHaveBeenCalled();
    for (const item of body.keys) expect("key_hash" in item).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// POST /api/keys — create, plaintext once, explicit literal DTO
// ---------------------------------------------------------------------------

describe("route — POST /api/keys (create)", () => {
  it("mints via generate→hash→insert and returns 201 with an EXPLICIT literal DTO {id,prefix,label,created_at,full}", async () => {
    Bun.env.API_KEY_PEPPER = "test-pepper";
    let captured: ApiKeyRecord | null = null;
    push(
      spyOn(storage, "insertApiKey").mockImplementation((rec) => {
        captured = rec as ApiKeyRecord;
        return 42;
      })
    );

    const res = await handleKeysCreate(
      new Request("http://localhost/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: "ci-runner" }),
      })
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;

    // Explicit literal DTO — exactly these five keys, nothing else.
    expect(Object.keys(body).sort()).toEqual(["created_at", "full", "id", "label", "prefix"]);
    expect(body.id).toBe(42);
    expect(body.label).toBe("ci-runner");
    expect(typeof body.created_at).toBe("string");
    expect(typeof body.full).toBe("string");
    // `full` is the plaintext shown once; it is `${prefix}.${secret}`.
    expect((body.full as string).startsWith((body.prefix as string) + ".")).toBe(true);

    // The stored record DID carry a real digest (we persist the hash)...
    expect(captured).not.toBeNull();
    expect(typeof captured!.key_hash).toBe("string");
    expect(captured!.key_hash.length).toBeGreaterThan(0);
    // ...and that digest is NOT the plaintext (proves we hashed, not stored raw).
    expect(captured!.key_hash).not.toBe(body.full);
  });

  it("NEGATIVE: the create response JSON contains NO key_hash key (never spreads ApiKeyRecord/DB row)", async () => {
    Bun.env.API_KEY_PEPPER = "test-pepper";
    push(spyOn(storage, "insertApiKey").mockReturnValue(7));

    const res = await handleKeysCreate(
      new Request("http://localhost/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: "leak-check" }),
      })
    );

    // Assert on the RAW serialized bytes — the strongest anti-leak guarantee.
    const raw = await res.text();
    expect(raw.includes("key_hash")).toBe(false);
    const body = JSON.parse(raw) as Record<string, unknown>;
    expect("key_hash" in body).toBe(false);
  });

  it("fail-fast 500 when API_KEY_PEPPER is empty — mints nothing (insertApiKey never called)", async () => {
    delete Bun.env.API_KEY_PEPPER;
    const ins = push(spyOn(storage, "insertApiKey").mockReturnValue(1));

    const res = await handleKeysCreate(
      new Request("http://localhost/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: "no-pepper" }),
      })
    );

    expect(res.status).toBe(500);
    expect(ins).not.toHaveBeenCalled();
  });

  it("ALWAYS mints with is_admin: 0, ignoring any client-supplied is_admin in the body (no self-escalation via the UI)", async () => {
    Bun.env.API_KEY_PEPPER = "test-pepper";
    let captured: ApiKeyRecord | null = null;
    push(
      spyOn(storage, "insertApiKey").mockImplementation((rec) => {
        captured = rec as ApiKeyRecord;
        return 99;
      })
    );

    const res = await handleKeysCreate(
      new Request("http://localhost/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Malicious/accidental attempt to mint an admin key from the browser.
        body: JSON.stringify({ label: "sneaky-admin", is_admin: 1 }),
      })
    );

    expect(res.status).toBe(201);
    expect(captured).not.toBeNull();
    // The client-supplied is_admin: 1 MUST be ignored — UI keys are never admin.
    expect(captured!.is_admin).toBe(0);
  });

  it("mints with is_admin: 0 for a normal create body with no is_admin field (default is non-admin)", async () => {
    Bun.env.API_KEY_PEPPER = "test-pepper";
    let captured: ApiKeyRecord | null = null;
    push(
      spyOn(storage, "insertApiKey").mockImplementation((rec) => {
        captured = rec as ApiKeyRecord;
        return 100;
      })
    );

    const res = await handleKeysCreate(
      new Request("http://localhost/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: "regular" }),
      })
    );

    expect(res.status).toBe(201);
    expect(captured).not.toBeNull();
    expect(captured!.is_admin).toBe(0);
  });

  it("rejects a missing/blank label with 400 before minting", async () => {
    Bun.env.API_KEY_PEPPER = "test-pepper";
    const ins = push(spyOn(storage, "insertApiKey").mockReturnValue(1));

    const res = await handleKeysCreate(
      new Request("http://localhost/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: "   " }),
      })
    );

    expect(res.status).toBe(400);
    expect(ins).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /api/keys/:id/revoke — idempotent
// ---------------------------------------------------------------------------

describe("route — POST /api/keys/:id/revoke", () => {
  it("revokes an active key → 200 { revoked: true } and forwards the numeric id", async () => {
    const spy = push(spyOn(storage, "revokeApiKey").mockReturnValue(true));

    const res = await handleKeysRevoke(
      new Request("http://localhost/api/keys/5/revoke", { method: "POST" })
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked: true });
    expect(spy).toHaveBeenCalledWith(5);
  });

  it("is an idempotent no-op for an already-revoked/unknown id → 200 { revoked: false }", async () => {
    const spy = push(spyOn(storage, "revokeApiKey").mockReturnValue(false));

    const res = await handleKeysRevoke(
      new Request("http://localhost/api/keys/999/revoke", { method: "POST" })
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked: false });
    expect(spy).toHaveBeenCalledWith(999);
  });

  it("treats a non-numeric id as a no-op → 200 { revoked: false } without touching storage", async () => {
    const spy = push(spyOn(storage, "revokeApiKey").mockReturnValue(true));

    const res = await handleKeysRevoke(
      new Request("http://localhost/api/keys/not-a-number/revoke", { method: "POST" })
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked: false });
    expect(spy).not.toHaveBeenCalled();
  });
});
