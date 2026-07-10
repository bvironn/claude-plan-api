/**
 * Dashboard self-authentication helpers.
 *
 * When the gateway runs with `REQUIRE_API_KEY=true`, every gated fetch
 * (`/api/*`, `/v1/*`) must carry `Authorization: Bearer <key>`. The operator
 * pastes a key into the dashboard; it persists in `localStorage` and this
 * module attaches it to outgoing requests.
 *
 * This file is deliberately framework-agnostic (no React import) so the pure
 * logic can be unit-tested under `bun:test` without a DOM. The React binding
 * (`useSyncExternalStore`) lives in the `<AuthGate>` component that consumes
 * `authStore`.
 */

const STORAGE_KEY = "cpk_dashboard_key"

// ---------------------------------------------------------------------------
// Storage access
// ---------------------------------------------------------------------------

/** The subset of the Web Storage API this module uses. */
type WebStorageLike = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/**
 * Safe accessor for `localStorage`. Returns `null` when Web Storage is
 * unavailable (server-side render, `bun:test`, privacy modes) so callers
 * never hit a `ReferenceError` on a bare `localStorage` identifier.
 */
function storage(): WebStorageLike | null {
  try {
    const ls = (globalThis as { localStorage?: WebStorageLike }).localStorage
    return ls ?? null
  } catch {
    return null
  }
}

/** Read the stored API key, or `null` when none is set / storage is absent. */
export function getStoredKey(): string | null {
  return storage()?.getItem(STORAGE_KEY) ?? null
}

/** Persist an API key for subsequent gated fetches. */
export function setStoredKey(key: string): void {
  storage()?.setItem(STORAGE_KEY, key)
}

/** Remove any stored API key so no `Authorization` header is attached. */
export function clearStoredKey(): void {
  storage()?.removeItem(STORAGE_KEY)
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Extract the public prefix from a full key. A full key is
 * `"<prefix>.<secret>"`; this returns the `<prefix>` segment (everything
 * before the first `.`). No dot → the whole string is the prefix.
 *
 * Non-null signature by contract: the CALLER is responsible for guarding a
 * possibly-`null` stored key before calling this (see `isStoredKeyPrefix`).
 */
export function parseKeyPrefix(full: string): string {
  return full.split(".")[0] ?? full
}

/**
 * Headers to merge into every gated fetch. `{ Authorization: "Bearer <key>" }`
 * when a key is stored, otherwise an empty object (nothing attached).
 *
 * Used by BOTH `getJson()` in `api.ts` and the Replay button's raw `fetch`.
 */
export function authHeaders(): Record<string, string> {
  const key = getStoredKey()
  return key ? { Authorization: `Bearer ${key}` } : {}
}

/**
 * True when `prefix` matches the prefix of the currently-stored key.
 *
 * Null-guarded: when no key is stored there is nothing to lock out, so this
 * returns `false` and NEVER calls `parseKeyPrefix(null)`. `prefix` is indexed
 * but not unique, so this powers a self-lockout *warning* only — a rare false
 * positive fails in the safe direction (warns when it need not).
 */
export function isStoredKeyPrefix(prefix: string): boolean {
  const stored = getStoredKey()
  if (stored == null) return false
  return prefix === parseKeyPrefix(stored)
}

// ---------------------------------------------------------------------------
// Typed 401 error
// ---------------------------------------------------------------------------

/**
 * Thrown by `getJson()` on a 401 so callers and the global `QueryCache`
 * `onError` can distinguish an auth failure from a generic network error.
 */
export class UnauthorizedError extends Error {
  constructor(message = "Unauthorized: API key required") {
    super(message)
    this.name = "UnauthorizedError"
  }
}

// ---------------------------------------------------------------------------
// Auth store (framework-agnostic external store)
// ---------------------------------------------------------------------------

/**
 * Minimal external store consumed via `useSyncExternalStore` in `<AuthGate>`.
 * `active` flips true when a gated request needs a key (401 or an explicit
 * `requireKey()` from the raw-fetch Replay path); the modal reads it and
 * prompts the operator. `dismiss()` closes the modal after a key is supplied.
 */
type Listener = () => void

let active = false
const listeners = new Set<Listener>()

function emit(): void {
  for (const listener of listeners) listener()
}

export const authStore = {
  subscribe(listener: Listener): () => void {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  /** Snapshot for `useSyncExternalStore`: is the key-entry prompt active? */
  getSnapshot(): boolean {
    return active
  },
  /** Signal that a key is required — opens the key-entry modal. */
  requireKey(): void {
    if (active) return
    active = true
    emit()
  },
  /** Close the key-entry modal (e.g. after a key was supplied). */
  dismiss(): void {
    if (!active) return
    active = false
    emit()
  },
}
