# Design: Session Turn Message Dedup

## Technical Approach

Two additive, client-only optimizations on the session-detail view (`s.$sessionId.tsx`),
both anchored on pure functions in `session-turns.ts` (bun:test, no DOM) with thin React wiring:

1. **Render dedup** — `computeMessageDedup(turns)` diffs each turn's resolved `messages[]`
   against its predecessor using djb2 fingerprints. A turn whose predecessor is a byte-exact
   prefix collapses that prefix into ONE static "already shown in Turn K" marker and renders
   only the new suffix; ANY mismatch → the whole turn renders full.
2. **Fetch caching** — each turn body is cached per-`traceId` with `staleTime: Infinity` for
   non-last (immutable) turns; the last turn stays live via the poll.

Both diff and render on the SAME array `TranscriptView` shows, via a shared
`resolveTranscriptMessages(record)` helper reused by the view and the diff — satisfying the
spec's "compare the same resolved message arrays the transcript view renders".

## Architecture Decisions

| Decision | Choice | Alternatives | Rationale |
|---|---|---|---|
| Message fingerprint | Reuse djb2 `hash()` (export it from `sessions.ts`); fingerprint = `role + ":" + stringify(content)`, hashed once per turn | deep-equal per position | O(bytes) once/turn; avoids repeated deep-equals over base64 image blocks; proposal-mandated reuse |
| Diff source of truth | Extract `resolveTranscriptMessages(record)` used by BOTH `TranscriptView` and `computeMessageDedup` | resolve independently in each | Guarantees diff and render see the identical array — no drift |
| Fetch caching mechanism | Keep the single `useQuery` + `Promise.all`; wrap each turn in `queryClient.ensureQueryData(["session-turn", id], …, { staleTime: turnStaleTime(i,total) })`; add `refetchInterval` to the outer query | `useQueries` (one observer/turn) | Preserves `turnsQuery.data`/`isPending`/render `.map` untouched (smallest diff); the per-turn cache entry still yields per-turn `staleTime` |
| Marker UX | ONE static muted marker per shared prefix ("N earlier messages already shown in Turn K") | per-message markers; clickable scroll-to jump | Prior turn sits directly above (collapsible); static + non-interactive also sidesteps the interactive-nesting HTML rule; clickable jump deferred |
| Dedup scope | Every turn except turn 0 (uniform, keyed by traceId) | last-turn only | Same duplication exists in any manually expanded prior turn; uniform is simpler and correct |
| Mismatch handling | Explicit `{ kind: "full" }` result variant | silent empty diff / partial dedup | Type-safe mandatory safety; never drops or mis-references (spec fallback) |

## Interfaces / Contracts

```ts
// src/ui/src/lib/session-turns.ts
export interface TranscriptMessage { role: string; content: unknown }

/** Same messages[] TranscriptView renders: upstream.messages, else client (non-system). */
export function resolveTranscriptMessages(record: RequestRecord): TranscriptMessage[]

export type TurnDedup =
  | { kind: "full" }                                      // turn 0, or prefix mismatch/shrink
  | { kind: "deduped"; sharedCount: number;               // leading messages already shown
      originTurnIndex: number; originTraceId: string }     // predecessor (i-1)

/** Pure. Keyed by traceId, mirrors computeExpandedTurns. */
export function computeMessageDedup(turns: RequestRecord[]): Map<string, TurnDedup>

/** Pure caching seam: last turn live (0), priors immutable (Infinity). */
export function turnStaleTime(index: number, total: number): number

// src/ui/src/components/transcript/transcript-view.tsx
export function TranscriptView(props: { record: RequestRecord; dedup?: TurnDedup }): JSX.Element
```

`TranscriptView`: when `dedup.kind === "deduped"`, render `<DedupMarker>` then
`messages.slice(sharedCount)`; otherwise render all messages — backward-compatible for
`r.$traceId.tsx` and other callers that pass no `dedup`.

## Data Flow

