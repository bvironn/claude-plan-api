# Tasks: Filter Sessions & Requests by API Key

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~250 |
| 400-line budget risk | Low |
| Chained PRs recommended | No |
| Suggested split | Single PR |
| Delivery strategy | auto-forecast |
| Chain strategy | stacked-to-main |

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: stacked-to-main
400-line budget risk: Low

## Phase 1: Foundation — Backend Storage

- [x] 1.1 Add `apiKeyId?: number` to `RequestFilters` in `src/observability/storage.ts`
- [x] 1.2 Add `apiKeyId != null` guard to `buildRequestWhere()` — appends `api_key_id = ?`, matching `minDuration`/`maxDuration` pattern

## Phase 2: Core — Backend Route

- [x] 2.1 Parse `apiKeyId` in `_handleTelemetryRequests()` (`src/http/routes/telemetry/requests.ts`) using `parseNum(…, -1)` — NOT bare `parseFloat` — sentinel `>= 0` → `apiKeyId`, otherwise `undefined` (spec: invalid/absent → unfiltered)
- [x] 2.2 Add `apiKeyId` to `toCamel()` projection

## Phase 3: Integration — UI Types & Components

- [x] 3.1 Add `apiKeyId?: number` to UI `RequestFilters` and `RequestRecord` in `src/ui/src/lib/types.ts`
- [x] 3.2 Create `<ApiKeySelect>` component (`src/ui/src/components/layout/`) — props: `apiKeys`, `value`, `onChange` — "All keys" default, revoked keys labeled distinctly

## Phase 4: Wiring — Requests & Sessions Views

- [x] 4.1 Wire `ApiKeySelect` into `requests-filters.tsx` — add `apiKeys` prop, embed after model toggle
- [x] 4.2 Add `apiKeyId` to `IndexSearch` + `validateSearch` in `index.tsx` — parse, add to `apiFilters`, fetch keys via `useQuery(["api-keys"], …)`, pass to `RequestsFilters`
- [x] 4.3 Add key selector to `sessions.tsx` — fetch keys, hold `apiKeyId` state, pass to `listRequests`, derive query key from `apiKeyId` for re-fetch, filtered → `groupIntoConversations`

## Phase 5: Testing

- [x] 5.1 Storage tests (`__tests__/telemetry-key-filter.spec.ts`) — in-memory DB, insert rows with varying `api_key_id`, assert `queryRequests`/`countRequests` for matching, non-matching, omitted, and invalid cases
- [x] 5.2 Route tests (same file) — spy on storage, assert param forwarding for valid, absent, and invalid `apiKeyId` (invalid → unfiltered, not error)
- [x] 5.3 UI fetch-wrapper tests (DOM-free, `ui-api-keys.spec.ts` pattern) — mock `fetch`, call `listRequests({ apiKeyId: 5 })`, assert `?apiKeyId=5` in URL

## Implementation Order

Storage → route → UI types/component → view wiring → tests. `strict_tdd` requires tests before marking any task done.
