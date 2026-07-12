import { describe, it, expect, beforeEach } from "bun:test";
import {
  initStorage,
  insertRequest,
  queryRequests,
  dropFtsTableForTests,
  reinitFtsForTests,
} from "../src/observability/storage.ts";

// ---------------------------------------------------------------------------
// RESIL-001 / REL-001 — reconciliation-based FTS backfill
//
// The previous `initRequestsFts` decided whether to run the one-time
// `INSERT INTO requests_fts(requests_fts) VALUES('rebuild')` backfill purely
// from `ftsExisted` (a `sqlite_master` existence check performed BEFORE the
// `CREATE VIRTUAL TABLE` + rebuild ran). A crash between the table commit and
// the rebuild completing left `requests_fts` present-but-EMPTY forever: the
// next startup saw the table already existed, skipped the rebuild, and
// reported `ftsAvailable = true` — so search silently missed every pre-crash
// row, permanently.
//
// The fix compares the number of actually-INDEXED documents
// (`requests_fts_docsize`, a shadow table with exactly one row per rowid that
// has been indexed) against the real `requests` row count, and rebuilds
// whenever they differ. This is self-healing on every startup, not just once.
//
// `count(*) FROM requests_fts` itself CANNOT be used for this reconciliation:
// SQLite optimizes a column-less count(*) against an external-content FTS5
// table by reading the CONTENT table's row count directly, so it returns the
// same number whether the index is populated or completely empty (verified
// empirically while implementing this fix).
// ---------------------------------------------------------------------------

function seed(traceId: string, requestBody: string, responseBody = ""): void {
  insertRequest({
    trace_id: traceId,
    timestamp: new Date().toISOString(),
    request_body: requestBody,
    response_body: responseBody,
  });
}

beforeEach(() => {
  initStorage(":memory:");
});

describe("storage — FTS reconciliation self-heals a crash between table creation and rebuild (RESIL-001 / REL-001)", () => {
  it("rows written before the FTS index existed become searchable once the reconciliation-based backfill runs", () => {
    // Seed real rows the normal way first — sanity check that indexing
    // already works before we simulate the crash.
    seed("a", "the claude sonnet model answered");
    seed("b", "a completely unrelated gpt reply");
    expect(queryRequests({ search: "claude" }).map((r) => r.trace_id)).toEqual(["a"]);

    // Simulate the crash: drop the FTS virtual table (and its shadow tables,
    // including `requests_fts_docsize`) on the SAME connection, so the
    // pre-existing `requests` rows above are kept (unlike calling
    // initStorage(":memory:") again, which would open a brand-new, empty
    // in-memory database). `reinitFtsForTests()` then re-runs exactly the
    // logic `initStorage` runs on every real startup: `CREATE VIRTUAL TABLE
    // IF NOT EXISTS` recreates the table bare (empty index, same as a crash
    // right after the CREATE committed), then the reconciliation check must
    // detect the docsize(0) vs requests(2) mismatch and rebuild — all within
    // this one call, matching how a real process restart behaves.
    dropFtsTableForTests();
    reinitFtsForTests();

    // The pre-crash rows are searchable again — the reconciliation check
    // (docsize count 0 vs requests count 2 → mismatch → rebuild) ran
    // automatically, not just on a virgin database.
    expect(queryRequests({ search: "claude" }).map((r) => r.trace_id)).toEqual(["a"]);
    expect(queryRequests({ search: "gpt" }).map((r) => r.trace_id)).toEqual(["b"]);
  });

  it("a second reinit is a cheap no-op once the index is already reconciled (does not re-run rebuild needlessly)", () => {
    seed("a", "claude sonnet");
    expect(queryRequests({ search: "claude" }).map((r) => r.trace_id)).toEqual(["a"]);

    // Reinit without dropping anything: docsize count already matches
    // requests count, so this must remain a no-op — and, crucially, must NOT
    // throw or clear the index.
    reinitFtsForTests();

    expect(queryRequests({ search: "claude" }).map((r) => r.trace_id)).toEqual(["a"]);
  });

  it("upgrading an existing DB with real historical rows makes them searchable after the reconciliation backfill (REL-001)", () => {
    // This is the exact gap finding REL-001 called out: all previous FTS
    // tests called initStorage(":memory:") BEFORE any insertRequest(), so
    // `ftsExisted` was always false against an ALWAYS-EMPTY table — the
    // riskiest line (rebuilding an index over real, non-empty legacy data)
    // had zero executable proof. Here rows exist FIRST, the index is then
    // wiped out from under them, and the backfill must recover them.
    seed("legacy-1", "pre-existing production row one", "response one");
    seed("legacy-2", "pre-existing production row two", "response two");
    seed("legacy-3", "totally different content", "unrelated response");

    dropFtsTableForTests();
    reinitFtsForTests();

    expect(queryRequests({ search: "production" }).map((r) => r.trace_id).sort()).toEqual([
      "legacy-1",
      "legacy-2",
    ]);
    expect(queryRequests({ search: "different" }).map((r) => r.trace_id)).toEqual(["legacy-3"]);
  });
});
