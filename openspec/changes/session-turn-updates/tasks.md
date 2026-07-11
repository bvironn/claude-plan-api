# Tasks: Session Turn Collapse

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~150–180 |
| 400-line budget risk | Low |
| Chained PRs recommended | No |
| Suggested split | Single PR |
| Delivery strategy | auto-forecast (auto-chain on budget exceeded only) |
| Chain strategy | stacked-to-main |

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: stacked-to-main
400-line budget risk: Low

### Stable identity confirmed

`request.traceId` (string) — unique per turn, already used as React key in the map render (`s.$sessionId.tsx:127`). Array index would reset user toggles on poll re-render; traceId is stable across the component lifecycle. Source: `RequestRecord.traceId` in `src/ui/src/lib/types.ts` + actual `key={turn.request.traceId}` usage.

### State design (inline in tasks — no separate design phase)

- **`useState<Set<string>>`** for `userInteracted` — traceIds the user has ever toggled. These are "locked" against auto-collapse/expand.
- **`useMemo`** derives `expandedTurns` from turn positions + `userInteracted`: last turn always expanded (no Collapsible wrapper); prior turns expanded only if in `userInteracted`.
- The **last turn** renders WITHOUT `Collapsible` (always expanded, no trigger). Prior turns get `<Collapsible open={...} onOpenChange={...}>` wrapping the header (as `CollapsibleTrigger`) and `TranscriptView` (as `CollapsibleContent`).
- On **poll update**: new last turn auto-appears expanded (no Collapsible). Previously-last turn gets a Collapsible wrapper for the first time — its `open` state is `false` unless the user had toggled it (which is impossible since it was the last turn with no trigger), so it collapses correctly.

### Suggested Work Unit

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Collapse state + Collapsible wrapping + tests | Single PR | `bun test __tests__/ui-session-turn-collapse.spec.ts` then `bun run tsc --noEmit` | Open `/s/$sessionId` (real session) — last turn expanded, prior collapsed, toggle works, poll updates preserve state | Revert `src/ui/src/routes/s.$sessionId.tsx` + test file |

---

## Phase 1: Extract Pure State Logic

- [x] 1.1 Extract `computeExpandedTurns(turns, userInteracted): Set<string>` — pure function that returns the set of expanded traceIds given turns array and user-interacted set. Last turn always expanded; prior turns expanded iff in `userInteracted`. → `src/ui/src/lib/session-turns.ts`
- [x] 1.2 Extract `handleToggle(traceId, userInteracted, setUserInteracted)` — pure toggle handler that adds/removes from userInteracted set. → implemented as pure `toggleTurnInteraction(traceId, userInteracted): Set<string>` (returns a new set; component wires it into `setUserInteracted`).

## Phase 2: Write Tests (RED — TDD first)

- [x] 2.1 Test: multi-turn session initial load — last turn expanded in result, prior turns not (spec: Default Last-Turn-Expanded, scenario multi-turn).
- [x] 2.2 Test: single-turn session — that one turn expanded (scenario single-turn).
- [x] 2.3 Test: zero-turn session — empty expanded set, no error (scenario zero-turn).
- [x] 2.4 Test: toggle expands a collapsed prior turn, leaves others unchanged (scenario manual expand).
- [x] 2.5 Test: toggle re-collapses a manually expanded prior turn (scenario re-collapse).
- [x] 2.6 Test: poll adds new turn — new last expands, previous last collapses, user-expanded prior turns stay expanded (scenarios: new turn via polling, prior turn preserved).
- [x] 2.7 Test: rapid successive poll updates — only the most recent turn is auto-expanded, no duplicate auto-expanded state (scenario rapid updates).
- [x] 2.8 Test: poll returns same turn count — expanded set unchanged (scenario no new turn).

## Phase 3: Implement (GREEN) + Wire Component

- [x] 3.1 Implement `computeExpandedTurns` and toggle handler — all tests from Phase 2 pass (13/13 in `__tests__/ui-session-turn-collapse.spec.ts`).
- [x] 3.2 Add `useState<Set<string>>` for `userInteracted` and `useMemo` for expanded derivation in `SessionDetailPage`.
- [x] 3.3 Modify `TurnSection` to accept `isLast`, `isExpanded`, `onToggle` props. Render last turn as-is (no Collapsible). Wrap prior turns in `<Collapsible open={isExpanded} onOpenChange={onToggle}>` with the sticky header as `CollapsibleTrigger` and `TranscriptView` as `CollapsibleContent`. Note: interactive controls (deep link `<a>` + `CopyButton` `<button>`) kept as siblings of the trigger, not nested inside it, to preserve valid HTML.
- [x] 3.4 Verify: `bun run tsc --noEmit` (UI project: `bun run typecheck` → clean; root tsc adds 0 new errors — 7 pre-existing in `transform-streaming-abort-signal.spec.ts`), `bun test` passes (557 pass, 1 pre-existing `observability.spec.ts` hook timeout unrelated to this change), and `bun run build` (UI vite build) succeeds — guards the src/ui test-file gotcha class.

## Phase 4: Verify

- [ ] 4.1 Confirm edge cases manually: open a real session with 0 turns (loading state), 1 turn (no collapsible), 3+ turns (prior collapsed, last expanded). Toggle prior turns. Wait for poll — verify transition. _(Deferred to sdd-verify / human runtime session — apply executor cannot open a live browser.)_
- [ ] 4.2 Archive per SDD close protocol. _(Deferred — separate sdd-archive phase, runs after verify + PR.)_
