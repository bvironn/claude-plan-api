import { test, expect, describe } from "bun:test"

import {
  resolveTranscriptMessages,
  computeMessageDedup,
  turnStaleTime,
} from "../src/ui/src/lib/session-turns"
import type { RequestRecord } from "../src/ui/src/lib/types"

// ---------------------------------------------------------------------------
// Fixtures. Only the body fields the dedup helpers read matter; the rest are
// filled with representative defaults so the RequestRecord shape type-checks.
// ---------------------------------------------------------------------------

type Msg = { role: string; content: unknown }

/** A single chat message helper. */
function m(role: string, content: string): Msg {
  return { role, content }
}

function makeRecord(
  traceId: string,
  bodies: { upstreamMessages?: Msg[]; clientMessages?: Msg[] } = {},
): RequestRecord {
  const upstreamRequestBody =
    bodies.upstreamMessages !== undefined
      ? JSON.stringify({ model: "claude-x", max_tokens: 1, messages: bodies.upstreamMessages })
      : null
  const requestBody =
    bodies.clientMessages !== undefined
      ? JSON.stringify({ model: "gpt-x", messages: bodies.clientMessages })
      : null
  return {
    id: 1,
    traceId,
    timestamp: "2026-01-01T00:00:00.000Z",
    method: "POST",
    path: "/v1/chat/completions",
    status: 200,
    duration: 10,
    model: "claude-x",
    isStream: false,
    requestBody,
    responseBody: null,
    upstreamRequestBody,
    error: null,
  }
}

/** A turn carrying an upstream (Anthropic-shape) message list. */
function turnWith(traceId: string, messages: Msg[]): RequestRecord {
  return makeRecord(traceId, { upstreamMessages: messages })
}

// ---------------------------------------------------------------------------
// resolveTranscriptMessages(record) — the SAME messages[] the transcript view
// renders. Upstream (Anthropic) wins; else client (OpenAI) with system rows
// filtered; malformed/empty degrades to [] without throwing.
// ---------------------------------------------------------------------------

