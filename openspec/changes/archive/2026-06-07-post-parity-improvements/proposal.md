# Proposal: Post-Parity Improvements (Disposition of S1–S7)

## Intent

Close all seven items left pending after `anthropic-api-parity-fixes`: three become implementation work, four are formally closed as non-goals. Cache efficiency is the dominant cost lever for this gateway (it burns the operator's Claude Max quota), so the two cache items (S6, S7) anchor the change.

## Scope

### In Scope

- **S1 — Empty-string stop filter**: guard the single-string `stop` path so `stop: ""` omits `stop_sequences` (parity with the array path; avoids upstream 400).
- **S6 — Deterministic tool ordering**: sort tools by client name before mapping so unstable client ordering no longer invalidates the cache prefix anchored at `tools[-1]`.
- **S7 — Intermediate cache breakpoint** (decision: in-scope): place a second breakpoint on the previous turn's last user block so long agentic conversations retain the prior turn's cache prefix within Anthropic's 20-block lookback. Hard constraints: total breakpoints ≤ 4 (worst case today is 3 with identity + tools); `system[0]` billing block MUST never carry `cache_control`; skip when fewer than 2 user messages.

### Out of Scope — formally closed as non-goals

| Item | Disposition | Rationale |
|------|-------------|-----------|
| S2 native `/v1/messages` passthrough | Non-goal | High effort; conflicts with all three OAuth invariants (billing block at `system[0]`, tool-name round-trip, curated betas); no identified client demand. Re-open only with a concrete SDK client AND a design preserving the invariants. |
| S3 document/PDF blocks | Non-goal | Gateway cannot materialize OpenAI file references (no OpenAI credentials). Pass-through yields an explicit upstream 400, not silent loss. Re-open if a client sends pre-resolved base64. |
| S4 batches/files endpoints | Non-goal | Architecturally non-viable: batch pricing requires API-key billing; the OAuth Max token has no batch surface. |
| S5 citations/server_tool_use blocks | Non-goal | YAGNI confirmed: unreachable through the current feature surface; zero client-visible impact today. |

## Capabilities

### New Capabilities

- `cache-strategy`: prompt-cache breakpoint placement policy — slot budget, billing-block exclusion invariant, last-user and intermediate user breakpoints (S7).

### Modified Capabilities

- `transform-parity`: stop-mapping requirement gains an empty-string scenario (S1); new requirement for deterministic tool ordering (S6).

## Approach

- S1: add a length guard to the single-string branch of stop normalization in `openai-to-anthropic.ts`.
- S6: stable-sort `body.tools` by `function.name` before mapping; ToolMap is order-independent so pre-sort is safe. Accept a one-time cache miss at deploy.
- S7: evolve `addCacheControlToLastUserBlock` into a budget-aware breakpoint planner marking the last and second-to-last user messages; exact placement and slot accounting resolved in design.
- Strict TDD throughout (`bun:test`, existing `__tests__/transform-*.spec.ts` patterns).

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/transform/openai-to-anthropic.ts` | Modified | S1 guard, S6 sort, S7 breakpoint planner |
| `__tests__/transform-stop-sequences.spec.ts` | Modified | S1 scenario |
| `__tests__/` (new specs) | New | S6 ordering, S7 breakpoint placement + invariants |
| `openspec/specs/cache-strategy/spec.md` | New | Breakpoint policy (via delta in this change) |
| `openspec/specs/transform-parity/spec.md` | Modified | S1, S6 deltas |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| S7 exceeds the 4-breakpoint max (identity + tools + 2 user) | Med | Slot accounting in the planner; drop the intermediate breakpoint first when the budget is full |
| S7 touches the billing block | Low | Invariant regression test: `system[0]` never carries `cache_control` |
| S6 one-time cache invalidation at deploy | Certain, one-time | Accepted; single deploy window |
| S7 gain unproven for short conversations | Med | Skip below 2 user messages; revert is one commit; measure via already-surfaced `cached_tokens` |

## Rollback Plan

All work lives in `src/transform/*` plus tests, landed as direct work-unit commits to master (no PRs; push at the end). Each item is an independently revertable commit; `git revert` restores prior behavior. No migrations, config, or new endpoints.

## Dependencies

None.

## Success Criteria

- [ ] `stop: ""` produces no `stop_sequences` upstream
- [ ] The same tool set in any client order yields an identical upstream `tools` array
- [ ] Requests with ≥ 2 user messages carry one intermediate + one final user-block breakpoint; total breakpoints never exceed 4
- [ ] `system[0]` never carries `cache_control` (regression test)
- [ ] S2–S5 are closed as documented non-goals — no further tracking
- [ ] `bun test` passes; `bun run tsc --noEmit` is clean
