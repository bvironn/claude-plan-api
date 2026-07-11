# Proposal: Dashboard Performance 2 — Payload, Compression & Query-Scale Hardening

## Intent

Follow-up to merged `dashboard-performance` (PR #26, shiki chunk + refetch tuning). The `sdd/explore/dashboard-performance-audit` audit found 8 file:line-verified issues where the stack ships or recomputes far more than needed on every load/poll: the telemetry list endpoint always returns full request/response/upstream bodies (whole agentic conversation histories) even to pages that never render them; nothing compresses JSON or static assets; the session-detail page refetches 500 full-body rows every 10s to resolve one conversation; and several storage queries pull/aggregate unbounded rows or scan large TEXT with leading-wildcard `LIKE`. Goal: cut bytes-over-wire and per-request/render cost with no observable data change.

## Scope

### In Scope
- Slim/summary projection for `/api/telemetry/requests` — default omits 3 body fields; full bodies opt-in (#1)
- HTTP compression (gzip/br) negotiated on `Accept-Encoding` for JSON + static assets, with `Vary` (#2)
- Efficient session-detail resolution: drop the 10s full-body 500-row poll; batch per-turn fetches (#3)
- Bound `getMetrics()` percentile computation; enforce a time window on `getUsageByApiKey()` (#4, #5)
- FTS-backed request search replacing leading-wildcard `LIKE`; dynamic-import Recharts off `/metrics`; memoize technical-panel JSON pretty-print (#6, #7, #8)

### Out of Scope
- Redesigning body storage / dropping raw bodies (audit trail needed by `sessions.tsx`/`export.ts`)
- New telemetry data or dashboards; auth/routing changes; non-Bun backend deps

## Capabilities

### New Capabilities
- `http-compression`: responses negotiate gzip/br via `Accept-Encoding`; set `Vary: Accept-Encoding`; exclude streaming/SSE (`export.ts`, `stream.ts`) and already-compressed types.
- `telemetry-list-projection`: `/api/telemetry/requests` default omits request/response/upstream body fields; body-consumers opt in; session-grouping inputs preserved.
- `telemetry-query-scaling`: bounded metric percentiles, windowed usage aggregation, FTS-backed request search, and efficient session-detail fetch.

### Modified Capabilities
- None. No existing telemetry spec in `openspec/specs/`. Frontend-only items #7/#8 are implementation-level (no spec).

## Approach

Phased by impact-then-risk for stacked-to-main chained PRs if total exceeds the 400-line budget. Each phase is an independent, verifiable slice with its own rollback.

- **Phase 1 (highest leverage, low risk)** — #1 slim list + #2 compression. Cuts the largest, most frequent payloads (every poll + asset load). Caps `http-compression` + `telemetry-list-projection`.
- **Phase 2** — #3 session-detail overfetch fix.
- **Phase 3 (scale-safety)** — #4 bounded percentiles + #5 windowed usage.
- **Phase 4 (lower urgency)** — #6 FTS + #7 Recharts dynamic import + #8 memoized pretty-print. Phases 2–4 cap `telemetry-query-scaling` + frontend impl.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/http/routes/telemetry/requests.ts` | Modified | `toCamel()` slim projection; opt-in full bodies (#1) |
| `src/http/server.ts`, `src/http/static.ts` | Modified | Add `Accept-Encoding` negotiation + `Vary` (#2) |
| `src/http/routes/telemetry/export.ts`, `stream.ts` | Unchanged | Must stay uncompressed/streaming (#2 guard) |
| `src/ui/src/routes/s.$sessionId.tsx` | Modified | Drop 10s full-body poll; batch per-turn fetch (#3) |
| `src/ui/src/routes/index.tsx`, `sessions.tsx` | Modified | Consume slim endpoint; preserve grouping (#1) |
| `src/observability/storage.ts` | Modified | Bounded percentiles (583-585), usage window (534-557), FTS (287,373) (#4,#5,#6) |
| `src/ui/src/routes/metrics.tsx` | Modified | Dynamic-import Recharts (#7) |
| `src/ui/src/components/panels/technical-panel.tsx` | Modified | Memoize `prettyJson()` (#8) |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Compression breaks `export.ts` streaming / `stream.ts` SSE / `Content-Length` (#2) | High | Skip compression for streaming/SSE + already-compressed types; opt-in per content-type; SSE test |
| Slim `RequestRecord` breaks `sessions.tsx`/`lib/sessions.ts` grouping (#1) | Med | Keep body-consumers on full shape; type-gate; verify grouping fields |
| SQLite lacks native percentile → approximation shifts values (#4) | Med | Bounded sample/window; document tolerance; keep output shape |
| FTS index migration on large TEXT (#6) | Med | Additive index/migration; fallback to `LIKE`; no schema break |
| Session-detail refactor needs new lookup endpoint (#3) | Med | Prefer client cache-key restructure; add endpoint only if required |

## Rollback Plan

Per-phase, independent PRs. Revert any phase's PR without touching others. #1/#3/#7/#8 are behavior-preserving edits (no migration). #2 revert removes response headers only. #6 FTS index is additive/drop-safe; #4/#5 revert restores prior queries. No destructive schema changes.

## Dependencies

- None new. Bun-native `Bun.gzipSync`/brotli; existing `bun:sqlite` FTS5; Vite dynamic import.

## Success Criteria

- [ ] `/api/telemetry/requests` default payload excludes body fields; body-consuming pages still work.
- [ ] JSON + static responses compressed when `Accept-Encoding` allows; streaming/SSE/export unaffected.
- [ ] Session-detail no longer polls 500 full-body rows every 10s.
- [ ] `getMetrics()`/`getUsageByApiKey()` bounded/windowed; search uses FTS; Recharts off `/metrics` chunk; pretty-print memoized.
- [ ] `bun test` + `bun run tsc --noEmit` pass; each phase deliverable within the 400-line review budget.
