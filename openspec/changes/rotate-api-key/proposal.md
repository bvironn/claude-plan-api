# Proposal: Rotate API Key

## Intent

Operators need to replace a compromised or aging API key secret **without losing the key's identity or usage history**. Today the only way to "rotate" is revoke-and-recreate, which mints a new `id` and severs all `requests.api_key_id` attribution — metrics and per-key history vanish. This change adds a first-class rotate operation that issues a fresh secret on the **same** key record, preserving all history and metrics.

## Scope

### In Scope
- Storage: `rotateApiKey(id)` — atomic in-place `UPDATE` of `prefix` + `key_hash` (+ `rotated_at`) scoped to active keys; `is_admin` untouched.
- HTTP: `POST /api/keys/:id/rotate` handler under the gated `/api/*` prefix; returns a `RotatedApiKey` DTO with the new plaintext `full` shown exactly once.
- Route registration in the server.
- UI: rotate action + one-time reveal dialog with a self-rotation lockout warning (mirrors self-revoke pattern).
- Tests: storage, route handler, and dispatch-level auth.

### Out of Scope
- Grace-period / dual-hash validity window for the old key (single-operator gateway — old key invalidates instantly).
- Explicit audit-log table (implicit `requests` attribution via `withObservability` is sufficient).
- Key versioning / historical-secret storage.
- Admin-key promotion via UI (rotation preserves `is_admin`, never sets it).

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `api-key-management`: adds a **Rotate Key** requirement (new secret + prefix on the same `id`, active-only, plaintext-once, `is_admin` preserved, revoked-key rotation rejected).

## Approach

**Approach A — in-place hash swap** (recommended by exploration). A single atomic `UPDATE api_keys SET prefix=?, key_hash=?, rotated_at=? WHERE id=? AND revoked_at IS NULL`. Because `id` never changes, `requests.api_key_id` attribution, aggregate metrics, and the per-key detail route are fully preserved. Mirrors the established `updateApiKeyLabel` mutation pattern and the `CreatedApiKey` one-time-reveal UX. Zero schema change beyond one additive `rotated_at` column.

Proposal-scope defaults (design phase finalizes):
- Old key invalidated instantly, no grace window.
- New plaintext via `full` field on `RotatedApiKey`; never persisted.
- `is_admin` strictly preserved by the UPDATE.
- Rotating a revoked key → `409 Conflict`.
- Self-rotation lockout warned in the UI.
- **Prefix IS regenerated** on rotate (new identity surface) — *design should confirm vs. prefix continuity.*
- **Add `rotated_at` column** for display — *design should confirm.*

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/observability/storage.ts` | Modified | Add `rotateApiKey(id)`; add `rotated_at` column to `api_keys` schema |
| `src/http/routes/keys.ts` | Modified | Add `handleKeysRotate` returning `RotatedApiKey` |
| `src/http/server.ts` | Modified | Register `POST /api/keys/:id/rotate` |
| `src/ui/src/lib/api.ts` | Modified | Add `rotateApiKey(id)` fetch wrapper |
| `src/ui/src/routes/keys.tsx` or `keys.$keyId.tsx` | Modified | Rotate action + one-time reveal dialog + lockout warning |
| `__tests__/api-key-storage.spec.ts`, `keys-route.spec.ts`, `api-key-dispatch.spec.ts` | Modified | Coverage for rotate |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| `UPDATE` accidentally alters `is_admin`, demoting an admin key | Low | Never list `is_admin` in the SET clause; assert in tests |
| Self-lockout: rotating the in-use admin key kills the session | Med | UI warning dialog (mirrors self-revoke) |
| Prefix drift confuses operators correlating logs by prefix | Low | Design-phase decision; documented as intentional new-identity surface |
| New `key_hash` collides with existing UNIQUE hash | Negligible | Surface the DB error, don't swallow (as `insertApiKey` does) |
| No grace period breaks callers using the old key | Low (single-operator) | Documented as intentional; one-time reveal prompts immediate swap |

## Rollback Plan

Revert the branch/PR. The additive `rotated_at` column is nullable and harmless if left in place (no code path requires it after revert). No data migration to undo; existing keys and history are untouched.

## Dependencies

- None. Builds entirely on existing `generateKey()` / `hashKey()` and the current `api_keys` schema.

## Success Criteria

- [ ] `POST /api/keys/:id/rotate` returns a new plaintext `full` exactly once and it authenticates.
- [ ] After rotation the key's `id`, `requests.api_key_id` attribution, and all metrics are unchanged.
- [ ] The old plaintext returns 401 immediately after rotation.
- [ ] Rotating a revoked key returns 409; `is_admin` is preserved across rotation.
- [ ] UI surfaces the new key once and warns on self-rotation lockout.
