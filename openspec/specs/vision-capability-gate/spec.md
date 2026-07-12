# Specification: Vision Capability Gate

Model-capability-aware image-block handling in the OpenAI→Anthropic transform. A tri-state
gate rejects only confirmed-unsupported vision requests and fails open (forward + warn) when
capability data is unverified.

## Requirements

### Requirement: Model Capability Surface Exposes Vision Support

The capability projection MUST expose per-model vision support as `imageInput`.
`getModelCapabilities(model).imageInput` MUST reflect the live registry entry when the
model is present live. The default capability set MUST report `imageInput === false`.

#### Scenario: Live registry vision flag surfaced

- GIVEN a live registry entry with vision enabled
- WHEN `getModelCapabilities(model)` is read
- THEN `imageInput` MUST equal the live entry's vision flag

#### Scenario: Conservative default when no live entry

- GIVEN no live registry entry backs the model
- WHEN the default capability set is read
- THEN `imageInput` MUST be `false`

### Requirement: Tri-State Vision Capability Gate

Before forwarding image content upstream, the transform MUST reject ONLY on a confirmed
negative: registry live AND model present live AND its `imageInput` is `false`. When the
registry is null OR the model is absent from the live registry (static fallback in effect),
it MUST fail open. The gate MUST NOT reject based on static-fallback data.

#### Scenario: Confirmed-negative image request rejected

- GIVEN registry live, model present, `imageInput` false
- WHEN a request with an image block is transformed
- THEN it MUST be rejected and MUST NOT forward upstream

#### Scenario: Vision-capable model forwarded

- GIVEN registry live, model present, `imageInput` true
- WHEN a request with an image block is transformed
- THEN the image block MUST forward unchanged

#### Scenario: Unverified registry fails open

- GIVEN registry null OR model absent from the live registry
- WHEN a request with an image block is transformed
- THEN the block MUST forward unchanged (fail-open), never rejected

#### Scenario: No image block is a no-op

- GIVEN a request with no image block, under any registry state
- WHEN it is transformed
- THEN the gate MUST take no action; the request forwards as today

### Requirement: Confirmed-Negative Rejection Contract

On a confirmed-negative image request the transform MUST raise a typed
`CapabilityMismatchError`, ONLY in that state, so existing callers are unaffected. Each
route handler (`handleChat`, `handleCompletions`, `handleTokensCount`) MUST catch it and
respond HTTP 400 with `error.type: "proxy_error"` and `error.code: 400`, not
`invalid_request_error`.

#### Scenario: Rejection maps to proxy_error 400

- GIVEN a confirmed-negative image request on any of the three routes
- WHEN `CapabilityMismatchError` is raised
- THEN the route MUST respond 400 with `type: "proxy_error"`, `code: 400`
- AND MUST NOT reach the upstream client

#### Scenario: Non-triggering requests never raise

- GIVEN any request that is not confirmed-negative-with-image
- WHEN it is transformed
- THEN `CapabilityMismatchError` MUST NOT be raised

### Requirement: Single Choke Point Across All Three Transform Routes

The gate MUST live at one choke point inside `openaiToAnthropic()` so `/v1/chat/completions`,
`/v1/completions` (FIM), and `/v1/tokens/count` all receive identical gating, even where
image content is a practical no-op.

#### Scenario: Token counting rejects confirmed-negative image

- GIVEN a confirmed-negative image request to `/v1/tokens/count`
- WHEN it is transformed
- THEN it MUST be rejected identically to chat, not silently counted

### Requirement: Capability-Mismatch Observability Event

The system MUST emit `transform.image_block_dropped` when the gate acts, extending the
payload with `reason: "capability_mismatch"` plus new fields `model` and `verified`
(boolean), consistent with the existing `{reason, urlPrefix}` shape. A reject MUST emit
`verified: true` at error level; a fail-open forward `verified: false` at warn level.

#### Scenario: Reject emits verified error event

- GIVEN a confirmed-negative image request being rejected
- WHEN the event fires
- THEN it MUST emit at error level with `reason: "capability_mismatch"`, `verified: true`, and `model`

#### Scenario: Fail-open emits unverified warn event

- GIVEN an unverified image request being forwarded
- WHEN the event fires
- THEN it MUST emit at warn level with `reason: "capability_mismatch"`, `verified: false`, and `model`
