# Tasks: Dashboard Performance 2 — Payload, Compression & Query-Scale Hardening

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~540 (180–250 per phase) |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 (Phase 1) → PR 2 (Phase 2) → PR 3 (Phase 3) → PR 4 (Phase 4) |
| Delivery strategy | auto-forecast |
| Chain strategy | stacked-to-main |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Slim projection + compression (#1, #2) | PR 1 | `bun test __tests__/*dashboard* __tests__/*telemetry*` + `bun run tsc --noEmit` | Start server, `curl -H "Accept-Encoding: br" /api/telemetry/requests \| gunzip` verify slim shape; `curl /api/telemetry/requests?bodies=full` verify full shape | Revert `compression.ts` + gate in `server.ts` + slim type changes |
| 2 | Session-detail resolution (#3) | PR 2 | `bun test __tests__/*ui*` + `bun run tsc --noEmit` | Navigate to session detail page, confirm no recurring 10s poll in network tab | Revert `s.$sessionId.tsx` cache key + poll change |
| 3 | Bounded percentiles + windowed usage (#4, #5) | PR 3 | `bun test __tests__/*storage* __tests__/*telemetry*` + `bun run tsc --noEmit` | Seed `:memory:` DB past `SAMPLE_CAP`, call `getMetrics()`, verify shape | Revert `getMetrics` cap + `getUsageByApiKey` window in `storage.ts` |
| 4 | FTS + dynamic Recharts + memoized pretty-print (#6, #7, #8) | PR 4 | `bun test` + `bun run tsc --noEmit` | Search with FTS term; inspect `/metrics` chunk for Recharts exclusion; check `prettyJson` referential identity on re-render | Drop FTS vtable/triggers; revert `metrics.tsx`/`technical-panel.tsx` |

## Phase 1: Slim Projection + Compression (#1, #2)

- [x] 1.1 Create `src/http/compression.ts` — `maybeCompress(req, res)` gate: `Accept-Encoding` negotiation (br → gzip → identity), allowlist (JSON, known static types) + buffered-body check + no existing `Content-Encoding` guard; sets `Content-Encoding` / `Vary: Accept-Encoding`
- [x] 1.2 Modify `src/http/server.ts` — extract route dispatch tail, wrap single return with `maybeCompress` call; `enforceApiKey`/OPTIONS remain first; static.ts passes through the central gate (no per-file change)
- [x] 1.3 Create `src/observability/conversation-preview.ts` — backend pure function `firstUserPreview(body: string): string|null` extracting first user message text (post-preamble split, ≤400 chars, null for non-chat), mirroring UI heuristic from `sessions.ts`
- [x] 1.4 Modify `src/http/routes/telemetry/requests.ts` — `toCamel()` two-shape projection: slim omits `requestBody`/`responseBody`/`upstreamRequestBody`, adds `firstUserPreview`; parse `?bodies=full` opt-in; by-id endpoint stays full always
- [ ] 1.5 Modify `src/ui/src/lib/types.ts` — `RequestRecord.requestBody`/`responseBody`/`upstreamRequestBody` optional (`string | null | undefined`); add `firstUserPreview?: string | null`; add `RequestFilters.bodies?: "full"`
- [ ] 1.6 Modify `src/ui/src/lib/api.ts` — `listRequests` forwards `bodies` via `toQuery` param passthrough (no signature change)
- [ ] 1.7 Modify `src/ui/src/lib/sessions.ts` — `firstUserTextFromRequest` prefers `record.firstUserPreview`, falls back to existing `requestBody`/`upstreamRequestBody` body parse
- [x] 1.8 Write RED test: compression eligibility — br/gzip pick, identity, exclusion rules (SSE, streaming, already-compressed) — verify `Content-Encoding`/`Vary`, decode round-trips byte-identical
- [x] 1.9 Write RED test: slim projection omits 3 body fields, keeps metadata + `firstUserPreview`
- [ ] 1.10 Write RED test: **grouping parity** — `groupIntoConversations(slim)` produces same conversation ids as `groupIntoConversations(full)` (fixtures with known grouping)
- [x] 1.11 Write RED test: auth-gate-before-compression — `maybeCompress` runs after `enforceApiKey`, cannot bypass auth
- [x] 1.12 Write RED test: SSE / streaming export uncompressed — `text/event-stream` and `ReadableStream` responses pass through with no `Content-Encoding`

## Phase 2: Session-Detail Resolution (#3)

- [ ] 2.1 Modify `src/ui/src/routes/s.$sessionId.tsx` — share one cached slim grouping query between sessions list and detail; change `queryKey` to shared key `["requests", "chat-slim"]`; remove `refetchInterval: 10_000` (resolve once via `staleTime`); group on slim rows with `firstUserPreview`; fetch only the conversation's turns via existing by-id full endpoint
- [ ] 2.2 Write RED test: session-detail does not fire recurring full-body poll (assert single group query, then parallel by-id fetches per turn)

## Phase 3: Bounded Percentiles + Windowed Usage (#4, #5)

- [ ] 3.1 Modify `src/observability/storage.ts` `getMetrics()` — cap latency sample via `SELECT duration_ms … ORDER BY timestamp DESC LIMIT SAMPLE_CAP`, compute p50/p95/p99 in JS; introduce `SAMPLE_CAP` constant; documented tolerance for shifted values
- [ ] 3.2 Modify `src/observability/storage.ts` `getUsageByApiKey()` — enforce default `timeFrom = now − DEFAULT_WINDOW_MS` when caller supplies no `timeFrom` (storage chokepoint)
- [ ] 3.3 Write RED test: capped percentiles — seed `:memory:` DB past `SAMPLE_CAP`; verify shape identical; values within documented tolerance
- [ ] 3.4 Write RED test: windowed usage — out-of-window rows excluded from totals

## Phase 4: FTS + Dynamic Recharts + Memoized Pretty-Print (#6, #7, #8)

- [ ] 4.1 Modify `src/observability/storage.ts` `initStorage()` — add additive external-content FTS5: `CREATE VIRTUAL TABLE IF NOT EXISTS requests_fts USING fts5(request_body, response_body, content='requests', content_rowid='id')` + `AFTER INSERT/UPDATE/DELETE` triggers (IF NOT EXISTS) + one-time `rebuild` when table empty
- [ ] 4.2 Modify `src/observability/storage.ts` — `ftsAvailable` flag; sanitize search term (quoted phrase); `buildRequestWhere` FTS/LIKE branch: when `filters.search` and `ftsAvailable` → `JOIN requests_fts WHERE requests_fts MATCH ?`; else → `LIKE` fallback
- [ ] 4.3 Modify `src/ui/src/routes/metrics.tsx` — dynamic `import()` Recharts components; Recharts excluded from non-`/metrics` route initial chunk
- [ ] 4.4 Modify `src/ui/src/components/panels/technical-panel.tsx` — `useMemo(() => prettyJson(body), [body])` per tab to skip recomputation on re-render with same input
- [ ] 4.5 Write RED test: FTS returns same logical matches as LIKE; LIKE fallback when vtable dropped (missing index / MATCH throw)
- [ ] 4.6 Write RED test: Recharts absent from non-`/metrics` initial chunk (dynamic-import assertion)
- [ ] 4.7 Write RED test: `prettyJson` memoized — `useMemo` referential-equality check on re-render with same body input
