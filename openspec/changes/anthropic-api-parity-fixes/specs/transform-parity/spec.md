# Transform Parity Specification

## Purpose

Defines fidelity rules for the OpenAI↔Anthropic transform layer: how client-supplied `tool_choice`, `stop`, `parallel_tool_calls`, and tool `strict` map to upstream Anthropic fields on the request side, and how Anthropic `stop_reason` and cache-usage tokens map back to OpenAI fields on the response side. Both non-streaming (`anthropic-to-openai.ts`) and streaming (`streaming.ts`) response paths are in scope.

---

## Requirements

### Requirement: tool_choice string mapping

The transform MUST convert the string forms of OpenAI `tool_choice` to their Anthropic equivalents before forwarding the request. `"none"` MUST become `{type:"none"}`. `"required"` MUST become `{type:"any"}`. `"auto"` MUST become `{type:"auto"}`. When `tools` are present and the client supplies no `tool_choice`, the transform MUST default to `{type:"auto"}` (existing behavior preserved).

#### Scenario: "none" maps to Anthropic none

- GIVEN a request with `tool_choice: "none"` and one or more tools
- WHEN `openaiToAnthropic` runs
- THEN the resulting body contains `tool_choice: {type:"none"}`

#### Scenario: "required" maps to Anthropic any

- GIVEN a request with `tool_choice: "required"` and one or more tools
- WHEN `openaiToAnthropic` runs
- THEN the resulting body contains `tool_choice: {type:"any"}`

#### Scenario: "auto" maps to Anthropic auto

- GIVEN a request with `tool_choice: "auto"` and one or more tools
- WHEN `openaiToAnthropic` runs
- THEN the resulting body contains `tool_choice: {type:"auto"}`

#### Scenario: absent tool_choice defaults to auto when tools present

- GIVEN a request with tools and no `tool_choice` field
- WHEN `openaiToAnthropic` runs
- THEN the resulting body contains `tool_choice: {type:"auto"}`

---

### Requirement: tool_choice object mapping for specific function

The transform MUST convert OpenAI `{type:"function", function:{name:"<fn>"}}` to Anthropic `{type:"tool", name:"<mapped-name>"}` using the per-request ToolMap. If the named function does not appear in the request's tool list, the transform MUST fall back to `{type:"auto"}` and emit a `warn`-level log event.

#### Scenario: named function resolves via ToolMap

- GIVEN a request with `tools:[{function:{name:"my_func",...}}]` and `tool_choice:{type:"function",function:{name:"my_func"}}`
- WHEN `openaiToAnthropic` runs
- THEN the resulting body contains `tool_choice:{type:"tool", name:"<mcp_-prefixed name>"}` using the same ToolMap entry used for the tool definition

#### Scenario: unknown function name falls back to auto

- GIVEN a request with `tool_choice:{type:"function",function:{name:"unknown_func"}}` where `"unknown_func"` is not in `tools`
- WHEN `openaiToAnthropic` runs
- THEN the resulting body contains `tool_choice:{type:"auto"}`
- AND a `warn`-level log event is emitted

---

### Requirement: stop to stop_sequences mapping

The transform MUST copy the OpenAI `stop` field to the Anthropic `stop_sequences` array. A string value MUST be wrapped in an array. An array value MUST be forwarded as-is. An empty array or absent/undefined `stop` MUST result in `stop_sequences` being omitted from the upstream body.

#### Scenario: string stop becomes single-element array

- GIVEN a request with `stop: "\n"`
- WHEN `openaiToAnthropic` runs
- THEN the resulting body contains `stop_sequences: ["\n"]`

#### Scenario: string array stop forwarded as-is

- GIVEN a request with `stop: ["STOP", "END"]`
- WHEN `openaiToAnthropic` runs
- THEN the resulting body contains `stop_sequences: ["STOP","END"]`

#### Scenario: empty array omits stop_sequences

- GIVEN a request with `stop: []`
- WHEN `openaiToAnthropic` runs
- THEN the resulting body does NOT contain a `stop_sequences` key

#### Scenario: absent stop omits stop_sequences

