import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import {
  AlertCircleIcon,
  ClockIcon,
  MessageSquareIcon,
  MessagesSquareIcon,
} from "lucide-react"
import { useMemo } from "react"

import { listRequests } from "@/lib/api"
import { groupIntoConversations } from "@/lib/sessions"
import { formatRelativeTime, formatTokens, truncate } from "@/lib/format"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { ModelBadge } from "@/components/layout/status-badge"

export const Route = createFileRoute("/sessions")({
  component: SessionsPage,
})

function SessionsPage() {
  const query = useQuery({
    queryKey: ["requests", "all-chat-completions"],
    queryFn: () =>
      listRequests({
        path: "/v1/chat/completions",
        limit: 500,
        order: "desc",
      }),
    refetchInterval: 10_000,
  })

  const conversations = useMemo(() => {
    if (!query.data) return []
    return groupIntoConversations(query.data.requests)
  }, [query.data])

  return (
    <div className="container mx-auto flex flex-col gap-4 p-4 sm:p-6">
      <header className="flex flex-col gap-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <MessagesSquareIcon data-icon="inline-start" />
          Sessions
        </h1>
        <p className="text-muted-foreground text-sm">
          Chat completions grouped into conversations by first user message.
          Consecutive turns within ~1 hour collapse into a single session — click
          to open the latest turn (contains the richest history).
        </p>
      </header>

      {query.isError && (
        <Alert variant="destructive">
          <AlertCircleIcon />
          <AlertTitle>Couldn't load sessions</AlertTitle>
          <AlertDescription>{(query.error as Error).message}</AlertDescription>
        </Alert>
      )}

      {query.isPending ? (
        <SessionsSkeleton />
      ) : conversations.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <MessagesSquareIcon />
            </EmptyMedia>
            <EmptyTitle>No conversations yet</EmptyTitle>
            <EmptyDescription>
              Send a chat completion and the first turn will appear here.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {conversations.map((c) => (
            <ConversationCard key={c.id} conv={c} />
          ))}
        </div>
      )}
    </div>
  )
}

function ConversationCard({ conv }: { conv: import("@/lib/sessions").Conversation }) {
  const durationMs = new Date(conv.lastActivityAt).getTime() - new Date(conv.startedAt).getTime()

  return (
    <Link
      to="/r/$traceId"
      params={{ traceId: conv.latestTraceId }}
      className="block"
    >
      <Card className="hover:border-primary/60 h-full cursor-pointer transition-colors">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">
            <MessageSquareIcon className="text-muted-foreground inline size-4" /> {truncate(conv.preview, 120)}
          </CardTitle>
          <CardDescription className="flex items-center gap-1.5 text-xs">
            <ClockIcon className="size-3" />
            {formatRelativeTime(conv.lastActivityAt)}
            {durationMs > 0 && (
              <span className="text-muted-foreground">· spans {formatDurationShort(durationMs)}</span>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="secondary" className="font-mono">
              {conv.turns} turn{conv.turns === 1 ? "" : "s"}
            </Badge>
            {conv.models.map((m) => (
              <ModelBadge key={m} model={m} />
            ))}
            {conv.hasError && (
              <Badge variant="destructive" className="font-normal">
                had errors
              </Badge>
            )}
          </div>
          <div className="text-muted-foreground flex gap-3 text-xs">
            <span>
              <span className="font-mono">{formatTokens(conv.totalInputTokens)}</span> ↓
            </span>
            <span>
              <span className="font-mono">{formatTokens(conv.totalOutputTokens)}</span> ↑
            </span>
            <span className="text-muted-foreground/60 ml-auto font-mono">
              {conv.latestTraceId.slice(0, 8)}
            </span>
          </div>
        </CardContent>
      </Card>
    </Link>
  )
}

function SessionsSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <Skeleton key={i} className="h-40 w-full" />
      ))}
    </div>
  )
}

/** Compact duration ("2h 14m", "34m", "12s"). */
function formatDurationShort(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  const rem = m % 60
  return rem === 0 ? `${h}h` : `${h}h ${rem}m`
}
