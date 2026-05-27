# Tasks: AccountProfile extra-usage coverage hardening

> **Framing**: 5 atomic test-only work units, one per spec requirement (R1..R5).
> All production code at `src/domain/account.ts` and `src/http/routes/account.ts`
> is **untouched**. Strict TDD reinterpreted: "RED" = demonstrate the gap (assert
> against current behavior expecting the new test to be absent or failing in a
> way that proves coverage was missing). "GREEN" = the existing production code
> already satisfies the assertion (this change adds **tests, not behavior**).
> If any RED step exposes a real production bug, STOP and escalate to
> `needs-user-clarification` — do NOT silently expand scope.

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~120 (range: 100-140) |
| Estimated files touched | 2 |
| 400-line budget risk | Low |
| Chained PRs recommended | No |
| Suggested split | single PR |
| Delivery strategy | auto-forecast → single-pr |
| Chain strategy | pending |

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: pending
400-line budget risk: Low

**Rationale**: Five focused test additions across two existing `__tests__/`
files. Largest individual task (~35 LOC for R5 with module-reset utility)
stays well under the budget. No production code, no docs, no migrations —
nothing inflates the diff. Single PR keeps the test-coverage story coherent
for the reviewer.

### Suggested Work Units

| Unit | Goal | Likely PR | Notes |
|------|------|-----------|-------|
| 1 | All 5 test units land together | PR 1 | Single coherent "coverage hardening" PR; commits split per task for review story |

## Phase 1: Coverage Tasks (one per spec requirement)

- [x] **1.1** `test(account): cover hasExtraUsageEnabled true propagation end-to-end` — **R1**
  - **Files**: `__tests__/domain-account-profile.spec.ts` (+~12 LOC), `__tests__/http-routes-account.spec.ts` (+~13 LOC). Inline fixture override (no new fixtures file yet).
  - **RED**: confirm no current test asserts `hasExtraUsageEnabled === true` reaching the HTTP body or `FullProfile.organization`. Grep first; if any partial covers it, abandon and document.
  - **GREEN**: add a domain test that calls `__normalizeProfileForTests` with `organization.has_extra_usage_enabled: true` and asserts `p.organization.hasExtraUsageEnabled === true` (strict `===`, not truthy). Add an HTTP test using a local UPSTREAM_PROFILE_TRUE variant where `fetchSpy` returns the payload with the flag set to `true`; assert `(body.organization as any).hasExtraUsageEnabled === true`.
  - **Refactor**: none expected. Do NOT extract a shared `withExtraUsageEnabled()` helper yet — premature.
  - **Rollback**: revert this task's diff in both spec files; no other test depends on it.
  - **Review weight**: S

- [x] **1.2** `test(account): extend strict gating cases for hasExtraUsageEnabled` — **R2**
  - **Files**: `__tests__/domain-account-profile.spec.ts` lines 120-129 (extend existing block, +~6 LOC).
  - **RED**: confirm current block covers `true`, `1`, `"true"`, missing key. Verify it does NOT cover `null`, `"false"`, and `false` literal. Run `bun test` to baseline.
  - **GREEN**: append three assertions to the existing `has_extra_usage_enabled gates on strict true` test:
    - `normalize({ organization: { has_extra_usage_enabled: null } }).organization.hasExtraUsageEnabled === false`
    - `normalize({ organization: { has_extra_usage_enabled: "false" } }).organization.hasExtraUsageEnabled === false`
    - `normalize({ organization: { has_extra_usage_enabled: false } }).organization.hasExtraUsageEnabled === false`
  - **Refactor**: rename the test to `has_extra_usage_enabled is false unless upstream sends literal true` if the new shape outgrows the old title.
  - **Rollback**: revert the appended `expect()` lines.
  - **Review weight**: S

- [x] **1.3** `test(account): cover account.profile.fetched log emit shape` — **R3**
  - **Files**: `__tests__/domain-account-profile.spec.ts` (+~28 LOC, new `describe` block).
  - **RED**: no current spec asserts the `account.profile.fetched` info event payload. Confirm via grep.
  - **GREEN**: new `describe("account.fetchProfile — log emit shape", …)` block. Spy on `emit` from `../src/observability/logger.ts`. Mock `getCredentials` and `globalThis.fetch` (mirror the pattern from `http-routes-account.spec.ts:30-48`). Call `ensureProfile()`. Filter `emitSpy.mock.calls` for `args[1] === "account.profile.fetched"`; assert exactly one match, level is `"info"`, and the payload contains keys `accountUuid`, `organizationUuid`, `organizationType`, `subscriptionStatus`, `rateLimitTier`, `hasExtraUsageEnabled`. Additional scenario: on `res.ok === false`, assert NO `account.profile.fetched` info emission for that call.
  - **Refactor**: if R4/R5 also spy on `emit`, lift a small `spyEmit()` helper into Task 1.6. Otherwise keep inline.
  - **Rollback**: revert the new `describe` block; standalone.
  - **Review weight**: M
  - **Notes**: this task **shares cache-pollution risk** with Tasks 1.4-1.5 (see Task 1.6). Run it before R4/R5 if possible.

