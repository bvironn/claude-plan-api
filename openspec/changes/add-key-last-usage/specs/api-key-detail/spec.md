# Delta for api-key-detail

## ADDED Requirements

### Requirement: "Last Used" Detail Section

When a key has at least one attributed request, `/keys/$keyId`
(`src/ui/src/routes/keys.$keyId.tsx`) MUST render a "Last Used" detail section
sourced from the already-fetched `requestsQuery.data.requests[0]` (already
ordered `desc` by timestamp). It MUST NOT issue a new fetch. The section MUST
show at minimum: relative and absolute timestamp, HTTP method and path, status
code, model, duration, token breakdown (input, output, cache read, cache
write), streaming mode, and a link to the full transcript at `/r/$traceId`. It
MAY additionally show `ip` and `userAgent` when present on the record (already
surfaced elsewhere in this gated admin dashboard — no new PII exposure class).

#### Scenario: Key with attributed requests renders the full card

- GIVEN a key whose `requestsQuery.data.requests` is non-empty
- WHEN the operator opens `/keys/$keyId`
- THEN the "Last Used" section MUST render from `requests[0]`
- AND it MUST show relative + absolute timestamp, method + path, status, model, duration, token breakdown (in/out/cache read/cache write), and streaming mode
- AND it MUST NOT trigger an additional request fetch

#### Scenario: Nullable or absent fields render gracefully

- GIVEN a `requests[0]` record missing `status`, `duration_ms`, `model`, `ip`, or `user_agent`
- WHEN the "Last Used" section renders
- THEN each absent field MUST render gracefully (e.g. "—")
- AND the section MUST NOT crash or render `undefined`

#### Scenario: Transcript link targets the correct trace

- GIVEN `requests[0]` has `trace_id` `T`
- WHEN the operator follows the transcript link in the "Last Used" section
- THEN the app MUST navigate to `/r/T`

### Requirement: Zero-Usage Empty State Covers "No Last Usage"

When a key has zero attributed requests, the existing `ZeroUsage` empty state
MUST cover the "no last usage" case too. The "Last Used" section MUST NOT
render a separate broken, empty, or `undefined` state.

#### Scenario: Key with zero requests shows the empty state

- GIVEN a key whose `requestsQuery.data.requests` is empty
- WHEN the operator opens `/keys/$keyId`
- THEN the existing `ZeroUsage` empty state MUST render
- AND no separate "Last Used" section MUST render
- AND the view MUST NOT crash
