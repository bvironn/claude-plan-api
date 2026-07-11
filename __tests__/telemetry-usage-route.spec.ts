import { describe, it, expect, afterEach, beforeEach, spyOn } from "bun:test";
import { handleTelemetryUsage } from "../src/http/routes/telemetry/usage.ts";
import * as storage from "../src/observability/storage.ts";
import {
  initStorage,
  insertApiKey,
  insertRequest,
  DEFAULT_USAGE_WINDOW_MS,
} from "../src/observability/storage.ts";
import type { UsageByKey } from "../src/observability/types.ts";

// handleTelemetryUsage is wrapped with withObservability, but `/api/telemetry`
// is a SILENT_PATH_PREFIX so the middleware passes straight through to the
// handler — no DB, no trace header. We stub the aggregation query so the test
// is deterministic and asserts only the route's own shaping behavior.

let spies: Array<{ mockRestore: () => void }> = [];

afterEach(() => {
  for (const s of spies) s.mockRestore();
  spies = [];
});

function stubUsage(rows: UsageByKey[]) {
  const spy = spyOn(storage, "getUsageByApiKey").mockReturnValue(rows);
  spies.push(spy);
  return spy;
}

const SAMPLE: UsageByKey[] = [
  {
    api_key_id: 7,
    prefix: "cpk_deadbeef",
    label: "ci-runner",
    requests: 3,
    tokens_in: 120,
    tokens_out: 45,
    cache_read_tokens: 10,
    cache_creation_tokens: 5,
  },
];

describe("route — GET /api/telemetry/usage", () => {
  it("returns per-key aggregated totals as JSON with generated_at + echoed window", async () => {
    const spy = stubUsage(SAMPLE);

    const res = await handleTelemetryUsage(
      new Request("http://localhost/api/telemetry/usage")
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");

    const body = (await res.json()) as {
      generated_at: string;
      time_from: string | null;
      time_to: string | null;
      keys: UsageByKey[];
    };

    // The route surfaces exactly what the aggregation returned.
    expect(body.keys).toEqual(SAMPLE);
    expect(typeof body.generated_at).toBe("string");
    expect(Number.isNaN(Date.parse(body.generated_at))).toBe(false);
    // No timeFrom param on this request → the route must report the actual
    // effective window it applied (REL-001), not a misleading null.
    expect(body.time_from).not.toBeNull();
    expect(Number.isNaN(Date.parse(body.time_from as string))).toBe(false);
    // No timeTo param → still echoed as null (unaffected by the default window).
    expect(body.time_to).toBeNull();
    expect(spy).toHaveBeenCalledWith({ timeFrom: undefined, timeTo: undefined });
  });

  it("forwards timeFrom/timeTo to getUsageByApiKey, echoes them, and returns empty keys when none match", async () => {
    // Different code path: window supplied, aggregation matches nothing → the
    // route MUST return an empty array (spec: empty, not an error).
    const spy = stubUsage([]);

    const res = await handleTelemetryUsage(
      new Request(
        "http://localhost/api/telemetry/usage?timeFrom=2026-01-01T00:00:00Z&timeTo=2026-02-01T00:00:00Z"
      )
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      time_from: string | null;
      time_to: string | null;
      keys: UsageByKey[];
    };

    expect(spy).toHaveBeenCalledWith({
      timeFrom: "2026-01-01T00:00:00Z",
      timeTo: "2026-02-01T00:00:00Z",
    });
    expect(body.time_from).toBe("2026-01-01T00:00:00Z");
    expect(body.time_to).toBe("2026-02-01T00:00:00Z");
    expect(body.keys).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// REL-001 — DTO honesty against the REAL storage function (unmocked)
//
// The tests above stub `getUsageByApiKey()` entirely, so they only prove the
// route's own shaping. This suite exercises the route AND the real
// `getUsageByApiKey()` together over a fresh in-memory DB, proving the actual
// end-to-end contract: when `timeFrom` is omitted, the response `time_from`
// must reflect the real 30-day default window the storage chokepoint applied
// (Phase 3 finding #5) — not `null` — while an explicit window still passes
// through unchanged.
// ---------------------------------------------------------------------------

describe("route — GET /api/telemetry/usage (real storage, unmocked)", () => {
  beforeEach(() => {
    initStorage(":memory:");
    insertApiKey({
      prefix: "cpk_real",
      key_hash: "hash-real",
      label: "real-key",
      created_at: "2020-01-01T00:00:00Z",
      is_admin: 0,
    });
  });

  it("reports the actual applied default window in time_from when the caller omits timeFrom", async () => {
    const now = Date.now();
    insertRequest({
      trace_id: "recent",
      timestamp: new Date(now - 60_000).toISOString(),
      api_key_id: 1,
      input_tokens: 100,
      output_tokens: 10,
    });

    const res = await handleTelemetryUsage(
      new Request("http://localhost/api/telemetry/usage")
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      time_from: string | null;
      time_to: string | null;
      keys: UsageByKey[];
    };

    // Not null: the DTO must be honest about the window it silently applied.
    expect(body.time_from).not.toBeNull();
    const appliedFrom = Date.parse(body.time_from as string);
    expect(Number.isNaN(appliedFrom)).toBe(false);
    // The reported boundary must be ~DEFAULT_USAGE_WINDOW_MS before now (a
    // few seconds of test-execution tolerance for the two independent
    // Date.now() reads on either side of the HTTP call).
    const expectedFrom = now - DEFAULT_USAGE_WINDOW_MS;
    expect(Math.abs(appliedFrom - expectedFrom)).toBeLessThan(5_000);
    expect(body.time_to).toBeNull();

    // And the aggregation itself still honors the same window: the recent
    // row is included.
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]?.requests).toBe(1);
  });

  it("still passes an explicit caller-supplied timeFrom/timeTo through unchanged (no regression)", async () => {
    const now = Date.now();
    insertRequest({
      trace_id: "in-range",
      timestamp: new Date(now - 60_000).toISOString(),
      api_key_id: 1,
      input_tokens: 50,
    });

    const explicitFrom = "1970-01-01T00:00:00.000Z";
    const explicitTo = new Date(now + 60_000).toISOString();
    const res = await handleTelemetryUsage(
      new Request(
        `http://localhost/api/telemetry/usage?timeFrom=${explicitFrom}&timeTo=${encodeURIComponent(explicitTo)}`
      )
    );
    const body = (await res.json()) as {
      time_from: string | null;
      time_to: string | null;
      keys: UsageByKey[];
    };

    // Explicit values are echoed verbatim — the honesty fix must not alter
    // the caller-override path.
    expect(body.time_from).toBe(explicitFrom);
    expect(body.time_to).toBe(explicitTo);
    expect(body.keys).toHaveLength(1);
  });
});
