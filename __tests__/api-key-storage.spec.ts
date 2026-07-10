import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initStorage,
  insertRequest,
  getRequestByTrace,
  insertApiKey,
  getApiKeyByHash,
  getUsageByApiKey,
  listApiKeys,
  revokeApiKey,
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
      is_admin: 0,
    });
    expect(id).toBeGreaterThan(0);
  });

  it("getApiKeyByHash returns the active key row (id, prefix, label) for a known hash", () => {
    const id = insertApiKey({
      prefix: "cpk_alice",
      key_hash: "hash-alice",
      label: "alice",
      created_at: "2026-01-01T00:00:00Z",
      is_admin: 0,
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
      is_admin: 0,
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
      is_admin: 0,
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
    insertApiKey({ prefix: "cpk_alice", key_hash: "h-alice", label: "alice", created_at: "2026-01-01T00:00:00Z", is_admin: 0 });
    insertApiKey({ prefix: "cpk_bob", key_hash: "h-bob", label: "bob", created_at: "2026-01-01T00:00:00Z", is_admin: 0 });

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

// ---------------------------------------------------------------------------
// listApiKeys — metadata only (never key_hash), DESC by created_at (tasks 1.1, 1.2, 3.1)
// ---------------------------------------------------------------------------

describe("storage — listApiKeys (metadata only, DESC)", () => {
  it("returns exactly the metadata columns and NEVER key_hash for every row", () => {
    insertApiKey({ prefix: "cpk_a", key_hash: "secret-hash-a", label: "alice", created_at: "2026-01-01T00:00:00Z", is_admin: 1 });
    insertApiKey({ prefix: "cpk_b", key_hash: "secret-hash-b", label: "bob", created_at: "2026-01-02T00:00:00Z", is_admin: 0 });

    const rows = listApiKeys();

    expect(rows.length).toBe(2);
    for (const row of rows) {
      // Explicit-column SELECT → the row object has exactly the DTO keys and no
      // secret. This is the structural guarantee against a `SELECT *` leak.
      // `is_admin` is an intentional part of the metadata allowlist (not a secret).
      expect(Object.keys(row).sort()).toEqual(["created_at", "id", "is_admin", "label", "prefix", "revoked_at"]);
      expect("key_hash" in row).toBe(false);
    }
  });

  it("orders rows by created_at DESC (newest first), independent of insert order", () => {
    insertApiKey({ prefix: "cpk_old", key_hash: "h-old", label: "old", created_at: "2026-01-01T00:00:00Z", is_admin: 0 });
    insertApiKey({ prefix: "cpk_new", key_hash: "h-new", label: "new", created_at: "2026-03-01T00:00:00Z", is_admin: 0 });
    insertApiKey({ prefix: "cpk_mid", key_hash: "h-mid", label: "mid", created_at: "2026-02-01T00:00:00Z", is_admin: 0 });

    const labels = listApiKeys().map((r) => r.label);
    expect(labels).toEqual(["new", "mid", "old"]);
  });

  it("includes revoked keys with revoked_at populated (list is NOT active-only)", () => {
    insertApiKey({ prefix: "cpk_r", key_hash: "h-r", label: "revoked", created_at: "2026-01-01T00:00:00Z", revoked_at: "2026-02-01T00:00:00Z", is_admin: 0 });
    const rows = listApiKeys();
    expect(rows.length).toBe(1);
    expect(rows[0]!.revoked_at).toBe("2026-02-01T00:00:00Z");
  });

  it("returns an empty array when no keys exist", () => {
    expect(listApiKeys()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// revokeApiKey — idempotent soft-revoke, returns boolean (tasks 1.3, 3.1)
// ---------------------------------------------------------------------------

describe("storage — revokeApiKey (idempotent soft-revoke)", () => {
  it("transitions an active key active→revoked, returns true, and deactivates it for auth", () => {
    insertApiKey({ prefix: "cpk_x", key_hash: "hash-x", label: "x", created_at: "2026-01-01T00:00:00Z", is_admin: 0 });
    // Active before revoke — the active-only lookup finds it.
    expect(getApiKeyByHash("hash-x")).not.toBeNull();

    const first = revokeApiKey(1);

    expect(first).toBe(true);
    // Active-only lookup now rejects it → enforceApiKey would 401 (spec scenario).
    expect(getApiKeyByHash("hash-x")).toBeNull();
  });

  it("is an idempotent no-op on the second call (already revoked → false)", () => {
    insertApiKey({ prefix: "cpk_x", key_hash: "hash-x", label: "x", created_at: "2026-01-01T00:00:00Z", is_admin: 0 });
    expect(revokeApiKey(1)).toBe(true);
    expect(revokeApiKey(1)).toBe(false);
  });

  it("returns false for an unknown id (no row transitions)", () => {
    insertApiKey({ prefix: "cpk_x", key_hash: "hash-x", label: "x", created_at: "2026-01-01T00:00:00Z", is_admin: 0 });
    expect(revokeApiKey(999)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// is_admin persistence + additive migration  (admin-scoped keys)
// ---------------------------------------------------------------------------

describe("storage — api_keys.is_admin persistence", () => {
  it("persists is_admin: 1 (admin key) and reads it back via getApiKeyByHash", () => {
    insertApiKey({ prefix: "cpk_root", key_hash: "h-root", label: "root", created_at: "2026-01-01T00:00:00Z", is_admin: 1 });
    const row = getApiKeyByHash("h-root");
    expect(row).not.toBeNull();
    // The admin flag is a real, distinct value — proves it round-tripped, not a default.
    expect(row!.is_admin).toBe(1);
  });

  it("persists is_admin: 0 (non-admin key) and reads it back via getApiKeyByHash", () => {
    insertApiKey({ prefix: "cpk_user", key_hash: "h-user", label: "user", created_at: "2026-01-01T00:00:00Z", is_admin: 0 });
    const row = getApiKeyByHash("h-user");
    expect(row).not.toBeNull();
    expect(row!.is_admin).toBe(0);
  });

  it("listApiKeys exposes is_admin per row so the admin UI can flag the master key(s)", () => {
    insertApiKey({ prefix: "cpk_root", key_hash: "h-root", label: "root", created_at: "2026-02-01T00:00:00Z", is_admin: 1 });
    insertApiKey({ prefix: "cpk_user", key_hash: "h-user", label: "user", created_at: "2026-01-01T00:00:00Z", is_admin: 0 });

    const byLabel = new Map(listApiKeys().map((r) => [r.label, r]));
    expect(byLabel.get("root")!.is_admin).toBe(1);
    expect(byLabel.get("user")!.is_admin).toBe(0);
  });
});

// The additive migration mirrors the `requests.api_key_id` / `upstream_request_body`
// precedent: add to CREATE TABLE for fresh DBs AND ensureColumn() for pre-existing
// ones. This must be provable against a DB created before the column existed, so it
// uses a real on-disk file (a `:memory:` DB is always fresh and never exercises ALTER).
describe("storage — is_admin additive migration (DB predating the column)", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "cpk-mig-"));
  const dbPath = join(tmpDir, "telemetry.db");

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("backfills is_admin=0 on an old api_keys table without data loss, and is a no-op on re-init", () => {
    // 1) Seed an OLD-schema api_keys (NO is_admin column) with one active row.
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE api_keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        prefix TEXT NOT NULL,
        key_hash TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        created_at TEXT NOT NULL,
        revoked_at TEXT
      );
    `);
    legacy
      .prepare("INSERT INTO api_keys (prefix, key_hash, label, created_at, revoked_at) VALUES (?, ?, ?, ?, ?)")
      .run("cpk_legacy", "h-legacy", "legacy", "2026-01-01T00:00:00Z", null);
    legacy.close();

    // 2) initStorage() runs the idempotent additive migration on the existing file.
    initStorage(dbPath);

    // 3) The column now exists (backfilled to 0) and the legacy row survived intact.
    const migrated = getApiKeyByHash("h-legacy");
    expect(migrated).not.toBeNull();
    expect(migrated!.label).toBe("legacy"); // no data loss
    expect(migrated!.is_admin).toBe(0); // NOT NULL DEFAULT 0 backfill

    // 4) Re-init is an idempotent no-op: still exactly one row, column still there.
    initStorage(dbPath);
    const rows = listApiKeys();
    expect(rows.length).toBe(1);
    expect(rows[0]!.label).toBe("legacy");
    expect(rows[0]!.is_admin).toBe(0);
  });
});
