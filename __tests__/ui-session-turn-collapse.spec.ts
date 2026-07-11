import { test, expect, describe } from "bun:test"

import {
  computeExpandedTurns,
  toggleTurnInteraction,
} from "../src/ui/src/lib/session-turns"

// ---------------------------------------------------------------------------
// computeExpandedTurns(turnIds, userInteracted) — pure derivation of which
// turns render expanded. Contract:
//   - The last turn is ALWAYS expanded (spec: Default Last-Turn-Expanded).
//   - A prior turn is expanded IFF the user has toggled it open (present in
//     userInteracted).
//   - Zero turns → empty set, no error.
// ---------------------------------------------------------------------------

describe("computeExpandedTurns", () => {
  // Task 2.1 — spec: Multi-turn session initial load
  test("multi-turn initial load expands only the last turn", () => {
    const expanded = computeExpandedTurns(["a", "b", "c"], new Set())
    expect(expanded).toEqual(new Set(["c"]))
    // Prior turns are collapsed.
    expect(expanded.has("a")).toBe(false)
    expect(expanded.has("b")).toBe(false)
  })

  // Task 2.2 — spec: Single-turn session
  test("single-turn session expands that one turn", () => {
    const expanded = computeExpandedTurns(["only"], new Set())
    expect(expanded).toEqual(new Set(["only"]))
  })

  // Task 2.3 — spec: Zero-turn session
  test("zero-turn session yields an empty expanded set without error", () => {
    const expanded = computeExpandedTurns([], new Set())
    expect(expanded).toEqual(new Set())
    expect(expanded.size).toBe(0)
  })

  // Task 2.4 — spec: Expand a collapsed prior turn (others unchanged)
  test("a user-toggled prior turn is expanded while other priors stay collapsed", () => {
    const expanded = computeExpandedTurns(["a", "b", "c"], new Set(["a"]))
    // last (c) always expanded + user-expanded prior (a); b stays collapsed.
    expect(expanded).toEqual(new Set(["a", "c"]))
    expect(expanded.has("b")).toBe(false)
  })

  // Task 2.5 — spec: Re-collapse a manually expanded turn.
  // Exercises the real round-trip (expand -> toggle off -> collapsed), not just
  // an already-empty set, so the "re-collapse" behavior is genuinely proven.
  test("re-collapsing a manually expanded prior turn removes it from the expanded set", () => {
    // Prior turn "a" is user-expanded; last turn "c" is always expanded.
    const expandedBefore = computeExpandedTurns(["a", "b", "c"], new Set(["a"]))
    expect(expandedBefore).toEqual(new Set(["a", "c"]))
    // The user re-collapses "a" via the toggle; deriving again drops it.
    const interactedAfter = toggleTurnInteraction("a", new Set(["a"]))
    const expandedAfter = computeExpandedTurns(["a", "b", "c"], interactedAfter)
    expect(expandedAfter.has("a")).toBe(false)
    expect(expandedAfter).toEqual(new Set(["c"]))
  })

  // Task 2.6 — spec: New turn arrives via polling / prior preserved
  test("polling a new last turn expands it, collapses the old last, and preserves user-expanded priors", () => {
    // Before poll: turns [a, b] with user having expanded prior "a".
    const before = computeExpandedTurns(["a", "b"], new Set(["a"]))
    expect(before).toEqual(new Set(["a", "b"]))

    // Poll adds "c". "b" was the last turn (no trigger) so it was never
    // toggled → not in userInteracted → it now collapses. "a" stays expanded.
    const after = computeExpandedTurns(["a", "b", "c"], new Set(["a"]))
    expect(after).toEqual(new Set(["a", "c"]))
    expect(after.has("b")).toBe(false)
  })

  // Task 2.7 — spec: Rapid successive updates
  test("rapid successive turns auto-expand only the most recent, never more than one auto-expanded last", () => {
    const step1 = computeExpandedTurns(["a", "b"], new Set())
    expect(step1).toEqual(new Set(["b"]))

    const step2 = computeExpandedTurns(["a", "b", "c"], new Set())
    expect(step2).toEqual(new Set(["c"]))

    const step3 = computeExpandedTurns(["a", "b", "c", "d"], new Set())
    expect(step3).toEqual(new Set(["d"]))
    // Exactly one auto-expanded turn (the last) — no accumulation.
    expect(step3.size).toBe(1)
  })

  // Task 2.8 — spec: Poll returns no new turn
  test("re-deriving with the same turn count and interactions yields the same expanded set", () => {
    const ids = ["a", "b", "c"]
    const interacted = new Set(["b"])
    const first = computeExpandedTurns(ids, interacted)
    const second = computeExpandedTurns(ids, interacted)
    expect(first).toEqual(new Set(["b", "c"]))
    expect(second).toEqual(first)
  })

  test("does not mutate the userInteracted set it receives", () => {
    const interacted = new Set(["a"])
    computeExpandedTurns(["a", "b"], interacted)
    expect(interacted).toEqual(new Set(["a"]))
  })
})

// ---------------------------------------------------------------------------
// toggleTurnInteraction(traceId, userInteracted) — pure toggle that returns a
// NEW set with traceId added if absent, removed if present. Used by the
// component's onToggle for prior turns.
// ---------------------------------------------------------------------------

describe("toggleTurnInteraction", () => {
  // Task 2.4 — expand: adds a not-yet-interacted prior turn.
  test("adds a traceId that was not previously interacted with", () => {
    const next = toggleTurnInteraction("a", new Set())
    expect(next).toEqual(new Set(["a"]))
  })

  // Task 2.5 — re-collapse: removes an already-interacted prior turn.
  test("removes a traceId that was already interacted with", () => {
    const next = toggleTurnInteraction("a", new Set(["a"]))
    expect(next).toEqual(new Set())
  })

  test("leaves other traceIds untouched when toggling one", () => {
    const next = toggleTurnInteraction("b", new Set(["a", "c"]))
    expect(next).toEqual(new Set(["a", "b", "c"]))
  })

  test("returns a new set and does not mutate the input", () => {
    const input = new Set(["a"])
    const next = toggleTurnInteraction("b", input)
    expect(input).toEqual(new Set(["a"]))
    expect(next).not.toBe(input)
  })
})
