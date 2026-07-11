/**
 * Pure decision/state logic behind `RotateKeyDialog` in `keys.tsx` (REQ-8,
 * sc12/sc13). Kept free of React and the DOM so it is trivially unit-testable
 * — mirrors `keys-metrics.ts`'s "pure derivation" convention.
 */

import type { ApiKeyMeta } from "./api"
import { isStoredKeyPrefix } from "./auth"

/**
 * True when `target` is the key currently authenticating this dashboard
 * session — rotating it would immediately log the dashboard out. Mirrors
 * `RevokeKeyDialog`'s inline `selfLockout` guard (`target != null &&
 * isStoredKeyPrefix(target.prefix)`), extracted here so both dialogs share
 * one tested implementation.
 */
export function isSelfLockoutTarget(target: ApiKeyMeta | null): boolean {
  return target != null && isStoredKeyPrefix(target.prefix)
}

/** One-time-reveal state for the freshly rotated plaintext key. */
export type RotateRevealState =
  | { revealed: false }
  | { revealed: true; full: string }

/** Initial / post-dismiss state: nothing revealed, `full` inaccessible. */
export const ROTATE_REVEAL_INITIAL: RotateRevealState = { revealed: false }

/**
 * Transition after a successful rotate — the fresh plaintext becomes visible
 * exactly once (mirrors `CreateKeyDialog`'s `created` reveal step).
 */
export function revealRotatedKey(full: string): RotateRevealState {
  return { revealed: true, full }
}

/**
 * Transition on dialog dismiss — the plaintext is discarded and never
 * retrievable again (matches the create dialog's one-time-secret contract).
 */
export function dismissRotateReveal(): RotateRevealState {
  return ROTATE_REVEAL_INITIAL
}
