import {
  queryEventsRaw,
  queryRequestsRaw,
} from "../../../observability/storage.ts";
import { withObservability } from "../../../observability/middleware.ts";
import type { EventFilters, RequestFilters } from "../../../observability/storage.ts";

const MAX_ROWS = 100_000;

function parseNum(val: string | null, def: number, max?: number): number {
  const n = val ? parseInt(val, 10) : def;
  if (isNaN(n) || n < 0) return def;
  return max != null ? Math.min(n, max) : n;
}

function parseCsvInt(val: string | null): number[] | undefined {
  if (!val) return undefined;
  const parts = val.split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n));
  return parts.length ? parts : undefined;
}

function parseCsv(val: string | null): string[] | undefined {
  if (!val) return undefined;
  const parts = val.split(",").map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts : undefined;
}

function csvCell(val: unknown): string {
  if (val == null) return "";
  const s = String(val);
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function rowsToCsv(rows: Record<string, unknown>[]): string {
  const first = rows[0];
  if (!first) return "";
  const keys = Object.keys(first);
  const header = keys.map(csvCell).join(",");
  const lines = rows.map((r) => keys.map((k) => csvCell(r[k])).join(","));
  return [header, ...lines].join("\n");
}

function rowsToJsonStream(rows: Record<string, unknown>[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i === 0) controller.enqueue(encoder.encode("["));
      if (i < rows.length) {
        const prefix = i === 0 ? "\n" : ",\n";
        controller.enqueue(encoder.encode(prefix + JSON.stringify(rows[i])));
        i++;
      } else {
        controller.enqueue(encoder.encode("\n]"));
        controller.close();
      }
    },
  });
}

async function _handleTelemetryExport(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const p = url.searchParams;

  const type = p.get("type") === "requests" ? "requests" : "events";
  const format = p.get("format") === "csv" ? "csv" : "json";
  const limit = parseNum(p.get("limit"), MAX_ROWS, MAX_ROWS);
  const offset = parseNum(p.get("offset"), 0);
  const order = p.get("order") === "asc" ? "asc" : "desc";
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = `telemetry-${type}-${timestamp}.${format}`;

  let rows: Record<string, unknown>[];

  if (type === "requests") {
    const filters: RequestFilters = {
      status: parseCsvInt(p.get("status")),
      method: p.get("method") ?? undefined,
      path: p.get("path") ?? undefined,
      traceId: p.get("traceId") ?? undefined,
      model: p.get("model") ?? undefined,
      timeFrom: p.get("from") ?? undefined,
      timeTo: p.get("to") ?? undefined,
      minDuration: p.get("minDuration") ? parseFloat(p.get("minDuration")!) : undefined,
      maxDuration: p.get("maxDuration") ? parseFloat(p.get("maxDuration")!) : undefined,
      search: p.get("search") ?? undefined,
      limit,
      offset,
      order,
    };
    rows = queryRequestsRaw(filters) as unknown as Record<string, unknown>[];
  } else {
    const filters: EventFilters = {
      level: parseCsv(p.get("level")),
      stream: parseCsv(p.get("stream")) as EventFilters["stream"],
      event: parseCsv(p.get("event")),
      traceId: p.get("traceId") ?? undefined,
      sessionId: p.get("sessionId") ?? undefined,
      search: p.get("search") ?? undefined,
      timeFrom: p.get("from") ?? undefined,
      timeTo: p.get("to") ?? undefined,
      limit,
      offset,
      order,
    };
    rows = queryEventsRaw(filters);
  }

  const headers: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Content-Disposition": `attachment; filename="${filename}"`,
  };

  if (format === "csv") {
    headers["Content-Type"] = "text/csv; charset=utf-8";
    return new Response(rowsToCsv(rows), { headers });
  } else {
    headers["Content-Type"] = "application/json";
    return new Response(rowsToJsonStream(rows), { headers });
  }
}

export const handleTelemetryExport = withObservability(_handleTelemetryExport);
