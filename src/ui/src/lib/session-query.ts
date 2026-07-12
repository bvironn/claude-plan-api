/**
 * Shared query config for resolving a session-detail view.
 *
 * The session-detail page (`s.$sessionId.tsx`) resolves a `sessionId` by
 * grouping the recent chat-completions list, then fetches each turn's full
 * transcript on demand via `getRequest` (by-id). Historically the detail view
 * ran this grouping list on `refetchInterval: 10_000`, re-pulling all 500 rows
 * — WITH their full request/response/upstream bodies — every 10 seconds
 * (audit finding #3).
 *
 * This module extracts that grouping query into a lightweight resolver:
 *   - a positive `staleTime` -> keep the grouped list warm so re-opening a
 *     session reuses the cache instead of refetching on every navigation;
 *   - a stable, shared `queryKey` -> every detail visit reads from ONE cache
 *     entry rather than each firing its own independent fetch;
 *   - a moderate `refetchInterval` -> see REL-001 below.
 *
 * The grouping fetch uses the DEFAULT list shape and never opts into full
 * bodies: `groupIntoConversations` only needs the metadata + first-user text to
 * derive conversation identity, and each turn's transcript is fetched
 * separately by `getRequest`. Once the slim default list projection lands, this
 * exact call returns slim rows (with `firstUserPreview`) at zero cost here.
 *
 * REL-001 (deliberate tradeoff, not an oversight): React Query only refetches
 * a stale query on a TRIGGER event (mount, window focus, reconnect, manual
 * invalidate) — never purely from elapsed time. Without a `refetchInterval`,
 * a user who opens a session detail view and leaves the tab open AND focused
 * gets no trigger at all, so they'd never see new turns added elsewhere to
 * that same conversation. `SESSION_GROUPING_REFETCH_INTERVAL_MS` restores a
 * periodic trigger — WITHOUT reverting to the old 10s/500-row full-body poll
 * (finding #3): this call still resolves the slim default list shape, not
 * full bodies, so the recurring fetch here is cheap regardless of interval.
 *
 * Kept side-effect-free and React-free so the polling/caching contract is
 * unit-testable in isolation from the component.
 */

import { listRequests, type RequestListResponse } from "./api"

/**
 * Stable key both the grouping resolver and future callers can share so a
 * resolved session list is cached under one entry across detail navigations.
 */
export const SESSION_GROUPING_QUERY_KEY = ["requests", "chat-grouping"] as const

/**
 * Resolve-once window. Long enough that navigating between sessions reuses the
 * cached grouping instead of refetching, while still going stale in between
 * refetch triggers so the list can't drift forever. The old behaviour
 * re-fetched the full payload every 10s; this is a slim resolve, not a
 * full-body poll.
 */
export const SESSION_GROUPING_STALE_TIME_MS = 30_000

/**
 * Periodic refetch trigger (REL-001). Set equal to the staleTime above so the
 * interval and staleness align: by the time the interval fires, the data is
 * guaranteed stale and the refetch isn't wasted. This is what lets a
 * session-detail view left open AND focused still pick up new turns without
 * the user having to navigate away and back — see the REL-001 note in the
 * module doc comment above for why this exists.
 */
export const SESSION_GROUPING_REFETCH_INTERVAL_MS = SESSION_GROUPING_STALE_TIME_MS

/**
 * Query options for the session-grouping resolver. Spread into `useQuery` by
 * the session-detail route.
 */
export function sessionGroupingQueryOptions(): {
  queryKey: typeof SESSION_GROUPING_QUERY_KEY
  queryFn: () => Promise<RequestListResponse>
  staleTime: number
  refetchInterval: number
} {
  return {
    queryKey: SESSION_GROUPING_QUERY_KEY,
    queryFn: () =>
      listRequests({ path: "/v1/chat/completions", limit: 500, order: "desc" }),
    staleTime: SESSION_GROUPING_STALE_TIME_MS,
    refetchInterval: SESSION_GROUPING_REFETCH_INTERVAL_MS,
  }
}
