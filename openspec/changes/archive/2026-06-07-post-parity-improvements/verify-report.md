## Verification Report

**Change**: post-parity-improvements
**Version**: specs/transform-parity (delta S1, S6) + specs/cache-strategy (S7)
**Mode**: Strict TDD
**Commits reviewed**: fba3e74 (S1), c7a5688 (S6), 02582cf (S7)
**Date**: 2026-06-06

### Completeness

| Metric | Value |
|--------|-------|
| Tasks total | 16 |
| Tasks complete | 15 |
| Tasks incomplete | 1 (WU4-T3 push - intentionally gated on this verify passing; not a defect) |

### Build & Tests Execution

**Tests**: 368 pass / 0 fail / 1024 expect() calls across 33 files (3.98s) - matches implementer claim.

**Type check**: exits 2 - 7 errors, ALL in `__tests__/transform-streaming-abort-signal.spec.ts`. Verified PRE-EXISTING: identical output at base commit 33d2dd5 (before this change). No new type errors introduced. However, WU4-T2 ("Zero type errors permitted") is checked [x] while the literal gate fails - see W4.

**Coverage**: changed-file run (4 touched spec files): `src/transform/openai-to-anthropic.ts` 64.21% lines / 81.82% funcs, BUT all uncovered ranges are pre-existing branches (vision helpers, sanitize, effort resolution). Every new S1/S6/S7 line (sort block 688-708, stop block 742-757, strip 776-784, planner 795-844) is covered.

### Spec Compliance Matrix

| Requirement | Scenario | Test | Result |
|-------------|----------|------|--------|
| S1 stop mapping | string stop becomes single-element array | transform-stop-sequences.spec.ts | COMPLIANT |
| S1 stop mapping | string array forwarded as-is | transform-stop-sequences.spec.ts | COMPLIANT |
| S1 stop mapping | empty array omits | transform-stop-sequences.spec.ts | COMPLIANT |
| S1 stop mapping | absent stop omits | transform-stop-sequences.spec.ts | COMPLIANT |
| S1 stop mapping | empty string omits | transform-stop-sequences.spec.ts | COMPLIANT |
| S1 stop mapping | only-empty-strings array omits | transform-stop-sequences.spec.ts | COMPLIANT |
| S6 tool ordering | non-alphabetical sorted before mapping | transform-tool-ordering.spec.ts | COMPLIANT |
| S6 tool ordering | same set, different arrival orders, identical arrays | transform-tool-ordering.spec.ts | COMPLIANT (test asserts order + cache_control, not full byte equality; independent probe confirmed JSON.stringify equality - see SUGGESTION S-2) |
| S6 tool ordering | cache_control on last tool after sort | transform-tool-ordering.spec.ts | COMPLIANT |
| S6 tool ordering | single tool unaffected | transform-tool-ordering.spec.ts | COMPLIANT |
| S7 billing exclusion | no cache_control with slots available | transform-cache-breakpoints.spec.ts | COMPLIANT |
| S7 billing exclusion | holds when identity absent | transform-cache-breakpoints.spec.ts | COMPLIANT |
| S7 max-4 ceiling | four breakpoints, all slots active | transform-cache-breakpoints.spec.ts | COMPLIANT (planner positions only - see CRITICAL C1 for client-smuggled markers) |
| S7 max-4 ceiling | two breakpoints, identity off + no tools | transform-cache-breakpoints.spec.ts | COMPLIANT |
| S7 intermediate placement | second-to-last of 2 user messages | transform-cache-breakpoints.spec.ts | COMPLIANT |
| S7 intermediate placement | third of four user messages | transform-cache-breakpoints.spec.ts | COMPLIANT |
| S7 skip rule | single user message, no intermediate | transform-cache-breakpoints.spec.ts | COMPLIANT |
| S7 skip rule | zero user messages, no user breakpoints | transform-cache-breakpoints.spec.ts | COMPLIANT |
| S7 eviction priority | intermediate dropped when budget exhausted | transform-cache-breakpoints.spec.ts | PARTIAL - scenario GIVEN is unreachable (see W1); test substitutes single-user fixture (skip rule, not eviction) |
| S7 eviction priority | intermediate placed when one slot remains (total 4) | transform-cache-control.spec.ts (Budget Ceiling, updated 3 to 4) | COMPLIANT |

**Compliance summary**: 19/20 scenarios compliant, 1 partial.

### Correctness (Static + Runtime Evidence)

