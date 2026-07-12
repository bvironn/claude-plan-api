# api-key-management Specification (Delta)

## ADDED Requirements

### Requirement: Unwindowed `last_used_at` on Key Metadata

`listApiKeys()` (`src/observability/storage.ts`) and `GET /api/keys`
(`src/http/routes/keys.ts` → `ApiKeyMeta`) MUST expose a
`last_used_at: string | null` field for every key. The value MUST be the ISO
timestamp of the most recent `requests` row attributed to that key's `id` via
`api_key_id`, computed with NO time-window filter — independent of the 30-day
window that bounds `getUsageByApiKey()`. It MUST be `null` when the key has
never been used. The value MUST be derived from an index-friendly correlated
`MAX(timestamp)` subquery over `requests` that can use the existing
`idx_requests_api_key` index; it MUST NOT require a new column, migration, or
schema change.

#### Scenario: Key with recent requests

- GIVEN a key with at least one attributed `requests` row
- WHEN `listApiKeys()` runs (or `GET /api/keys` is called)
- THEN `last_used_at` MUST equal the ISO `timestamp` of that key's most recent attributed request

#### Scenario: Key idle beyond the 30-day usage window (regression guard)

- GIVEN a key whose most recent attributed request is older than 30 days
- WHEN `last_used_at` is computed
- THEN it MUST be that real request timestamp, NOT `null`
- AND it MUST NOT be suppressed by the `getUsageByApiKey()` 30-day window

#### Scenario: Key never used

- GIVEN a key with zero attributed `requests` rows
- WHEN `last_used_at` is computed
- THEN it MUST be `null`

#### Scenario: Revoked key retains its last-used time

- GIVEN a revoked key with attributed requests from before revocation
- WHEN `last_used_at` is computed
- THEN it MUST be the timestamp of the most recent pre-revocation request
- AND revocation MUST NOT clear or alter the value

### Requirement: "Last used" Indicator on the Keys List

The `/keys` list page (`src/ui/src/routes/keys.tsx`) MUST render a "Last used"
indicator per key derived from `last_used_at`, formatted with the existing
`formatRelativeTime()` helper. When `last_used_at` is `null` it MUST show "—"
(or an equivalent never-used placeholder).

#### Scenario: Used key shows a relative time

- GIVEN a key whose `last_used_at` is a non-null ISO timestamp
- WHEN the operator views `/keys`
- THEN the key's "Last used" indicator MUST show `formatRelativeTime(last_used_at)`

#### Scenario: Never-used key shows a placeholder

- GIVEN a key whose `last_used_at` is `null`
- WHEN the operator views `/keys`
- THEN the key's "Last used" indicator MUST show "—" (never used)
