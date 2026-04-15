"use client";

import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EventDrawer } from "@/components/event-drawer";
import { format } from "date-fns";
import type { TelemetryEvent } from "@/lib/telemetry/types";
import { fetchLogs } from "@/lib/telemetry/client";

const LEVEL_VARIANTS: Record<string, "default" | "destructive" | "secondary" | "outline"> = {
  error: "destructive",
  warn: "secondary",
  info: "default",
  debug: "outline",
};

export function SessionTimeline() {
  const [sessions, setSessions] = React.useState<string[]>([]);
  const [sessionId, setSessionId] = React.useState<string>("");
  const [events, setEvents] = React.useState<TelemetryEvent[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [selected, setSelected] = React.useState<TelemetryEvent | null>(null);
  const [drawerOpen, setDrawerOpen] = React.useState(false);

  // Load available sessions on mount
  React.useEffect(() => {
    fetchLogs({ limit: 500, order: "desc" }).then((resp) => {
      const ids = [
        ...new Set(
          resp.events
            .map((e) => e.sessionId)
            .filter((id): id is string => !!id)
        ),
      ];
      setSessions(ids);
      if (ids[0]) setSessionId(ids[0]);
    }).catch(() => {});
  }, []);

  React.useEffect(() => {
    if (!sessionId) return;
    setLoading(true);
    fetchLogs({ sessionId, limit: 200, order: "asc" })
      .then((resp) => setEvents(resp.events))
      .catch(() => setEvents([]))
      .finally(() => setLoading(false));
  }, [sessionId]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <label className="text-sm font-medium">Session</label>
        <Select value={sessionId} onValueChange={(v) => setSessionId(v ?? "")}>
          <SelectTrigger className="w-80">
            <SelectValue placeholder="Select a session..." />
          </SelectTrigger>
          <SelectContent>
            {sessions.length === 0 ? (
              <SelectItem value="__none__" disabled>
                No sessions found
              </SelectItem>
            ) : (
              sessions.map((id) => (
                <SelectItem key={id} value={id}>
                  <span className="font-mono text-xs">{id}</span>
                </SelectItem>
              ))
            )}
          </SelectContent>
        </Select>
      </div>

      <ScrollArea className="h-[500px] rounded-md border p-4">
        {loading ? (
          <div className="space-y-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex gap-3 items-start">
                <Skeleton className="h-4 w-20 shrink-0" />
                <Skeleton className="h-4 w-full" />
              </div>
            ))}
          </div>
        ) : events.length === 0 ? (
          <p className="text-muted-foreground text-sm text-center py-10">
            {sessionId ? "No events for this session" : "Select a session above"}
          </p>
        ) : (
          <div className="relative">
            {/* Timeline line */}
            <div className="absolute left-[88px] top-0 bottom-0 w-px bg-border" />
            <div className="space-y-2">
              {events.map((ev, i) => (
                <div
                  key={i}
                  className="flex gap-3 items-start cursor-pointer hover:bg-muted/50 rounded px-2 py-1 relative"
                  onClick={() => {
                    setSelected(ev);
                    setDrawerOpen(true);
                  }}
                >
                  <span className="font-mono text-xs text-muted-foreground w-20 shrink-0 text-right">
                    {format(new Date(ev.timestamp), "HH:mm:ss")}
                  </span>
                  {/* Dot */}
                  <div className="mt-1.5 w-2 h-2 rounded-full bg-primary shrink-0 z-10" />
                  <div className="flex flex-col min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge
                        variant={LEVEL_VARIANTS[ev.level] ?? "default"}
                        className="text-xs shrink-0"
                      >
                        {ev.level}
                      </Badge>
                      <span className="font-mono text-xs truncate">{ev.event}</span>
                      {ev.duration !== undefined && (
                        <span className="text-xs text-muted-foreground shrink-0">
                          {Math.round(ev.duration)}ms
                        </span>
                      )}
                    </div>
                    {ev.http_path && (
                      <span className="text-xs text-muted-foreground font-mono">
                        {ev.http_method} {ev.http_path}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </ScrollArea>

      <EventDrawer
        event={selected}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
      />
    </div>
  );
}
