# Tasks: Rename API Key Label

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

### Suggested Work Units

| Unit | Goal | Likely PR | Notes |
|------|------|-----------|-------|
| 1 | Backend + Frontend rename-key label feature | PR 1 | Single PR, well under 400 lines. Tests included. |

## Phase 1: Backend Storage Layer

- [x] 1.1 Add `updateApiKeyLabel(id: number, label: string): boolean` in `src/observability/storage.ts` — `UPDATE api_keys SET label = ? WHERE id = ? AND revoked_at IS NULL`; returns `true` if a row changed. (Red test first in `__tests__/api-key-storage.spec.ts`: active key updates → true, revoked key → false, nonexistent id → false.)

## Phase 2: Backend Route Handler

- [x] 2.1 Add `_handleKeysRename` in `src/http/routes/keys.ts` — parse body, validate label (non-empty after trim, matching create), reject with 400 on missing/invalid. Build explicit `ApiKeyMeta` literal DTO (never spread a row). Call `updateApiKeyLabel`. Return updated DTO on success. (Spec: 4 validation scenarios, 2 error states.)

- [x] 2.2 Revoked-key guard — 409 when `updateApiKeyLabel` returns `false` (key active-only). Distinguish 404 (nonexistent id) from 409 (revoked key) by a preliminary `listApiKeys` lookup or a second query. (Spec: revoked 409, nonexistent 404.)

## Phase 3: Backend Route Registration

- [x] 3.1 Import `handleKeysRename` in `src/http/server.ts` and register `PATCH /api/keys/:id` using regex test (mirrors revoke registration). Add `PATCH` to the CORS allow-methods header.

## Phase 4: Backend Route Tests

- [x] 4.1 Route-level tests in `__tests__/keys-route.spec.ts` covering all 6 spec requirements via `spyOn(storage)` + real `Request`:
  - Success: label persists, DTO has correct shape, no `key_hash` in raw serialization
  - Secret-never-leaked: both success and error responses checked for `key_hash` absence
  - Non-label fields ignored: extra body fields (`is_admin`, `key_hash`) do not affect the stored label
  - Empty/invalid label 400: blank, whitespace, missing, non-string all rejected; storage not called
  - Revoked key 409: `updateApiKeyLabel` returns `false` on an active-only lookup
  - Nonexistent key 404: key not found via preliminary lookup

## Phase 5: Frontend API Client

- [x] 5.1 Add `renameApiKey(id: number, label: string): Promise<ApiKeyMeta>` in `src/ui/src/lib/api.ts` — calls `PATCH /api/keys/${id}` via `fetch` with `{ label }` body (note: no `postJson`/`getJson` — need a `patchJson` or inline fetch since existing helpers only do GET/POST). Add covering tests in `__tests__/ui-api-keys.spec.ts` (mirror create/revoke patterns).

## Phase 6: Frontend UI Edit Affordance

- [x] 6.1 Add inline-rename state and edit control to `KeyRow` in `src/ui/src/routes/keys.tsx` — click label → `<Input>` with current value → confirm (Enter/blur) calls `renameApiKey` → invalidate `["keys"]` query on success. Show validation error inline. Disable edit for revoked keys.

## Quality Gates

- [x] `bun test` passes (all existing + new tests) — 519 pass, all 4 api-key suites green; the single failure (`observability.spec.ts` 30s hook timeout on a real server spawn + upstream 429) is PRE-EXISTING and reproduces identically on the baseline commit, unrelated to this change.
- [x] `bun run tsc --noEmit` passes (no type errors) — zero new errors introduced; the 7 remaining errors all live in the untouched `__tests__/transform-streaming-abort-signal.spec.ts` and are PRE-EXISTING on baseline.
