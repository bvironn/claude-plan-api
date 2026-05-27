# Verify report — account-profile-extra-usage-coverage

> Hybrid artifact (OpenSpec + Engram). Mirror of the
> `sdd/account-profile-extra-usage-coverage/verify-report` Engram observation.
> This is an **independent** verification — every claim from `apply-progress.md`
> was reproduced, not trusted.

## Verdict: **PASS**

- Scope suite: ✅ 21 pass / 0 fail (reproduced; matches apply).
- Full suite: ✅ 262 pass / 2 fail (reproduced; the 2 failures are
  pre-existing Windows-environment issues, NOT regressions — verified
  independently below).
- Type-check (`bun run tsc --noEmit`): ✅ EXIT=0.
- Requirements coverage: ✅ 5/5 spec requirements (R1..R5) mapped to passing tests.
- Out-of-scope adherence: ✅ zero changes under `src/`. Diff lives entirely
  in `__tests__/` and `openspec/changes/account-profile-extra-usage-coverage/`.
- Strict-TDD discipline: ✅ one commit per task, conventional-commit messages,
  no production code touched, no test rewrites that erase prior coverage.

No CRITICAL findings. One minor SUGGESTION (documentation polish on the
module-reset utility). Safe to archive.

## Mode

- `execution_mode`: `auto`
- `artifact_store.mode`: `both` (hybrid — OpenSpec file + Engram observation)
- `strict_tdd`: **active** (test runner: `bun test`). Strict-TDD verify rules
  applied per `~/.config/opencode/skills/sdd-verify/strict-tdd-verify.md` —
  every requirement was independently re-mapped to a passing test, the apply
  phase's claims were treated as adversarial input.

## Completeness — task status from `tasks.md`

| Task | Title | Status | Commit | Verified |
|------|-------|--------|--------|----------|
| 1.1 | R1 `true` propagation end-to-end | `[x]` | `cb6d553` | ✅ |
| 1.2 | R2 strict gating extra cases | `[x]` | `57b8b95` | ✅ |
| 1.3 | R3 log emit shape | `[x]` | `f58d4a2` | ✅ |
| 1.4 | R4 inflight dedup | `[x]` | `b53c314` | ✅ |
| 1.5 | R5 cache-hit + refresh bypass | `[x]` | `5237127` | ✅ |
| 1.6 | shared helpers extraction | `[~] DROPPED` | — | ✅ (trigger condition correctly unmet) |
| 2.1 | `bun test` green | `[x]` | — | ✅ (re-run independently) |
| 2.2 | `bun run tsc --noEmit` EXIT=0 | `[x]` | — | ✅ (re-run independently) |
| 2.3 | forecast still holds | `[x]` | — | ✅ (296 LOC < 400 budget) |
| post | TSC fix for R3 filter callbacks | n/a | `ef97f21` | ✅ (required for `tsc --noEmit` to pass; targeted) |

T1.6 drop is **correct**: per the task's own trigger ("BOTH duplicated
`mock.module` reset AND duplicated `spyOn(logger, "emit")`"), only R3 spies
on `emit`; R4 and R5 do not. The `loadFreshAccountModule()` utility landed
inline at the top of `__tests__/domain-account-profile.spec.ts` and is
reused by R3/R4/R5 directly. No separate helpers file warranted.

## Build / Tests / Type-check evidence

### Scope suite (re-run during verify)

```
$ bun test __tests__/domain-account-profile.spec.ts __tests__/http-routes-account.spec.ts
 21 pass
 0 fail
 74 expect() calls
Ran 21 tests across 2 files. [211.00ms]
```

### Full suite (re-run during verify)

```
$ bun test
 262 pass
 2 fail
Ran 264 tests across 20 files. [2.03s]
```

Failing tests (named for traceability):

1. `__tests__/observability.spec.ts` — unnamed (fails in `beforeAll`).
2. `__tests__/telemetry-upstream-body.spec.ts` — `storage — upstream_request_body column > REQ-2: ensureColumn migration is idempotent on a pre-existing DB without the column`.

### Type-check

```
$ bun run tsc --noEmit
EXIT=0
```

## Requirement → Test traceability matrix (R1..R5)

Strict-TDD requirement: each spec SHALL must be demonstrably exercised by a
passing test. Five rows, all green.

