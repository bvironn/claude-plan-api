import { test, expect, describe } from "bun:test"

import { sortConversations } from "../src/ui/src/lib/sessions"
import type { Conversation } from "../src/ui/src/lib/sessions"

// Minimal Conversation factory — only the fields sortConversations reads
// (totalInputTokens/totalOutputTokens/lastActivityAt) vary per test.
function conv(overrides: Partial<Conversation> & { id: string }): Conversation {
  return {
    preview: "hello",
    turns: 1,
    models: [],
    startedAt: "2026-01-01T00:00:00.000Z",
    lastActivityAt: "2026-01-01T00:00:00.000Z",
    totalOutputTokens: 0,
    totalInputTokens: 0,
    latestTraceId: `t-${overrides.id}`,
    traceIds: [`t-${overrides.id}`],
    hasError: false,
    ...overrides,
  }
}

describe("sortConversations", () => {
  test("\"tokens\" sorts by input+output tokens combined, descending", () => {
    const input = [
      conv({ id: "a", totalInputTokens: 10, totalOutputTokens: 5 }), // 15
      conv({ id: "b", totalInputTokens: 100, totalOutputTokens: 50 }), // 150
      conv({ id: "c", totalInputTokens: 20, totalOutputTokens: 20 }), // 40
    ]
    const sorted = sortConversations(input, "tokens")
    expect(sorted.map((c) => c.id)).toEqual(["b", "c", "a"])
  })

  test("\"recent\" sorts by lastActivityAt descending regardless of input order", () => {
    const input = [
      conv({ id: "oldest", lastActivityAt: "2026-01-01T00:00:00.000Z" }),
      conv({ id: "newest", lastActivityAt: "2026-01-03T00:00:00.000Z" }),
      conv({ id: "middle", lastActivityAt: "2026-01-02T00:00:00.000Z" }),
    ]
    const sorted = sortConversations(input, "recent")
    expect(sorted.map((c) => c.id)).toEqual(["newest", "middle", "oldest"])
  })

  test("does not mutate the input array", () => {
    const input = [
      conv({ id: "a", totalInputTokens: 1, totalOutputTokens: 1 }),
      conv({ id: "b", totalInputTokens: 100, totalOutputTokens: 100 }),
    ]
    const snapshot = [...input]
    sortConversations(input, "tokens")
    expect(input).toEqual(snapshot)
  })

  test("empty input yields an empty array for both sort modes", () => {
    expect(sortConversations([], "tokens")).toEqual([])
    expect(sortConversations([], "recent")).toEqual([])
  })
})
