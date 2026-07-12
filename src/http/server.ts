import { PORT, BIND_HOST } from "../config.ts";
import { handleHealth } from "./routes/health.ts";
import { handleModels } from "./routes/models.ts";
import { handleChat } from "./routes/chat.ts";
import { handleCompletions } from "./routes/completions.ts";
import { handleTokensCount } from "./routes/tokens.ts";
import { handleAccountProfile } from "./routes/account.ts";
import {
  handleTelemetryLogs,
  handleTelemetryStream,
  handleTelemetryMetrics,
  handleTelemetryRequests,
  handleTelemetryRequestById,
  handleTelemetryExport,
  handleTelemetryUsage,
} from "./routes/telemetry/index.ts";
import { handleKeysList, handleKeysCreate, handleKeysRevoke, handleKeysRename, handleKeysRotate } from "./routes/keys.ts";
import { serveStatic, serveSpaFallback } from "./static.ts";
import { withObservability } from "../observability/middleware.ts";
import { emit } from "../observability/logger.ts";
import { enforceApiKey } from "../guards/api-key.ts";
import { maybeCompress } from "./compression.ts";

// Paths whose exact match or prefix is owned by API handlers. GET requests to
// any other path fall through to the SPA (dist/index.html) so client-side
// routing works without a per-route server-side handler.
const API_PREFIXES = ["/api/", "/v1/", "/health", "/assets/"] as const;

function isApiOwned(pathname: string): boolean {
  for (const p of API_PREFIXES) {
    if (pathname === p || pathname.startsWith(p)) return true;
  }
  return false;
}

const observedHealth = withObservability(() => Promise.resolve(handleHealth()));
const observedModels = withObservability(() => Promise.resolve(handleModels()));
const observedChat = withObservability(handleChat);
const observedCompletions = withObservability(handleCompletions);
const observedTokensCount = withObservability(handleTokensCount);
const observedAccountProfile = withObservability(handleAccountProfile);

/**
 * The single request dispatcher, extracted from `Bun.serve({ fetch })` so it
 * can be driven directly by dispatch-level integration tests with real
 * `Request` objects (design decision #8). `startServer()` wires it in as
 * `{ fetch: handleRequest }`.
 */
export async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const { method, pathname } = { method: req.method, pathname: url.pathname };
  if (method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  }
  try {
    // API-key enforcement gate (design decision #1). MUST be the first statement
    // in the try-block, BEFORE any route dispatch, so a 401 short-circuits
    // before `withObservability` writes an `insertRequest` row for a rejected
    // request. Returns a 401 `Response` (reject) or `null` (pass / not gated /
    // enforcement disabled). Gated surface: `/v1/*` and `/api/*` (incl.
    // telemetry); `/health`, `/`, `/assets/*`, and the SPA fallback bypass.
    // The rejection is returned DIRECTLY (never through `maybeCompress`) so
    // compression can never run on — or bypass — an unauthenticated request.
    const denied = enforceApiKey(req);
    if (denied) return denied;

    // Single response tail gate (design decision #1): every dispatched
    // response — JSON API + static assets — flows through `maybeCompress`,
    // which negotiates br/gzip and excludes SSE / streamed exports declaratively.
    const res = await dispatch(req, method, pathname);
    return await maybeCompress(req, res);
  } catch (err) {
    emit("error", "http.unhandled", {
      method,
      path: pathname,
      error: (err as Error).message,
      stack: (err as Error).stack,
    });
    return Response.json({ error: { message: (err as Error).message } }, { status: 500 });
  }
}

/**
 * Route matching + handler invocation, extracted from `handleRequest` so the
 * single tail response can flow through `maybeCompress` (design decision #1).
 * Runs AFTER `enforceApiKey`; returns the raw (uncompressed) `Response` for the
 * matched route, or the 404 fallback. Note: `OPTIONS` and the auth rejection are
 * handled by `handleRequest` and never reach here.
 */
async function dispatch(req: Request, method: string, pathname: string): Promise<Response> {
  if (method === "GET" && pathname === "/health") return await observedHealth(req);
  if (method === "GET" && pathname === "/v1/models") return await observedModels(req);
  if (method === "POST" && pathname === "/v1/chat/completions") return await observedChat(req);
  if (method === "POST" && pathname === "/v1/completions") return await observedCompletions(req);
  if (method === "POST" && pathname === "/v1/tokens/count") return await observedTokensCount(req);
  if (method === "GET" && pathname === "/api/account/profile") return await observedAccountProfile(req);

  // Telemetry API (audit-only, GET-dominant — no client-side ingest)
  if (method === "GET" && pathname === "/api/telemetry/logs") return await handleTelemetryLogs(req);
  if (method === "GET" && pathname === "/api/telemetry/stream") return await handleTelemetryStream(req);
  if (method === "GET" && pathname === "/api/telemetry/metrics") return await handleTelemetryMetrics(req);
  if (method === "GET" && pathname === "/api/telemetry/usage") return await handleTelemetryUsage(req);
  if (method === "GET" && pathname === "/api/telemetry/requests") return await handleTelemetryRequests(req);
  if (method === "GET" && pathname.startsWith("/api/telemetry/requests/")) return await handleTelemetryRequestById(req);
  if (method === "GET" && pathname === "/api/telemetry/export") return await handleTelemetryExport(req);

  // API key administration (list/create/revoke). Under the gated `/api/`
  // prefix (inherits enforceApiKey) but NOT the telemetry SILENT prefix, so
  // create/revoke write an attributed `requests` row.
  if (method === "GET" && pathname === "/api/keys") return await handleKeysList(req);
  if (method === "POST" && pathname === "/api/keys") return await handleKeysCreate(req);
  if (method === "POST" && /^\/api\/keys\/[^/]+\/revoke$/.test(pathname)) return await handleKeysRevoke(req);
  if (method === "PATCH" && /^\/api\/keys\/[^/]+$/.test(pathname)) return await handleKeysRename(req);
  if (method === "POST" && /^\/api\/keys\/[^/]+\/rotate$/.test(pathname)) return await handleKeysRotate(req);

  // Static asset serving for the built UI. Only kicks in on GET; POST
  // and other verbs fall through to the 404 below.
  if (method === "GET") {
    // Try to serve a real static file first (index.html on /, real asset on /assets/*).
    const staticRes = await serveStatic(pathname);
    if (staticRes !== null) return staticRes;

    // SPA fallback: any GET that isn't claimed by the API prefixes
    // returns dist/index.html so TanStack Router can handle /r/:id,
    // /live, /metrics, /compare, etc. on the client.
    if (!isApiOwned(pathname)) {
      return await serveSpaFallback();
    }
  }

  emit("warn", "http.route.notFound", { method, path: pathname });
  return Response.json({ error: { message: `Not found: ${method} ${pathname}` } }, { status: 404 });
}

export function startServer() {
  return Bun.serve({
    port: PORT,
    hostname: BIND_HOST,
    fetch: handleRequest,
  });
}
