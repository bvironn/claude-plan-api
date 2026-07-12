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

import type {
  AnthropicRequestBody,
  OpenAIChatRequestBody,
  RequestRecord,
} from "./types"
import { parseOrNull } from "./format"
import { hash } from "./sessions"

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

// ---------------------------------------------------------------------------
// Render dedup + immutable-turn fetch caching
//
// Each turn of a session re-sends the FULL running message history, so turn `i`
// is (normally) a byte-exact prefix of turn `i+1`. These pure helpers let the
// detail view collapse that repeated prefix into a single reference marker and
// cache immutable (non-last) turns forever — all without touching the upstream
// request path (spec: Upstream Request Path Boundary).
// ---------------------------------------------------------------------------

/**
 * The reusable shape of a single parsed transcript message. Intentionally loose
 * (`content: unknown`) because the same resolver feeds both the diff and the
 * renderer, and `MessageBubble` already normalises any content shape.
 */
export interface TranscriptMessage {
  role: string
  content: unknown
}

/**
 * Per-turn dedup verdict, keyed by traceId in {@link computeMessageDedup}.
 *
 *   - `full`    — render every message (turn 0, a prefix mismatch, or a shrink).
 *   - `deduped` — the leading `sharedCount` messages already rendered in the
 *                 predecessor turn (`originTurnIndex`/`originTraceId`); render a
 *                 single marker for them plus the new suffix.
 */
export type TurnDedup =
  | { kind: "full" }
  | {
      kind: "deduped"
      sharedCount: number
      originTurnIndex: number
      originTraceId: string
    }

/**
 * Resolve the SAME `messages[]` the transcript view renders: prefer the upstream
 * (Anthropic) normalised shape, else fall back to the client (OpenAI) request
 * with system messages filtered out. Shared by `TranscriptView` and
 * `computeMessageDedup` so the diff and the render never drift.
 */
export function resolveTranscriptMessages(record: RequestRecord): TranscriptMessage[] {
  const upstream = parseOrNull<AnthropicRequestBody>(record.upstreamRequestBody)
  const clientReq = parseOrNull<OpenAIChatRequestBody>(record.requestBody)

  // Prefer the upstream normalised shape (what actually went to Anthropic),
  // else fall back to the client request with system rows filtered out. This is
  // byte-for-byte the same resolution `TranscriptView` performs — the two share
  // this helper precisely so the diff and the render can never drift.
  const messages =
    upstream?.messages ??
    (clientReq?.messages?.filter((msg) => msg.role !== "system") as
      | AnthropicRequestBody["messages"]
      | undefined) ??
    []

  return messages.map((msg) => ({ role: msg.role, content: msg.content }))
}

/**
 * Pure render-dedup diff. Keyed by traceId (mirrors `computeExpandedTurns`).
 * Turn 0 is always `full`; any prefix shrink or fingerprint mismatch inside the
 * predecessor's length falls back to `full` (mandatory safety — never
 * partial-dedup a divergent turn); otherwise the shared prefix is deduped.
 */
export function computeMessageDedup(turns: RequestRecord[]): Map<string, TurnDedup> {
  const result = new Map<string, TurnDedup>()

  // Fingerprint every turn's resolved messages ONCE (djb2 over role + content),
  // so the pairwise prefix compare below is O(messages) rather than repeated
  // deep-equals over base64 image blocks.
  const fingerprints: string[][] = turns.map((turn) =>
    resolveTranscriptMessages(turn).map(
      (msg) => hash(`${msg.role}:${JSON.stringify(msg.content)}`),
    ),
  )

  for (let i = 0; i < turns.length; i++) {
    const traceId = turns[i]!.traceId

    // Turn 0 has no predecessor to dedup against.
    if (i === 0) {
      result.set(traceId, { kind: "full" })
      continue
    }

    const prev = fingerprints[i - 1]!
    const curr = fingerprints[i]!

    // Empty-predecessor guard: a predecessor that resolved to zero messages has
    // nothing to dedup against — falling through would otherwise report a
    // vacuous `sharedCount: 0` "deduped" turn instead of just rendering in full.
    if (prev.length === 0) {
      result.set(traceId, { kind: "full" })
      continue
    }

    // Shrink guard: a turn that lost messages relative to its predecessor is an
    // anomaly — never partial-dedup it (mandatory safety fallback).
    if (curr.length < prev.length) {
      result.set(traceId, { kind: "full" })
      continue
    }

    // Mismatch guard: ANY divergence inside the predecessor's length (retry,
    // edit, reorder — including at index 0) forces the whole turn to full.
    let mismatch = false
    for (let p = 0; p < prev.length; p++) {
      if (curr[p] !== prev[p]) {
        mismatch = true
        break
      }
    }
    if (mismatch) {
      result.set(traceId, { kind: "full" })
      continue
    }

    // Clean byte-exact prefix: the leading `prev.length` messages already
    // rendered in turn i-1; dedup them into a single marker.
    result.set(traceId, {
      kind: "deduped",
      sharedCount: prev.length,
      originTurnIndex: i - 1,
      originTraceId: turns[i - 1]!.traceId,
    })
  }

  return result
}

/**
 * Pure caching seam: the last turn stays live (`0`, re-fetched each poll) while
 * every prior turn is immutable (`Infinity`, served from cache forever).
 */
export function turnStaleTime(index: number, total: number): number {
  // The last turn (its content can still grow) stays live; every prior turn is
  // structurally immutable and served from cache forever. `total > 0` guards the
  // degenerate `turnStaleTime(-1, 0)` case → Infinity (default to immutable).
  return index === total - 1 && total > 0 ? 0 : Infinity
}
