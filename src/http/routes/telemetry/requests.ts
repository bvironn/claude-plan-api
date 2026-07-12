import {
  queryRequests,
  countRequests,
  getRequestByTrace,
  queryEvents,
} from "../../../observability/storage.ts";
import { withObservability } from "../../../observability/middleware.ts";
import { firstUserPreview } from "../../../observability/conversation-preview.ts";
import type { RequestFilters, EventFilters } from "../../../observability/storage.ts";

const CORS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

/**
 * Map a DB row to the camelCase API shape. Two projections (design decision #2):
 *   - slim (default `full=false`): omits requestBody/responseBody/
 *     upstreamRequestBody — the bytes-heavy fields — to cut list payload size.
 *   - full (`full=true`, via `?bodies=full` and always for the by-id transcript):
 *     the historical byte-superset.
 *
 * BOTH shapes carry the server-derived `firstUserPreview`: the first user
 * message text (preferring the upstream/Anthropic body, falling back to the
 * client/OpenAI body), so the dashboard can group sessions on the slim shape.
 */
function toCamel(r: Record<string, unknown>, full: boolean = true): Record<string, unknown> {
  const inT = (r.input_tokens as number | null) ?? 0;
  const outT = (r.output_tokens as number | null) ?? 0;
  const base: Record<string, unknown> = {
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
    firstUserPreview:
      firstUserPreview(r.upstream_request_body as string | null) ??
      firstUserPreview(r.request_body as string | null),
    error: r.error,
    ip: r.ip,
    userAgent: r.user_agent,
    apiKeyId: r.api_key_id ?? undefined,
  };

  if (!full) return base;

  return {
    ...base,
    requestBody: r.request_body,
    responseBody: r.response_body,
    upstreamRequestBody: r.upstream_request_body ?? null,
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

  // Guard `apiKeyId` with the shared numeric parser (NOT bare parseFloat): an
  // invalid/negative/absent value resolves to the -1 sentinel, which we treat
  // as "no filter" so a bad param never leaks NaN into `api_key_id = ?`.
  const apiKeyIdRaw = parseNum(p.get("apiKeyId"), -1);

  const filters: RequestFilters = {
    status: parseCsvInt(p.get("status")),
    method: p.get("method") ?? undefined,
    path: p.get("path") ?? undefined,
    traceId: p.get("traceId") ?? undefined,
    model: p.get("model") ?? undefined,
    apiKeyId: apiKeyIdRaw >= 0 ? apiKeyIdRaw : undefined,
    timeFrom: p.get("from") ?? undefined,
    timeTo: p.get("to") ?? undefined,
    minDuration: p.get("minDuration") ? parseFloat(p.get("minDuration")!) : undefined,
    maxDuration: p.get("maxDuration") ? parseFloat(p.get("maxDuration")!) : undefined,
    search: p.get("search") ?? undefined,
    limit: parseNum(p.get("limit"), 100, 1000),
    offset: parseNum(p.get("offset"), 0),
    order: p.get("order") === "asc" ? "asc" : "desc",
  };

  // Slim by default; `?bodies=full` opts back into the raw request/response/
  // upstream bodies (design decision #2). Only the exact value "full" opts in.
  const full = p.get("bodies") === "full";

  const total = countRequests(filters);
  const rows = queryRequests(filters);
  const requests = rows.map((r) => toCamel(r as unknown as Record<string, unknown>, full));

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
