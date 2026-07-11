/**
 * Pure collapse-state logic for the session detail view (`SessionDetailPage`).
 *
 * Each turn's transcript is a superset of the prior turn, so only the newest
 * turn carries new information. These helpers derive which turns render
 * expanded from two inputs:
 *
 *   - `turnIds`        — the turns' stable identities (traceIds) in chronological
 *                        order. The last element is the current (newest) turn.
 *   - `userInteracted` — the set of PRIOR-turn traceIds the user has explicitly
 *                        toggled open. Membership is "locked" against
 *                        auto-collapse: it survives poll re-renders.
 *
 * Kept as side-effect-free functions (no React, no DOM) so the collapse
 * behaviour is unit-testable in isolation from the component.
 */

/**
 * Derive the set of expanded turn ids.
 *
 * Rules:
 *   - The LAST turn is always expanded (and never collapsible below open).
 *   - A prior turn is expanded IFF it is present in `userInteracted`.
 *   - Zero turns → empty set.
 *
 * The returned set is fresh; `userInteracted` is never mutated.
 */
export function computeExpandedTurns(
  turnIds: string[],
  userInteracted: Set<string>,
): Set<string> {
  const expanded = new Set<string>()
  if (turnIds.length === 0) return expanded

  const lastId = turnIds[turnIds.length - 1]!

  for (const id of turnIds) {
    // The last turn is always expanded; prior turns only when the user has
    // explicitly toggled them open.
    if (id === lastId || userInteracted.has(id)) {
      expanded.add(id)
    }
  }

  return expanded
}

/**
 * Toggle a prior turn's user-interaction membership.
 *
 * Returns a NEW set: `traceId` is added when absent (user expands a collapsed
 * prior turn) or removed when present (user re-collapses it). The input set is
 * never mutated, so it is safe to hand straight to a React state setter.
 */
export function toggleTurnInteraction(
  traceId: string,
  userInteracted: Set<string>,
): Set<string> {
  const next = new Set(userInteracted)
  if (next.has(traceId)) {
    next.delete(traceId)
  } else {
    next.add(traceId)
  }
  return next
}