| Req | Spec scenario | Test name | File | Lines | Result |
|-----|---------------|-----------|------|-------|--------|
| R1 | Upstream `true` reaches the HTTP response (boolean, not `"true"`) | `hasExtraUsageEnabled: true reaches the HTTP response body as JSON boolean` | `__tests__/http-routes-account.spec.ts` | 107-128 | ✅ PASS |
| R1 | Domain layer surfaces `true` (strict boolean identity) | `has_extra_usage_enabled: true propagates as strict boolean true` | `__tests__/domain-account-profile.spec.ts` | 164-174 | ✅ PASS |
| R2 | String `"true"` rejected; numeric `1` rejected; missing key → false; literal `true` accepted; `null` → false; string `"false"` → false; literal `false` → false | `has_extra_usage_enabled is false unless upstream sends literal true` | `__tests__/domain-account-profile.spec.ts` | 133-151 | ✅ PASS (7 assertions cover all 7 input shapes) |
| R3 | Success-path: exactly one `account.profile.fetched` info event with six named keys, `hasExtraUsageEnabled` matches normalized boolean | `success path emits exactly one account.profile.fetched info event with the six named keys` | `__tests__/domain-account-profile.spec.ts` | 229-251 | ✅ PASS |
| R3 | Failure-path: non-2xx upstream → no `account.profile.fetched` info emission | `failure path (non-2xx upstream) does NOT emit account.profile.fetched` | `__tests__/domain-account-profile.spec.ts` | 253-261 | ✅ PASS |
| R4 | Two concurrent calls share one fetch and return same reference (`===`) | `two concurrent ensureProfile() calls share one fetch and return the same reference` | `__tests__/domain-account-profile.spec.ts` | 295-322 | ✅ PASS |
| R4 | `inflight` slot clears after settle | `inflight slot clears after settle so a later cold call fires a new fetch` | `__tests__/domain-account-profile.spec.ts` | 324-345 | ✅ PASS |
| R5 | Second `ensureProfile()` is a cache hit (no upstream fetch, same reference) | `second ensureProfile() is a cache hit — no upstream fetch, same reference` | `__tests__/domain-account-profile.spec.ts` | 383-394 | ✅ PASS |
| R5 | `refreshProfile()` always bypasses cache and replaces reference | `refreshProfile() bypasses the cache — always fetches and replaces` | `__tests__/domain-account-profile.spec.ts` | 396-411 | ✅ PASS |

**Coverage**: 5/5 requirements, 9 covering tests, 0 untested SHALL clauses.

### Independent corroboration of each requirement against production code

Per strict-TDD verify protocol, each test was cross-referenced to the
unchanged production code at `src/domain/account.ts` to ensure the test
actually exercises the claimed behavior (and is not a tautology).

- **R1**: production check at `src/domain/account.ts:148`
  (`hasExtraUsageEnabled: org.has_extra_usage_enabled === true`). The R1
  domain test sends `true` and asserts `=== true`, then `typeof === "boolean"`.
  The HTTP test verifies the same value survives JSON serialization. Not a
  tautology — both ends of the pipeline are exercised.
- **R2**: same `=== true` gate at line 148. The R2 test asserts on 7 input
  shapes (`true`, `1`, `"true"`, missing, `null`, `"false"`, `false`). All
  6 non-`true` values must coerce to `false`. The strict-`===` check in
  production is what makes them all coerce — no `??` fallback, no truthy
  cast. Test passes by construction; behavior is locked.
- **R3**: production `emit("info", "account.profile.fetched", {...})` at
  `src/domain/account.ts:108-115` emits exactly the six required keys.
  Failure-path at lines 101-104 short-circuits with a `warn`-level
  `account.profile.fetch.failed`, never reaching the success emit. Both
  scenarios match the spec verbatim.
- **R4**: production inflight pattern at `src/domain/account.ts:64-69`:
  `if (cachedProfile) return cachedProfile; if (inflight) return inflight;
  inflight = fetchProfile().finally(() => { inflight = null; });`. The
  R4 test kicks off two `ensureProfile()` calls **synchronously** before
  any `await`, guaranteeing both observe the inflight slot deterministically.
  Second test forces a `refreshProfile()` after settle to prove the slot
  cleared (otherwise refresh would dedup against a leftover pending promise).
- **R5**: production cache check at `src/domain/account.ts:65`
  (`if (cachedProfile) return cachedProfile`) provides the hot path;
  `refreshProfile()` at lines 75-79 always calls `fetchProfile()` and
  replaces `cachedProfile`. Both scenarios exercise these branches directly.

## Out-of-scope adherence

```
$ git diff --stat 568ce17..HEAD
 __tests__/domain-account-profile.spec.ts           | 275 ++++++++++++++++++++-
 __tests__/http-routes-account.spec.ts              |  23 ++
 openspec/changes/.../apply-progress.md             | 155 ++++++++++++
 openspec/changes/.../exploration.md                | 272 ++++++++++++++++++++
 openspec/changes/.../proposal.md                   | 124 ++++++++++
 openspec/changes/.../specs/account-profile/spec.md | 140 +++++++++++
 openspec/changes/.../tasks.md                      | 119 +++++++++
 7 files changed, 1106 insertions(+), 2 deletions(-)
```

```
$ git diff 568ce17..HEAD -- src/ | wc -l
 0
```

