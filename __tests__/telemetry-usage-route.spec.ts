import { describe, it, expect, afterEach, spyOn } from "bun:test";
import { handleTelemetryUsage } from "../src/http/routes/telemetry/usage.ts";
import * as storage from "../src/observability/storage.ts";
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
    // No window params on this request → nulls echoed, undefined passed through.
    expect(body.time_from).toBeNull();
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
