import { describe, it, expect, beforeEach } from "bun:test";
import {
  initStorage,
  insertRequest,
  getRequestByTrace,
  insertApiKey,
  getApiKeyByHash,
  getUsageByApiKey,
} from "../src/observability/storage.ts";

// Every test runs against a fresh in-memory DB → deterministic, isolated,
// no disk I/O and no interference with the dev/prod telemetry.db.
beforeEach(() => {
  initStorage(":memory:");
});

// ---------------------------------------------------------------------------
// api_keys table + insertApiKey / getApiKeyByHash  (tasks 1.3, 1.4)
// ---------------------------------------------------------------------------

describe("storage — api_keys: insertApiKey / getApiKeyByHash", () => {
  it("insertApiKey persists a row and returns its generated id", () => {
    const id = insertApiKey({
      prefix: "cpk_alice",
      key_hash: "hash-alice",
      label: "alice",
      created_at: "2026-01-01T00:00:00Z",
    });
    expect(id).toBeGreaterThan(0);
  });

  it("getApiKeyByHash returns the active key row (id, prefix, label) for a known hash", () => {
    const id = insertApiKey({
      prefix: "cpk_alice",
      key_hash: "hash-alice",
      label: "alice",
      created_at: "2026-01-01T00:00:00Z",
    });
    const row = getApiKeyByHash("hash-alice");
    expect(row).not.toBeNull();
    expect(row!.id).toBe(id);
    expect(row!.prefix).toBe("cpk_alice");
    expect(row!.label).toBe("alice");
    expect(row!.revoked_at ?? null).toBeNull();
  });

  it("getApiKeyByHash returns null for an unknown hash", () => {
    insertApiKey({
      prefix: "cpk_alice",
      key_hash: "hash-alice",
      label: "alice",
      created_at: "2026-01-01T00:00:00Z",
    });
    expect(getApiKeyByHash("no-such-hash")).toBeNull();
  });

  it("getApiKeyByHash ignores revoked keys (revoked_at IS NOT NULL)", () => {
    insertApiKey({
      prefix: "cpk_bob",
      key_hash: "hash-bob-revoked",
      label: "bob",
      created_at: "2026-01-01T00:00:00Z",
      revoked_at: "2026-02-01T00:00:00Z",
    });
    expect(getApiKeyByHash("hash-bob-revoked")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// requests.api_key_id attribution via insertRequest  (task 1.5)
// ---------------------------------------------------------------------------

describe("storage — requests.api_key_id attribution", () => {
  it("insertRequest persists a provided api_key_id", () => {
    insertRequest({
      trace_id: "t-attr-1",
      timestamp: "2026-04-01T00:00:00Z",
      api_key_id: 7,
    });
    const row = getRequestByTrace("t-attr-1") as unknown as Record<string, unknown>;
    expect(row.api_key_id).toBe(7);
  });

  it("insertRequest leaves api_key_id NULL when omitted", () => {
    insertRequest({ trace_id: "t-attr-2", timestamp: "2026-04-01T00:00:00Z" });
    const row = getRequestByTrace("t-attr-2") as unknown as Record<string, unknown>;
    expect(row.api_key_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getUsageByApiKey aggregation + time window  (task 1.6)
// ---------------------------------------------------------------------------

describe("storage — getUsageByApiKey aggregation", () => {
  beforeEach(() => {
    // Two issued keys → ids 1 and 2.
    insertApiKey({ prefix: "cpk_alice", key_hash: "h-alice", label: "alice", created_at: "2026-01-01T00:00:00Z" });
    insertApiKey({ prefix: "cpk_bob", key_hash: "h-bob", label: "bob", created_at: "2026-01-01T00:00:00Z" });

    // Key 1 — two requests INSIDE the March window.
    insertRequest({ trace_id: "r1", timestamp: "2026-03-10T00:00:00Z", api_key_id: 1, input_tokens: 100, output_tokens: 10, cache_read_tokens: 5, cache_creation_tokens: 2 });
    insertRequest({ trace_id: "r2", timestamp: "2026-03-11T00:00:00Z", api_key_id: 1, input_tokens: 200, output_tokens: 20, cache_read_tokens: 5, cache_creation_tokens: 3 });
    // Key 1 — one request OUTSIDE the window (January), with huge tokens that must NOT be summed.
    insertRequest({ trace_id: "r3", timestamp: "2026-01-01T00:00:00Z", api_key_id: 1, input_tokens: 9999, output_tokens: 9999 });
    // Key 2 — one request INSIDE the window.
    insertRequest({ trace_id: "r4", timestamp: "2026-03-12T00:00:00Z", api_key_id: 2, input_tokens: 50, output_tokens: 5 });
    // Unattributed request (api_key_id NULL) INSIDE the window — must be excluded.
    insertRequest({ trace_id: "r5", timestamp: "2026-03-12T00:00:00Z", input_tokens: 1 });
  });

  const MARCH = { timeFrom: "2026-03-01T00:00:00Z", timeTo: "2026-03-31T23:59:59Z" };

  it("aggregates per-key request counts and token sums bounded to the window", () => {
    const usage = getUsageByApiKey(MARCH);
    const byId = new Map(usage.map((u) => [u.api_key_id, u]));

    // Exactly the two attributed keys — the NULL group is excluded.
    expect(usage.length).toBe(2);

    const k1 = byId.get(1)!;
    expect(k1).toBeDefined();
    expect(k1.requests).toBe(2); // r1 + r2; r3 (out of window) excluded
    expect(k1.tokens_in).toBe(300); // 100 + 200, NOT 9999
    expect(k1.tokens_out).toBe(30);
    expect(k1.cache_read_tokens).toBe(10);
    expect(k1.cache_creation_tokens).toBe(5);
    expect(k1.prefix).toBe("cpk_alice");
    expect(k1.label).toBe("alice");

    const k2 = byId.get(2)!;
    expect(k2.requests).toBe(1);
    expect(k2.tokens_in).toBe(50);
    expect(k2.tokens_out).toBe(5);
    expect(k2.label).toBe("bob");
  });

  it("bounds results to a different window (only the January row is counted)", () => {
    const usage = getUsageByApiKey({ timeFrom: "2025-12-31T00:00:00Z", timeTo: "2026-01-02T00:00:00Z" });
    expect(usage.length).toBe(1);
    expect(usage[0]!.api_key_id).toBe(1);
    expect(usage[0]!.requests).toBe(1);
    expect(usage[0]!.tokens_in).toBe(9999);
  });

  it("returns an empty array (not an error) when no rows match the window", () => {
    const usage = getUsageByApiKey({ timeFrom: "2030-01-01T00:00:00Z", timeTo: "2030-12-31T00:00:00Z" });
    expect(usage).toEqual([]);
  });
});
