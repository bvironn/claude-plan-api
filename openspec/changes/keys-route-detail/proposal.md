# Proposal: Per-Key Detail Drill-Down from /keys

## Intent

On `/keys`, each key shows only an aggregate summary (`197 req · 80.3k tok`) with
no way to inspect that key's actual requests, sessions, or richer metrics. Operators
can't answer "what is THIS key doing, and is it healthy?" without leaving the page and
manually filtering elsewhere. Surface the already-attributed per-key data
(`requests.api_key_id`) as a focused detail view reachable from `/keys`.

## Scope

### In Scope
- Make each key row on `/keys` open a per-key detail route (`/keys/$keyId`).
- Detail view shows that key's metadata (prefix, label, status, admin, created).
- Deep-links to pre-filtered Requests (`/?apiKeyId=<id>`) and Sessions (`/sessions?apiKeyId=<id>`).
- Richer metrics from existing columns: request count, tokens in/out, cache read/creation, error rate (`status >= 400`), per-model breakdown, first/last activity.
- Empty state when the key has zero attributed requests.

### Out of Scope
- Cost / dollar breakdown — **no pricing data exists in the schema** (`requests` has no cost column). Explicitly not invented.
- New analytics infrastructure, time-series charts, or a new aggregation service.
- Changing how attribution is recorded, or backfilling unattributed rows.
- The `apiKeyId` request/session filter itself — delivered by the pending `key-usage-filter` change (PR #22); this change composes with it, not duplicates it.

## Capabilities

### New Capabilities
- `api-key-detail`: per-key detail view/route surfacing one key's metrics and deep-links into filtered Requests/Sessions.

### Modified Capabilities
- None. (No existing on-master spec owns `/keys` metrics; `telemetry-key-filter` from PR #22 is consumed, not modified.)

## Approach

Add a TanStack file route `/keys/$keyId` reusing the app's existing detail-route
convention (`/r/$traceId`, `/s/$sessionId`). The page fetches `listApiKeys()` +
`getUsageByApiKey()` (already available) and derives per-model / error-rate metrics
client-side from a scoped `listRequests({ apiKeyId })` call — **which requires the
`apiKeyId` filter from PR #22**. Deep-links reuse the URL-driven filter Requests
already supports and Sessions gains in PR #22. Prefer a dedicated route over an
inline panel: it is URL-shareable, matches existing UX, and keeps `/keys` list lean.

**Sequencing**: this change assumes `key-usage-filter` (PR #22) is merged first, so
`apiKeyId` exists on `GET /api/telemetry/requests` and `ApiKeySelect`/deep-links work.
If designed before that merge, gate the `listRequests({ apiKeyId })` metric calls on
the filter's availability.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/ui/src/routes/keys.tsx` | Modified | Row → link to `/keys/$keyId` |
| `src/ui/src/routes/keys.$keyId.tsx` | New | Detail view: metadata, metrics, deep-links |
| `src/ui/src/lib/api.ts` | Modified | Reuse `listRequests({ apiKeyId })`, `getUsageByApiKey` |
| `src/ui/src/lib/format.ts` | Maybe | Error-rate / per-model helpers if needed |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| PR #22 not merged → no `apiKeyId` filter | High | Sequence after #22; gate metric calls until available |
| Client-side per-model derivation on large result sets | Med | Cap `limit`, reuse existing 100/500 patterns |
| Users expect cost breakdown | Med | State non-goal explicitly; no pricing data exists |

## Rollback Plan

UI-only, additive. Revert the new route file and the `keys.tsx` link change; the
existing `/keys` table is untouched in behavior. No backend, schema, or migration
changes — nothing to roll back server-side.

## Dependencies

- `key-usage-filter` change / PR #22 (adds `apiKeyId` filter + `ApiKeySelect`) merged to master first.

## Success Criteria

- [ ] Clicking a key on `/keys` opens `/keys/$keyId` for that key.
- [ ] Detail view shows request count, tokens, error rate, and per-model breakdown from real data.
- [ ] Deep-links open Requests and Sessions pre-filtered to that key.
- [ ] Zero-usage key renders a clean empty state, not an error.
- [ ] No invented metrics: every number traces to an existing `requests` column.
