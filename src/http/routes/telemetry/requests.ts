import {
  queryRequests,
  countRequests,
  getRequestByTrace,
  queryEvents,
} from "../../../observability/storage.ts";
import { withObservability } from "../../../observability/middleware.ts";
import type { RequestFilters, EventFilters } from "../../../observability/storage.ts";

const CORS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function toCamel(r: Record<string, unknown>): Record<string, unknown> {
  const inT = (r.input_tokens as number | null) ?? 0;
  const outT = (r.output_tokens as number | null) ?? 0;
  return {
    id: r.id,
    traceId: r.trace_id,
    timestamp: r.timestamp,
    method: r.method,
    path: r.path,
    status: r.status,
    duration: r.duration_ms,
    model: r.model,
    isStream: r.is_stream === 1,
    inputTokens: r.input_tokens ?? undefined,
    outputTokens: r.output_tokens ?? undefined,
    totalTokens: inT + outT > 0 ? inT + outT : undefined,
    cacheReadTokens: r.cache_read_tokens ?? undefined,
    cacheCreationTokens: r.cache_creation_tokens ?? undefined,
    requestBody: r.request_body,
    responseBody: r.response_body,
    error: r.error,
    ip: r.ip,
    userAgent: r.user_agent,
  };
}

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

async function _handleTelemetryRequests(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const p = url.searchParams;

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
    limit: parseNum(p.get("limit"), 100, 1000),
    offset: parseNum(p.get("offset"), 0),
    order: p.get("order") === "asc" ? "asc" : "desc",
  };

  const total = countRequests(filters);
  const rows = queryRequests(filters);
  const requests = rows.map((r) => toCamel(r as unknown as Record<string, unknown>));

  return new Response(
    JSON.stringify({ total, limit: filters.limit, offset: filters.offset, requests }),
    { headers: CORS }
  );
}

async function _handleTelemetryRequestById(req: Request): Promise<Response> {
  const url = new URL(req.url);
  // pathname is /api/telemetry/requests/:traceId
  const traceId = url.pathname.split("/api/telemetry/requests/")[1];

  if (!traceId) {
    return new Response(JSON.stringify({ error: "Missing traceId" }), { status: 400, headers: CORS });
  }

  const request = getRequestByTrace(traceId);
  if (!request) {
    return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: CORS });
  }

  const evFilters: EventFilters = { traceId, limit: 1000, order: "asc" };
  const events = queryEvents(evFilters);

  return new Response(
    JSON.stringify({ request: toCamel(request as unknown as Record<string, unknown>), events }),
    { headers: CORS }
  );
}

export const handleTelemetryRequests = withObservability(_handleTelemetryRequests);
export const handleTelemetryRequestById = withObservability(_handleTelemetryRequestById);
