# Apply progress - Revamp README.md

Mode: Standard (docs-only; strict-TDD does not apply - verifier script is the test surface)
Artifact store: both (Engram + openspec)
Status: COMPLETE - all 5 work units done, verify.ps1 green.

## Work units

- [x] **1.1** Create `docs/adaptive-thinking.md` (45 lines, >= 25 required)
  - Commit: `831b42f docs: relocate adaptive-thinking essay to docs/adaptive-thinking.md`
- [x] **2.1** Delete orphan folder `openspec/changes/revamp-readme/`
  - No commit produced: the folder was never tracked by git (untracked stray directory on disk). Verified with `git ls-files openspec/changes/revamp-readme/` (empty) and `git log --all --diff-filter=A --name-only` (no history). Removal achieves the desired state (`Test-Path` returns `False`) without an empty commit. Verifier check 11 confirms.
- [x] **3.1** Rewrite `README.md` to locked 13-section structure
  - Commit: `909a6e1 docs(readme): revamp README to locked 13-section structure`
  - Final README length: 220 lines (top of the 170-220 range)
  - 12 H2 headings in locked order; Title block is H1 + badges + status stamp
  - Tradeoff: removed the small ASCII title diagram (lines 3-11 of original) to land at 220 lines. Diagram was not on the design's preserve-verbatim list; architecture diagram (the larger, structural one) is preserved. Recorded as a risk for verify phase to confirm acceptable.
- [x] **4.1** Create `openspec/changes/revamp-readme-md/verify.ps1`
  - Commit: `d6bae70 chore(openspec): add verify.ps1 for revamp-readme-md`
  - ASCII-only (no em-dashes) so PowerShell 5.1 parses it without a UTF-8 BOM
  - Uses `@(...)` casts on `Where-Object` results to keep `.Count` strict-mode safe
- [x] **5.1** Run verify.ps1 locally
  - All 13 checks PASS, exit 0
  - No fix commits required

## verify.ps1 output

```
===== Revamp README.md - verify.ps1 =====
  [PASS]  1. README line count in [170, 220] - lines=220
  [PASS]  2. 12 ## headings present in locked order - found=12 expected=12
  [PASS]  3. Required anchor headings present - missing=[]
  [PASS]  4. Every README endpoint resolves in src/http/server.ts - unresolved=[]
  [PASS]  5. Env vars match bidirectionally README <-> src/config.ts - readme_only=[] config_only=[]
  [PASS]  6. No live numeric badges (tests/coverage/builds-NN)
  [PASS]  7. Quickstart section length <= 40 lines - length=15
  [PASS]  8. Adaptive thinking body <= 6 lines and links to sub-doc - body=6 linked=True
  [PASS]  9. Exactly one '## Disclaimer' heading - count=1
  [PASS] 10. docs/adaptive-thinking.md exists and >= 25 lines - exists=True lines=45
  [PASS] 11. Orphan folder openspec/changes/revamp-readme/ does not exist - exists=False
  [PASS] 12. Out-of-scope guard (git diff) - disallowed=[]
  [PASS] 13. Required link targets present in README - missing=[]

Summary: 13 passed, 0 failed (of 13)
```

## Commits produced (in order)

1. `831b42f docs: relocate adaptive-thinking essay to docs/adaptive-thinking.md`
2. `909a6e1 docs(readme): revamp README to locked 13-section structure`
3. `d6bae70 chore(openspec): add verify.ps1 for revamp-readme-md`

(Units 2 and 5 produced no commits, per their work-unit definitions.)

## Files touched

| File | Action |
| --- | --- |
| `docs/adaptive-thinking.md` | create (45 lines) |
| `README.md` | modify (220 lines; +45 / -78 from previous) |
| `openspec/changes/revamp-readme-md/verify.ps1` | create (274 lines) |
| `openspec/changes/revamp-readme/` | delete (untracked stray folder; no git history) |

## Notes / risks for verify phase

- Title-block ASCII diagram removed to satisfy line cap. Verifier check 6 / 7 / 8 / 1 all pass; design did not list it as preserve. If the verify phase considers it essential, it can be reintroduced and other content trimmed to compensate.
- SDD artifacts (proposal.md, exploration.md, spec.md, design.md, tasks.md, apply-progress.md) remain untracked on the filesystem in `openspec/changes/revamp-readme-md/`. Per the task contract apply phase only commits the 5 work units; SDD artifact commit follows prior project convention (see commit `c78ca51`) and is handled by sdd-archive or the orchestrator at archive time.
- verifier check 12 inspects `git diff --name-only HEAD` (tracked-file changes only). After all 5 work units it returns an empty list - guard PASSES.

## Pre-checks (PASSED)

- Orphan folder `openspec/changes/revamp-readme/` confirmed empty before deletion
- `docs/audit-2026-04-17.md` exists (linked from README)
- `src/config.ts` env vars match design: `PORT`, `BIND_HOST`, `CREDENTIALS_PATH`, `ANTHROPIC_CLI_VERSION` (binds to const `VERSION`), `MAX_RETRY_AFTER_MS`
- All README API-table endpoints resolve to handlers in `src/http/server.ts`
