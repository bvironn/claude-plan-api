# Tasks — Revamp README.md

## Overview

Docs-only change. Five work units mapped 1:1 to the design's locked apply order. Each unit is one commit with a clear start, finish, verification, and rollback. No source code touched. Strict TDD does not apply (docs); verifier script provides the test surface.

Sequencing rule: sub-doc first (so README link target exists), orphan delete second (independent, tiny), README rewrite third (largest single edit), verifier fourth (so verify phase has tooling), local verifier run fifth (proves green before the verify phase).

## Work units

### Unit 1: Create `docs/adaptive-thinking.md` (relocate long essay)

- [x] **1.1** Create `docs/adaptive-thinking.md` per design outline (Title + intro + two contracts + why-adaptive + verification lesson + cross-links).
  - Files touched: `docs/adaptive-thinking.md` (new)
  - Acceptance: verify.ps1 check 10 (`docs/adaptive-thinking.md` exists, ≥ 25 lines). Preserves verbatim paragraphs 1–3 + "wire capture" line from current README §"About that plaintext reasoning".
  - Estimated changed lines: ~50
  - Dependencies: none
  - Commit hint: `docs: relocate adaptive-thinking essay to docs/adaptive-thinking.md`

### Unit 2: Delete orphan folder `openspec/changes/revamp-readme/`

- [x] **2.1** Pre-check folder is empty, then delete `openspec/changes/revamp-readme/` (NOT our `revamp-readme-md/`).
  - Files touched: `openspec/changes/revamp-readme/` (deleted)
  - Acceptance: verify.ps1 check 11 (orphan folder does not exist). Pre-check: `Get-ChildItem -LiteralPath "openspec/changes/revamp-readme" -Force` returns empty; abort if not.
  - Estimated changed lines: ~0 (empty folder; no tracked content)
  - Dependencies: none
  - Commit hint: `chore(openspec): remove empty orphan folder revamp-readme`

### Unit 3: Rewrite `README.md` in one pass

- [x] **3.1** Apply preserve/trim/rewrite from design; insert locked Quickstart (37 lines) and Configuration table verbatim; produce 13 top-level sections in locked order; hit 180–210 lines.
  - Files touched: `README.md` (rewrite)
  - Acceptance: verify.ps1 checks 1, 2, 3, 4, 5, 6, 7, 8, 9, 13 all pass. Single commit — partial README is high cognitive cost.
  - Estimated changed lines: ~410 (≈210 added + ≈200 removed; full rewrite of 251-line file)
  - Dependencies: Unit 1 (link target `docs/adaptive-thinking.md` must exist before §10 teaser links it)
  - Commit hint: `docs(readme): revamp README to locked 13-section structure`

### Unit 4: Create `openspec/changes/revamp-readme-md/verify.ps1`

- [x] **4.1** Author PowerShell-native verifier with all 13 checks from design (line count, heading order, anchors, route grep, env-var grep, badge regex, Quickstart length, adaptive-thinking section budget, single Disclaimer, sub-doc exists, orphan gone, out-of-scope diff guard, link targets present).
  - Files touched: `openspec/changes/revamp-readme-md/verify.ps1` (new)
  - Acceptance: script runs without syntax error (`powershell -NoProfile -File verify.ps1 -WhatIf` or direct exec); all 13 checks defined; exit code non-zero on any failure.
  - Estimated changed lines: ~120
  - Dependencies: none (script is self-contained; can be authored before or after README, but ordered fourth so verify phase has tooling ready)
  - Commit hint: `chore(openspec): add verify.ps1 for revamp-readme-md`

### Unit 5: Run verify.ps1 locally and prove green

- [x] **5.1** Execute `openspec/changes/revamp-readme-md/verify.ps1`; if any check fails, fix in the corresponding unit (NOT in this unit) and re-run. This unit ends green.
  - Files touched: none (run-only; fixes belong to their owning unit)
  - Acceptance: all 13 checks return PASS; exit code 0.
  - Estimated changed lines: 0
  - Dependencies: Units 1, 2, 3, 4
  - Commit hint: (no commit — verification step; sdd-verify phase will record evidence)

## Review Workload Forecast

