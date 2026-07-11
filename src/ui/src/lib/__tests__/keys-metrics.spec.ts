import { test, expect, describe } from "bun:test"

import { deriveKeyMetrics, findApiKeyById } from "../keys-metrics"
import type { ApiKeyMeta } from "../api"
import type { RequestRecord } from "../types"

// Minimal RequestRecord factory — only the columns deriveKeyMetrics reads
// matter; the rest are filled with schema-plausible defaults so the input is a
// real RequestRecord shape, not a partial cast.
function req(overrides: Partial<RequestRecord>): RequestRecord {
  return {
    id: 1,
    traceId: "t-1",
    timestamp: "2026-01-01T00:00:00.000Z",
    method: "POST",
    path: "/v1/chat/completions",
    status: 200,
    duration: 100,
    model: "claude-sonnet-4-6",
    isStream: false,
    requestBody: null,
    responseBody: null,
    upstreamRequestBody: null,
    error: null,
    ...overrides,
  }
}

describe("deriveKeyMetrics", () => {
  test("empty input yields a zeroed, non-crashing metrics object", () => {
    const m = deriveKeyMetrics([])
    expect(m.requestCount).toBe(0)
    expect(m.tokensIn).toBe(0)
    expect(m.tokensOut).toBe(0)
    expect(m.cacheReadTokens).toBe(0)
    expect(m.cacheCreationTokens).toBe(0)
    expect(m.errorRate).toBe(0)
    expect(m.perModel).toEqual([])
    expect(m.firstActivity).toBeNull()
    expect(m.lastActivity).toBeNull()
  })

  test("sums token totals across attributed rows", () => {
    const m = deriveKeyMetrics([
      req({ inputTokens: 100, outputTokens: 40, cacheReadTokens: 10, cacheCreationTokens: 5 }),
      req({ inputTokens: 200, outputTokens: 60, cacheReadTokens: 20, cacheCreationTokens: 15 }),
    ])
    expect(m.requestCount).toBe(2)
    expect(m.tokensIn).toBe(300)
    expect(m.tokensOut).toBe(100)
    expect(m.cacheReadTokens).toBe(30)
    expect(m.cacheCreationTokens).toBe(20)
  })

  test("error rate equals failed (status >= 400) divided by total", () => {
    const m = deriveKeyMetrics([
      req({ status: 200 }),
      req({ status: 200 }),
      req({ status: 429 }),
      req({ status: 500 }),
    ])
    expect(m.requestCount).toBe(4)
    expect(m.errorRate).toBe(0.5)
  })

  test("null status is not counted as an error", () => {
    const m = deriveKeyMetrics([
      req({ status: null }),
      req({ status: 200 }),
    ])
    expect(m.errorRate).toBe(0)
  })

  test("groups per-model with counts and token sums, sorted by count desc", () => {
    const m = deriveKeyMetrics([
      req({ model: "claude-sonnet-4-6", inputTokens: 10, outputTokens: 5 }),
      req({ model: "claude-sonnet-4-6", inputTokens: 20, outputTokens: 5 }),
      req({ model: "claude-opus-4-8", inputTokens: 100, outputTokens: 50 }),
    ])
    expect(m.perModel).toHaveLength(2)
    // sonnet has 2 requests → first
    expect(m.perModel[0]).toEqual({
      model: "claude-sonnet-4-6",
      count: 2,
      tokensIn: 30,
      tokensOut: 10,
    })
    expect(m.perModel[1]).toEqual({
      model: "claude-opus-4-8",
      count: 1,
      tokensIn: 100,
      tokensOut: 50,
    })
  })

  test("rows with a null model are grouped under an explicit '(unknown)' bucket", () => {
    const m = deriveKeyMetrics([
      req({ model: null, inputTokens: 7, outputTokens: 3 }),
    ])
    expect(m.perModel).toHaveLength(1)
    expect(m.perModel[0]?.model).toBe("(unknown)")
    expect(m.perModel[0]?.count).toBe(1)
  })

  test("infers first/last activity from the min/max timestamps", () => {
    const m = deriveKeyMetrics([
      req({ timestamp: "2026-01-02T00:00:00.000Z" }),
      req({ timestamp: "2026-01-01T00:00:00.000Z" }),
      req({ timestamp: "2026-01-03T00:00:00.000Z" }),
    ])
    expect(m.firstActivity).toBe("2026-01-01T00:00:00.000Z")
    expect(m.lastActivity).toBe("2026-01-03T00:00:00.000Z")
  })

  test("treats missing token fields as zero, never NaN", () => {
    const m = deriveKeyMetrics([req({})])
    expect(m.tokensIn).toBe(0)
    expect(m.tokensOut).toBe(0)
    expect(Number.isNaN(m.tokensIn)).toBe(false)
    expect(Number.isNaN(m.errorRate)).toBe(false)
  })
})

// key({...}) — minimal ApiKeyMeta factory for the lookup resolver.
function key(overrides: Partial<ApiKeyMeta> & { id: number }): ApiKeyMeta {
  return {
    prefix: `sk-${overrides.id}`,
    label: `key-${overrides.id}`,
    created_at: "2026-01-01T00:00:00.000Z",
    revoked_at: null,
    is_admin: 0,
    ...overrides,
  }
}

describe("findApiKeyById", () => {
  const keys: ApiKeyMeta[] = [key({ id: 1 }), key({ id: 2 }), key({ id: 3 })]

  test("resolves a key by its numeric id parsed from a route string param", () => {
    const found = findApiKeyById(keys, "2")
    expect(found?.id).toBe(2)
    expect(found?.prefix).toBe("sk-2")
  })

  test("returns null for an id string that matches no key (not-found state)", () => {
    expect(findApiKeyById(keys, "999")).toBeNull()
  })

  test("returns null for a non-numeric id string, never throwing", () => {
    expect(findApiKeyById(keys, "abc")).toBeNull()
    expect(findApiKeyById(keys, "")).toBeNull()
  })

  test("returns null when the key list is empty (data not loaded yet)", () => {
    expect(findApiKeyById([], "1")).toBeNull()
  })
})
