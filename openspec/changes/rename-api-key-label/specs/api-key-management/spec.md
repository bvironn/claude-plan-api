# api-key-management Specification (Delta)

## ADDED Requirements

### Requirement: Rename Key Label (Active-Only, Secret-Safe)

`PATCH /api/keys/:id` MUST update only the human-facing `label` of an existing
active key via `updateApiKeyLabel(id, label)` (`UPDATE api_keys SET label = ?
WHERE id = ?`). The handler MUST ignore every other body field; it MUST NEVER
touch `key_hash`, `prefix`, `is_admin`, `created_at`, or `revoked_at`. The
response MUST return updated metadata (`id`, `prefix`, `label`, `created_at`,
`revoked_at`) built from an explicit literal DTO and MUST NEVER include
`key_hash` or any plaintext secret. The route inherits the gated `/api/*`
prefix and `enforceApiKey`.

#### Scenario: Successful rename persists the new label

- GIVEN an active key with label `"old"`
- WHEN a client calls `PATCH /api/keys/:id` with body `{ "label": "new" }`
- THEN the key's stored `label` becomes `"new"`
- AND the response returns the updated metadata with `label` `"new"`
- AND a subsequent `GET /api/keys` shows `"new"` for that key

#### Scenario: Response never leaks the secret

- GIVEN any rename request that reaches the handler
- WHEN `PATCH /api/keys/:id` produces a response (success or error)
- THEN the response body MUST NOT contain `key_hash` or any plaintext secret

#### Scenario: Non-label fields are ignored

- GIVEN an active key
- WHEN `PATCH /api/keys/:id` is called with `{ "label": "ok", "is_admin": true, "key_hash": "x" }`
- THEN only `label` is updated to `"ok"`
- AND `is_admin`, `key_hash`, `prefix`, and `revoked_at` are unchanged

### Requirement: Label Validation (Non-Empty, Trimmed)

The rename handler MUST validate the incoming `label` mirroring create: the
value MUST be a string that is non-empty after trimming. An absent, non-string,
empty, or whitespace-only `label` MUST be rejected with HTTP 400 and MUST NOT
mutate any key. The persisted `label` SHOULD be the trimmed value.

#### Scenario: Empty or whitespace label is rejected

- GIVEN an active key
- WHEN `PATCH /api/keys/:id` is called with `{ "label": "   " }` or `{ "label": "" }`
- THEN the response status is 400
- AND the key's stored `label` is unchanged

#### Scenario: Missing or non-string label is rejected

- GIVEN an active key
- WHEN `PATCH /api/keys/:id` is called with no `label`, or a non-string `label`
- THEN the response status is 400
- AND the key's stored `label` is unchanged

### Requirement: Revoked Keys Cannot Be Renamed

Renaming MUST be restricted to active keys. A `PATCH /api/keys/:id` targeting a
revoked key (`revoked_at IS NOT NULL`) MUST be rejected with HTTP 409 and MUST
NOT mutate the key. A `PATCH` targeting a nonexistent `id` MUST return HTTP 404.

Rationale: a revoked key is a terminal audit artifact — its material is dead and
its label at revocation time is part of the historical record. Mutating a
revoked key's label serves no operational purpose (the key can never
authenticate again) and risks muddying the audit trail. This mirrors revoke's
active-only semantics, keeping key-state transitions one-directional.

#### Scenario: Renaming a revoked key is rejected

- GIVEN a key whose `revoked_at` is set
- WHEN `PATCH /api/keys/:id` is called with a valid `{ "label": "new" }`
- THEN the response status is 409
- AND the key's stored `label` is unchanged

#### Scenario: Renaming a nonexistent key returns 404

- GIVEN an `id` that does not match any key
- WHEN `PATCH /api/keys/:id` is called with a valid label
- THEN the response status is 404
- AND no key is mutated
