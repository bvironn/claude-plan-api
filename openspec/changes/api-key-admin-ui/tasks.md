# Tasks: API Key Admin UI + Dashboard Self-Auth

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~740 (260 backend + ~60 backend tests + ~420 frontend + ~60 frontend tests) |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR 1: Backend → PR 2: Frontend auth infra → PR 3: Keys UI route |
| Delivery strategy | auto-forecast |
| Chain strategy | stacked-to-main |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Notes |
|------|------|-----------|-------|
| 1 | Backend routes + storage + tests | PR 1 → main | Standalone additive — endpoints exist but unlinked from UI |
| 2 | Frontend auth infra + api.ts + __root.tsx + replay-button.tsx fix + pure-logic tests | PR 2 → main | Fixes production 401 breakage; depends on nothing |
| 3 | Keys UI route + nav + manual verification + useEventStream doc | PR 3 → main | Depends on PR 1's routes being live |

## Phase 1: Backend Storage & Types

- [x] 1.1 Add `ApiKeyMeta` DTO to `src/observability/types.ts` — `{id,prefix,label,created_at,revoked_at}`, no `key_hash`
- [x] 1.2 Add `listApiKeys()` to `src/observability/storage.ts` — explicit column SELECT (never `SELECT *`), DESC by `created_at`
- [x] 1.3 Add `revokeApiKey(id)` to `storage.ts` — idempotent soft-revoke: `UPDATE SET revoked_at=? WHERE id=? AND revoked_at IS NULL`, returns boolean

## Phase 2: Backend HTTP Routes

- [x] 2.1 Create `src/http/routes/keys.ts` — `GET /api/keys` → `{keys: ApiKeyMeta[]}`
- [x] 2.2 `POST /api/keys` `{label}` → 201 with explicit literal DTO `{id,prefix,label,created_at,full}` — never spread `ApiKeyRecord`/DB row; fail-fast on empty `getApiKeyPepper()`
- [x] 2.3 `POST /api/keys/:id/revoke` → `{revoked: boolean}` (idempotent via `revokeApiKey`); regex match `^/api/keys/[^/]+/revoke$`
- [x] 2.4 Wire imports + dispatch in `src/http/server.ts` (after telemetry block, ~line 84)

## Phase 3: Backend Tests

- [x] 3.1 Extend `__tests__/api-key-storage.spec.ts` — `listApiKeys`: returned items have no `key_hash`, DESC order; `revokeApiKey`: idempotent (2nd call `false`, unknown id `false`)
- [x] 3.2 Create `__tests__/keys-route.spec.ts` — list/create/revoke shapes; **negative test**: create response JSON has NO `key_hash` key; create fail-fast on empty pepper (`spyOn(storage)` + `Request`, mirrors telemetry-usage-route pattern)
- [x] 3.3 Extend `__tests__/api-key-dispatch.spec.ts` — `/api/keys*` returns 401 without key header

## Phase 4: Frontend Auth Infrastructure

- [ ] 4.1 Create `src/ui/src/lib/auth.ts` — `getStoredKey`/`setStoredKey`/`clearStoredKey` (`localStorage` key `cpk_dashboard_key`); `authHeaders()` returns `{Authorization: "Bearer "+key}` or `{}`; `parseKeyPrefix(full)` = `full.split(".")[0]`; minimal external store (`subscribe`/`getSnapshot`/`requireKey`/`dismiss`) consumed via `useSyncExternalStore`
- [ ] 4.2 Modify `src/ui/src/lib/api.ts` — `getJson()` merges `...authHeaders()` in fetch headers; on `res.status===401` throw `new UnauthorizedError()`; **delete dead `replay()`** export (zero callers)
- [ ] 4.3 Modify `src/ui/src/components/transcript/replay-button.tsx` — merge `...authHeaders()` into raw `fetch("/v1/chat/completions")` headers; on `res.status===401` call `authStore.requireKey()`
- [ ] 4.4 Modify `src/ui/src/main.tsx` — add `QueryClient({ defaultOptions: { queries: { retry: (count, err) => !(err instanceof UnauthorizedError) && count < 1 } }, queryCache: new QueryCache({ onError: ... }) })` wiring
- [ ] 4.5 Modify `src/ui/src/routes/__root.tsx` — mount `<AuthGate>` component before `<Outlet />`, wired to auth store state

## Phase 5: Frontend Keys UI Route

- [ ] 5.1 Create `src/ui/src/routes/keys.tsx` — TanStack Query list → `Table` (id/prefix/label/created_at/usage/revoked_at); create `Dialog`+`Input`+`Label` showing plaintext `full` once with reused `CopyButton`; revoke confirm `Dialog` with null-guarded self-lockout warning (`s=getStoredKey(); s!=null && row.prefix===parseKeyPrefix(s)`); command refetch via `queryClient.invalidateQueries(["keys"])`; `errorComponent: RouteError`
- [ ] 5.2 Add nav entry `{ to:"/keys", label:"Keys", icon: KeyRoundIcon }` to `NAV` array in `src/ui/src/components/layout/app-header.tsx`
- [ ] 5.3 Resolve `src/ui/src/routes/keys.tsx` file routing — route tree gen `tsr generate`

## Phase 6: Frontend Pure-Logic Unit Tests

- [ ] 6.1 Create `__tests__/ui-auth.spec.ts` — `parseKeyPrefix` splits correctly; `authHeaders()` returns `{}` when no `localStorage` key and `{Authorization: "Bearer ..."}` when present; self-lockout null guard: `null` stored key → no warning, never calls `parseKeyPrefix(null)`

## Phase 7: Documentation & Manual Verification

- [ ] 7.1 Document `useEventStream.ts` EventSource limitation: browser EventSource cannot attach `Authorization` header → Live view `/api/telemetry/stream` stays 401 under `REQUIRE_API_KEY=true`. Correct fix = query-param/short-lived stream token on the stream route (backend + security-sensitive, out of this slice). Fails soft via `onerror` backoff-reconnect. Add note to `design.md` and/or `keys.tsx`.
- [ ] 7.2 Manual verification: `cd src/ui && bun run build` → deploy/restart live systemd service → walk through: 401→key-entry→retry succeeds on telemetry views; create key shows plaintext once; list never exposes `key_hash` column; revoke soft-deletes + self-lockout warning on stored key; Replay button works with stored key transmitted as Bearer
