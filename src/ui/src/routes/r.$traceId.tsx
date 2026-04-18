import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { AlertCircleIcon, ArrowLeftIcon, MessageSquareIcon } from "lucide-react"

import { getRequest } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { TranscriptView } from "@/components/transcript/transcript-view"
import {
  ReplayButton,
  ReplayPanel,
  type ReplayRecord,
} from "@/components/transcript/replay-button"
import { ExportMenu } from "@/components/transcript/export-menu"
import { TechnicalPanel } from "@/components/panels/technical-panel"
import { SpanTimeline } from "@/components/panels/span-timeline"
import { Separator } from "@/components/ui/separator"
import { StatusBadge } from "@/components/layout/status-badge"
import { formatRelativeTime } from "@/lib/format"
import { RouteError } from "@/components/layout/route-error"

export const Route = createFileRoute("/r/$traceId")({
  component: TranscriptPage,
  errorComponent: RouteError,
})

function TranscriptPage() {
  const { traceId } = Route.useParams()
  const [replay, setReplay] = useState<ReplayRecord | null>(null)

  const query = useQuery({
    queryKey: ["request", traceId],
    queryFn: () => getRequest(traceId),
    staleTime: 30_000, // once a request is complete it basically never changes
  })

  return (
    <div className="container mx-auto flex flex-col gap-4 p-4 sm:p-6">
      {/* Back + header strip */}
      <div className="flex items-center gap-3">
        <Button asChild variant="ghost" size="sm">
          <Link to="/">
            <ArrowLeftIcon data-icon="inline-start" />
            Back to list
          </Link>
        </Button>
        <Separator orientation="vertical" className="h-5" />
        <MessageSquareIcon className="text-muted-foreground size-4" />
        <h1 className="truncate text-lg font-semibold tracking-tight">Transcript</h1>
        {query.data?.request && (
          <>
            <StatusBadge status={query.data.request.status} />
            <span className="text-muted-foreground hidden text-sm sm:inline">
              {formatRelativeTime(query.data.request.timestamp)}
            </span>
            <div className="ml-auto flex items-center gap-2">
              <ReplayButton
                original={query.data.request}
                onReplay={setReplay}
                externalInFlight={replay?.streaming ?? false}
              />
              <ExportMenu record={query.data.request} events={query.data.events} />
            </div>
          </>
        )}
      </div>

      {query.isPending && <TranscriptSkeleton />}

      {query.isError && (
        <Alert variant="destructive">
          <AlertCircleIcon />
          <AlertTitle>Couldn't load transcript</AlertTitle>
          <AlertDescription>{(query.error as Error).message}</AlertDescription>
        </Alert>
      )}

      {query.data && !query.data.request && (
        <div className="flex min-h-[50vh] items-center justify-center">
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <AlertCircleIcon />
              </EmptyMedia>
              <EmptyTitle>Trace not found</EmptyTitle>
              <EmptyDescription>
                No record for <code className="bg-muted rounded px-1 py-0.5 font-mono text-xs">{traceId}</code>.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </div>
      )}

      {query.data?.request && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(280px,380px)]">
          <div className="flex min-w-0 flex-col gap-4">
            <TranscriptView record={query.data.request} />
            <ReplayPanel replay={replay} />
          </div>
          <div className="flex flex-col gap-4 lg:sticky lg:top-20 lg:self-start">
            <TechnicalPanel request={query.data.request} />
            {query.data.events && query.data.events.length > 0 && (
              <SpanTimeline events={query.data.events} />
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function TranscriptSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(280px,380px)]">
      <div className="flex flex-col gap-4">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-32 w-3/4" />
        <Skeleton className="h-24 w-2/3 self-end" />
        <Skeleton className="h-40 w-full" />
      </div>
      <div className="flex flex-col gap-4">
        <Skeleton className="h-52 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    </div>
  )
}
