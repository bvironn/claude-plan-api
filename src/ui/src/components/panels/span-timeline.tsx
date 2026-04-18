import { ClockIcon } from "lucide-react"
import { useMemo } from "react"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import type { TelemetryEvent } from "@/lib/types"
import { formatDuration } from "@/lib/format"

interface Span {
  name: string
  start: number
  duration: number
  end: number
  level: string
}

function extractSpans(events: TelemetryEvent[]): Span[] {
  // Match *.start / *.end pairs by event-name prefix and parentSpanId.
  const startByKey = new Map<string, TelemetryEvent>()
  const spans: Span[] = []

  for (const e of events) {
    if (e.event.endsWith(".start")) {
      const key = e.event.replace(/\.start$/, "")
      startByKey.set(`${key}::${e.spanId ?? ""}`, e)
    } else if (e.event.endsWith(".end")) {
      const key = e.event.replace(/\.end$/, "")
      const startKey = `${key}::${e.spanId ?? ""}`
      const start = startByKey.get(startKey)
      if (start) {
        const startMs = new Date(start.timestamp).getTime()
        const endMs = new Date(e.timestamp).getTime()
        spans.push({
          name: key,
          start: startMs,
          duration: e.duration ?? endMs - startMs,
          end: endMs,
          level: e.level,
        })
        startByKey.delete(startKey)
      }
    }
  }

  return spans
}

export function SpanTimeline({ events }: { events: TelemetryEvent[] }) {
  const spans = useMemo(() => extractSpans(events), [events])

  if (spans.length === 0) return null

  const minStart = Math.min(...spans.map((s) => s.start))
  const maxEnd = Math.max(...spans.map((s) => s.end))
  const totalDuration = Math.max(maxEnd - minStart, 1) // avoid div-by-zero

  // Sort spans by start time ascending so the waterfall flows top-to-bottom.
  const sorted = [...spans].sort((a, b) => a.start - b.start)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <ClockIcon data-icon="inline-start" />
          Span timeline
          <span className="text-muted-foreground font-mono text-xs font-normal">
            ({spans.length} · total {formatDuration(totalDuration)})
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-1">
          {sorted.map((s, i) => {
            const offsetPct = ((s.start - minStart) / totalDuration) * 100
            const widthPct = Math.max((s.duration / totalDuration) * 100, 1)

            return (
              <Tooltip key={i}>
                <TooltipTrigger asChild>
                  <div className="grid grid-cols-[180px_1fr] items-center gap-3">
                    <span className="truncate font-mono text-xs">
                      {s.name}
                    </span>
                    <div className="bg-muted/40 relative h-5 overflow-hidden rounded">
                      <div
                        className="bg-primary absolute top-0 h-full rounded transition-all"
                        style={{
                          left: `${offsetPct}%`,
                          width: `${widthPct}%`,
                        }}
                      />
                    </div>
                  </div>
                </TooltipTrigger>
                <TooltipContent side="left" className="font-mono text-xs">
                  <div>{s.name}</div>
                  <div className="text-muted-foreground">
                    offset +{formatDuration(s.start - minStart)} · {formatDuration(s.duration)}
                  </div>
                </TooltipContent>
              </Tooltip>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}
