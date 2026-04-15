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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { format } from "date-fns";
import { SearchBar } from "@/components/search-bar";
import { EventDrawer } from "@/components/event-drawer";
import type { TelemetryEvent } from "@/lib/telemetry/types";
import { fetchLogs } from "@/lib/telemetry/client";

const LEVEL_VARIANTS: Record<string, "default" | "destructive" | "secondary" | "outline"> = {
  error: "destructive",
  warn: "secondary",
  info: "default",
  debug: "outline",
};

const PAGE_SIZE = 50;

export function EventsTable() {
  const [events, setEvents] = React.useState<TelemetryEvent[]>([]);
  const [total, setTotal] = React.useState(0);
  const [offset, setOffset] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [search, setSearch] = React.useState("");
  const [level, setLevel] = React.useState<string>("all");
  const [stream, setStream] = React.useState("");
  const [selected, setSelected] = React.useState<TelemetryEvent | null>(null);
  const [drawerOpen, setDrawerOpen] = React.useState(false);

  const load = React.useCallback(
    async (off: number) => {
      setLoading(true);
      try {
        const resp = await fetchLogs({
          offset: off,
          limit: PAGE_SIZE,
          order: "desc",
          search: search || undefined,
          level: level !== "all" ? level : undefined,
          stream: stream || undefined,
        });
        setEvents(resp.events);
        setTotal(resp.total);
      } finally {
        setLoading(false);
      }
    },
    [search, level, stream]
  );

  React.useEffect(() => {
    setOffset(0);
    void load(0);
  }, [load]);

  const columns: ColumnDef<TelemetryEvent>[] = [
    {
      accessorKey: "timestamp",
      header: "Time",
      size: 160,
      cell: ({ getValue }) => {
        const val = getValue() as string;
        return (
          <span className="font-mono text-xs text-muted-foreground">
            {val ? format(new Date(val), "HH:mm:ss.SSS") : "—"}
          </span>
        );
      },
    },
    {
      accessorKey: "level",
      header: "Level",
      size: 70,
      cell: ({ getValue }) => {
        const val = getValue() as string;
        return (
          <Badge variant={LEVEL_VARIANTS[val] ?? "default"} className="text-xs">
            {val}
          </Badge>
        );
      },
    },
    {
      accessorKey: "event",
      header: "Event",
      cell: ({ getValue }) => (
        <span className="font-mono text-xs">{getValue() as string}</span>
      ),
    },
    {
      accessorKey: "stream",
      header: "Stream",
      size: 100,
      cell: ({ getValue }) => {
        const val = getValue() as string | undefined;
        return val ? (
          <Badge variant="outline" className="text-xs">
            {val}
          </Badge>
        ) : null;
      },
    },
    {
      accessorKey: "traceId",
      header: "Trace",
      size: 100,
      cell: ({ getValue }) => {
        const val = getValue() as string | undefined;
        return val ? (
          <span className="font-mono text-xs text-muted-foreground">
            {val.slice(0, 8)}…
          </span>
        ) : null;
      },
    },
    {
      accessorKey: "duration",
      header: "Duration",
      size: 80,
      cell: ({ getValue }) => {
        const val = getValue() as number | undefined;
        return val !== undefined ? (
          <span className="font-mono text-xs">{Math.round(val)}ms</span>
        ) : null;
      },
    },
  ];

  const table = useReactTable({
    data: events,
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
      {/* Filters */}
      <div className="flex flex-wrap gap-2 items-center">
        <div className="flex-1 min-w-48">
          <SearchBar
            value={search}
            onChange={setSearch}
            placeholder="Search events..."
          />
        </div>
        <Select value={level} onValueChange={(v) => setLevel(v ?? "all")}>
          <SelectTrigger className="w-32">
            <SelectValue placeholder="Level" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All levels</SelectItem>
            <SelectItem value="debug">debug</SelectItem>
            <SelectItem value="info">info</SelectItem>
            <SelectItem value="warn">warn</SelectItem>
            <SelectItem value="error">error</SelectItem>
          </SelectContent>
        </Select>
        <SearchBar
          value={stream}
          onChange={setStream}
          placeholder="Filter stream..."
        />
      </div>

      {/* Table */}
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
                <TableCell colSpan={columns.length} className="text-center text-muted-foreground py-10">
                  No events found
                </TableCell>
              </TableRow>
            ) : (
              table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  className="cursor-pointer hover:bg-muted/50"
                  onClick={() => {
                    setSelected(row.original);
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

      {/* Pagination */}
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">
          {total} total events · page {currentPage} of {totalPages || 1}
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

      <EventDrawer
        event={selected}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
      />
    </div>
  );
}
