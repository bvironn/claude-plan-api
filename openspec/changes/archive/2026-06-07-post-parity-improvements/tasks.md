# Tasks: Post-Parity Improvements (S1, S6, S7)

> Delivery: direct work-unit commits to master — no PRs. Push after verify passes.
> TDD mode: STRICT. Every task that changes behavior follows red → green → refactor.
> Tests travel with the code that makes them pass (same commit, same work unit).

---

## WU1 — S1: Empty-String Stop Filter

Spec reference: transform-parity spec, "stop to stop_sequences mapping" requirement.

### Tasks (sequential)

- [x] **WU1-T1 (RED)** — In `__tests__/transform-stop-sequences.spec.ts`, add failing test scenarios:
  - `stop: ""` → `stop_sequences` key absent in upstream body
  - `stop: ["", "x"]` → `stop_sequences: ["x"]` (mixed array, empty entries stripped)
  - Confirm `bun test` fails on the new cases before touching implementation.

- [x] **WU1-T2 (GREEN)** — In `src/transform/openai-to-anthropic.ts`, unify the stop normalization:
  - Collect both the single-string and array paths into a candidate array first.
  - Apply one shared post-filter: `candidates.filter((s): s is string => typeof s === "string" && s.length > 0)`.
  - The existing `normalized.length > 0` omit-check stays unchanged.
  - Confirm all WU1-T1 scenarios plus pre-existing stop tests pass.

- [x] **WU1-T3 (REFACTOR)** — Review for dead branches or redundant type-guards introduced. No behavior change allowed; test suite must stay green.

- [x] **WU1-T4 (COMMIT)** — Commit with message:
  ```
  fix(transform): filter empty-string stop values before stop_sequences mapping
  ```

---

## WU2 — S6: Deterministic Tool Ordering

Spec reference: transform-parity spec, "deterministic tool ordering before mapping" requirement.

> Note: This is an explicit intentional behavior change — tools must be sorted by client `function.name` in ascending code-unit order before the ToolMap is built and before `cache_control` is placed on the last tool. Apply does NOT treat this as drift.

### Tasks (sequential)

- [x] **WU2-T1 (RED)** — Create `__tests__/transform-tool-ordering.spec.ts` with failing tests:
  - Same tool set in `["search", "calculator", "fetch"]` order → upstream `tools` ordered `["calculator", "fetch", "search"]` (mapped names reflect sort).
  - Request A `["b_tool", "a_tool"]` and request B `["a_tool", "b_tool"]` → identical upstream arrays with `cache_control` on the same last element in both.
  - `cache_control` is on the tool whose client name is `"z_tool"` when tools are `["z_tool", "a_tool"]`.
  - Single tool remains unaffected (no sort-related side effects).
  - `body.tools` original array is NOT mutated (sort operates on a copy).
  - Confirm `bun test` fails on these before touching implementation.

- [x] **WU2-T2 (GREEN)** — In `src/transform/openai-to-anthropic.ts`, before the tool `.map()`:
  - Create a sorted copy: `[...body.tools].sort((a, b) => nameOf(a) < nameOf(b) ? -1 : nameOf(a) > nameOf(b) ? 1 : 0)` where `nameOf` reads `t.function.name`.
  - Use this sorted copy for both the ToolMap population and `addCacheControlToLastTool`.
  - Original `body.tools` reference MUST remain unmutated.
  - Confirm all WU2-T1 scenarios pass plus all pre-existing tool tests.

- [x] **WU2-T3 (REFACTOR)** — Verify `nameOf` is readable and that no existing tool_choice lookup breaks (ToolMap is keyed by client name — confirm sort does not affect lookup correctness). No behavior change; suite stays green.

- [x] **WU2-T4 (COMMIT)** — Commit with message:
  ```
  feat(transform): sort tools by client name before mapping for stable cache prefix
  ```

---

## WU3 — S7: Budget-Aware Cache Breakpoint Planner

Spec reference: cache-strategy spec (all requirements — billing-block exclusion, ≤4 total, intermediate placement, skip rule, eviction priority).

