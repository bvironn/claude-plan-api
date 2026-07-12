# Delta for session-transcript-dedup

New capability: render-only message dedup with a mandatory full-render fallback, plus
immutable-turn fetch caching in the session detail view. All requirements additive.

## ADDED Requirements

### Requirement: Render Deduplication Of Repeated Messages

A message that already appeared verbatim in an earlier, now-collapsed turn MUST NOT be
re-rendered in full inside the always-expanded last turn; it MUST render as a compact
reference marker naming the turn where it first appeared. Only the new suffix (messages
absent from the preceding turn's array) MUST render in full. Dedup MUST compare the same
resolved message arrays the transcript view renders.

#### Scenario: Repeated prefix message renders as reference marker

- GIVEN the last turn shares a byte-exact prefix with the preceding turn
- WHEN the always-expanded last turn is rendered
- THEN each shared-prefix message MUST render as a compact reference marker to the earlier turn
- AND MUST NOT re-render its full content; the new suffix MUST render in full

#### Scenario: Each unique message shown once across turn boxes

- GIVEN N turns with byte-exact prefixes between consecutive turns
- WHEN all turn boxes are rendered
- THEN every unique message MUST render in full exactly once across all boxes combined
- AND repeated messages in the last turn MUST appear only as markers

### Requirement: Prefix-Mismatch Full-Render Fallback

When a turn's array is NOT a byte-exact prefix continuation of the preceding turn
(retry, edit, reorder), the system MUST render that turn's FULL message set with NO
markers. Mandatory safety, not best-effort: it MUST NOT drop or mis-reference a message.

#### Scenario: Divergent prefix renders full

- GIVEN turn K diverges from turn K-1 at any position past index 0
- WHEN turn K is rendered
- THEN turn K MUST render all messages in full
- AND MUST NOT emit any marker

#### Scenario: Divergence at index 0 renders entire turn full

- GIVEN turn 2's message at index 0 differs from turn 1's at index 0
- WHEN turn 2 is rendered
- THEN the ENTIRE turn 2 MUST render in full, with no partial dedup and no marker

### Requirement: Immutable-Turn Fetch Caching

A turn that is not the current last turn MUST NOT be re-fetched once its body has been
fetched. Non-last turns are structurally immutable; the turns query MUST treat them as
permanently fresh (e.g. `staleTime: Infinity`).

#### Scenario: Non-last turn not re-fetched on later poll

- GIVEN turn K (not the last) whose body was already fetched
- WHEN a subsequent poll occurs
- THEN the turns query MUST NOT re-fetch turn K's body

### Requirement: Live Last-Turn Updates

The current last turn MUST keep being re-fetched and updated on every poll. Caching MUST
NOT freeze the live last turn.

#### Scenario: Last turn refreshed on each poll

- GIVEN the current last turn
- WHEN a poll occurs
- THEN the system MUST re-fetch and update its body

#### Scenario: New last turn stays live, prior turn becomes immutable

- GIVEN a new turn arrives, so the previous last turn is no longer last
- WHEN subsequent polls occur
- THEN the new last turn MUST keep updating live
- AND the now non-last turn MUST stop being re-fetched

### Requirement: Degenerate Session Handling

The system MUST handle sessions where deduplication is impossible without error.

#### Scenario: Single-turn session

- GIVEN a session with exactly one turn
- WHEN it is rendered
- THEN no dedup MUST occur, no marker MUST be emitted, and the turn MUST render in full

#### Scenario: Zero-turn or loading session

- GIVEN zero turns, or a session still loading
- WHEN render is attempted
- THEN the system MUST NOT throw and there MUST be nothing to deduplicate

### Requirement: Upstream Request Path Boundary

Render/fetch-only capability. The LLM/upstream request path is explicitly OUT of scope:
the system MUST NOT modify it, and the full running history sent upstream MUST remain
exactly as today. (Non-requirement/boundary: no backend, slicing endpoint, or
sent-history change is introduced.)

#### Scenario: Upstream history unchanged

- GIVEN dedup and immutable-turn caching are active in the UI
- WHEN a request is sent upstream
- THEN the full untouched message history MUST be sent, identical to pre-change behavior
