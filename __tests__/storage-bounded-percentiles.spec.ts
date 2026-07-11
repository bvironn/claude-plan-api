import { describe, it, expect, beforeEach } from "bun:test";
import { initStorage, insertRequest, getMetrics, SAMPLE_CAP } from "../src/observability/storage.ts";

// Fresh in-memory DB per test → deterministic, isolated, no disk I/O.
beforeEach(() => {
  initStorage(":memory:");
});

// A window wide enough that every seeded row is inside it — so the ONLY thing
// bounding the latency sample is SAMPLE_CAP, never the time window.
const HOUR_MS = 3_600_000;

// ---------------------------------------------------------------------------
// Bounded percentile computation (finding #4)
//
// getMetrics() must cap the latency sample to the most-recent SAMPLE_CAP rows
// (ORDER BY timestamp DESC LIMIT SAMPLE_CAP) and compute p50/p95/p99 in JS,
// instead of scanning every duration_ms row in the window.
// ---------------------------------------------------------------------------

describe("storage — getMetrics bounded percentiles (#4)", () => {
  it("computes percentiles from the most-recent SAMPLE_CAP rows, excluding older rows beyond the bound", () => {
    const base = Date.now();
    let n = 0;

    // SAMPLE_CAP recent rows, all fast (10ms) — these hold the NEWEST timestamps.
    for (let i = 0; i < SAMPLE_CAP; i++) {
      insertRequest({
        trace_id: `fast-${n++}`,
        timestamp: new Date(base - i).toISOString(),
        duration_ms: 10,
        status: 200,
      });
    }

    // EXTRA slow outliers, OLDER than every recent row but still inside the
    // query window. An unbounded scan would let these dominate the tail
    // (p99 → 99999); a bounded, recency-biased sample must exclude them.
    const EXTRA = 500;
    for (let j = 0; j < EXTRA; j++) {
      insertRequest({
        trace_id: `slow-${n++}`,
        timestamp: new Date(base - SAMPLE_CAP - 1000 - j).toISOString(),
        duration_ms: 99999,
        status: 200,
      });
    }

    const m = getMetrics(HOUR_MS);

    // The slow outliers fall outside the most-recent SAMPLE_CAP window → excluded.
    expect(m.latencyP50).toBe(10);
    expect(m.latencyP95).toBe(10);
    expect(m.latencyP99).toBe(10);

    // Only the latency SAMPLE is bounded — the total request COUNT is not.
    expect(m.requestsTotal).toBe(SAMPLE_CAP + EXTRA);
  });

  it("returns exact percentiles (zero tolerance) when the dataset is at or under SAMPLE_CAP", () => {
    const base = Date.now();

    // 100 rows with distinct durations 1..100 — well under the cap, so the
    // capped path must reproduce the exact nearest-rank percentile the old
    // unbounded SQL sort produced. This is the "documented tolerance is zero
    // below the cap" guarantee.
    for (let i = 1; i <= 100; i++) {
      insertRequest({
        trace_id: `d-${i}`,
        timestamp: new Date(base - i).toISOString(),
        duration_ms: i,
        status: 200,
      });
    }

    const m = getMetrics(HOUR_MS);

    // Nearest-rank: durations_sorted_asc[floor(len * pct / 100)] over [1..100].
    expect(m.latencyP50).toBe(51); // index 50
    expect(m.latencyP95).toBe(96); // index 95
    expect(m.latencyP99).toBe(100); // index 99
  });

  it("preserves the Metrics response shape (identical fields) after capping", () => {
    insertRequest({
      trace_id: "shape-1",
      timestamp: new Date().toISOString(),
      duration_ms: 42,
      status: 200,
      input_tokens: 5,
      output_tokens: 7,
      cache_read_tokens: 1,
      cache_creation_tokens: 2,
    });

    const m = getMetrics(HOUR_MS);

    expect(Object.keys(m).sort()).toEqual([
      "activeErrors",
      "cacheCreationTokens",
      "cacheReadTokens",
      "errorsByRoute",
      "eventsPerMin",
      "latencyP50",
      "latencyP95",
      "latencyP99",
      "requestsByStatus",
      "requestsTotal",
      "tokensIn",
      "tokensOut",
    ]);
    // A real (non-empty) sample flows through the JS percentile path.
    expect(m.latencyP50).toBe(42);
    expect(m.requestsTotal).toBe(1);
  });
});