> This work unit carries three intentional behavior changes that apply MUST treat as explicit, not drift:
> 1. The breakpoint planner runs AFTER `repairToolPairs` (pipeline reorder).
> 2. Client-supplied `cache_control` on `messages[]` content blocks is stripped before the planner runs.
> 3. An intermediate breakpoint is added on the second-to-last user message's last block when budget allows.
>
> Design risk: `__tests__/transform-cache-control.spec.ts` asserts `total === 3` on a fixture with 2 user messages. Under S7 this fixture will produce 4 breakpoints (identity + tools + last user + intermediate). The expectation update is part of this work unit's red-green cycle — do NOT fix it outside WU3.

### Tasks (sequential)

- [x] **WU3-T1 (RED — new spec file)** — Create `__tests__/transform-cache-breakpoints.spec.ts` with failing tests covering all cache-strategy spec scenarios:
  - Billing block (`system[0]`) NEVER carries `cache_control` regardless of slot availability.
  - Billing block exclusion holds when identity block is absent (`clean_system: true`).
  - Four breakpoints when all slots active: identity on, tools present, ≥3 user messages.
  - Two breakpoints when identity off, no tools, ≥3 user messages.
  - Intermediate breakpoint placed on first user message's last block when exactly 2 user messages, tools present, identity off.
  - Intermediate breakpoint placed on third user message (second-to-last) when 4 user messages exist.
  - Single user message → no intermediate breakpoint placed.
  - Zero user messages → no user-message breakpoints placed.
  - Budget exhausted by identity + tools + final user → intermediate dropped (total = 3).
  - Client-supplied `cache_control` on `messages[]` content blocks is stripped before planner runs (verify no client marker survives in upstream body).
  - Breakpoints land on post-repair blocks (place on orphaned `tool_result` → after repair the breakpoint is on the surviving block, not an orphan).
  - Confirm ALL new tests fail before touching implementation.

- [x] **WU3-T2 (RED — existing spec update)** — In `__tests__/transform-cache-control.spec.ts`, update the "Budget Ceiling" test:
  - The fixture has 2 user messages (`"start"` user turn + the tool_result batch user turn).
  - Under S7, this fixture qualifies for an intermediate breakpoint (2 user messages, identity on, tools present → 4 total).
  - Change the assertion from `expect(total).toBe(3)` to `expect(total).toBe(4)`.
  - Also verify the comment block for that test reflects the new expected count.
  - Confirm the modified test now fails (current code produces 3, not 4).

- [x] **WU3-T3 (GREEN — `stripClientCacheControl`)** — In `src/transform/openai-to-anthropic.ts`, add module-private helper:
  ```ts
  function stripClientCacheControl(messages: AnthropicMessage[]): void;
  ```
  Walks every `messages[*].content` block and deletes any `cache_control` key. Does NOT touch `system[]` or `tools[]`.

- [x] **WU3-T4 (GREEN — `applyCacheBreakpoints`)** — In `src/transform/openai-to-anthropic.ts`, add module-private helper:
  ```ts
  function applyCacheBreakpoints(messages: AnthropicMessage[], budget: number): void;
  ```
  - Walks `messages` backwards collecting indices where `role === "user"`.
  - Places `cache_control` on the last content block of the last user message (priority 1, consumes 1 slot).
  - If `budget >= 2` AND ≥2 user messages exist: places `cache_control` on the last content block of the second-to-last user message (priority 2).
  - String content is wrapped into a single text block (existing behavior preserved).
  - A missing anchor block (empty content) skips placement without consuming a slot.
  - Marker shape: `{ type: "ephemeral", ttl: "1h" }`.

- [x] **WU3-T5 (GREEN — pipeline reorder)** — In `src/transform/openai-to-anthropic.ts`, reorder the pipeline:
  1. `repaired = repairToolPairs(messages)`
  2. `stripClientCacheControl(repaired)`
  3. `budget = 4 - (includeIdentity ? 1 : 0) - (hasTools ? 1 : 0)`
  4. `applyCacheBreakpoints(repaired, budget)`
  - Remove the old `addCacheControlToLastUserBlock` call (replaced by `applyCacheBreakpoints`).
  - Confirm ALL tests in WU3-T1 and WU3-T2 now pass.
  - Confirm all pre-existing tests in `__tests__/transform-cache-control.spec.ts` still pass.

