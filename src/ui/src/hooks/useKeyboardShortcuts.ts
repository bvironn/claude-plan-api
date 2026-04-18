import { createContext, useContext, useEffect } from "react"

/**
 * Global keyboard shortcut registry.
 *
 * The provider in `__root.tsx` mounts ONE top-level `keydown` listener and
 * dispatches to whichever handler is currently registered for each shortcut.
 * Route-specific handlers register and unregister inside effects — this keeps
 * the shortcut contract explicit (every route opts in) and avoids duplicate
 * listeners stacking up on every navigation.
 *
 * Shortcuts handled globally:
 *   /      → focus the active route's search input (registered via `registerSearchFocus`)
 *   j / k  → move list selection down/up (registered via `registerListNav`)
 *   Enter  → open the current list item (when list nav is registered)
 *   Esc    → blur the active element + clear selection (registered via `registerEscape`)
 *
 * The handlers are refs-shaped (functions), but to keep this file dependency-free we
 * store them in plain fields on the context value and rely on the provider's
 * internal mutable map.
 */
export type ShortcutHandlers = {
  /** Focus the primary search input on the current route. */
  onSlash?: () => void
  /** Move list selection down. */
  onJ?: () => void
  /** Move list selection up. */
  onK?: () => void
  /** Open currently-selected item. */
  onEnter?: () => void
  /** Escape: clear selection, close overlays, blur active input. */
  onEscape?: () => void
}

export type ShortcutContext = {
  /** Register route-specific handlers. Returns an unregister callback. */
  register: (handlers: ShortcutHandlers) => () => void
}

// The default context is a no-op: if some component tries to register
// without being wrapped in the provider, we fail loud but non-fatally by
// returning an unregister that does nothing.
export const KeyboardShortcutContext = createContext<ShortcutContext>({
  register: () => () => {},
})

export function useKeyboardShortcuts() {
  return useContext(KeyboardShortcutContext)
}

/**
 * Convenience hook for routes that want to wire handlers once. Re-registers
 * whenever any handler identity changes (the caller is expected to memo
 * them with `useCallback` when they depend on state).
 */
export function useRegisterShortcuts(handlers: ShortcutHandlers) {
  const { register } = useKeyboardShortcuts()
  useEffect(() => {
    return register(handlers)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    register,
    handlers.onSlash,
    handlers.onJ,
    handlers.onK,
    handlers.onEnter,
    handlers.onEscape,
  ])
}
