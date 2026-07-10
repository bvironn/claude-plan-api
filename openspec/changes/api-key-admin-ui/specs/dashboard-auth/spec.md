# dashboard-auth Specification

## Purpose

Defines how the built dashboard authenticates itself against a `REQUIRE_API_KEY=true` host: the operator supplies an API key in the browser, it persists in `localStorage`, and every gated fetch carries it as a Bearer token. Without this, all `/api/telemetry/*` and `/v1/*` dashboard fetches 401 on first load with no recovery path.

---

## Requirements

### Requirement: Client-Side Key Entry and Persistence

The dashboard MUST provide a UI affordance for the operator to enter an API key. The entered key MUST persist in `localStorage`. The dashboard MUST allow the stored key to be cleared or replaced.

#### Scenario: Key persists in localStorage

- GIVEN the operator has no stored key
- WHEN they enter a key in the key-entry prompt
- THEN the key is written to `localStorage`
- AND subsequent dashboard fetches read that same key from `localStorage`

#### Scenario: Key cleared or replaced

- GIVEN a key is stored in `localStorage`
- WHEN the operator clears or replaces it
- THEN the old key is removed and no longer attached to fetches

---

### Requirement: Bearer Attachment on Gated Fetches

Every dashboard fetch to a gated prefix (`/api/*`, `/v1/*`) MUST attach `Authorization: Bearer <stored-key>` when a key is present in `localStorage`.

#### Scenario: Bearer sent on subsequent fetches

- GIVEN a valid key is stored in `localStorage`
- WHEN the dashboard calls any `/api/telemetry/*` or `/v1/*` endpoint
- THEN the request carries `Authorization: Bearer <stored-key>`
- AND the endpoint returns 200, not 401

---

### Requirement: 401 Recovery Flow

A 401 response MUST trigger the key-entry prompt rather than a raw error or crash. The prompt MUST allow re-entering a key after an invalid or revoked key was used.

#### Scenario: 401 shows key-entry prompt, not a crash

- GIVEN no key or an invalid key is stored
- WHEN a gated fetch returns 401
- THEN the dashboard displays the key-entry prompt
- AND no unhandled error or blank crash is shown

#### Scenario: Invalid or revoked key allows re-entry

- GIVEN a stored key that is invalid or revoked
- WHEN a gated fetch returns 401
- THEN the dashboard shows the key-entry prompt again
- AND the operator can supply a different key and retry
