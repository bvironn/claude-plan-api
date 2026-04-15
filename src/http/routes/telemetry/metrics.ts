import { getMetrics } from "../../../observability/storage.ts";
import { withObservability } from "../../../observability/middleware.ts";

async function _handleTelemetryMetrics(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const windowStr = url.searchParams.get("window");
  const windowMs = windowStr ? Math.max(1000, parseInt(windowStr, 10)) : 300_000;

  const m = getMetrics(isNaN(windowMs) ? 300_000 : windowMs);

  const dto = {
    window_ms: windowMs,
    generated_at: new Date().toISOString(),
    events_per_min: m.eventsPerMin,
    active_errors: m.activeErrors,
    requests_total: m.requestsTotal,
    requests_by_status: m.requestsByStatus,
    latency_p50: m.latencyP50,
    latency_p95: m.latencyP95,
    latency_p99: m.latencyP99,
    tokens_in: m.tokensIn,
    tokens_out: m.tokensOut,
    cache_read_tokens: m.cacheReadTokens,
    cache_creation_tokens: m.cacheCreationTokens,
    errors_by_route: m.errorsByRoute,
  };

  return new Response(JSON.stringify(dto), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    },
  });
}

export const handleTelemetryMetrics = withObservability(_handleTelemetryMetrics);
