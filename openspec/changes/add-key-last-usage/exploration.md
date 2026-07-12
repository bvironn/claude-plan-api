# Exploration: add-key-last-usage — show last usage detail for an API key

## Current State

### Backend (verified by reading `src/observability/storage.ts`, `src/observability/types.ts`, `src/http/routes/keys.ts`, `src/http/routes/telemetry/usage.ts`)

- `requests` table (line 65) has a full per-request record — `trace_id, timestamp,
  method, path, status, duration_ms, ip, user_agent, model, is_stream,
  input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
  api_key_id` — plus indexes `idx_requests_timestamp`, `idx_requests_api_key`
  (line 115, added additively after `ensureColumn`). No composite
  `(api_key_id, timestamp)` index exists, but the single-column indexes are
  enough at current scale (admin dashboard, not high-QPS analytics).
- `listApiKeys()` (line 753) SELECTs `id, prefix, label, created_at,
  revoked_at, is_admin, rotated_at` from `api_keys` — **no last-used
  information, and the `api_keys` table has no such column** (must be derived
  from `requests`).
- `getUsageByApiKey(filters: UsageFilters = {})` (line 862) aggregates
  `requests` GROUP BY `r.api_key_id`, **bounded by a 30-day default window**
  (`resolveUsageTimeFrom` / `DEFAULT_USAGE_WINDOW_MS`, line 839: `30 * 24 * 60
  * 60 * 1000`). Rows are filtered by `r.timestamp >= timeFrom` **before**
  the `GROUP BY`, so a key with zero requests inside the window produces **no
  row at all** in the result — not a zero-row, an absent one.
- `GET /api/telemetry/usage` (`src/http/routes/telemetry/usage.ts`) wraps
  `getUsageByApiKey` 1:1, same windowing semantics.
- `POST/GET /api/keys*` (`src/http/routes/keys.ts`) build explicit literal
  DTOs field-by-field (never spread a DB row) — secret-safe by construction,
  a pattern to preserve for any new field.
- No redaction/PII policy exists anywhere in the codebase (checked for
  `redact|PII|privacy|GDPR` — only unrelated "redacted_thinking" Anthropic
  content-block hits). `ip`/`user_agent` are already part of `RequestRecord`
  and already flow to the client on every existing per-request view.

### Frontend list page (`src/ui/src/routes/keys.tsx`)

- `keys.tsx:94` calls `getUsageByApiKey()` **with no args** → confirms the
  page is subject to the 30-day windowing above.
- `KeysTable`/`KeyRow` render one row per key: Prefix / Label / Created /
  **"Usage (last 30d)"** / Status / Actions. The usage cell reads
  `usageByKeyId.get(k.id)` — `undefined` renders `"—"`. **No last-used
  timestamp column exists.**
- `src/ui/src/lib/format.ts` already has `formatRelativeTime(iso)` — "just
  now" / "2m ago" / "3h ago" / absolute date for >24h — exactly the
  formatter a "Last used" cell needs, already used for `Created`/`Rotated`.

### Frontend detail page (`src/ui/src/routes/keys.$keyId.tsx`)

- Already calls `listRequests({ apiKeyId, limit: 500, order: "desc" })` —
  **already newest-first**, so `requestsQuery.data.requests[0]` is already
  the most recent request in memory, no new fetch needed.
- `deriveKeyMetrics()` (`src/ui/src/lib/keys-metrics.ts:64`) already computes
  `firstActivity`/`lastActivity` (ISO strings, min/max of `r.timestamp`) into
  `KeyMetrics` — **but the detail page never renders `lastActivity`
  anywhere.** Dead/unused data path today (confirmed: no reference to
  `metrics.lastActivity` in `keys.$keyId.tsx`).
- Page currently renders `MetadataCard` (prefix/label/created/rotated),
  `DeepLinks`, `MetricsCards` (6 aggregate stat tiles), `PerModelTable`. No
  per-request "last used" detail card exists.

### What "detailed" looks like elsewhere (`src/ui/src/components/panels/technical-panel.tsx`)

