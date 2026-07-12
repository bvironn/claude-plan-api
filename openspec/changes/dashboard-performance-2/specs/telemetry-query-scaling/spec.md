# Delta for telemetry-query-scaling

## ADDED Requirements

### Requirement: Bounded percentile computation

`getMetrics()` percentile calculation MUST operate over a bounded sample rather than scanning unbounded rows. The response shape and field names MUST stay unchanged; computed values MAY shift within a documented tolerance.

#### Scenario: percentiles bounded on large dataset

- GIVEN a dataset larger than the configured sample bound
- WHEN `getMetrics()` runs
- THEN percentiles are computed from the bounded sample
- AND the response shape is identical to the prior output

### Requirement: Windowed usage aggregation

`getUsageByApiKey()` MUST enforce a time window so aggregation never scans the full history.

#### Scenario: rows outside the window excluded

- GIVEN usage rows both inside and outside the window
- WHEN `getUsageByApiKey()` aggregates
- THEN only in-window rows contribute to the totals

### Requirement: FTS-backed request search

Request text search MUST use an FTS index instead of a leading-wildcard `LIKE` scan. When the FTS index is unavailable, the system MUST fall back to the prior `LIKE` behavior without error.

#### Scenario: search uses FTS index

- GIVEN a search term against indexed requests
- WHEN search runs
- THEN it queries the FTS index and returns the same logical matches

#### Scenario: fallback when FTS unavailable

- GIVEN the FTS index is missing
- WHEN search runs
- THEN it falls back to `LIKE` and still returns results

### Requirement: Efficient session-detail resolution

The session-detail view MUST resolve a conversation without polling 500 full-body rows every 10 seconds. It MUST fetch only the turns it needs (batched per turn) or use a targeted lookup.

#### Scenario: no recurring full-body poll

- GIVEN an open session-detail view
- WHEN it resolves the conversation
- THEN it does not repeat a 10s poll of 500 full-body rows
- AND it fetches only the required turns

### Requirement: Deferred chart bundle on /metrics

The `/metrics` route MUST import Recharts dynamically so the library is excluded from the initial bundle chunk of other routes.

#### Scenario: Recharts absent from non-metrics load

- GIVEN a load of any route other than `/metrics`
- WHEN the initial bundle loads
- THEN the Recharts chunk is not fetched

### Requirement: Memoized technical-panel pretty-print

The technical panel MUST memoize JSON pretty-printing so `prettyJson()` recomputes only when its input changes.

#### Scenario: pretty-print not recomputed on unrelated re-render

- GIVEN a technical panel already showing a formatted body
- WHEN it re-renders with the same body value
- THEN the pretty-printed output is reused without recomputation
