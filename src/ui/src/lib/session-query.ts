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
 * This module extracts that grouping query into a single poll-free resolver:
 *   - no `refetchInterval` -> no recurring background poll;
 *   - a positive `staleTime` -> resolve once and keep the grouped list warm,
 *     so re-opening a session reuses the cache instead of refetching;
 *   - a stable, shared `queryKey` -> every detail visit reads from ONE cache
 *     entry rather than each firing its own independent fetch.
 *
 * The grouping fetch uses the DEFAULT list shape and never opts into full
 * bodies: `groupIntoConversations` only needs the metadata + first-user text to
 * derive conversation identity, and each turn's transcript is fetched
 * separately by `getRequest`. Once the slim default list projection lands, this
 * exact call returns slim rows (with `firstUserPreview`) at zero cost here.
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
 * cached grouping instead of refetching, while still going stale (React Query
 * refetches on a later remount/refocus) so the list can't drift forever. The
 * old behaviour re-fetched the full payload every 10s; this is a one-shot
 * resolve, not a live poll.
 */
export const SESSION_GROUPING_STALE_TIME_MS = 30_000

/**
 * Query options for the session-grouping resolver. Spread into `useQuery` by
 * the session-detail route.
 */
export function sessionGroupingQueryOptions(): {
  queryKey: typeof SESSION_GROUPING_QUERY_KEY
  queryFn: () => Promise<RequestListResponse>
  staleTime: number
} {
  return {
    queryKey: SESSION_GROUPING_QUERY_KEY,
    queryFn: () =>
      listRequests({ path: "/v1/chat/completions", limit: 500, order: "desc" }),
    staleTime: SESSION_GROUPING_STALE_TIME_MS,
  }
}
