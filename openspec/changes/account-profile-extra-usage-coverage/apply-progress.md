# Apply progress — account-profile-extra-usage-coverage

> Hybrid artifact (OpenSpec + Engram). This is the on-disk mirror of the
> `sdd/account-profile-extra-usage-coverage/apply-progress` Engram observation.

## Status: complete — ready for verify

All five coverage tasks (T1.1–T1.5) shipped as atomic commits. T1.6 was
evaluated and **dropped** per its own trigger condition (the AND-clause was
unmet). Phase 2 verification (`bun test` + `bun run tsc --noEmit`) is green
modulo two pre-existing Windows environment failures that have nothing to do
with this change.

## Tasks completed (Phase 1)

| Task | Requirement | Commit | LOC | Notes |
|------|-------------|--------|-----|-------|
| T1.1 | R1 — `true` propagation end-to-end | `cb6d553` | +35 (domain +12, route +23) | Two tests: domain `normalize` strict-bool assertion + HTTP body asserts `org.hasExtraUsageEnabled === true` and `typeof === "boolean"`. |
| T1.2 | R2 — strict gating extra cases | `57b8b95` | +10 / -1 | Extended the existing `has_extra_usage_enabled gates on strict true` test with `null`, `"false"`, and literal `false` assertions; renamed for clarity. |
| T1.3 | R3 — log emit shape | `f58d4a2` | +101 / -1 | New describe block with success-path and failure-path tests. Introduced the `loadFreshAccountModule()` utility (uses Bun's `import("…?v=N")` loader trick to force module re-evaluation). |
| T1.4 | R4 — inflight dedup | `b53c314` | +84 | New describe block. Deferred-promise pattern guarantees both `ensureProfile()` calls register on the inflight slot BEFORE the upstream fetch settles. Asserts `fetch` count === 1 and `a === b`. Second test proves the inflight slot clears via a forced `refreshProfile()`. |
| T1.5 | R5 — cache hit + refresh bypass | `5237127` | +66 | New describe block. Cold→hot test asserts `fetch` count === 0 on the second `ensureProfile()` and `===` identity. Refresh test asserts `refreshProfile()` always fetches and replaces the cache reference. |
| (post) | TSC fix | `ef97f21` | +2 / -2 | Typed `emitSpy.mock.calls as unknown[][]` to clear two TS7006 errors in R3 filter callbacks. |

## Tasks evaluated and dropped

- **T1.6 (extract shared `resetAccountModule` + `spyEmit` helpers)** —
  **dropped**. Trigger condition required BOTH duplicated module-reset
  boilerplate AND duplicated `spyOn(logger, "emit")` setup across T1.3/T1.4/
  T1.5. Only T1.3 spies on `emit`; T1.4 and T1.5 don't. The
  `loadFreshAccountModule()` helper landed inline at the top of the spec
  file (in T1.3) and is reused by T1.4 and T1.5 already — no helpers file
  warranted.

## TDD Cycle Evidence

Strict TDD here is **inverted** per the orchestrator brief: the gap in
coverage IS the defect. "RED" = absence of coverage demonstrated before
adding the test. "GREEN" = the test asserts a contract that existing
production code already satisfies (no behavior change). "REFACTOR" = the
shared `loadFreshAccountModule()` utility introduced once in T1.3 and reused.

| Task | RED (gap demonstrated) | GREEN (test passes against unchanged prod code) | REFACTOR |
|------|-------------------------|--------------------------------------------------|----------|
| T1.1 | Grep confirmed no prior test asserted `hasExtraUsageEnabled === true` reaching HTTP body or `FullProfile.organization`. | Domain + HTTP tests both pass against `src/domain/account.ts:148` (`org.has_extra_usage_enabled === true`) and route serialization unchanged. | None — inline fixture override per tasks.md guidance. |
| T1.2 | Existing gating test only covered `true`, `1`, `"true"`, missing key. `null`, `"false"`, literal `false` were uncovered. | Three new assertions all pass against the same strict `=== true` check at `account.ts:148`. | Test title renamed to better describe the contract. |
| T1.3 | No prior spec asserted the `account.profile.fetched` info event shape (confirmed via grep). | `emit("info", "account.profile.fetched", payload)` at `account.ts:108-115` already emits all six required keys. Failure-path also already short-circuits at `account.ts:101-104` (warn-level `account.profile.fetch.failed`) without the info emit. | Introduced `loadFreshAccountModule()` utility (used by T1.4 and T1.5 too). |
| T1.4 | No prior spec asserted concurrent-call dedup. | Production code at `account.ts:64-69` already implements the inflight pattern correctly — both concurrent calls observe the `inflight` slot, share the promise, and `finally(() => { inflight = null })` clears the slot. | Reused `loadFreshAccountModule()` from T1.3. |
| T1.5 | No prior unit-level cache-hit test (HTTP specs worked around it with `?refresh=1`). | Production cache check at `account.ts:65` (`if (cachedProfile) return cachedProfile`) already provides the cache-hit path; `refreshProfile()` at `account.ts:75-79` always calls `fetchProfile()` and replaces the cache. | Reused `loadFreshAccountModule()`. |

**No latent bug was uncovered.** Every test transitioned RED → GREEN
honestly against the current production code. Strict TDD escalation
contract was respected.

## Files touched

| File | LOC change | Action |
|------|------------|--------|
| `__tests__/domain-account-profile.spec.ts` | +274 / -1 (net +273) | Modified — added `loadFreshAccountModule()` utility, R1 single-test, R2 extra assertions, R3/R4/R5 new describe blocks. |
| `__tests__/http-routes-account.spec.ts` | +23 / 0 | Modified — added single R1 HTTP test asserting `true` reaches the JSON body. |
| `openspec/changes/account-profile-extra-usage-coverage/tasks.md` | +3 / -8 | Modified — marked tasks `[x]`, documented T1.6 drop decision. |

Production code (`src/domain/account.ts`, `src/http/routes/account.ts`,
`src/upstream/beta-exclusion.ts`, etc.) was **NOT touched**. Out-of-scope
guardrails respected — no `AccountProfile.hasExtraUsageEnabled` alias added,
no anthropic-client changes, no coverage tooling, no type renames.

## Test results

```
bun test __tests__/domain-account-profile.spec.ts __tests__/http-routes-account.spec.ts
 21 pass
 0 fail
Ran 21 tests across 2 files. [200ms]
```

Baseline before this change: 13 pass. Net delta: **+8 new test cases**
(R1 = 2 tests, R2 = 1 expanded test with +3 assertions, R3 = 2 tests,
R4 = 2 tests, R5 = 2 tests — counting `test()` blocks, R2 stayed as one
block).

```
bun run tsc --noEmit
EXIT=0
```

Full suite:
```
bun test
 262 pass
 2 fail
Ran 264 tests across 20 files. [2.04s]
```

The two failures are **pre-existing Windows environment issues** unrelated
to this change:

1. `__tests__/observability.spec.ts:22` — integration spec calls
   `Bun.$\`fuser -k ${PORT}/tcp\`` (Linux-only) before booting a server.
   Confirmed failing at baseline commit `568ce17` (before this change).
2. `__tests__/telemetry-upstream-body.spec.ts:49` — `Bun.spawnSync(["mkdir", "-p", logsDir])`
   needs Unix `mkdir`. Confirmed failing at `568ce17`.

Neither touches `src/domain/account.ts`, `src/http/routes/account.ts`, or
the test files modified here. Verify phase should treat them as
out-of-scope environmental noise.

## Commits (in order)

1. `cb6d553` — `test(account-profile): cover hasExtraUsageEnabled true propagation end-to-end` (T1.1, R1)
2. `57b8b95` — `test(account-profile): extend strict gating cases for hasExtraUsageEnabled` (T1.2, R2)
3. `f58d4a2` — `test(account-profile): cover account.profile.fetched log emit shape` (T1.3, R3)
4. `b53c314` — `test(account-profile): cover inflight dedup of concurrent ensureProfile calls` (T1.4, R4)
5. `5237127` — `test(account-profile): cover cache-hit no-fetch and refreshProfile always-fetch` (T1.5, R5)
6. `ef97f21` — `test(account-profile): type emitSpy.mock.calls as unknown[][] in filter callbacks` (TSC fix for the R3 callbacks)

No push, no PR opened — local commits only per the apply contract.

## Workload / PR boundary

- **Mode**: single PR (delivery_strategy: auto-forecast → single-pr).
- **LOC actual**: +296 / -2 = net +294 across two test files (plus 6 LOC in
  `tasks.md` for marking). Forecast was 100-140; actual ran higher because
  each new describe block needs its own `beforeEach`/`afterEach` setup
  blocks (~12 LOC each) and the helper utility took ~14 LOC of comments +
  code. Still comfortably under the 400-LOC review budget. **No size
  exception needed.**
- **Boundary**: starts at `568ce17` (SDD bootstrap), ends at `ef97f21`
  (TSC fix). Six commits, all `test(account-profile):` scope.

## Risks observed during apply

1. **Module-reset utility is novel for this repo.** Only one prior file
   (`upstream-beta-exclusion.spec.ts`) uses `mock.module`, and none use
   the `import("…?v=N")` cache-bust trick. If Bun ever changes this loader
   behavior, R3/R4/R5 break. Mitigation: the utility is one ~14-line block
   with a clear comment explaining the intent. If it breaks, the spec
   author can fall back to `mock.module` reset patterns.
2. **R4 is the highest flake-risk task in the batch.** Local runs are
   green and use a deferred-promise pattern (no `setTimeout`), but CI on
   slower hardware could in theory race. Mitigation: tests run sub-second
   locally; both `ensureProfile()` calls are kicked off synchronously
   before any `await`, so the inflight slot is observed deterministically.
3. **Forecast under-estimated by ~2x.** Actual LOC (296) vs estimate
   (100-140) ran higher mostly due to per-describe `beforeEach` boilerplate.
   Future SDD task-planning for test-only changes should add ~10 LOC per
   describe block for setup. Still well under budget, so no immediate
   action — just a learning for the next coverage-style change.

## Next recommended phase

`sdd-verify` — orchestrator should run the verify phase to confirm specs
map to passing tests and the verify report can be written. Verify phase
should be aware the two pre-existing Windows failures are environmental and
not regressions.
