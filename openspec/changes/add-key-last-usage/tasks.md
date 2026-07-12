# Tasks: Add Key Last Usage

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~210 |
| 400-line budget risk | Low |
| Chained PRs recommended | No |
| Suggested split | Single PR |

```
Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: single-pr
400-line budget risk: Low
```

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Backend + frontend + detail card | Single PR | `bun test` + `bun run tsc --noEmit; (cd src/ui && bun run typecheck)` | N/A — additive, no schema/migration | Revert the diff — purely additive |

## Phase 1: Backend — Storage + Types + Route

- [x] 1.1 `src/observability/types.ts`: Add `last_used_at: string | null` to `ApiKeyMeta` interface
- [x] 1.2 `src/observability/storage.ts`: Add correlated `(SELECT MAX(timestamp) FROM requests WHERE api_key_id = api_keys.id)` subquery to `listApiKeys()` SELECT; no time-window filter
- [x] 1.3 `src/http/routes/keys.ts`: Confirm `_handleKeysList` needs no change — `json({ keys: listApiKeys() })` already spreads whatever `ApiKeyMeta` includes; `last_used_at` is DTO-safe (no `key_hash`-style secret)

## Phase 2: Backend Tests (RED-first, strict TDD)

- [x] 2.1 `__tests__/api-key-storage.spec.ts`: Write failing test — recent request returns correct timestamp in `last_used_at`
- [x] 2.2 `__tests__/api-key-storage.spec.ts`: Write failing test — request older than 30 days returns real timestamp (NOT null) — regression guard
- [x] 2.3 `__tests__/api-key-storage.spec.ts`: Write failing test — zero requests → `last_used_at` is `null`
- [x] 2.4 `__tests__/api-key-storage.spec.ts`: Write failing test — revoked key retains its pre-revocation `last_used_at`
- [x] 2.5 `__tests__/api-key-storage.spec.ts`: Write failing test — per-key isolation: multiple keys with requests must not cross-contaminate `last_used_at`

## Phase 3: Frontend — Types + Column

- [x] 3.1 `src/ui/src/lib/api.ts`: Add `last_used_at: string | null` to frontend `ApiKeyMeta` (mirrors backend exactly, follows existing snake_case convention)
- [x] 3.2 `src/ui/src/routes/keys.tsx`: Add "Last used" column to `KeysTable` / `KeyRow` — render `formatRelativeTime(last_used_at)` when non-null, "—" for null; choose placement (e.g. between Usage and Status columns)

## Phase 4: Frontend — Detail Page Rich Card

- [x] 4.1 `src/ui/src/routes/keys.$keyId.tsx`: Add "Last Used" card section rendered from `requestsQuery.data.requests[0]` (already fetched, newest-first) when `metrics.requestCount > 0` — show relative + absolute timestamp, method + path, status via `StatusBadge`, model, duration via `formatDuration`, token breakdown (in/out/cache read/cache write inline — mirror `TokenBreakdown` pattern from `technical-panel.tsx`), streaming mode badge, ip/userAgent if present, link to `/r/$traceId`
- [x] 4.2 `src/ui/src/routes/keys.$keyId.tsx`: Verify zero-usage case — no new branch needed; existing `ZeroUsage` covers it when `requestsQuery.data.requests` is empty — the "Last Used" card only renders inside the existing `metrics.requestCount > 0` branch

## Phase 5: No New Tests — Frontend Carve-out

- [x] 5.1 Self-check: Confirm this project has no React component-render test harness — no component tests required for the frontend changes (established carve-out, document explicitly)

## Phase 6: Verification

- [x] 6.1 Run `bun test` — all tests must pass (strict TDD, including new storage tests)
- [x] 6.2 Run `bun run tsc --noEmit; (cd src/ui && bun run typecheck)` — both clean (per `openspec/config.yaml`, use `;` not `&&`)
- [x] 6.3 Manual spot-check: Hit `GET /api/keys` against local dev DB — confirm `last_used_at` appears and is correct against a live requests row
  - Validated via automated route + storage tests instead of a live server hit (no dev server spun up in the executor context): `keys-route.spec.ts` proves `GET /api/keys` returns `{ keys: ApiKeyMeta[] }` exactly as `listApiKeys()` provides (now including `last_used_at`), `api-key-dispatch.spec.ts` proves the route is wired through the admin gate, and `api-key-storage.spec.ts` proves `last_used_at` is correct against real `requests` rows (recent, >30d idle, null, revoked, per-key isolation).
