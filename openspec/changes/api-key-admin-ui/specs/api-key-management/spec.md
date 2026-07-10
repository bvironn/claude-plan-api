# api-key-management Specification

## Purpose

Defines the HTTP and storage behavior for managing API keys from the dashboard: list metadata, create (plaintext once), soft-revoke, and per-key usage. All routes land under the already-gated `/api/*` prefix and inherit `enforceApiKey`. Secrets (`key_hash`, plaintext) MUST NEVER leak through list or usage paths.

---

## Requirements

### Requirement: List Keys (Metadata Only)

`GET /api/keys` MUST return only key metadata: `id`, `prefix`, `label`, `created_at`, `revoked_at`. The response MUST NEVER include `key_hash` or any plaintext secret. `listApiKeys()` MUST select explicit columns, never `SELECT *`.

#### Scenario: List omits secrets

- GIVEN one or more keys exist
- WHEN a client calls `GET /api/keys`
- THEN each item contains `id`, `prefix`, `label`, `created_at`, `revoked_at`
- AND no item contains `key_hash` or a plaintext secret

---

### Requirement: Create Key (Plaintext Once)

`POST /api/keys` MUST create a key via the existing `generateKey()` → `hashKey()` → `insertApiKey()` sequence and MUST return the plaintext key exactly once in the create response. The plaintext MUST NOT be retrievable afterward.

#### Scenario: Create returns plaintext once and it authenticates

- GIVEN a valid create request
- WHEN `POST /api/keys` succeeds
- THEN the response includes the plaintext key exactly once
- AND using that key as Bearer on a subsequent gated request returns 200
- AND the plaintext is absent from any later `GET /api/keys` response

---

### Requirement: Revoke Key (Soft, Idempotent, Active-Only)

`POST /api/keys/:id/revoke` MUST set `revoked_at` via `revokeApiKey(id)` (`UPDATE api_keys SET revoked_at=? WHERE id=? AND revoked_at IS NULL`). A revoked key MUST immediately fail `enforceApiKey`'s active-only check. Revoking an already-revoked or nonexistent id MUST be an idempotent no-op, not an error.

#### Scenario: Revoke deactivates the key

- GIVEN an active key
- WHEN `POST /api/keys/:id/revoke` is called
- THEN `revoked_at` is set on that key
- AND a subsequent request using that key fails `enforceApiKey` with 401

#### Scenario: Revoke is idempotent

- GIVEN a key that is already revoked, or an id that does not exist
- WHEN `POST /api/keys/:id/revoke` is called
- THEN the response is a successful no-op with no error raised

---

### Requirement: Self-Lockout Warning

The revoke confirm dialog MUST explicitly warn when the key being revoked is the key currently stored in the operator's `localStorage`.

#### Scenario: Revoking the stored key warns of self-lockout

- GIVEN the key stored in `localStorage` matches the key being revoked
- WHEN the operator opens the revoke confirm dialog
- THEN the dialog explicitly warns that this will lock out the current session

---

### Requirement: Per-Key Usage Column

The `/keys` UI MUST surface per-key usage totals sourced from `GET /api/telemetry/usage` (reusing `getUsageByApiKey`), matched to each key by `api_key_id`.

#### Scenario: Usage column shows correct totals

- GIVEN keys with recorded request and token usage
- WHEN the `/keys` table renders
- THEN each row shows that key's totals from `GET /api/telemetry/usage`
- AND the totals match `getUsageByApiKey` for the same key
