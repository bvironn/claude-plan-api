# Design: Anthropic API Parity Fixes (Transform Layer)

## Technical Approach

Pure transform-layer edits following the existing hexagonal-lite layout: request-side mappings stay in `src/transform/openai-to-anthropic.ts`, response-side in `anthropic-to-openai.ts` / `streaming.ts`, name translation stays in `src/domain/tool-mapping.ts` (unchanged). Two small shared modules are extracted to kill duplication drift. No route, header, or `system[]` changes. The Bun UAF-safe byte-encoding path in `chat.ts` and the streaming sink/cancel lifecycle are untouched.

## Architecture Decisions

| Decision | Choice | Alternatives Rejected | Rationale |
|---|---|---|---|
| tool_choice placement | Inside the existing `if (body.tools...)` block, AFTER `result.tools` `.map()` | Resolve before tools | The `.map()` populates the per-request ToolMap; specific-function lookup needs `toolMap.forward[name]` |
| Unknown function name | Fall back to `{type:"auto"}` + `warn` `transform.tool_choice.unknown_function` | Hard 400 | Proposal risk table mandates graceful fallback; gateway philosophy is never-throw transforms |
| `parallel_tool_calls:false` merge | Set `disable_parallel_tool_use: true` on resolved tool_choice, skipped when type is `"none"` | Separate top-level field | Anthropic carries the flag inside tool_choice; under `"none"` no tool runs so parallel control is moot |
| strict forwarding | Forward `strict: true` as-is in the tool `.map()` (only literal `true`) | Gate on header set at runtime; drop with warn | See Feasibility Check below — beta is unconditionally present; runtime gating would couple the pure transform to the upstream layer |
| stop mapping | `string` → `[s]`, `string[]` → filtered copy (non-empty strings only); omit field when result is empty | Pass raw value | Anthropic only accepts an array; empty arrays add request-fingerprint noise |
| stop_reason map | New `src/transform/stop-reason.ts` shared by both response files | Two local maps (status quo) | Proposal item 4; map already drifted risk Med; one tested source of truth |
| usage builder | New `src/transform/usage.ts` with `buildOpenAiUsage()` shared by both response files | Duplicate per file | Same drift argument as stop_reason; streaming's internal usage struct already uses Anthropic field names so one builder fits both |
| cached_tokens omit-vs-zero | Always emit `prompt_tokens_details: { cached_tokens: N }`, N defaults to 0 | Omit when upstream lacks field | Official OpenAI responses always include the details object; streaming initializes cache counters to 0 so "absent" is indistinguishable anyway |
| cache_creation omit-vs-zero | Emit top-level `cache_creation_input_tokens` only when > 0 | Always emit | Non-standard extension — keep vanilla OpenAI shape when caching is not in play |

## Feasibility Check: `strict: true` and beta headers (required output)

`src/upstream/headers.ts` shows a structured-outputs beta is ALWAYS present under OAuth:
- Chat path: `structured-outputs-2025-11-13` appended unconditionally (line 90).
- Structured-output path: `structured-outputs-2025-12-15` in the base set (line 59).

**Decision: forward `strict` as-is.** No gating code in the transform (it cannot see headers without a layering violation). Instead, protect the invariant with a test: `buildBetas()` output must contain a `structured-outputs-` beta on both paths.

**Residual risk**: the 400-retry beta-exclusion mechanism (`excluded` set) can strip the beta mid-session; whether upstream then tolerates `strict` in the body is undecidable from the repo. Mitigation: forward only literal `true`; rollback is a one-line drop of the spread.

## Data Flow (request side, tools block)

```
body.tools ──map()──▶ result.tools (+strict)  ──populates──▶ ToolMap
                                                                │
body.tool_choice ──resolve("none"|"required"|"auto"|{function})─┤ lookup
                                                                ▼
                          resolved tool_choice (default {type:"auto"})
body.parallel_tool_calls:false ──merge──▶ + disable_parallel_tool_use
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `src/transform/stop-reason.ts` | Create | `toFinishReason()` + map incl. `refusal→content_filter`, `model_context_window_exceeded→length`, `pause_turn→stop` |
| `src/transform/usage.ts` | Create | `OpenAiUsage` type + `buildOpenAiUsage()` |
| `src/transform/openai-to-anthropic.ts` | Modify | tool_choice resolution, `stop`→`stop_sequences`, `strict` spread, parallel merge — all inside/near the tools block (~L683-700) |
| `src/transform/anthropic-to-openai.ts` | Modify | Replace local stopMap (L22) + usage literal (L50-54) with shared imports |
| `src/transform/streaming.ts` | Modify | ONLY: replace stopMap (L40) and the `message_delta` usage literal (L220) — sink/cancel/flush code untouched |

## Interfaces / Contracts

```typescript
// src/transform/stop-reason.ts
export function toFinishReason(stopReason: unknown): string; // unknown → "stop"

// src/transform/usage.ts
export interface OpenAiUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details: { cached_tokens: number };
  cache_creation_input_tokens?: number; // extension; present only when > 0
}
export function buildOpenAiUsage(u: {
  input_tokens?: number; output_tokens?: number;
  cache_read_input_tokens?: number; cache_creation_input_tokens?: number;
}): OpenAiUsage;
```

tool_choice resolution table (request side):

| Client value | Upstream |
|---|---|
| absent / `"auto"` / unrecognized | `{type:"auto"}` |
| `"none"` | `{type:"none"}` |
| `"required"` | `{type:"any"}` |
| `{type:"function", function:{name}}` | `{type:"tool", name: toolMap.forward[name]}`; unmapped → warn + `{type:"auto"}` |

## Testing Strategy (Strict TDD — tests first, bun:test)

| Spec file | Status | Covers |
|---|---|---|
| `__tests__/transform-tool-choice.spec.ts` | New | All resolution rows, mcp_ name lookup, fallback warn, parallel merge incl. `"none"` skip, strict forwarding |
| `__tests__/transform-stop-sequences.spec.ts` | New | string/array/empty/non-string filtering, omission |
| `__tests__/transform-stop-reason.spec.ts` | New | Shared map unit + non-streaming via `anthropicToOpenai()` + streaming via synthetic SSE |
| `__tests__/transform-usage-cache-tokens.spec.ts` | New | `buildOpenAiUsage` unit, non-streaming response, streaming finish chunk |
| `__tests__/upstream-beta-exclusion.spec.ts` | Extend | Invariant: `buildBetas()` contains `structured-outputs-` on both paths |

Patterns reused: pure-function calls on `openaiToAnthropic` (per `transform-cache-control.spec.ts`); synthetic SSE `ReadableStream` fed to `streamAnthropicToOpenai` (per `transform-streaming-buffer-flush.spec.ts`). No fetch mocks needed — transforms are pure.

## Migration / Rollout

No migration. All changes in `src/transform/*` + tests; single-PR revert restores prior behavior.

## Open Questions

- [ ] None blocking. Residual risk on `strict` under runtime beta exclusion documented above; acceptable with the invariant test + trivial rollback.
