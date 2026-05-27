## Exploration: POST /v1/completions (OpenAI Legacy Completions — FIM for IDE Autocomplete)

### Current State

The proxy exposes an OpenAI-compatible API on top of Anthropic Claude. The request pipeline is:

```
Client Request (OpenAI format)
  → openaiToAnthropic()        (transform/openai-to-anthropic.ts)
  → callAnthropic()            (upstream/anthropic-client.ts)
  → anthropicToOpenai() OR streamAnthropicToOpenai()   (transform/*)
  → Client Response (OpenAI format)
```

**Key architectural facts discovered:**

1. **`chat.ts` is the reference pattern** — it calls `openaiToAnthropic()`, then `callAnthropic()`, then dispatches to streaming or non-streaming conversion. The completions route follows the same flow with one extra step: converting `{prompt, suffix}` → a synthetic `messages` array before entering the pipeline.

2. **`openaiToAnthropic()` expects `body.messages[]`** — it iterates the messages array to build Anthropic-native messages. For FIM, we must synthesize this array from `prompt`+`suffix` BEFORE calling the transform.

3. **Claude has no native FIM endpoint** — Anthropic's API is chat-only. We must encode `prompt`+`suffix` into a chat message. The response text from Claude IS the completion, with no leading/trailing text if the prompt template is well-designed.

4. **The streaming pipeline is fully reusable** — `streamAnthropicToOpenai()` already converts Anthropic SSE → OpenAI SSE. The only difference needed is the response `object` field: completions use `"text_completion"` instead of `"chat.completion.chunk"`, and `choices[].text` instead of `choices[].delta.content`. This requires either a dedicated streaming function or a thin wrapper that post-processes chunks.

5. **Non-streaming reuse is simpler** — `anthropicToOpenai()` returns `{object: "chat.completion", choices: [{message: {content}}]}`. For completions, we extract `choices[0].message.content` and reshape as `{object: "text_completion", choices: [{text, index, finish_reason}]}`.

6. **Server routing is a flat if/else chain** — adding `POST /v1/completions` is a one-liner in `server.ts`, following the existing pattern.

7. **Testing pattern** — tests call route handlers directly (no HTTP server), mock `fetch` via `spyOn(globalThis, "fetch")`, and mock `ensureValidToken` / `getCredentials` from `src/domain/credentials.ts`. The transform-only tests call `streamAnthropicToOpenai()` directly with synthetic `ReadableStream<Uint8Array>` inputs.

8. **`observability` middleware wrapping** — all production routes wrap their handler with `withObservability()`. The completions route must do the same.

9. **The `object` field mismatch** — this is the only hard incompatibility with direct reuse of existing transform functions. Everything else (model resolution, system building, upstream call, error handling, token accounting, SSE framing) is identical.

### Affected Areas

- `src/http/routes/chat.ts` — reference implementation to follow; no changes needed
- `src/http/routes/completions.ts` — **NEW FILE** — the route handler
- `src/transform/openai-to-anthropic.ts` — reused as-is; FIM messages synthesized upstream of it
- `src/transform/anthropic-to-openai.ts` — `anthropicToOpenai()` reused for non-streaming shape extraction
- `src/transform/streaming.ts` — needs either direct reuse (with a post-processing shim) or a separate `streamAnthropicToCompletions()` for correct `object`/`text` fields
- `src/http/server.ts` — add one route registration line
- `__tests__/http-routes-completions.spec.ts` — **NEW FILE** — unit tests

### FIM Prompt Template Analysis

Claude has no fill-in-the-middle endpoint. The de-facto approach for FIM with chat models is to construct a system or user message that describes the task and places `<prefix>` and `<suffix>` markers:

**Option A — Minimal single-message:**
```
<fim_prefix>{prompt}<fim_suffix>{suffix}<fim_middle>
```
Sends a single user message in FIM notation. Claude understands these markers from its training on code data. The response should be ONLY the completion (no explanation). Risk: Claude may add prose if the prompt is ambiguous.