| Requirement | Status | Notes |
|------------|--------|-------|
| S1 unified stop filter | Implemented | Single shared filter post-candidates; probe confirmed empty string and all-empty array omit; mixed array filters to non-empty |
| S6 sort before ToolMap + cache_control | Implemented | Sort precedes .map() (ToolMap build) and addCacheControlToLastTool; spread copy - probe + test confirm no input mutation; ToolMap forward AND reverse round-trip verified by probe |
| S7 billing-block invariant | Structural | Only 3 writers of cache_control in src: identity block (L513), planner (L830, messages only), last tool (L849). system[0] built without marker (L506-508); planner/stripper never receive system[] |
| S7 max-4 planner accounting | Gap | Planner-placed markers provably max 4 (budget = 4 - identity - tools, always >= 2; planner places max 2). BUT client markers nested in tool_result.content[] survive the strip - total 5 reachable (CRITICAL C1) |
| S7 planner after repairToolPairs | Implemented | Pipeline L558-565; independent probe with orphan-as-LAST-user confirms marker lands on surviving block (shipped test is non-discriminating - W2) |
| S7 client cache_control strip | Partial | Top-level messages content blocks stripped; nested tool_result.content blocks NOT stripped (C1). system[]/tools[] correctly untouched |

### Coherence (Design)

| Decision | Followed? | Notes |
|----------|-----------|-------|
| S1 unified post-filter | Yes | Exactly as designed |
| S6 pre-sort copy, code-unit comparator | Yes | No localeCompare, no in-place sort |
| S7 planner runs after repair (sanctioned reorder) | Yes | Not drift - design-sanctioned |
| S7 strip makes planner single authority (sanctioned strip) | Partially | The design's own cited threat path (toAnthropicContentBlocks pass-through) also feeds tool_result.content nesting, which the strip misses |
| S7 eviction priority structural (budget >= 2 guard) | Yes | Guard present; unreachable via public API (W1) |

### TDD Compliance

| Check | Result | Details |
|-------|--------|---------|
| TDD Evidence reported | WARN | apply-progress has no canonical "TDD Cycle Evidence" table (W3); equivalent evidence in tasks.md RED/GREEN/REFACTOR structure, all checked |
| All tasks have tests | PASS | 3 behavior WUs map to 4 test files touched/created |
| RED confirmed (tests exist) | PASS | All 4 test files exist with the claimed cases |
| GREEN confirmed (tests pass) | PASS | 368/368 pass at runtime |
| Triangulation adequate | PASS | S1: 7 cases; S6: 6 cases; S7: 11 + 1 updated - multiple distinct expected values per behavior |
| Safety Net for modified files | PASS | Pre-existing stop/cache-control suites retained and passing |

**TDD Compliance**: 5/6 checks passed (evidence-format warning).

### Test Layer Distribution

| Layer | Tests | Files | Tools |
|-------|-------|-------|-------|
| Unit | 26 (new/modified for this change) | 4 | bun test |
| Integration | 0 | 0 | n/a (transform-only change per design) |
| E2E | 0 | 0 | n/a |

### Assertion Quality

| File | Line | Assertion | Issue | Severity |
|------|------|-----------|-------|----------|
| transform-cache-breakpoints.spec.ts | 335 | conditional expect inside if (firstBlock.cache_control) | Soft assertion - silently weakens if planner behavior changes; precondition currently holds so the path IS exercised | WARNING (folded into W2) |
| transform-cache-breakpoints.spec.ts | 348-382 | post-repair test | Non-discriminating fixture: passes under pre-change pipeline too (orphan precedes last user) | WARNING (W2) |
| transform-cache-breakpoints.spec.ts | 243-295 | budget-exhaustion test | 30-line comment essay concluding the spec scenario is unreachable, then testing a different mechanism | WARNING (W1) |

No tautologies, ghost loops, or assertion-free tests found. All other assertions verify real behavior with distinct expected values.

### Quality Metrics

**Linter**: not configured for this project.
**Type Checker**: bun run tsc --noEmit exits 2 - 7 pre-existing errors in __tests__/transform-streaming-abort-signal.spec.ts (verified identical at base 33d2dd5; none in changed files).

### Drift Check

All diff hunks in fba3e74, c7a5688, 02582cf trace to spec/design/tasks. The two intentional behavior changes (pipeline reorder; client cache_control strip) are design-sanctioned - NOT drift. No unsanctioned changes found.

### Issues Found

**CRITICAL**:

