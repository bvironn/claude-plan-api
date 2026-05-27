# Proposal: POST /v1/completions — OpenAI Legacy Completions (FIM)

## Intent

IDEs using OpenAI-compatible autocomplete (e.g., Continue.dev, Codeium) call `POST /v1/completions` with a FIM (Fill-in-the-Middle) payload. The proxy currently only exposes `/v1/chat/completions`, blocking these tools. This change adds the legacy completions endpoint by reusing the existing streaming pipeline with a thin route wrapper.

## Scope

### In Scope
- `POST /v1/completions` route handler supporting streaming and non-streaming responses
- FIM prompt synthesis from `{prompt, suffix}` fields into a structured chat message
- Response reshaping from `chat.completion` → `text_completion` object type
- Unit tests covering streaming, non-streaming, FIM injection, and error paths
- Route registration in `server.ts`

### Out of Scope
- Modifications to existing transform functions (`openai-to-anthropic.ts`, `streaming.ts`)
- Native FIM via a dedicated Anthropic endpoint (does not exist)
- Model enforcement at the proxy layer (callers choose their own model)
- `echo`, `best_of`, `logprobs` OpenAI parameters (not supported by Anthropic)

## Capabilities

### New Capabilities
- `completions-endpoint`: OpenAI-compatible `POST /v1/completions` with FIM prompt encoding and streaming support

### Modified Capabilities
None

## Approach

Thin route handler pattern (mirrors `chat.ts`):

1. Parse `{model, prompt, suffix, stream, max_tokens, ...}` from request body
2. Synthesize a `messages[]` array: system message with FIM instruction + user message with `<|fim_prefix|>{prompt}<|fim_suffix|>{suffix}<|fim_middle|>` tokens
3. Call `openaiToAnthropic()` with `clean_system: true` (drops Claude identity, keeps billing header)
4. Call `callAnthropic()` upstream
5. **Non-streaming**: call `anthropicToOpenai()`, extract `choices[0].message.content`, return `{object: "text_completion", choices: [{text, index, finish_reason}]}`
6. **Streaming**: pipe `streamAnthropicToOpenai()` through a `TransformStream` that rewrites `object: "text_completion"` and maps `delta.content → text`
7. Wrap handler with `withObservability()`

Zero changes to shared transform layer.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/http/routes/completions.ts` | New | Route handler — FIM synthesis + response reshape |
| `src/http/server.ts` | Modified | 2 lines: import + route registration |
| `__tests__/http-routes-completions.spec.ts` | New | Unit tests (bun:test, spyOn fetch) |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Claude adds explanation text despite system prompt | Low | Explicit system instruction: "Return ONLY the completion text" |
| `clean_system: true` removes billing header | Low | Confirmed safe in explore phase — only removes identity block |
| Adaptive thinking latency for autocomplete | Low | Document that callers should use haiku-class models; not enforced at proxy |
| TransformStream chunk boundary splits JSON | Low | Existing streaming pipeline already handles SSE framing correctly |

## Rollback Plan

Delete `src/http/routes/completions.ts` and `__tests__/http-routes-completions.spec.ts`. Revert the 2-line addition to `src/http/server.ts`. No database migrations, no config changes, no shared code modified. Full rollback is a single PR revert.

## Dependencies

None — no new packages required. Bun native APIs and existing project modules only.

## Success Criteria

- [ ] `POST /v1/completions` returns `200` with `object: "text_completion"` for non-streaming requests
- [ ] `POST /v1/completions` with `stream: true` returns SSE with `object: "text_completion"` chunks
- [ ] FIM tokens (`<|fim_prefix|>`, `<|fim_suffix|>`, `<|fim_middle|>`) appear in the upstream Anthropic request
- [ ] `clean_system: true` is set — Claude identity system prompt is not forwarded
- [ ] All existing tests continue to pass (`bun test`)
- [ ] TypeScript compiles cleanly (`bun run tsc --noEmit`)
- [ ] IDE autocomplete tools (e.g., Continue.dev) successfully complete code via the proxy
