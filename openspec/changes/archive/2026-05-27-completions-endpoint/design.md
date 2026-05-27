# Design: POST /v1/completions — OpenAI Legacy Completions (FIM)

## Technical Approach

Add a thin route handler `src/http/routes/completions.ts` that mirrors `chat.ts` structure. It synthesizes a FIM `messages[]` array, delegates to the existing `openaiToAnthropic` → `callAnthropic` → `anthropicToOpenai` / `streamAnthropicToOpenai` pipeline, then reshapes the output to the `text_completion` object type. No shared transform code is modified.

## Architecture Decisions

| Decision | Choice | Alternatives Rejected | Rationale |
|---|---|---|---|
| FIM encoding | System + user message with `<\|fim_prefix\|>…<\|fim_suffix\|>…<\|fim_middle\|>` tokens | Native FIM endpoint | Anthropic has no FIM endpoint; token markers are the industry-standard chat-FIM convention |
| `clean_system: true` | Pass flag to `openaiToAnthropic()` | Hardcode billing-only system | Reuses existing tested mechanism; drops Claude identity that would pollute autocomplete completions |
| Streaming rewrite | Inline `TransformStream` inside `completions.ts` | New helper in `streaming.ts` | One-file surface area; zero changes to shared transform layer (proposal constraint) |
| Response shape | Build `text_completion` object in-handler | Add param to `anthropicToOpenai()` | `anthropicToOpenai()` is a shared function; adding a mode param would spread completions logic across files |
| Observability | `withObservability()` wrapper in `server.ts` | Direct call | Matches every other route — uniform telemetry with no per-handler code |

## Data Flow

### Non-streaming

```
Client POST /v1/completions
  { model, prompt, suffix, max_tokens, temperature, stop }
        │
        ▼
handleCompletions()
  buildFimMessages(prompt, suffix)
    → system: "Return ONLY the completion text…"
    → user:   "<|fim_prefix|>{prompt}<|fim_suffix|>{suffix}<|fim_middle|>"
  openaiToAnthropic({ model, messages, max_tokens, temperature, stop,
                      stream: false, clean_system: true })
        │
        ▼
callAnthropic(anthropicBody)          ← upstream HTTP (existing)
        │
        ▼
anthropicToOpenai(data, model)        ← existing transform
  choices[0].message.content → text
        │
        ▼
reshapeToTextCompletion(openaiResp)
  { id, object: "text_completion", created, model,
    choices: [{ text, index: 0, finish_reason }],
    usage }
        │
        ▼
Response.json(textCompletion)
```

### Streaming

```
Client POST /v1/completions  { stream: true }
        │
        ▼
handleCompletions()   (same FIM + transform setup)
callAnthropic(anthropicBody)          ← upstream HTTP
        │
        ▼
streamAnthropicToOpenai(res.body, model)
  → ReadableStream of SSE "chat.completion.chunk" events
        │
        ▼
chatChunkToTextChunkStream()          ← TransformStream (new, inline)
  For each SSE line:
    parse JSON chunk
    rewrite: object "chat.completion.chunk" → "text_completion"
    rewrite: choices[0].delta.content   → choices[0].text
    re-serialize → SSE line
        │
        ▼
Response(stream, { "Content-Type": "text/event-stream" })
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `src/http/routes/completions.ts` | Create | Route handler: FIM synthesis, pipeline delegation, response reshape, streaming TransformStream |
| `src/http/server.ts` | Modify | Add import + 1-line route: `if (method === "POST" && pathname === "/v1/completions") return await observedCompletions(req)` |
| `__tests__/http-routes-completions.spec.ts` | Create | Unit tests (bun:test, spyOn pattern) |

## Interfaces / Contracts

```typescript
// src/http/routes/completions.ts

interface CompletionsRequest {
  model?: string;
  prompt: string;
  suffix?: string;
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
  stop?: string | string[];
}

// Text completion response (non-streaming)
interface TextCompletion {
  id: string;
  object: "text_completion";
  created: number;
  model: string;
  choices: Array<{
    text: string;
    index: number;
    finish_reason: string | null;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// SSE chunk shape (streaming) — each data: line
interface TextCompletionChunk {
  id: string;
  object: "text_completion";
  created: number;
  model: string;
  choices: Array<{
    text: string;           // renamed from delta.content
    index: number;
    finish_reason: string | null;
  }>;
}
```

### FIM message template

```typescript
function buildFimMessages(prompt: string, suffix = ""): Array<Record<string, unknown>> {
  return [
    {
      role: "system",
      content: "You are a code completion engine. Return ONLY the completion text with no explanation, preamble, or markdown."
    },
    {
      role: "user",
      content: `<|fim_prefix|>${prompt}<|fim_suffix|>${suffix}<|fim_middle|>`
    }
  ];
}
```

### TransformStream (streaming rewrite)

The inline `chatChunkToTextChunkStream()` function wraps the `ReadableStream` returned by `streamAnthropicToOpenai`. It:

1. Passes SSE comment lines (`: keep-alive`) through unchanged
2. Passes `data: [DONE]` through unchanged
3. For every `data: {…}` line: parses JSON, rewrites `object` and `choices[0].delta.content → choices[0].text`, re-serializes

```typescript
// Pseudocode — actual impl in completions.ts
function chatChunkToTextChunkStream(chatStream: ReadableStream, model: string): ReadableStream {
  // TextDecoderStream + TextEncoderStream + TransformStream
  // line-by-line: if starts with "data: " parse, rewrite, re-emit
  // passthrough: SSE comments, [DONE]
}
```

## Testing Strategy

| Layer | What | Approach |
|---|---|---|
| Unit — FIM synthesis | `buildFimMessages` produces correct token structure | Pure function, direct assert |
| Unit — non-streaming reshape | `handleCompletions()` returns `object: "text_completion"` with correct `choices[0].text` | `spyOn(callAnthropic)` mock returns canned Anthropic response |
| Unit — streaming rewrite | TransformStream converts `chat.completion.chunk` → `text_completion` chunks | Feed synthetic SSE stream; assert output SSE lines |
| Unit — streaming passthrough | `[DONE]` and `: keep-alive` lines pass through unmodified | Same synthetic stream test |
| Unit — error passthrough | Upstream error (non-2xx) returns error JSON | Mock `callAnthropic` to return 401 |
| Unit — `clean_system` forwarded | `openaiToAnthropic` receives `clean_system: true` | Spy on `openaiToAnthropic` import |

Pattern: mirrors `http-routes-models.spec.ts` — `spyOn(globalThis, "fetch")` or module-level spy on `callAnthropic`; direct handler function call; `Response.json()` assertion.

## Migration / Rollout

No migration required. The route is purely additive. Rollback: delete `completions.ts`, delete the spec file, revert the 2-line `server.ts` diff.

## Open Questions

- [ ] Should `stop` sequences be forwarded as-is to `openaiToAnthropic`? The existing transform does not handle `stop` at the top level — verify whether `openaiToAnthropic` passes unknown fields through or silently drops them. If dropped, add explicit mapping.
- [ ] Should the handler validate that `prompt` is a non-empty string and return 400 immediately? The proposal is silent on input validation; the existing `chat.ts` handler does no validation beyond `req.json()`.
