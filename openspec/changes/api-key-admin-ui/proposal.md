# Proposal: API Key Admin UI + Dashboard Self-Auth

## Intent

The dashboard is **broken in production now**: `REQUIRE_API_KEY=true` gates every `/api/*` and `/v1/*` call, but the UI's `getJson()` sends no credential — every telemetry view 401s on first load with no way to supply a key. This change fixes that AND ships the requested UI to list/create/revoke keys with per-key usage. One mechanism unblocks both.

## Scope

### In
- Dashboard self-auth: localStorage key entry + `Authorization: Bearer` per fetch; 401 → key-entry prompt.
- Backend: `GET /api/keys` (metadata-only), `POST /api/keys` (create, plaintext once), `POST /api/keys/:id/revoke` (soft-revoke).
- `storage.ts`: `listApiKeys()` (explicit columns, never `key_hash`), `revokeApiKey(id)` (idempotent).
- UI `/keys` route: table + create dialog (reuses `CopyButton`) + revoke-with-confirm; usage column via `GET /api/telemetry/usage`; nav entry.

### Out
- Admin/role privilege model, cookie/session auth, key renaming/label edits, pagination, rate-limiting/quotas, dedicated audit log, un-revoke.

## Key Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Self-auth = localStorage + Bearer header (Approach A) | Zero backend change; reuses existing guard; VPN-only mitigates XSS. Fixes live breakage + enables admin UI at once. |
| 2 | No privilege model in v1; any valid key manages keys | Matches CLI trust model (VPN-only; all hold a key). `is_admin` is a clean additive column later. |
| 3 | Soft-revoke only (`revoked_at`); confirm dialog warns on self-lockout | Preserves `requests.api_key_id` FK + audit history; revoking your own stored key warns explicitly. |
| 4 | Routes under `/api/keys`; list/usage never return `key_hash`/plaintext; plaintext once at create | Inherits `enforceApiKey` free; mirrors CLI one-time-secret contract. |
| 5 | Usage as a column in the keys table | Reuses built `GET /api/telemetry/usage`; no separate page. |
| 6 | Tight first slice (see Out) | Ship fix + core CRUD; defer refinements. |

## Capabilities

### New
- `api-key-management`: list/create/revoke keys + per-key usage.
- `dashboard-auth`: client key entry unblocking all gated dashboard fetches.

### Modified
- None (prior `api-key-authentication` guard unchanged; not tracked as an openspec spec).

## Risks

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Dashboard 401 live in prod (URGENT/HIGH) | High/Live | Ship self-auth first — top priority. |
| Key in localStorage (XSS) | Med | VPN-only; documented; cookie auth deferred. |
| Any key mints/revokes keys | Med | Accepted v1; `is_admin` follow-up. |
| Self-lockout mid-session | Med | Confirm dialog warns on current key. |

## Rollback

Revert UI + route commits; `enforceApiKey` and schema untouched (no migration). Dashboard returns to pre-deploy state; revoke is soft/additive so no data change.

## Assumptions (auto-mode; correct if wrong)

- VPN-only trust model acceptable → no roles in v1.
- localStorage Bearer is an acceptable XSS posture here.
- Usage-per-key column suffices (no separate page).
- No un-revoke needed in v1.

## Success Criteria

- [ ] Built UI loads telemetry views without 401 after key entry.
- [ ] Create returns plaintext once; list/usage never expose `key_hash`.
- [ ] Revoke is soft, idempotent, confirm-gated; self-revoke warns.
