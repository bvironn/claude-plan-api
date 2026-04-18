import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { useCallback, useMemo, useState } from "react"
import { ListIcon, ZapIcon } from "lucide-react"

import { listRequests } from "@/lib/api"
import type { RequestRecord } from "@/lib/types"
import {
  formatDuration,
  formatTokens,
  formatRelativeTime,
  truncate,
} from "@/lib/format"
import { useRegisterShortcuts } from "@/hooks/useKeyboardShortcuts"

import {
  RequestsFilters,
  type RequestsFilterState,
} from "@/components/layout/requests-filters"
import { ModelBadge, StatusBadge } from "@/components/layout/status-badge"
import { CopyButton } from "@/components/layout/copy-button"
import { RouteError } from "@/components/layout/route-error"

import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Skeleton } from "@/components/ui/skeleton"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

// Typed search params from URL — TanStack Router parses and validates.
type IndexSearch = {
  q?: string
  status?: "2xx" | "4xx" | "5xx"
  model?: string
}

export const Route = createFileRoute("/")({
  component: IndexPage,
  errorComponent: RouteError,
  validateSearch: (search): IndexSearch => {
    const q = typeof search.q === "string" && search.q.length > 0 ? search.q : undefined
    const statusRaw = typeof search.status === "string" ? search.status : undefined
    const status =
      statusRaw === "2xx" || statusRaw === "4xx" || statusRaw === "5xx" ? statusRaw : undefined
    const model = typeof search.model === "string" && search.model.length > 0 ? search.model : undefined
    return { q, status, model }
  },
})

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

