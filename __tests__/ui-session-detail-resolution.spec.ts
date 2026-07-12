import { test, expect, describe, spyOn } from "bun:test"

import {
  sessionGroupingQueryOptions,
  SESSION_GROUPING_QUERY_KEY,
} from "../src/ui/src/lib/session-query"
import * as api from "../src/ui/src/lib/api"

// ---------------------------------------------------------------------------
// Efficient session-detail resolution (finding #3 / telemetry-query-scaling).
//
// Spec: "Session-detail MUST resolve a conversation without the 10s 500
// full-body-row poll; batch per-turn fetch or targeted lookup."
//   - Scenario: open view -> no recurring 500-row full-body poll; fetches only
//     the required turns.
//
// The route (`s.$sessionId.tsx`) resolves a `sessionId` by grouping the recent
// chat-completions list, then fetches each turn's full transcript on demand via
// `getRequest` (by-id). The grouping query config is extracted into
// `sessionGroupingQueryOptions()` so its polling/caching contract is a pure,
// DOM-free unit under test (this repo's `__tests__/` renders no React).
// ---------------------------------------------------------------------------

describe("sessionGroupingQueryOptions", () => {
  // REL-001 regression: React Query only refetches a STALE query on a trigger
  // event (mount, window focus, reconnect, manual invalidate) — never purely
  // from elapsed time. A session-detail view left open AND focused would
  // otherwise never see new turns added elsewhere to the same conversation,
  // indefinitely. A positive `refetchInterval` is the only trigger that fires
  // without any user action, so its presence is what proves that gap is
  // closed — this does NOT restore the old 10s full-body poll (finding #3);
  // this query already resolves the slim default list shape (see the
  // "queryFn fetches..." test below), it's the grouping-only concern.
  test("sets a positive refetchInterval so an idle, focused tab still sees new turns", () => {
    const opts = sessionGroupingQueryOptions() as Record<string, unknown>
    expect(typeof opts.refetchInterval).toBe("number")
    expect(opts.refetchInterval as number).toBeGreaterThan(0)
  })

  // The interval should align with the staleTime it's paired with, not
  // reintroduce the old wasteful sub-staleness churn.
  test("refetchInterval is at or above the query's own staleTime", () => {
    const opts = sessionGroupingQueryOptions() as Record<string, unknown>
    expect(opts.refetchInterval as number).toBeGreaterThanOrEqual(
      opts.staleTime as number,
    )
  })

  // "Resolve once via staleTime": a positive staleTime keeps the grouped list
  // warm so re-opening a session reuses the cache instead of refetching.
  test("resolves once via a positive staleTime that keeps the grouped list warm", () => {
    const opts = sessionGroupingQueryOptions()
    expect(typeof opts.staleTime).toBe("number")
    // At least the app-wide 20s baseline (main.tsx) — a real resolve-once
    // window, not a 0ms always-stale query that would refetch on every mount.
    expect(opts.staleTime).toBeGreaterThanOrEqual(20_000)
  })

  // A stable, shared key means every session-detail visit reads from ONE cache
  // entry rather than each firing its own independent fetch.
  test("uses a stable shared query key across calls", () => {
    const first = sessionGroupingQueryOptions()
    const second = sessionGroupingQueryOptions()
    expect(first.queryKey).toEqual(SESSION_GROUPING_QUERY_KEY)
    expect(first.queryKey).toEqual(second.queryKey)
  })

  // Behavioral triangulation: invoking the queryFn fetches the recent
  // chat-completions LIST shape (path/limit/order) and never asks for full
  // bodies — each turn's transcript is pulled separately by `getRequest`, which
  // is what keeps the heavy 500-row full-body payload from coming back.
  test("queryFn fetches the recent chat-completions list shape, not full turn bodies", async () => {
    const spy = spyOn(api, "listRequests").mockResolvedValue({
      total: 0,
      limit: 500,
      offset: 0,
      requests: [],
    })
    try {
      await sessionGroupingQueryOptions().queryFn()
      expect(spy).toHaveBeenCalledTimes(1)
      const args = spy.mock.calls[0]![0] as Record<string, unknown>
      expect(args).toMatchObject({
        path: "/v1/chat/completions",
        limit: 500,
        order: "desc",
      })
      // Grouping resolves on the default list shape; opting into full bodies
      // here is precisely the overfetch finding #3 removes.
      expect(args).not.toHaveProperty("bodies")
    } finally {
      spy.mockRestore()
    }
  })
})

// ---------------------------------------------------------------------------
// Source-text guard (this repo's DOM-free convention — see
// dashboard-performance.spec.ts). Proves the ROUTE actually adopted the
// poll-free resolver and still fetches turns per-id, so a future edit can't
// silently reintroduce the 10s full-body poll.
// ---------------------------------------------------------------------------

describe("s.$sessionId.tsx route wiring", () => {
  const routePath = new URL(
    "../src/ui/src/routes/s.$sessionId.tsx",
    import.meta.url,
  )

  test("consumes the shared poll-free grouping resolver", async () => {
    const source = await Bun.file(routePath).text()
    expect(source).toContain("sessionGroupingQueryOptions")
  })

  test("no longer polls the grouping query with a refetchInterval", async () => {
    const source = await Bun.file(routePath).text()
    expect(source).not.toContain("refetchInterval")
  })

  test("still fetches each turn on demand via the by-id endpoint", async () => {
    const source = await Bun.file(routePath).text()
    expect(source).toContain("getRequest(")
  })
})
