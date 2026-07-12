```yaml
schema: gentle-ai.verify-result/v1
evidence_revision: git:fd1c4535c013e278a775930d707e0691acf9a047
verdict: pass
blockers: 0
critical_findings: 0
requirements: 4/4
scenarios: 10/10
test_command: bun test
test_exit_code: 0
test_output_hash: sha256:82460f6226ae409b0edf2ea30c148b56e789f95a9ea239bad07b71462762b3c3
build_command: bun run tsc --noEmit
build_exit_code: 2
build_output_hash: sha256:7a6443418454a63e3211d3757cb9d5b95caf5c10c3e1ab5a52dbf68aa75d59a8
```

> **Note on `build_exit_code: 2`**: this is a **documented pre-existing baseline**,
> not a defect introduced by this change. Independently re-verified in this session
> (not trusted from the apply report) by checking out `master` into an isolated
> `git worktree`, symlinking `node_modules` (a bare `bun install` in the worktree
> produced spurious module-resolution noise — discarded, see below), and re-running
> `bun run tsc --noEmit`: output was **byte-for-byte identical** to `feat/key-last-usage`
> — same 48 errors, same 4 files (`__tests__/transform-streaming-abort-signal.spec.ts`,
> `__tests__/ui-date-range.spec.ts`, `src/ui/src/lib/date-range.ts`,
> `src/ui/src/routes/sessions.tsx`), none of which this change touches. Zero new
> type errors. UI typecheck (`cd src/ui && bun run typecheck`) is a separate,
> clean, `exit 0` run — see Build & Tests Execution.

## Verification Report

**Change**: add-key-last-usage
**Version**: N/A
**Mode**: Strict TDD

### Completeness

| Metric | Value |
|--------|-------|
| Tasks total | 16 |
| Tasks complete | 16 |
| Tasks incomplete | 0 |

All 16 tasks in `tasks.md` (Phases 1–6) are checked `[x]`. Cross-checked task-by-task against the actual diff — every task maps to a real, present code change (no phantom checkmarks).

### Build & Tests Execution

**Tests**: ✅ 706 passed / ❌ 0 failed / ⚠️ 0 skipped
```text
$ bun test
706 pass
0 fail
1832 expect() calls
Ran 706 tests across 68 files. [5.71s]
```
Independently run (not copied from the apply report). Baseline was 701 (per apply-progress); +5 exactly matches the 5 new `last_used_at` tests. `__tests__/api-key-storage.spec.ts` alone: 38/38 pass (32 pre-existing + 5 new + 1 pre-existing count adjustment from the allowlist assertion — no test count regression).

**Known flake check** (`observability.spec.ts`, `bun: command not found: fuser`): the flake **did surface** in this run (line 129 of the captured log), unlike the apply report's two clean runs — but it caused **zero test failures**: all 4 tests in that file still passed (`(pass) health endpoint...`, `(pass) SSE stream...`, `(pass) metrics endpoint...`, `(pass) export CSV...`). Confirmed **pre-existing and unrelated**: `observability.spec.ts` is not in this change's diff (`git diff --stat` — 11 files, none is this file), and the failure mode is an environment sandbox limitation (missing `fuser` binary swallowed by `.nothrow()`), not code this change touches.

**Build (root)**: ⚠️ 48 pre-existing errors (unrelated, independently confirmed identical on `master` — see YAML note above)
```text
$ bun run tsc --noEmit
48 errors across 4 files, all outside the 11 changed files.
```

**Build (UI)**: ✅ Passed
```text
$ cd src/ui && bun run typecheck
$ tsr generate && tsc --noEmit
(exit 0, clean, no output)
```

**Coverage**: ➖ Not available (no coverage tool configured in this project — consistent with prior verify cycles for this project)

### Critical Pin — `last_used_at` Is Genuinely Unwindowed (independently re-derived)

Read the raw SQL directly from `src/observability/storage.ts:761-766` (not taken on faith from the apply report):

