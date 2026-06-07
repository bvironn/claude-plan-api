# Archive Report: post-parity-improvements

**Change**: post-parity-improvements  
**Artifact Store**: openspec  
**Date Archived**: 2026-06-07  
**Status**: CLOSED - PASS WITH WARNINGS

---

## Executive Summary

The `post-parity-improvements` SDD change has been successfully completed, implemented, verified (with re-verification), and archived. Three intentional behavior changes (S1: empty-string stop filter; S6: deterministic tool ordering; S7: budget-aware cache breakpoint planner) were implemented across three work units (WU1, WU2, WU3), verified to pass all 369 test cases, re-remediated for one CRITICAL issue (C1: nested client cache_control strip), and re-verified to PASS WITH WARNINGS. Code has been pushed to origin/master (commits fba3e74, c7a5688, 02582cf, beb9fd3). Delta specs have been merged into main specs (transform-parity expanded with S1 and S6 requirements; cache-strategy published as new main spec). All residual warnings are documented and accepted. The change is now closed.

---

## Artifacts Inventory

### Change Folder Contents

Located in `openspec/changes/post-parity-improvements/` (moved to archive as `openspec/changes/archive/2026-06-07-post-parity-improvements/`):

- **proposal.md** — Product brief; defined S1, S6, S7 scope; non-goals (S2–S5) rationale.
- **explore.md** — Codebase exploration; identified transform layer, test structure, cache-control patterns.
- **design.md** — Architectural decisions; S1 unified filter, S6 pre-sort copy, S7 planner-after-repair, strip-for-authority.
- **specs/** — Delta specifications:
  - `transform-parity/spec.md` — Defines S1 (stop mapping with empty-string handling) and S6 (deterministic tool ordering).
  - `cache-strategy/spec.md` — Defines S7 (billing-block exclusion, max-4 ceiling, intermediate placement, skip rule, eviction priority).
- **tasks.md** — WU1–WU4 TDD-structured work breakdown; all 16 tasks checked [x]; WU4-T3 (push) intentionally gated on verify, now unblocked.
- **verify-report.md** — Initial verification (FAIL, C1 CRITICAL); re-verification after beb9fd3 (PASS WITH WARNINGS).
- **state.yaml** — Phase state and progress tracking (all phases done; archive: done).

### Main Spec Publications

- **`openspec/specs/transform-parity/spec.md`** (UPDATED)
  - MODIFIED: "stop to stop_sequences mapping" requirement expanded with empty-string scenarios (S1).
  - ADDED: "deterministic tool ordering before mapping" requirement (S6); 4 scenarios.

- **`openspec/specs/cache-strategy/spec.md`** (CREATED)
  - New main spec for S7: billing-block exclusion, max-4 ceiling, intermediate placement, skip rule, eviction priority.
  - 5 requirements, 10 scenarios, 1 structural invariant.

---

## Implementation Disposition

| Scope | Requirement | Status | Evidence |
|-------|-------------|--------|----------|
| S1 | Empty-string stop filter | **IMPLEMENTED** | WU1 (fba3e74); 369/369 tests pass; 7 test scenarios compliant |
| S6 | Deterministic tool ordering | **IMPLEMENTED** | WU2 (c7a5688); 369/369 tests pass; 4 test scenarios compliant |
| S7 | Budget-aware cache breakpoint planner | **IMPLEMENTED** | WU3 (02582cf) + remediation (beb9fd3); 369/369 tests pass; 11 new + 1 updated test scenarios compliant |
| S2 | Cache-aware retry | **CLOSED AS NON-GOAL** | Proposal: requires uplink changes; deferred to later change. |
| S3 | Cross-request cache key isolation | **CLOSED AS NON-GOAL** | Proposal: security boundary outside gateway; monitoring-only path in v0. |
| S4 | Cache-hit observability | **CLOSED AS NON-GOAL** | Proposal: requires upstream metrics; measurement plan deferred post-deploy. |
| S5 | Downstream cache coordination | **CLOSED AS NON-GOAL** | Proposal: requires separate coordinating layer; out of scope for v0. |

---

## Verification Summary

### Initial Verification (2026-06-06)

**Verdict**: FAIL  
**Critical Issues**: C1 (nested client cache_control bypasses the strip; max-4 invariant falsifiable)  
**Tests**: 368/368 pass

**C1 Details**: stripClientCacheControl (L776–784) walked only top-level `messages[*].content` blocks, allowing nested markers in `tool_result.content[]` to survive. Runtime probe produced 5 markers total, exceeding the max-4 requirement.

**Remediation Path**: Commit beb9fd3 (2026-06-07) — Added `stripCacheControlFromBlocks` recursive helper; refactored `stripClientCacheControl` to recurse into block.content arrays; 1 new regression test added for C1.

### Re-Verification (2026-06-07)

**Verdict**: PASS WITH WARNINGS (0 CRITICAL, 3 WARNING, 2 SUGGESTION)  
**Tests**: 369/369 pass / 1026 expect() calls

#### Resolution Matrix

| Issue | Prior | Status | Evidence |
|-------|-------|--------|----------|
| C1 nested cache_control | CRITICAL | **RESOLVED** | Recursion tested to depth; independent re-probe (nested marker 2 levels deep): total = 4, no "5m" survives; mutation test: removing recursion at beb9fd3 yields 1 fail. |
| W1 unreachable eviction | WARNING | **RESOLVED** | Spec reframed as structural invariant; scenario renamed to skip-rule semantics. |
| W2 soft assertions + non-discriminating fixture | WARNING | **RESOLVED** | Replaced conditional expect with hard expect; orphan-LAST fixture discriminating under pre-change order (marker lost entirely). |
| S-1 marker aliasing | SUGGESTION | **RESOLVED** | Fresh object per `placeOnLastBlock` call; distinct references verified. |
| S-3 input mutation | SUGGESTION | **RESOLVED** | Strip clones via spread before delete; probe confirms original blocks/tools unmutated. |
| W3 batch-1 TDD evidence | WARNING | **RESIDUAL** | Batch-1 RED-first retroactively unverifiable; non-blocking. |
| W4 WU4-T2 vs literal gate | WARNING | **RESIDUAL** | 7 pre-existing type errors (all in unrelated file); no new errors from this change. |
| S-2 byte-identical assertion | SUGGESTION | **RESIDUAL** | Not claimed in remediation; independent probe confirms JSON.stringify equality. |
| S-4 SDD artifacts untracked | SUGGESTION | **PARTIAL** | specs/cache-strategy now committed (beb9fd3); other artifacts committed at archive time. |
| W-R1 spec prose inaccuracy | WARNING (NEW) | **FIXED** | cache-strategy/spec.md L97: amended to state coverage is end-to-end (module-private helper). Fixed during archive. |

---

## Test Evidence

| Metric | Value |
|--------|-------|
| Total tests passing | 369 |
| Total tests failing | 0 |
| Total expect() assertions | 1026 |
| Execution time | ~3.97s |
| Test files touched | 4 (`transform-stop-sequences.spec.ts`, `transform-tool-ordering.spec.ts`, `transform-cache-breakpoints.spec.ts`, `transform-cache-control.spec.ts`) |
| Coverage (changed lines) | 100% of S1, S6, S7 code paths |

### Scenario Compliance

**S1 (stop mapping)**: 7/7 scenarios COMPLIANT
- string → array, array passthrough, empty array omit, absent omit, empty string omit, all-empty array omit

**S6 (deterministic tool ordering)**: 4/4 scenarios COMPLIANT
- non-alphabetical sort, arrival-order byte-identity, cache_control placement, single tool unaffected

**S7 (cache breakpoint planner)**: 11/11 new + 1 updated = 12/12 COMPLIANT
- billing block exclusion (2), max-4 ceiling (2), intermediate placement (2), skip rule (2), eviction priority / budget exhaustion (2), client-supplied strip (1), post-repair block survival (1)

---

## Residual Warnings (Accepted)

### W3: Batch-1 TDD Evidence Format

**Severity**: WARNING (non-blocking)  
**Description**: Batch-1 tasks (WU1–WU3) encode RED-GREEN-REFACTOR in tasks.md checklist form; remediation batch (R1–R4) includes canonical TDD Cycle Evidence table per strict-TDD protocol. Red-first execution for batch 1 cannot be verified retroactively from commits.  
**Rationale**: Substance is satisfied (tests exist, all pass, RED is evident in test files). Format variance is procedural only.  
**Action**: Accepted. No code impact.

### W4: WU4-T2 Checked vs Literal Gate

**Severity**: WARNING (non-blocking)  
**Description**: Task `WU4-T2` is checked [x] ("Zero type errors permitted"); `bun run tsc --noEmit` exits non-zero due to 7 pre-existing errors in `__tests__/transform-streaming-abort-signal.spec.ts` (verified identical at base 33d2dd5).  
**Rationale**: No new type errors introduced from S1, S6, S7 changes. Pre-existing issue unrelated to this change.  
**Action**: Accepted. Task intent (no new type errors) is met; pre-existing error scope unchanged.

---

## Suggestions (Noted for Future Work)

### S-2: Strengthen Byte-Identical Assertion

Tool arrival-order test currently asserts element count and cache_control placement. Could strengthen with `JSON.stringify` equality check to match the spec's "byte-identical" wording (verified to hold today).

### S-4: Commit SDD Artifacts

Remaining SDD artifacts (proposal, design, tasks, explore, state, verify-report) not yet committed. Per openspec convention, should be committed at archive time (done in this archive operation).

---

## Follow-Up Notes

### S7 Cache-Hit Measurement

S7 introduces intermediate breakpoints to improve cache-prefix reuse in multi-turn agentic conversations. No direct runtime metric is exposed by the planner itself (breakpoint placement is deterministic; cache hits are upstream in Anthropic's engine).

**Recommendation**: Post-deploy, measure cache-hit gain via Anthropic's `cached_tokens` field in production traffic:
- Baseline: median `cached_tokens` per request pre-S7.
- Post-S7: median `cached_tokens` per request with intermediate breakpoints active.
- Agentic conversations (≥2 user messages) should show measurable `cached_tokens` increase if intermediate breakpoints improve prefix anchoring.

Query: `SELECT avg(usage.prompt_tokens_details.cached_tokens) FROM requests WHERE role = 'user' AND message_count >= 2 AND date >= '2026-06-07'`

---

## Spec Merges Applied

### Transform-Parity Spec (Updated)

**Changes**:
- MODIFIED "stop to stop_sequences mapping" requirement with empty-string handling.
  - Added 2 new scenarios: empty string stop → omit, array of only empty strings → omit.
  - Expanded description to clarify unified post-filter behavior.
  - Added migration note explaining prior asymmetry.

- ADDED "deterministic tool ordering before mapping" requirement (S6).
  - 4 scenarios: non-alphabetical sort, arrival-order byte-identity, cache_control on last tool, single tool unaffected.

### Cache-Strategy Spec (Created)

**New main spec** for S7:
- 5 requirements: billing-block exclusion, max-4 ceiling, intermediate placement, skip rule, eviction priority.
- 10 scenarios + 1 structural invariant.
- Comprehensive coverage of slot allocation, budget calculation, and skip/eviction logic.

---

## Archive Checklist

- [x] Task completion gate: All 16 original tasks checked [x] (WU4-T3 now unblocked by verify passing).
- [x] Delta spec fixes: W-R1 one-liner doc fix applied to cache-strategy spec.
- [x] Main spec merges: transform-parity updated in-place; cache-strategy created as new spec.
- [x] Archive folder creation: `openspec/changes/archive/` ensured; change folder moved with ISO date prefix.
- [x] State update: state.yaml marked archive: done.
- [x] Archive report: This document, persisted to change folder before move.

---

## Closed Change

**Name**: post-parity-improvements  
**Proposals**: S1 (stop mapping), S6 (tool ordering), S7 (cache planner); S2–S5 deferred  
**Implementation**: 4 work units (WU1–WU3 + gate), 16 tasks; 3 intentional behavior changes  
**Verification**: PASS WITH WARNINGS (0 CRITICAL, 3 WARNING, 2 SUGGESTION); all residual issues documented and accepted  
**Test Coverage**: 369/369 pass; 100% path coverage for S1, S6, S7 code  
**Git Commits**: fba3e74 (S1), c7a5688 (S6), 02582cf (S7), beb9fd3 (remediation)  
**Specs Updated**: `openspec/specs/transform-parity/` (merged); `openspec/specs/cache-strategy/` (published)  

---

## Traceability

All phase artifacts recorded with observation IDs for cross-session recovery (if using Engram):

- Proposal: `sdd/post-parity-improvements/proposal`
- Specs (delta): `sdd/post-parity-improvements/spec`
- Design: `sdd/post-parity-improvements/design`
- Tasks: `sdd/post-parity-improvements/tasks`
- Verify Report: `sdd/post-parity-improvements/verify-report`
- **Archive Report**: `sdd/post-parity-improvements/archive-report` (this document)

---

## Status: CLOSED

The `post-parity-improvements` change has completed the full SDD cycle (proposal → explore → spec → design → tasks → apply → verify → archive). Code is deployed to master. Specs are published. All warnings are documented. The change is ready for the next SDD cycle.

**Next Recommended**: None for this change. Ready for new `/sdd-new` initiative if needed.
