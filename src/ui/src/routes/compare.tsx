import { createFileRoute, Link } from "@tanstack/react-router"
import { useQueries } from "@tanstack/react-query"
import { useEffect, useRef, useState } from "react"
import {
  AlertCircleIcon,
  ArrowLeftIcon,
  GitCompareIcon,
} from "lucide-react"

import { getRequest } from "@/lib/api"
import type { RequestByTraceResponse } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Separator } from "@/components/ui/separator"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { TranscriptView } from "@/components/transcript/transcript-view"
import { StatusBadge } from "@/components/layout/status-badge"
import { CopyButton } from "@/components/layout/copy-button"
import { formatRelativeTime, truncate } from "@/lib/format"
import { RouteError } from "@/components/layout/route-error"

// ---------------------------------------------------------------------------
// Route — /compare?a=<traceId>&b=<traceId>
// ---------------------------------------------------------------------------

type CompareSearch = {
  a?: string
  b?: string
}

export const Route = createFileRoute("/compare")({
  component: ComparePage,
  errorComponent: RouteError,
  validateSearch: (search): CompareSearch => {
    const a = typeof search.a === "string" && search.a.length > 0 ? search.a : undefined
    const b = typeof search.b === "string" && search.b.length > 0 ? search.b : undefined
    return { a, b }
  },
})

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function ComparePage() {
  const { a, b } = Route.useSearch()
  const [scrollSync, setScrollSync] = useState(false)

  // Fetch both traces in parallel via useQueries.
  const queries = useQueries({
    queries: [
      {
        queryKey: ["request", a],
        queryFn: () => getRequest(a as string),
        enabled: typeof a === "string" && a.length > 0,
        staleTime: 30_000,
      },
      {
        queryKey: ["request", b],
        queryFn: () => getRequest(b as string),
        enabled: typeof b === "string" && b.length > 0,
        staleTime: 30_000,
      },
    ],
  })
  const [qa, qb] = queries as [
    (typeof queries)[number],
    (typeof queries)[number],
  ]

  return (
    <div className="container mx-auto flex min-w-0 flex-col gap-4 p-4 sm:p-6">
      <HeaderBar
        traceA={a}
        traceB={b}
        scrollSync={scrollSync}
        onScrollSyncChange={setScrollSync}
      />

      {!a || !b ? (
        <MissingIdsHint traceA={a} traceB={b} />
      ) : (
        <CompareColumns
          traceA={a}
          traceB={b}
          queryA={qa as unknown as SideQuery}
          queryB={qb as unknown as SideQuery}
          scrollSync={scrollSync}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Header strip
// ---------------------------------------------------------------------------

function HeaderBar({
  traceA,
  traceB,
  scrollSync,
  onScrollSyncChange,
}: {
  traceA?: string
  traceB?: string
  scrollSync: boolean
  onScrollSyncChange: (v: boolean) => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button asChild variant="ghost" size="sm">
        <Link to="/">
          <ArrowLeftIcon data-icon="inline-start" />
          Back to list
        </Link>
      </Button>
      <Separator orientation="vertical" className="h-5" />
      <GitCompareIcon className="text-muted-foreground size-4" />
      <h1 className="truncate text-lg font-semibold tracking-tight">Compare</h1>

      {traceA && (
        <div className="text-muted-foreground ml-2 flex items-center gap-1 font-mono text-xs">
          A: {truncate(traceA, 12)}
          <CopyButton value={traceA} label="Copy trace A" />
        </div>
      )}
      {traceB && (
        <div className="text-muted-foreground flex items-center gap-1 font-mono text-xs">
          B: {truncate(traceB, 12)}
          <CopyButton value={traceB} label="Copy trace B" />
        </div>
      )}

      <div className="ml-auto flex items-center gap-2">
        <label
          htmlFor="scroll-sync"
          className="text-muted-foreground flex cursor-pointer items-center gap-2 text-sm"
        >
          <input
            id="scroll-sync"
            type="checkbox"
            className="size-4 accent-primary"
            checked={scrollSync}
            onChange={(e) => onScrollSyncChange(e.target.checked)}
          />
          Scroll sync
        </label>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Missing ids empty state
// ---------------------------------------------------------------------------

function MissingIdsHint({ traceA, traceB }: { traceA?: string; traceB?: string }) {
  return (
    <div className="flex min-h-[50vh] items-center justify-center">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <GitCompareIcon />
          </EmptyMedia>
          <EmptyTitle>Compare needs two trace ids</EmptyTitle>
          <EmptyDescription>
            Open this page as{" "}
            <code className="bg-muted rounded px-1 py-0.5 font-mono text-xs">
              /compare?a=&lt;traceA&gt;&amp;b=&lt;traceB&gt;
            </code>
            . Currently: a={traceA ?? "—"}, b={traceB ?? "—"}.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Two-column body
// ---------------------------------------------------------------------------

type SideQuery = {
  data?: RequestByTraceResponse
  isPending: boolean
  isError: boolean
  error: unknown
}

function CompareColumns({
  traceA,
  traceB,
  queryA,
  queryB,
  scrollSync,
}: {
  traceA: string
  traceB: string
  queryA: SideQuery
  queryB: SideQuery
  scrollSync: boolean
}) {
  // Scroll-sync: when enabled, scrolling one column mirrors into the other
  // using proportional scroll (works when columns differ in height). We
  // guard against feedback loops with a `syncingRef` flag.
  const refA = useRef<HTMLDivElement | null>(null)
  const refB = useRef<HTMLDivElement | null>(null)
  const syncingRef = useRef(false)

  useEffect(() => {
    if (!scrollSync) return
    const a = refA.current
    const b = refB.current
    if (!a || !b) return

    function mirror(src: HTMLDivElement, dst: HTMLDivElement) {
      return () => {
        if (syncingRef.current) return
        const srcMax = src.scrollHeight - src.clientHeight
        const dstMax = dst.scrollHeight - dst.clientHeight
        if (srcMax <= 0 || dstMax <= 0) return
        const ratio = src.scrollTop / srcMax
        syncingRef.current = true
        dst.scrollTop = ratio * dstMax
        // Release on next frame so the dst's own scroll handler sees the flag.
        requestAnimationFrame(() => {
          syncingRef.current = false
        })
      }
    }

    const onA = mirror(a, b)
    const onB = mirror(b, a)
    a.addEventListener("scroll", onA, { passive: true })
    b.addEventListener("scroll", onB, { passive: true })
    return () => {
      a.removeEventListener("scroll", onA)
      b.removeEventListener("scroll", onB)
    }
  }, [scrollSync])

  return (
    <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2">
      <Column title="A" traceId={traceA} query={queryA} containerRef={refA} />
      <Column title="B" traceId={traceB} query={queryB} containerRef={refB} />
    </div>
  )
}

function Column({
  title,
  traceId,
  query,
  containerRef,
}: {
  title: string
  traceId: string
  query: SideQuery
  containerRef: React.MutableRefObject<HTMLDivElement | null>
}) {
  return (
    <div className="border-border bg-card flex min-w-0 flex-col gap-3 rounded-lg border p-4">
      <div className="flex items-center gap-2 text-sm">
        <span className="text-muted-foreground font-mono">{title}</span>
        {query.data?.request && (
          <>
            <StatusBadge status={query.data.request.status} />
            <span className="text-muted-foreground text-xs">
              {formatRelativeTime(query.data.request.timestamp)}
            </span>
          </>
        )}
        <Link
          to="/r/$traceId"
          params={{ traceId }}
          className="text-muted-foreground hover:text-foreground ml-auto font-mono text-xs"
        >
          open →
        </Link>
      </div>

      <div
        ref={containerRef}
        className="flex max-h-[calc(100vh-12rem)] min-w-0 flex-col gap-4 overflow-y-auto pr-1"
      >
        {query.isPending && (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-32 w-3/4" />
            <Skeleton className="h-24 w-2/3 self-end" />
          </div>
        )}

        {query.isError && (
          <Alert variant="destructive">
            <AlertCircleIcon />
            <AlertTitle>Couldn't load trace {title}</AlertTitle>
            <AlertDescription>{(query.error as Error)?.message ?? "Unknown error"}</AlertDescription>
          </Alert>
        )}

        {query.data && !query.data.request && (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <AlertCircleIcon />
              </EmptyMedia>
              <EmptyTitle>Trace not found</EmptyTitle>
              <EmptyDescription>
                No record for{" "}
                <code className="bg-muted rounded px-1 py-0.5 font-mono text-xs">
                  {traceId}
                </code>
                .
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}

        {query.data?.request && <TranscriptView record={query.data.request} />}
      </div>
    </div>
  )
}
