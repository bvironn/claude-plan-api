# api-key-auth Specification

## Purpose

Defines inbound API-key authentication for `claude-plan-api`: the key model and storage, key generation/issuance format, fast per-request hash validation, header extraction, and the cross-cutting 401 enforcement gate that protects JSON API routes while exempting `/health` and static/SPA serving.

---

## Requirements

### Requirement: API Key Model and Storage

The system MUST persist API keys in an `api_keys` table with at least the columns `id`, `key_hash`, `label`, `created_at`, and `revoked_at` (nullable). The system MUST store only the key digest in `key_hash` and MUST NOT store or log the plaintext secret. A key is active when `revoked_at IS NULL`; a key with a non-null `revoked_at` is revoked.

#### Scenario: Persisted key row stores only the hash

- GIVEN a newly issued API key
- WHEN the key is written to `api_keys`
- THEN the row has `id`, `key_hash`, `label`, `created_at`, and `revoked_at` is `NULL`
- AND no column or log line contains the plaintext secret

---

### Requirement: Key Generation and Issuance

The system MUST generate keys in a display-safe `prefix_secret` format: a stable non-secret prefix followed by a high-entropy random secret. The plaintext key MUST be returned to the operator exactly once at issuance and MUST NOT be recoverable afterward. Issuance MUST be available via the CLI `scripts/create-api-key.ts`, which persists only the hash.

#### Scenario: CLI issues a working key shown once

- GIVEN an operator runs `scripts/create-api-key.ts` with a label
- WHEN the command completes
- THEN the full `prefix_secret` key is printed exactly once
- AND only its digest is stored in `api_keys`
- AND presenting that key on a gated route authenticates successfully

---

### Requirement: Fast Hash Validation

The system MUST hash the presented secret using SHA-256/HMAC with a server-side pepper (`API_KEY_PEPPER`) and look it up against the indexed `key_hash` column. The system MUST NOT use slow adaptive hashing (bcrypt/argon2/`Bun.password`) for per-request validation. Validation MUST succeed only for an active (non-revoked) key whose digest matches.

#### Scenario: Valid key authenticates a gated request

- GIVEN an active key issued via the CLI and `REQUIRE_API_KEY=true`
- WHEN a client calls a gated JSON route with a valid key header
- THEN the request is authenticated and dispatched to its handler
- AND the response is the handler's normal result (not 401)

---

### Requirement: Credential Extraction from Headers

The system MUST accept the key from either `Authorization: Bearer <key>` or `X-API-Key: <key>`. When both are present, `Authorization: Bearer` MUST take precedence. A request presenting neither header MUST be treated as unauthenticated.

#### Scenario: Either header supplies the key

- GIVEN an active key
- WHEN the key is sent as `Authorization: Bearer <key>` OR as `X-API-Key: <key>`
- THEN the key is extracted and validated identically for both headers

---

### Requirement: 401 Enforcement Gate

When `REQUIRE_API_KEY=true`, the system MUST reject any request to a gated JSON API route (`/v1/*` and `/api/*`, including telemetry) that lacks a valid, active key with HTTP 401 before the route handler runs. A missing, malformed, unknown, or revoked key MUST all yield 401. When `REQUIRE_API_KEY` is `false` (the default), the system MUST NOT enforce authentication and MUST dispatch requests unchanged.

#### Scenario: Missing key is rejected

- GIVEN `REQUIRE_API_KEY=true`
- WHEN a client calls a gated route with no key header
- THEN the server returns HTTP 401
- AND the route handler is not invoked

#### Scenario: Invalid or revoked key is rejected

- GIVEN `REQUIRE_API_KEY=true`
- WHEN a client calls a gated route with an unknown or revoked key
- THEN the server returns HTTP 401

#### Scenario: Flag disabled bypasses enforcement

- GIVEN `REQUIRE_API_KEY=false`
- WHEN a client calls a gated route with no key
- THEN the request is dispatched normally with no 401 from the auth gate

---

### Requirement: Exempt Routes

The system MUST always serve `GET /health` and static/SPA assets without requiring a key, even when `REQUIRE_API_KEY=true`. Exemptions MUST be an explicit allow-list; all other JSON API routes are gated by default.

#### Scenario: Exempt routes never require a key

- GIVEN `REQUIRE_API_KEY=true`
- WHEN a client requests `GET /health` or a static/SPA asset with no key
- THEN the server responds normally without a 401
