# Delta for http-compression

## ADDED Requirements

### Requirement: Content-negotiated response compression

The system MUST compress eligible JSON and static-asset responses with brotli or gzip when the request `Accept-Encoding` advertises support, preferring brotli. When no supported encoding is offered, the response MUST be sent uncompressed (identity). Decoded bodies MUST be byte-identical to the uncompressed payload.

#### Scenario: brotli negotiated for JSON

- GIVEN a request with `Accept-Encoding: br, gzip`
- WHEN an eligible JSON response is produced
- THEN the response sets `Content-Encoding: br`
- AND the decoded body equals the uncompressed payload

#### Scenario: no acceptable encoding offered

- GIVEN a request with no `Accept-Encoding` header (or only `identity`)
- WHEN an eligible response is produced
- THEN no `Content-Encoding` is set and the body is uncompressed

### Requirement: Vary on Accept-Encoding

Any response subject to encoding negotiation MUST set `Vary: Accept-Encoding` so shared caches key on that header.

#### Scenario: Vary present on negotiable response

- GIVEN a request for an eligible JSON or static response
- WHEN the response is produced
- THEN it includes `Vary: Accept-Encoding`

### Requirement: Streaming, SSE, and already-compressed exclusion

The system MUST NOT compress streaming export responses (`export.ts`), Server-Sent-Events streams (`stream.ts`), or already-compressed content types. Excluded responses MUST pass through unbuffered with no `Content-Encoding` added.

#### Scenario: SSE stream not compressed

- GIVEN a request to an SSE endpoint (`text/event-stream`)
- WHEN events stream to the client
- THEN no `Content-Encoding` is set and event framing is preserved

#### Scenario: streaming export not compressed

- GIVEN a request to the streaming export endpoint
- WHEN the download streams
- THEN the response is uncompressed and unbuffered
