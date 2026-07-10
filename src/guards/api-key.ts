import { isApiKeyRequired } from "../config.ts";
import { emit } from "../observability/logger.ts";
import { getApiKeyByHash } from "../observability/storage.ts";
import { hashKey, parseKeyFromHeaders, setRequestKeyId } from "../domain/api-keys.ts";

/**
 * Pre-dispatch API-key enforcement gate (design decision #1). Called as the
 * first statement in the server's `fetch()` try-block, BEFORE any route runs
 * and before `withObservability` writes an `insertRequest` row.
 *
 * Returns a `Response` to short-circuit the request, or `null` to let it
 * proceed. Follows the `guards/anti-loop.ts` convention: pure-ish module,
 * `emit()` on the triggering (reject/forbid) paths.
 *
 * Bypass rules (return `null` without a lookup):
 *   - enforcement disabled (`REQUIRE_API_KEY !== "true"`), or
 *   - the route is not gated (`/health`, `/`, `/assets/*`, SPA fallback).
 *
 * Gated routes are `/v1/*` and `/api/*` (including telemetry). Design
 * decision #2: NOT `isApiOwned` (which also covers `/assets/` and `/health`).
 *
 * Two-tier gating by prefix:
 *   - `/v1/*` (the Anthropic↔OpenAI proxy — the product surface for teammates):
 *     ANY valid, non-revoked key passes. No privilege check.
 *   - `/api/*` (the dashboard data layer — key management, telemetry, sessions,
 *     live, metrics, which carry full prompt/response bodies): additionally
 *     requires `is_admin === 1`. A valid-but-non-admin key gets 403 Forbidden
 *     (authorization failure), NOT 401 — the key IS valid, so it must NOT be
 *     asked to re-authenticate (no `WWW-Authenticate`).
 *
 * 401 semantics are unchanged for both prefixes: missing / invalid / revoked
 * keys still `reject()` with 401 + `WWW-Authenticate: Bearer`.
 */
export function enforceApiKey(req: Request): Response | null {
  if (!isApiKeyRequired()) return null;

  const { pathname } = new URL(req.url);
  if (!isGated(pathname)) return null;

  const presented = parseKeyFromHeaders(req);
  if (!presented) return reject(pathname);

  const record = getApiKeyByHash(hashKey(presented));
  if (!record || record.id == null) return reject(pathname);

  // `/api/*` (dashboard data layer) additionally requires an admin key. `/v1/*`
  // (the proxy product surface) passes for any valid key. Authentication has
  // already succeeded here, so an insufficient privilege is 403, never 401.
  if (pathname.startsWith("/api/") && record.is_admin !== 1) {
    return forbidden(pathname);
  }

  // Valid active (and, for `/api/*`, admin) key → attribute it for
  // observability, then pass.
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

/**
 * Log the forbidden access and build the 403 response for a VALID key that
 * lacks dashboard (`is_admin`) privilege. Deliberately NOT `reject()`: there is
 * no `WWW-Authenticate` header because re-authenticating with the same valid
 * key would just 403 again — this is an authorization failure, not an
 * authentication one.
 */
function forbidden(path: string): Response {
  emit("warn", "auth.forbidden", { path });
  return new Response(
    JSON.stringify({ error: { message: "Forbidden: dashboard access requires an admin key", code: 403 } }),
    {
      status: 403,
      headers: {
        "Content-Type": "application/json",
      },
    }
  );
}