```
groupQuery ─▶ conversation.traceIds
   │
   ▼ turnsQuery (1 useQuery, refetchInterval = SESSION_GROUPING_REFETCH_INTERVAL_MS)
   queryFn: Promise.all(traceIds.map((id, i, arr) =>
       queryClient.ensureQueryData(["session-turn", id], () => getRequest(id),
           { staleTime: turnStaleTime(i, arr.length) })))   // last = 0, prior = Infinity
   │  turns: RequestByTraceResponse[]
   ▼ useMemo
   computeMessageDedup(turns.map(t => t.request)) ─▶ Map<traceId, TurnDedup>
   │
   ▼ per turn
   TurnSection(request, dedup) ─▶ TranscriptView(record, dedup)
       deduped ? [ marker + messages.slice(sharedCount) ] : all messages
```

**Safety-fallback sequence** (per turn `i`, in order — hash each message once, reuse arrays):

```
hashes[i] = resolveTranscriptMessages(turn i).map(fingerprint)
i == 0                             → full
len(i) < len(i-1)                  → full           (shrunk / anomaly)
∃ p < len(i-1): hashes[i][p] ≠ …   → full           (retry / edit / reorder)
else                               → deduped(sharedCount = len(i-1), origin = i-1)
last turn recomputed every render (useMemo on `turns`) — its content can grow
```

**Caching semantics** (spec: Immutable-Turn Caching + Live Last-Turn Updates): the outer
`refetchInterval` re-runs the queryFn each poll; `ensureQueryData` sees `staleTime: 0` for the
last turn → re-fetch, and `staleTime: Infinity` for priors → cache hit, no network. When a new
turn arrives the previous last turn moves to a non-last index → `turnStaleTime` returns
`Infinity` → it stops being re-fetched, served from cache. The 30s ensureQueryData touch keeps
prior entries warm (well under React Query's default `gcTime`).

## File Changes

| File | Action | Description |
|---|---|---|
| `src/ui/src/lib/session-turns.ts` | Modify | Add `resolveTranscriptMessages`, `computeMessageDedup`, `TurnDedup`, `turnStaleTime` (all pure) |
| `src/ui/src/lib/sessions.ts` | Modify | `export` the existing djb2 `hash()` for reuse |
| `src/ui/src/routes/s.$sessionId.tsx` | Modify | `ensureQueryData` per turn + outer `refetchInterval`; `useMemo` dedup Map; thread `dedup` through `TurnSection` → `TranscriptView` |
| `src/ui/src/components/transcript/transcript-view.tsx` | Modify | Optional `dedup` prop; use shared resolver; render marker + suffix |
| `__tests__/ui-session-message-dedup.spec.ts` | Create | Unit tests for the three pure functions |

## Testing Strategy

| Layer | What to Test | Approach |
|---|---|---|
| Unit | `computeMessageDedup`: prefix dedup + suffix-only, mismatch@>0 → full, mismatch@0 → full, shrink → full, turn 0 → full, 0/1-turn, no input mutation | bun:test, pure, no DOM (mirrors `ui-session-turn-collapse.spec.ts`) |
| Unit | `resolveTranscriptMessages`: upstream-preferred, client fallback (system-filtered), empty/malformed | bun:test, pure |
| Unit | `turnStaleTime`: last → 0, prior → Infinity, single/zero-turn | bun:test, pure |
| Integration | Upstream history unchanged (boundary) | existing telemetry/upstream-body specs stay green — no backend touched |

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file classification, or
process-integration boundary. Pure client-side React / React-Query change.

## Migration / Rollout

No migration. Additive UI-only; reverting the four wiring edits restores today's render-full +
refetch-all behavior. LLM/upstream request path untouched (spec boundary).

## Open Questions

- [ ] djb2 collision could false-mark a message as duplicate and hide it. Residual, display-only
      (data still fetched; the prior turn still renders it in full; LLM path untouched); accepted
      per the proposal's hash-over-deep-equal choice.
- [ ] Clickable "jump to Turn K" marker deferred to a follow-up (v1 static, keeps review budget down).
