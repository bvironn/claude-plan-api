# Proposal: Filter Sessions & Requests by API Key

## Intent

Admins can see per-key usage totals in `/keys`, but the **Requests** (`/`) and **Sessions** (`/sessions`) views cannot be narrowed to a single API key — there is no way to answer "what did key X do?". Requests are already attributed: the `requests.api_key_id` column exists (`RequestRecord.api_key_id`) and `getUsageByApiKey()` groups on it. This change surfaces that attribution as a filter control on both views.

## Scope

### In Scope
- Backend: add `apiKeyId?: number` to `RequestFilters`; `buildRequestWhere()` appends `api_key_id = ?`; parse `apiKeyId` query param in `_handleTelemetryRequests` (`src/http/routes/telemetry/requests.ts`).
- Include `apiKeyId` in the request row `toCamel()` projection so the UI can read/display attribution.
- UI: shared API-key `<select>` populated from `GET /api/keys` (`listApiKeys()`), wired into Requests (`index.tsx` + `requests-filters.tsx`) as a URL-driven param, and into Sessions (`sessions.tsx`, which currently has no filter UI).
- UI client: add `apiKeyId?` to `RequestFilters` (`src/ui/src/lib/types.ts`); `listRequests`/`toQuery` already forward it.

### Out of Scope
- Redesigning the telemetry pages, pagination, or new charts.
- Filtering the raw `/logs` (events) view or CSV `export`.
- Server-side session grouping (Sessions stays client-grouped via `groupIntoConversations`).

## Capabilities

### New Capabilities
- `telemetry-key-filter`: filter Requests and Sessions telemetry views by `api_key_id`, backed by an `apiKeyId` query param on `GET /api/telemetry/requests`.

### Modified Capabilities
- None (the Requests/Sessions views are not currently tracked as openspec specs).

## Approach

Extend the existing `RequestFilters` filter chain (same pattern as `model`/`status`) with one nullable `apiKeyId` condition — no new query, no schema change. The route already camelCases its params (`traceId`, `minDuration`), so use `?apiKeyId=N`. The UI adds one select control fed by `listApiKeys()`; Sessions reuses the same `listRequests` call it already makes, just passing `apiKeyId`.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/observability/storage.ts` | Modified | `RequestFilters` + `buildRequestWhere` gain `apiKeyId` |
| `src/http/routes/telemetry/requests.ts` | Modified | Parse `apiKeyId`; expose in `toCamel` |
| `src/ui/src/lib/types.ts` | Modified | Add `apiKeyId?` to `RequestFilters` |
| `src/ui/src/components/layout/requests-filters.tsx` | Modified | Add key `<select>` |
| `src/ui/src/routes/index.tsx` | Modified | URL param + wiring |
| `src/ui/src/routes/sessions.tsx` | Modified | Add key filter control |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Legacy rows have `NULL api_key_id` | High | Filter is opt-in; "All keys" default shows everything |
| Revoked keys still referenced by past requests | Med | `listApiKeys()` returns revoked keys with `revoked_at`; label them in the select |
| Param naming drift (`api_key_id` vs `apiKeyId`) | Low | Follow route's existing camelCase convention |

## Rollback

Revert the UI and route/storage commits. The `apiKeyId` condition is purely additive (no migration, no schema change); omitting the param restores prior unfiltered behavior.

## Dependencies

- Existing `GET /api/keys` (`listApiKeys()`) and `requests.api_key_id` attribution — both already present.

## Success Criteria

- [ ] `GET /api/telemetry/requests?apiKeyId=N` returns only requests attributed to key N.
- [ ] Requests and Sessions views each expose a key selector populated from `/api/keys`.
- [ ] Default "All keys" preserves current unfiltered behavior; selection is URL-shareable on Requests.