describe("resolveTranscriptMessages", () => {
  // Task 2.1 — spec: Dedup MUST compare the same resolved arrays TranscriptView renders.
  test("returns the upstream messages when the record has a valid upstream body", () => {
    const rec = makeRecord("t1", {
      upstreamMessages: [m("user", "hello"), m("assistant", "hi there")],
      // A client body is also present to prove upstream takes precedence.
      clientMessages: [m("user", "SHOULD NOT BE USED")],
    })
    expect(resolveTranscriptMessages(rec)).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ])
  })

  // Task 2.2 — design: upstream.messages ?? clientReq?.messages?.filter(role !== "system")
  test("falls back to client messages with system entries filtered out", () => {
    const rec = makeRecord("t1", {
      clientMessages: [
        m("system", "you are a bot"),
        m("user", "hello"),
        m("assistant", "hi"),
      ],
    })
    expect(resolveTranscriptMessages(rec)).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ])
  })

  // Task 2.3 — spec: zero-turn/loading must not throw.
  test("returns [] without throwing for a record with no parseable body", () => {
    const rec = makeRecord("t1") // neither upstream nor client body
    expect(resolveTranscriptMessages(rec)).toEqual([])
    // Malformed JSON must also degrade to [] rather than throw.
    const malformed: RequestRecord = {
      ...rec,
      upstreamRequestBody: "{not valid json",
      requestBody: "also broken",
    }
    expect(resolveTranscriptMessages(malformed)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// computeMessageDedup(turns) — pure render-dedup diff, keyed by traceId. Turn 0
// is always full; a prefix shrink or any mismatch inside the predecessor's
// length falls back to full; otherwise the shared prefix is deduped.
// ---------------------------------------------------------------------------

describe("computeMessageDedup", () => {
  // Task 2.4 — spec: Repeated prefix renders as marker; each unique message shown once.
  test("dedups byte-exact prefixes across consecutive turns", () => {
    const turn0 = [m("user", "q1"), m("assistant", "a1")] // 2 msgs
    const turn1 = [...turn0, m("user", "q2"), m("assistant", "a2")] // 4 msgs
    const turn2 = [...turn1, m("user", "q3"), m("assistant", "a3")] // 6 msgs
    const map = computeMessageDedup([
      turnWith("t0", turn0),
      turnWith("t1", turn1),
      turnWith("t2", turn2),
    ])
    expect(map.get("t0")).toEqual({ kind: "full" })
    expect(map.get("t1")).toEqual({
      kind: "deduped",
      sharedCount: 2,
      originTurnIndex: 0,
      originTraceId: "t0",
    })
    expect(map.get("t2")).toEqual({
      kind: "deduped",
      sharedCount: 4,
      originTurnIndex: 1,
      originTraceId: "t1",
    })
  })

  // Task 2.5 — spec: Divergent prefix renders full.
  test("a turn diverging from its predecessor past index 0 renders full", () => {
    const turn0 = [m("user", "q1"), m("assistant", "a1")]
    // Same msg 0, DIFFERENT msg 1 (divergence at p=1 > 0), plus a new suffix msg.
    const turn1 = [m("user", "q1"), m("assistant", "DIFFERENT"), m("user", "q2")]
    const map = computeMessageDedup([turnWith("t0", turn0), turnWith("t1", turn1)])
    expect(map.get("t1")).toEqual({ kind: "full" })
  })

  // Task 2.6 — spec: Divergence at index 0 renders entire turn full.
  test("a turn whose first message differs renders entirely full, no partial dedup", () => {
    const turn0 = [m("user", "q1")]
    const turn1 = [m("user", "q1"), m("assistant", "a1")] // clean prefix of turn0
    const turn2 = [m("user", "DIFFERENT"), m("assistant", "a1"), m("user", "q2")]
    const map = computeMessageDedup([
      turnWith("t0", turn0),
      turnWith("t1", turn1),
      turnWith("t2", turn2),
    ])
    // t1 is a clean continuation, but t2 diverges at index 0 → fully full.
    expect(map.get("t1")).toEqual({
      kind: "deduped",
      sharedCount: 1,
      originTurnIndex: 0,
      originTraceId: "t0",
    })
    expect(map.get("t2")).toEqual({ kind: "full" })
  })

  // Task 2.7 — design safety: len(i) < len(i-1) → full.
  test("a turn with fewer messages than its predecessor renders full (shrink guard)", () => {
    const turn0 = [m("user", "q1"), m("assistant", "a1"), m("user", "q2")] // 3
    const turn1 = [m("user", "q1"), m("assistant", "a1")] // 2 — shrunk
    const map = computeMessageDedup([turnWith("t0", turn0), turnWith("t1", turn1)])
    expect(map.get("t1")).toEqual({ kind: "full" })
  })

  // Empty-predecessor guard: a predecessor resolving to zero messages (a real,
  // reachable input per `resolveTranscriptMessages`'s tested empty-array
  // return path) has nothing to dedup against — the mismatch loop runs zero
  // iterations for it, so without an explicit guard the turn would wrongly
  // fall through to `{kind:"deduped", sharedCount: 0}` instead of `full`.
  test("a turn whose predecessor has zero messages renders full, not a vacuous deduped marker", () => {
    const turn0: Msg[] = [] // resolves to zero messages
    const turn1 = [m("user", "q1"), m("assistant", "a1")]
    const map = computeMessageDedup([turnWith("t0", turn0), turnWith("t1", turn1)])
    expect(map.get("t1")).toEqual({ kind: "full" })
  })

  // Task 2.8 — design safety: turn 0 is always full (even in a multi-turn session).
  test("turn 0 is always full regardless of what follows", () => {
    const map = computeMessageDedup([
      turnWith("t0", [m("user", "q1")]),
      turnWith("t1", [m("user", "q1"), m("assistant", "a1")]),
    ])
    expect(map.get("t0")).toEqual({ kind: "full" })
  })

  // Task 2.9 — spec: Single-turn session.
  test("a single-turn session yields exactly one full entry", () => {
    const map = computeMessageDedup([
      turnWith("only", [m("user", "q1"), m("assistant", "a1")]),
    ])
    expect(map.size).toBe(1)
    expect(map.get("only")).toEqual({ kind: "full" })
  })

  // Task 2.10 — spec: Zero-turn or loading session.
  test("an empty turns array yields an empty map without error", () => {
    const map = computeMessageDedup([])
    expect(map.size).toBe(0)
    expect(map).toEqual(new Map())
  })

  // Task 2.11 — no-mutation guard (mirrors the collapse test).
  test("does not mutate the input turns array or its elements", () => {
    const turns = [
      turnWith("t0", [m("user", "q1")]),
      turnWith("t1", [m("user", "q1"), m("assistant", "a1")]),
    ]
    const snapshot = structuredClone(turns)
    computeMessageDedup(turns)
    expect(turns).toEqual(snapshot)
    expect(turns.length).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// turnStaleTime(index, total) — pure caching seam: the last turn is live (0),
// every prior turn is immutable (Infinity).
// ---------------------------------------------------------------------------

describe("turnStaleTime", () => {
  // Task 2.12 — spec: Live Last-Turn Updates.
  test("the last turn returns 0 (kept live)", () => {
    expect(turnStaleTime(2, 3)).toBe(0)
  })

  // Task 2.13 — spec: Immutable-Turn Fetch Caching.
  test("prior turns return Infinity (immutable, cached forever)", () => {
    expect(turnStaleTime(0, 3)).toBe(Infinity)
    expect(turnStaleTime(1, 3)).toBe(Infinity)
  })

  // Task 2.14 — spec: Single-turn session (the only turn is also the last).
  test("the sole turn of a single-turn session returns 0", () => {
    expect(turnStaleTime(0, 1)).toBe(0)
  })

  // Task 2.15 — guard: negative/degenerate index defaults to immutable.
  test("a negative index with zero total returns Infinity", () => {
    expect(turnStaleTime(-1, 0)).toBe(Infinity)
  })
})