function IndexPage() {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })

  // Compose filters for the API call.
  const apiFilters = useMemo(() => {
    const statusArr = search.status
      ? search.status === "2xx"
        ? [200, 201, 204]
        : search.status === "4xx"
          ? [400, 401, 403, 404, 429]
          : [500, 502, 503, 504]
      : undefined
    return {
      path: "/v1/chat/completions",
      search: search.q,
      model: search.model,
      status: statusArr,
      limit: 100,
      order: "desc" as const,
    }
  }, [search])

  const query = useQuery({
    queryKey: ["requests", apiFilters],
    queryFn: () => listRequests(apiFilters),
    refetchInterval: 5_000, // gentle auto-refresh while the user sits on the list
  })

  // Collect distinct models we've seen for the filter chips.
  const knownModels = useMemo(() => {
    if (!query.data) return []
    const set = new Set<string>()
    for (const r of query.data.requests) if (r.model) set.add(r.model)
    return [...set].sort()
  }, [query.data])

  const filterValue: RequestsFilterState = {
    search: search.q,
    statusClass: search.status,
    model: search.model,
  }

  function updateFilters(next: RequestsFilterState) {
    navigate({
      search: () => ({
        q: next.search,
        status: next.statusClass,
        model: next.model,
      }),
      replace: true,
    })
  }

  // Keyboard shortcut wiring via the root provider. `/` focuses the search
  // input; `j`/`k` move the highlighted row; `Enter` opens it; `Esc` clears.
  const requests = query.data?.requests ?? []
  const [selectedIndex, setSelectedIndex] = useState<number>(-1)

  const onSlash = useCallback(() => {
    const el = document.querySelector<HTMLInputElement>("input[data-search-input]")
    el?.focus()
    el?.select()
  }, [])

  const onJ = useCallback(() => {
    if (requests.length === 0) return
    setSelectedIndex((i) => Math.min(requests.length - 1, i < 0 ? 0 : i + 1))
  }, [requests.length])

  const onK = useCallback(() => {
    if (requests.length === 0) return
    setSelectedIndex((i) => Math.max(0, i < 0 ? 0 : i - 1))
  }, [requests.length])

  const onEnter = useCallback(() => {
    if (selectedIndex < 0 || selectedIndex >= requests.length) return
    const r = requests[selectedIndex]
    if (!r) return
    navigate({ to: "/r/$traceId", params: { traceId: r.traceId } })
  }, [navigate, selectedIndex, requests])

  const onEscape = useCallback(() => {
    setSelectedIndex(-1)
  }, [])

  useRegisterShortcuts({ onSlash, onJ, onK, onEnter, onEscape })

  return (
    <div className="container mx-auto flex flex-col gap-4 p-4 sm:p-6">
      <header className="flex flex-col gap-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <ListIcon data-icon="inline-start" />
          Requests
        </h1>
        <p className="text-muted-foreground text-sm">
          Every <code className="bg-muted rounded px-1 py-0.5 font-mono text-xs">POST /v1/chat/completions</code>{" "}
          recorded by the gateway. Click any row to see the full transcript.
        </p>
      </header>

      <RequestsFilters
        value={filterValue}
        onChange={updateFilters}
        models={knownModels}
      />

      {query.isError && (
        <Alert variant="destructive">
          <AlertTitle>Couldn't load requests</AlertTitle>
          <AlertDescription>{(query.error as Error).message}</AlertDescription>
        </Alert>
      )}

      {query.isPending ? (
        <ListSkeleton />
      ) : query.data && query.data.requests.length === 0 ? (
        <EmptyState filtered={Boolean(search.q || search.status || search.model)} />
      ) : (
        <RequestsTable
          requests={requests}
          total={query.data?.total ?? 0}
          selectedIndex={selectedIndex}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Table (composition-only — shadcn Table primitives)
// ---------------------------------------------------------------------------

function RequestsTable({
  requests,
  total,
  selectedIndex,
}: {
  requests: RequestRecord[]
  total: number
  selectedIndex: number
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="text-muted-foreground flex items-center justify-between text-xs">
        <span>
          {requests.length} of {total} shown
        </span>
        <span className="hidden sm:block">
          auto-refresh every 5 s · <kbd className="bg-muted rounded px-1 py-0.5">/</kbd> search ·{" "}
          <kbd className="bg-muted rounded px-1 py-0.5">j</kbd>/
          <kbd className="bg-muted rounded px-1 py-0.5">k</kbd> move ·{" "}
          <kbd className="bg-muted rounded px-1 py-0.5">Enter</kbd> open
        </span>
      </div>

      <div className="border-border overflow-hidden rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[160px]">When</TableHead>
              <TableHead className="w-[70px]">Status</TableHead>
              <TableHead>Model</TableHead>
              <TableHead className="w-[90px] text-right">Duration</TableHead>
              <TableHead className="w-[110px] text-right">Tokens</TableHead>
              <TableHead className="w-[130px]">Trace</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {requests.map((r, i) => (
              <RequestRow
                key={r.traceId}
                request={r}
                selected={i === selectedIndex}
              />
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

function RequestRow({ request, selected = false }: { request: RequestRecord; selected?: boolean }) {
  const inT = request.inputTokens ?? 0
  const outT = request.outputTokens ?? 0
  const total = inT + outT

  return (
    <TableRow
      className={`cursor-pointer ${selected ? "bg-accent/60" : ""}`}
      data-selected={selected || undefined}
    >
      <TableCell className="text-sm">
        <Link to="/r/$traceId" params={{ traceId: request.traceId }} className="block">
          <span className="font-medium">{formatRelativeTime(request.timestamp)}</span>
          <span className="text-muted-foreground ml-2 hidden font-mono text-xs lg:inline">
            {new Date(request.timestamp).toLocaleTimeString()}
          </span>
        </Link>
      </TableCell>
      <TableCell>
        <Link to="/r/$traceId" params={{ traceId: request.traceId }} className="block">
          <StatusBadge status={request.status} />
        </Link>
      </TableCell>
      <TableCell>
        <Link to="/r/$traceId" params={{ traceId: request.traceId }} className="block">
          <ModelBadge model={request.model} />
          {request.isStream && (
            <span className="text-muted-foreground ml-2 inline-flex items-center gap-1 text-xs">
              <ZapIcon className="size-3" />
              stream
            </span>
          )}
        </Link>
      </TableCell>
      <TableCell className="text-right font-mono text-xs">
        <Link to="/r/$traceId" params={{ traceId: request.traceId }} className="block">
          {formatDuration(request.duration)}
        </Link>
      </TableCell>
      <TableCell className="text-right font-mono text-xs">
        <Link to="/r/$traceId" params={{ traceId: request.traceId }} className="block">
          {total > 0 ? (
            <>
              <span>{formatTokens(total)}</span>
              <span className="text-muted-foreground ml-1">
                ({formatTokens(inT)}↓ {formatTokens(outT)}↑)
              </span>
            </>
          ) : (
            "—"
          )}
        </Link>
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-1">
          <Link
            to="/r/$traceId"
            params={{ traceId: request.traceId }}
            className="text-muted-foreground font-mono text-xs"
          >
            {truncate(request.traceId, 8)}
          </Link>
          <CopyButton value={request.traceId} label="Copy trace id" />
        </div>
      </TableCell>
    </TableRow>
  )
}

// ---------------------------------------------------------------------------
// Loading + empty states
// ---------------------------------------------------------------------------

function ListSkeleton() {
  return (
    <div className="border-border flex flex-col gap-0 overflow-hidden rounded-md border">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="border-border flex items-center gap-4 border-b p-3 last:border-b-0">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-6 w-12" />
          <Skeleton className="h-4 w-40 flex-1" />
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-4 w-20" />
        </div>
      ))}
    </div>
  )
}

function EmptyState({ filtered }: { filtered: boolean }) {
  if (filtered) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ListIcon />
          </EmptyMedia>
          <EmptyTitle>No matching requests</EmptyTitle>
          <EmptyDescription>
            Try clearing filters or widening the search.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <ListIcon />
        </EmptyMedia>
        <EmptyTitle>No requests yet</EmptyTitle>
        <EmptyDescription>
          Send one from any OpenAI-compatible client pointing at this gateway,
          or try the curl below.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <pre className="bg-muted overflow-x-auto rounded-md p-3 text-left text-xs">
          {`curl -X POST http://localhost:3457/v1/chat/completions \\
  -H 'Content-Type: application/json' \\
  -d '{"model":"claude-sonnet-4-6","messages":[{"role":"user","content":"hi"}]}'`}
        </pre>
      </EmptyContent>
    </Empty>
  )
}
