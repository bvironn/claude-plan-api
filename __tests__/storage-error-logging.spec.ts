import { describe, it, expect, beforeEach, spyOn } from "bun:test";
import {
  initStorage,
  insertRequest,
  updateRequest,
  insertEvent,
  queryEvents,
} from "../src/observability/storage.ts";
import type { TelemetryEvent } from "../src/observability/types.ts";

// Regression tests for the silent-swallow incident: insertRequest,
// updateRequest and insertEvent used to wrap their sole DB write in a bare
// `catch {}`, so ANY write failure (disk full, SQLITE_BUSY, schema mismatch,
// bad bind) vanished with zero logging. These tests force a real write failure
// and prove the failure is now LOGGED — while still NOT throwing upward (a
// telemetry write must never become a 500 for the real API client).
//
// How the failure is forced: bun:sqlite's prepared-statement `.run()` rejects
// an un-bindable value (a plain object) with a synchronous throw, exercising
// the exact catch block the incident was about — no DB internals required.
beforeEach(() => {
  initStorage(":memory:");
});

describe("storage — write-failure logging (silent-swallow regression)", () => {
  it("insertRequest logs the failure through emit() instead of swallowing it", () => {
    // model is TEXT; passing an object makes .run() throw at bind time.
    const badRecord = {
      trace_id: "t-insert-fail",
      timestamp: "2026-01-01T00:00:00Z",
      model: {} as unknown as string,
    };

    // Requirement: must NOT throw upward (log-and-continue, not log-and-crash).
    expect(() => insertRequest(badRecord)).not.toThrow();

    // emit("error", "storage.insertRequest.failed", …) flows through the real
    // observability pipeline and records an events row. Before the fix, the
    // catch {} swallowed everything → zero rows here (test would fail).
    const logged = queryEvents({ event: ["storage.insertRequest.failed"] });
    expect(logged.length).toBe(1);
    expect(logged[0]!.payload).toMatchObject({ traceId: "t-insert-fail" });
    // The logged payload carries the underlying error message, not an empty swallow.
    expect(typeof (logged[0]!.payload as Record<string, unknown>).error).toBe("string");
  });

  it("updateRequest logs the failure through emit() instead of swallowing it", () => {
    // Seed a valid row so the UPDATE targets something real.
    insertRequest({ trace_id: "t-update-fail", timestamp: "2026-01-01T00:00:00Z" });

    // Patch references a column that does not exist → the dynamically built
    // `UPDATE requests SET nonexistent_col = ? …` throws at prepare() time.
    // This mirrors the incident's cited "schema mismatch" failure mode.
    expect(() =>
      updateRequest("t-update-fail", { nonexistent_col: "x" } as never)
    ).not.toThrow();

    const logged = queryEvents({ event: ["storage.updateRequest.failed"] });
    expect(logged.length).toBe(1);
    expect(logged[0]!.payload).toMatchObject({ traceId: "t-update-fail" });
    expect(typeof (logged[0]!.payload as Record<string, unknown>).error).toBe("string");
  });

  it("insertEvent logs the failure via console.error (no emit recursion)", () => {
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      // level is TEXT NOT NULL; an object makes .run() throw at bind time.
      const badEvent = {
        timestamp: "2026-01-01T00:00:00Z",
        level: {} as unknown as TelemetryEvent["level"],
        event: "storage.insertEvent.regression",
      } as TelemetryEvent;

      // Must NOT throw upward.
      expect(() => insertEvent(badEvent)).not.toThrow();

      // The failure is reported via console.error (NOT emit — that would recurse
      // back into insertEvent). Assert a message that references this function.
      expect(errSpy).toHaveBeenCalled();
      const messages = errSpy.mock.calls.map((c) => c.map(String).join(" "));
      expect(messages.some((m) => m.includes("storage.insertEvent"))).toBe(true);

      // And crucially: insertEvent did NOT re-enter emit()/insertEvent() to log
      // its own failure — so no self-referential error event was written.
      const recursed = queryEvents({ event: ["storage.insertEvent.regression"] });
      expect(recursed.length).toBe(0);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("a successful insertRequest still records NO failure event (guards against a false-positive)", () => {
    // Proves the failure event only appears on real failure — not a tautology
    // that always logs regardless of outcome.
    insertRequest({ trace_id: "t-ok", timestamp: "2026-01-01T00:00:00Z" });
    expect(queryEvents({ event: ["storage.insertRequest.failed"] }).length).toBe(0);
  });
});