- **C1 - Nested client cache_control bypasses the strip; max-4 invariant falsifiable.** A tool-role message with array content carrying cache_control on a block flows through the toAnthropicContentBlocks pass-through into tool_result.content[]. stripClientCacheControl (src/transform/openai-to-anthropic.ts L776-784) walks only TOP-LEVEL messages content blocks, so the nested marker survives. Runtime probe: identity ON + tools + smuggled nested marker produced FIVE cache_control markers in the upstream body and forwarded the client's ttl 5m marker verbatim. This contradicts the cache-strategy max-4 requirement's intent and the design's explicit "planner becomes the single authority" claim (the design cites this exact pass-through as the threat). The Anthropic wire format accepts cache_control on nested tool_result content blocks, so this risks upstream 400 (maximum of 4 cache_control blocks) on affected requests. Not a regression (pre-change had no strip at all), but the change's core safety claim is incomplete. Fix: in stripClientCacheControl, recurse into block.content when it is an array (tool_result nesting). Blocks WU4-T3 (push).

**WARNING**:

- **W1 - Eviction-priority spec scenario unreachable as written.** The scenario requires the planner to see budget < 2 with 2+ user messages, but budget = 4 - identity - tools is always >= 2. The covering test substitutes a 1-user fixture, which exercises the SKIP rule, not eviction priority. The budget >= 2 guard exists structurally but no test (and no reachable input) can exercise it. Amend the spec scenario (or make the planner unit-testable) before archive.
- **W2 - Weak S7 tests.** The post-repair test fixture is non-discriminating (passes under the old pipeline; a discriminating fixture puts the orphan tool_result LAST - probe confirms correct behavior there) and the strip test uses a conditional assertion. Behavior verified correct by independent probes; the suite would not catch a future pipeline-order regression.
- **W3 - Strict TDD evidence not in canonical table format.** apply-progress lacks the "TDD Cycle Evidence" table required by the strict-TDD protocol. Substance is otherwise satisfied (tasks.md encodes RED-GREEN-REFACTOR per WU, all checked; tests exist and pass), but RED-first cannot be verified retroactively since each WU commit bundles test + implementation.
- **W4 - WU4-T2 checked [x] but the literal gate fails.** bun run tsc --noEmit exits non-zero due to 7 pre-existing errors in transform-streaming-abort-signal.spec.ts (verified present at base 33d2dd5). The task says "Zero type errors permitted"; apply-progress softened it to "zero NEW type errors". No new errors from this change, but the checked task does not match the actual gate result.

**SUGGESTION**:

- **S-1 - Marker aliasing**: applyCacheBreakpoints assigns the SAME marker object reference to both placements (probe confirmed identity equality). Use a fresh object per placement to avoid latent shared-mutation hazards.
- **S-2 - Strengthen byte-identical assertion**: assert JSON.stringify(toolsA) === JSON.stringify(toolsB) in the arrival-order test to match the spec's "byte-identical" wording (probe confirms it holds today).
- **S-3 - Input mutation inconsistency**: stripClientCacheControl deletes keys on client-supplied block objects in place - the same hazard the S6 design rejected for tools (logging/echo paths may inspect). Pre-existing pattern for messages; consider cloning at the boundary in a future change.
- **S-4 - SDD artifacts untracked**: openspec/changes/post-parity-improvements/ is not committed; commit it at archive time (matches prior-change convention).

### Verdict

**FAIL** - one CRITICAL (C1: nested client cache_control survives the strip; max-4 invariant falsifiable with a reachable input). Push (WU4-T3) is blocked until C1 is remediated within WU3 scope and verify is re-run. Everything else is in good shape: 368/368 tests pass, 19/20 scenarios compliant, no drift, billing-block invariant structurally sound.

---

## Re-verification Report (after remediation commit beb9fd3)

**Date**: 2026-06-07
**Mode**: Strict TDD (re-verification, fresh-context adversarial)
**Commit reviewed**: beb9fd3 - fix(transform): strip nested client cache_control and harden breakpoint tests
**Tests**: 369 pass / 0 fail / 1026 expect() calls across 33 files (3.97s) - matches implementer claim (+1 from baseline 368).
**Type check**: same 7 pre-existing errors, all in `__tests__/transform-streaming-abort-signal.spec.ts`; zero new errors.

### Issue Resolution Matrix