- GIVEN a request with no `stop` field
- WHEN `openaiToAnthropic` runs
- THEN the resulting body does NOT contain a `stop_sequences` key

---

### Requirement: parallel_tool_calls mapping

When the client sets `parallel_tool_calls: false`, the transform MUST merge `disable_parallel_tool_use: true` into the resolved `tool_choice` object. When `parallel_tool_calls` is absent or `true`, `disable_parallel_tool_use` MUST NOT appear in the upstream body.

#### Scenario: parallel_tool_calls false adds disable flag

- GIVEN a request with `parallel_tool_calls: false` and tools present
- WHEN `openaiToAnthropic` runs
- THEN the resulting `tool_choice` object contains `disable_parallel_tool_use: true`

#### Scenario: parallel_tool_calls false + explicit tool_choice preserves both

- GIVEN a request with `parallel_tool_calls: false` and `tool_choice: "required"`
- WHEN `openaiToAnthropic` runs
- THEN the resulting body contains `tool_choice: {type:"any", disable_parallel_tool_use:true}`

#### Scenario: parallel_tool_calls absent — no disable flag

- GIVEN a request with tools and no `parallel_tool_calls` field
- WHEN `openaiToAnthropic` runs
- THEN the resulting `tool_choice` object does NOT contain `disable_parallel_tool_use`

#### Scenario: parallel_tool_calls true — no disable flag

- GIVEN a request with `parallel_tool_calls: true` and tools present
- WHEN `openaiToAnthropic` runs
- THEN the resulting `tool_choice` object does NOT contain `disable_parallel_tool_use`

---

### Requirement: tool strict forwarding (gated)

When a tool definition carries `strict: true` AND no excluded beta header is required to honor it under the current `anthropic-version`, the transform SHOULD forward `strict: true` on the upstream tool definition. If forwarding `strict` requires a beta header that the gateway deliberately excludes, the field MUST be dropped silently. The design phase resolves feasibility against the pinned API version.

#### Scenario: strict true forwarded when no beta header required

- GIVEN a tool with `function.strict: true` and the gateway's pinned version allows it without an excluded beta header
- WHEN `openaiToAnthropic` runs
- THEN the upstream tool definition includes `strict: true`

#### Scenario: strict silently dropped when beta header required

- GIVEN a tool with `function.strict: true` and forwarding requires a beta header the gateway excludes
- WHEN `openaiToAnthropic` runs
- THEN the upstream tool definition does NOT include a `strict` field
- AND no error is thrown or logged at error level

---

### Requirement: stop_reason mapping — non-streaming

The transform MUST use a shared stop-reason module to map all Anthropic `stop_reason` values to OpenAI `finish_reason`. The mapping MUST be: `end_turn`→`"stop"`, `max_tokens`→`"length"`, `stop_sequence`→`"stop"`, `tool_use`→`"tool_calls"`, `refusal`→`"content_filter"`, `model_context_window_exceeded`→`"length"`, `pause_turn`→`"stop"`. Any unmapped value MUST fall back to `"stop"`.

#### Scenario: refusal maps to content_filter

- GIVEN an Anthropic response with `stop_reason: "refusal"`
- WHEN `anthropicToOpenai` runs
- THEN `choices[0].finish_reason` equals `"content_filter"`

#### Scenario: model_context_window_exceeded maps to length

- GIVEN an Anthropic response with `stop_reason: "model_context_window_exceeded"`
- WHEN `anthropicToOpenai` runs
- THEN `choices[0].finish_reason` equals `"length"`

#### Scenario: pause_turn maps to stop

- GIVEN an Anthropic response with `stop_reason: "pause_turn"`
- WHEN `anthropicToOpenai` runs
- THEN `choices[0].finish_reason` equals `"stop"`

#### Scenario: unknown stop_reason falls back to stop

- GIVEN an Anthropic response with `stop_reason: "some_future_reason"`
- WHEN `anthropicToOpenai` runs
- THEN `choices[0].finish_reason` equals `"stop"`

---

### Requirement: stop_reason mapping — streaming

