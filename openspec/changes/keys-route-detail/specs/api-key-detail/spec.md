# Delta for api-key-detail

## ADDED Requirements

### Requirement: Per-Key Detail Route

The system MUST expose a URL-shareable detail route `/keys/$keyId` reachable
by clicking a key row on `/keys`, rendering that key's metadata: prefix, label,
status, admin flag, and created date.

#### Scenario: Navigate to an existing key

- GIVEN an API key exists with a known `keyId`
- WHEN the operator navigates to `/keys/$keyId`
- THEN the view MUST show that key's prefix, label, status, admin flag, and created date

#### Scenario: Open detail from the keys list

- GIVEN the operator is on `/keys`
- WHEN they click a key row
- THEN the app MUST navigate to `/keys/$keyId` for that key

### Requirement: Derived Usage Metrics

The system MUST show usage metrics derived only from real `requests` columns
attributed via `api_key_id`: request count, token totals (in, out, cache read,
cache creation), error rate (`status >= 400`), and a per-model breakdown.
Every displayed number MUST trace to an existing column; no value MAY be invented.

#### Scenario: Key with attributed requests

- GIVEN a key has attributed rows in `requests`
- WHEN the operator opens `/keys/$keyId`
- THEN the view MUST show request count, token totals (in/out/cache), error rate, and per-model breakdown
- AND each metric MUST be computed from that key's `requests` rows only

#### Scenario: Error rate reflects failed requests

- GIVEN a key has requests with `status >= 400`
- WHEN metrics are computed
- THEN the error rate MUST equal failed requests divided by total requests for that key

### Requirement: Pre-Filtered Deep-Links

The system MUST provide deep-links from the detail view to Requests
(`/?apiKeyId=<id>`) and Sessions (`/sessions?apiKeyId=<id>`), pre-filtered to
the current key.

#### Scenario: Deep-link to Requests

- GIVEN the operator is on `/keys/$keyId`
- WHEN they follow the Requests deep-link
- THEN Requests MUST open pre-filtered to `apiKeyId=<keyId>`

#### Scenario: Deep-link to Sessions

- GIVEN the operator is on `/keys/$keyId`
- WHEN they follow the Sessions deep-link
- THEN Sessions MUST open pre-filtered to `apiKeyId=<keyId>`

### Requirement: Zero-Usage Empty State

The system MUST render a clean empty state — not an error — when a valid key
has zero attributed requests. Metadata and deep-links MUST still render.

#### Scenario: Valid key with no attributed requests

- GIVEN a valid key has zero rows in `requests`
- WHEN the operator opens `/keys/$keyId`
- THEN the view MUST show an empty-usage state without any error
- AND the key's metadata and deep-links MUST still be visible

### Requirement: Nonexistent Key Handling

The system MUST render a clean "key not found" state when `keyId` matches no
existing key. It MUST NOT crash, throw an uncaught error, or render a blank page.

#### Scenario: Unknown keyId

- GIVEN no key exists for a given `keyId`
- WHEN the operator navigates to `/keys/$keyId`
- THEN the view MUST show a "not found" state
- AND the app MUST NOT crash or surface an unhandled error

## Non-Goals

### Requirement: No Cost or Pricing Figures

The system MUST NOT display any cost or dollar figures on the detail view. The
`requests` schema has no pricing column, so cost data MUST NOT be invented or
estimated. All displayed values MUST remain grounded in the real schema.

#### Scenario: Cost data is absent

- GIVEN the detail view renders usage metrics
- WHEN any metric is displayed
- THEN no cost, dollar, or pricing figure MUST appear
- AND every shown value MUST map to an existing `requests` column