- Estimated changed lines: 580
- Files touched: 4 (`docs/adaptive-thinking.md` new, `README.md` rewrite, `openspec/changes/revamp-readme-md/verify.ps1` new, `openspec/changes/revamp-readme/` deletion)
- Chained PRs recommended: No
- 400-line budget risk: Medium
- Decision needed before apply: No
- Reasoning: Design estimated 483 user-facing lines; my work-unit decomposition lands at ~580 because the README rewrite is a full-file replacement (≈210 added + ≈200 removed = ~410 churn) plus ~50 for the new sub-doc plus ~120 for verify.ps1. That exceeds the 400-line nominal budget but stays under the 600-line session review budget. Risk is Medium not High because (a) ~120 lines are a self-contained verifier script that reviews independently of doc voice, (b) the README is one coherent rewrite that splits worse than it ships whole — partial READMEs carry higher cognitive cost than a slightly larger PR, and (c) delivery_strategy is auto-forecast and the session budget is 600. No chaining decision needed.

Plain-text guard contract:

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: pending
400-line budget risk: Medium

## Verification mapping

| Spec req | Task(s) | verify.ps1 check |
| --- | --- | --- |
| S1 Section Structure (13 sections, no nav chip-row) | 3.1 | check 2 |
| S2 Title Block Content (3 badges, no live numeric, status stamp) | 3.1 | check 6 (numeric badge ban); manual review of badge count + stamp |
| S3 Configuration Accuracy (all `src/config.ts` env vars) | 3.1 | check 5 (bidirectional env-var grep) |
| S4 Endpoint/Script/Path Accuracy | 3.1 | check 4 (route grep vs `src/http/server.ts`) |
| S5 Quickstart Shape (≤ 40 lines, `curl GET /v1/models`, JSON shape) | 3.1 | check 7 |
| S6 Voice and Framing (one disclaimer, no marketing language) | 3.1 | check 9 (exactly 1 `## Disclaimer`); manual voice review |
| S7 Linking and Discoverability (5 link targets; adaptive-thinking body ≤ 6 lines + link) | 1.1, 3.1 | checks 8, 10, 13 |
| S8 Length and Anchor Preservation (170–220 lines, 5 anchors preserved) | 3.1 | checks 1, 3 |
| S9 Out-of-Scope Guard (no touches outside permitted paths; orphan deletion only) | 2.1, all | checks 11, 12 |

## Rollback plan

| Unit | Rollback command |
| --- | --- |
| 1.1 | `git restore --source=HEAD --staged --worktree -- docs/adaptive-thinking.md && git clean -f docs/adaptive-thinking.md` (or `git revert <unit-1-commit>` if already committed) |
| 2.1 | `git checkout HEAD~1 -- openspec/changes/revamp-readme/` (restores from prior commit) or `git revert <unit-2-commit>` |
| 3.1 | `git checkout HEAD -- README.md` (pre-commit) or `git revert <unit-3-commit>` (post-commit) |
| 4.1 | `git restore --source=HEAD --staged --worktree -- openspec/changes/revamp-readme-md/verify.ps1 && git clean -f openspec/changes/revamp-readme-md/verify.ps1` or `git revert <unit-4-commit>` |
| 5.1 | No rollback — run-only. |

Full-change rollback: `git revert <unit-3-commit> <unit-2-commit> <unit-1-commit> <unit-4-commit>` (reverse order); units are independent enough that partial rollback is safe.

## Out-of-scope guard

These files MUST NOT be touched. verify.ps1 check 12 enforces via `git diff --name-only HEAD`:

- `CLAUDE.md`
- `OBSERVABILITY.md`
- `src/ui/README.md`
- Anything under `src/` (including `src/config.ts`, `src/http/**`, `src/transform/**`)
- `package.json`, `bun.lock`, `tsconfig.json`
- Anything under `openspec/specs/` (the deployed specs, not change deltas)
- Any sub-README other than the root

Permitted paths only:
- `README.md`
- `docs/adaptive-thinking.md`
- `openspec/changes/revamp-readme-md/**`
- Deletion of `openspec/changes/revamp-readme/` (orphan, empty)