**Option B — Explicit instruction message (recommended):**
```
system: "You are a code completion engine. Complete the code between <|fim_prefix|> and <|fim_suffix|>. Return ONLY the completion text, no explanation, no markdown."
user: "<|fim_prefix|>{prompt}<|fim_suffix|>{suffix}<|fim_middle|>"
```
Two-message approach. The system instruction anchors the model's role. More reliable for avoiding prose. Aligns with how Continue.dev and similar tools approach FIM with non-FIM models.

**Option C — OpenCode-style inlined:**
```
user: "Complete the following code. Only output the completion, nothing else.\n\nPrefix:\n{prompt}\n\nSuffix:\n{suffix}\n\nCompletion:"
```
Prose description without special tokens. More portable but less precise signal to the model.

**Recommendation: Option B** — explicit system instruction + FIM tokens in user message. Provides the clearest signal, reduces "Claude will explain itself" risk, and works with adaptive thinking (`thinking: {type: "adaptive", display: "summarized"}`) which is injected by default for capable models.

**Important**: `clean_system: true` must be set in the synthesized body so `openaiToAnthropic` does NOT inject the "You are Claude Code" identity block. For FIM, we want the code-completion system prompt, not the CLI identity. The billing header is still injected (required for OAuth).

### Streaming Shape Difference

Current streaming output (`streamAnthropicToOpenai`):
```json
{"object":"chat.completion.chunk","choices":[{"delta":{"content":"text"},"finish_reason":null}]}
```

Required completions streaming output:
```json
{"object":"text_completion","choices":[{"text":"completion text","index":0,"finish_reason":null}]}
```

**Approach A: Thin wrapper** — call `streamAnthropicToOpenai()` and pipe its output through a `TransformStream` that rewrites each chunk. Reuses all the complex logic (keep-alive, buffer flush, deferred-cancel, telemetry).

**Approach B: New `streamAnthropicToCompletions()` function** — copy-paste `streaming.ts` with modified chunk shapes. Full control but duplicates ~300 lines of complex, battle-tested logic.

**Approach C: Parameterize `streamAnthropicToOpenai()`** — add a `mode: "chat" | "completions"` param. Single source of truth, no duplication, small interface change.

**Recommendation: Approach A (thin wrapper / TransformStream)** — it's the lowest risk. The deferred-cancel logic, keep-alive heartbeats, buffer flush, and telemetry in `streaming.ts` are complex and well-tested. Duplicating them (Approach B) invites drift. Adding a parameter (Approach C) couples two concerns. A `TransformStream` is ~20 lines and leaves the existing implementation untouched. If the wrapper has parsing costs, it's negligible for a low-throughput autocomplete endpoint.

### Approaches

1. **Thin completions route + TransformStream wrapper (Recommended)**
   - New `src/http/routes/completions.ts`: synthesizes FIM messages → calls `openaiToAnthropic()` with `clean_system: true` → `callAnthropic()` → for streaming: pipe `streamAnthropicToOpenai()` through a `TransformStream` that rewrites `object` and `delta.content → text`; for non-streaming: call `anthropicToOpenai()` and reshape the result
   - Server: one line in `server.ts`
   - Zero changes to transform layer
   - Pros: minimal surface, zero risk to existing routes, reuses all battle-tested streaming logic
   - Cons: stream output passes through two transform stages (small overhead)
   - Effort: **Low** (~120 LOC new, 1 LOC change)

2. **Parameterized streaming function**
   - Add `mode: "chat" | "completions"` to `streamAnthropicToOpenai()`
   - Conditionally emit `object: "text_completion"` and `text:` instead of `delta.content:`
   - Pros: single function, no double-parsing
   - Cons: modifies tested file (risks regression), couples chat and completions concerns
   - Effort: **Low-Medium** (~150 LOC change in streaming.ts + completions route)

3. **Dedicated `streamAnthropicToCompletions()` function**
   - New function in `streaming.ts` or `streaming-completions.ts`, adapting the existing logic
   - Pros: clean separation, full control over output
   - Cons: duplicates ~300 lines of complex logic; maintenance burden when streaming.ts changes
   - Effort: **Medium** (~400 LOC total)

