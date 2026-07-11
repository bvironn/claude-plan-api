# Telemetry Key Filter Specification

## Purpose

Enable admins to narrow the Requests (`/`) and Sessions (`/sessions`) telemetry views to a single API key, using `requests.api_key_id` attribution surfaced through an `apiKeyId` query param on `GET /api/telemetry/requests`.

## Requirements

### Requirement: Filter requests by API key

`GET /api/telemetry/requests` MUST accept an optional numeric `apiKeyId` query param. When present and valid, the response MUST include only request rows where `api_key_id` equals that value.

#### Scenario: Filter returns only matching requests

- GIVEN requests attributed to keys 1 and 2
- WHEN a client requests `GET /api/telemetry/requests?apiKeyId=1`
- THEN the response MUST contain only requests with `api_key_id = 1`
- AND `total` MUST reflect the filtered count

#### Scenario: Non-matching key returns empty set

- GIVEN no request has `api_key_id = 99`
- WHEN a client requests `GET /api/telemetry/requests?apiKeyId=99`
- THEN `requests` MUST be empty and `total` MUST be `0`

### Requirement: Backward-compatible default

The system MUST preserve current unfiltered behavior when `apiKeyId` is absent. Omitting the param MUST return requests across all keys, including legacy rows with `NULL api_key_id`.

#### Scenario: Omitted param is unfiltered

- GIVEN requests across multiple keys and some with `NULL api_key_id`
- WHEN a client requests `GET /api/telemetry/requests` with no `apiKeyId`
- THEN the response MUST include requests regardless of `api_key_id`

### Requirement: Invalid apiKeyId falls back to unfiltered

The system MUST treat an invalid `apiKeyId` (non-numeric, negative, or `NaN`) as absent and return the unfiltered result, consistent with the existing numeric-param parsing pattern (`parseNum`). The system MUST NOT return an error status for an invalid `apiKeyId`.

#### Scenario: Non-numeric value ignored

- GIVEN requests across multiple keys
- WHEN a client requests `GET /api/telemetry/requests?apiKeyId=abc`
- THEN the value MUST be ignored and the response MUST be unfiltered (HTTP 200)

#### Scenario: Empty value ignored

- GIVEN requests across multiple keys
- WHEN a client requests `GET /api/telemetry/requests?apiKeyId=`
- THEN the response MUST be unfiltered (HTTP 200)

### Requirement: Requests view exposes a URL-shareable key selector

The Requests view MUST expose a key selector populated from `GET /api/keys`. The selection MUST persist in the URL query so that reloading or sharing the link reproduces the same filtered view. A default "All keys" option MUST preserve unfiltered behavior.

#### Scenario: Selection persists on reload

- GIVEN an admin selects key N in the Requests view
- WHEN the URL updates and the page is reloaded or shared
- THEN the Requests list MUST reload filtered by key N from the URL param

#### Scenario: All keys clears the filter

- GIVEN a key filter is active
- WHEN the admin selects "All keys"
- THEN the `apiKeyId` param MUST be removed and all requests MUST be shown

### Requirement: Sessions view exposes a key selector

The Sessions view MUST expose a key selector (net-new UI) that filters the same underlying request list by `apiKeyId` BEFORE client-side session grouping (`groupIntoConversations`). Server-side grouping is out of scope.

#### Scenario: Sessions filtered before grouping

- GIVEN sessions built from requests across keys 1 and 2
- WHEN the admin selects key 1 in the Sessions view
- THEN only requests with `api_key_id = 1` MUST feed the grouping
- AND sessions MUST be regrouped from that filtered request set

### Requirement: Selector includes revoked keys

The key selector MUST include revoked keys returned by `listApiKeys()` (those with `revoked_at`), because past requests may reference them. Revoked keys MUST be labeled distinctly from active keys.

#### Scenario: Revoked key selectable and labeled

- GIVEN key 3 is revoked but has historical requests
- WHEN the selector renders
- THEN key 3 MUST appear, be visually distinguished as revoked, and be selectable to filter its historical requests
