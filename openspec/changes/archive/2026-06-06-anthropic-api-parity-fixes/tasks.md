# Tasks: Anthropic API Parity Fixes (Transform Layer)

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | 280–360 (code ~140, tests ~180) |
| 400-line budget risk | Medium |
| Chained PRs recommended | No |
| Suggested split | Single PR |
| Delivery strategy | ask-on-risk |
| Chain strategy | pending |

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: pending
400-line budget risk: Medium

### Suggested Work Units

| Unit | Goal | Likely PR | Notes |
|------|------|-----------|-------|
| 1 | All transform-layer parity fixes + tests | PR 1 | Self-contained; pure transform files only; no route/sink changes |

---

## Phase 1: Shared Module Infrastructure

- [x] 1.1 **[RED]** Create `__tests__/transform-stop-reason.spec.ts` — failing tests for `toFinishReason()`: all 7 known values + unknown fallback, plus verify non-streaming (`anthropicToOpenai`) and streaming (`streamAnthropicToOpenai`) both produce identical output for `"refusal"` and `"model_context_window_exceeded"`. Reference spec: stop_reason mapping — non-streaming + streaming requirements.
- [x] 1.2 **[GREEN]** Create `src/transform/stop-reason.ts` — export `toFinishReason(stopReason: unknown): string` with map: `end_turn→stop`, `max_tokens→length`, `stop_sequence→stop`, `tool_use→tool_calls`, `refusal→content_filter`, `model_context_window_exceeded→length`, `pause_turn→stop`; unknown falls back to `"stop"`. Run `bun test __tests__/transform-stop-reason.spec.ts` — must go green (unit assertions only; consumer assertions stay red until Phase 3).
- [x] 1.3 **[RED]** Create `__tests__/transform-usage-cache-tokens.spec.ts` — failing unit tests for `buildOpenAiUsage()`: reads/creation present, only reads present, only creation present (>0 emits field), all absent (cached_tokens=0, cache_creation_input_tokens omitted). Reference spec: cache usage requirements.
- [x] 1.4 **[GREEN]** Create `src/transform/usage.ts` — export `OpenAiUsage` interface and `buildOpenAiUsage(u)`. `prompt_tokens_details.cached_tokens` always present (defaults 0). `cache_creation_input_tokens` emitted only when > 0 (design decision overrides spec "always 0" wording). Run `bun test __tests__/transform-usage-cache-tokens.spec.ts` — unit assertions green.

---

## Phase 2: Request-Side Transform — openai-to-anthropic.ts

- [x] 2.1 **[RED]** Create `__tests__/transform-tool-choice.spec.ts` — failing tests for:
  - String mappings: `"none"→{type:"none"}`, `"required"→{type:"any"}`, `"auto"→{type:"auto"}`, absent→`{type:"auto"}` (spec: tool_choice string mapping).
  - Named function resolves via ToolMap to `mcp_`-prefixed name (spec: tool_choice object mapping — named function).
  - Unknown function name falls back to `{type:"auto"}` + warn log event at level `"warn"` with event `"transform.tool_choice.unknown_function"` (spec: unknown function name).
- [x] 2.2 **[RED — same file, extend]** Add parallel_tool_calls tests to `__tests__/transform-tool-choice.spec.ts`:
  - `parallel_tool_calls:false` with tools → `tool_choice` contains `disable_parallel_tool_use:true` (spec: parallel_tool_calls false adds disable flag).
  - `parallel_tool_calls:false` + `tool_choice:"required"` → `{type:"any", disable_parallel_tool_use:true}` (spec: both preserved).
  - `parallel_tool_calls:false` + `tool_choice:"none"` → `{type:"none"}` WITHOUT `disable_parallel_tool_use` (design: skipped when type is "none").
  - Absent / `true` → no `disable_parallel_tool_use` (spec: absent/true — no flag).
- [x] 2.3 **[RED — same file, extend]** Add strict-forwarding tests to `__tests__/transform-tool-choice.spec.ts`:
  - Tool with `function.strict: true` → upstream tool definition includes `strict: true` (spec: strict forwarding gated).
  - Tool without `strict` → upstream tool definition has no `strict` field.
