# completions-endpoint Specification

## Purpose

Defines the behavior of `POST /v1/completions` — an OpenAI legacy completions endpoint for IDE Fill-in-the-Middle (FIM) autocomplete. Translates FIM payloads into chat messages, calls the existing Anthropic pipeline, and reshapes responses to `text_completion` format.

---

## Requirements

### Requirement: Request Validation

The endpoint MUST accept a JSON request body with the following fields:

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `model` | string | MUST | Passed through to Anthropic unchanged |
| `prompt` | string | MUST | FIM prefix text |
| `suffix` | string | MAY | FIM suffix text; omitted when not provided |
| `max_tokens` | number | MAY | Forwarded to upstream |
| `stream` | boolean | MAY | Defaults to `false` |
| `temperature` | number | MAY | Forwarded to upstream |
| `stop` | string \| string[] | MAY | Forwarded to upstream |

The endpoint MUST reject requests missing `prompt` with HTTP 400.

The endpoint MUST ignore unsupported OpenAI parameters (`echo`, `best_of`, `logprobs`, `n`).

#### Scenario: Valid non-streaming request

- GIVEN a POST body with `model` and `prompt`
- WHEN the request is received
- THEN the server returns HTTP 200 with `Content-Type: application/json`
- AND the response body contains `object: "text_completion"`

#### Scenario: Missing prompt field

- GIVEN a POST body with `model` but no `prompt`
- WHEN the request is received
- THEN the server returns HTTP 400
- AND the response body contains an `error` field describing the missing field

#### Scenario: Unsupported parameters ignored

- GIVEN a POST body with `model`, `prompt`, and `best_of: 3`
- WHEN the request is received
- THEN the server returns HTTP 200
- AND `best_of` does not appear in the upstream Anthropic request

---

### Requirement: FIM Translation

The endpoint MUST translate `{prompt, suffix}` into a `messages[]` array before calling the upstream pipeline.

The system message MUST instruct the model to return ONLY the completion text with no explanation or markdown.

When `suffix` is present, the user message MUST contain FIM tokens in this order: `<|fim_prefix|>{prompt}<|fim_suffix|>{suffix}<|fim_middle|>`.

When `suffix` is absent, the user message MUST contain only: `<|fim_prefix|>{prompt}<|fim_middle|>`.

The call to `openaiToAnthropic()` MUST set `clean_system: true`.

#### Scenario: FIM with suffix

- GIVEN `prompt: "def add("` and `suffix: "\n    return a + b"`
- WHEN FIM translation executes
- THEN the upstream messages array contains a user message with `<|fim_prefix|>def add(<|fim_suffix|>\n    return a + b<|fim_middle|>`

#### Scenario: FIM without suffix

- GIVEN `prompt: "def add("` and no `suffix`
- WHEN FIM translation executes
- THEN the upstream messages array contains a user message with `<|fim_prefix|>def add(<|fim_middle|>`

#### Scenario: System prompt strips Claude identity

- GIVEN any valid request
- WHEN `openaiToAnthropic()` is called
- THEN `clean_system` is `true` in the options passed to the transform

---

### Requirement: Non-Streaming Response

For non-streaming requests (`stream` is `false` or absent), the endpoint MUST return a JSON object with `object: "text_completion"`.

The response MUST include `choices[0].text` containing the model's completion text.

The response MUST include `choices[0].finish_reason` and `choices[0].index: 0`.

The response MUST include `model` and `id` fields.

#### Scenario: Non-streaming success

- GIVEN a valid request with `stream: false`
- WHEN the upstream responds successfully
- THEN the response body has `object: "text_completion"`
- AND `choices[0].text` contains the completion string
- AND `choices[0].index` is `0`

#### Scenario: Upstream error (non-streaming)

- GIVEN the upstream Anthropic API returns a non-2xx status
- WHEN the handler processes the response
- THEN the endpoint returns an HTTP error with a JSON `error` body
- AND no `text_completion` object is emitted

---

### Requirement: Streaming Response

For streaming requests (`stream: true`), the endpoint MUST return SSE (`text/event-stream`).

Each SSE data event MUST carry a JSON chunk with `object: "text_completion"` and `choices[0].text` containing the incremental token text.

The final SSE event MUST be `data: [DONE]`.

The streaming pipeline MUST reuse the existing `streamAnthropicToOpenai()` transform with a rewrite step that changes `object` from `chat.completion.chunk` to `text_completion` and maps `delta.content` to `text`.

#### Scenario: Streaming success

- GIVEN a valid request with `stream: true`
- WHEN the upstream streams tokens
- THEN the response Content-Type is `text/event-stream`
- AND each data event contains `object: "text_completion"`
- AND `choices[0].text` is present with partial completion text

#### Scenario: Streaming terminates correctly

- GIVEN a valid streaming request
- WHEN the upstream signals end-of-stream
- THEN the last SSE event is `data: [DONE]`
- AND the connection closes cleanly

#### Scenario: Upstream error (streaming)

- GIVEN the upstream returns an error mid-stream
- WHEN the handler detects the error
- THEN the SSE stream emits an error event before closing
- AND the connection does not hang open

---

### Requirement: Observability

The route handler MUST be wrapped with `withObservability()` consistent with the existing `chat.ts` handler.

#### Scenario: Observability wrapping

- GIVEN any request to `POST /v1/completions`
- WHEN the handler is invoked
- THEN request/response metrics are captured by `withObservability()`

---

### Requirement: Route Registration

The route MUST be registered in `server.ts` as `POST /v1/completions` before the server starts accepting requests.

#### Scenario: Route available after startup

- GIVEN the server has started
- WHEN a client sends `POST /v1/completions`
- THEN the server routes to the completions handler (not 404)
