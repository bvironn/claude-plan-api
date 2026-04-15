"use client";

import * as React from "react";
import {
  useReactTable,
  getCoreRowModel,
  flexRender,
  type ColumnDef,
} from "@tanstack/react-table";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerClose,
} from "@/components/ui/drawer";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { getSSE } from "@/lib/telemetry/sse";
import { format } from "date-fns";
import { SearchBar } from "@/components/search-bar";
import { EventDrawer } from "@/components/event-drawer";
import type { TelemetryRequest, TelemetryEvent } from "@/lib/telemetry/types";
import { fetchRequests, fetchRequest } from "@/lib/telemetry/client";

const PAGE_SIZE = 50;

function statusColor(status?: number): "default" | "destructive" | "secondary" | "outline" {
  if (!status) return "outline";
  if (status >= 500) return "destructive";
  if (status >= 400) return "secondary";
  return "default";
}

function methodColor(method: string): string {
  const colors: Record<string, string> = {
    GET: "text-green-600",
    POST: "text-blue-600",
    PUT: "text-yellow-600",
    PATCH: "text-orange-600",
    DELETE: "text-red-600",
  };
  return colors[method] ?? "";
}

function RequestDetailDrawer({
  traceId,
  open,
  onClose,
}: {
  traceId: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const [data, setData] = React.useState<{
    request: TelemetryRequest;
    events: TelemetryEvent[];
  } | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [selectedEvent, setSelectedEvent] = React.useState<TelemetryEvent | null>(null);
  const [eventDrawerOpen, setEventDrawerOpen] = React.useState(false);

  React.useEffect(() => {
    if (!traceId || !open) return;
    setLoading(true);
    fetchRequest(traceId)
      .then((d) => setData(d))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [traceId, open]);

  return (
    <>
      <Drawer open={open} onOpenChange={(o) => !o && onClose()}>
        <DrawerContent className="max-h-[85vh]">
          <DrawerHeader className="flex items-start justify-between border-b pb-3">
            <div>
              <DrawerTitle className="text-base font-mono">
                {data?.request.method} {data?.request.path}
              </DrawerTitle>
              {traceId && (
                <p className="text-xs text-muted-foreground font-mono mt-1">
                  trace: {traceId}
                </p>
              )}
            </div>
            <DrawerClose asChild>
              <Button variant="ghost" size="icon" onClick={onClose}>
                <X className="h-4 w-4" />
              </Button>
            </DrawerClose>
          </DrawerHeader>

          <ScrollArea className="p-4 flex-1" style={{ maxHeight: "70vh" }}>
            {loading ? (
              <div className="space-y-2">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-6 w-full" />
                ))}
              </div>
            ) : data ? (
              <>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm mb-4">
                  <span className="text-muted-foreground">Status</span>
                  <Badge variant={statusColor(data.request.status)}>
                    {data.request.status ?? "—"}
                  </Badge>
                  <span className="text-muted-foreground">Duration</span>
                  <span className="font-mono text-xs">
                    {data.request.duration ? `${Math.round(data.request.duration)}ms` : "—"}
                  </span>
                  <span className="text-muted-foreground">Model</span>
                  <span className="font-mono text-xs">{data.request.model ?? "—"}</span>
                  <span className="text-muted-foreground">Tokens</span>
                  <span className="font-mono text-xs">
                    {data.request.totalTokens
                      ? `${data.request.totalTokens} (in: ${data.request.inputTokens} / out: ${data.request.outputTokens})`
                      : "—"}
                  </span>
                  <span className="text-muted-foreground">Time</span>
                  <span className="font-mono text-xs">
                    {format(new Date(data.request.timestamp), "yyyy-MM-dd HH:mm:ss")}
                  </span>
                </div>

                {data.events.length > 0 && (
                  <>
                    <Separator className="my-3" />
                    <p className="text-xs font-semibold text-muted-foreground mb-2">
                      CORRELATED EVENTS ({data.events.length})
                    </p>
                    <div className="space-y-1">
                      {data.events.map((ev, i) => (
                        <div
                          key={i}
                          className="flex items-center gap-2 text-xs cursor-pointer hover:bg-muted rounded px-2 py-1"
                          onClick={() => {
                            setSelectedEvent(ev);
                            setEventDrawerOpen(true);
                          }}
                        >
                          <Badge
                            variant={
                              ev.level === "error"
                                ? "destructive"
                                : ev.level === "warn"
                                ? "secondary"
                                : "outline"
                            }
                            className="text-xs shrink-0"
                          >
                            {ev.level}
                          </Badge>
                          <span className="font-mono text-muted-foreground shrink-0">
                            {format(new Date(ev.timestamp), "HH:mm:ss.SSS")}
                          </span>
                          <span className="font-mono truncate">{ev.event}</span>
                          {ev.duration !== undefined && (
                            <span className="text-muted-foreground shrink-0">
                              {Math.round(ev.duration)}ms
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </>
            ) : (
              <p className="text-muted-foreground text-sm">Failed to load request details.</p>
            )}
          </ScrollArea>
        </DrawerContent>
      </Drawer>
      <EventDrawer
        event={selectedEvent}
        open={eventDrawerOpen}
        onClose={() => setEventDrawerOpen(false)}
      />
    </>
  );
}

export function RequestsTable() {
  const [requests, setRequests] = React.useState<TelemetryRequest[]>([]);
  const [total, setTotal] = React.useState(0);
  const [offset, setOffset] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [search, setSearch] = React.useState("");
  const [selectedTraceId, setSelectedTraceId] = React.useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = React.useState(false);

  const load = React.useCallback(
    async (off: number) => {
      setLoading(true);
      try {
        const resp = await fetchRequests({
          offset: off,
          limit: PAGE_SIZE,
          order: "desc",
          search: search || undefined,
        });
        setRequests(resp.requests);
        setTotal(resp.total);
      } finally {
        setLoading(false);
      }
    },
    [search]
  );

  React.useEffect(() => {
    setOffset(0);
    void load(0);
  }, [load]);

  // Live refresh: subscribe to SSE and reload when an HTTP request finishes,
  // but only if we're on the first page (so we don't disturb pagination).
  React.useEffect(() => {
    if (offset !== 0) return;
    let pending = false;
    const unsub = getSSE().subscribe((ev) => {
      if (ev.event === "http.request.end" || ev.event === "http.request.error") {
        if (pending) return;
        pending = true;
        setTimeout(() => {
          pending = false;
          void load(0);
        }, 250);
      }
    });
    return unsub;
  }, [offset, load]);

  const columns: ColumnDef<TelemetryRequest>[] = [
    {
      accessorKey: "timestamp",
      header: "Time",
      size: 160,
      cell: ({ getValue }) => {
        const val = getValue() as string;
        return (
          <span className="font-mono text-xs text-muted-foreground">
            {format(new Date(val), "HH:mm:ss")}
          </span>
        );
      },
    },
    {
      accessorKey: "method",
      header: "Method",
      size: 70,
      cell: ({ getValue }) => {
        const val = getValue() as string;
        return (
          <span className={`font-mono text-xs font-bold ${methodColor(val)}`}>{val}</span>
        );
      },
    },
    {
      accessorKey: "path",
      header: "Path",
      cell: ({ getValue }) => (
        <span className="font-mono text-xs">{getValue() as string}</span>
      ),
    },
    {
      accessorKey: "status",
      header: "Status",
      size: 70,
      cell: ({ getValue }) => {
        const val = getValue() as number | undefined;
        return val ? (
          <Badge variant={statusColor(val)}>{val}</Badge>
        ) : (
          <span className="text-muted-foreground text-xs">—</span>
        );
      },
    },
    {
      accessorKey: "duration",
      header: "Duration",
      size: 90,
      cell: ({ getValue }) => {
        const val = getValue() as number | undefined;
        return val !== undefined ? (
          <span className="font-mono text-xs">{Math.round(val)}ms</span>
        ) : (
          <span className="text-muted-foreground text-xs">—</span>
        );
      },
    },
    {
      accessorKey: "model",
      header: "Model",
      size: 120,
      cell: ({ getValue }) => {
        const val = getValue() as string | undefined;
        return val ? (
          <Badge variant="outline" className="text-xs max-w-[100px] truncate">
            {val}
          </Badge>
        ) : null;
      },
    },
    {
      accessorKey: "totalTokens",
      header: "Tokens",
      size: 70,
      cell: ({ getValue }) => {
        const val = getValue() as number | undefined;
        return val !== undefined ? (
          <span className="font-mono text-xs">{val.toLocaleString()}</span>
        ) : (
          <span className="text-muted-foreground text-xs">—</span>
        );
      },
    },
  ];

  const table = useReactTable({
    data: requests,
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    rowCount: total,
  });

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  const goToPage = (page: number) => {
    const newOffset = (page - 1) * PAGE_SIZE;
    setOffset(newOffset);
    void load(newOffset);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2 items-center">
        <div className="flex-1 min-w-48">
          <SearchBar value={search} onChange={setSearch} placeholder="Search requests..." />
        </div>
      </div>

      <div className="rounded-md border overflow-auto">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((hg) => (
              <TableRow key={hg.id}>
                {hg.headers.map((h) => (
                  <TableHead key={h.id} style={{ width: h.getSize() }}>
                    {flexRender(h.column.columnDef.header, h.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {loading ? (
              Array.from({ length: 8 }).map((_, i) => (
                <TableRow key={i}>
                  {columns.map((_, ci) => (
                    <TableCell key={ci}>
                      <Skeleton className="h-4 w-full" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : table.getRowModel().rows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className="text-center text-muted-foreground py-10"
                >
                  No requests found
                </TableCell>
              </TableRow>
            ) : (
              table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  className="cursor-pointer hover:bg-muted/50"
                  onClick={() => {
                    setSelectedTraceId(row.original.traceId);
                    setDrawerOpen(true);
                  }}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id} style={{ width: cell.column.getSize() }}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">
          {total} total requests · page {currentPage} of {totalPages || 1}
        </span>
        <div className="flex gap-1">
          <Button
            variant="outline"
            size="icon"
            onClick={() => goToPage(currentPage - 1)}
            disabled={currentPage <= 1}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            onClick={() => goToPage(currentPage + 1)}
            disabled={currentPage >= totalPages}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <RequestDetailDrawer
        traceId={selectedTraceId}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
      />
    </div>
  );
}
