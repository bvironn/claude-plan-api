# Proposal: Anthropic API Parity Fixes (Transform Layer)

## Intent

A 2026-06-06 parity audit (engram #214) found the gateway silently drops or mistranslates several OpenAI parameters. Clients lose tool-invocation control (`tool_choice` dropped), custom `stop` sequences never reach upstream, prompt-cache savings are invisible in `usage`, and `finish_reason` loses safety/limit semantics (`refusal` and `model_context_window_exceeded` both report `"stop"`). This change closes the transform-layer gaps.

## Scope

### In Scope

1. Map client `tool_choice`: `"none"` → `{type:"none"}`, `"required"` → `{type:"any"}`, `{type:"function"}` → `{type:"tool", name}` via the per-request ToolMap (`mcp_PascalCase` names). Keep `{type:"auto"}` default.
2. Map OpenAI `stop` (string | string[]) → `stop_sequences`.
3. Surface cache usage: `usage.prompt_tokens_details.cached_tokens` (reads) plus `usage.cache_creation_input_tokens` extension (writes) — non-streaming and streaming finish chunk.
4. Extend stop-reason map: `refusal` → `"content_filter"`, `model_context_window_exceeded` → `"length"`, `pause_turn` → `"stop"` (explicit). Extract the duplicated map into one shared module.
5. Forward tool `strict: true` (gated on a feasibility check — see Risks).
6. Map `parallel_tool_calls: false` → `tool_choice.disable_parallel_tool_use: true`, merged into the resolved `tool_choice`.

### Out of Scope

- `stream_options.include_usage` final-usage-chunk emission (audit item 7) — deferred: touches the streaming finish/cancel path recently patched for a Bun UAF segfault, and needs a backward-compat decision (usage is currently always inline).
- Native `/v1/messages` passthrough, batches, files endpoints.
- Any change to `system[]` handling (reserved for OAuth billing block + identity).
- Document/PDF block transform.

## Capabilities

### New Capabilities

- `transform-parity`: fidelity rules for OpenAI↔Anthropic parameter and response translation (tool_choice, stop sequences, cache usage, finish_reason semantics, strict tools, parallel-tool control)

### Modified Capabilities

None

## Approach

Pure transform-layer edits; no route, upstream-header, or `system[]` changes; per-request ToolMap concurrency model untouched.

- Request side (`openai-to-anthropic.ts`): resolve client `tool_choice` before the auto-default; map specific function names through the existing ToolMap; copy `stop` → `stop_sequences`; forward `strict`; merge `disable_parallel_tool_use`.
- Response side (`anthropic-to-openai.ts`, `streaming.ts`): shared stop-reason module; usage builder gains cache-token fields.
- Strict TDD: every mapping lands test-first with bun:test, following `__tests__/transform-*.spec.ts` patterns.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/transform/openai-to-anthropic.ts` | Modified | Items 1, 2, 5, 6 (request-side mappings) |
| `src/transform/anthropic-to-openai.ts` | Modified | Items 3, 4 (usage + finish_reason) |
| `src/transform/streaming.ts` | Modified | Items 3, 4 on finish chunk |
| `src/transform/stop-reason.ts` | New | Shared stop_reason → finish_reason map |
| `__tests__/transform-*.spec.ts` | New/Modified | TDD specs per mapping |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| `tool_choice` names a function absent from `tools[]` | Low | Fall back to `{type:"auto"}` + warn log |
| `strict: true` requires a beta header the gateway deliberately excludes | Med | Verify against pinned `anthropic-version: 2023-06-01` first; drop item 5 if a beta is required |
| Extra usage fields break strict OpenAI clients | Low | `cached_tokens` uses the official OpenAI slot; clients ignore unknown fields |
| Stop-reason map drift between streaming/non-streaming | Med | Single shared module (item 4) |

## Rollback Plan

All changes confined to `src/transform/*` plus tests. No migrations, no config, no new endpoints. Single PR revert restores prior behavior.

## Dependencies

None — no new packages.

## Success Criteria

- [ ] `tool_choice` `"none"` / `"required"` / specific-function reach upstream in correct Anthropic shape with mapped tool names
- [ ] `stop` values appear upstream as `stop_sequences`
- [ ] Cache hits expose `usage.prompt_tokens_details.cached_tokens` in streaming and non-streaming responses
- [ ] `refusal` → `content_filter`; `model_context_window_exceeded` → `length`
- [ ] `parallel_tool_calls: false` produces `disable_parallel_tool_use: true` upstream
- [ ] All existing tests pass (`bun test`); TypeScript compiles cleanly (`bun run tsc --noEmit`)
