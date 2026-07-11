# Tasks: Per-Key Detail Drill-Down

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~370–410 |
| 400-line budget risk | Medium (borderline, likely fits) |
| Chained PRs recommended | No |
| Suggested split | Single PR |
| Delivery strategy | auto-forecast |
| Chain strategy | stacked-to-main |

Decision needed before apply: Yes
Chained PRs recommended: No
Chain strategy: pending
400-line budget risk: Medium

### Branching / Sequencing Decision (HARD DEPENDENCY)

This change requires the `apiKeyId` filter on `GET /api/telemetry/requests` and the `ApiKeySelect` component — both delivered by PR #22 (`feat/key-usage-filter`, unmerged).

**Recommendation**: Branch from `feat/key-usage-filter` (the branch, already pushed, has the dependency) to parallelize work. Before this PR merges to master, rebase `feat/key-usage-filter` onto master (or have it merged first), then rebase this branch onto master. This avoids blocking on PR #22's review cycle while keeping history clean.

If the team prefers zero risk: wait for PR #22 to merge to master, then branch from master for apply.

### Suggested Work Units

| Unit | Goal | Likely PR | Notes |
|------|------|-----------|-------|
| 1 | Metric derivation helpers + tests | Base commit | Pure logic, no DOM, first to review |
| 2 | Detail route + keys.tsx links | On top | Renders the data from helpers; depends on helpers |
| 3 | Verify + polish | Same PR | Manual verification in browser |

## Phase 1: Foundation — Metric Helpers

- [x] 1.1 Create `src/ui/src/lib/keys-metrics.ts` — pure `deriveKeyMetrics(requests: RequestRecord[])` returning `{ requestCount, tokensIn, tokensOut, cacheReadTokens, cacheCreationTokens, errorRate, perModel: Array<{model, count, tokensIn, tokensOut}> }` — no React, no DOM
- [x] 1.2 Write `__tests__/keys-metrics.spec.ts` — test empty, mixed status, multiple models, first/last activity inference

## Phase 2: Detail Route

- [x] 2.1 Create `src/ui/src/routes/keys.$keyId.tsx` — `createFileRoute("/keys/$keyId")`, fetch `listApiKeys()` (for key metadata) + `listRequests({ apiKeyId, limit: 500 })` (for metrics), loading skeleton, RouteError
- [x] 2.2 Metadata card — prefix, label, status (Active/Revoked), admin badge, created date — derive from key in `listApiKeys()` response; render not-found state when keyId matches no key
- [x] 2.3 Derived metrics cards — request count, token totals (in/out/cache read/cache creation), error rate (`failed / total`), all computed via `deriveKeyMetrics()`
- [x] 2.4 Per-model breakdown section — table of model, request count, tokens in/out
- [x] 2.5 Deep-link buttons to Requests (`/?apiKeyId=<id>`) and Sessions (`/sessions?apiKeyId=<id>`)
- [x] 2.6 Zero-usage empty state — key metadata + deep-links visible but metrics section shows "No attributed requests yet"

## Phase 3: Integration — keys.tsx Link

- [x] 3.1 Add `Link` import to `keys.tsx`; wrap each `KeyRow`'s prefix/label cell in `<Link to="/keys/$keyId" params={{ keyId: String(k.id) }}>` — make the row clickable to the detail route

## Phase 4: Verification

- [x] 4.1 Run `bun test` — all existing tests pass
- [x] 4.2 Run `bun run tsc --noEmit` — no type errors in new/modified files
