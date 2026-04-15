"use client";

import * as React from "react";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerClose,
} from "@/components/ui/drawer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { X, ExternalLink } from "lucide-react";
import { format } from "date-fns";
import type { TelemetryEvent } from "@/lib/telemetry/types";

const LEVEL_VARIANTS: Record<
  string,
  "default" | "destructive" | "secondary" | "outline"
> = {
  error: "destructive",
  warn: "secondary",
  info: "default",
  debug: "outline",
};

interface EventDrawerProps {
  event: TelemetryEvent | null;
  open: boolean;
  onClose: () => void;
}

export function EventDrawer({ event, open, onClose }: EventDrawerProps) {
  if (!event) return null;

  const formattedTime = event.timestamp
    ? format(new Date(event.timestamp), "yyyy-MM-dd HH:mm:ss.SSS")
    : "—";

  return (
    <Drawer open={open} onOpenChange={(o) => !o && onClose()}>
      <DrawerContent className="max-h-[85vh]">
        <DrawerHeader className="flex items-start justify-between border-b pb-3">
          <div className="flex flex-col gap-1">
            <DrawerTitle className="text-base font-mono">{event.event}</DrawerTitle>
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant={LEVEL_VARIANTS[event.level] ?? "default"}>
                {event.level}
              </Badge>
              <span className="text-xs text-muted-foreground font-mono">{formattedTime}</span>
              {event.traceId && (
                <span className="text-xs text-muted-foreground font-mono">
                  trace: {event.traceId.slice(0, 8)}…
                </span>
              )}
            </div>
          </div>
          <DrawerClose asChild>
            <Button variant="ghost" size="icon" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          </DrawerClose>
        </DrawerHeader>

        <ScrollArea className="p-4 flex-1 overflow-auto" style={{ maxHeight: "70vh" }}>
          {/* Meta fields */}
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm mb-4">
            {event.sessionId && (
              <>
                <span className="text-muted-foreground">Session</span>
                <span className="font-mono text-xs break-all">{event.sessionId}</span>
              </>
            )}
            {event.traceId && (
              <>
                <span className="text-muted-foreground">Trace ID</span>
                <span className="font-mono text-xs break-all flex items-center gap-1">
                  {event.traceId}
                  <a
                    href={`/observability/request/${event.traceId}`}
                    className="text-primary hover:underline inline-flex items-center"
                    title="View trace"
                  >
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </span>
              </>
            )}
            {event.http_method && (
              <>
                <span className="text-muted-foreground">HTTP</span>
                <span className="font-mono text-xs">
                  {event.http_method} {event.http_path}{" "}
                  {event.http_status && (
                    <Badge variant={event.http_status >= 400 ? "destructive" : "default"}>
                      {event.http_status}
                    </Badge>
                  )}
                </span>
              </>
            )}
            {event.duration !== undefined && (
              <>
                <span className="text-muted-foreground">Duration</span>
                <span className="font-mono text-xs">{Math.round(event.duration)}ms</span>
              </>
            )}
            {event.stream && (
              <>
                <span className="text-muted-foreground">Stream</span>
                <span className="font-mono text-xs">{event.stream}</span>
              </>
            )}
          </div>

          {/* Payload */}
          {event.payload && Object.keys(event.payload).length > 0 && (
            <>
              <Separator className="my-3" />
              <p className="text-xs font-semibold text-muted-foreground mb-2">PAYLOAD</p>
              <pre className="bg-muted text-xs rounded-md p-3 overflow-x-auto font-mono whitespace-pre-wrap break-all">
                {JSON.stringify(event.payload, null, 2)}
              </pre>
            </>
          )}

          {/* Stack trace */}
          {event.stack && (
            <>
              <Separator className="my-3" />
              <p className="text-xs font-semibold text-destructive mb-2">STACK TRACE</p>
              <pre className="bg-destructive/10 text-destructive text-xs rounded-md p-3 overflow-x-auto font-mono whitespace-pre-wrap">
                {event.stack}
              </pre>
            </>
          )}
        </ScrollArea>
      </DrawerContent>
    </Drawer>
  );
}
