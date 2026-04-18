import { createFileRoute, Link } from "@tanstack/react-router"
import {
  ActivityIcon,
  AlertCircleIcon,
  CircleDotIcon,
  PauseIcon,
  PlayIcon,
  PlugIcon,
  PlugZapIcon,
  TrashIcon,
} from "lucide-react"
import { useMemo, useState } from "react"

import { useEventStream } from "@/hooks/useEventStream"
import type { LogLevel, LogStream } from "@/lib/types"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@/components/ui/toggle-group"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Separator } from "@/components/ui/separator"
import { LevelBadge } from "@/components/layout/level-badge"

export const Route = createFileRoute("/live")({
  component: LivePage,
})

const LEVELS: LogLevel[] = ["trace", "debug", "info", "warn", "error", "fatal"]
const STREAMS: LogStream[] = ["http", "event", "perf", "app"]

function LivePage() {
  const { events, status, reconnects, paused, pendingCount, pause, resume, clear } = useEventStream()

  const [levelFilter, setLevelFilter] = useState<LogLevel | "">("")
  const [streamFilter, setStreamFilter] = useState<LogStream | "">("")

  const filtered = useMemo(() => {
    return events.filter((e) => {
      if (levelFilter && e.level !== levelFilter) return false
      if (streamFilter && e.stream !== streamFilter) return false
      return true
    })
  }, [events, levelFilter, streamFilter])

  return (
    <div className="container mx-auto flex flex-col gap-4 p-4 sm:p-6">
      <header className="flex flex-col gap-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <ActivityIcon data-icon="inline-start" />
          Live stream
        </h1>
        <p className="text-muted-foreground text-sm">
          Real-time events from{" "}
          <code className="bg-muted rounded px-1 py-0.5 font-mono text-xs">GET /api/telemetry/stream</code>{" "}
          via Server-Sent Events. Auto-reconnects with exponential backoff.
        </p>
      </header>

      <Card>
        <CardHeader className="border-b">
          <div className="flex flex-wrap items-center gap-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <ConnectionIndicator status={status} />
              <span className="font-medium">
                {status === "open" ? "Connected" : status === "reconnecting" ? "Reconnecting" : status === "connecting" ? "Connecting" : status === "paused" ? "Paused" : "Disconnected"}
              </span>
              {reconnects > 0 && (
                <Badge variant="outline" className="font-normal">
                  reconnects: {reconnects}
                </Badge>
              )}
              <Badge variant="secondary" className="font-mono font-normal">
                {filtered.length} / {events.length} shown
              </Badge>
            </CardTitle>

            <div className="ml-auto flex flex-wrap items-center gap-2">
              {/* Level */}
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                value={levelFilter}
                onValueChange={(v) => setLevelFilter((v as LogLevel) ?? "")}
              >
                {LEVELS.map((l) => (
                  <ToggleGroupItem key={l} value={l} className="font-mono text-xs capitalize">
                    {l}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>

              <Separator orientation="vertical" className="h-5" />

              {/* Stream */}
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                value={streamFilter}
                onValueChange={(v) => setStreamFilter((v as LogStream) ?? "")}
              >
                {STREAMS.map((s) => (
                  <ToggleGroupItem key={s} value={s} className="font-mono text-xs">
                    {s}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>

              <Separator orientation="vertical" className="h-5" />

              {paused ? (
                <Button variant="default" size="sm" onClick={resume}>
                  <PlayIcon data-icon="inline-start" />
                  Resume{pendingCount > 0 ? ` (+${pendingCount})` : ""}
                </Button>
              ) : (
                <Button variant="outline" size="sm" onClick={pause}>
                  <PauseIcon data-icon="inline-start" />
                  Pause
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={clear}>
                <TrashIcon data-icon="inline-start" />
                Clear
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <ScrollArea className="h-[calc(100vh-320px)] min-h-[400px]">
            {filtered.length === 0 ? (
              <div className="flex min-h-[300px] items-center justify-center p-6">
                <Empty>
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <ActivityIcon />
                    </EmptyMedia>
                    <EmptyTitle>Waiting for events…</EmptyTitle>
                    <EmptyDescription>
                      Trigger any request (chat completion, /v1/models, /health) and you'll see events stream in.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              </div>
            ) : (
              <ul className="divide-border divide-y">
                {filtered.map((e, i) => (
                  <EventRow key={`${e.timestamp}-${i}`} event={e} />
                ))}
              </ul>
            )}
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  )
}

function EventRow({ event }: { event: import("@/lib/types").TelemetryEvent }) {
  const payloadSummary = useMemo(() => {
    if (!event.payload) return ""
    const keys = Object.keys(event.payload).slice(0, 4)
    return keys
      .map((k) => {
        const val = event.payload![k]
        const str = typeof val === "string" ? val : typeof val === "number" ? String(val) : typeof val === "boolean" ? String(val) : JSON.stringify(val)
        return `${k}=${str.length > 40 ? str.slice(0, 40) + "…" : str}`
      })
      .join(" · ")
  }, [event.payload])

  return (
    <li className="hover:bg-muted/50 flex items-center gap-3 px-4 py-2 text-xs">
      <span className="text-muted-foreground w-16 shrink-0 font-mono">
        {event.timestamp.slice(11, 19)}
      </span>
      <LevelBadge level={event.level} />
      {event.stream && (
        <Badge variant="outline" className="w-14 justify-center font-mono text-[10px]">
          {event.stream}
        </Badge>
      )}
      <span className="truncate font-mono text-xs">{event.event}</span>
      <span className="text-muted-foreground flex-1 truncate font-mono">
        {payloadSummary}
      </span>
      {event.traceId && (
        <Link
          to="/r/$traceId"
          params={{ traceId: event.traceId }}
          className="text-muted-foreground hover:text-foreground font-mono"
        >
          {event.traceId.slice(0, 8)}
        </Link>
      )}
    </li>
  )
}

function ConnectionIndicator({ status }: { status: string }) {
  if (status === "open") {
    return <CircleDotIcon className="text-green-500 size-4" />
  }
  if (status === "reconnecting" || status === "connecting") {
    return <PlugZapIcon className="text-amber-500 size-4 animate-pulse" />
  }
  if (status === "closed") {
    return <PlugIcon className="text-muted-foreground size-4" />
  }
  return <AlertCircleIcon className="text-destructive size-4" />
}
