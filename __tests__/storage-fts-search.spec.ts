import { describe, it, expect, beforeEach } from "bun:test";
import {
  initStorage,
  insertRequest,
  updateRequest,
  queryRequests,
  countRequests,
  sanitizeFtsQuery,
  buildRequestSearchClause,
  isFtsAvailable,
  setFtsAvailableForTests,
} from "../src/observability/storage.ts";

// ---------------------------------------------------------------------------
// FTS5-backed request search (finding #6)
//
// The `search` filter used to run an unindexed `request_body LIKE '%term%' OR
// response_body LIKE '%term%'` full-table scan. It is now backed by an additive,
// external-content FTS5 virtual table (`requests_fts`) kept in sync by triggers,
// with a transparent LIKE fallback when FTS is unavailable.
//
// Fresh in-memory DB per test; FTS is (re)built by initStorage each time.
// ---------------------------------------------------------------------------

function seed(traceId: string, requestBody: string, responseBody = ""): void {
  insertRequest({
    trace_id: traceId,
    timestamp: new Date().toISOString(),
    request_body: requestBody,
    response_body: responseBody,
  });
}

const traces = (): string[] => queryRequests({ search: "claude" }).map((r) => r.trace_id);

beforeEach(() => {
  initStorage(":memory:");
});

describe("sanitizeFtsQuery — safe FTS5 MATCH construction", () => {
  it("wraps the term as a double-quoted prefix phrase", () => {
    expect(sanitizeFtsQuery("claude")).toBe(`"claude"*`);
  });

  it("escapes embedded double quotes by doubling them (no operator injection)", () => {
    expect(sanitizeFtsQuery(`a"b`)).toBe(`"a""b"*`);
  });
});

describe("buildRequestSearchClause — FTS vs LIKE branch", () => {
  it("emits an indexed FTS MATCH subquery when useFts is true", () => {
    const clause = buildRequestSearchClause("foo", true);
    expect(clause.cond).toBe(
      "id IN (SELECT rowid FROM requests_fts WHERE requests_fts MATCH ?)"
    );
    expect(clause.vals).toEqual([`"foo"*`]);
  });

  it("emits the original LIKE substring scan when useFts is false", () => {
    const clause = buildRequestSearchClause("foo", false);
    expect(clause.cond).toBe("(request_body LIKE ? OR response_body LIKE ?)");
    expect(clause.vals).toEqual(["%foo%", "%foo%"]);
  });
});

describe("storage — FTS request search (#6)", () => {
  it("reports FTS as available after initStorage on a build with FTS5", () => {
    expect(isFtsAvailable()).toBe(true);
  });

  it("matches a whole token in request_body and excludes non-matching rows", () => {
    seed("a", "the claude sonnet model answered");
    seed("b", "a gpt-4 style completion");

    const rows = queryRequests({ search: "claude" });
    expect(rows.map((r) => r.trace_id)).toEqual(["a"]);
    expect(countRequests({ search: "claude" })).toBe(1);
  });

  it("matches a word by prefix (sonnet found by 'son')", () => {
    seed("a", "claude sonnet");
    seed("b", "claude opus");

    expect(queryRequests({ search: "son" }).map((r) => r.trace_id)).toEqual(["a"]);
  });

  it("matches a token that only appears in response_body", () => {
    seed("a", "request text", "the widget was created");
    seed("b", "request text", "nothing relevant here");

    expect(queryRequests({ search: "widget" }).map((r) => r.trace_id)).toEqual(["a"]);
  });

  it("returns no rows and count 0 when nothing matches", () => {
    seed("a", "claude sonnet", "response");

    expect(queryRequests({ search: "nonexistentxyz" })).toEqual([]);
    expect(countRequests({ search: "nonexistentxyz" })).toBe(0);
  });

  it("keeps the index in sync when a request body is updated (AFTER UPDATE trigger)", () => {
    seed("a", "claude sonnet original");
    expect(traces()).toEqual(["a"]); // indexed on insert

    updateRequest("a", { request_body: "opus rewrite only" });

    // Old token no longer matches; the new token does — proves the trigger
    // re-indexed the row rather than leaving a stale FTS entry.
    expect(queryRequests({ search: "claude" })).toEqual([]);
    expect(queryRequests({ search: "opus" }).map((r) => r.trace_id)).toEqual(["a"]);
  });

  it("keeps countRequests and queryRequests consistent under a search filter", () => {
    seed("a", "claude sonnet");
    seed("b", "claude opus");
    seed("c", "gpt only");

    expect(countRequests({ search: "claude" })).toBe(
      queryRequests({ search: "claude" }).length
    );
    expect(countRequests({ search: "claude" })).toBe(2);
  });
});

describe("storage — transparent LIKE fallback when FTS is unavailable (#6)", () => {
  it("returns the SAME token matches via the LIKE path as via FTS", () => {
    seed("a", "the claude sonnet model");
    seed("b", "a gpt-4 completion");

    const viaFts = queryRequests({ search: "claude" }).map((r) => r.trace_id);

    setFtsAvailableForTests(false);
    const viaLike = queryRequests({ search: "claude" }).map((r) => r.trace_id);
    setFtsAvailableForTests(true);

    expect(viaFts).toEqual(["a"]);
    expect(viaLike).toEqual(["a"]); // identical result set → transparent fallback
    expect(viaLike).not.toContain("b");
  });

  it("documents the semantic difference: LIKE fallback matches mid-token substrings the FTS token index does not", () => {
    seed("a", "anthropic claude");

    // FTS is prefix/token matching: 'laude' is not a token prefix → no match.
    expect(queryRequests({ search: "laude" })).toEqual([]);

    setFtsAvailableForTests(false);
    // LIKE '%laude%' is substring matching → it DOES match inside "claude".
    expect(queryRequests({ search: "laude" }).map((r) => r.trace_id)).toEqual(["a"]);
    setFtsAvailableForTests(true);
  });
});

// Source-text guard (this repo's __tests__/ is DOM-free by convention — see
// dashboard-performance.spec.ts). The switch from LIKE substring to FTS token/
// prefix matching is a user-visible behavior change, so the search field MUST
// disclose it rather than change semantics silently.
describe("ui — search field discloses full-text (token) search (#6)", () => {
  const filtersPath = new URL(
    "../src/ui/src/components/layout/requests-filters.tsx",
    import.meta.url
  );

  it("labels the search input as full-text search", async () => {
    const source = await Bun.file(filtersPath).text();
    expect(source).toContain("Full-text search");
  });

  it("explains word/prefix (not substring) matching via a title tooltip", async () => {
    const source = await Bun.file(filtersPath).text();
    expect(source).toMatch(/title=.*word-prefixes.*not arbitrary substrings/s);
  });
});
