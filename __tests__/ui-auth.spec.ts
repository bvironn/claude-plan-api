/**
 * Pure-logic unit tests for the dashboard self-auth helpers in
 * `src/ui/src/lib/auth.ts`.
 *
 * These cover ONLY the DOM-free logic (`parseKeyPrefix`, `authHeaders`,
 * key storage wrappers, and the self-lockout prefix compare). React
 * components, the modal, and the Replay-button wiring are intentionally
 * out of automated testing (no jsdom/happy-dom/RTL infra in this repo) —
 * see the change's design.md frontend-testing decision. They are covered
 * by manual verification in a later phase.
 *
 * `bun:test` has no `localStorage` global, so this suite installs a tiny
 * in-memory Web Storage stub on `globalThis`. That keeps the suite DOM-free
 * while still exercising the storage-backed wrappers.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import {
  authHeaders,
  clearStoredKey,
  getStoredKey,
  isStoredKeyPrefix,
  parseKeyPrefix,
  setStoredKey,
} from "../src/ui/src/lib/auth"

// Minimal in-memory Web Storage implementation. Not jsdom — just a Map with
// the four methods `auth.ts` touches, assigned onto `globalThis.localStorage`.
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

beforeEach(() => {
  g.localStorage = new MemoryStorage()
})

afterEach(() => {
  delete g.localStorage
})

describe("parseKeyPrefix", () => {
  test("returns the segment before the first dot", () => {
    expect(parseKeyPrefix("cpk_live_ab12cd34.the-long-secret-tail")).toBe(
      "cpk_live_ab12cd34",
    )
  })

  test("returns the whole string when there is no dot", () => {
    expect(parseKeyPrefix("cpk_live_nodothere")).toBe("cpk_live_nodothere")
  })

  test("splits only on the FIRST dot", () => {
    expect(parseKeyPrefix("pre.mid.tail")).toBe("pre")
  })
})

describe("authHeaders + key storage", () => {
  test("returns {} when no key is stored", () => {
    expect(getStoredKey()).toBeNull()
    expect(authHeaders()).toEqual({})
  })

  test("returns a Bearer header for the stored key", () => {
    setStoredKey("cpk_live_ab12cd34.secret")
    expect(getStoredKey()).toBe("cpk_live_ab12cd34.secret")
    expect(authHeaders()).toEqual({
      Authorization: "Bearer cpk_live_ab12cd34.secret",
    })
  })

  test("clearStoredKey removes the key so no header is attached", () => {
    setStoredKey("cpk_live_ab12cd34.secret")
    clearStoredKey()
    expect(getStoredKey()).toBeNull()
    expect(authHeaders()).toEqual({})
  })
})

describe("isStoredKeyPrefix (self-lockout guard)", () => {
  test("returns false, never throwing, when no key is stored (null guard)", () => {
    expect(getStoredKey()).toBeNull()
    expect(() => isStoredKeyPrefix("cpk_live_anything")).not.toThrow()
    expect(isStoredKeyPrefix("cpk_live_anything")).toBe(false)
  })

  test("returns true when the row prefix matches the stored key's prefix", () => {
    setStoredKey("cpk_live_match01.secret")
    expect(isStoredKeyPrefix("cpk_live_match01")).toBe(true)
  })

  test("returns false when the row prefix differs from the stored key's prefix", () => {
    setStoredKey("cpk_live_match01.secret")
    expect(isStoredKeyPrefix("cpk_live_other99")).toBe(false)
  })

  test("returns false without throwing when localStorage is unavailable", () => {
    delete g.localStorage
    expect(() => isStoredKeyPrefix("cpk_live_anything")).not.toThrow()
    expect(isStoredKeyPrefix("cpk_live_anything")).toBe(false)
    expect(authHeaders()).toEqual({})
  })
})
