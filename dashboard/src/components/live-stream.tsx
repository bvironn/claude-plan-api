"use client";

import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Pause, Play, Trash2 } from "lucide-react";
import { format } from "date-fns";
import { getSSE } from "@/lib/telemetry/sse";
import { EventDrawer } from "@/components/event-drawer";
import type { TelemetryEvent } from "@/lib/telemetry/types";

const MAX_EVENTS = 200;

const LEVEL_VARIANTS: Record<string, "default" | "destructive" | "secondary" | "outline"> = {
  error: "destructive",
  warn: "secondary",
  info: "default",
  debug: "outline",
};

export function LiveStream() {
  const [events, setEvents] = React.useState<TelemetryEvent[]>([]);
  const [paused, setPaused] = React.useState(false);
  const [selected, setSelected] = React.useState<TelemetryEvent | null>(null);
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const pausedRef = React.useRef(paused);

  React.useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  // Auto-scroll to bottom
  React.useEffect(() => {
    if (!paused && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [events, paused]);

  React.useEffect(() => {
    const sse = getSSE();
    const unsub = sse.subscribe((event) => {
      if (pausedRef.current) return;
      setEvents((prev) => {
        const next = [...prev, event];
        return next.length > MAX_EVENTS ? next.slice(-MAX_EVENTS) : next;
      });
    });
    return unsub;
  }, []);

  return (
    <div className="flex flex-col gap-3">
      {/* Controls */}
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setPaused((p) => !p)}
          className="flex items-center gap-1.5"
        >
          {paused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
          {paused ? "Resume" : "Pause"}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setEvents([])}
          className="flex items-center gap-1.5"
        >
          <Trash2 className="h-3 w-3" />
          Clear
        </Button>
        <span className="text-xs text-muted-foreground ml-auto">
          {events.length} / {MAX_EVENTS} events
          {paused && (
            <Badge variant="secondary" className="ml-2 text-xs">
              PAUSED
            </Badge>
          )}
        </span>
      </div>

      {/* Stream */}
      <div
        ref={scrollRef}
        className="h-[560px] overflow-y-auto rounded-md border bg-background font-mono text-xs"
      >
        {events.length === 0 ? (
          <div className="flex items-center justify-center h-full text-muted-foreground">
            Waiting for events…
          </div>
        ) : (
          <div className="p-2 space-y-0.5">
            {events.map((ev, i) => (
              <div
                key={i}
                className="flex items-start gap-2 hover:bg-muted/50 rounded px-1 py-0.5 cursor-pointer"
                onClick={() => {
                  setSelected(ev);
                  setDrawerOpen(true);
                }}
              >
                <span className="text-muted-foreground shrink-0 w-24">
                  {format(new Date(ev.timestamp), "HH:mm:ss.SSS")}
                </span>
                <Badge
                  variant={LEVEL_VARIANTS[ev.level] ?? "default"}
                  className="text-xs shrink-0 py-0 px-1 h-4"
                >
                  {ev.level[0].toUpperCase()}
                </Badge>
                <span className="truncate text-foreground">{ev.event}</span>
                {ev.duration !== undefined && (
                  <span className="text-muted-foreground shrink-0">
                    {Math.round(ev.duration)}ms
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <EventDrawer
        event={selected}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
      />
    </div>
  );
}
