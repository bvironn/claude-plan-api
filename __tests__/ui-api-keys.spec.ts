/**
 * Fetch-mock unit tests for the dashboard API-key client wrappers in
 * `src/ui/src/lib/api.ts` (`listApiKeys`, `createApiKey`, `revokeApiKey`,
 * `getUsageByApiKey`).
 *
 * These are DOM-free: they exercise URL construction, HTTP method, request
 * body serialization, `Authorization` propagation, response parsing, and the
 * shared 401 → `UnauthorizedError` behavior — all without a DOM. `keys.tsx`
 * (the React route, dialogs, table rendering) stays out of automated testing
 * per the change's design.md frontend-testing decision and is covered by the
 * Phase 7 manual verification.
 *
 * `bun:test` has no `localStorage` global, so an in-memory Web Storage stub is
 * installed to exercise the `authHeaders()` path (matches ui-auth.spec.ts).
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"

import {
  createApiKey,
  getUsageByApiKey,
  listApiKeys,
  renameApiKey,
  revokeApiKey,
} from "../src/ui/src/lib/api"
import { setStoredKey, UnauthorizedError } from "../src/ui/src/lib/auth"

// Minimal in-memory Web Storage — same shape as ui-auth.spec.ts.
class MemoryStorage {
  private store = new Map<string, string>()
  get length(): number {
    return this.store.size
  }
  clear(): void {
    this.store.clear()
  }
  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null
  }
  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null
  }
  removeItem(key: string): void {
    this.store.delete(key)
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value))
  }
}

const g = globalThis as { localStorage?: unknown }

let fetchSpy: ReturnType<typeof spyOn> | null = null

/** Mock `fetch` to return `body` at `status` and record the call args. */
function mockFetch(body: unknown, status = 200): void {
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () =>
    new Response(JSON.stringify(body), { status })) as unknown as typeof fetch)
}

/** The `[input, init]` of the first (only) fetch call. */
function firstCall(): [string, RequestInit | undefined] {
  const calls = (fetchSpy as unknown as { mock: { calls: unknown[][] } }).mock.calls
  return calls[0] as [string, RequestInit | undefined]
}

beforeEach(() => {
  g.localStorage = new MemoryStorage()
})

afterEach(() => {
  fetchSpy?.mockRestore()
  fetchSpy = null
  delete g.localStorage
})

describe("listApiKeys", () => {
  test("GETs /api/keys and returns the parsed metadata list", async () => {
    mockFetch({
      keys: [
        { id: 2, prefix: "cpk_live_bb", label: "prod", created_at: "2026-07-10T00:00:00Z", revoked_at: null },
        { id: 1, prefix: "cpk_live_aa", label: "old", created_at: "2026-07-09T00:00:00Z", revoked_at: "2026-07-09T12:00:00Z" },
      ],
    })

    const res = await listApiKeys()

    expect(res.keys).toHaveLength(2)
    expect(res.keys[0]?.prefix).toBe("cpk_live_bb")
    expect(res.keys[1]?.revoked_at).toBe("2026-07-09T12:00:00Z")
    expect(firstCall()[0]).toBe("/api/keys")
    // GET has no explicit method (default).
    expect(firstCall()[1]?.method).toBeUndefined()
  })

  test("attaches Authorization: Bearer when a key is stored", async () => {
    setStoredKey("cpk_live_aa.secret-tail")
    mockFetch({ keys: [] })

    await listApiKeys()

    const headers = firstCall()[1]?.headers as Record<string, string>
    expect(headers.Authorization).toBe("Bearer cpk_live_aa.secret-tail")
  })

  test("throws UnauthorizedError on a 401", async () => {
    mockFetch({ error: "no key" }, 401)
    await expect(listApiKeys()).rejects.toBeInstanceOf(UnauthorizedError)
  })
})

