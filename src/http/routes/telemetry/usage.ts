import { getUsageByApiKey, resolveUsageTimeFrom } from "../../../observability/storage.ts";
import { withObservability } from "../../../observability/middleware.ts";

/**
 * GET /api/telemetry/usage?timeFrom&timeTo
 *
 * Aggregated per-API-key usage: request count and summed token columns grouped
 * by `api_key_id`, joined to `api_keys` for prefix/label. The optional
 * `timeFrom`/`timeTo` query params bound the window; when `timeFrom` is
 * omitted, `getUsageByApiKey()`'s storage-layer chokepoint applies a default
 * 30-day (`DEFAULT_USAGE_WINDOW_MS`) lookback window instead of aggregating
 * the full history. The response's `time_from` always reflects the ACTUAL
 * window that was applied — the caller-supplied value, or the resolved
 * default boundary — so a caller can never mistake a windowed rollup for an
 * all-time total. A window matching no rows returns an empty `keys` array
 * (not an error), mirroring `getUsageByApiKey()`'s contract.
 *
 * Wrapped with `withObservability` for parity with the other telemetry routes.
 * Since `/api/telemetry` is a SILENT_PATH_PREFIX the wrapper skips logging, but
 * the pre-dispatch `enforceApiKey` gate still protects this route when
 * `REQUIRE_API_KEY=true` (design decision #1: auth and observability are
 * orthogonal).
 */
async function _handleTelemetryUsage(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const timeFrom = url.searchParams.get("timeFrom") ?? undefined;
  const timeTo = url.searchParams.get("timeTo") ?? undefined;

  const keys = getUsageByApiKey({ timeFrom, timeTo });

  const dto = {
    generated_at: new Date().toISOString(),
    // Honest window reporting (REL-001): report the window that was ACTUALLY
    // applied, not the raw query param — when timeFrom is omitted this
    // resolves to the default lookback boundary rather than null.
    time_from: resolveUsageTimeFrom(timeFrom),
    time_to: timeTo ?? null,
    keys,
  };

  return new Response(JSON.stringify(dto), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    },
  });
}

export const handleTelemetryUsage = withObservability(_handleTelemetryUsage);
