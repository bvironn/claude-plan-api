import { describe, it, expect, beforeEach } from "bun:test";
import {
  initStorage,
  insertRequest,
  updateRequest,
  queryRequests,
  queryEvents,
  dropFtsTableForTests,
} from "../src/observability/storage.ts";

// ---------------------------------------------------------------------------
// RESIL-002 — FTS sync failure must never drop the base telemetry row
//
// The AFTER INSERT / AFTER UPDATE triggers used to write into `requests_fts`
// as part of the SAME statement that inserted/updated `requests`. A trigger
// failure aborts the WHOLE triggering statement, silently dropping the actual
// telemetry record — not just the search index entry.
//
// insertRequest/updateRequest now perform the FTS sync as an explicit,
// separate, best-effort step AFTER the base write has already committed, in
// its own try/catch that can never roll back or fail the base write. This
// forces the FTS sync write to actually throw (by dropping `requests_fts` out
// from under a live connection while `ftsAvailable` stays true) and proves the
// base `requests` row survives and is queryable regardless.
// ---------------------------------------------------------------------------

beforeEach(() => {
  initStorage(":memory:");
});

describe("storage — insertRequest survives an FTS sync failure (RESIL-002)", () => {
  it("writes and keeps the base requests row even though the FTS sync throws", () => {
    dropFtsTableForTests(); // requests_fts is gone; ftsAvailable stays true

    expect(() =>
      insertRequest({
        trace_id: "t-fts-insert-fail",
        timestamp: "2026-01-01T00:00:00Z",
        request_body: "hello world",
      })
    ).not.toThrow();

    // The real telemetry row exists and is queryable — proving the FTS
    // failure never rolled back or dropped it.
    const rows = queryRequests({ traceId: "t-fts-insert-fail" });
    expect(rows.length).toBe(1);
    expect(rows[0]!.request_body).toBe("hello world");
  });

  it("logs the FTS sync failure via emit() instead of swallowing it silently", () => {
    dropFtsTableForTests();

    insertRequest({
      trace_id: "t-fts-insert-fail-logged",
      timestamp: "2026-01-01T00:00:00Z",
      request_body: "some content",
    });

    const logged = queryEvents({ event: ["storage.fts.syncFailed"] });
    expect(logged.length).toBe(1);
    expect(logged[0]!.payload).toMatchObject({ id: expect.any(Number) });
    expect(typeof (logged[0]!.payload as Record<string, unknown>).error).toBe("string");
  });
});

describe("storage — updateRequest survives an FTS sync failure (RESIL-002)", () => {
  it("applies and keeps the base column update even though the FTS sync throws", () => {
    insertRequest({
      trace_id: "t-fts-update-fail",
      timestamp: "2026-01-01T00:00:00Z",
      request_body: "original body",
    });

    dropFtsTableForTests();

    expect(() =>
      updateRequest("t-fts-update-fail", { request_body: "patched body", status: 200 })
    ).not.toThrow();

    const rows = queryRequests({ traceId: "t-fts-update-fail" });
    expect(rows.length).toBe(1);
    expect(rows[0]!.request_body).toBe("patched body");
    expect(rows[0]!.status).toBe(200);
  });

  it("still applies non-body column patches (e.g. status/tokens only) when FTS is broken", () => {
    insertRequest({ trace_id: "t-fts-update-nonbody", timestamp: "2026-01-01T00:00:00Z" });
    dropFtsTableForTests();

    expect(() =>
      updateRequest("t-fts-update-nonbody", { status: 500, duration_ms: 42 })
    ).not.toThrow();

    const rows = queryRequests({ traceId: "t-fts-update-nonbody" });
    expect(rows[0]!.status).toBe(500);
    expect(rows[0]!.duration_ms).toBe(42);
  });
});

describe("storage — a successful FTS sync records no failure event (guards against a false-positive)", () => {
  it("insertRequest with a healthy FTS index logs no syncFailed event", () => {
    insertRequest({ trace_id: "t-fts-ok", timestamp: "2026-01-01T00:00:00Z", request_body: "fine" });
    expect(queryEvents({ event: ["storage.fts.syncFailed"] }).length).toBe(0);
  });
});