- ✅ No changes to `src/domain/account.ts` — production behavior unchanged.
- ✅ No changes to `src/upstream/beta-exclusion.ts`, `src/upstream/anthropic-client.ts`,
  or any other file under `src/`.
- ✅ All diff is confined to `__tests__/` (test additions) and
  `openspec/changes/account-profile-extra-usage-coverage/` (SDD docs).
- ✅ `AccountProfile` interface (`src/domain/account.ts:14-22`) unchanged —
  no `hasExtraUsageEnabled` alias was added at the account level, honoring
  the org-scoped contract documented in `spec.md` design notes.

## Windows-env failure verification (independent corroboration)

The full suite shows 2 failures. The apply phase claims these are
pre-existing Windows-environment issues, NOT regressions caused by this
change. Verification:

### 1. `__tests__/observability.spec.ts`

```
$ git diff 568ce17..HEAD -- __tests__/observability.spec.ts
(empty — file unchanged from baseline)
```

File content (line 16):
```ts
await Bun.$`fuser -k ${PORT}/tcp`.nothrow();
```
`fuser` is a Linux-only utility. On Windows, `Bun.$` cannot resolve the
command and the `beforeAll` hook fails, causing every test in the file to
report as `(unnamed)` failure. The `.nothrow()` does not help because the
spawn itself errors before the chain has a chance to ignore the exit code.

**Verdict**: pre-existing environmental failure. Not caused by this
change. Same file content at baseline `568ce17`.

### 2. `__tests__/telemetry-upstream-body.spec.ts`

```
$ git diff 568ce17..HEAD -- __tests__/telemetry-upstream-body.spec.ts
(empty — file unchanged from baseline)
```

File content (line 49):
```ts
Bun.spawnSync(["mkdir", "-p", logsDir]);
```
`mkdir -p` is a Unix idiom — Windows `mkdir` doesn't accept `-p`. The
spawn returns non-zero; downstream `new Database(dbPath)` then fails to
open because the `logs/` directory was never created. Only `REQ-2` fails
because it's the test that exercises this code path; the other tests in
the file use `mkdtempSync` instead and pass.

**Verdict**: pre-existing environmental failure. Not caused by this
change. Same file content at baseline `568ce17`.

### Net result

Both failing tests live in files that this change **did not touch** (zero
lines diff vs baseline). Both failures are caused by Linux/Unix-only
shell utilities invoked from Bun, with no Windows fallback. These should
be tracked as `KNOWN-ISSUE` (out-of-scope environmental noise), not
treated as regressions of this change.

## Strict-TDD discipline checks

| Check | Result |
|-------|--------|
| No production code modified to make tests pass | ✅ `git diff 568ce17..HEAD -- src/` is empty |
| One commit per task | ✅ 5 commits map 1:1 to T1.1–T1.5; `ef97f21` is a narrow TSC follow-up; `c78ca51` is SDD doc consolidation |
| Conventional-commit messages | ✅ all 5 task commits use `test(account-profile): …`; TSC fix uses `test(account-profile): …` (acceptable — narrow scope) |
| No commit conflates multiple tasks | ✅ each task commit touches only the test code for its requirement |
| No commit rewrites earlier tests | ✅ T1.2 is the only "extension" commit and it only appends assertions to an existing test, preserving prior coverage |
| Each test maps to a SHALL clause | ✅ see traceability matrix above |
| RED→GREEN honest | ✅ apply documented `loadFreshAccountModule()` exists because the cache test would otherwise see a polluted module from earlier tests. Production code passes the new assertions without modification — exactly the "inversion" the orchestrator brief described. |

## Risk follow-up (from apply's flagged risks)

### Risk 1 — R4 inflight dedup flake-risk

**Verified.** The R4 test uses a deferred-promise pattern (`new Promise((resolve) => { resolveFetch = resolve; })`)
to hold the fetch open while both `ensureProfile()` calls register. No
`setTimeout`, no `setImmediate`, no time-based sleep. The synchronous
kickoff (`const callA = ensureProfile(); const callB = ensureProfile();`)
guarantees both calls observe the inflight slot before any microtask
boundary. The final assertions are on `fetchSpy.mock.calls.length` and
`===` identity — not timing. **Verdict**: deterministic. No WARNING.

### Risk 2 — Module-reset utility `loadFreshAccountModule()` is novel

**Verified.** Lives inline at lines 5-15 of
`__tests__/domain-account-profile.spec.ts`, NOT exported, NOT in a shared
helpers file. Has a 6-line documentation comment explaining the
`?v=${counter}` cache-bust trick and why it works against Bun's ESM
loader. Used by R3, R4, R5 (the requirements that need module-level
state reset). Logger spies still work because the re-imported module
still pulls `emit` from the canonical `../src/observability/logger.ts`
module — verified by the R3 success test passing.

