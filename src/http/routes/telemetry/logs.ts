import { queryEvents, countEvents } from "../../../observability/storage.ts";
import { withObservability } from "../../../observability/middleware.ts";
import type { EventFilters } from "../../../observability/storage.ts";

function parseCsv(val: string | null): string[] | undefined {
  if (!val) return undefined;
  const parts = val.split(",").map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts : undefined;
}

function parseNum(val: string | null, def: number, max?: number): number {
  const n = val ? parseInt(val, 10) : def;
  if (isNaN(n) || n < 0) return def;
  return max != null ? Math.min(n, max) : n;
}

async function _handleTelemetryLogs(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const p = url.searchParams;

  const filters: EventFilters = {
    level: parseCsv(p.get("level")),
    stream: parseCsv(p.get("stream")) as EventFilters["stream"],
    event: parseCsv(p.get("event")),
    traceId: p.get("traceId") ?? undefined,
    sessionId: p.get("sessionId") ?? undefined,
    search: p.get("search") ?? undefined,
    timeFrom: p.get("from") ?? undefined,
    timeTo: p.get("to") ?? undefined,
    limit: parseNum(p.get("limit"), 100, 1000),
    offset: parseNum(p.get("offset"), 0),
    order: (p.get("order") === "asc" ? "asc" : "desc"),
  };

  const total = countEvents(filters);
  const events = queryEvents(filters);

  const body = JSON.stringify({
    total,
    limit: filters.limit,
    offset: filters.offset,
    events,
  });

  return new Response(body, {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    },
  });
}

export const handleTelemetryLogs = withObservability(_handleTelemetryLogs);
