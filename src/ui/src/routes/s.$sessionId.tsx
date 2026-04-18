import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import {
  AlertCircleIcon,
  ArrowLeftIcon,
  ClockIcon,
  MessagesSquareIcon,
} from "lucide-react"
import { useMemo } from "react"

import { getRequest, listRequests } from "@/lib/api"
import { groupIntoConversations } from "@/lib/sessions"
import { formatDuration, formatRelativeTime, formatTokens, truncate } from "@/lib/format"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
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

  // To resolve `sessionId` → conversation, we re-group the full list. Cheap
  // relative to the transcript fetches that follow.
  const groupQuery = useQuery({
    queryKey: ["requests", "all-chat-completions"],
    queryFn: () =>
      listRequests({
        path: "/v1/chat/completions",
        limit: 500,
        order: "desc",
      }),
    refetchInterval: 10_000,
  })

  const conversation = useMemo(() => {
    if (!groupQuery.data) return null
    const groups = groupIntoConversations(groupQuery.data.requests)
    return groups.find((g) => g.id === sessionId) ?? null
  }, [groupQuery.data, sessionId])

  // Fetch every turn of the conversation in parallel. Each turn's transcript
  // is a separate API call. Using useQueries would be cleaner, but enabled
  // with a stable array gives us the same effect with less code.
  const turnsQuery = useQuery({
    queryKey: ["session-turns", sessionId, conversation?.traceIds],
    enabled: !!conversation,
    queryFn: async () => {
      if (!conversation) return []
      const results = await Promise.all(
        conversation.traceIds.map((id) => getRequest(id).catch(() => null)),
      )
      return results.filter((r): r is NonNullable<typeof r> => r !== null)
    },
  })

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
            <div className="flex flex-col gap-6">
              {turnsQuery.data?.map((turn, i) => (
                <TurnSection
                  key={turn.request.traceId}
                  index={i}
                  total={turnsQuery.data?.length ?? 0}
                  request={turn.request}
                />
              ))}
            </div>
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
}: {
  index: number
  total: number
  request: import("@/lib/types").RequestRecord
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="bg-muted/40 sticky top-14 z-20 -mx-4 flex items-center gap-2 border-b px-4 py-2 backdrop-blur-md sm:-mx-6 sm:px-6">
        <Badge variant="secondary" className="font-mono">
          Turn {index + 1} / {total}
        </Badge>
        <StatusBadge status={request.status} />
        <span className="text-muted-foreground text-xs">
          {formatRelativeTime(request.timestamp)} · {formatDuration(request.duration)} ·{" "}
          {formatTokens(request.outputTokens)} tokens out
        </span>
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
      </div>
      <TranscriptView record={request} />
    </section>
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
