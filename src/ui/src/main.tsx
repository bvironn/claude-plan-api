import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import {
  QueryCache,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query"
import { RouterProvider, createRouter } from "@tanstack/react-router"

import "./index.css"
import { ThemeProvider } from "@/components/theme-provider"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Toaster } from "@/components/ui/sonner"
import { authStore, UnauthorizedError } from "@/lib/auth"
import { routeTree } from "./routeTree.gen"

// -----------------------------------------------------------------------
// Router
// -----------------------------------------------------------------------
const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  // Non-zero so an `intent` preload (hover/focus) within this window reuses
  // the query cache instead of firing a redundant fetch right before the
  // real navigation. Matches the QueryClient staleTime below.
  defaultPreloadStaleTime: 20_000,
  scrollRestoration: true,
})

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router
  }
}

// -----------------------------------------------------------------------
// Query client
// -----------------------------------------------------------------------
const queryClient = new QueryClient({
  // Any query that 401s throws UnauthorizedError (from getJson). Route it to
  // the auth store so <AuthGate> prompts for a key. QueryCache.onError is the
  // only place React Query surfaces async query errors globally.
  queryCache: new QueryCache({
    onError: (error) => {
      if (error instanceof UnauthorizedError) {
        authStore.requireKey()
      }
    },
  }),
  defaultOptions: {
    queries: {
      // Audit UI consumes live-ish data; keep it fresh but don't hammer.
      // Bounded to 20s: long enough that switching tabs or re-focusing the
      // window doesn't force a redundant refetch of data that's still
      // effectively current, short enough that stale reads don't linger.
      staleTime: 20_000,
      gcTime: 5 * 60_000,
      // Keep a single retry for transient errors, but NEVER retry an auth
      // failure — the key-entry prompt should appear immediately, not after a
      // backoff. (failureCount starts at 0, so `count < 1` == the old retry:1.)
      retry: (count, error) =>
        !(error instanceof UnauthorizedError) && count < 1,
      // Kept true: refocus-refetch only fires when data is actually stale
      // (past the 20s staleTime above), so it no longer causes the
      // redundant-on-every-focus churn a short/zero staleTime produced.
      // Routes that need tighter freshness (e.g. the live request list) opt
      // in explicitly via their own `refetchInterval`.
      refetchOnWindowFocus: true,
    },
  },
})

// -----------------------------------------------------------------------
// Render
// -----------------------------------------------------------------------
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <RouterProvider router={router} />
          <Toaster richColors closeButton position="bottom-right" />
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
)
