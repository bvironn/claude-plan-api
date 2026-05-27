# Transform Sanitization Specification

## Purpose

Defines the rules for sanitizing OpenAI-format chat payloads before they enter the OpenAI→Anthropic transform. Anthropic rejects empty text content blocks and whitespace-only string content with HTTP 400. This capability removes such fragments, substitutes placeholders where turn structure must be preserved, drops fully-empty assistant messages, and exposes observability for the mutations it performs.

## Requirements

### Requirement: Empty text block filtering in assistant content arrays

The transform MUST filter out content blocks where `type === "text"` AND `text` is empty or contains only whitespace from assistant messages with array content. Non-text blocks (`tool_use`, `image`, etc.) MUST pass through unchanged. If the resulting array is empty AND the message has no `tool_calls`, the message MUST be dropped. If the resulting array is empty AND the message has `tool_calls`, the message MUST be preserved so `tool_calls` can become `tool_use` blocks downstream.

#### Scenario: Empty text block removed, real text kept

- GIVEN assistant message with `content: [{type:"text",text:""}, {type:"text",text:"real"}]`
- WHEN sanitization runs
- THEN only the second block survives in the output

#### Scenario: Whitespace-only text block removed

- GIVEN assistant message with `content: [{type:"text",text:"   "}, {type:"text",text:"real"}]`
- WHEN sanitization runs
- THEN only the second block survives in the output

#### Scenario: All-empty content with no tool_calls drops message

- GIVEN assistant message with `content: [{type:"text",text:""}]` AND no `tool_calls`
- WHEN sanitization runs
- THEN the message is dropped entirely from the output array

#### Scenario: All-empty content with tool_calls preserves message

- GIVEN assistant message with `content: [{type:"text",text:""}]` AND `tool_calls` present
- WHEN sanitization runs
- THEN the message is preserved in the output array

#### Scenario: Non-text blocks pass through unchanged

- GIVEN assistant message with `content: [{type:"tool_use",...}, {type:"image",...}]`
- WHEN sanitization runs
- THEN both blocks are present unchanged in the output

### Requirement: Empty user message handling

The transform MUST handle user messages with empty or whitespace-only content by substituting the placeholder `"(empty message)"` so the turn structure is preserved. String content and array content MUST be normalized consistently.

#### Scenario: Empty string user content substituted

- GIVEN user message with `content: ""`
- WHEN sanitization runs
- THEN `content` is replaced with `"(empty message)"`

#### Scenario: Whitespace-only string user content substituted

- GIVEN user message with `content: " "`
- WHEN sanitization runs
- THEN `content` is replaced with `"(empty message)"`

#### Scenario: Real user content unchanged

- GIVEN user message with `content: "real text"`
- WHEN sanitization runs
- THEN `content` is unchanged

#### Scenario: Empty array user content substituted

- GIVEN user message with `content: []`
- WHEN sanitization runs
- THEN `content` is replaced with `[{type:"text",text:"(empty message)"}]`

#### Scenario: Array of only empty text substituted

- GIVEN user message with `content: [{type:"text",text:""}]`
- WHEN sanitization runs
- THEN `content` is replaced with `[{type:"text",text:"(empty message)"}]`

#### Scenario: Mixed array drops empty text and keeps image

- GIVEN user message with `content: [{type:"text",text:""}, {type:"image",...}]`
- WHEN sanitization runs
- THEN the empty text block is dropped AND the image block is preserved

### Requirement: Observability of mutations

The transform SHOULD emit a `transform.sanitize.mutated` warn-level event whenever sanitization actually modifies a message. The event MUST NOT be emitted when no mutation occurs. The event payload MUST include `role`, `mutation_type` (one of `"filtered_empty_text"`, `"placeholder_substituted"`, `"message_dropped"`), and `original_block_count`.

#### Scenario: Mutation emits one warn event

- GIVEN a message that requires sanitization
- WHEN sanitization mutates the message
- THEN exactly one `transform.sanitize.mutated` warn event is emitted for that message
- AND its payload includes `role`, `mutation_type`, and `original_block_count`

#### Scenario: No mutation emits no event

- GIVEN a message that requires no sanitization
- WHEN sanitization runs
- THEN no `transform.sanitize.mutated` event is emitted

### Requirement: Pure function isolation

The sanitization MUST be exposed as a pure function `sanitizeOpenAIMessages(messages)` that does not mutate the input array nor any nested message object. It MUST return a new array. When no sanitization is needed, the returned value MUST be structurally equal to the input.

#### Scenario: Input array reference unchanged

- GIVEN any input messages array
- WHEN `sanitizeOpenAIMessages(messages)` is called
- THEN the original array reference is unchanged after the call

#### Scenario: Original message objects unchanged

- GIVEN any input messages array
- WHEN `sanitizeOpenAIMessages(messages)` is called
- THEN none of the original message objects are mutated

#### Scenario: Structural equality when no sanitization needed

- GIVEN messages that require no sanitization
- WHEN `sanitizeOpenAIMessages(messages)` is called
- THEN the output is structurally equal to the input

### Requirement: Idempotency

Running sanitization on already-sanitized output MUST be a no-op.

#### Scenario: Double sanitization equals single sanitization

- GIVEN any input messages array `x`
- WHEN `sanitizeOpenAIMessages(sanitizeOpenAIMessages(x))` is computed
- THEN the result deeply equals `sanitizeOpenAIMessages(x)`
