import { PORT } from "../config.ts";
import { handleHealth } from "./routes/health.ts";
import { handleModels } from "./routes/models.ts";
import { handleChat } from "./routes/chat.ts";
import {
  handleTelemetryLogs,
  handleTelemetryStream,
  handleTelemetryMetrics,
  handleTelemetryRequests,
  handleTelemetryRequestById,
  handleTelemetryExport,
  handleTelemetryIngest,
} from "./routes/telemetry/index.ts";
import { withObservability } from "../observability/middleware.ts";
import { emit } from "../observability/logger.ts";

const observedHealth = withObservability(() => Promise.resolve(handleHealth()));
const observedModels = withObservability(() => Promise.resolve(handleModels()));
const observedChat = withObservability(handleChat);

export function startServer() {
  return Bun.serve({
    port: PORT,
    hostname: "0.0.0.0",
    async fetch(req) {
      const url = new URL(req.url);
      const { method, pathname } = { method: req.method, pathname: url.pathname };
      if (method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
          },
        });
      }
      try {
        if (method === "GET" && pathname === "/health") return await observedHealth(req);
        if (method === "GET" && pathname === "/v1/models") return await observedModels(req);
        if (method === "POST" && pathname === "/v1/chat/completions") return await observedChat(req);

        // Telemetry API
        if (method === "POST" && pathname === "/api/telemetry") return await handleTelemetryIngest(req);
        if (method === "GET" && pathname === "/api/telemetry/logs") return await handleTelemetryLogs(req);
        if (method === "GET" && pathname === "/api/telemetry/stream") return await handleTelemetryStream(req);
        if (method === "GET" && pathname === "/api/telemetry/metrics") return await handleTelemetryMetrics(req);
        if (method === "GET" && pathname === "/api/telemetry/requests") return await handleTelemetryRequests(req);
        if (method === "GET" && pathname.startsWith("/api/telemetry/requests/")) return await handleTelemetryRequestById(req);
        if (method === "GET" && pathname === "/api/telemetry/export") return await handleTelemetryExport(req);

        emit("warn", "http.route.notFound", { method, path: pathname });
        return Response.json({ error: { message: `Not found: ${method} ${pathname}` } }, { status: 404 });
      } catch (err) {
        emit("error", "http.unhandled", {
          method,
          path: pathname,
          error: (err as Error).message,
          stack: (err as Error).stack,
        });
        return Response.json({ error: { message: (err as Error).message } }, { status: 500 });
      }
    },
  });
}