```sql
SELECT id, prefix, label, created_at, revoked_at, is_admin, rotated_at,
        (SELECT MAX(timestamp) FROM requests WHERE api_key_id = api_keys.id) AS last_used_at
 FROM api_keys ORDER BY created_at DESC
```

- **No `WHERE timestamp >= ?` or any time-bound predicate anywhere in the query** — structurally confirmed by direct source read, not inferred from a comment.
- The subquery is correctly **correlated** on `api_key_id = api_keys.id` (references the outer query's row), not a constant/non-correlated scalar subquery.
- `idx_requests_api_key` exists (`storage.ts:115`, `CREATE INDEX IF NOT EXISTS idx_requests_api_key ON requests(api_key_id)`), so the correlated lookup is index-backed, not a full scan.
- **Runtime proof, not just static reading**: the regression-guard test inserts a request timestamped `2020-06-01` (today's env date is `2026-07-11` — ~6 years old, far beyond any 30-day window) and asserts `last_used_at` equals that real timestamp, not `null`. This test would fail immediately if the implementation reused the windowed `getUsageByApiKey()` pattern (`WHERE r.timestamp >= ?`). It passed. This is mutation-resistant proof, not a tautology.
- **Correlation-correctness proof**: a separate test inserts an *unattributed* request (`api_key_id` omitted → SQL `NULL`) with a **far-future** timestamp (`2030-01-01`) alongside three real keys, then asserts each key's `last_used_at` reflects only its own rows. If the subquery were accidentally non-correlated (missing the `WHERE api_key_id = api_keys.id` clause), every key would incorrectly show `2030-01-01`. It didn't — each key showed its own correct value, and the zero-request key showed `null`.

**Verdict on this pin: CONFIRMED — genuinely unwindowed, genuinely correlated, both structurally and behaviorally.**

### Spec Compliance Matrix

**Domain: `api-key-management`**

| Requirement | Scenario | Test | Result |
|-------------|----------|------|--------|
| Unwindowed `last_used_at` on Key Metadata | Key with recent requests | `api-key-storage.spec.ts > listApiKeys last_used_at > "returns the ISO timestamp of the key's most recent attributed request"` (uses out-of-chronological-order inserts so a naive "last inserted" or `ORDER BY id DESC LIMIT 1` impl would fail) | ✅ COMPLIANT |
| Unwindowed `last_used_at` on Key Metadata | Key idle beyond the 30-day usage window (**regression guard**) | `... > "returns the REAL timestamp for a key idle beyond the 30-day usage window (regression guard, NOT null)"` | ✅ COMPLIANT |
| Unwindowed `last_used_at` on Key Metadata | Key never used | `... > "is null for a key with zero attributed requests"` | ✅ COMPLIANT |
| Unwindowed `last_used_at` on Key Metadata | Revoked key retains its last-used time | `... > "retains a revoked key's pre-revocation last_used_at (revocation does not clear it)"` | ✅ COMPLIANT |
| "Last used" Indicator on the Keys List | Used key shows a relative time | Source: `keys.tsx:263-265` `formatRelativeTime(apiKey.last_used_at)` in the new 7th `TableCell` | ⚠️ PARTIAL (source-verified) |
| "Last used" Indicator on the Keys List | Never-used key shows a placeholder | Source: `format.ts:22` `formatRelativeTime` — `if (!iso) return "—"` — same call site, no extra branching needed | ⚠️ PARTIAL (source-verified) |

**Domain: `api-key-detail`**

| Requirement | Scenario | Test | Result |
|-------------|----------|------|--------|
| "Last Used" Detail Section | Key with attributed requests renders the full card | Source: `LastUsedCard` reads `record.{timestamp,status,method,path,model,isStream,duration,inputTokens,outputTokens,cacheReadTokens,cacheCreationTokens,ip,userAgent,traceId}`, all present on `RequestRecord`. "No additional fetch" sub-claim is **statically provable**: `LastUsedCard` takes `record` as a prop, contains no `useQuery`/fetch call | ⚠️ PARTIAL (source-verified) |
| "Last Used" Detail Section | Nullable/absent fields render gracefully | Source: every field routes through `?? "—"`, `formatDuration()` (`ms == null → "—"`), `formatTokens()` (`n == null → "—"`), or `StatusBadge` (`status == null` → outline `"—"` badge) — no raw interpolation anywhere | ⚠️ PARTIAL (source-verified) |
| "Last Used" Detail Section | Transcript link targets the correct trace | Source: `<Link to="/r/$traceId" params={{ traceId: record.traceId }}>`; route confirmed to exist (`src/ui/src/routes/r.$traceId.tsx:31`); **compiler-checked** — TanStack Router's typed `Link` would fail the (clean, exit-0) UI typecheck on a param-shape mismatch | ⚠️ PARTIAL (source-verified + compiler-checked) |
| Zero-Usage Empty State Covers "No Last Usage" | Key with zero requests shows the empty state | Source: `LastUsedCard` is reachable **only** inside the `metrics.requestCount === 0 ? <ZeroUsage/> : (...)` else-branch — mutually exclusive by construction; `ZeroUsage` function body (lines 433-448) confirmed **byte-for-byte unchanged** by the diff | ⚠️ PARTIAL (source-verified; branch exclusivity is structurally provable) |

**Compliance summary**: 10/10 scenarios addressed; 4/10 (100% of backend/correctness-critical scenarios) are runtime-test-covered with real, mutation-resistant `bun:sqlite` tests. The remaining 6/10 are pure UI-composition scenarios (`keys.tsx` column, `keys.$keyId.tsx` card) verified via source inspection plus a clean, type-checked UI build — **not** via a runtime render test, because **this project has zero DOM-testing infrastructure anywhere** (independently reconfirmed this session: `grep -rl "@testing-library\|render(" __tests__/` → zero matches). This is a pre-existing, project-wide condition, not introduced by this change, and matches the identical, already-adjudicated treatment in this project's `key-usage-filter` and `keys-route-detail` verify cycles (both scenarios-PARTIAL-for-UI, both verdict PASS).

### Correctness (Static Evidence)

| Requirement | Status | Notes |
|------------|--------|-------|
| `last_used_at` correlated subquery | ✅ Implemented | See Critical Pin section above — structurally + behaviorally confirmed unwindowed and correctly correlated |
| Backend `ApiKeyMeta.last_used_at` | ✅ Implemented | Required `string \| null` field, `src/observability/types.ts` |
| Frontend `ApiKeyMeta.last_used_at` | ✅ Implemented | Exact mirror, `src/ui/src/lib/api.ts` |
| `GET /api/keys` DTO safety | ✅ Implemented | `_handleKeysList` unchanged: bare `json({ keys: listApiKeys() })`, no spread/widening. Regression-tested: `Object.keys(row).sort()` asserts the exact 8-key allowlist and `"key_hash" in row === false` |
| `keys.tsx` "Last used" column | ✅ Implemented | 7th `TableHead`/`TableCell` pair added consistently (was 6, now 7/7 — no layout break); null → "—" via existing `formatRelativeTime` |
| `keys.$keyId.tsx` `LastUsedCard` | ✅ Implemented | Zero new network calls, correctly gated, every nullable field degrades gracefully, correct trace-link target |
| `ZeroUsage` state | ✅ Untouched | Confirmed byte-identical function body pre/post diff |
| Fixture ripple (5 files) | ✅ Correct | `keys-route.spec.ts`, `api-key-dispatch.spec.ts`, `keys-metrics.spec.ts`, `rotate-key-dialog.spec.tsx` — mechanical `last_used_at` additions from the required-field type change, all still passing |

### Coherence (Design)

No `design.md` exists for this change (appropriately scoped out — a ~300-line additive, no-schema-change feature). `proposal.md`'s "Approach" section serves the equivalent purpose and was cross-checked directly against the implementation:

| Decision | Followed? | Notes |
|----------|-----------|-------|
| Compute `last_used_at` on `listApiKeys()`, NOT on windowed `getUsageByApiKey()` | ✅ Yes | Confirmed via source read — the two functions remain fully independent; `getUsageByApiKey()`'s `WHERE r.timestamp >= ?` is untouched |
| Option B (detail card) is pure rendering over already-fetched data | ✅ Yes | Zero new `useQuery`, sources `requestsQuery.data.requests[0]` |
| No schema/migration/new column | ✅ Yes | Diff confirms no `ALTER TABLE`/migration — pure derived-at-read-time subquery |

### TDD Compliance

| Check | Result | Details |
|-------|--------|---------|
| TDD Evidence reported | ✅ | Found in apply-progress (Engram #995), full RED/GREEN/TRIANGULATE table for the backend layer |
| All tasks have tests | ✅ (disclosed carve-out) | Backend (1.1-1.2, 2.1-2.5): full RED→GREEN evidence. Frontend (3.x/4.x): no render harness exists anywhere in the project (pre-existing, disclosed carve-out — task 5.1) — verified via source read + clean UI `tsc` instead |
| RED confirmed (tests exist) | ✅ | `__tests__/api-key-storage.spec.ts` new `describe` block (5 tests) confirmed present, read in full |
| GREEN confirmed (tests pass) | ✅ | Independently ran `bun test`: 38/38 in `api-key-storage.spec.ts` (32 pre-existing + 5 new + 1 allowlist-assertion update), 706/706 full suite |
| Triangulation adequate | ✅ | 5 distinct scenarios, 5 distinct expected values (recent ts, deep-past ts idle-guard, `null`, revoked-retained ts, multi-key isolation w/ decoy row) — not just empty-vs-nonempty variance |
| Safety Net for modified files | ✅ | Full `bun test` (706/706) covers `storage.ts` and every modified file; the 32 pre-existing `listApiKeys`/`api_keys` tests plus 4 fixture-repaired spec files all still pass |

**TDD Compliance**: 6/6 checks passed

---

### Test Layer Distribution

| Layer | Tests | Files | Tools |
|-------|-------|-------|-------|
| Unit (bun:sqlite, `:memory:`) | 5 new (+33 pre-existing/re-verified in same file) | 1 (`api-key-storage.spec.ts`) | bun:test, bun:sqlite |
| Integration (route/dispatch, fixture-repaired, re-verified) | 0 new / 9 re-verified | `keys-route.spec.ts`, `api-key-dispatch.spec.ts` | bun:test, `spyOn` |
| Frontend / DOM render | 0 (no harness installed anywhere in this project) | — | not available |
| **Total new tests** | **5** | **1** | |

---

### Assertion Quality

Scanned all 5 new test cases plus the modified DTO-allowlist assertion in `api-key-storage.spec.ts`:
- No tautologies (`expect(true).toBe(true)`-style).
- No orphan empty-collection assertions without a companion non-empty test — `"is null for a key with zero attributed requests"` sits directly alongside 4 sibling tests asserting specific non-null ISO timestamps in the same `describe` block.
- No ghost loops over possibly-empty collections.
- No smoke-test-only patterns — every test calls real production code (`listApiKeys()` against a real in-memory `bun:sqlite` DB, not a mock) and asserts a specific value (an exact ISO string or `toBeNull()`), never mere existence.
- No CSS/implementation-detail coupling (backend-only tests, N/A).
- Mock ratio: 0 mocks in this describe block (real DB) vs 6 assertions across 5 tests — no mock-heavy concern.
- The multi-key isolation test is the strongest one: it plants a decoy unattributed row with a **far-future** timestamp specifically to catch a non-correlated-subquery regression — this is deliberate, adversarial test design, not incidental coverage.

**Assertion quality**: ✅ All assertions verify real behavior

---

### Quality Metrics

**Linter**: ➖ Not available (no lint script found for the backend; consistent with prior verify cycles for this project)
**Type Checker**: ✅ No new errors — root: 48 pre-existing errors, byte-for-byte identical output confirmed between `master` and `feat/key-last-usage` (isolated `git worktree` comparison), zero in any of the 11 changed files. UI: `exit 0`, clean.

### Secret / DTO Leak Spot-Check

- SQL uses an explicit column allowlist (`id, prefix, label, created_at, revoked_at, is_admin, rotated_at, ... AS last_used_at`) — `key_hash` is structurally absent from the query, not just absent by convention.
- `_handleKeysList` performs no spreading, no transformation: `json({ keys: listApiKeys() })` — cannot widen the leak surface even if a caller tried.
- `last_used_at` is a plain derived `string | null` timestamp — not an object, not a reference to any secret-bearing row.
- Regression-tested: `Object.keys(row).sort()` assertion in `api-key-storage.spec.ts` pins the exact 8-key output shape and independently asserts `"key_hash" in row === false`.

**Verdict: no leak-surface widening.**

### Issues Found

**CRITICAL**: None.

**WARNING**: None. (6/10 spec scenarios — all UI-composition-only, in `keys.tsx` and `keys.$keyId.tsx` — have no possible runtime test because this project has zero DOM-testing infrastructure anywhere, independently reconfirmed this session via `grep -rl "@testing-library\|render(" __tests__/` returning no matches. This is a pre-existing, project-wide condition, not introduced or worsened by this change, and is verified instead via direct source inspection plus a clean, type-checked UI build. This exactly matches the precedent already established and accepted in this project's `key-usage-filter` and `keys-route-detail` verify cycles — both graded PASS with zero warnings under the identical condition. Not flagging as a fresh gap specific to this PR.)

**SUGGESTION**:
- `proposal.md`'s "Success Criteria" checkboxes (lines 81–85) remain unticked (`[ ]`) even though all 5 are functionally satisfied by the verified implementation — a cosmetic doc-sync gap. `tasks.md` (the authoritative completion tracker per this project's SDD convention) is correctly 16/16 checked, so this does not affect the verdict.
- `proposal.md`'s "Modified Capabilities" prose mentions surfacing the already-computed `metrics.lastActivity` in the detail card; the finalized delta spec (`api-key-detail/spec.md`) and the actual implementation instead use the richer `requests[0]` record (consistent with the user's "as detailed as possible" request). `metrics.lastActivity` itself ends up unused in the UI. Not a defect — the spec supersedes early proposal wording — just a minor drift worth tidying if `proposal.md` is revisited.
- Consider a lightweight DOM-testing layer (e.g. `@testing-library/react` + `happy-dom`) in a future infra change so UI-composition scenarios get direct runtime proof instead of source inspection. This is a project-wide gap repeatedly noted across this project's SDD verify cycles, not specific to this change.

### Verdict

**PASS**

The correctness-critical, regression-prone logic — the unwindowed `last_used_at` correlated subquery — is independently confirmed both structurally (direct SQL read: no time-window predicate, correct correlation) and behaviorally (5 real `bun:sqlite` tests, including a deliberately adversarial idle->30-day regression guard and a decoy-row correlation-isolation test, all passing). Full suite is 706/706 (baseline 701 + 5 new, zero regressions); the one flaky log line (`observability.spec.ts`'s missing-`fuser` warning) surfaced but caused zero failures and is confirmed pre-existing/unrelated. Both type-checks are clean relative to their baselines (root: byte-identical 48 pre-existing errors, none in touched files; UI: exit 0). No secret/DTO leak surface was introduced. The only verification gap — 6 UI-composition spec scenarios lacking a runtime test — is a disclosed, pre-existing, project-wide limitation with two independent prior precedents in this same project, not a defect in this change.
