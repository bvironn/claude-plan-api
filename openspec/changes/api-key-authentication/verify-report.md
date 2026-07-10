## Verification Report — Unit 1 / PR 1 ("Foundation")

**Change**: api-key-authentication
**Unit**: 1 of 4 ("Foundation" — Config, Types, Storage). Delivery: auto-chain, stacked-to-main. NOT yet committed/pushed (working tree only).
**Version**: specs/api-key-usage (Per-Request Key Attribution, Aggregated Usage Query — storage layer); specs/api-key-auth (API Key Model and Storage — storage layer only)
**Mode**: Strict TDD (runner: `bun test`)
**Also serves as**: fresh-context orchestrator gatekeeper review of Batch-1 apply (Engram `sdd/api-key-authentication/apply-progress`, obs #824). Adversarial — every claim below was independently re-derived from source and command output, not taken on trust.

### Completeness

| Metric | Value |
|--------|-------|
| Tasks total (whole change, verified by direct count) | **19** (apply-progress claims 22 — wrong, see Issues W1) |
| Tasks total (this unit, Phase 1) | 6 |
| Tasks complete (Phase 1) | 6/6 |
| Tasks complete (whole change so far) | 6/19 |
| Tasks incomplete | 13 (Phase 2: 4, Phase 3: 6, Phase 4: 3) |

### Build & Tests Execution

**Build**: ✅ Passed (schema/type additions compile as part of `tsc`, see below)

**Tests**: ✅ 385 pass / 0 fail / 1065 expect() calls across 35 files (~3.7s)
```text
$ bun test
385 pass
0 fail
1065 expect() calls
Ran 385 tests across 35 files. [3.67s]
```
Ran independently twice (once pre-stash-test, once post-restore) — identical counts both times. Matches the apply's claim exactly. New tests: `__tests__/config-api-key.spec.ts` (7, confirmed by direct `it()` count) + `__tests__/api-key-storage.spec.ts` (9, confirmed by direct `it()` count) = 16 new, 369 pre-batch → 385 post-batch.

**Type check**: ❌ exits 2 — 7 errors, **all pre-existing, all in `__tests__/transform-streaming-abort-signal.spec.ts`**, a file this batch never touches.
```text
$ bun run tsc --noEmit
__tests__/transform-streaming-abort-signal.spec.ts(40,34): error TS2304: Cannot find name 'ReadableStreamReadResult'.
__tests__/transform-streaming-abort-signal.spec.ts(60,80): error TS2345: ... ToolMap ...
__tests__/transform-streaming-abort-signal.spec.ts(63,37): error TS2345: ... readMany ...
__tests__/transform-streaming-abort-signal.spec.ts(71,80): error TS2345: ... ToolMap ...
__tests__/transform-streaming-abort-signal.spec.ts(77,37): error TS2345: ... readMany ...
__tests__/transform-streaming-abort-signal.spec.ts(83,80): error TS2345: ... ToolMap ...
__tests__/transform-streaming-abort-signal.spec.ts(86,37): error TS2345: ... readMany ...
```
Proven pre-existing two ways, not just asserted: (1) the file is absent from `git status` — byte-identical to HEAD; (2) `git stash push` of the 4 tracked modified files, plus temporarily relocating the 2 new untracked test files out of `__tests__/`, reproduced these **exact same 7 errors on the exact same lines** against the true pre-batch baseline. Restored cleanly afterward (`git stash pop`; `bun test` re-confirmed 385/0/1065 post-restore). **Zero new type errors** from `src/config.ts`, `src/observability/storage.ts`, `src/observability/types.ts`, or the two new test files.

**Coverage**: ➖→✅ Threshold 0% (`openspec/config.yaml` `verify.coverage_threshold: 0`, informational only). `bun test --coverage` **does work** (Bun 1.3.13) — see Discoveries; cached capabilities incorrectly claim it's unavailable.
- `src/config.ts`: 100% funcs / 100% lines
- `src/observability/storage.ts`: 69.23% funcs / 57.44% lines file-wide, but **every line this batch touched is covered** — all reported uncovered ranges (218-228, 232-235, 239-257, 261-269, 273-280, 335-342, 434-477) fall inside pre-existing, untouched functions (`buildEventWhere`, `countEvents`, `rowToEvent`, `queryEvents`, `queryEventsRaw`, `queryRequestsRaw`, `getMetrics`). `insertApiKey`, `getApiKeyByHash`, `getUsageByApiKey`, the `api_keys` DDL, and `insertRequest`'s new `api_key_id` param are all exercised.
- `src/observability/types.ts`: N/A — type-only file, no executable lines.

### Spec Compliance Matrix

Phase 1 implements the **storage layer** underneath two specs. Full end-to-end compliance for auth-flow requirements needs Phase 2 (guard) + Phase 3 (wiring) — correctly not attempted here.

| Requirement | Scenario | Test | Result |
|-------------|----------|------|--------|
| api-key-usage: Aggregated Usage Query | Correct totals for a date range | `api-key-storage.spec.ts > aggregates per-key request counts and token sums bounded to the window` + `> bounds results to a different window` | ✅ COMPLIANT |
| api-key-usage: Aggregated Usage Query | No matching key returns empty, not error | `api-key-storage.spec.ts > returns an empty array (not an error) when no rows match the window` | ✅ COMPLIANT |
| api-key-usage: Per-Request Key Attribution | Request row is attributed to its key | `api-key-storage.spec.ts > insertRequest persists a provided api_key_id` / `> ... leaves api_key_id NULL when omitted` | ⚠️ PARTIAL — storage mechanism proven; the "authenticated request from a known key" half needs Phase 2 guard + Phase 3 wiring |
| api-key-usage: Usage Telemetry Route | Usage route returns aggregated totals | none | ➖ N/A — Phase 3 scope (`telemetry/usage.ts`, task 3.4) |
| api-key-auth: API Key Model and Storage | Persisted key row stores only the hash | `api-key-storage.spec.ts > insertApiKey persists a row...` + `> getApiKeyByHash returns the active key row...` + `> ... ignores revoked keys...` | ⚠️ PARTIAL — schema + active/revoked semantics fully proven; `ApiKeyRecord` has no plaintext-secret field (structurally impossible to leak one here); "newly issued via CLI" flow is Phase 3 |
| api-key-auth: Key Generation and Issuance | CLI issues a working key shown once | none | ➖ N/A — Phase 3 scope |
| api-key-auth: Fast Hash Validation | Valid key authenticates a gated request | none | ➖ N/A — Phase 2 scope (`hashKey()`) |
| api-key-auth: Credential Extraction from Headers | Either header supplies the key | none | ➖ N/A — Phase 2 scope |
| api-key-auth: 401 Enforcement Gate | (3 scenarios) | none | ➖ N/A — Phase 2/3 scope |
| api-key-auth: Exempt Routes | Exempt routes never require a key | none | ➖ N/A — Phase 2/3 scope |
| project-readme | (all) | none | ➖ N/A — Phase 4 scope |

**Compliance summary**: 2/2 scenarios whose full scope is achievable at Phase 1 are COMPLIANT. 2 requirements are PARTIAL (storage half proven, auth-flow half correctly deferred). 0 FAILING, 0 UNTESTED for anything Phase 1 actually claims to deliver.

### Correctness (Static Evidence)

| Requirement | Status | Notes |
|------------|--------|-------|
| `isApiKeyRequired()` / `getApiKeyPepper()` (call-time env) | ✅ Implemented | Byte-matches design decision #6; sits next to `isClaudeCodeIdentityEnabled()`, same call-time-read pattern |
| `RequestRecord.api_key_id?`, `ApiKeyRecord`, `UsageByKey` | ✅ Implemented | All 3 types present, fields match design's Schema/Interfaces sections |
| `api_keys` table + `requests.api_key_id` column | ✅ Implemented | Byte-for-byte identical SQL to design.md (see Coherence) |
| `insertApiKey()`, `getApiKeyByHash()`, `getUsageByApiKey()` | ✅ Implemented | Signatures + query semantics match design's Interfaces/Contracts exactly |
| `insertRequest(api_key_id)` | ✅ Implemented | Optional param threaded through prepared statement + bind list |
| `initStorage(dbPath?)` | ✅ Implemented (early) | Storage half of design decision #8 delivered now, not Phase 3 — disclosed deviation, justified by task 1.6 needing `:memory:` |

### Coherence (Design)

| Decision | Followed? | Notes |
|----------|-----------|-------|
| #3 Hashing: HMAC-SHA256(pepper, full) hex, unique-indexed | N/A this unit | `key_hash TEXT NOT NULL UNIQUE` exists (unique-indexed ✅); `hashKey()` itself is Phase 2 |
| #6 Config access: call-time env | ✅ Yes | Confirmed by reading source — reads `Bun.env` inside the function body, not at module load |
| #7 Schema: normalized `api_keys` + advisory `requests.api_key_id` | ✅ Yes | No `PRAGMA foreign_keys=ON` anywhere in storage.ts; `api_key_id` is a plain nullable `INTEGER`, app-enforced only |
| #8 Testability: optional `initStorage(dbPath?)` | ✅ Yes (storage half) | `handleRequest` extraction (other half) correctly deferred to Phase 3 |
| Schema SQL block | ✅ Yes | Line-for-line identical: columns, index names, `ensureColumn` pattern, index-after-`ensureColumn` ordering |

### TDD Compliance

| Check | Result | Details |
|-------|--------|---------|
| TDD Evidence reported | ✅ | Canonical "TDD Cycle Evidence" table present in apply-progress #824 |
| All tasks have tests | ✅ | 6/6 Phase-1 tasks map to a test file (1.1→config-api-key.spec.ts; 1.2→compile-time via tsc; 1.3-1.6→api-key-storage.spec.ts) |
| RED confirmed (tests exist) | ✅ | Both test files verified to exist on disk with the exact claimed test counts (7 + 9) |
| GREEN confirmed (tests pass) | ✅ | 16/16 new tests pass; 385/385 full suite pass — independently executed, not read from the report |
| Triangulation adequate | ✅ (1 cosmetic note) | 15/16 tests well-triangulated with distinct expected values; task 1.1's evidence-table says "4 cases" but the task covers 7 (4 for `isApiKeyRequired` + 3 for `getApiKeyPepper`) — GREEN column already correctly says 7/7, so this is a reporting nit, not a real gap |
| Safety Net for modified files | ✅ | `telemetry-upstream-body.spec.ts` independently confirmed to exist with exactly 6 tests (REQ-1..REQ-6), all still green in the full run — matches "6/6" claims for tasks 1.3 and 1.5 |

**TDD Compliance**: 6/6 checks passed.

---

### Test Layer Distribution

| Layer | Tests | Files | Tools |
|-------|-------|-------|-------|
| Unit | 16 (new, this unit) | 2 | `bun:test` |
| Integration | 0 (this unit) | 0 | planned Phase 3 per design's Testing Strategy table |
| E2E | 0 | 0 | not available in this project |
| **Total (this unit)** | **16** | **2** | |

---

### Changed File Coverage

| File | Line % | Uncovered Lines | Rating |
|------|--------|------------------|--------|
| `src/config.ts` | 100% | — | ✅ Excellent |
| `src/observability/storage.ts` | 57.44% (file-wide) | 218-228,232-235,239-257,261-269,273-280,335-342,434-477 — **all pre-existing, unrelated functions**; every new line this batch added is covered | ✅ Excellent (for the actual diff) |
| `src/observability/types.ts` | N/A | — | ➖ N/A (type-only, no executable lines) |

**New-code coverage**: 100% of lines added/changed by this batch are exercised by the new tests. The blended file-wide % for `storage.ts` is not representative of this batch's quality — it is dragged down by long-standing, untouched query helpers.

---

### Assertion Quality

✅ All assertions verify real behavior. Scanned both new test files against the banned-pattern list (tautologies, orphan empty checks without a companion, type-only-alone, ghost loops, smoke-test-only, implementation-detail coupling, mock-heavy ratio): zero violations. Every `toBeNull()` / `toEqual([])` has a companion test in the same `describe` block asserting the non-empty/non-null case. Zero mocks used (real in-memory `bun:sqlite` throughout) — no mock-ratio concern.

---

### Quality Metrics

**Linter**: ➖ Not available (no ESLint/Biome config in this project — confirmed, matches cached capabilities).
**Type Checker**: ⚠️ `bun run tsc --noEmit` exits 2, but all 7 errors are proven pre-existing and unrelated (see Build & Tests Execution above). Zero new errors in changed files.

---

### Hallucination Check

Every function, type, table/column, and test file the apply claimed to create or modify was independently located in the real source and matches the claimed signature/shape — **zero hallucinations**:

| Claim | Verified |
|---|---|
| `isApiKeyRequired()` / `getApiKeyPepper()` in `src/config.ts` | ✅ exists, lines 57-59 / 69-71 |
| `RequestRecord.api_key_id?`, `ApiKeyRecord`, `UsageByKey` in `types.ts` | ✅ exist, lines 46 / 53-60 / 67-76 |
| `api_keys` table + `requests.api_key_id` column in `storage.ts` | ✅ exist, lines 71/77-85/92 |
| `insertApiKey()`, `getApiKeyByHash()`, `getUsageByApiKey()` | ✅ exist, lines 362-369 / 375-380 / 394-417 |
| `insertRequest()` accepts optional `api_key_id` | ✅ threaded through `getInsertRequest()` + bind list |
| `__tests__/config-api-key.spec.ts` — 7 tests | ✅ exactly 7 `it()` blocks |
| `__tests__/api-key-storage.spec.ts` — 9 tests | ✅ exactly 9 `it()` blocks |
| "385 pass / 0 fail / 1065 expect()" | ✅ reproduced exactly, twice |
| "tsc clean except pre-existing unrelated errors" | ✅ reproduced exactly via git-stash isolation |

**One non-hallucination inaccuracy found** (a wrong number, not a fabricated artifact): apply-progress's task-count denominator ("6/22 total") is wrong — the real total is **19** (see Issues, W1).

### Scope Check — Phase 1 only? ✅ YES

- Modified (tracked): `src/config.ts`, `src/observability/storage.ts`, `src/observability/types.ts` — all Phase 1 files per design's File Changes table.
- New (untracked): `__tests__/config-api-key.spec.ts`, `__tests__/api-key-storage.spec.ts` — Phase 1 tests.
- Phase 2 files `src/domain/api-keys.ts`, `src/guards/api-key.ts`: confirmed **absent** from disk (Glob: no matches).
- Phase 3 files `scripts/create-api-key.ts`, `src/http/routes/telemetry/usage.ts`: confirmed **absent**.
- Phase 3 touch points `src/http/server.ts`, `src/observability/middleware.ts`, `src/http/routes/telemetry/index.ts`: confirmed **untouched** — absent from `git status`; direct read of `middleware.ts` shows it still calls `insertRequest()` without `api_key_id`; `grep` for `api_key|getRequestKeyId|enforceApiKey|handleRequest` across those files + README.md returned zero matches.
- Phase 4 (`README.md`): confirmed **untouched**.
- `tasks.md`: Phase 1 boxes 1.1-1.6 = `[x]` (6/6); Phase 2/3/4 boxes = `[ ]` (13/13) — matches actual code state exactly, no stale or premature checkboxes.

**One out-of-task-list, in-working-tree finding** (not a Phase-1 scope violation, but adjacent risk — see Issues, W2): `openspec/config.yaml` carries an uncommitted diff unrelated to any Phase-1 task.

---

### Discoveries

- **`bun test --coverage` works** (Bun 1.3.13) and produces real per-file Funcs/Lines % + uncovered-line-range output. Both the cached Engram observation `sdd/claude-plan-api/testing-capabilities` (#812) and `openspec/config.yaml`'s `testing.coverage.available: false` say it's unavailable — that's stale/wrong. Filed as a standalone discovery (see Engram save below) rather than overwriting the shared capabilities artifact directly, since other fields in it weren't independently re-verified this session.

---

### Issues Found

**CRITICAL**: None.

**WARNING**:
- **W1 — apply-progress task-count denominator is wrong.** Engram `sdd/api-key-authentication/apply-progress` (#824) states "6/22 total"; the verified real total is **19** (6 checked + 13 unchecked, counted directly from `tasks.md`). Left uncorrected, Phase 2-4 apply/verify runs will keep reporting against the wrong denominator (true progress is 6/19 = 31.6%, not 6/22 = 27.3%). Recommend correcting the persisted artifact before Phase 2 apply begins.
- **W2 — `openspec/config.yaml` has a stale, uncommitted `Testing:` line sitting in the same working tree as this batch.** Working tree shows `Testing: bun test — 369/369 pass (0 fail)`, written by an earlier sdd-init pass (pre-batch, and accurate at the time) — not by this apply batch, and not listed in any Phase-1 task. Post-batch the true count is 385/385. If the orchestrator stages/commits everything for PR 1 as-is, this file ships a now-inaccurate count. Recommend updating it to `385/385 pass (0 fail)` before commit, or excluding this file from PR 1's diff.
- **W3 — Cached coverage-availability flag is wrong.** `openspec/config.yaml` `testing.coverage.available: false` and Engram #812 both say coverage isn't available; `bun test --coverage` demonstrably works (see Discoveries). Recommend correcting both once convenient — not blocking, coverage threshold is 0 regardless.

**SUGGESTION**:
- **S1 — TDD evidence table undercounts task 1.1's case count** ("4 cases" reported vs. 7 actual: 4 for `isApiKeyRequired()` + 3 for `getApiKeyPepper()`). Cosmetic; GREEN column already correctly says 7/7.
- **S2 — Re-run `api-key-usage`'s "Per-Request Key Attribution" and `api-key-auth`'s "API Key Model and Storage" scenarios end-to-end once Phase 2 (guard) + Phase 3 (wiring) land** — Phase 1 only proves the storage-layer half of each.
- **S3 — `getUsageByApiKey`'s `COALESCE(SUM(...),0)` path has no test where a matched row has an individually-NULL token column** (e.g. `input_tokens` omitted on an otherwise in-window, attributed row) — current tests always set all four token fields together. Not spec-required, but would harden confidence in the zero-safety net.

### Verdict

**PASS WITH WARNINGS** — 0 CRITICAL, 3 WARNING (all documentation/process-accuracy, none functional), 3 SUGGESTION. All 6 Phase-1 tasks are genuinely complete: independently re-verified via source inspection, real test execution (run twice, deterministic), a real `git stash` pre-existing-error proof for the `tsc` claim, a line-for-line schema diff against design.md, and a `grep`+`git status` scope-boundary check across every Phase 2/3/4 touch point. Zero hallucinations, zero drift, zero scope creep. The apply summary's *functional* and *test-execution* claims all check out; the only misses are a wrong task-count denominator and stray unrelated diffs already sitting in the working tree.

**next_recommended**: Proceed to Phase 2 apply (Core Auth — domain + guard), on the condition that W1 (task-total) is corrected first so Phase 2/3/4 self-reports don't compound the error, and the orchestrator explicitly decides what to do with the `openspec/config.yaml` diff (W2) before opening PR 1.

---

*Gatekeeper note: this report covers Unit 1 / PR 1 only. Units 2-4 (Core Auth, Integration, Documentation) remain unverified and unimplemented; do not treat this PASS as clearance for the whole `api-key-authentication` change.*