- [x] **1.4** `test(account): cover inflight dedup of concurrent ensureProfile calls` — **R4**
  - **Files**: `__tests__/domain-account-profile.spec.ts` (+~32 LOC, new `describe` block).
  - **RED**: no current spec asserts that two concurrent `ensureProfile()` calls trigger exactly one upstream fetch. Confirm via grep.
  - **GREEN**: new `describe("account.ensureProfile — inflight dedup", …)`. In `beforeEach`, reset the `account` module (`mock.module("../src/domain/account.ts", …)` OR dynamic re-import — see Task 1.6 utility). Build a fetch mock backed by a manually-resolved `Promise<Response>` (capture the `resolve` fn). Issue `const [a, b] = await Promise.all([ensureProfile(), ensureProfile()]); resolve(response);` — invert the order so both calls register `inflight` before the response settles. Assert `fetchSpy.mock.calls.length === 1` and `a === b` (same reference). Second scenario: after settle, clear the cache (next task's utility), call `ensureProfile()` again, assert a new fetch fires (`inflight` slot cleared).
  - **Refactor**: timing-sensitive — use deferred Promise pattern, not `setTimeout`. If flake observed, instrument with `await Promise.resolve()` ticks; do NOT introduce `bun:test --timeout`.
  - **Rollback**: revert the new `describe`; standalone unless Task 1.6 lands.
  - **Review weight**: M
  - **Notes**: ⚠️ **Highest flake risk** in this batch. If GREEN reveals dedup is actually broken in production (more than 1 fetch), STOP and escalate.

- [x] **1.5** `test(account): cover cache-hit no-fetch and refreshProfile always-fetch` — **R5**
  - **Files**: `__tests__/domain-account-profile.spec.ts` (+~35 LOC, new `describe` block).
  - **RED**: no current spec asserts the cold→hot→no-fetch path for `ensureProfile()` at the domain unit level. The HTTP route specs work around it with `?refresh=1` (see comment at `__tests__/http-routes-account.spec.ts:39-41`). Confirm.
  - **GREEN**: new `describe("account.ensureProfile — cache hit", …)`. In `beforeEach`, fully reset the `account` module so `cachedProfile` and `inflight` are both null (use the Task 1.6 utility or inline `await mock.module("../src/domain/account.ts", …)`). Test 1 (cache hit): call `ensureProfile()` once (cold), then `fetchSpy.mockClear()`, then call again (hot); assert `fetchSpy.mock.calls.length === 0` and the second result `=== first result`. Test 2 (`refreshProfile` bypass): with cache populated, call `refreshProfile()`; assert exactly one new fetch and the cache reference is replaced.
  - **Refactor**: if Task 1.6 is in play, consume its `resetAccountModule()` helper.
  - **Rollback**: revert the new `describe`; standalone unless Task 1.6 lands.
  - **Review weight**: M
  - **Notes**: documented in spec design notes (`spec.md:136-140`) — bun:test ES-module caching is the root cause. The `?refresh=1` workaround MUST NOT be used here; reset the module instead.

- [~] **1.6** *(conditional, DROPPED)* `test(account): extract shared resetAccountModule and spyEmit helpers` — cross-cutting

  **Decision (apply)**: DROPPED per the task's own trigger condition. R3 is the only block that spies on `emit`; R4 and R5 do not. The AND-clause "duplicated `mock.module` reset boilerplate **AND** duplicated `spyOn(logger, "emit")` setup" is unmet. The `loadFreshAccountModule()` helper landed inline at the top of `__tests__/domain-account-profile.spec.ts` (introduced in T1.3) and is reused by T1.4 and T1.5 already — no separate helpers file justified.
  - **Trigger condition**: ONLY add this task if Tasks 1.3, 1.4, and 1.5 end up with duplicated `mock.module` reset boilerplate **AND** duplicated `spyOn(logger, "emit")` setup. If only one pair duplicates, inline it instead.
  - **Files**: `__tests__/_helpers/account.ts` (new, +~25 LOC); refactor Tasks 1.3/1.4/1.5 to import from it (net delta ~-15 LOC across the three).
  - **RED**: not applicable — pure refactor. Run full `bun test` before and after; identical green output.
  - **GREEN**: extract `resetAccountModule()` (mocks the module map) and `spyEmit()` (returns `{ spy, calls: () => spy.mock.calls.filter(c => c[1] === eventName) }`).
  - **Refactor**: this IS the refactor.
  - **Rollback**: revert helpers file and inline the calls back into 1.3-1.5.
  - **Review weight**: S
  - **Notes**: justify-or-drop. If you reach Task 1.6 planning and the duplication is < 3 lines per task, **drop this task** — the helpers would be premature abstraction.

## Phase 2: Verification

- [x] **2.1** Run `bun test` — all 5 (or 6) new tests green; no pre-existing test regressed.
- [x] **2.2** Run `bun run tsc --noEmit` — `EXIT=0`. Ensure no new `any` leaks or missing type imports in the test helpers.
- [x] **2.3** Confirm review-workload forecast still holds (`git diff --shortstat` on the branch tip).

## Dependency Order

`1.1 → 1.2` (independent, can run in any order). `1.3 → 1.4 → 1.5` (share module-reset infrastructure; running in this order minimizes cache pollution between describe blocks). `1.6` (if needed) lands **last** after 1.3-1.5 are green. Phase 2 always last.

## Notes on Strict TDD in a Test-Only Change

The "implementation IS tests" inversion means each task's commit story should
be: (1) the test added (RED in the sense that absence-of-coverage is the
defect being fixed), (2) optional refactor commit only if shared infra
emerges. Do NOT split each task into "red commit then green commit" — that
ceremony adds noise without surfacing real failures. The atomic work unit
per `work-unit-commits` IS the single commit that adds the test for one
requirement.
