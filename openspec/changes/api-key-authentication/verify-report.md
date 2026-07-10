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

## Verification Report — Unit 3 / PR 3 ("Integration")

**Change**: api-key-authentication
**Unit**: 3 of 4 ("Integration" — Server Wiring, CLI, Usage Route). Branch `feat/api-key-auth-wiring`, stacked on `feat/api-key-auth-guard` (PR #11, open, unmerged), itself stacked on `feat/api-key-auth-foundation` (PR #10, open, unmerged). NOT committed/pushed — verified read-only, nothing staged/committed by this verify pass.
**Version**: specs/api-key-auth (401 Enforcement Gate, Exempt Routes, Fast Hash Validation, Credential Extraction, Key Generation and Issuance); specs/api-key-usage (Per-Request Key Attribution, Usage Telemetry Route)
**Mode**: Strict TDD (runner: `bun test`)
**Risk framing**: this is the **highest-risk unit in the change** — `enforceApiKey` goes LIVE in `fetch()` here for the first time. Treated as a live-wiring security review, not a routine unit-test check. Every claim in Engram `sdd/api-key-authentication/apply-progress` (#824, Batch 3 section) was independently re-derived from source and command execution — nothing taken on trust.

### Completeness

| Metric | Value |
|--------|-------|
| Tasks total (whole change, direct count) | **19** |
| Tasks total (this unit, Phase 3) | 6 |
| Tasks complete (Phase 3) | 6/6 |
| Tasks complete (whole change so far) | 16/19 |
| Tasks incomplete | 3 (Phase 4: README docs, all still `[ ]`) |

`tasks.md` diff independently inspected via `git diff`: **exactly** the 6 Phase-3 checkboxes flip `[ ]`→`[x]` (one gained extra prose disclosing the middleware attribution wiring folded into 3.1); zero other lines touched, Phase-4 boxes untouched and still `[ ]`.

### Build & Tests Execution

**Build**: ✅ Passed

**Tests**: ✅ 422 pass / 0 fail / 1151 expect() calls across 40 files — reproduced exactly, matches the apply claim.
```text
$ bun test
422 pass
0 fail
1151 expect() calls
Ran 422 tests across 40 files. [3.77s]
```
Isolated run of only the 3 new files:
```text
$ bun test __tests__/api-key-dispatch.spec.ts __tests__/telemetry-usage-route.spec.ts __tests__/create-api-key.spec.ts
13 pass
0 fail
45 expect() calls
Ran 13 tests across 3 files. [308ms]
```
422−409=13 and 1151−1106=45 — matches the full-suite delta over the Unit-2 baseline exactly (2 route + 9 dispatch + 2 CLI = 13). **Zero regressions.** Also re-ran the full Phase 1+2 test files (`api-key-guard`, `api-key-domain`, `api-key-storage`, `observability`) in isolation: 37 pass / 0 fail — confirms the live-wired guard did not break the pre-existing real-server-spawn dispatch test (`observability.spec.ts`, which boots the actual compiled server with `REQUIRE_API_KEY` unset).

**Type check**: ❌ exits 2 — same 7 errors, same file, same lines as the Unit-1/Unit-2-proven pre-existing baseline (`__tests__/transform-streaming-abort-signal.spec.ts`, untouched, absent from `git status`):
```text
__tests__/transform-streaming-abort-signal.spec.ts(40,34): error TS2304: Cannot find name 'ReadableStreamReadResult'.
__tests__/transform-streaming-abort-signal.spec.ts(60,80): error TS2345: ... ToolMap ...
__tests__/transform-streaming-abort-signal.spec.ts(63,37): error TS2345: ... readMany ...
__tests__/transform-streaming-abort-signal.spec.ts(71,80): error TS2345: ... ToolMap ...
__tests__/transform-streaming-abort-signal.spec.ts(77,37): error TS2345: ... readMany ...
__tests__/transform-streaming-abort-signal.spec.ts(83,80): error TS2345: ... ToolMap ...
__tests__/transform-streaming-abort-signal.spec.ts(86,37): error TS2345: ... readMany ...
```
**Zero new type errors** from `server.ts`, `middleware.ts`, `usage.ts`, `telemetry/index.ts`, or `scripts/create-api-key.ts`.

**Coverage**:
| File | Funcs % | Lines % | Uncovered | Rating |
|------|---------|---------|-----------|--------|
| `src/http/routes/telemetry/usage.ts` | 100% | 100% | — | ✅ Excellent |
| `src/http/routes/telemetry/index.ts` | 100% | 100% | — | ✅ Excellent |
| `src/http/server.ts` | 66.67% | 60% | 27-30, 51-58, 96-99, 101-109, 114-118 | ⚠️ see note |
| `src/observability/middleware.ts` | 100% | 81.93% | 37, 87-100 | ⚠️ see note |
| `scripts/create-api-key.ts` | n/a | n/a | not instrumented (subprocess) | ➖ tooling limitation, not a test gap |

Note on `server.ts`/`middleware.ts` "uncovered" lines: **every one of them is pre-existing code, unchanged by this diff** — verified by mapping each uncovered range against `git diff`: `isApiOwned` body (27-30), the OPTIONS 204 response (51-58), the SPA-fallback branch (96-99), the 404/500 catch tail (101-109), and `startServer()` itself (114-118) all sit outside this PR's hunks. The two genuinely **new** lines this PR added to these files — the guard call site (`server.ts` 67-68) and the attribution field (`middleware.ts` 63) — **are both covered**. `middleware.ts`'s uncovered 37/87-100 are the pre-existing body-clone-failure catch and the handler-error catch, also untouched by this diff.

### Ordering Proof (the核心/critical check — read line by line, not trusted from the summary)

Read `src/http/server.ts` in full myself and cross-checked against `git diff` (the diff is a clean, behavior-preserving extraction of the old inline `Bun.serve({ fetch(req){...} })` closure into an exported `handleRequest`, with exactly two functional insertions: the guard block and one new route line):

```typescript
47: export async function handleRequest(req: Request): Promise<Response> {
48:   const url = new URL(req.url);
49:   const { method, pathname } = { method: req.method, pathname: url.pathname };
50:   if (method === "OPTIONS") {
51:     return new Response(null, { status: 204, headers: {...CORS...} });
59:   }
60:   try {
61:     // API-key enforcement gate (design decision #1). MUST be the first statement
...
67:     const denied = enforceApiKey(req);
68:     if (denied) return denied;
69:
70:     if (method === "GET" && pathname === "/health") return await observedHealth(req);
71:     if (method === "GET" && pathname === "/v1/models") return await observedModels(req);
...      (all remaining route dispatch, static serving, SPA fallback, 404)
103:   } catch (err) { ... }
112: }
```

**Finding: CONFIRMED, no ordering bug.** `enforceApiKey(req)` (line 67) is the literal first statement inside the `try` block — before every route-dispatch line (70+), before the static/SPA branch, before the 404 fallback. `withObservability` (and therefore `insertRequest`) is only reachable through `observedHealth`/`observedModels`/`observedChat`/`observedCompletions`/`observedTokensCount`/`observedAccountProfile` — all of which are called only from lines ≥70, strictly after the `if (denied) return denied;` early return at line 68. If `enforceApiKey` returns a `Response` (401), `handleRequest` returns immediately at line 68 and **none** of the observability-wrapped handlers ever execute — `insertRequest` cannot fire for a rejected request. This was proven twice: (1) by reading the control flow directly, and (2) by runtime: `__tests__/api-key-dispatch.spec.ts`'s first test spies on `storage.insertRequest` and asserts `expect(ins).not.toHaveBeenCalled()` after a 401 — this passed (see Test Quality below for why this spy is a genuine, non-vacuous proof and not a false-positive artifact of a broken mock).

One caveat noted, not a bug: `OPTIONS` requests (line 50, before the `try` block) bypass the guard entirely, same as they bypassed all dispatch logic before this PR. `OPTIONS` only ever returns a static, dataless 204 CORS response — no handler runs, no data is read or written — so this is standard CORS-preflight practice, not a security gap. Not a deviation introduced by this PR (the OPTIONS block's position is unchanged from the pre-PR inline closure).

### Predicate Correctness — every route in `handleRequest`, classified

| # | Method + Path | Handler | Gated by `enforceApiKey`? | Verified how |
|---|---|---|---|---|
| 1 | `OPTIONS *` | inline 204 CORS response | ❌ Exempt (runs before `try`, pre-existing) | Source read; harmless (no data) |
| 2 | `GET /health` | `observedHealth` | ❌ Exempt (`isGated` only matches `/v1/`,`/api/`) | Dispatch test: 200 + key-store never consulted |
| 3 | `GET /v1/models` | `observedModels` | ✅ Gated (`/v1/`) | Dispatch test: 401 no-key; 200 valid-key both header forms |
| 4 | `POST /v1/chat/completions` | `observedChat` | ✅ Gated | Dispatch test: 401 no-key + `insertRequest` not called |
| 5 | `POST /v1/completions` | `observedCompletions` | ✅ Gated (`/v1/` prefix, same predicate) | Predicate read directly; shares `isGated` with #4 |
| 6 | `POST /v1/tokens/count` | `observedTokensCount` | ✅ Gated | Predicate read directly |
| 7 | `GET /api/account/profile` | `observedAccountProfile` | ✅ Gated (`/api/`) | Predicate read directly |
| 8 | `GET /api/telemetry/logs` | `handleTelemetryLogs` | ✅ Gated | Predicate read directly |
| 9 | `GET /api/telemetry/stream` | `handleTelemetryStream` | ✅ Gated | Predicate read directly |
| 10 | `GET /api/telemetry/metrics` | `handleTelemetryMetrics` | ✅ Gated | Dispatch test: 401 no-key |
| 11 | `GET /api/telemetry/usage` **(NEW)** | `handleTelemetryUsage` | ✅ Gated | Dispatch test: 401 no-key (see Usage-Route Security below for the pass-through gap) |
| 12 | `GET /api/telemetry/requests` | `handleTelemetryRequests` | ✅ Gated | Predicate read directly |
| 13 | `GET /api/telemetry/requests/*` | `handleTelemetryRequestById` | ✅ Gated | Predicate read directly |
| 14 | `GET /api/telemetry/export` | `handleTelemetryExport` | ✅ Gated | Predicate read directly |
| 15 | `GET /assets/*` (static) | `serveStatic` | ❌ Exempt | Dispatch test: 404 (miss) not 401 + key-store never consulted |
| 16 | `GET /` and any other GET | `serveSpaFallback` | ❌ Exempt | Predicate read directly; same `isGated` as #15 |
| 17 | unmatched (404) / unhandled error (500) | fallback / catch | N/A — guard already ran for the whole request before reaching here | Guard runs prefix-based on `pathname`, independent of whether a handler exists — an unregistered `/api/*` path 401s (no route enumeration leak) rather than 404ing when unauthenticated |

`isGated` (in `guards/api-key.ts`, unchanged this unit) is `pathname.startsWith("/v1/") || pathname.startsWith("/api/")` — a **different, narrower** predicate than `server.ts`'s own `isApiOwned` (which also matches `/health` and `/assets/`), exactly matching design decision #2. No route is double-classified or missed: every `/v1/*` and `/api/*` path (including the new usage route) is gated; `/health`, `/assets/*`, `/`, and the SPA fallback are provably exempt.

### Flag-Off Safety (`REQUIRE_API_KEY=false`, the default)

Traced `enforceApiKey`'s first line: `if (!isApiKeyRequired()) return null;` — this executes **before** any URL parsing, header parsing, or storage call inside the guard. When the flag is unset or literally `"false"`, `isApiKeyRequired()` returns `false`, so the guard does exactly one `Bun.env` string comparison and returns `null` immediately — zero `parseKeyFromHeaders`, zero `hashKey`, zero `getApiKeyByHash`, zero `setRequestKeyId`.

Downstream, `middleware.ts`'s new `api_key_id: getRequestKeyId(req)` field: since `setRequestKeyId` is never called on this code path, `getRequestKeyId(req)` returns `undefined` for that `Request` object (no WeakMap entry). In `storage.ts`'s `insertRequest`, the bind value is `r.api_key_id ?? null` — and an **absent** property (pre-PR shape) and an **explicit `undefined`** property (post-PR shape) both evaluate to `undefined` on property access in JS, so `?? null` produces the identical SQL bind (`NULL`) either way. **No behavioral difference, confirmed by direct trace of the nullish-coalescing logic**, not just by the passing test.

Confirmed by runtime evidence too: `__tests__/api-key-dispatch.spec.ts`'s "enforcement OFF: gate is a no-op" test calls `handleRequest` on a gated `/v1/models` path with `REQUIRE_API_KEY` deleted and a stubbed `getApiKeyByHash` primed to return an active key — asserts 200 **and** `expect(lookup).not.toHaveBeenCalled()`. This proves the guard short-circuits before any lookup even when a valid key *would* have been found — dispatch is untouched by the feature's mere presence.

### CLI Correctness (`scripts/create-api-key.ts`)

Traced the file top to bottom:
```
24: const label = process.argv[2]?.trim();          // usage-arg check
31: const pepper = getApiKeyPepper();                // reads env
32: if (!pepper) { ...error...; process.exit(1); }   // FAIL-FAST — before anything else
43: initStorage();                                    // schema guaranteed BEFORE storage use
45: const { prefix, full } = generateKey();
46: const id = insertApiKey({ ..., key_hash: hashKey(full), ... });
54-59: console.log(... full ...)                     // printed exactly once
```
**Confirmed**: the empty-pepper check (line 32) executes strictly before `initStorage()` (line 43) and before `generateKey()`/`insertApiKey()` (lines 45-52) — an empty pepper makes the process `exit(1)` before a database connection is even opened, let alone a key minted. `initStorage()` is called (line 43) before `insertApiKey()` is ever invoked (line 46), satisfying gate-review guardrail #2.

Runtime evidence, not just source reading: `__tests__/create-api-key.spec.ts` spawns the **real** script as a subprocess (`Bun.spawn`) with `API_KEY_PEPPER: ""`. Asserts: exit code ≠ 0, `stderr` contains `"API_KEY_PEPPER"`, and — critically — `stdout` does **not** match the `cpk_<hex>.<hex>` regex and does not even contain the substring `"cpk_"`, i.e., no key material was printed. The happy-path test independently re-derives `hashKey(full)` in the test itself (same pepper, real domain function) and asserts it **equals** the row's persisted `key_hash`, and separately asserts `key_hash` contains neither the full key nor the raw secret substring — a genuine cryptographic correctness check on real subprocess output and a real on-disk SQLite file, not a mocked assertion.

### Usage-Route Security (`/api/telemetry/usage`)

1. **Gated, not exempt**: confirmed in the Predicate Correctness table (row 11) — `/api/telemetry/usage` starts with `/api/`, so it is on the gated surface exactly like every other telemetry route; the dispatch test explicitly names it ("gates the NEW usage route") and asserts 401 with no key.
2. **No key-material leak**: `getUsageByApiKey()`'s SQL (`storage.ts` 401-416) selects only `r.api_key_id, k.prefix, k.label, COUNT(*), SUM(...)` — `key_hash` is never in the `SELECT` list. The `UsageByKey` type (`types.ts` 67-76) structurally has no `key_hash`/secret field at all — it is not merely omitted by convention, it is impossible to serialize by the type. `usage.ts`'s handler passes the query result straight through to `JSON.stringify` with no additional field added. **Confirmed no path exists for this route to leak a hash or plaintext key**, verified at both the SQL and the TypeScript-type level.
3. **Gap found (WARNING, not CRITICAL)**: there is no dispatch-level (`handleRequest`) test that exercises the **pass-through** case for this specific route — i.e., `GET /api/telemetry/usage` with a valid key (or `REQUIRE_API_KEY=false`) asserting a 200 with the real JSON shape via the real route table. The 401 path is dispatch-tested; the handler's own JSON-shaping logic is tested in isolation (`telemetry-usage-route.spec.ts`, bypassing `server.ts`'s routing); but the *specific* `server.ts` line 81 registration (`pathname === "/api/telemetry/usage" → handleTelemetryUsage`) reaching 200 has no dedicated proof — I confirmed it is correct by direct source reading (see quoted line above), but the test suite does not independently prove it the way it does for `/v1/models`. See Issues, W7.

### Test Quality — is "`insertRequest` not called on 401" a real proof or a vacuous one?

This is the single most important test-quality question for this unit, so it got dedicated scrutiny rather than a read-through. `__tests__/api-key-dispatch.spec.ts` mocks via `import * as storage from "../src/observability/storage.ts"` + `spyOn(storage, "insertRequest")`, while the real call site (`middleware.ts`) uses a **named** import (`import { insertRequest } from "./storage.ts"`) — a legitimate question is whether `spyOn` on the namespace object actually intercepts a *different* file's named-import call site, or whether the assertion passes vacuously regardless of the real control flow.

**Resolved with a positive-control proof already present in the same file, executed as part of this verify pass**: the "passes a valid Bearer key... attributes `api_key_id`" test uses the identical mocking pattern (`spyOn(storage, "insertRequest").mockImplementation((rec) => { captured = rec; })`) and asserts `captured!.api_key_id === 7` — a value that can **only** become non-null if the mock's own callback body actually executed inside `middleware.ts`'s real call. I ran this test myself (not read from the report) and it passed. This is direct, runtime, positive proof that `spyOn` on the storage namespace object genuinely intercepts `middleware.ts`'s named-import call site in this Bun/TS setup — not an inference, an observed fact from this session's own test run. Since both tests share the exact same mock mechanism against the exact same call site, this validates that the negative assertion (`expect(ins).not.toHaveBeenCalled()` after a 401) is **equally real**: had the ordering bug existed (guard called too late, or not at all), `withObservability`'s wrapped handler would have run and the spy would have recorded a call, failing the test.

**Verdict: the "not called on 401" assertion is a genuine storage-side-effect check, not a response-code proxy** — and arguably stronger than asserting on real `requests` table row-counts would have been, since it pins down the exact function boundary rather than an indirect row-count side effect. No test-quality violation found. (Minor, non-blocking nuance: no test in this suite exercises the guard + attribution + storage stack against a **real** `:memory:` database end-to-end in one continuous test — everything is proven either at the real-DB unit level (Unit 1) or at the mocked-dispatch level (this unit). Noted as S7, not a defect.)

### Spec Compliance Matrix

Phase 3 wires the guard live — this is where the 5 scenarios Unit 2 marked PARTIAL (decision-logic proven, dispatch not yet wired) become testable at the system/dispatch level.

| Requirement | Scenario | Test | Result |
|-------------|----------|------|--------|
| api-key-auth: API Key Model and Storage | Persisted key row stores only the hash | Unit 1 `api-key-storage.spec.ts` + this unit's `create-api-key.spec.ts` happy-path (independent corroboration via a real CLI-issued row) | ✅ COMPLIANT |
| api-key-auth: Key Generation and Issuance | CLI issues a working key shown once | `create-api-key.spec.ts` (printed-once + digest-only-stored: proven directly) | ⚠️ **PARTIAL** — no single runtime test spans "issue via CLI" → "present that exact key to a real `handleRequest` dispatch" → 200; each link (CLI storage correctness, guard hash+lookup logic, dispatch wiring) is independently proven, but not chained in one test. See Issues, S8. |
| api-key-auth: Fast Hash Validation | Valid key authenticates a gated request | `api-key-dispatch.spec.ts` (Bearer + X-API-Key → 200) combined with Unit 2's `hashKey()` determinism/pepper-sensitivity unit tests | ✅ COMPLIANT |
| api-key-auth: Credential Extraction from Headers | Either header supplies the key | Unit 2 `api-key-domain.spec.ts`/`api-key-guard.spec.ts`, reinforced by this unit's dispatch test (both headers → identical 200 + attribution via real `handleRequest`) | ✅ COMPLIANT |
| api-key-auth: 401 Enforcement Gate | Missing key rejected | `api-key-dispatch.spec.ts` (401 + `insertRequest` not called) | ✅ COMPLIANT |
| api-key-auth: 401 Enforcement Gate | Invalid/revoked key rejected | `api-key-dispatch.spec.ts` (unknown/revoked → 401) | ✅ COMPLIANT |
| api-key-auth: 401 Enforcement Gate | Flag disabled bypasses enforcement | `api-key-dispatch.spec.ts` (flag off → 200, lookup never called) | ✅ COMPLIANT |
| api-key-auth: Exempt Routes | Exempt routes never require a key | `api-key-dispatch.spec.ts` (`/health` 200, `/assets/*` 404-not-401, both with enforcement ON) | ✅ COMPLIANT |
| api-key-usage: Per-Request Key Attribution | Request row attributed to its key | `api-key-dispatch.spec.ts` (`captured.api_key_id === 7` via real `middleware.ts` code path, both header forms) | ✅ COMPLIANT |
| api-key-usage: Aggregated Usage Query | (both scenarios) | Unit 1 `api-key-storage.spec.ts` | ✅ COMPLIANT (unchanged, unaffected by this unit) |
| api-key-usage: Usage Telemetry Route | Usage route returns aggregated totals | `telemetry-usage-route.spec.ts` (shape/window) + `api-key-dispatch.spec.ts` (gating) | ✅ COMPLIANT — union of two real tests proves both halves; see W7 for the one untested sub-case (dispatch-level 200) |
| project-readme | (all) | none | ➖ N/A — Phase 4, not started |

**Compliance summary**: 10/11 in-scope scenarios COMPLIANT (up from 2/9 PARTIAL-heavy in Unit 2 — task 3.6 did exactly what Unit 2's `next_recommended` predicted). 1/11 PARTIAL (Key Generation and Issuance's end-to-end clause). 0 FAILING, 0 UNTESTED.

### Correctness (Static Evidence)

| Requirement | Status | Notes |
|------------|--------|-------|
| `handleRequest(req)` exported, `startServer` uses `{ fetch: handleRequest }` | ✅ Implemented | Confirmed via source + `git diff` (clean extraction) |
| `enforceApiKey` as first try-block statement | ✅ Implemented | See Ordering Proof |
| `/api/telemetry/usage` registered | ✅ Implemented | `server.ts` line 81, gated (starts with `/api/`) |
| `handleTelemetryUsage` exported from `telemetry/index.ts` | ✅ Implemented | One-line diff, correct target file |
| `usage.ts` GET handler, `withObservability`-wrapped | ✅ Implemented | Matches design's DTO shape exactly (`generated_at`, `time_from`, `time_to`, `keys`) |
| `middleware.ts` attribution (`api_key_id: getRequestKeyId(req)`) | ✅ Implemented | Not a numbered task, but required by design's File Changes row and the Per-Request Attribution scenario — correctly delivered, disclosed in apply-progress |
| `scripts/create-api-key.ts` fail-fast + `initStorage()`-first | ✅ Implemented | See CLI Correctness |

### Coherence (Design)

| Decision | Followed? | Notes |
|----------|-----------|-------|
| #1 Hook point: pre-dispatch guard, first stmt in `fetch()` | ✅ Yes | Now LIVE — see Ordering Proof |
| #2 Gated predicate: `/v1/*`\|\|`/api/*`, not `isApiOwned` | ✅ Yes (carried, reconfirmed) | See Predicate Correctness table |
| #5 Attribution transport: `WeakMap` set (guard) / get (middleware) | ✅ Yes | `middleware.ts` now reads it; same `req` identity confirmed by the dispatch test's attribution assertions |
| #6 Config access: call-time env | ✅ Yes (carried) | Unchanged |
| #7 Schema: advisory FK | ✅ Yes (carried) | Unchanged |
| #8 Testability: exported `handleRequest` | ✅ Yes | Delivered exactly as specified; enabled the dispatch test |

### TDD Compliance

| Check | Result | Details |
|-------|--------|---------|
| TDD Evidence reported | ✅ | "TDD Cycle Evidence" table present in apply-progress #824, Batch-3 section, for tasks 3.1-3.6 |
| All tasks have tests | ✅ | 6/6 Phase-3 tasks map to a test file |
| RED confirmed (tests exist) | ✅ | All 3 new files verified on disk; counts independently reconfirmed (2+9+2=13) |
| GREEN confirmed (tests pass) | ✅ | 13/13 new tests pass isolated; 422/422 full suite — both executed independently this session |
| Triangulation adequate | ✅ | Dispatch: 4 reject-401 cases + 2 exempt cases + 2 valid-key cases + 1 flag-off case = 9, each asserting a distinct outcome; usage route: non-empty-window vs empty-window; CLI: fail-fast vs happy-path |
| Safety Net for modified files | ✅ | `server.ts`/`middleware.ts` modifications: full 422/422 suite green including the pre-existing `observability.spec.ts` real-server-spawn test — proves the live-wired guard didn't regress existing dispatch behavior |

**TDD Compliance**: 6/6 checks passed.

---

### Test Layer Distribution

| Layer | Tests | Files | Tools |
|-------|-------|-------|-------|
| Unit | 0 (new, this unit) | 0 | — |
| Integration | 13 (2 route + 9 dispatch + 2 CLI-subprocess) | 3 | `bun:test`, `Bun.spawn` |
| E2E | 0 | 0 | not available in this project |
| **Total (this unit)** | **13** | **3** | |

This unit is integration-heavy by design (per the Testing Strategy table) — appropriate for a wiring/dispatch phase, not a smell.

---

### Assertion Quality

✅ All assertions verify real behavior. Scanned all 3 new files against the banned-pattern list:
- No tautologies, no assertion-free tests, no ghost loops.
- `not.toHaveBeenCalled()` usages (4 occurrences) are genuine behavioral proofs of guard short-circuiting, independently corroborated by the positive-control test in the same file (see Test Quality above) — not implementation-detail coupling.
- CLI test's `stdout`/`stderr` assertions check real subprocess output, and the happy-path test independently recomputes `hashKey(full)` rather than asserting an opaque non-null hash — a real value-level assertion, not a type-only check.
- Mock/assertion ratio in `api-key-dispatch.spec.ts`: ~13 spy creations vs. ~20 `expect()` calls across 9 tests — reasonable, not mock-heavy given this is deliberately an integration/dispatch layer.
- Every `not.toBeNull()`/negative case (e.g., "not 401", "lookup not called") sits beside a positive companion test in the same file.

**Assertion quality**: ✅ 0 CRITICAL, 0 WARNING.

---

### Quality Metrics

**Linter**: ➖ Not available (unchanged from Units 1-2).
**Type Checker**: ⚠️ Same 7 pre-existing errors, zero new. See Build & Tests Execution.

---

### Hallucination Check

| Claim | Verified |
|---|---|
| `handleRequest(req)` in `src/http/server.ts`, exported, `async` | ✅ line 47, exact signature |
| `enforceApiKey` imported + called as first try-block statement | ✅ import line 20, call site line 67-68 |
| `/api/telemetry/usage` route registration | ✅ line 81 |
| `handleTelemetryUsage` export in `telemetry/index.ts` | ✅ line 6 |
| `src/http/routes/telemetry/usage.ts` — `_handleTelemetryUsage` + exported `handleTelemetryUsage = withObservability(...)` | ✅ exists exactly as claimed, lines 19/42 |
| `middleware.ts` — `getRequestKeyId` import + `api_key_id` field | ✅ line 5 import, line 63 field |
| `scripts/create-api-key.ts` — fail-fast pepper check before `initStorage()`/`insertApiKey()` | ✅ lines 31-52, ordering confirmed by direct read |
| "13 new tests (2 route + 9 dispatch + 2 CLI)" | ✅ reproduced exactly via isolated run |
| "422 pass / 0 fail / 1151 expect() across 40 files" | ✅ reproduced exactly |
| "tsc clean except the known 7 pre-existing errors" | ✅ reproduced exactly, same file/line/col triples |
| "insertRequest NOT called on 401" | ✅ asserted via spy on the real call boundary, validated non-vacuous (see Test Quality) |
| Workload estimate "~612 add / 61 del" | ⚠️ Minor inaccuracy — actual `git diff --numstat` + new-file line counts total **607 add / 61 del** (≈1% off, not material) |

**Zero hallucinations on functions/files/test-counts/behavioral claims.** One negligible numeric rounding difference (workload estimate), not a fabrication.

### Scope Check — Phase 3 only? ✅ YES

- Modified (tracked): `src/http/server.ts`, `src/observability/middleware.ts`, `src/http/routes/telemetry/index.ts`, `openspec/changes/api-key-authentication/tasks.md` — all Phase 3 per design's File Changes table.
- New (untracked): `src/http/routes/telemetry/usage.ts`, `scripts/create-api-key.ts`, `__tests__/api-key-dispatch.spec.ts`, `__tests__/telemetry-usage-route.spec.ts`, `__tests__/create-api-key.spec.ts` — exactly the Phase 3 file set.
- `src/domain/api-keys.ts`, `src/guards/api-key.ts` (Phase 2): confirmed **untouched** — absent from `git status`.
- `README.md` (Phase 4): `git diff` empty — untouched.
- `openspec/config.yaml`: `git status --porcelain` returns nothing — untouched by this batch (still carrying Unit 1/2's stale numbers, see Issues W4/W5).
- `tasks.md`: `git diff` shows exactly the 6 Phase-3 boxes flip `[ ]`→`[x]`, Phase-4 boxes still `[ ]` — matches actual code state exactly.
- `.codegraph/` untracked — local tooling index used for this verify pass, not part of the change.

### Discoveries / Recurring Issues Carried From Units 1-2

- **W4/W5 (Unit 2) still open, further stale.** `openspec/config.yaml`'s `Testing:` line still reads `409/409` (real is now **422/422**); `coverage.available: false` is still wrong (still demonstrably works). File confirmed untouched by this batch (not new damage, but now two units further out of date).
- **W6 (Unit 2, theoretical timing side-channel)**: unaffected by this unit (guard/domain untouched), carried forward unchanged.

### Issues Found

**CRITICAL**: None. The core live-wiring claim — 401 short-circuits before any handler/`insertRequest` runs — was independently traced through the actual control flow and confirmed by a non-vacuous runtime test (see Ordering Proof, Test Quality).

**WARNING**:
- **W7 — No dispatch-level happy-path test for the new `/api/telemetry/usage` route specifically.** The 401/reject path is dispatch-tested; the handler's own response-shaping is unit-tested in isolation; but no test does `GET /api/telemetry/usage` through real `handleRequest` with a valid key or `REQUIRE_API_KEY=false` and asserts 200 + JSON shape. I independently confirmed the route registration line (`server.ts:81`) is correct by direct source reading, so real-world risk is low, but this is a genuine gap in the suite's own proof for task 3.2's specific wiring — the other 3 "success" dispatch tests all target `/v1/models`, none target the new route. Recommend a follow-up test before Phase 4 closes out the change.
- **W8 — "Key Generation and Issuance" has no single closed-loop test** spanning CLI-issue → present-to-real-`handleRequest` → 200. Each link (CLI persists the correct HMAC digest; `hashKey` is deterministic; `getApiKeyByHash` correctly matches on a real DB; the guard correctly calls both) is independently proven in different test files/units, and the composition is logically sound, but no single test exercises the full chain. Recommend closing this before final archive if a true end-to-end smoke test is wanted (not blocking — the transitive proof is solid).
- **W4/W5 (carried, Unit 2)** — `openspec/config.yaml` staleness, now further out of date (409/409 shown vs. real 422/422). Non-blocking, documentation-only, not caused by this batch.

**SUGGESTION**:
- **S7 — No single test exercises the guard + attribution + storage stack against a real (non-stubbed) `:memory:` database in one continuous flow.** Real-DB proof exists at the Unit 1 storage layer; dispatch-level proof exists via mocks. Would harden confidence further, not required.
- **S8 — OPTIONS requests bypass `enforceApiKey` entirely** (handled before the `try` block). Standard CORS-preflight practice, returns no data, not a new gap (unchanged position from the pre-PR closure) — noted for completeness of the route enumeration, not a defect.
- **S9 — Workload estimate off by ~1%** (612 claimed vs. 607 actual add lines) — cosmetic.

### Verdict

**PASS WITH WARNINGS** — 0 CRITICAL, 4 WARNING (2 new — both are test-completeness gaps for which I independently substituted manual source verification, not functional defects; 2 carried/worsening documentation staleness from Units 1-2), 3 SUGGESTION. All 6 Phase-3 tasks are genuinely complete: the live-wiring ordering claim was traced statement-by-statement through the actual control flow (not trusted from the summary) and corroborated by a runtime test proven non-vacuous via a positive-control assertion in the same file; every route in `server.ts` was enumerated and classified gated/exempt against the actual `isGated`/`isApiOwned` predicates; flag-off safety was traced through the nullish-coalescing chain to a byte-for-byte identical pre-PR dispatch; the CLI's fail-fast-before-mint ordering was confirmed both by source and by a real subprocess spawn test that inspects a real SQLite file; the usage route was confirmed incapable of leaking key material at both the SQL and TypeScript-type level. Zero hallucinations (one negligible ~1% line-count rounding difference). This is the highest-risk unit in the change and it holds up under adversarial re-derivation.

**next_recommended**: Proceed to Phase 4 apply (README documentation) — the only remaining phase. Recommend addressing W7 (dispatch-level happy-path test for `/api/telemetry/usage`) and W8 (CLI-to-dispatch closed-loop test) at some point before final archive, and finally resolving the now twice-carried W4/W5 `openspec/config.yaml` staleness. None of these block Phase 4.

---

*Gatekeeper note (cumulative): this document now covers Units 1-3 / PRs 1-3 (Foundation, Core Auth, Integration), all three independently verified PASS WITH WARNINGS with 0 CRITICAL findings across all three adversarial passes. As of Unit 3, `enforceApiKey` is LIVE in `fetch()` — end-to-end request authentication now genuinely exists in this codebase and defaults to OFF (`REQUIRE_API_KEY=false`), confirmed behavior-identical to pre-PR dispatch when off. Unit 4 (README documentation) remains unimplemented — purely additive, non-functional, low risk. No CRITICAL security findings have been raised against the auth gate across any of the three units verified so far.*
