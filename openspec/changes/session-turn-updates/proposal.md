# Proposal: Collapsible Session Turns (Last-Turn-Expanded)

## Intent

`SessionDetailPage` (`src/ui/src/routes/s.$sessionId.tsx`) renders every turn of a
conversation fully expanded — no collapse state exists. Because multi-turn clients
resend the full running history each turn, turn N's transcript is a superset of
turn N-1's, so stacking all N turns is redundant by construction and forces users
to scroll past duplicated history to reach the newest exchange. Backlog issue #4
asks that sessions "show only the last turn, updatable live."

## Scope

### In Scope
- Collapse turns `0..n-2` by default; keep the **last** turn always expanded.
- Allow the user to manually expand/collapse any previous turn.
- Reuse the existing `Collapsible` UI pattern (already used 5x in the codebase).
- Preserve the current authenticated polling (`refetchInterval: 10_000`) so the
  visible last turn keeps updating live — no data-fetch behavior change.

### Out of Scope
- SSE-based incremental streaming of the in-progress turn (Approach 3). It would
  drag in the EventSource/Bearer 401 gotcha (Engram #838, `/live`-only) as a hard
  blocker — deferred.
- Lazy-fetching bodies for collapsed turns (Approach 2) — separate optimization.
- Any backend / upstream / transform changes.

## Capabilities

### New Capabilities
- `session-turn-collapse`: UI behavior for the session detail view — which turns
  render expanded vs collapsed, and how a user toggles them.

### Modified Capabilities
- None. No existing spec covers the UI session detail view.

## Approach

Add local collapse state to `SessionDetailPage`. Wrap each non-latest `TurnSection`
in the existing `Collapsible` / `CollapsibleTrigger` / `CollapsibleContent`
components; the turn's existing sticky header becomes the trigger row. The last turn
in `turnsQuery.data` renders outside a collapsible (or defaultOpen) so it is always
visible. Polling stays exactly as-is.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/ui/src/routes/s.$sessionId.tsx` | Modified | Add collapse state; wrap non-last turns in `Collapsible` |
| `src/ui/src/components/ui/collapsible.tsx` | Reused | Existing pattern, no change |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Collapsed turn hides content user expected | Low | Any turn is manually expandable; last always open |
| Header re-used as trigger breaks sticky styling | Low | Verify against 5 existing `Collapsible` usages |

## Rollback Plan

UI-only, single-file behavioral change. Revert the commit to
`src/ui/src/routes/s.$sessionId.tsx` (and any test) to restore fully-expanded
rendering. No data migration, no backend or API state to unwind.

## Dependencies

- None. Reuses existing `Collapsible` components already in the tree.

## Success Criteria

- [ ] Only the last turn is expanded on initial load; all previous turns collapsed.
- [ ] Any collapsed turn can be manually expanded and re-collapsed.
- [ ] Last turn still updates live via existing 10s authenticated polling.
- [ ] No changes to backend, fetching, or the `/live` SSE path.
