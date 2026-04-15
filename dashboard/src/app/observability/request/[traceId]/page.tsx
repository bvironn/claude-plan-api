"use client";

import * as React from "react";
import { useParams } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { format } from "date-fns";
import { EventDrawer } from "@/components/event-drawer";
import { fetchRequest } from "@/lib/telemetry/client";
import type { TelemetryEvent } from "@/lib/telemetry/types";
import type { RequestDetail } from "@/lib/telemetry/types";

const LEVEL_VARIANTS: Record<string, "default" | "destructive" | "secondary" | "outline"> = {
  error: "destructive",
  warn: "secondary",
  info: "default",
  debug: "outline",
};

function statusBadge(status?: number): "default" | "destructive" | "secondary" | "outline" {
  if (!status) return "outline";
  if (status >= 500) return "destructive";
  if (status >= 400) return "secondary";
  return "default";
}

export default function RequestDetailPage() {
  const params = useParams<{ traceId: string }>();
  const traceId = decodeURIComponent(params.traceId ?? "");

  const [data, setData] = React.useState<RequestDetail | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [selectedEvent, setSelectedEvent] = React.useState<TelemetryEvent | null>(null);
  const [drawerOpen, setDrawerOpen] = React.useState(false);

  React.useEffect(() => {
    if (!traceId) return;
    setLoading(true);
    fetchRequest(traceId)
      .then((d) => setData(d))
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [traceId]);

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-5xl mx-auto px-4 py-6 flex flex-col gap-6">
        {/* Header */}
        <div className="flex items-center gap-3">
          <Link href="/observability">
            <Button variant="ghost" size="icon">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <h1 className="text-xl font-bold tracking-tight font-mono">
              {loading ? "Loading…" : data ? `${data.request.method} ${data.request.path}` : "Request not found"}
            </h1>
            <p className="text-xs text-muted-foreground font-mono">{traceId}</p>
          </div>
        </div>

        {loading ? (
          <div className="space-y-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-20 w-full" />
            ))}
          </div>
        ) : error ? (
          <div className="text-destructive">{error}</div>
        ) : data ? (
          <>
            {/* Request summary */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Request Summary</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                  <div>
                    <p className="text-muted-foreground text-xs">Status</p>
                    <Badge variant={statusBadge(data.request.status)}>
                      {data.request.status ?? "—"}
                    </Badge>
                  </div>
                  <div>
                    <p className="text-muted-foreground text-xs">Duration</p>
                    <p className="font-mono">
                      {data.request.duration
                        ? `${Math.round(data.request.duration)}ms`
                        : "—"}
                    </p>
                  </div>
                  <div>
                    <p className="text-muted-foreground text-xs">Model</p>
                    <p className="font-mono text-xs">{data.request.model ?? "—"}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground text-xs">Tokens</p>
                    <p className="font-mono text-xs">
                      {data.request.totalTokens
                        ? `${data.request.totalTokens} total`
                        : "—"}
                    </p>
                  </div>
                  <div>
                    <p className="text-muted-foreground text-xs">Timestamp</p>
                    <p className="font-mono text-xs">
                      {format(new Date(data.request.timestamp), "yyyy-MM-dd HH:mm:ss")}
                    </p>
                  </div>
                  <div>
                    <p className="text-muted-foreground text-xs">Session</p>
                    <p className="font-mono text-xs">{data.request.sessionId ?? "—"}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground text-xs">IP</p>
                    <p className="font-mono text-xs">{data.request.ip ?? "—"}</p>
                  </div>
                  {data.request.error && (
                    <div className="col-span-2">
                      <p className="text-muted-foreground text-xs">Error</p>
                      <p className="font-mono text-xs text-destructive">{data.request.error}</p>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Event timeline */}
            {data.events.length > 0 && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">
                    Event Timeline ({data.events.length})
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="relative">
                    <div className="absolute left-[88px] top-0 bottom-0 w-px bg-border" />
                    <div className="space-y-2">
                      {data.events.map((ev, i) => (
                        <div
                          key={i}
                          className="flex gap-3 items-start cursor-pointer hover:bg-muted/50 rounded px-2 py-1 relative"
                          onClick={() => {
                            setSelectedEvent(ev);
                            setDrawerOpen(true);
                          }}
                        >
                          <span className="font-mono text-xs text-muted-foreground w-20 shrink-0 text-right">
                            {format(new Date(ev.timestamp), "HH:mm:ss.SSS")}
                          </span>
                          <div className="mt-1.5 w-2 h-2 rounded-full bg-primary shrink-0 z-10" />
                          <div className="flex flex-col min-w-0 flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <Badge
                                variant={LEVEL_VARIANTS[ev.level] ?? "default"}
                                className="text-xs shrink-0"
                              >
                                {ev.level}
                              </Badge>
                              <span className="font-mono text-xs">{ev.event}</span>
                              {ev.duration !== undefined && (
                                <span className="text-xs text-muted-foreground">
                                  {Math.round(ev.duration)}ms
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}
          </>
        ) : null}

        <EventDrawer
          event={selectedEvent}
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
        />
      </div>
    </div>
  );
}
