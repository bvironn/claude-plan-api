import { isApiKeyRequired } from "../config.ts";
import { emit } from "../observability/logger.ts";
import { getApiKeyByHash } from "../observability/storage.ts";
import { hashKey, parseKeyFromHeaders, setRequestKeyId } from "../domain/api-keys.ts";

/**
 * Pre-dispatch API-key enforcement gate (design decision #1). Called as the
 * first statement in the server's `fetch()` try-block, BEFORE any route runs
 * and before `withObservability` writes an `insertRequest` row.
 *
 * Returns a 401 `Response` to short-circuit the request, or `null` to let it
 * proceed. Follows the `guards/anti-loop.ts` convention: pure-ish module,
 * `emit()` on the triggering (reject) path.
 *
 * Bypass rules (return `null` without a lookup):
 *   - enforcement disabled (`REQUIRE_API_KEY !== "true"`), or
 *   - the route is not gated (`/health`, `/`, `/assets/*`, SPA fallback).
 *
 * Gated routes are `/v1/*` and `/api/*` (including telemetry). Design
 * decision #2: NOT `isApiOwned` (which also covers `/assets/` and `/health`).
 */
export function enforceApiKey(req: Request): Response | null {
  if (!isApiKeyRequired()) return null;

  const { pathname } = new URL(req.url);
  if (!isGated(pathname)) return null;

  const presented = parseKeyFromHeaders(req);
  if (!presented) return reject(pathname);

  const record = getApiKeyByHash(hashKey(presented));
  if (!record || record.id == null) return reject(pathname);

  // Valid active key → attribute it to this request for observability, then pass.
  setRequestKeyId(req, record.id);
  return null;
}

/** A request path is gated when it targets the JSON/data API surface. */
function isGated(pathname: string): boolean {
  return pathname.startsWith("/v1/") || pathname.startsWith("/api/");
}

/** Log the rejection and build the 401 response. */
function reject(path: string): Response {
  emit("warn", "auth.rejected", { path });
  return new Response(JSON.stringify({ error: { message: "Unauthorized", code: 401 } }), {
    status: 401,
    headers: {
      "Content-Type": "application/json",
      "WWW-Authenticate": "Bearer",
    },
  });
}
