# Tasks: POST /v1/completions — OpenAI Legacy Completions (FIM)

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~240 (2 new files + 2 lines in server.ts) |
| 400-line budget risk | Low |
| Chained PRs recommended | No |
| Suggested split | Single PR |
| Delivery strategy | auto-forecast |
| Chain strategy | pending |

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: pending
400-line budget risk: Low

### Suggested Work Units

| Unit | Goal | Likely PR | Notes |
|------|------|-----------|-------|
| 1 | All changes in a single reviewable PR | PR 1 | completions.ts + server.ts + spec file; tests included |

---

## Open Questions — Resolved

- **`stop` field**: `openai-to-anthropic.ts` has no `stop` handling — it is silently dropped by the transform. Forward `stop` in the body passed to `openaiToAnthropic`; no explicit mapping required.
- **Missing `prompt` → 400**: Spec MUST validate. Return explicit `400` with `{ error: { message: "prompt is required" } }` before any upstream call.

---

## Phase 1: Foundation

- [x] 1.1 Create `src/http/routes/completions.ts` — declare `CompletionsRequest` interface (`model`, `prompt`, `suffix?`, `max_tokens?`, `temperature?`, `stream?`, `stop?`)
- [x] 1.2 Implement `buildFimMessages(prompt, suffix?)` — returns system message ("Return ONLY the completion text…") + user message with FIM tokens (`<|fim_prefix|>{prompt}<|fim_suffix|>{suffix}<|fim_middle|>`)
- [x] 1.3 Implement `reshapeToTextCompletion(openaiResp, model)` — extracts `choices[0].message.content` from `anthropicToOpenai()` output, returns `{ id, object: "text_completion", created, model, choices: [{ text, index: 0, finish_reason }], usage }`

## Phase 2: Core Implementation

- [x] 2.1 Implement `chatChunkToTextChunkStream(chatStream, model)` — inline `TransformStream` that line-by-line passes SSE comments and `[DONE]` unchanged; for `data: {…}` lines rewrites `object: "chat.completion.chunk"` → `"text_completion"` and `choices[0].delta.content` → `choices[0].text`
- [x] 2.2 Implement `handleCompletions(req)` — parse body; return 400 if `prompt` missing; call `openaiToAnthropic({ model, messages: buildFimMessages(...), max_tokens, temperature, stop, stream, clean_system: true })`
- [x] 2.3 Add non-streaming path: call `callAnthropic()`, on non-ok return upstream error; on ok call `anthropicToOpenai()` then `reshapeToTextCompletion()`; return `Response.json()`
- [x] 2.4 Add streaming path: call `callAnthropic()`, on non-ok return error; pipe `streamAnthropicToOpenai(res.body, model)` through `chatChunkToTextChunkStream()`; return SSE `Response`

## Phase 3: Wiring

- [x] 3.1 In `src/http/server.ts` — add `import { handleCompletions } from "./routes/completions.ts"` (line after `handleChat` import)
- [x] 3.2 In `src/http/server.ts` — add `const observedCompletions = withObservability(handleCompletions)` (line after `observedChat`)
- [x] 3.3 In `src/http/server.ts` — add route line `if (method === "POST" && pathname === "/v1/completions") return await observedCompletions(req)` immediately after the `chat/completions` route

## Phase 4: Testing (TDD — write tests first, make them pass)

- [x] 4.1 RED — Create `__tests__/http-routes-completions.spec.ts`; add `spyOn(globalThis, "fetch")` scaffold mirroring `http-routes-tokens.spec.ts`; write failing test: `POST /v1/completions` without `prompt` → 400 with `error` field
- [x] 4.2 RED — Write failing test: valid non-streaming request returns 200 with `object: "text_completion"` and `choices[0].text`
- [x] 4.3 RED — Write failing test: FIM with `suffix` — spy on `openaiToAnthropic` (or inspect fetch call body) to assert `<|fim_prefix|>…<|fim_suffix|>…<|fim_middle|>` token order in upstream messages
- [x] 4.4 RED — Write failing test: FIM without `suffix` — upstream user message contains `<|fim_prefix|>…<|fim_middle|>` only
- [x] 4.5 RED — Write failing test: `clean_system: true` forwarded — spy on `openaiToAnthropic` import to assert flag is set
- [x] 4.6 RED — Write failing test: streaming request returns `Content-Type: text/event-stream`; each chunk has `object: "text_completion"` and `choices[0].text`; last event is `data: [DONE]`
- [x] 4.7 RED — Write failing test: upstream non-2xx (non-streaming) → handler returns same error status
- [x] 4.8 GREEN — Run `bun test __tests__/http-routes-completions.spec.ts`; implement until all 7 tests pass
- [x] 4.9 VERIFY — Run `bun test` (full suite); confirm no regressions; run `bun run tsc --noEmit` for type-clean compile

## Phase 5: Warning Fixes (post-verify)

- [x] W-01 — Add test: `best_of: 3` not forwarded to upstream Anthropic request body
- [x] W-02 — Add test: streaming path with upstream 503 returns plain error response (not SSE)
- [x] W-03 — Fix conditional assertion in streaming chunk test: filter finish-reason chunks, assert remaining unconditionally have `choices[0].text` as string
- [x] S-01 — Add test: `suffix: ""` treated as absent (no `<|fim_suffix|>` tokens in upstream)
