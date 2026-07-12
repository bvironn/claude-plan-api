# Proposal: Session Turn Message Dedup

## Intent

Multi-turn clients resend the full history each call: turn N carries `2N-1` messages, with turn N-1's array as an exact prefix. Cumulative volume over N turns = `Σ(2k-1) = N²` (exact, not just asymptotic). This surfaces twice today: (1) **render** — the always-expanded last turn re-displays every earlier turn's literal text already shown in its own collapsed box; (2) **network** — `turnsQuery` re-fetches all N full bodies on every ~30s poll. Both grow O(n²).

## Scope

### In Scope
- **Render dedup**: a pure diff function in `session-turns.ts` computing the common message-array prefix between a fully-rendered turn and the immediately-preceding turn (data already in memory). Shared-prefix messages render as a compact "already shown in Turn K" reference marker (consistent with the existing `Turn N / total` badge + `Collapsible` language); only the new suffix renders in full.
- **Fetch caching**: apply `staleTime: Infinity` (or equivalent) to any turn that is not the current last turn (structurally immutable once fetched), so polling stops re-downloading already-fetched turn bodies.

### Out of Scope
- Any backend/upstream API change; any change to what is sent to the LLM (full untouched history stays exactly as today).
- Backend message-index/slicing endpoint (Approach 3) — deferred, higher risk/effort.
- Re-opening `session-turn-updates` Phase 4 (verify/archive) — pre-existing, separate loose end.

## Capabilities

### New Capabilities
- `session-transcript-dedup`: render-only message deduplication with safe full-render fallback, plus immutable-turn fetch caching in the session detail view.

### Modified Capabilities
- None.

## Approach

Client-only, additive. Diff operates on the SAME resolved array `TranscriptView` renders (`upstreamRequestBody.messages` with `requestBody.messages` fallback). Reuse the `hash()` djb2 pattern (`sessions.ts`) for cheap prefix equality — no deep-equal. **Mandatory safety (testable)**: if a later turn's prefix does NOT byte-match the earlier turn's array at any position (retry, edit, reorder), fall back to rendering that turn in FULL — never drop or mis-reference content.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/ui/src/lib/session-turns.ts` | Modified | Add pure `computeMessageDedup` (mirrors `computeExpandedTurns`) + fallback |
| `src/ui/src/routes/s.$sessionId.tsx` | Modified | Per-turn `staleTime` by last-turn check; pass diff to `TurnSection`/`TranscriptView` |
| `src/ui/src/components/transcript/transcript-view.tsx` | Modified | Render reference marker instead of full content for deduped messages |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Prefix mismatch drops content | Med | Mandatory full-render fallback, unit-tested |
| Equality-check cost on large blocks | Low | djb2 hash fingerprint, not deep-equal |
| First-load bytes still O(n²) | Known | Caching only avoids RE-fetch; documented follow-up |

## Rollback Plan

Additive UI-only logic. Revert the diff + `staleTime` wiring; behavior falls back to today's always-render-full + refetch-all. Trivial, no data/schema/backend impact.

## Dependencies

- Merged `session-turn-updates` (Collapsible + last-turn-expanded model). No other dependency.

## Success Criteria

- [ ] A session with N turns renders each unique message exactly once across all turn boxes combined, except the always-expanded last turn where deduped messages show a reference marker instead of full content.
- [ ] A prefix mismatch (retry/edit/reorder) renders that turn in FULL — no dropped/mis-referenced message (unit-tested).
- [ ] Turns other than the current last turn are not re-fetched on subsequent polls once fetched.
- [ ] LLM request path unchanged; full history still sent.

## Review Workload

Rough estimate ~180–260 changed lines: `session-turns.ts` diff fn ~50–80; `s.$sessionId.tsx` wiring ~30–50; `transcript-view.tsx` marker ~30–50; unit tests ~60–80. Within the 400-line budget — single PR likely; confirm in `sdd-tasks`.
