import { useEffect } from "react"

import { RouteError } from "@/components/layout/route-error"
import { isChunkLoadError } from "@/lib/chunk-load-error"

/**
 * Error boundary for the `/metrics` route specifically. Wraps the shared
 * `RouteError` with ONE extra case: a chunk-load failure on the lazy-loaded
 * `metrics-charts` import (see routes/metrics.tsx) can never be recovered by
 * the shared soft retry (`reset()` + `router.invalidate()`) — React 19's
 * `lazy()` caches the rejected import forever, so every re-render throws the
 * SAME cached rejection. A full page reload re-evaluates the module graph
 * fresh and picks up the new chunk hash.
 *
 * All OTHER errors on this route still go through the unchanged
 * `RouteError` soft-retry path — this component only intercepts the one
 * failure mode that soft retry structurally cannot fix. See RESIL-003.
 */
export function MetricsRouteError({ error, reset }: { error: Error; reset: () => void }) {
  const chunkLoadFailure = isChunkLoadError(error)

  useEffect(() => {
    if (chunkLoadFailure) {
      window.location.reload()
    }
  }, [chunkLoadFailure])

  if (chunkLoadFailure) {
    // Reload is already in flight (see effect above) — nothing meaningful to
    // render while the page tears down and re-fetches the module graph.
    return null
  }

  return <RouteError error={error} reset={reset} />
}
