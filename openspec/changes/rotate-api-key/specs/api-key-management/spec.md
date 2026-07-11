# api-key-management Specification (Delta)

## ADDED Requirements

### Requirement: Rotate Key (In-Place Secret Swap, Active-Only, Plaintext Once)

`POST /api/keys/:id/rotate` SHALL generate a new `(prefix, key_hash)` pair via
the existing `generateKey()` → `hashKey()` pipeline and atomically `UPDATE` them
in place on the same `api_keys` row, also setting `rotated_at` to the current
UTC ISO timestamp. The handler MUST be registered under the gated `/api/*`
prefix and MUST inherit the `enforceApiKey` + admin-only guard identical to all
other `/api/keys` operations.

The response MUST return a `RotatedApiKey` DTO with the following fields:
`id`, `prefix`, `label`, `created_at`, `revoked_at`, `rotated_at`, and `full`
(the new plaintext key). The `full` field MUST be returned **exactly once** in
this response; it MUST NOT be persisted to the database and MUST NOT appear in
any subsequent list or metadata response.

The `id` of the key SHALL remain unchanged after rotation. All existing
`requests.api_key_id` attributions, aggregate metrics, and per-key detail
queries remain linked to the same `id` uninterrupted.

The `is_admin` flag SHALL be strictly preserved by the `UPDATE` statement.
The `UPDATE` SET clause MUST NOT include `is_admin`; rotation MUST NEVER alter
the privilege level of a key.

The old plaintext key SHALL be invalidated immediately and atomically upon
the `UPDATE` completing — no grace period, no dual-hash window.

#### Scenario: Successful rotate returns new plaintext once and old key is invalidated

- GIVEN an active key with plaintext `old_key`
- WHEN `POST /api/keys/:id/rotate` is called by an authenticated admin
- THEN the response status is 200
- AND the response body contains a `full` field holding the new plaintext key `new_key`
- AND `new_key` authenticates successfully on a subsequent gated request (returns 200)
- AND `old_key` immediately fails `enforceApiKey` on any subsequent request (returns 401)
- AND `full` is absent from any subsequent `GET /api/keys` or `GET /api/keys/:id` response

#### Scenario: Key id and all request attribution are preserved after rotate

- GIVEN an active key with `id` = `K` that has recorded usage (entries in `requests` with `api_key_id = K`)
- WHEN `POST /api/keys/K/rotate` is called
- THEN the rotated key record retains `id` = `K`
- AND all existing `requests` rows with `api_key_id = K` remain queryable and attributed to `K`
- AND `GET /api/telemetry/usage` returns the same aggregate totals for key `K` as before rotation

#### Scenario: Admin key rotation preserves is_admin

- GIVEN an active key with `is_admin = 1`
- WHEN `POST /api/keys/:id/rotate` is called
- THEN the key's `is_admin` remains `1` after rotation
- AND the rotated key authenticates as an admin on admin-gated routes

#### Scenario: Non-admin key rotation preserves is_admin = 0

- GIVEN an active key with `is_admin = 0`
- WHEN `POST /api/keys/:id/rotate` is called
- THEN the key's `is_admin` remains `0` after rotation
- AND the rotated key does NOT pass the admin guard on admin-gated routes

---

### Requirement: Rotating a Revoked Key Is Rejected (409 Conflict)

`POST /api/keys/:id/rotate` MUST reject rotation of a revoked key with HTTP 409
and MUST NOT mutate any stored key material. A revoked key is a terminal artifact;
its identity is preserved for audit and its secret is already inactive.

Rationale: mirrors the active-only constraint on rename/revoke — once revoked,
a key's state is terminal and no secret-material change is meaningful.

#### Scenario: Rotating a revoked key returns 409

- GIVEN a key whose `revoked_at` is set (revoked)
- WHEN `POST /api/keys/:id/rotate` is called
- THEN the response status is 409
- AND no fields on the key record are mutated (`key_hash`, `prefix`, `rotated_at` unchanged)

---

### Requirement: Rotating a Nonexistent Key Returns 404

`POST /api/keys/:id/rotate` targeting an `id` that does not exist in `api_keys`
MUST return HTTP 404 and MUST NOT mutate any data.

#### Scenario: Rotating a nonexistent key returns 404

- GIVEN an `id` that does not match any row in `api_keys`
- WHEN `POST /api/keys/:id/rotate` is called
- THEN the response status is 404
- AND no key is mutated

---

### Requirement: key_hash Uniqueness Collision Surfaces an Error

