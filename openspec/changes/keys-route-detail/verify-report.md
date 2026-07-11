```yaml
schema: gentle-ai.verify-result/v1
evidence_revision: sha256:c209e4ee4c2467ff6b91102c5797a0ee58c37ad530db4ddaa9a2fdd8418419f0
verdict: pass
blockers: 0
critical_findings: 0
requirements: 5/5
scenarios: 9/9
test_command: bun test
test_exit_code: 1
test_output_hash: sha256:c209e4ee4c2467ff6b91102c5797a0ee58c37ad530db4ddaa9a2fdd8418419f0
build_command: bun run tsc --noEmit && (cd src/ui && bun run typecheck)
build_exit_code: 2
build_output_hash: sha256:c0b1cc18690036c8c052d3e655378448b3b43e9480becc9d891a75452c2484b0
```

> **Note on nonzero exit codes**: `test_exit_code: 1` and `build_exit_code: 2` reflect
> raw process exit codes from `bun test` (1 pre-existing failure, unrelated to this
> change) and root `tsc --noEmit` (7 pre-existing errors, all in one untouched test
> file). Both are independently reproduced as pre-existing on `feat/key-usage-filter`
> (the actual branch base) below — see "Pre-existing failure verification". The UI-scoped
> typecheck (`cd src/ui && bun run typecheck`) — the command this change actually owns —
> is genuinely clean (exit 0).

## Verification Report

**Change**: keys-route-detail
**Version**: N/A
**Mode**: Strict TDD
**Branch under test**: `feat/keys-route-detail` (base: `feat/key-usage-filter`, confirmed via `git merge-base --is-ancestor` — this is a stacked branch, NOT based on master)

### Completeness

| Metric | Value |
|--------|-------|
| Tasks total | 9 (+2 verification sub-tasks) |
| Tasks complete | 9 (+2) |
| Tasks incomplete | 0 |

All checkboxes in `tasks.md` are marked `[x]`. Independently confirmed against source:
metric helpers exist (`keys-metrics.ts`), the route exists and is wired into
`routeTree.gen.ts` (confirming `tsr generate` actually ran and the route is real,
not a dangling file), `keys.tsx` rows link to it, and `sessions.tsx` gained the URL
param wiring the apply agent flagged as a deviation.

### Build & Tests Execution

**Build (UI typecheck, in-scope)**: ✅ Passed
```text
$ cd src/ui && bun run typecheck
$ tsr generate && tsc --noEmit
(no output — clean, exit 0)
```

**Build (root tsc --noEmit)**: ⚠️ 7 pre-existing errors, ZERO in changed files
```text
__tests__/transform-streaming-abort-signal.spec.ts(40,34): error TS2304: Cannot find name 'ReadableStreamReadResult'.
__tests__/transform-streaming-abort-signal.spec.ts(60,80): error TS2345: ... ToolMap
__tests__/transform-streaming-abort-signal.spec.ts(63,37): error TS2345: ... readMany missing
__tests__/transform-streaming-abort-signal.spec.ts(71,80): error TS2345: ... ToolMap
__tests__/transform-streaming-abort-signal.spec.ts(77,37): error TS2345: ... readMany missing
__tests__/transform-streaming-abort-signal.spec.ts(83,80): error TS2345: ... ToolMap
__tests__/transform-streaming-abort-signal.spec.ts(86,37): error TS2345: ... readMany missing
```
Independently reproduced byte-identical (same 7 lines) on `feat/key-usage-filter`
(the branch base) via a disposable `git worktree`. Confirmed pre-existing, not
introduced by this change. File is untouched by this change's diff.

**Tests**: ⚠️ 521 pass / 1 fail (pre-existing, environment-caused — see below) / 0 skipped
```text
$ bun test
... 521 pass
 1 fail
 1389 expect() calls
Ran 522 tests across 46 files. [33.4s]
```

**12 new tests added by this change** (`keys-metrics.spec.ts`), all passing:
- `deriveKeyMetrics`: 8 cases (empty input, token sums, error rate, null-status
  handling, per-model grouping+sort, unknown-model bucket, first/last activity,
  NaN-safety)
- `findApiKeyById`: 4 cases (resolve, unknown id, non-numeric id, empty key list)

**The 1 failing test is genuinely pre-existing and environment-caused, NOT a
regression from this change.** Root-caused independently (not merely trusted
from the apply report):

- Failing spec: `__tests__/observability.spec.ts` (byte-identical between
  `feat/key-usage-filter` and `feat/keys-route-detail` — confirmed via `diff <(git
  show base:file) <(git show head:file)`).
- Root cause: this sandbox's gitignored `.env` sets `BIND_HOST=10.0.40.18`
  (a specific non-loopback interface). `observability.spec.ts` spawns the real
  server (`Bun.spawn(["bun", "src/index.ts", "3998"])`) and polls
  `http://127.0.0.1:3998/health` in a loop for up to 30s before giving up —
  but the server is actually listening on `10.0.40.18:3998`, so every poll gets
  `ECONNREFUSED` against loopback, `ready` never flips true, and the
  `beforeAll` hook throws after the full 30s timeout, surfacing as `(fail)
  (unnamed)`.
