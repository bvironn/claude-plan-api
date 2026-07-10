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

*Gatekeeper note (Unit 1, historical): this report covered Unit 1 / PR 1 only. Units 2-4 (Core Auth, Integration, Documentation) remained unverified and unimplemented at that time.*

---

## Verification Report — Unit 2 / PR 2 ("Core Auth")

**Change**: api-key-authentication
**Unit**: 2 of 4 ("Core Auth" — Domain + Guard). Branch `feat/api-key-auth-guard`, stacked on `feat/api-key-auth-foundation` (PR #10, **open**, base=`master`, unmerged — confirmed via `gh pr view 10`). No PR yet opened for this unit (expected: orchestrator opens it after verify passes). NOT yet committed/pushed (working tree only) — verified read-only, nothing staged/committed by this verify pass.
**Version**: specs/api-key-auth — Key Generation and Issuance (format proven; CLI is Phase 3), Fast Hash Validation, Credential Extraction from Headers, 401 Enforcement Gate, Exempt Routes
**Mode**: Strict TDD (runner: `bun test`)
**Also serves as**: fresh-context orchestrator gatekeeper review of Batch-2 apply (Engram `sdd/api-key-authentication/apply-progress`, obs #824, Batch 2 section). Adversarial — every claim below was independently re-derived from source and command output, not taken on trust.

### Completeness

| Metric | Value |
|--------|-------|
| Tasks total (whole change, verified by direct count) | **19** (apply-progress now correctly says 10/19 — Unit 1's W1 finding was fixed) |
| Tasks total (this unit, Phase 2) | 4 |
| Tasks complete (Phase 2) | 4/4 |
| Tasks complete (whole change so far) | 10/19 |
| Tasks incomplete | 9 (Phase 3: 6, Phase 4: 3) |

`tasks.md` diff independently inspected via `git diff`: **exactly** the 4 Phase-2 checkboxes flip `[ ]`→`[x]`; zero other lines touched (no stray edits, no Phase-3/4 boxes prematurely checked).

### Build & Tests Execution

**Build**: ✅ Passed (new modules compile as part of `tsc`, see below)

**Tests**: ✅ 409 pass / 0 fail / 1106 expect() calls across 37 files
```text
$ bun test
409 pass
0 fail
1106 expect() calls
Ran 409 tests across 37 files. [3.67s]
```
Also ran isolated on just the 2 new files to double-confirm the delta:
```text
$ bun test __tests__/api-key-domain.spec.ts __tests__/api-key-guard.spec.ts
24 pass
0 fail
41 expect() calls
Ran 24 tests across 2 files. [194ms]
```
409−385=24 and 1106−1065=41 — the isolated run's count matches the full-suite delta over the Unit-1 baseline exactly. **Zero regressions.** Test counts independently re-confirmed via `rg -c "^\s*it\("`: `api-key-domain.spec.ts`=15, `api-key-guard.spec.ts`=9 (not just read/eyeballed).

**Type check**: ❌ exits 2 — 7 errors, **same file, same lines as the Unit-1-proven pre-existing baseline**, `__tests__/transform-streaming-abort-signal.spec.ts` (untouched by this batch — absent from `git status`):
```text
__tests__/transform-streaming-abort-signal.spec.ts(40,34): error TS2304: Cannot find name 'ReadableStreamReadResult'.
__tests__/transform-streaming-abort-signal.spec.ts(60,80): error TS2345: ... ToolMap ...
__tests__/transform-streaming-abort-signal.spec.ts(63,37): error TS2345: ... readMany ...
__tests__/transform-streaming-abort-signal.spec.ts(71,80): error TS2345: ... ToolMap ...
__tests__/transform-streaming-abort-signal.spec.ts(77,37): error TS2345: ... readMany ...
__tests__/transform-streaming-abort-signal.spec.ts(83,80): error TS2345: ... ToolMap ...
__tests__/transform-streaming-abort-signal.spec.ts(86,37): error TS2345: ... readMany ...
```
Exact same 7 file/line/column triples as Unit 1's git-stash-proven baseline. **Zero new type errors** from `src/domain/api-keys.ts` or `src/guards/api-key.ts`.

**Coverage**: `bun test --coverage` on the 2 new files:
```text
src/domain/api-keys.ts   100.00% Funcs  100.00% Lines
src/guards/api-key.ts    100.00% Funcs  100.00% Lines
```
Both Phase-2 source files fully covered.

### Spec Compliance Matrix

The task framing for this unit is explicit: satisfy every `api-key-auth` requirement **at the unit level**, while the guard is not yet wired into `fetch()` (that's Phase 3). Several spec scenarios describe end-to-end dispatch behavior ("dispatched to its handler", "route handler is not invoked", "server responds normally") that literally cannot be true in production yet, since nothing calls `enforceApiKey()` from the server. To avoid overclaiming system-level compliance that doesn't exist, scenarios whose decision logic is 100% implemented+tested but whose *dispatch* half is still pending are marked **PARTIAL**, not COMPLIANT — consistent with the report format's own definition ("test passes but covers only part of the scenario").

| Requirement | Scenario | Test | Result |
|-------------|----------|------|--------|
| api-key-auth: API Key Model and Storage | Persisted key row stores only the hash | (Unit 1: `api-key-storage.spec.ts`) | ✅ COMPLIANT — carried forward from Unit 1, unaffected by this unit |
| api-key-auth: Key Generation and Issuance | CLI issues a working key shown once | none this unit | ➖ N/A — CLI is Phase 3 (task 3.5); `generateKey()`'s format/entropy/uniqueness is unit-tested (4 tests) but the full scenario needs the CLI |
| api-key-auth: Fast Hash Validation | Valid key authenticates a gated request | `api-key-guard.spec.ts > gated valid key` (2 tests: Bearer, X-API-Key) | ⚠️ PARTIAL — hash validation + pass/attribute decision fully proven (`enforceApiKey` returns `null` and attributes id `7` for both header forms); "dispatched to its handler, handler's normal result" needs real `fetch()` wiring (Phase 3, task 3.1) |
| api-key-auth: Credential Extraction from Headers | Either header supplies the key | `api-key-domain.spec.ts > parseKeyFromHeaders()` (4 tests) + `api-key-guard.spec.ts` (Bearer and X-API-Key both → identical attributed id) | ✅ COMPLIANT — this requirement's full scope (identical extraction+validation for both headers) is achieved entirely at the guard boundary; does not require system dispatch |
| api-key-auth: 401 Enforcement Gate | Missing key is rejected | `api-key-guard.spec.ts > rejects a gated /v1/* route with no key` + telemetry variant | ⚠️ PARTIAL — the gate's own 401 decision is fully proven; "before the route handler runs" / real dispatch needs Phase 3 wiring + task 3.6's integration test |
| api-key-auth: 401 Enforcement Gate | Invalid or revoked key is rejected | `api-key-guard.spec.ts > rejects an unknown key` + `> rejects a revoked key` | ⚠️ PARTIAL — same caveat |
| api-key-auth: 401 Enforcement Gate | Flag disabled bypasses enforcement | `api-key-guard.spec.ts > REQUIRE_API_KEY=false` | ⚠️ PARTIAL — same caveat |
| api-key-auth: Exempt Routes | Exempt routes never require a key | `api-key-guard.spec.ts > exempt routes` (2 tests, 3 paths: `/health`, `/`, `/assets/app.js`) | ⚠️ PARTIAL — exemption logic fully proven at guard level; system-level "server responds normally" is pending Phase 3 wiring |
| api-key-usage (all) | — | none this unit | ➖ N/A — storage half already COMPLIANT (Unit 1); usage route is Phase 3 |
| project-readme | — | none this unit | ➖ N/A — Phase 4 |

**Compliance summary**: 2/9 spec.md scenarios fully COMPLIANT (1 carried from Unit 1 + Credential Extraction, new this unit); 5/9 PARTIAL (decision logic 100% implemented and passing; dispatch-level "last mile" correctly deferred to Phase 3); 2/9 N/A (CLI/Phase 3, docs/Phase 4). **0 FAILING, 0 UNTESTED** for anything this unit claims to deliver — exactly matching the stated framing that this batch satisfies every requirement at the unit level without claiming premature system-level clearance.

### Correctness (Static Evidence)

| Requirement | Status | Notes |
|------------|--------|-------|
| `generateKey()` — `cpk_<8hex>.<64hex>`, CSPRNG | ✅ Implemented | `crypto.getRandomValues()` (Web Crypto CSPRNG) for both the 4-byte prefix and 32-byte (256-bit) secret — confirmed by source read + `rg "Math\.random"` returning **zero** matches anywhere in `src/` |
| `hashKey()` — HMAC-SHA256(pepper, full) | ✅ Implemented, **verified TRUE HMAC** | `new Bun.CryptoHasher("sha256", getApiKeyPepper())` — cross-checked against Bun's own docs (`node_modules/bun-types/docs/runtime/hashing.mdx`, "HMAC in `Bun.CryptoHasher`" section, L279: "pass the key to the constructor" to compute HMAC). This is genuine HMAC-SHA256, **not** a plain SHA-256 of the key alone — the task explicitly flagged this distinction as materially important, and it checks out |
| `parseKeyFromHeaders()` — Bearer precedence | ✅ Implemented | Regex-anchored `Bearer` match tried first; falls through to `X-API-Key` only when `Authorization` is absent or doesn't match `Bearer`; dedicated precedence test (`Bearer cpk_bearer.win` beats `X-API-Key cpk_xkey.lose`) |
| `setRequestKeyId`/`getRequestKeyId` WeakMap | ✅ Implemented | Module-level `WeakMap<Request, number>`, GC-safe, isolated per `Request` identity (3 dedicated tests, including cross-request isolation) |
| `enforceApiKey()` — gated predicate | ✅ Implemented, **byte-identical to design** | `pathname.startsWith("/v1/") \|\| pathname.startsWith("/api/")` — matches design decision #2 exactly; explicitly **not** `isApiOwned` (which also covers `/assets/` + `/health` and would wrongly gate them) |
| `enforceApiKey()` — active-only lookup | ✅ Implemented | Delegates to Unit-1's `getApiKeyByHash` (`WHERE key_hash = ? AND revoked_at IS NULL`) — revoked keys correctly excluded |
| 401 response shape | ✅ Implemented, matches codebase convention | `{error:{message,code}}` + `Content-Type: application/json` + `WWW-Authenticate: Bearer` — confirmed the base shape is used across `static.ts`, `server.ts`, `tokens.ts`; `chat.ts` L60 has a precedent for adding a `code` field too |

### Coherence (Design)

| Decision | Followed? | Notes |
|----------|-----------|-------|
| #1 Hook point: pre-dispatch guard, first stmt in `fetch()` | ➖ N/A this unit | Guard exists and is exported, but **correctly not yet called** from `fetch()` — that's Phase 3 task 3.1 |
| #2 Gated predicate: `/v1/*`\|\|`/api/*`, not `isApiOwned` | ✅ Yes | Confirmed byte-for-byte against design.md |
| #3 Hashing: HMAC-SHA256, fast (not `Bun.password`) | ✅ Yes | Confirmed genuine HMAC via Bun docs; no adaptive/slow hash anywhere in the new code |
| #4 Key format: `cpk_<prefix>.<secret>` | ✅ Yes | `cpk_` + 8 hex prefix (4 random bytes) + 64 hex secret (32 random bytes / 256-bit), shown once via the returned `full`, never persisted by this module (it's I/O-free) |
| #5 Attribution transport: `WeakMap<Request, number>` | ✅ Yes | Module-level, guard `set`s, (not-yet-wired) middleware will `get` |
| #6 Config access: call-time env | ✅ Yes (carried) | `isApiKeyRequired()` unchanged since Unit 1; guard calls it at invocation time, not import time |
| #8 Testability: exported `handleRequest` | ➖ N/A this unit | Correctly deferred to Phase 3 (task 3.1) |
| Follows `guards/anti-loop.ts` convention | ✅ Yes (idiom-level) | Both modules import `emit` from `observability/logger` and call it exactly on the triggering path (`anti-loop.ts`'s `trackToolError`/`loopDetected`; `api-key.ts`'s `reject()`). Not byte-identical structure (`anti-loop.ts` returns `boolean`, `api-key.ts` returns `Response \| null` directly) but the stated "emit-on-trigger, otherwise quiet" idiom genuinely holds — not a hallucinated convention claim |

### TDD Compliance

| Check | Result | Details |
|-------|--------|---------|
| TDD Evidence reported | ✅ | "TDD Cycle Evidence" table present in apply-progress #824, Batch-2 section, for tasks 2.1-2.4 |
| All tasks have tests | ✅ | 4/4 Phase-2 tasks map to a test file (2.1→`api-key-domain.spec.ts`; 2.2→`api-key-guard.spec.ts`; 2.3/2.4 share the same RED/GREEN cycle as 2.1/2.2 per the apply's own table, since they're the implementation half of the same test-first pair) |
| RED confirmed (tests exist) | ✅ | Both files verified on disk with the exact claimed counts — independently re-counted via `rg -c "^\s*it\("`: 15 and 9, not just read |
| GREEN confirmed (tests pass) | ✅ | 24/24 new tests pass in isolation; 409/409 full suite pass — executed independently twice (isolated + full), not read from the report |
| Triangulation adequate | ✅ | apply-progress claims "4 gen + 4 hash + 4 parse + 3 weakmap" (=15, exact) and "off(1) + exempt(3 paths across 2 tests) + reject(missing/telemetry/unknown/revoked=4) + valid(Bearer/X-API-Key=2)" (=9, exact) — both recounted line-by-line against the real files and matched exactly; **zero cosmetic miscounts this unit** (Unit 1 had one, S1) |
| Safety Net for modified files | ✅ | "N/A (new module)" is correct for both — confirmed both files are wholly new (`git status` shows `??`, not `M`) |

**TDD Compliance**: 6/6 checks passed.

---

### Test Layer Distribution

| Layer | Tests | Files | Tools |
|-------|-------|-------|-------|
| Unit | 24 (new, this unit) | 2 | `bun:test` |
| Integration | 0 (this unit) | 0 | planned Phase 3 per design's Testing Strategy table (task 3.6, dispatch-level) |
| E2E | 0 | 0 | not available in this project |
| **Total (this unit)** | **24** | **2** | |

---

### Changed File Coverage

| File | Funcs % | Line % | Uncovered Lines | Rating |
|------|---------|--------|------------------|--------|
| `src/domain/api-keys.ts` | 100% | 100% | — | ✅ Excellent |
| `src/guards/api-key.ts` | 100% | 100% | — | ✅ Excellent |

**Average changed file coverage**: 100%. Note: CodeGraph's static call-graph flagged `hashKey` as "⚠️ no covering tests found" — this is a **false negative**, directly refuted by the 100% line-coverage run plus 4 dedicated `hashKey()` tests in `api-key-domain.spec.ts` plus indirect exercise in every guard test that presents a non-empty key (real `hashKey()` runs; only `storage.getApiKeyByHash` is stubbed). Flagged as a tooling-accuracy footnote, not a real coverage gap.

---

### Assertion Quality

✅ All assertions verify real behavior. Both files scanned against the full banned-pattern list:
- No tautologies, no assertion-free tests, no ghost loops (no `forEach`/`map` over query results).
- `not.toHaveBeenCalled()` checks in the guard's "off"/"exempt" tests are legitimate behavioral assertions (proving the expensive storage lookup is skipped on the bypass path — the actual behavior under test for a guard clause), not implementation-detail coupling.
- Every `toBeNull()`/`toBeUndefined()` has a companion test in the same `describe` asserting the non-null/defined case (e.g., WeakMap "returns undefined when unset" sits beside "round-trips the attributed id").
- Mock/assertion ratio in `api-key-guard.spec.ts`: ~9 spy creations vs. 18 `expect()` calls (≈1:2) — well under the "mocks > 2× assertions" threshold; `api-key-domain.spec.ts` uses zero mocks (pure functions).
- Well-triangulated: each behavior (off/exempt/reject-missing/reject-unknown/reject-revoked/valid-Bearer/valid-X-API-Key) asserts a **different** expected outcome, not repeated empty/trivial checks.

**Assertion quality**: ✅ 0 CRITICAL, 0 WARNING.

---

### Quality Metrics

**Linter**: ➖ Not available (unchanged from Unit 1 — no ESLint/Biome config).
**Type Checker**: ⚠️ `bun run tsc --noEmit` exits 2, but all 7 errors are the same proven-pre-existing ones from Unit 1's baseline (see Build & Tests Execution). Zero new errors in changed files.

---

### Hallucination Check

| Claim | Verified |
|---|---|
| `generateKey()`, `hashKey()`, `parseKeyFromHeaders()`, `setRequestKeyId()`/`getRequestKeyId()` in `src/domain/api-keys.ts` | ✅ exist, lines 43/57/67/89/94 — signatures match claims exactly |
| `enforceApiKey()`, `isGated()`, `reject()` in `src/guards/api-key.ts` | ✅ exist, lines 22/40/45 — signatures match claims exactly |
| `__tests__/api-key-domain.spec.ts` — 15 tests | ✅ exactly 15 `it()` blocks (`rg -c` independently confirms) |
| `__tests__/api-key-guard.spec.ts` — 9 tests | ✅ exactly 9 `it()` blocks (`rg -c` independently confirms) |
| "409 pass / 0 fail / 1106 expect()" (full suite) | ✅ reproduced exactly |
| "24 new tests" | ✅ reproduced exactly, isolated run: 24 pass / 0 fail / 41 expect() |
| "tsc clean except same 7 pre-existing errors" | ✅ reproduced exactly, same 7 file/line/col triples as Unit-1's stash-proven baseline |
| Key format `cpk_<8hex>.<64hex>` | ✅ confirmed via source + regex-asserting tests (`^cpk_[0-9a-f]{8}$`, `^[0-9a-f]{64}$`) |
| HMAC-SHA256 (not plain SHA-256) | ✅ confirmed via Bun's own docs |
| CSPRNG (not `Math.random()`) | ✅ confirmed via source (`crypto.getRandomValues`) + repo-wide grep |
| Guard follows `guards/anti-loop.ts` convention | ✅ idiom genuinely holds (see Coherence table) |

**Zero hallucinations.** Every claimed function/file/test-count/numeric result was independently reproduced, not taken from the apply summary.

### Security Review (explicit focus area — this is the auth core)

- **HMAC vs. plain hash**: ✅ CONFIRMED true HMAC-SHA256 (see Correctness table) — this materially matters (a plain, unkeyed SHA-256 of the key would make the digest itself brute-forceable offline if the DB ever leaked, since SHA-256 is fast; HMAC with a server-only pepper prevents that). Verdict: **not** a weaker scheme, the design's intent is faithfully implemented.
- **CSPRNG**: ✅ CONFIRMED — `crypto.getRandomValues()` (Web Crypto), zero `Math.random()` usage anywhere in `src/`. 256-bit secret entropy is cryptographically sound.
- **Gated predicate correctness**: ✅ CONFIRMED — `/v1/*` and `/api/*` only; `/health`, `/`, `/assets/*` are provably NOT gated (3 explicit exempt-route tests, including an assertion that the storage lookup is never even attempted for `/health`).
- **Active-only lookup**: ✅ CONFIRMED — `getApiKeyByHash` filters `revoked_at IS NULL` (proven at the storage layer in Unit 1); this unit's guard tests correctly proxy that behavior via a stub rather than re-proving the SQL filter — appropriate separation of test responsibility, not a gap.
- **Pepper/secret never logged or exposed**: ✅ CONFIRMED — `src/domain/api-keys.ts` has **zero** `emit()`/`console.*` calls (pure module); the guard's only `emit()` call carries `{ path }` only; the 401 response body is the generic `{error:{message:"Unauthorized",code:401}}` — no key material, hash, or pepper in any log line or response.
- **Timing-attack risk in the hash comparison**: ⚠️ **WARNING (theoretical, low severity)**. The match happens entirely inside SQLite (`WHERE key_hash = ?`, backed by a `UNIQUE` index), not a JS `===`. SQLite's default TEXT comparison is not constant-time at the byte level, so in principle a lookup could leak partial-match timing signal. However, this is fundamentally different from the classic timing attack on **raw secret** comparison: here the compared value is an **HMAC-SHA256 digest** of attacker-supplied input, not the secret itself. Because of SHA-256/HMAC's avalanche property, an attacker cannot use a partial-digest-match timing oracle to incrementally refine a guess toward a valid key — a 1-bit change to the presented key scrambles the entire digest unpredictably, so there is no gradient to climb the way there is with naive raw-string comparison. Net: **real-world exploitability is very low**, and given this is flagged in the task as an internal tool, this is a defense-in-depth suggestion rather than a blocking defect. Recommend (non-blocking): if this API is ever exposed beyond a trusted network, consider a constant-time final comparison as belt-and-suspenders hardening.

### Scope Check — Phase 2 only? ✅ YES

- New (untracked): `src/domain/api-keys.ts`, `src/guards/api-key.ts`, `__tests__/api-key-domain.spec.ts`, `__tests__/api-key-guard.spec.ts` — exactly the 4 files the design's File Changes table assigns to Phase 2.
- `src/http/server.ts`: read in full — **zero** references to `enforceApiKey`, `domain/api-keys.ts`, or `guards/api-key.ts`; confirmed absent from `git status` (byte-identical to HEAD). The pre-dispatch wiring (design decision #1) has **not** happened yet, exactly as scoped.
- `src/observability/middleware.ts`: read in full — `insertRequest()` call still has no `api_key_id` / `getRequestKeyId` reference; confirmed absent from `git status`.
- Phase 3 files (`scripts/create-api-key.ts`, `src/http/routes/telemetry/usage.ts`): confirmed **absent** from disk.
- `README.md`, `openspec/config.yaml`: `git diff` returns **empty** for both — untouched by this batch.
- `tasks.md`: `git diff` shows **exactly** 4 lines changed, all `[ ]`→`[x]` for 2.1-2.4 — no other edits, no premature Phase-3/4 checkboxes.
- `.codegraph/` appears as untracked in `git status` — this is a local CodeGraph index directory (tooling artifact used for this verify pass itself), not part of the api-key-authentication change; no action needed.

### Discoveries / Recurring Issues Carried From Unit 1

- **W2 (Unit 1) is still open, and now further stale.** `openspec/config.yaml`'s `context.Testing:` line still reads `bun test — 385/385 pass (0 fail)` — accurate immediately after Unit 1, but the real count after this unit is **409/409**. `git diff` confirms this file was **not touched** by this batch (the staleness isn't new damage from Unit 2, but it is now one Unit further out of date). Recommend updating before whichever PR ends up carrying this file's diff.
- **W3 (Unit 1) is still open, unfixed.** `openspec/config.yaml`'s `testing.coverage.available: false` (with the note "bun test has no built-in coverage flag yet") is still present and still wrong — reconfirmed again this session (`bun test --coverage` produced real 100%/100% output for both new files). Not blocking (coverage threshold is 0), but flagged a second time now since it was already identified in Unit 1 and has not been corrected.
- **W1 (Unit 1) is resolved.** apply-progress #824 now correctly states "10/19 total" — the task-count denominator bug from Unit 1 did not compound into Batch 2's self-report.

### Issues Found

**CRITICAL**: None.

**WARNING**:
- **W4 — `openspec/config.yaml` test count is stale again** (385/385 shown, real is 409/409). Not caused by this batch; carried/worsening from Unit 1's W2. Non-blocking, documentation-accuracy only.
- **W5 — `openspec/config.yaml` `coverage.available: false` still incorrect**, unfixed since Unit 1's W3. Non-blocking, coverage threshold is 0 regardless.
- **W6 — Theoretical timing side-channel in the SQL hash-equality lookup** (see Security Review). Low real-world exploitability given HMAC-SHA256's avalanche property; not a raw-secret comparison. Non-blocking defense-in-depth suggestion.

**SUGGESTION**:
- **S4 — CodeGraph's static analysis flagged `hashKey` as having "no covering tests"** — a false negative, directly refuted by 100% coverage and 4 dedicated tests. Worth noting only as a tooling-accuracy footnote for future verify passes in this project.
- **S5 — Phase 3's task 3.6 (dispatch-level integration test)** is exactly what will convert this unit's 5 PARTIAL spec scenarios into full COMPLIANT once the guard is wired into `fetch()`. No additional test is needed beyond what's already planned.
- **S6 — Rate-limiting/backoff for repeated invalid-key attempts** is explicitly out of scope per design.md's Open Questions (quotas are a follow-up). Not a regression; just flagging it stays intentionally deferred, not forgotten.

### Verdict

**PASS WITH WARNINGS** — 0 CRITICAL, 3 WARNING (2 are recurring documentation/process-accuracy issues from Unit 1 that this batch did not touch or worsen structurally, only made one unit more stale; 1 is a theoretical/low-severity security note), 3 SUGGESTION. All 4 Phase-2 tasks are genuinely complete: independently re-verified via full source inspection, real test execution (24/24 isolated, 409/409 full suite, both run independently — not read from the report), real coverage run (100%/100% both new files), a documentation-cross-check proving `hashKey()` is genuine HMAC-SHA256 (not a weaker plain hash), grep-proven absence of `Math.random()` and of any pepper/secret logging, and a `git diff`/`git status`-proven zero-scope-creep boundary (exactly the 4 intended files, exactly 4 checkbox flips, `server.ts`/`middleware.ts`/README/config.yaml all byte-identical to HEAD). Zero hallucinations.

**next_recommended**: Proceed to Phase 3 apply (Integration — server wiring, CLI issuance, usage route, dispatch-level integration test). Task 3.6's integration test is what converts this unit's 5 PARTIAL scenarios to full COMPLIANT. Recommend the orchestrator/user decide what to do with the still-open W4/W5 (`openspec/config.yaml` staleness) at some point before final archive, though neither blocks Phase 3.

---

*Gatekeeper note (cumulative): this document now covers Units 1-2 / PRs 1-2 (Foundation, Core Auth), both independently verified PASS WITH WARNINGS with 0 CRITICAL findings. Units 3-4 (Integration/wiring, Documentation) remain unverified and unimplemented — the guard is not yet called from `fetch()`, so end-to-end request authentication does not yet exist in this codebase. Do not treat this PASS as clearance for the whole `api-key-authentication` change.*