- [x] **WU3-T6 (REFACTOR)** — Review `applyCacheBreakpoints` for clarity of the budget subtraction and the backwards-walk. No behavior changes; suite stays green.

- [x] **WU3-T7 (COMMIT)** — Commit with message:
  ```
  feat(transform): add intermediate cache breakpoint and budget-aware planner (S7)
  ```

---

## WU4 — Full Suite Gate

Runs after WU1, WU2, WU3 are all committed.

### Tasks

- [x] **WU4-T1** — Run the full test suite:
  ```
  bun test
  ```
  All tests must pass. If any failure appears, fix within the work unit that owns the failing test before continuing.

- [x] **WU4-T2** — Run type-check:
  ```
  bun run tsc --noEmit
  ```
  Zero type errors permitted.

- [ ] **WU4-T3** — Push to master:
  ```
  git push origin master
  ```

---

## Parallelism Notes

| Work Unit | Can start when | Parallel with |
|-----------|---------------|---------------|
| WU1 | Immediately | WU2 (independent files, no shared state) |
| WU2 | Immediately | WU1 (independent files, no shared state) |
| WU3 | WU1 and WU2 committed | — (depends on both; touches same transform file) |
| WU4 | WU3 committed | — (final gate) |

WU1 and WU2 may be developed in parallel (different test files, different transform sections). WU3 must begin only after both are committed — it touches the same `openai-to-anthropic.ts` file and the existing `transform-cache-control.spec.ts`.

---

## Review Workload Forecast

| Metric | Estimate |
|--------|----------|
| Files modified | 3 (`openai-to-anthropic.ts`, `transform-stop-sequences.spec.ts`, `transform-cache-control.spec.ts`) |
| Files created | 2 (`transform-tool-ordering.spec.ts`, `transform-cache-breakpoints.spec.ts`) |
| Total files touched | 5 |
| Estimated changed lines | ~180–230 (implementation: ~60; new tests: ~120–160; existing test edits: ~10) |
| 400-line budget risk | Low |
| Chained commit slices recommended | WU1+WU2 can be two independent commits; WU3 is a single focused commit; WU4 is a no-code gate |
| Decision needed before apply | No |

No exceptional approval needed. The three work-unit commits are independently revertable and the total change is well within the 400-line threshold.

---

## Remediation (post-verify) — commit beb9fd3

Verify returned FAIL (C1 CRITICAL). Remediation applied 2026-06-07.

- [x] **R1 — Fix C1 (CRITICAL)**: Added failing test for nested `cache_control` in `tool_result.content`. Fixed `stripClientCacheControl` by extracting `stripCacheControlFromBlocks` helper that recursively clones blocks and strips `cache_control` at any depth including `block.content` arrays. Addresses max-4 ceiling invariant gap. TDD: RED (test failed showing 5 markers) → GREEN (fix makes strip recursive, all 12 tests pass).

- [x] **R2 — Fix W2 (weak tests)**: Replaced the conditional `if (firstBlock.cache_control)` assertion in the strip test with a hard `expect(firstBlock.cache_control).toEqual(EPHEMERAL_1H)` (intermediate slot always filled when budget ≥ 2 and ≥ 2 user messages exist). Replaced non-discriminating post-repair fixture with discriminating orphan-as-LAST fixture: orphaned tool_result appears as last message — fails under pre-change pipeline order, passes under planner-after-repairToolPairs.

- [x] **R3 — Address S1/S3**: Created distinct marker objects per `placeOnLastBlock` call (removed shared `marker` reference alias). Block cloning in `stripCacheControlFromBlocks` (spread `{ ...block }` before delete) addresses S3 in-place mutation concern.

- [x] **R4 — Fix W1 (spec amendment)**: Amended `specs/cache-strategy/spec.md` — reframed "intermediate dropped when budget exhausted" scenario as a structural invariant note (budget ≥ 2 always; eviction enforced by `budget ≥ 2` guard, not runtime eviction). Renamed the scenario to "intermediate absent when only one user message exists (skip rule, not eviction)". Condensed the 30-line comment essay in the covering test to a 3-line factual note.

**Test counts**: 368 (baseline) → 369 (added C1 regression test). Full suite: 369 pass / 0 fail.