**Verdict**: contained. Single-file helper, well-commented. If Bun ever
changes loader behavior (low likelihood — `?v=N` cache-busting is a
documented escape hatch), the fix is localized to one ~14-LOC block.
No WARNING; flagged as SUGGESTION for documentation polish (see below).

### Risk 3 — LOC overshoot vs forecast (296 vs 100-140)

**Verified.** `git diff --stat 568ce17..HEAD` shows +275 in
`domain-account-profile.spec.ts` and +23 in `http-routes-account.spec.ts`
for a test net delta of ~+298. The overshoot is driven by:

1. Per-describe `beforeEach`/`afterEach` boilerplate (R3, R4, R5 each
   need their own credentials + fetch spy setup, ~12-15 LOC each).
2. The `loadFreshAccountModule()` utility itself (14 LOC including
   the explanatory comment).
3. The R3 success test is verbose because it asserts six payload keys
   explicitly to lock the contract.

**No scope creep observed**: every added line is part of a test for a
spec requirement. Total still 296 < 400 review budget. **Verdict**:
boilerplate overshoot, not scope creep. No WARNING.

## Findings

### CRITICAL
*(none)*

### WARNING
*(none)*

### SUGGESTION

1. **`loadFreshAccountModule()` comment could mention the bun-version compat.**
   The current comment at `__tests__/domain-account-profile.spec.ts:5-10`
   explains the `?v=N` trick well. It does NOT mention which Bun versions
   are known to support this behavior, which would help future maintainers
   diagnose a regression if Bun's ESM loader ever stops honoring query-
   string cache busts. Suggested addition (one line):
   `// Tested on Bun 1.3.x; if a future Bun release changes ESM loader cache keys, fall back to mock.module()`.
   **Severity**: cosmetic. Does NOT block archive.

## Coherence with spec / design / proposal

- **Spec ↔ tests**: 5/5 requirements covered; each SHALL clause has at
  least one passing test (see traceability matrix). The spec's "Tests"
  table at `spec.md:117-123` matches the actual test file locations.
- **Design notes ↔ implementation**:
  - "Org-scoped flag, not account-scoped" — respected; `AccountProfile`
    interface unchanged, no alias added.
  - "Coverage means tests, not tooling" — respected; no c8/istanbul,
    no `coverage.available` flip.
  - "ES-module cache caveat" — addressed via `loadFreshAccountModule()`
    rather than the spec-prohibited `?refresh=1` workaround. ✅
- **Proposal ↔ delivery**: single PR, test-only, 5 atomic commits per
  requirement + 1 TSC fix. Forecast was single-pr; delivered as single-pr.
  Workload (296 LOC) under the 400 review budget. ✅

## Persistence

- **OpenSpec file**: `openspec/changes/account-profile-extra-usage-coverage/verify-report.md` (this file).
- **Engram**: topic_key `sdd/account-profile-extra-usage-coverage/verify-report`, written via `mem_save` with `capture_prompt: false`.

## Next recommended phase

**`sdd-archive`** — verify is green (PASS, no warnings, no criticals).
The change is ready to be archived (delta specs synced into the main
`openspec/specs/account-profile/` capability). Archive should:

1. Promote the 5 ADDED requirements from
   `openspec/changes/account-profile-extra-usage-coverage/specs/account-profile/spec.md`
   into the live capability spec at
   `openspec/specs/account-profile/` (creating it if it doesn't exist
   under the live tree).
2. Move the change folder to the archive location.
3. Update any change-registry index if present.

The two pre-existing Windows env failures are out-of-scope for this
change; they could be tracked as a separate `windows-test-env-coverage`
proposal but should NOT block archive of this change.

## Residual risks for future maintenance

1. **`loadFreshAccountModule()` depends on a Bun loader behavior**
   (query-string cache busting). If a future Bun release changes ESM
   cache-key resolution, R3/R4/R5 may stop resetting properly and the
   tests would start interfering with each other. Mitigation already in
   place: utility is 14 LOC in one block; fallback to `mock.module` is
   straightforward.

2. **Windows-only contributors will continue to see 2 full-suite
   failures.** These are pre-existing and not introduced here, but they
   add noise to the verify gate. A follow-up to make `observability.spec.ts`
   and `telemetry-upstream-body.spec.ts` cross-platform would clean this
   up — out of scope for this change.

3. **R4's deterministic guarantee relies on Bun's microtask ordering.**
   The synchronous double-kickoff of `ensureProfile()` only works because
   both calls register on the inflight slot before the awaiting microtask
   runs. This is standard JS spec behavior and not Bun-specific, but if
   a future JS engine quirk changed ordering, R4 could become flaky.
   Mitigation: the assertion is on `fetchSpy.mock.calls.length === 1`,
   which fails loudly rather than silently.
