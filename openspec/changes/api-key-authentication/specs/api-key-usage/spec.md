# api-key-usage Specification

## Purpose

Defines per-request attribution of proxied traffic to the issuing API key and an aggregated, date-range-filtered usage query exposed through a telemetry route, reusing the existing `requests` table, `ensureColumn()` migration, and the `getMetrics()` `SUM`/`GROUP BY` aggregation idiom.

---

## Requirements

### Requirement: Per-Request Key Attribution

The system MUST record the issuing key's `api_key_id` on each logged row of the existing `requests` table. The column MUST be added via the existing idempotent `ensureColumn()` migration. The system MUST write only a validated `api_key_id`; when authentication is disabled or the request is exempt, the value MAY be null. The reference is advisory (app-enforced), not a DB-enforced foreign key.

#### Scenario: Request row is attributed to its key

- GIVEN an authenticated request from a known key on a logged route
- WHEN the request is recorded in `requests`
- THEN the row's `api_key_id` equals the issuing key's id

---

### Requirement: Aggregated Usage Query

The system MUST provide `getUsageByApiKey()` returning per-key totals — request count and summed token columns (`input_tokens`, `output_tokens`, cache tokens) — grouped by `api_key_id`. The query MUST accept an optional `timeFrom`/`timeTo` range and MUST bound results to that window. A query matching no rows MUST return an empty or zero-total result set, not an error.

#### Scenario: Correct totals for a date range

- GIVEN recorded requests for a key both inside and outside a `timeFrom`/`timeTo` window
- WHEN `getUsageByApiKey({ timeFrom, timeTo })` runs
- THEN only in-window rows are aggregated
- AND the per-key request count and token sums match the in-window rows

#### Scenario: No matching key returns empty, not error

- GIVEN a `timeFrom`/`timeTo` window with no matching requests
- WHEN `getUsageByApiKey()` runs
- THEN it returns an empty (or zero-total) result
- AND it does not throw or return an error status

---

### Requirement: Usage Telemetry Route

The system MUST expose the aggregated per-key usage through a telemetry route under `/api/telemetry/*` that accepts the `timeFrom`/`timeTo` range. The route is a gated JSON API route and MUST itself require a valid key when `REQUIRE_API_KEY=true`.

#### Scenario: Usage route returns aggregated totals

- GIVEN authenticated access and recorded usage
- WHEN the client calls the usage telemetry route with a date range
- THEN the response contains per-key totals bounded by that range
