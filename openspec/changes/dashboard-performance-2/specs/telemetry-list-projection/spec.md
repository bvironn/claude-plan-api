# Delta for telemetry-list-projection

## ADDED Requirements

### Requirement: Slim default list projection

By default `/api/telemetry/requests` MUST return a slim projection that omits the request-body, response-body, and upstream-body fields. All non-body metadata MUST remain present and unchanged.

#### Scenario: default response omits body fields

- GIVEN a GET `/api/telemetry/requests` with no full-body opt-in
- WHEN the endpoint responds
- THEN each record excludes request/response/upstream body fields
- AND non-body metadata fields are unchanged

### Requirement: Opt-in full bodies

Callers that need raw bodies MUST be able to opt in explicitly (query parameter), in which case the response MUST include the full request/response/upstream body fields.

#### Scenario: opt-in returns full bodies

- GIVEN a GET `/api/telemetry/requests` with the full-body opt-in flag set
- WHEN the endpoint responds
- THEN each record includes the request/response/upstream body fields

### Requirement: Session-grouping inputs preserved

The slim projection MUST retain every field the dashboard uses to group requests into sessions (e.g. session identifier and ordering timestamps), so grouping behaves identically to the full shape.

#### Scenario: slim records still group into sessions

- GIVEN a slim `/api/telemetry/requests` response
- WHEN the dashboard groups records into sessions
- THEN grouping yields the same sessions as the full-shape response
