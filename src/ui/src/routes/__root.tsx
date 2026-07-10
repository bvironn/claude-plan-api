import {
  createRootRoute,
  Link,
  Outlet,
  useRouter,
} from "@tanstack/react-router"
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from "react"
import { useQueryClient } from "@tanstack/react-query"
import { AlertCircleIcon, ArrowLeftIcon } from "lucide-react"

import { AppHeader } from "@/components/layout/app-header"
import {
  KeyboardShortcutContext,
  type ShortcutContext,
  type ShortcutHandlers,
} from "@/hooks/useKeyboardShortcuts"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { authStore, setStoredKey } from "@/lib/auth"

export const Route = createRootRoute({
  component: RootComponent,
  errorComponent: RootErrorComponent,
  notFoundComponent: RootNotFoundComponent,
})

function RootComponent() {
  // Route-specific handlers live in a mutable ref, so re-registering doesn't
  // require re-creating the listener. Each call to `register` replaces the
  // current handler set; returning an unregister cleans up — but only if
  // the unregister is still the active one (prevents stale effect cleanups
  // from nuking a handler registered by the NEXT route).
  const handlersRef = useRef<ShortcutHandlers>({})
  const activeIdRef = useRef(0)

  const register = useCallback((handlers: ShortcutHandlers) => {
    activeIdRef.current += 1
    const myId = activeIdRef.current
    handlersRef.current = handlers
    return () => {
      if (activeIdRef.current === myId) {
        handlersRef.current = {}
      }
    }
  }, [])

  const contextValue: ShortcutContext = useMemo(() => ({ register }), [register])

  // Single global keydown listener, dispatches to whichever handlers the
  // current route has registered.
  useEffect(() => {
    function isEditableTarget(el: EventTarget | null): boolean {
      if (!el || !(el instanceof HTMLElement)) return false
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") return true
      if (el.isContentEditable) return true
      return false
    }

    function onKeyDown(e: KeyboardEvent) {
      // Never swallow keystrokes with modifiers — those belong to the
      // browser or OS (ctrl+f, cmd+k, etc.).
      if (e.metaKey || e.ctrlKey || e.altKey) return

      const h = handlersRef.current

      // Escape is the one shortcut we always want to honor even inside
      // editable targets (so `Esc` blurs a focused input).
      if (e.key === "Escape") {
        if (isEditableTarget(e.target)) {
          ;(e.target as HTMLElement).blur()
        }
        h.onEscape?.()
        return
      }

      // All other shortcuts ignore editable targets so typing in inputs
      // doesn't hijack `j`/`k`/`/`.
      if (isEditableTarget(e.target)) return

      if (e.key === "/") {
        if (h.onSlash) {
          e.preventDefault()
          h.onSlash()
        }
        return
      }
      if (e.key === "j") {
        if (h.onJ) {
          e.preventDefault()
          h.onJ()
        }
        return
      }
      if (e.key === "k") {
        if (h.onK) {
          e.preventDefault()
          h.onK()
        }
        return
      }
      if (e.key === "Enter") {
        if (h.onEnter) {
          h.onEnter()
        }
        return
      }
    }

    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])

  return (
    <KeyboardShortcutContext.Provider value={contextValue}>
      <div className="bg-background text-foreground flex min-h-screen flex-col">
        <AppHeader />
        <AuthGate />
        <main className="flex-1">
          <Outlet />
        </main>
      </div>
    </KeyboardShortcutContext.Provider>
  )
}

// ---------------------------------------------------------------------------
// Auth gate — key-entry modal driven by the global auth store
// ---------------------------------------------------------------------------

/**
 * Renders a key-entry Dialog whenever the auth store is active. The store is
 * flipped on by a 401 (via `QueryCache.onError` in `main.tsx`) or by the
 * raw-fetch Replay path calling `authStore.requireKey()`. On submit the key
 * is persisted and ALL queries are invalidated so they refetch with the
 * Bearer attached — satisfying the "401 → prompt → retry" recovery flow.
 */
function AuthGate() {
  const active = useSyncExternalStore(
    authStore.subscribe,
    authStore.getSnapshot,
  )
  const queryClient = useQueryClient()
  const [value, setValue] = useState("")

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const trimmed = value.trim()
    if (!trimmed) return
    setStoredKey(trimmed)
    setValue("")
    authStore.dismiss()
    // Refetch every query now that a Bearer is available.
    void queryClient.invalidateQueries()
  }

  return (
    <Dialog
      open={active}
      onOpenChange={(open) => {
        if (!open) authStore.dismiss()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertCircleIcon className="text-amber-500" />
            API key required
          </DialogTitle>
          <DialogDescription>
            This dashboard requires an API key. Paste a valid key to continue —
            it is stored in your browser and sent as a Bearer token on gated
            requests.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div className="flex flex-col gap-2">
            <Label htmlFor="auth-gate-key">API key</Label>
            <Input
              id="auth-gate-key"
              type="password"
              autoFocus
              autoComplete="off"
              placeholder="cpk_live_…"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={!value.trim()}>
              Save key
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Error + 404 boundaries
// ---------------------------------------------------------------------------

function RootErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  const router = useRouter()
  return (
    <div className="bg-background text-foreground flex min-h-screen flex-col">
      <AppHeader />
      <main className="flex-1">
        <div className="container mx-auto flex flex-col gap-4 p-4 sm:p-6">
          <Alert variant="destructive">
            <AlertCircleIcon />
            <AlertTitle>Something went wrong</AlertTitle>
            <AlertDescription>
              <p className="mb-2">
                The dashboard hit an unexpected error while rendering this route.
                The error was caught so the rest of the app stays usable — reload
                the route below, or go back to the list.
              </p>
              <pre className="bg-muted text-foreground overflow-x-auto rounded-md p-2 text-xs">
                {error.message}
              </pre>
            </AlertDescription>
          </Alert>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="default"
              size="sm"
              onClick={() => {
                reset()
                router.invalidate()
              }}
            >
              Retry
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link to="/">
                <ArrowLeftIcon data-icon="inline-start" />
                Back to requests
              </Link>
            </Button>
          </div>
        </div>
      </main>
    </div>
  )
}

function RootNotFoundComponent() {
  return (
    <div className="bg-background text-foreground flex min-h-screen flex-col">
      <AppHeader />
      <main className="flex-1">
        <div className="container mx-auto flex flex-col gap-4 p-4 sm:p-6">
          <Alert>
            <AlertCircleIcon />
            <AlertTitle>Page not found</AlertTitle>
            <AlertDescription>
              That route doesn't exist in the dashboard. Head back to the request
              list to start exploring.
            </AlertDescription>
          </Alert>
          <div>
            <Button asChild variant="default" size="sm">
              <Link to="/">
                <ArrowLeftIcon data-icon="inline-start" />
                Back to requests
              </Link>
            </Button>
          </div>
        </div>
      </main>
    </div>
  )
}
