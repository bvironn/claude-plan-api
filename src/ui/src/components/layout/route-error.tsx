import { AlertCircleIcon, RefreshCwIcon } from "lucide-react"
import { useRouter } from "@tanstack/react-router"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"

/**
 * Per-route error boundary. Rendered by TanStack Router via `errorComponent`
 * when a route's loader or component throws synchronously. For async errors
 * inside React Query we still rely on `isError` branches inside each page —
 * this boundary is the last-resort net.
 */
export function RouteError({ error, reset }: { error: Error; reset: () => void }) {
  const router = useRouter()
  return (
    <div className="container mx-auto flex flex-col gap-4 p-4 sm:p-6">
      <Alert variant="destructive">
        <AlertCircleIcon />
        <AlertTitle>This page hit an error</AlertTitle>
        <AlertDescription>
          <p className="mb-2">The route failed to render. You can retry or head back.</p>
          <pre className="bg-muted text-foreground overflow-x-auto rounded-md p-2 text-xs">
            {error.message}
          </pre>
        </AlertDescription>
      </Alert>
      <div>
        <Button
          variant="default"
          size="sm"
          onClick={() => {
            reset()
            router.invalidate()
          }}
        >
          <RefreshCwIcon data-icon="inline-start" />
          Retry
        </Button>
      </div>
    </div>
  )
}
