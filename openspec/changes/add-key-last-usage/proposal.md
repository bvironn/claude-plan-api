# Proposal: Show Last Usage Detail for an API Key

## Intent

Operators cannot see when an API key was last used. The `/keys` list only
shows a windowed "Usage (last 30d)" aggregate, and the `/keys/$keyId` detail
page fetches the most recent request but never renders it. The user asked for
the last time each key was used, "as detailed as possible."

## Scope

### In Scope

- **A** — Compact relative-time "Last used" column on the `/keys` list page.
- **A** — `listApiKeys()` returns an **unwindowed** `last_used_at` per key.
- **B** — Rich "Last Used" card on `/keys/$keyId` rendering the most recent
  request (method, path, status, model, duration, token breakdown, ip,
  user-agent, trace link) plus a relative-time label.

### Out of Scope

- Composite `(api_key_id, timestamp)` index (future scale optimization).
- Any redaction/PII policy change (ip/user-agent already surfaced elsewhere).
- New backend work for Option B (data already fetched and computed).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `api-key-management`: ADD a requirement that `listApiKeys()` and `GET
  /api/keys` expose `last_used_at` computed **unwindowed** (`MAX(timestamp)`
  correlated subquery over `requests`, index-backed by `idx_requests_api_key`),
  independent of the 30-day usage window; `/keys` renders it as a "Last used"
  column via `formatRelativeTime()`, showing `null` as never used.
- `api-key-detail`: ADD a requirement that `/keys/$keyId` renders the most
  recent request (`requests[0]`) as a detailed "Last Used" card and surfaces
  the already-computed `metrics.lastActivity` relative time; clean empty state
  when the key has zero requests.

## Approach

Compute `last_used_at` on `listApiKeys()` — NOT on the windowed
`getUsageByApiKey()`, which would render idle-but-real keys as "never." Add
the field to `ApiKeyMeta` (backend `src/observability/types.ts` + frontend
mirror `src/ui/src/lib/api.ts`). Option B is pure rendering over data already
in memory.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/observability/storage.ts` | Modified | `listApiKeys()` adds unwindowed `last_used_at` subquery |
| `src/observability/types.ts` | Modified | `last_used_at` on `ApiKeyMeta` |
| `src/ui/src/lib/api.ts` | Modified | Mirror `last_used_at` field |
| `src/ui/src/routes/keys.tsx` | Modified | "Last used" column |
| `src/ui/src/routes/keys.$keyId.tsx` | Modified | "Last Used" detail card |
| `__tests__/api-key-storage.spec.ts` | Modified | Failing-first `last_used_at` tests |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Windowed vs unwindowed confusion | Med | Explicitly pin unwindowed on `listApiKeys()` |
| Subquery cost at scale | Low | `idx_requests_api_key` covers current scale |

## Rollback Plan

Purely additive. Revert the diff — no migrations, no schema/data changes, no
data loss. `last_used_at` is derived at read time from existing `requests`.

## Dependencies

None. Uses existing tables, indexes, and fetched data.

## Success Criteria

- [ ] `/keys` shows a relative-time "Last used" per key, `null` → never.
- [ ] `last_used_at` is correct for keys idle beyond 30 days.
- [ ] `/keys/$keyId` renders the most recent request in full detail.
- [ ] New `listApiKeys()` tests written failing-first, then green.
- [ ] `bun test` and both type-checks pass.