- The codebase's existing bar for "detailed" per-request display: Model,
  Mode (stream/thinking/effort badges), Duration, full token breakdown
  (in/out/cache-read/cache-write), trace id with copy button.
- `RequestRecord` (UI type, `src/ui/src/lib/types.ts:14`) also carries
  `method`, `path`, `status`, `ip`, `userAgent` — **none of these five are
  currently rendered by `TechnicalPanel`**, confirmed by grepping the whole
  `src/ui/src` tree (only `status` is shown, via `StatusBadge` on the
  request-detail header, not inside the technical panel itself).

### Testing conventions (verified)

- `getUsageByApiKey` covered by `__tests__/api-key-storage.spec.ts` (`describe
  "storage — getUsageByApiKey aggregation"`, line 107) and
  `__tests__/storage-windowed-usage.spec.ts`.
- `listApiKeys` covered by `__tests__/api-key-storage.spec.ts` (`describe
  "storage — listApiKeys (metadata only, DESC)"`, line 168).
- `deriveKeyMetrics` covered by `__tests__/keys-metrics.spec.ts` (includes an
  existing test: "infers first/last activity from the min/max timestamps").
- `GET /api/telemetry/usage` covered by `__tests__/telemetry-usage-route.spec.ts`.
- UI client (`getUsageByApiKey`, `listApiKeys`) covered by
  `__tests__/ui-api-keys.spec.ts`.
- **No React-rendering tests exist anywhere in this project** (`find
  src/ui/src -iname "*.spec.ts*" -o -iname "*.test.ts*"` → empty). All UI
  coverage is on pure lib functions (`keys-metrics.ts`, `format.ts`) imported
  directly into `bun:test`, not on rendered route components. This bounds
  the realistic TDD scope for this change to the storage-layer SQL change —
  the JSX rendering itself follows the existing (untested-at-component-level)
  convention.

## Affected Areas

### Option A — "Last used" column on `/keys` list

- `src/observability/storage.ts` — extend `listApiKeys()` (NOT
  `getUsageByApiKey()`, see design nuance below) to also return
  `last_used_at: string | null` per key.
- `src/observability/types.ts` — add `last_used_at` to `ApiKeyMeta`.
- `src/ui/src/lib/api.ts` — mirror `last_used_at` on the frontend `ApiKeyMeta`
  interface (line ~194).
- `src/ui/src/routes/keys.tsx` — new "Last used" column in `KeysTable`/`KeyRow`,
  rendered with the existing `formatRelativeTime()`.
- `__tests__/api-key-storage.spec.ts` — new/updated assertions in the
  `listApiKeys` describe block (strict TDD: write failing tests first).

### Option B — Rich "Last Used" card on `/keys/$keyId` detail

- `src/ui/src/routes/keys.$keyId.tsx` — new card rendering
  `requestsQuery.data.requests[0]` (method, path, status, model, duration,
  token breakdown, ip, user agent, trace id with link/copy), plus wiring the
  already-computed `metrics.lastActivity` for the relative-time label. **Zero
  backend changes** — all data is already fetched (`listRequests({ apiKeyId,
  order: "desc" })`) and already computed (`deriveKeyMetrics`).
- Possibly extract a small shared `LastRequestCard`/reuse pattern from
  `TechnicalPanel`'s `MetaRow`/`TokenBreakdown` helpers to avoid duplicating
  markup — optional, a design-phase call.
- No new tests strictly required by TDD policy (no backend/pure-function
  change; project has no component-render tests), but the `deriveKeyMetrics`
  test suite already covers `lastActivity` correctness.

## Design nuance found during verification (important — changes the naive plan)

The orchestrator's initial framing for Option A was "add a cheap `MAX(timestamp)`
column to the existing `getUsageByApiKey()` aggregate." **Reading the code
shows this would be subtly wrong**, not just cheap-and-simple:

`getUsageByApiKey()` filters `WHERE r.timestamp >= timeFrom` **before**
`GROUP BY r.api_key_id`, and `/keys` calls it with the default 30-day window.
If `last_used_at` were computed inside that same windowed query, a key that
was last used 40 days ago (idle beyond the window, but not stale to a human
operator) would produce **no row at all** — the UI would render "—" for
"Last used," implying "never used," which is worse than misleading given the
user explicitly asked for the *last time it was used, ever* ("la última vez
... cuando se usó").

**Correct fix**: compute `last_used_at` as an **unwindowed** value, attached
to `listApiKeys()` (which already returns every key regardless of usage)
rather than to the windowed `getUsageByApiKey()`. A correlated subquery
works cleanly and is index-backed by the existing `idx_requests_api_key`:

```sql
SELECT id, prefix, label, created_at, revoked_at, is_admin, rotated_at,
  (SELECT MAX(timestamp) FROM requests WHERE requests.api_key_id = api_keys.id)
    AS last_used_at
FROM api_keys ORDER BY created_at DESC
```

This guarantees every key gets a `last_used_at` (or `null` if truly never
used) independent of the 30-day usage-window semantics that `"Usage (last
30d)"` intentionally keeps. This is a design decision for `sdd-design`, not
just an implementation detail — it changes which function/table the field
lives on.

## Approaches

1. **Option A only — list-page "Last used" column**
   - Pros: at-a-glance scan across all keys; one place to look.
   - Cons: no detail beyond a timestamp; doesn't satisfy "lo más detallado
     posible" (as much detail as possible) on its own.
   - Effort: Low (one correlated subquery + one column + interface mirror).

2. **Option B only — detail-page rich "Last Used" card**
   - Pros: zero backend work, all data already in memory, matches the user's
     "as detailed as possible" ask directly (method/path/status/model/
     duration/tokens/ip/user-agent/trace link).
   - Cons: requires navigating into a specific key's detail page — no
     at-a-glance signal on the list.
   - Effort: Low (pure rendering, reuses fetched data + existing
     `deriveKeyMetrics` output).

3. **Both A and B (recommended)**
   - Pros: quick relative-time scan on `/keys` (e.g., "3h ago" / "12d ago")
     for every key at once, AND full forensic detail one click away on the
     key's own page. Marginal cost of A is one indexed subquery; B is free.
   - Cons: touches slightly more files; still low complexity overall.
   - Effort: Low–Medium (A: Low, B: Low; combined still fits in one PR).

## Recommendation

Do **both A and B**. The user explicitly asked for "lo más detallado
posible" (as much detail as possible) — B alone delivers that detail but
only per-key; A alone gives scannability without depth. Combined, the cost
is marginal (A is one indexed correlated subquery + one column; B is
free — the data is already fetched and partly already computed via
`deriveKeyMetrics`).

Implement A on `listApiKeys()` (unwindowed `last_used_at`), not on the
30-day-windowed `getUsageByApiKey()` — see design nuance above. This is the
one point that should NOT be left to accidental implementation choice during
`sdd-design`/`sdd-apply`; flag it explicitly there.

## Risks

- **Windowed vs. unwindowed last-used** (see design nuance) — the single
  biggest correctness risk; must be decided explicitly in `sdd-design`, not
  discovered during `sdd-apply`.
- **`ip`/`user_agent` exposure on the detail card** — not a new exposure
  class: this is an operator-only admin dashboard already gated by
  `enforceApiKey` (`/api/*` requires a valid key, `is_admin` for dashboard
  routes per existing convention), and both fields already exist on
  `RequestRecord` and already reach the client on every other per-request
  view. Worth a one-line note in the design doc, not a blocker.
- **Correlated subquery cost** — fine at current scale with
  `idx_requests_api_key`; if `requests` grows very large, a composite
  `(api_key_id, timestamp DESC)` index would help, but that's a future
  optimization, not required for this change.
- **Strict TDD scope** — only the storage-layer SQL change (Option A) has a
  meaningful failing-test-first story (`__tests__/api-key-storage.spec.ts`).
  Option B is pure JSX using already-tested data (`deriveKeyMetrics` is
  already covered); this project has no component-render test convention to
  extend.

## Ready for Proposal

Yes. Both approaches are additive, low-risk, and fully scoped by file. The
one open design decision (unwindowed `last_used_at` on `listApiKeys()`) should
be carried into `sdd-propose`/`sdd-design` explicitly so it isn't silently
reinterpreted during implementation.
