import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  AlertCircleIcon,
  ArrowLeftIcon,
  ChevronDownIcon,
  ClockIcon,
  MessagesSquareIcon,
} from "lucide-react"
import { useMemo, useState } from "react"

import { getRequest } from "@/lib/api"
import { groupIntoConversations } from "@/lib/sessions"
import {
  sessionGroupingQueryOptions,
  SESSION_GROUPING_REFETCH_INTERVAL_MS,
} from "@/lib/session-query"
import {
  computeExpandedTurns,
  computeMessageDedup,
  toggleTurnInteraction,
  turnStaleTime,
  type TurnDedup,
} from "@/lib/session-turns"
import { formatDuration, formatRelativeTime, formatTokens, truncate } from "@/lib/format"
import { cn } from "@/lib/utils"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { ModelBadge, StatusBadge } from "@/components/layout/status-badge"
import { CopyButton } from "@/components/layout/copy-button"
import { TranscriptView } from "@/components/transcript/transcript-view"
import { RouteError } from "@/components/layout/route-error"

export const Route = createFileRoute("/s/$sessionId")({
  component: SessionDetailPage,
  errorComponent: RouteError,
})

function SessionDetailPage() {
  const { sessionId } = Route.useParams()

  // To resolve `sessionId` → conversation, we re-group the recent list. Cheap
  // relative to the transcript fetches that follow. Uses the shared poll-free
  // resolver: no 10s full-body poll (audit finding #3), resolve once + cached,
  // per-turn transcripts fetched on demand via `getRequest` below.
  const groupQuery = useQuery(sessionGroupingQueryOptions())

  const queryClient = useQueryClient()

  const conversation = useMemo(() => {
    if (!groupQuery.data) return null
    const groups = groupIntoConversations(groupQuery.data.requests)
    return groups.find((g) => g.id === sessionId) ?? null
  }, [groupQuery.data, sessionId])

  // Fetch every turn of the conversation in parallel. Each turn's transcript
  // is a separate API call. Using useQueries would be cleaner, but enabled
  // with a stable array gives us the same effect with less code.
  //
  // Each turn body is cached under its own `["session-turn", id]` entry via
  // `ensureQueryData`, with a per-turn `staleTime`: the last (still-growing)
  // turn stays live (`0` → re-fetched on each poll) while every prior turn is
  // immutable (`Infinity` → served from cache, never re-fetched). Note:
  // `staleTime` alone never triggers a background refetch for an already-cached
  // `ensureQueryData` entry — `revalidateIfStale: true` is required for that.
  // The outer `refetchInterval` is what drives that per-poll re-run (spec:
  // Immutable-Turn Fetch Caching + Live Last-Turn Updates).
  const turnsQuery = useQuery({
    queryKey: ["session-turns", sessionId, conversation?.traceIds],
    enabled: !!conversation,
    refetchInterval: SESSION_GROUPING_REFETCH_INTERVAL_MS,
    queryFn: async () => {
      if (!conversation) return { results: [], failedTraceIds: [] }
      const settled = await Promise.all(
        conversation.traceIds.map((id, i, arr) =>
          queryClient
            .ensureQueryData({
              queryKey: ["session-turn", id],
              queryFn: () => getRequest(id),
              staleTime: turnStaleTime(i, arr.length),
              revalidateIfStale: true,
            })
            .then((data) => ({ id, data, failed: false as const }))
            .catch(() => ({ id, data: null, failed: true as const })),
        ),
      )
      const failedTraceIds = settled.filter((s) => s.failed).map((s) => s.id)
      const results = settled
        .map((s) => s.data)
        .filter((r): r is NonNullable<typeof r> => r !== null)
      return { results, failedTraceIds }
    },
  })

  // Collapse state. `userInteracted` holds the traceIds of PRIOR turns the user
  // has explicitly toggled open; membership survives poll re-renders so a
  // manual expand is never reset by an unrelated refetch. The last turn is
  // always expanded (derived, never stored).
  const [userInteracted, setUserInteracted] = useState<Set<string>>(new Set())

  const turns = turnsQuery.data?.results
  const failedTurnCount = turnsQuery.data?.failedTraceIds.length ?? 0

  const turnIds = useMemo(
    () => turns?.map((t) => t.request.traceId) ?? [],
    [turns],
  )

  const expandedTurns = useMemo(
    () => computeExpandedTurns(turnIds, userInteracted),
    [turnIds, userInteracted],
  )

  // Per-turn render-dedup verdicts, keyed by traceId. Recomputed whenever the
  // turn bodies change (the last turn can grow on each poll).
  const dedupMap = useMemo(
    () => computeMessageDedup(turns?.map((t) => t.request) ?? []),
    [turns],
  )

  const handleToggle = (traceId: string) => {
    setUserInteracted((prev) => toggleTurnInteraction(traceId, prev))
  }

  return (
    <div className="container mx-auto flex flex-col gap-4 p-4 sm:p-6">
      <div className="flex items-center gap-3">
        <Button asChild variant="ghost" size="sm">
          <Link to="/sessions">
            <ArrowLeftIcon data-icon="inline-start" />
            Back to sessions
          </Link>
        </Button>
        <Separator orientation="vertical" className="h-5" />
        <MessagesSquareIcon className="text-muted-foreground size-4" />
        <h1 className="truncate text-lg font-semibold tracking-tight">Session</h1>
      </div>

      {groupQuery.isError && (
        <Alert variant="destructive">
          <AlertCircleIcon />
          <AlertTitle>Couldn't load session list</AlertTitle>
          <AlertDescription>{(groupQuery.error as Error).message}</AlertDescription>
        </Alert>
      )}

      {groupQuery.isPending ? (
        <SessionSkeleton />
      ) : !conversation ? (
        <div className="flex min-h-[40vh] items-center justify-center">
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <AlertCircleIcon />
              </EmptyMedia>
              <EmptyTitle>Session not found</EmptyTitle>
              <EmptyDescription>
                No conversation matches{" "}
                <code className="bg-muted rounded px-1 py-0.5 font-mono text-xs">{sessionId}</code>.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </div>
      ) : (
        <>
          <SessionHeader conv={conversation} />

          {turnsQuery.isPending ? (
            <div className="flex flex-col gap-4">
              <Skeleton className="h-32 w-full" />
              <Skeleton className="h-32 w-full" />
            </div>
          ) : (
            <>
              {failedTurnCount > 0 && (
                <Alert variant="destructive">
                  <AlertCircleIcon />
                  <AlertTitle>
                    {failedTurnCount} turn{failedTurnCount === 1 ? "" : "s"} failed to load
                  </AlertTitle>
                </Alert>
              )}
              <div className="flex flex-col gap-6">
                {turns?.map((turn, i) => {
                  const total = turns?.length ?? 0
                  return (
                    <TurnSection
                      key={turn.request.traceId}
                      index={i}
                      total={total}
                      request={turn.request}
                      isLast={i === total - 1}
                      isExpanded={expandedTurns.has(turn.request.traceId)}
                      onToggle={() => handleToggle(turn.request.traceId)}
                      dedup={dedupMap.get(turn.request.traceId)}
                    />
                  )
                })}
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}

function SessionHeader({ conv }: { conv: import("@/lib/sessions").Conversation }) {
  const durationMs =
    new Date(conv.lastActivityAt).getTime() - new Date(conv.startedAt).getTime()

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{truncate(conv.preview, 220)}</CardTitle>
        <CardDescription className="flex flex-wrap items-center gap-2 text-xs">
          <ClockIcon className="size-3" />
          started {formatRelativeTime(conv.startedAt)}
          <span>·</span>
          last activity {formatRelativeTime(conv.lastActivityAt)}
          {durationMs > 0 && (
            <>
              <span>·</span>
              <span>spans {formatDuration(durationMs)}</span>
            </>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary" className="font-mono">
          {conv.turns} turn{conv.turns === 1 ? "" : "s"}
        </Badge>
        {conv.models.map((m) => (
          <ModelBadge key={m} model={m} />
        ))}
        <Badge variant="outline" className="font-mono">
          {formatTokens(conv.totalInputTokens)} ↓
        </Badge>
        <Badge variant="outline" className="font-mono">
          {formatTokens(conv.totalOutputTokens)} ↑
        </Badge>
        {conv.hasError && <Badge variant="destructive">had errors</Badge>}
      </CardContent>
    </Card>
  )
}

function TurnSection({
  index,
  total,
  request,
  isLast,
  isExpanded,
  onToggle,
  dedup,
}: {
  index: number
  total: number
  request: import("@/lib/types").RequestRecord
  isLast: boolean
  isExpanded: boolean
  onToggle: () => void
  dedup?: TurnDedup
}) {
  // Turn identity summary — badge, status, and meta. For prior (collapsible)
  // turns this becomes the Collapsible trigger button and gains a chevron.
  const summary = (
    <>
      <Badge variant="secondary" className="font-mono">
        Turn {index + 1} / {total}
      </Badge>
      <StatusBadge status={request.status} />
      <span className="text-muted-foreground text-xs">
        {formatRelativeTime(request.timestamp)} · {formatDuration(request.duration)} ·{" "}
        {formatTokens(request.outputTokens)} tokens out
      </span>
      {!isLast && (
        <ChevronDownIcon
          className={cn(
            "text-muted-foreground size-4 shrink-0 transition-transform",
            isExpanded && "rotate-180",
          )}
        />
      )}
    </>
  )

  // Right-side controls (deep link + copy). These are interactive elements
  // (`<a>` and `<button>`) so they MUST live as siblings of the trigger, never
  // nested inside it — nesting interactive elements is invalid HTML.
  const controls = (
    <div className="ml-auto flex items-center gap-1">
      <Link
        to="/r/$traceId"
        params={{ traceId: request.traceId }}
        className="text-muted-foreground hover:text-foreground font-mono text-xs"
        title="Open this turn's standalone transcript"
      >
        {request.traceId.slice(0, 8)}
      </Link>
      <CopyButton value={request.traceId} label="Copy trace id" />
    </div>
  )

  const barClass =
    "bg-muted/40 sticky top-14 z-20 -mx-4 flex items-center gap-2 border-b px-4 py-2 backdrop-blur-md sm:-mx-6 sm:px-6"

  // Last turn: always expanded, no collapsible trigger (spec: single-turn and
  // last-turn requirements).
  if (isLast) {
    return (
      <section className="flex flex-col gap-3">
        <div className={barClass}>
          {summary}
          {controls}
        </div>
        <TranscriptView record={request} dedup={dedup} />
      </section>
    )
  }

  // Prior turns: collapsible. The summary cluster is the trigger; the
  // transcript is the collapsible content. Controls sit outside the trigger.
  return (
    <Collapsible open={isExpanded} onOpenChange={onToggle} asChild>
      <section className="flex flex-col gap-3">
        <div className={barClass}>
          <CollapsibleTrigger className="-my-2 flex flex-1 cursor-pointer items-center gap-2 py-2 text-left">
            {summary}
          </CollapsibleTrigger>
          {controls}
        </div>
        <CollapsibleContent>
          <TranscriptView record={request} dedup={dedup} />
        </CollapsibleContent>
      </section>
    </Collapsible>
  )
}

function SessionSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton className="h-28 w-full" />
      <Skeleton className="h-64 w-full" />
      <Skeleton className="h-48 w-full" />
    </div>
  )
}