describe("createApiKey", () => {
  test("POSTs /api/keys with a JSON {label} body and returns the plaintext once", async () => {
    mockFetch(
      { id: 5, prefix: "cpk_live_zz", label: "ci", created_at: "2026-07-10T01:00:00Z", full: "cpk_live_zz.the-secret" },
      201,
    )

    const created = await createApiKey("ci")

    expect(created.full).toBe("cpk_live_zz.the-secret")
    expect(created.id).toBe(5)
    const [url, init] = firstCall()
    expect(url).toBe("/api/keys")
    expect(init?.method).toBe("POST")
    const headers = init?.headers as Record<string, string>
    expect(headers["Content-Type"]).toBe("application/json")
    expect(JSON.parse(init?.body as string)).toEqual({ label: "ci" })
  })
})

describe("revokeApiKey", () => {
  test("POSTs /api/keys/:id/revoke and returns the revoked flag", async () => {
    mockFetch({ revoked: true })

    const res = await revokeApiKey(42)

    expect(res.revoked).toBe(true)
    const [url, init] = firstCall()
    expect(url).toBe("/api/keys/42/revoke")
    expect(init?.method).toBe("POST")
  })

  test("surfaces an idempotent no-op (revoked:false) without throwing", async () => {
    mockFetch({ revoked: false })
    const res = await revokeApiKey(999)
    expect(res.revoked).toBe(false)
  })
})

describe("renameApiKey", () => {
  test("PATCHes /api/keys/:id with a JSON {label} body and returns the updated metadata", async () => {
    mockFetch(
      { id: 7, prefix: "cpk_live_pp", label: "renamed", created_at: "2026-07-10T00:00:00Z", revoked_at: null, is_admin: 0 },
      200,
    )

    const updated = await renameApiKey(7, "renamed")

    expect(updated.id).toBe(7)
    expect(updated.label).toBe("renamed")
    expect(updated.revoked_at).toBeNull()
    const [url, init] = firstCall()
    expect(url).toBe("/api/keys/7")
    expect(init?.method).toBe("PATCH")
    const headers = init?.headers as Record<string, string>
    expect(headers["Content-Type"]).toBe("application/json")
    expect(JSON.parse(init?.body as string)).toEqual({ label: "renamed" })
  })

  test("attaches Authorization: Bearer when a key is stored", async () => {
    setStoredKey("cpk_live_aa.secret-tail")
    mockFetch({ id: 1, prefix: "cpk_live_aa", label: "x", created_at: "2026-07-10T00:00:00Z", revoked_at: null, is_admin: 0 })

    await renameApiKey(1, "x")

    const headers = firstCall()[1]?.headers as Record<string, string>
    expect(headers.Authorization).toBe("Bearer cpk_live_aa.secret-tail")
  })

  test("throws UnauthorizedError on a 401", async () => {
    mockFetch({ error: "no key" }, 401)
    await expect(renameApiKey(1, "x")).rejects.toBeInstanceOf(UnauthorizedError)
  })

  test("throws a descriptive error on a 409 (revoked key)", async () => {
    mockFetch({ error: { message: "Cannot rename a revoked key" } }, 409)
    await expect(renameApiKey(4, "new")).rejects.toThrow(/409/)
  })
})

describe("getUsageByApiKey", () => {
  test("GETs /api/telemetry/usage and returns per-key usage rows", async () => {
    mockFetch({
      generated_at: "2026-07-10T02:00:00Z",
      time_from: null,
      time_to: null,
      keys: [
        { api_key_id: 5, prefix: "cpk_live_zz", label: "ci", requests: 3, tokens_in: 100, tokens_out: 200, cache_read_tokens: 0, cache_creation_tokens: 0 },
      ],
    })

    const res = await getUsageByApiKey()

    expect(firstCall()[0]).toBe("/api/telemetry/usage")
    expect(res.keys[0]?.api_key_id).toBe(5)
    expect(res.keys[0]?.requests).toBe(3)
    expect(res.keys[0]?.tokens_out).toBe(200)
  })
})