The storage function `rotateApiKey(id)` MUST NOT silently swallow a database
error caused by the new `key_hash` violating the `UNIQUE` constraint on
`api_keys.key_hash`. Any such constraint violation MUST surface as a thrown
error that propagates to the HTTP layer and MUST NOT leave the key in an
inconsistent state. (The probability of a HMAC-SHA256 collision on a 256-bit
secret is astronomically low; this requirement exists to prevent silent
corruption in the event of an implementation defect or entropy failure.)

#### Scenario: key_hash collision surfaces an error rather than silent failure

- GIVEN a scenario where the generated `key_hash` already exists in `api_keys`
  (e.g. forced by a test double or a deliberately seeded collision)
- WHEN `rotateApiKey(id)` executes the `UPDATE`
- THEN the database constraint violation is NOT swallowed
- AND an error is propagated to the caller (HTTP layer returns 5xx or equivalent)
- AND the original `key_hash` and `prefix` of the targeted key remain unchanged

---

### Requirement: rotated_at Column Records Rotation Timestamp

The `api_keys` schema SHALL include an additive nullable `rotated_at TEXT` column
(ISO UTC timestamp). The `rotateApiKey(id)` storage function MUST set `rotated_at`
to the current UTC timestamp on each rotation. The column MUST be `NULL` for keys
that have never been rotated. The `RotatedApiKey` response DTO MUST include
`rotated_at`.

#### Scenario: rotated_at is set on successful rotation

- GIVEN an active key with `rotated_at = NULL`
- WHEN `POST /api/keys/:id/rotate` succeeds
- THEN the key's `rotated_at` is set to an ISO UTC timestamp close to the time of the request
- AND the response body includes the `rotated_at` field with that value

#### Scenario: rotated_at is null for unrotated keys

- GIVEN a key that was created but never rotated
- WHEN `GET /api/keys` is called
- THEN the key's `rotated_at` is `null`

---

### Requirement: Prefix Is Regenerated on Rotate (New Identity Surface)

Each call to `POST /api/keys/:id/rotate` SHALL produce a new random `prefix`
(8 hex chars, same generation as `generateKey()`) alongside the new secret.
The old prefix is replaced atomically with the new prefix in the same `UPDATE`.
The `RotatedApiKey` response DTO MUST return the new `prefix`.

Rationale: the prefix is the public display handle in logs and the UI; regenerating
it signals to operators that a new key material identity is in effect, reducing
confusion between old and new key material in access logs.

#### Scenario: Prefix changes after rotation

- GIVEN an active key with `prefix = "aabbccdd"`
- WHEN `POST /api/keys/:id/rotate` succeeds
- THEN the key's stored `prefix` is a new value different from `"aabbccdd"`
- AND the response body `prefix` field reflects the new value
- AND the `id` field in the response is the same as before

---

### Requirement: Rotate Response Never Leaks Existing Secrets

The `RotatedApiKey` response DTO MUST NOT include `key_hash`. It MUST NOT include
the old plaintext key. The only plaintext exposed is the newly generated `full`
value in the immediate rotate response.

#### Scenario: Response contains no stored secret material

- GIVEN any successful `POST /api/keys/:id/rotate` response
- THEN the response body MUST NOT contain `key_hash`
- AND the response body MUST NOT contain the previous key's plaintext prefix or secret

---

### Requirement: UI Rotate Action with One-Time Reveal and Self-Lockout Warning

The `/keys` UI (or `/keys/$keyId` per-key detail view) SHALL expose a rotate
action per key. Upon triggering the action, the UI MUST present a confirmation
dialog. The dialog MUST display an explicit self-lockout warning when the key
being rotated matches the key currently stored in `localStorage` (mirrors the
self-revoke warning pattern). On confirmation, the UI calls `rotateApiKey(id)`,
receives the `RotatedApiKey`, and displays the new `full` plaintext in a
one-time reveal dialog — the same copy-and-dismiss UX as the create flow. After
dismissal, `full` is no longer accessible from any UI surface.

#### Scenario: Self-lockout warning is shown when rotating the active session key

- GIVEN the key stored in `localStorage` matches the key being rotated
- WHEN the operator opens the rotate confirm dialog
- THEN the dialog explicitly warns that confirming will invalidate the current session key

#### Scenario: New plaintext key is shown exactly once after rotation

- GIVEN the operator confirms a rotate action
- WHEN the `RotatedApiKey` response is received
- THEN the UI displays the `full` plaintext in a one-time reveal dialog
- AND after the dialog is dismissed, the plaintext is no longer visible in any UI surface