### Recommendation

**Approach 1 (thin route + TransformStream wrapper).** The TransformStream parses each SSE line, detects `"object":"chat.completion.chunk"`, and rewrites it as `"text_completion"` while moving `delta.content` to `text`. Lines like `data: [DONE]`, keep-alive comments (`: keep-alive`), and non-data lines pass through untouched. This is ~25 lines of glue code and leaves all existing logic intact.

The FIM prompt template should be **Option B**: explicit system instruction (`clean_system: true` suppresses Claude Code identity) + FIM-token user message. The `suffix` field is optional per OpenAI spec — if absent, treat as prefix-only completion.

### Risks

- **Claude verbosity**: Claude may add explanation despite the system prompt. Mitigation: test the prompt template empirically; the system instruction ("return ONLY the completion text") is well-established for code models.
- **`clean_system: true` interaction**: this flag is respected by `openaiToAnthropic()` and drops the Claude Code identity but keeps the billing header. Confirmed by reading the source — safe to use.
- **Adaptive thinking in FIM context**: `openaiToAnthropic()` injects `thinking: {type:"adaptive", display:"summarized"}` for capable models. For autocomplete this adds latency. Mitigation: synthesized body can include `model: "claude-haiku-*"` (no adaptive thinking) or we can pass `no_thinking: true` — but this field doesn't exist yet. Simpler: document that callers should use a haiku-class model for FIM, as Continue.dev recommends.
- **Object field mismatch in non-streaming**: `anthropicToOpenai()` returns `object: "chat.completion"`. Our route handler reshapes this — the function itself is not modified. No regression risk.
- **TransformStream parsing overhead**: SSE lines are parsed twice (once in `streamAnthropicToOpenai`, once in the wrapper). For autocomplete (small completions, short streams), this is negligible.
- **Test isolation**: the route handler imports `callAnthropic`, `ensureValidToken`, and `ensureAccountUuid`. All are mockable via `spyOn` following the existing test pattern in `http-routes-tokens.spec.ts`.

### Implementation Sketch

```
completions.ts handler:
  1. Parse body → extract { model, prompt, suffix, max_tokens, stream, temperature, stop }
  2. Synthesize messages: [{ role: "user", content: "<|fim_prefix|>{prompt}<|fim_suffix|>{suffix}<|fim_middle|>" }]
  3. Build openaiBody: { model, messages, max_tokens, stream, temperature, stop, clean_system: true, system_override: FIM_SYSTEM_PROMPT }
     Wait — openaiToAnthropic() does not accept a system_override. Instead inject system as a message with role:"system":
     messages = [{ role: "system", content: FIM_SYSTEM_PROMPT }, { role: "user", content: "..." }]
  4. Call openaiToAnthropic(openaiBody) → { body: anthropicBody, isStructuredOutput }
  5. Call callAnthropic(anthropicBody, { model, isStream, isStructuredOutput })
  6. If streaming: pipe streamAnthropicToOpenai() through completionsTransformStream()
  7. If non-streaming: reshape anthropicToOpenai() result → text_completion shape
```

**FIM system prompt:**
```
You are a code completion engine. Your task is to fill in the middle of the code.
Return ONLY the completion text that goes between the prefix and suffix.
Do not add any explanation, comments, or markdown formatting.
```

### New Files Required

- `src/http/routes/completions.ts` — route handler (~100 LOC)
- `__tests__/http-routes-completions.spec.ts` — unit tests (~120 LOC)

### Modified Files

- `src/http/server.ts` — add 2 lines (import + route registration)

### Ready for Proposal

Yes. The scope is well-defined, the risk is low, and the implementation path is clear. The key decisions are:
1. Use TransformStream wrapper (not modifying `streaming.ts`)
2. FIM template: system instruction + `<|fim_prefix|>...<|fim_suffix|>...<|fim_middle|>` in user message
3. `clean_system: true` to suppress Claude Code identity in favor of the FIM system prompt
4. Callers should prefer haiku-class models for latency (document, don't enforce)
