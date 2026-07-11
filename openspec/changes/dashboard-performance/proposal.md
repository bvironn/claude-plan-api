# Proposal: Dashboard Performance — Lazy Shiki Chunk + Refetch Tuning

## Intent

The dashboard feels slow in two measurable ways. First, opening a transcript (`/r/$traceId`) blocks on a large synchronous JS chunk: `markdown-view.tsx` statically imports shiki types (line 4), so Vite folds the shiki highlighter + grammar index (`index-CYDd3GAO.js`, 196K) into the transcript chunk (184K) instead of a separate async chunk — the dynamic `import("shiki")` at line 41 never forms an async boundary. Second, background refetch storms (`refetchOnWindowFocus: true` + global `staleTime: 5_000` + `defaultPreloadStaleTime: 0` + index `refetchInterval: 5_000`) cause near-constant fetching and loading flashes. Both are UI-only fixes with high perceived-speed payoff.

## Scope

### In Scope
- Make shiki fully dynamic in `markdown-view.tsx` so it resolves into its own async chunk, off the transcript first-load path.
- Tune React Query defaults: raise `staleTime`, set a non-zero `defaultPreloadStaleTime`, review `refetchOnWindowFocus`.
- Preserve the index route's intentional 5s live polling.

### Out of Scope
- Consolidating `getMetrics()` 7-query pattern (SQLite not the bottleneck at this scale — deferred indefinitely).
- Rollup `manualChunks`, new dependencies, schema or architecture changes.
- Initial-load shiki and per-language grammar chunks (already on-demand, not the problem).

## Capabilities

### New Capabilities
- `dashboard-performance`: perceived-load requirements — shiki loads as an async chunk with a plain-text fallback during the gap; background refetch cadence avoids redundant fetches while keeping live index polling.

### Modified Capabilities
- None.

## Approach

**A — Lazy shiki chunk**: Remove the static `import type` from shiki; use inline `import("shiki")` types or local type aliases so shiki enters the graph only via the dynamic import. Verify the async boundary in the built output. Existing plain-text fallback in the highlighter covers the load gap.

**B — Refetch tuning**: In `main.tsx`, raise `staleTime` (15–30s), set `defaultPreloadStaleTime` non-zero, and review `refetchOnWindowFocus`. Leave `routes/index.tsx` `refetchInterval: 5_000` intact.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/ui/src/components/transcript/markdown-view.tsx` | Modified | Drop static shiki type import; force async chunk |
| `src/ui/src/main.tsx` | Modified | Tune staleTime, preloadStaleTime, focus refetch |
| `src/ui/src/routes/index.tsx` | Unchanged | Keep intentional 5s polling |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Shiki type removal breaks TS types | Med | Use inline `import("shiki")` types; `tsc` gate |
| Async chunk not actually split | Med | Verify built chunk boundary before merge |
| Higher staleTime shows stale data longer | Low | Cap at 15–30s; keep index live polling |

## Rollback Plan

Single PR, isolated to two UI files. Revert the PR (or the two edits) to restore the static import and prior query defaults. No data, schema, or API migration involved.

## Dependencies

- None. No new packages; existing Vite + TanStack Router + React Query stack.

## Success Criteria

- [ ] Shiki resolves as a distinct async chunk absent from the transcript first-load path.
- [ ] Transcript route first navigation downloads less synchronous JS than before.
- [ ] No redundant background refetch on tab focus; index route still polls every 5s.
- [ ] `tsc` and existing UI tests pass; single PR well under 400 changed lines.
