/**
 * Pure-logic unit tests for `src/ui/src/lib/rotate-key.ts` — the extractable
 * state/decision logic behind `RotateKeyDialog` in `keys.tsx` (sc12, sc13).
 *
 * DOM-free by convention (matches `ui-api-keys.spec.ts` / `keys-metrics.spec.ts`):
 * `keys.tsx` itself (the React route, dialogs, table rendering) stays out of
 * automated DOM testing per design.md's frontend-testing decision. Instead we
 * test the exact pure functions the component wires into its `useState`
 * transitions, so this test file exercises REAL production logic, not a
 * decorative reimplementation.
 */

import { describe, expect, test } from "bun:test"

import {
  dismissRotateReveal,
  isSelfLockoutTarget,
  revealRotatedKey,
  ROTATE_REVEAL_INITIAL,
} from "../src/ui/src/lib/rotate-key"
import type { ApiKeyMeta } from "../src/ui/src/lib/api"
import { setStoredKey } from "../src/ui/src/lib/auth"

// bun:test has no localStorage global — install a minimal in-memory stub
// (same shape as ui-auth.spec.ts / ui-api-keys.spec.ts) so isStoredKeyPrefix
// (reused inside isSelfLockoutTarget) can read/write it.
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

function withKey(prefix: string, label = "target"): ApiKeyMeta {
  return {
    id: 1,
    prefix,
    label,
    created_at: "2026-01-01T00:00:00Z",
    revoked_at: null,
    is_admin: 0,
    last_used_at: null,
  }
}

// ---------------------------------------------------------------------------
// isSelfLockoutTarget — sc12 (self-lockout warning when target matches stored key)
// ---------------------------------------------------------------------------

describe("isSelfLockoutTarget (sc12: self-lockout warning)", () => {
  test("returns false when there is no target (dialog closed)", () => {
    g.localStorage = new MemoryStorage()
    expect(isSelfLockoutTarget(null)).toBe(false)
    delete g.localStorage
  })

  test("returns false when the target's prefix does NOT match the stored key", () => {
    g.localStorage = new MemoryStorage()
    setStoredKey("cpk_live_aaaaaaaa.secret-tail")
    expect(isSelfLockoutTarget(withKey("cpk_live_bbbbbbbb"))).toBe(false)
    delete g.localStorage
  })

  test("returns true when the target's prefix MATCHES the currently-stored key (real self-lockout)", () => {
    g.localStorage = new MemoryStorage()
    setStoredKey("cpk_live_ccccccc0.secret-tail")
    expect(isSelfLockoutTarget(withKey("cpk_live_ccccccc0"))).toBe(true)
    delete g.localStorage
  })

  test("returns false (never throws) when no key is stored at all", () => {
    g.localStorage = new MemoryStorage()
    expect(() => isSelfLockoutTarget(withKey("cpk_live_anything"))).not.toThrow()
    expect(isSelfLockoutTarget(withKey("cpk_live_anything"))).toBe(false)
    delete g.localStorage
  })
})

// ---------------------------------------------------------------------------
// Reveal-once state machine — sc13 (full shown once, gone after dismiss)
// ---------------------------------------------------------------------------

describe("rotate reveal-once state (sc13: full shown once, then gone)", () => {
  test("the initial state carries no plaintext (nothing revealed before a rotate)", () => {
    expect(ROTATE_REVEAL_INITIAL).toEqual({ revealed: false })
  });

  test("revealRotatedKey(full) transitions to a revealed state carrying EXACTLY that plaintext", () => {
    const state = revealRotatedKey("cpk_live_dddddddd.new-secret")
    expect(state).toEqual({ revealed: true, full: "cpk_live_dddddddd.new-secret" })
  })

  test("two different rotations produce two different revealed states (not a hardcoded Fake It)", () => {
    const first = revealRotatedKey("cpk_live_first00.secret-one")
    const second = revealRotatedKey("cpk_live_second0.secret-two")
    expect(first).toEqual({ revealed: true, full: "cpk_live_first00.secret-one" })
    expect(second).toEqual({ revealed: true, full: "cpk_live_second0.secret-two" })
    expect(first).not.toEqual(second)
  })

  test("dismissRotateReveal() discards the plaintext — the resulting state carries NO `full` field", () => {
    const revealed = revealRotatedKey("cpk_live_eeeeeeee.secret-tail")
    const dismissed = dismissRotateReveal()

    expect(dismissed).toEqual({ revealed: false })
    expect("full" in dismissed).toBe(false)
    // The plaintext is provably gone from the post-dismiss state, not merely
    // hidden — matches the create dialog's "can't retrieve it again" contract.
    expect(revealed.revealed && revealed.full).toBe("cpk_live_eeeeeeee.secret-tail") // sanity: prior state DID have it
  })

  test("dismissRotateReveal() is idempotent and always returns the same initial shape", () => {
    expect(dismissRotateReveal()).toEqual(ROTATE_REVEAL_INITIAL)
    expect(dismissRotateReveal()).toEqual(dismissRotateReveal())
  })
})