- [x] 2.4 **[GREEN]** Modify `src/transform/openai-to-anthropic.ts` inside the `if (body.tools ...)` block (~L683–700):
  - In the `result.tools` `.map()`: spread `...(fn.strict === true ? { strict: true } : {})` onto the upstream tool object.
  - After `addCacheControlToLastTool(result.tools)` and AFTER the ToolMap is populated, resolve `tool_choice`:
    - `"none"` → `{type:"none"}`, `"required"` → `{type:"any"}`, `"auto"` / absent → `{type:"auto"}`, `{type:"function",function:{name}}` → lookup `toolMap.forward[name]` → `{type:"tool",name}` or warn + `{type:"auto"}`.
  - After tool_choice is resolved, if `body.parallel_tool_calls === false` AND resolved type is not `"none"`, merge `disable_parallel_tool_use: true`.
  - Run `bun test __tests__/transform-tool-choice.spec.ts` — all green.
- [x] 2.5 **[RED]** Create `__tests__/transform-stop-sequences.spec.ts` — failing tests:
  - `stop: "\n"` → `stop_sequences: ["\n"]` (spec: string stop becomes single-element array).
  - `stop: ["STOP","END"]` → `stop_sequences: ["STOP","END"]` (spec: array forwarded as-is).
  - `stop: []` → no `stop_sequences` key (spec: empty array omits).
  - `stop` absent → no `stop_sequences` key (spec: absent omits).
- [x] 2.6 **[GREEN]** Modify `src/transform/openai-to-anthropic.ts` — add `stop`→`stop_sequences` mapping before the `emit("debug",...)` call: normalize to array, filter to non-empty strings, omit if empty. Run `bun test __tests__/transform-stop-sequences.spec.ts` — green.

---

## Phase 3: Response-Side Transform — anthropic-to-openai.ts and streaming.ts

- [x] 3.1 **[GREEN]** Modify `src/transform/anthropic-to-openai.ts`:
  - Replace the inline `stopMap` (L22) with an import of `toFinishReason` from `../transform/stop-reason.ts`.
  - Replace the `usage` literal (L50–54) with a call to `buildOpenAiUsage` from `../transform/usage.ts`, spreading the result.
  - Run `bun test __tests__/transform-stop-reason.spec.ts __tests__/transform-usage-cache-tokens.spec.ts` — consumer assertions now green.
- [x] 3.2 **[GREEN]** Modify `src/transform/streaming.ts` — chunk-shaping lines only:
  - Replace the inline `stopMap` (L40) with an import of `toFinishReason` from `./stop-reason.ts`.
  - Replace the `message_delta` usage literal (L220) with a call to `buildOpenAiUsage`, passing the accumulated `usage` object with `cache_read_input_tokens` and `cache_creation_input_tokens` captured at `message_start`.
  - DO NOT touch sink/cancel/flush lifecycle code.
  - Run `bun test __tests__/transform-stop-reason.spec.ts __tests__/transform-usage-cache-tokens.spec.ts` — streaming assertions green.

---

## Phase 4: Invariant Test and Spec Amendment

- [x] 4.1 **[GREEN — extend existing]** Extend `__tests__/upstream-beta-exclusion.spec.ts` — add a test in the `headers — REQ-7` describe block asserting that `buildBetas()` output contains a string matching `/structured-outputs-/` on both the structured-output path (`isStructuredOutput: true`) and the chat path (`isStructuredOutput: false`). This guards the `strict: true` forwarding invariant (design: feasibility check). Run `bun test __tests__/upstream-beta-exclusion.spec.ts` — green.
- [x] 4.2 **[SPEC AMENDMENT]** Edit `openspec/changes/anthropic-api-parity-fixes/specs/transform-parity/spec.md` — in the "Scenario: upstream omits cache fields — output is 0" section under "cache usage in non-streaming responses", amend the last bullet from `"AND usage.cache_creation_input_tokens equals 0"` to `"AND usage.cache_creation_input_tokens is absent (not present in the output object)"`. This reconciles the spec with the design decision: `cache_creation_input_tokens` is emitted only when > 0.

---

## Phase 5: Final Verification

- [x] 5.1 Run `bun test` (full suite) — all tests green, no regressions. Confirm test count increased by at least the new spec files. **Result: 348 pass, 0 fail (31 files). Previous baseline inferred ~290 tests; new spec files add 57 tests.**
