import { emit } from "./logger.ts";
import { insertRequest, updateRequest } from "./storage.ts";
import { newTraceId, runWithTrace } from "./tracer.ts";
import { SESSION_ID } from "../session.ts";
import type { TraceContext } from "./types.ts";

const SILENT_PATH_PREFIXES = ["/api/telemetry"];

export function withObservability(
  handler: (req: Request) => Promise<Response>
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (SILENT_PATH_PREFIXES.some((p) => url.pathname === p || url.pathname.startsWith(p + "/"))) {
      return handler(req);
    }

    const traceId = newTraceId();
    const spanId = newTraceId();
    const started = performance.now();
    const ip = req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip") || "unknown";
    const userAgent = req.headers.get("user-agent") || "";

    const ctx: TraceContext = {
      traceId,
      spanId,
      parentSpanId: null,
      sessionId: SESSION_ID,
      startedAt: Date.now(),
      attributes: {},
    };

    // Clone body for logging (consuming body from clone, not original)
    let bodyText = "";
    if (["POST", "PUT", "PATCH"].includes(req.method)) {
      try { bodyText = await req.clone().text(); } catch {}
    }

    return runWithTrace(ctx, async () => {
      emit("info", "http.request.start", {
        method: req.method,
        path: url.pathname,
        query: url.search,
        ip,
        userAgent,
        body: bodyText,
      }, "http");

      insertRequest({
        trace_id: traceId,
        timestamp: new Date().toISOString(),
        method: req.method,
        path: url.pathname,
        ip,
        user_agent: userAgent,
        request_body: bodyText,
      });

      try {
        const res = await handler(req);
        const duration = performance.now() - started;

        emit("info", "http.request.end", {
          method: req.method,
          path: url.pathname,
          status: res.status,
          duration,
        }, "http");

        updateRequest(traceId, { status: res.status, duration_ms: duration });

        // Return a new Response so we can add the trace header
        const headers = new Headers(res.headers);
        headers.set("x-trace-id", traceId);
        return new Response(res.body, {
          status: res.status,
          statusText: res.statusText,
          headers,
        });
      } catch (err) {
        const duration = performance.now() - started;
        emit("error", "http.request.error", {
          method: req.method,
          path: url.pathname,
          error: (err as Error).message,
          stack: (err as Error).stack,
          duration,
        }, "http");
        updateRequest(traceId, {
          status: 500,
          duration_ms: duration,
          error: (err as Error).message,
        });
        throw err;
      }
    });
  };
}
