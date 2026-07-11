# Tasks: Rotate API Key

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~600 total (backend ~290, frontend ~330) |
| 400-line budget risk | High (whole feature); each PR slice stays under 400 |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 (backend: schema/storage/route/server + backend tests) → PR 2 (frontend: types/dialog/detail card + UI test) |
| Delivery strategy | single-pr preferred, stacked-to-main chain if needed |
| Chain strategy | stacked-to-main |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High

Note: design.md estimated "well under 400 lines" for a single PR; a bottom-up
per-file estimate (storage ~20, types ~4, route ~38, server ~6, api.ts ~19,
keys.tsx ~170, keys.$keyId.tsx ~10, plus 4 RED test files ~355) totals ~600
authored lines once tests are included in the diff count. Each proposed PR
slice individually stays under 400, so the split resolves the risk without
shrinking test coverage.

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Backend: schema, `rotateApiKey`, route, server wiring | PR 1 | `bun test __tests__/api-key-storage.spec.ts __tests__/keys-route.spec.ts __tests__/api-key-dispatch.spec.ts` | Create key → POST rotate → old key 401 / new key 200 via `enforceApiKey` | Revert PR 1 branch; `rotated_at` column is additive/nullable, harmless if left |
| 2 | Frontend: `RotatedApiKey` type, `rotateApiKey()` client, `RotateKeyDialog`, detail card | PR 2 (base = PR 1 branch) | `bun test __tests__/rotate-key-dialog.spec.tsx` | `bun run build` (vite) + manual: click Rotate on `/keys`, confirm, verify one-time reveal | Revert PR 2 branch only; backend API unaffected |

## Phase 1: Schema & Storage

- [x] 1.1 RED: `__tests__/api-key-storage.spec.ts` — add `rotateApiKey` scenarios sc2 (id/attribution preserved), sc3/sc4 (is_admin 1/0 preserved), sc7 (UNIQUE collision throws, original row intact), sc8 (rotated_at set), sc9 (null when unrotated), sc10 (prefix changes, id same)
- [x] 1.2 GREEN: `src/observability/storage.ts` — add `rotated_at TEXT` to `CREATE TABLE api_keys` + `ensureColumn("api_keys","rotated_at","TEXT")`; add `rotated_at` to `listApiKeys` SELECT allowlist
- [x] 1.3 GREEN: `src/observability/storage.ts` — implement `rotateApiKey(id, prefix, keyHash, rotatedAt): boolean` — `UPDATE ... SET prefix=?,key_hash=?,rotated_at=? WHERE id=? AND revoked_at IS NULL`; no `is_admin` in SET; do not catch UNIQUE violations
- [x] 1.4 GREEN: `src/observability/types.ts` — add `rotated_at?: string | null` to `ApiKeyRecord` and `ApiKeyMeta`
- [x] 1.5 Verify: `bun test __tests__/api-key-storage.spec.ts` green

## Phase 2: Route & Server Wiring

- [x] 2.1 RED: `__tests__/keys-route.spec.ts` — add sc1 (200, `full` present, absent from list), sc5 (409 revoked), sc6 (404 unknown), sc7 (5xx on collision, original unchanged), sc8 (`rotated_at` in DTO), sc11 (no `key_hash`/prior plaintext)
- [x] 2.2 GREEN: `src/http/routes/keys.ts` — implement `_handleKeysRotate`: classify via `listApiKeys().find(id)` (absent→404, revoked→409), `generateKey()`+`hashKey()`, call `rotateApiKey`, return explicit literal `RotatedApiKey` DTO (never spread)
- [x] 2.3 GREEN: `src/http/routes/keys.ts` — export `handleKeysRotate = withObservability(_handleKeysRotate)`
- [x] 2.4 GREEN: `src/http/server.ts` — import `handleKeysRotate`; register `POST /^\/api\/keys\/[^/]+\/rotate$/` under the `/api/*` admin gate
- [x] 2.5 RED: `__tests__/api-key-dispatch.spec.ts` — add sc1 (old key 401 / new key 200 after rotate via `enforceApiKey`), sc3-equivalent (admin key still passes `/api/*` post-rotate)
- [x] 2.6 Verify: `bun test __tests__/keys-route.spec.ts __tests__/api-key-dispatch.spec.ts` green

**PR 1 boundary** — backend rotate feature complete and independently revertable here.

## Phase 3: Frontend Types & API Client

- [ ] 3.1 GREEN: `src/ui/src/lib/api.ts` — add `RotatedApiKey` interface (no `key_hash`) and `rotateApiKey(id)` POST wrapper; add `rotated_at?: string | null` to `ApiKeyMeta`

## Phase 4: UI Rotate Dialog

- [ ] 4.1 RED: `__tests__/rotate-key-dialog.spec.tsx` (new, repo root) — sc12 (self-lockout warning when target matches stored key), sc13 (`full` shown once, gone after dismiss)
- [ ] 4.2 GREEN: `src/ui/src/routes/keys.tsx` — add Rotate button to `KeyRow` + `rotateTarget` state wiring
- [ ] 4.3 GREEN: `src/ui/src/routes/keys.tsx` — implement `RotateKeyDialog`: confirm step with `isStoredKeyPrefix` self-lockout warning (mirrors `RevokeKeyDialog`), on confirm call `rotateApiKey(id)`, one-time reveal step (mirrors `CreateKeyDialog`), invalidate `["keys"]`/`["keys-usage"]`
- [ ] 4.4 GREEN: `src/ui/src/routes/keys.$keyId.tsx` — show `rotated_at` in `MetadataCard` when present
- [ ] 4.5 Verify: `bun test __tests__/rotate-key-dialog.spec.tsx` green; `bun run build` succeeds

**PR 2 boundary** — frontend rotate UI complete, independently revertable, base = PR 1 branch.

## Phase 5: Full Verification

- [ ] 5.1 `bun test` (full suite) green
- [ ] 5.2 Smoke: create key → rotate → old key 401, new key 200 (end-to-end sc1)