The streaming path MUST use the same shared stop-reason module as the non-streaming path. The `message_delta` event's `stop_reason` MUST be mapped using the shared module, producing identical output for the same input value.

#### Scenario: refusal maps to content_filter in stream finish chunk

- GIVEN an Anthropic SSE stream whose `message_delta` event has `stop_reason: "refusal"`
- WHEN `streamAnthropicToOpenai` processes the stream
- THEN the finish chunk contains `choices[0].finish_reason: "content_filter"`

#### Scenario: model_context_window_exceeded maps to length in stream

- GIVEN an Anthropic SSE stream whose `message_delta` event has `stop_reason: "model_context_window_exceeded"`
- WHEN `streamAnthropicToOpenai` processes the stream
- THEN the finish chunk contains `choices[0].finish_reason: "length"`

---

### Requirement: cache usage in non-streaming responses

The non-streaming response transform MUST include `usage.prompt_tokens_details.cached_tokens` (sourced from Anthropic `usage.cache_read_input_tokens`) and `usage.cache_creation_input_tokens` (sourced from Anthropic `usage.cache_creation_input_tokens`) in the returned OpenAI object. When the upstream omits either field (or provides 0), the corresponding output field MUST be 0.

#### Scenario: cache read tokens surfaced

- GIVEN an Anthropic response with `usage.cache_read_input_tokens: 500`
- WHEN `anthropicToOpenai` runs
- THEN the result contains `usage.prompt_tokens_details.cached_tokens: 500`

#### Scenario: cache creation tokens surfaced

- GIVEN an Anthropic response with `usage.cache_creation_input_tokens: 200`
- WHEN `anthropicToOpenai` runs
- THEN the result contains `usage.cache_creation_input_tokens: 200`

#### Scenario: upstream omits cache fields — output is 0

- GIVEN an Anthropic response with no `cache_read_input_tokens` or `cache_creation_input_tokens` fields
- WHEN `anthropicToOpenai` runs
- THEN `usage.prompt_tokens_details.cached_tokens` equals `0`
- AND `usage.cache_creation_input_tokens` is absent (not present in the output object)

---

### Requirement: cache usage in streaming finish chunk

The streaming finish chunk (emitted on `message_delta`) MUST include `usage.prompt_tokens_details.cached_tokens` (from `cache_read_input_tokens` captured at `message_start`) and `usage.cache_creation_input_tokens` (from `cache_creation_input_tokens` captured at `message_start`). When the upstream omits either field, the corresponding value MUST be 0.

#### Scenario: streaming cache read tokens in finish chunk

- GIVEN an Anthropic SSE stream whose `message_start` event has `usage.cache_read_input_tokens: 300`
- WHEN `streamAnthropicToOpenai` processes the stream to the `message_delta` finish chunk
- THEN the finish chunk's `usage.prompt_tokens_details.cached_tokens` equals `300`

#### Scenario: streaming cache creation tokens in finish chunk

- GIVEN an Anthropic SSE stream whose `message_start` event has `usage.cache_creation_input_tokens: 150`
- WHEN `streamAnthropicToOpenai` processes the stream to the `message_delta` finish chunk
- THEN the finish chunk's `usage.cache_creation_input_tokens` equals `150`

#### Scenario: streaming cache fields absent — output is 0

- GIVEN an Anthropic SSE stream whose `message_start` has no cache token fields
- WHEN `streamAnthropicToOpenai` processes the stream to the finish chunk
- THEN `usage.prompt_tokens_details.cached_tokens` equals `0`
- AND `usage.cache_creation_input_tokens` is absent (not present in the output object)

---

### Requirement: shared stop-reason module

The stop-reason mapping table MUST reside in a single shared module (e.g., `src/transform/stop-reason.ts`). Both `anthropic-to-openai.ts` and `streaming.ts` MUST import from that module and MUST NOT define their own inline stop-reason maps. The module MUST export the mapping as a pure function or a constant record so it is unit-testable in isolation.

#### Scenario: both paths produce identical output for same input

- GIVEN any Anthropic `stop_reason` value
- WHEN the shared module is used by both the streaming and non-streaming paths
- THEN both paths return the same `finish_reason` string for that value
