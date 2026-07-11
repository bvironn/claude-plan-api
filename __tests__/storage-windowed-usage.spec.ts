import { describe, it, expect, beforeEach } from "bun:test";
import {
  initStorage,
  insertApiKey,
  insertRequest,
  getUsageByApiKey,
  DEFAULT_USAGE_WINDOW_MS,
} from "../src/observability/storage.ts";

// Fresh in-memory DB per test, seeded with one attributed key (id 1).
beforeEach(() => {
  initStorage(":memory:");
  insertApiKey({
    prefix: "cpk_a",
    key_hash: "h-a",
    label: "alice",
    created_at: "2020-01-01T00:00:00Z",
    is_admin: 0,
  });
});

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Windowed usage aggregation (finding #5)
//
// getUsageByApiKey() must enforce a default time window at the storage layer so
// aggregation never scans the full `requests` history when the caller (the
// /api/telemetry/usage poll) supplies no `timeFrom`. An explicit `timeFrom`
// overrides the default.
// ---------------------------------------------------------------------------

describe("storage — getUsageByApiKey default window (#5)", () => {
  it("enforces a default window when no timeFrom is supplied, excluding rows older than DEFAULT_USAGE_WINDOW_MS", () => {
    const now = Date.now();

    // Recent row — comfortably inside the default window.
    insertRequest({
      trace_id: "recent",
      timestamp: new Date(now - 60_000).toISOString(),
      api_key_id: 1,
      input_tokens: 100,
      output_tokens: 10,
    });
    // Old row — a full day OLDER than the default window boundary. Its huge
    // token counts MUST NOT be summed when the caller passes no window.
    insertRequest({
      trace_id: "old",
      timestamp: new Date(now - DEFAULT_USAGE_WINDOW_MS - DAY_MS).toISOString(),
      api_key_id: 1,
      input_tokens: 99999,
      output_tokens: 99999,
    });

    const usage = getUsageByApiKey(); // no filters → default window applies

    expect(usage.length).toBe(1);
    expect(usage[0]!.api_key_id).toBe(1);
    expect(usage[0]!.requests).toBe(1); // only the recent row
    expect(usage[0]!.tokens_in).toBe(100); // NOT 100099
    expect(usage[0]!.tokens_out).toBe(10);
  });

  it("returns empty (not full history) when every row predates the default window and no timeFrom is given", () => {
    const now = Date.now();
    insertRequest({
      trace_id: "old1",
      timestamp: new Date(now - DEFAULT_USAGE_WINDOW_MS - 1_000).toISOString(),
      api_key_id: 1,
      input_tokens: 5,
    });
    insertRequest({
      trace_id: "old2",
      timestamp: new Date(now - DEFAULT_USAGE_WINDOW_MS - 2_000).toISOString(),
      api_key_id: 1,
      input_tokens: 7,
    });

    // Both rows predate the default window → the chokepoint bounds the scan and
    // finds nothing, rather than summing the full history.
    expect(getUsageByApiKey()).toEqual([]);
  });

  it("respects an explicit timeFrom that widens the window past the default (caller override)", () => {
    const now = Date.now();
    insertRequest({
      trace_id: "recent",
      timestamp: new Date(now - 60_000).toISOString(),
      api_key_id: 1,
      input_tokens: 100,
    });
    insertRequest({
      trace_id: "old",
      timestamp: new Date(now - DEFAULT_USAGE_WINDOW_MS - DAY_MS).toISOString(),
      api_key_id: 1,
      input_tokens: 99999,
    });

    // Explicit far-past lower bound → the default is NOT applied; the old row
    // is included. Proves the "unless the caller passes a window" escape hatch.
    const usage = getUsageByApiKey({ timeFrom: "1970-01-01T00:00:00Z" });

    expect(usage.length).toBe(1);
    expect(usage[0]!.requests).toBe(2); // both rows
    expect(usage[0]!.tokens_in).toBe(100099);
  });
});
