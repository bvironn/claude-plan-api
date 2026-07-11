/**
 * Tests for the `apiKeyId` telemetry filter (change: key-usage-filter).
 *
 * Two layers in one file:
 *  - Storage: `queryRequests`/`countRequests` honor the new `apiKeyId` filter
 *    (matching / non-matching / omitted / invalid) against an isolated DB.
 *  - Route: `_handleTelemetryRequests` parses `?apiKeyId=` with the existing
 *    `parseNum` guard (valid → filtered, absent/invalid → unfiltered, never an
 *    error) and surfaces `apiKeyId` in the camelCased projection.
 *
 * Each test runs in an isolated tmp CWD so `initStorage` creates a fresh DB
 * under `logs/telemetry.db` (mirrors telemetry-upstream-body.spec.ts).
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  initStorage,
  insertRequest,
  queryRequests,
  countRequests,
} from "../src/observability/storage.ts";
import { handleTelemetryRequests } from "../src/http/routes/telemetry/requests.ts";
import { listRequests } from "../src/ui/src/lib/api.ts";

let originalCwd: string;
let tmpDir: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tmpDir = mkdtempSync(join(tmpdir(), "claude-plan-api-keyfilter-"));
  process.chdir(tmpDir);
});

afterEach(() => {
  process.chdir(originalCwd);
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

/** Seed three requests: key 1, key 2, and a legacy NULL-key row. */
function seedMixedKeys(): void {
  initStorage();
  insertRequest({ trace_id: "k1-a", timestamp: "2026-04-18T00:00:01Z", path: "/v1/chat/completions", api_key_id: 1 });
  insertRequest({ trace_id: "k1-b", timestamp: "2026-04-18T00:00:02Z", path: "/v1/chat/completions", api_key_id: 1 });
  insertRequest({ trace_id: "k2-a", timestamp: "2026-04-18T00:00:03Z", path: "/v1/chat/completions", api_key_id: 2 });
  insertRequest({ trace_id: "legacy", timestamp: "2026-04-18T00:00:04Z", path: "/v1/chat/completions" });
}

// ---------------------------------------------------------------------------
// Storage layer (tasks 1.1, 1.2, test 5.1)
// ---------------------------------------------------------------------------

describe("storage — apiKeyId filter", () => {
  it("returns only rows matching apiKeyId", () => {
    seedMixedKeys();
    const rows = queryRequests({ apiKeyId: 1 });
    expect(rows.map((r) => r.trace_id).sort()).toEqual(["k1-a", "k1-b"]);
    expect(countRequests({ apiKeyId: 1 })).toBe(2);
  });

  it("returns a different subset for a different apiKeyId (triangulation)", () => {
    seedMixedKeys();
    const rows = queryRequests({ apiKeyId: 2 });
    expect(rows.map((r) => r.trace_id)).toEqual(["k2-a"]);
    expect(countRequests({ apiKeyId: 2 })).toBe(1);
  });

  it("returns an empty set for a non-matching apiKeyId", () => {
    seedMixedKeys();
    expect(queryRequests({ apiKeyId: 99 })).toHaveLength(0);
    expect(countRequests({ apiKeyId: 99 })).toBe(0);
  });

  it("returns all rows (including NULL-key legacy) when apiKeyId is omitted", () => {
    seedMixedKeys();
    const rows = queryRequests({});
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.trace_id)).toContain("legacy");
    expect(countRequests({})).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Route layer (tasks 2.1, 2.2, test 5.2)
// ---------------------------------------------------------------------------

async function requestsJson(qs: string): Promise<{ total: number; requests: Array<Record<string, unknown>> }> {
  const res = await handleTelemetryRequests(new Request(`http://localhost/api/telemetry/requests${qs}`));
  expect(res.status).toBe(200);
  return (await res.json()) as { total: number; requests: Array<Record<string, unknown>> };
}

describe("telemetry/requests route — apiKeyId param", () => {
  it("filters to the requested key and reflects the filtered total", async () => {
    seedMixedKeys();
    const body = await requestsJson("?apiKeyId=1");
    expect(body.total).toBe(2);
    expect(body.requests.map((r) => r.traceId).sort()).toEqual(["k1-a", "k1-b"]);
  });

  it("returns an empty set (total 0, HTTP 200) for a non-matching key", async () => {
    seedMixedKeys();
    const body = await requestsJson("?apiKeyId=99");
    expect(body.total).toBe(0);
    expect(body.requests).toHaveLength(0);
  });

  it("is unfiltered when apiKeyId is absent", async () => {
    seedMixedKeys();
    const body = await requestsJson("");
    expect(body.total).toBe(4);
  });

  it("treats a non-numeric apiKeyId as absent (unfiltered, not an error)", async () => {
    seedMixedKeys();
    const body = await requestsJson("?apiKeyId=abc");
    expect(body.total).toBe(4);
  });

  it("treats an empty apiKeyId value as absent (unfiltered)", async () => {
    seedMixedKeys();
    const body = await requestsJson("?apiKeyId=");
    expect(body.total).toBe(4);
  });

  it("treats a negative apiKeyId as absent (unfiltered, guard sentinel)", async () => {
    seedMixedKeys();
    const body = await requestsJson("?apiKeyId=-3");
    expect(body.total).toBe(4);
  });

  it("surfaces apiKeyId in the camelCased projection", async () => {
    seedMixedKeys();
    const body = await requestsJson("?apiKeyId=1");
    const row = body.requests.find((r) => r.traceId === "k1-a");
    expect(row).toBeDefined();
    expect(row!.apiKeyId).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// UI fetch wrapper (task 3.1, test 5.3) — DOM-free, mock fetch
// ---------------------------------------------------------------------------

describe("ui listRequests — apiKeyId forwarding", () => {
  it("encodes apiKeyId into the query string", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () =>
      new Response(JSON.stringify({ total: 0, limit: 100, offset: 0, requests: [] }), { status: 200 })) as unknown as typeof fetch);
    try {
      await listRequests({ apiKeyId: 5 });
      const url = (fetchSpy.mock.calls[0] as unknown[])[0] as string;
      expect(url).toBe("/api/telemetry/requests?apiKeyId=5");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("omits apiKeyId from the query when unset (unfiltered)", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () =>
      new Response(JSON.stringify({ total: 0, limit: 100, offset: 0, requests: [] }), { status: 200 })) as unknown as typeof fetch);
    try {
      await listRequests({ path: "/v1/chat/completions" });
      const url = (fetchSpy.mock.calls[0] as unknown[])[0] as string;
      expect(url).not.toContain("apiKeyId");
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
