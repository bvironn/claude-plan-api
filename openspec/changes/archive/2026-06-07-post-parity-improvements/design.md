# Design: Post-Parity Improvements (S1, S6, S7)

## Technical Approach

All three items are pure-function changes inside `openaiToAnthropic` (`src/transform/openai-to-anthropic.ts`). S1 unifies the stop-filter, S6 pre-sorts tools, S7 replaces `addCacheControlToLastUserBlock` with a budget-aware breakpoint planner that runs after `repairToolPairs`. No new modules, routes, or config.

## Architecture Decisions

### Decision: S1 — unified post-filter for stop normalization

**Choice**: Normalize both branches to a candidate array, then apply one shared filter: `candidates.filter((s): s is string => typeof s === "string" && s.length > 0)`.
**Alternatives considered**: Guard only the single-string branch (`rawStop.length > 0` inside the ternary).
**Rationale**: The bug exists because the two branches have asymmetric guards. A single filter removes the asymmetry structurally instead of patching one branch; future shapes inherit the guard for free. The existing `normalized.length > 0` omit-check stays.

### Decision: S6 — pre-sort a copy of `body.tools` by client name, code-unit comparator

**Choice**: `[...body.tools].sort((a, b) => nameOf(a) < nameOf(b) ? -1 : nameOf(a) > nameOf(b) ? 1 : 0)` before `.map()`, where `nameOf` reads `t.function.name`.
**Alternatives considered**: (a) post-sort the mapped Anthropic array — works, but the ToolMap would be populated in client order, and sorting by mapped `mcp_PascalCase` names couples ordering to the mapping scheme; (b) `localeCompare` — locale/ICU-dependent, not guaranteed identical across runtimes; (c) in-place sort — mutates the client body, which logging/echo paths may inspect.
**Rationale**: Pre-sort is confirmed safe against ToolMap behavior: `forward` keys are original client names and `mapToolName` is deterministic per name, so insertion order is irrelevant (explore finding upheld). Code-unit `<`/`>` comparison is fully deterministic. `addCacheControlToLastTool` then always marks the lexicographically-last tool — stable across requests with the same tool set, which is exactly the cache-prefix goal. `Array.prototype.sort` is stable (ES2019), so duplicate names keep relative order.

### Decision: S7 — breakpoint planner runs AFTER repairToolPairs, on the wire-final array

**Choice**: Reorder the pipeline to `repaired = repairToolPairs(messages)` → `stripClientCacheControl(repaired)` → `applyCacheBreakpoints(repaired, budget)`.
**Alternatives considered**: Keep current pre-repair placement (line 558) and only add the intermediate mark.
**Rationale**: Today a breakpoint placed on an orphaned `tool_result` block is silently dropped by repair — a latent bug. Breakpoints must land on blocks that actually ship upstream. `repairToolPairs` shares block references, so post-repair mutation is safe.

### Decision: S7 — strip client-supplied cache_control from messages[] first

**Choice**: New helper walks every `messages[*].content` block and deletes `cache_control` before the planner runs.
**Alternatives considered**: Preserve client markers and count them against the budget.
**Rationale**: Without stripping, the ≤ 4 proof is impossible — clients can inject arbitrary markers (pass-through at `toAnthropicContentBlocks` line 98). The planner becomes the single authority. `tools[]` is already safe structurally (rebuilt field-by-field in `.map()`); `system[]` is gateway-constructed, so no client marker can enter it.

### Decision: S7 — anchor, skip rule, and eviction priority

**Choice**: Walk `repaired` backwards collecting user-message indices (`role === "user"`; each consecutive tool batch is one user message, so the second-to-last user message is the previous turn's boundary). Place the final breakpoint on the last user message's last block (priority 1), then the intermediate breakpoint on the second-to-last user message's last block (priority 2) only if `budget >= 2` and ≥ 2 user messages exist. `budget = 4 - (includeIdentity ? 1 : 0) - (hasTools ? 1 : 0)`, computed from values known before the call. String content is wrapped into a single text block (current behavior); a missing anchor block skips placement without consuming a slot. Marker shape stays `{ type: "ephemeral", ttl: "1h" }`.
**Rationale**: Priority ordering makes "drop intermediate first" structural, not incidental — if a future placement shrinks the budget, the intermediate is the first to disappear.

**Slot accounting (post-strip, exhaustive)**:

| Configuration | identity (system[1]) | tools[-1] | last user | intermediate | Total |
|---|---|---|---|---|---|
| default, no tools | 0 | 0 | 1 | ≤1 | ≤2 |
| default + tools | 0 | 1 | 1 | ≤1 | ≤3 |
| identity, no tools | 1 | 0 | 1 | ≤1 | ≤3 |
| identity + tools | 1 | 1 | 1 | ≤1 | **≤4** |

**system[0] invariant**: guaranteed structurally — `system[]` is built locally (billing block created without `cache_control`, line 507), the planner and stripper receive only `messages[]`, and no code path passes `system[]` to them. A regression test asserts it anyway.

## Data Flow

    body.tools ──sort──→ map() ──→ addCacheControlToLastTool
    messages ──→ repairToolPairs ──→ stripClientCacheControl
                                          │
    budget(identity, hasTools) ──→ applyCacheBreakpoints
                                     ├─ last user block      (slot, priority 1)
                                     └─ 2nd-to-last user blk (slot, priority 2)

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `src/transform/openai-to-anthropic.ts` | Modify | S1 unified filter; S6 sorted copy before map; S7 pipeline reorder + `stripClientCacheControl` + `applyCacheBreakpoints` (replaces `addCacheControlToLastUserBlock`) |
| `__tests__/transform-stop-sequences.spec.ts` | Modify | `stop: ""` omits `stop_sequences`; mixed `["", "x"]` keeps `["x"]` |
| `__tests__/transform-tool-ordering.spec.ts` | Create | Same set, two client orders → identical upstream array; cache_control on lexicographically-last tool; `body.tools` not mutated; tool_choice lookup unaffected |
| `__tests__/transform-cache-breakpoints.spec.ts` | Create | Intermediate placement (≥2 users, tool_result batch anchor), skip rule (<2 users), client cache_control stripped, post-repair placement, `system[0]` invariant, total ≤ 4 at full config |
| `__tests__/transform-cache-control.spec.ts` | Modify | Budget-ceiling expectation moves 3 → 4 (that fixture has 2 user messages) |

## Interfaces / Contracts

```ts
function stripClientCacheControl(messages: AnthropicMessage[]): void;
function applyCacheBreakpoints(messages: AnthropicMessage[], budget: number): void;
```

Both module-private, same file — matches the existing helper pattern.

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit | All scenarios above | Strict TDD (red → green per item), `bun test`, pure-function calls to `openaiToAnthropic`; reuse the recursive `countCacheControl` walker pattern |
| Type | No regressions | `bun run tsc --noEmit` |

No integration/E2E changes — transform layer only.

## Migration / Rollout

No migration. One-time cache miss at deploy (S6 reorder, S7 new marker) — accepted per proposal. Each item lands as an independently revertable commit.

## Open Questions

- [ ] None blocking. S7 hit-rate gain is unproven for short conversations — measured post-deploy via already-surfaced `cached_tokens` (proposal risk, not a design blocker).