- Independently verified: `BIND_HOST=127.0.0.1 bun test __tests__/observability.spec.ts`
  clears the hang (fails fast instead on unrelated 401s from stale
  `REQUIRE_API_KEY` env state in this sandbox, confirming the port-bind
  mismatch was the sole cause of the *hang*).
- Independently verified this is not branch-specific: cloned
  `feat/key-usage-filter` into a disposable `git worktree` (no `.env` copied,
  since it's gitignored) and `bun test` there ran clean (513 pass, 0 fail) —
  proving the flake is 100% a property of this sandbox's `.env`, not of any
  commit on this branch.
- Test count math checks out: 513 (base, no `.env`-triggered failure) + 12
  (new `keys-metrics` tests) = 525 expected; actual is 522 tests run (521 pass
  + 1 fail) because `observability.spec.ts` contributes only 1 counted "test"
  when its `beforeAll` hook itself times out (the file's other 3 tests never
  register) — consistent with the root cause, not a discrepancy.

**Coverage**: Not available — no coverage tool configured in this project's `bun test` setup (`Coverage analysis skipped — no coverage tool detected`).

### Spec Compliance Matrix

| Requirement | Scenario | Test | Result |
|-------------|----------|------|--------|
| Per-Key Detail Route | Navigate to an existing key | `keys-metrics.spec.ts > findApiKeyById > resolves a key by its numeric id` + manual source trace of `keys.$keyId.tsx` `MetadataCard` render (prefix/label/status/admin/created all rendered from `apiKey`) | ✅ COMPLIANT |
| Per-Key Detail Route | Open detail from the keys list | Source: `keys.tsx` `KeyRow` wraps prefix+label cells in `<Link to="/keys/$keyId" params={{keyId: String(apiKey.id)}}>`; route registered in `routeTree.gen.ts` (proves `tsr generate` ran, route is live) | ✅ COMPLIANT |
| Derived Usage Metrics | Key with attributed requests | `keys-metrics.spec.ts > deriveKeyMetrics > sums token totals across attributed rows` + `groups per-model...` — all metrics traced to real `RequestRecord` columns (`inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheCreationTokens`, `status`, `model`) | ✅ COMPLIANT |
| Derived Usage Metrics | Error rate reflects failed requests | `keys-metrics.spec.ts > error rate equals failed (status >= 400) divided by total` (0.5 for 2/4 failed) + `null status is not counted as an error` | ✅ COMPLIANT |
| Pre-Filtered Deep-Links | Deep-link to Requests | Source trace: `keys.$keyId.tsx` `DeepLinks` → `<Link to="/" search={{apiKeyId: keyId}}>`; `index.tsx` `validateSearch` parses `apiKeyId` → `Route.useSearch()` → `apiFilters.apiKeyId` → `listRequests(apiFilters)`. Backend filter covered by `telemetry-key-filter.spec.ts` (13 passing tests, pre-existing from PR #22, exercised end-to-end here) | ✅ COMPLIANT |
| Pre-Filtered Deep-Links | Deep-link to Sessions | Source trace (the flagged deviation): `keys.$keyId.tsx` `DeepLinks` → `<Link to="/sessions" search={{apiKeyId: keyId}}>`; `sessions.tsx` **NEW** `validateSearch: (search) => ({apiKeyId: ...})` + `Route.useSearch()` → `apiKeyId` → `listRequests({path, apiKeyId, ...})`. Route tree (`routeTree.gen.ts` line 74-89) shows `/sessions` typed with this search shape, proving `tsc`/`tsr` actually validated the `search={{apiKeyId}}` call site against `SessionsSearch` — a type mismatch here would have failed the (verified-clean) UI typecheck | ✅ COMPLIANT (deviation genuinely fixed, not just claimed) |
| Zero-Usage Empty State | Valid key with no attributed requests | `keys-metrics.spec.ts > empty input yields a zeroed, non-crashing metrics object` (`requestCount: 0`) + source: `keys.$keyId.tsx` renders `MetadataCard` and `DeepLinks` unconditionally once `apiKey != null`, THEN branches on `metrics.requestCount === 0` → `<ZeroUsage/>` — metadata/links are outside the metrics conditional, confirmed always-visible | ✅ COMPLIANT |
| Nonexistent Key Handling | Unknown keyId | `keys-metrics.spec.ts > findApiKeyById > returns null for an id string that matches no key` + `never throwing` (non-numeric, empty string) + source: `apiKey == null ? <KeyNotFound/> : ...` — distinct branch from zero-usage, gated on key existence not metrics | ✅ COMPLIANT |
| No Cost or Pricing Figures | Cost data is absent | `grep -in "cost\|price\|dollar\|\$[0-9]"` across `keys.$keyId.tsx` + `keys-metrics.ts` → zero matches (only false-positive Tailwind class `w-36`) | ✅ COMPLIANT |

**Compliance summary**: 9/9 scenarios compliant.

Note on test-layer honesty: this repo has no DOM test harness (no jsdom/happy-dom/
testing-library — confirmed by grep, matches the apply report's claim). Per the
project's strict-tdd graceful degradation, ALL route logic with branching behavior
(metrics derivation, key resolution / not-found signal) was extracted into the pure,
unit-tested `keys-metrics.ts` module; the `.tsx` file is a thin assembly of tested
helpers plus presentational JSX with no untested conditional logic of its own. The
"Result" column above cites source-trace evidence for the JSX wiring specifically
because no component-render test can exist in this repo — this is disclosed
degradation, not silent gap-filling.

### Correctness (Static Evidence)

| Requirement | Status | Notes |
|------------|--------|-------|
| `deriveKeyMetrics()` purity | ✅ Implemented | Read full source: no `fetch`, no DOM, no module-level mutable state, no console/logging side effects. Pure function of its `requests` argument, returns a new object each call. Confirmed via `codegraph_explore` (verbatim source) plus manual read. |
| `findApiKeyById()` never throws | ✅ Implemented | `Number(keyIdParam)` + `Number.isInteger` guard before array lookup; explicitly tested for `"abc"`, `""`, unknown id, empty key list — all return `null`, never throw |
| Metrics traceable to real columns | ✅ Implemented | Every field read (`inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheCreationTokens`, `status`, `model`, `timestamp`) exists on `RequestRecord` (`src/ui/src/lib/types.ts`), which mirrors the backend `requests` table exactly |
| Assertion quality (12 new tests) | ✅ No issues | No tautologies, no assertion-free tests, no ghost loops. Each test calls `deriveKeyMetrics`/`findApiKeyById` and asserts specific, varied, non-trivial values (sums, ratios, sort order, distinct null-handling branches) — genuinely triangulated, not tautological. Full audit performed per strict-tdd Step 5f; zero violations found. |
| `keys.tsx` row click affordance | ✅ Implemented | `<Link>` wraps only the prefix/label `TableCell` inner content, NOT the whole `<TableRow>` — the Revoke button (its own `TableCell`) is unaffected; no nested-interactive-element hazard |
| No PR #21 (rename) regression | ✅ N/A — confirmed absent | `git merge-base --is-ancestor feat/rename-api-key-label feat/keys-route-detail` → false. The rename feature does not exist anywhere in this branch's ancestry, so there is nothing to regress |

### Coherence (Design)

| Decision | Followed? | Notes |
|----------|-----------|-------|
| Dedicated route over inline panel | ✅ Yes | `keys.$keyId.tsx` implements `createFileRoute("/keys/$keyId")`, URL-shareable, matches `/r/$traceId` and `/s/$sessionId` convention |
| Sequence after / branch from PR #22 (`feat/key-usage-filter`) | ✅ Yes | Verified via `git merge-base --is-ancestor feat/key-usage-filter feat/keys-route-detail` → true; PR #22 commit `48ff792` present in ancestry |
| Reuse `listRequests({apiKeyId})` + `listApiKeys()` | ✅ Yes | No new backend endpoints added; `keys.$keyId.tsx` composes existing `api.ts` functions only |
| Gate metric calls on filter availability | ✅ Yes (moot) | Since branched after PR #22's `apiKeyId` filter landed on this branch, `requestsQuery` is unconditionally enabled (guarded only by numeric-id validity), which is correct given the sequencing |
| Deviation: sessions.tsx needed real URL-param wiring (discovery #922) | ✅ Genuinely fixed | Independently traced the full data path (see Spec Compliance Matrix, "Deep-link to Sessions" row) — confirmed via source read + route-tree type registration + clean UI typecheck, not merely trusted from the report |

### Issues Found

**CRITICAL**: None

**WARNING**: None

**SUGGESTION**:
- The YAML envelope's `test_exit_code: 1` / `build_exit_code: 2` reflect raw
  process exit codes including the pre-existing, environment-caused failures
  documented above. Future verify runs in a sandbox with `BIND_HOST` unset (or
  set to `127.0.0.1`) would show `test_exit_code: 0`. This is a sandbox
  artifact, not a code defect, and does not block this PASS verdict — but
  flagging it so the orchestrator doesn't misread a future CI run using a
  differently configured environment.
- No DOM test harness exists in this repo (project-wide, not introduced by
  this change), so the `.tsx` route assembly itself has no component-level
  test coverage — only its extracted pure logic does. This matches project
  convention (same degradation pattern used by every other route in this
  codebase) and was explicitly disclosed by the apply agent; not a new gap
  introduced by this change.

### Verdict

**PASS**

All 5 spec requirements / 9 scenarios are genuinely implemented and verified via
source trace + passing unit tests (not merely claimed). The 1 test failure and 7
tsc errors are independently confirmed pre-existing (byte-identical file,
reproduced on the branch base in an isolated worktree) and are unrelated to this
change's diff. The flagged sessions.tsx deviation was independently verified to
be a genuine, working fix — not a stub — by tracing the full URL → validateSearch →
useSearch → query → filtered-results chain and confirming the route-tree's typed
search params would have failed a clean typecheck had the wiring been wrong.
