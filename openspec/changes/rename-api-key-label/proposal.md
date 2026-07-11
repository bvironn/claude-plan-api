# Proposal: Rename API Key Label

## Intent

In the `/keys` admin UI, an API key's display `label` is fixed at creation and can never be edited. Operators who mistype a label, or need to re-purpose a key, are stuck with a wrong or stale name forever — the only workaround is revoke + re-mint, which rotates the secret needlessly. This change makes the human-facing `label` editable without touching the key material.

## Scope

### In Scope
- Backend endpoint to update an existing key's `label` (`PATCH /api/keys/:id` `{ label }`).
- `storage.ts` helper to update `label` by `id` (label-only `UPDATE`, never touches `key_hash`/`prefix`/`is_admin`/`revoked_at`).
- `/keys` UI affordance to edit a key's label inline (or via dialog) and persist it.
- `api.ts` client function (`renameApiKey`) + route registration in `server.ts`.
- Label validation mirroring create: non-empty, trimmed.

### Out of Scope
- Key rotation, deletion, or revoke changes (separate SDD changes).
- Editing `is_admin`, `prefix`, `created_at`, or any secret-bearing field.
- Renaming revoked keys (MAY be disallowed — decided in spec phase).

## Capabilities

### New Capabilities
- None

### Modified Capabilities
- `api-key-management`: add a requirement that an existing key's `label` MAY be updated via the admin surface, without affecting key material or privilege.

## Approach

Mirror the existing create/revoke pattern. Add `updateApiKeyLabel(id, label): boolean` in `storage.ts` (idempotent-style `UPDATE api_keys SET label = ? WHERE id = ?`). Add `_handleKeysRename` in `routes/keys.ts` wrapped with `withObservability` (free audit trail), returning the updated `ApiKeyMeta` via an explicit literal DTO (never spread the row — it carries `key_hash`). Register `PATCH /api/keys/:id` in `server.ts`. In the UI, add an edit control to `KeyRow` that calls `renameApiKey` and invalidates the keys query.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/observability/storage.ts` | Modified | Add label-only update helper |
| `src/http/routes/keys.ts` | Modified | Add rename handler (explicit DTO) |
| `src/http/server.ts` | Modified | Register `PATCH /api/keys/:id` |
| `src/ui/src/lib/api.ts` | Modified | Add `renameApiKey(id, label)` |
| `src/ui/src/routes/keys.tsx` | Modified | Edit-label affordance in `KeyRow` |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Accidental secret leak via response DTO | Low | Explicit literal DTO, never spread the DB row |
| Body-trusted privilege change | Low | Handler updates `label` only; ignores all other fields |
| Route regex collision with `/revoke` | Low | Scope `PATCH` to bare `/api/keys/:id` |

## Rollback Plan

Revert the five touched files. The DB schema is unchanged (no migration), so no data rollback is needed — existing labels remain intact.

## Dependencies

- None (reuses existing `api_keys` table and `withObservability`).

## Success Criteria

- [ ] `PATCH /api/keys/:id` updates the label and returns updated metadata (no secret).
- [ ] Admin can rename a key's label from `/keys` and see it persist after reload.
- [ ] Invalid/empty label returns 400; response never carries `key_hash`.
- [ ] `bun test` and `bun run tsc --noEmit` pass.