| Issue | Prior Severity | Status | Evidence |
|-------|---------------|--------|----------|
| C1 nested cache_control bypasses strip | CRITICAL | **RESOLVED** | (a) `stripCacheControlFromBlocks` (src/transform/openai-to-anthropic.ts L777-790) recursively clones blocks and strips `cache_control` at any depth of `block.content`; (b) independent re-probe (identity ON + tools + smuggled nested ttl:5m marker): total = 4, no "5m" survives; (c) DEEPER variant (marker two levels down: tool_result wrapper block + inner text block, both marked): total = 4, no "5m" survives - recursion is genuine; (d) mutation test: with the recursion removed at beb9fd3, exactly the C1 regression test fails (11 pass / 1 fail) - the test has pinpoint killing power |
| W1 unreachable eviction scenario | WARNING | **RESOLVED** (new doc nit, see W-R1) | Spec reframed as structural invariant (`budget >= 2` guard); scenario renamed to skip-rule semantics; covering test matches reality. No unreachable runtime scenario remains |
| W2 soft assertion + non-discriminating fixture | WARNING | **RESOLVED** | Conditional `if (firstBlock.cache_control)` replaced with hard `expect(...).toEqual(EPHEMERAL_1H)` (spec L304). Orphan-LAST fixture empirically discriminating: same fixture run against base 33d2dd5 (planner-before-repair) yields marker LOST entirely (surviving user block has no marker, total = 0) - the new test (expects marker present + total = 1) fails under the pre-change order and passes under the current order |
| S-1 marker object aliasing | SUGGESTION | **RESOLVED** | Fresh `{ type: "ephemeral", ttl: "1h" }` per `placeOnLastBlock` call (L853); probe confirms the two user-message markers are distinct references |
| S-3 in-place mutation of client blocks | SUGGESTION | **RESOLVED** | Strip clones via spread before delete; probe confirms client-supplied user blocks, tool-content blocks, and the tools array all retain their original state after `openaiToAnthropic` returns |
| W3 batch-1 TDD evidence format | WARNING | RESIDUAL | Remediation batch DOES include a canonical TDD Cycle Evidence table (protocol followed this time, RED -> GREEN documented). Batch-1 evidence remains in tasks.md form only; RED-first for batch 1 stays retroactively unverifiable. Non-blocking |
| W4 WU4-T2 checked vs literal gate | WARNING | RESIDUAL | 7 pre-existing type errors unchanged (verified identical scope: all in transform-streaming-abort-signal.spec.ts); none in changed files. Task wording vs gate result mismatch stands as documented |
| S-2 byte-identical assertion | SUGGESTION | RESIDUAL | Not claimed by remediation. Independent probe re-confirms `JSON.stringify` equality across arrival orders holds today |
| S-4 SDD artifacts untracked | SUGGESTION | PARTIAL | `specs/cache-strategy/spec.md` now committed (beb9fd3). proposal/design/tasks/explore/state/verify-report/specs/transform-parity remain untracked - commit at archive time per convention |

### New Issues Found

**WARNING**:

- **W-R1 - Amended spec misstates the test mechanism.** `specs/cache-strategy/spec.md` (structural-invariant note, L97) claims "Unit tests for this requirement use the `budget` parameter directly rather than end-to-end invocation". False: `applyCacheBreakpoints` is module-private (not exported) and no test calls it directly - all covering tests are end-to-end through `openaiToAnthropic`. The requirement's two scenarios ARE covered by passing runtime tests (skip-rule total-3 test; budget>=2 total-4 tests), so this is a documentation inaccuracy only. Fix: one-line reword at archive time (e.g. "the guard is verified structurally and via end-to-end tests; no direct unit test exists because the helper is module-private").

### Regression Sweep

| Invariant | Result | Evidence |
|-----------|--------|----------|
| system[0] billing block never carries cache_control | HOLDS | Suite tests + independent probe (identity ON, tools, marker smuggling): system[0] clean in every probe |
| S1 stop mapping (string->array, empty filtered, omit rules) | HOLDS | Suite + probes: `"END"` -> `["END"]`; `""` omitted; `["b","","a"]` -> `["b","a"]` (order preserved) |
| S6 deterministic tool ordering + byte identity | HOLDS | Probe: two arrival orders of {zeta, alpha, mid} produce byte-identical tools[] (`JSON.stringify` equal), sorted by client name, last tool marked, client array unmutated |
| Max-4 ceiling under adversarial input | HOLDS | Probes A and B: 4 markers exactly, ceiling never exceeded |
| Full suite | GREEN | 369/369, zero fail |

### Task State

All 16 original tasks checked except WU4-T3 (push) - intentionally gated on this re-verify, now unblocked. All 4 remediation tasks (R1-R4) checked and verified against code reality.

### Re-verification Verdict

**PASS WITH WARNINGS** - 0 CRITICAL, 3 WARNING (new: W-R1 spec prose; residual: W3, W4), 2 SUGGESTION (residual S-2, partial S-4). C1 is conclusively resolved with recursion verified at depth and mutation-tested killing power. Push (WU4-T3) is UNBLOCKED. Recommend: push, then archive - fixing the W-R1 one-liner and committing the remaining SDD artifacts during archive.
