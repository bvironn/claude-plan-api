import { emit } from "../../../observability/logger.ts";
import { withObservability } from "../../../observability/middleware.ts";

const MAX_BATCH = 500;

interface RawEvent {
  timestamp?: unknown;
  level?: unknown;
  event?: unknown;
  sessionId?: unknown;
  traceId?: unknown;
  payload?: unknown;
}

function isValidEvent(e: unknown): e is Required<Pick<RawEvent, "event">> & RawEvent {
  if (!e || typeof e !== "object") return false;
  const ev = e as RawEvent;
  return typeof ev.event === "string" && ev.event.length > 0;
}

async function _handleTelemetryIngest(req: Request): Promise<Response> {
  const CORS = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: CORS });
  }

  if (!body || typeof body !== "object" || !Array.isArray((body as Record<string, unknown>).events)) {
    return new Response(JSON.stringify({ error: "Body must be { events: [...] }" }), { status: 400, headers: CORS });
  }

  const rawEvents = ((body as Record<string, unknown>).events as unknown[]).slice(0, MAX_BATCH);
  let count = 0;
  let dropped = 0;

  for (const raw of rawEvents) {
    if (!isValidEvent(raw)) {
      dropped++;
      continue;
    }

    const level = (typeof raw.level === "string" ? raw.level : "info") as Parameters<typeof emit>[0];
    const validLevels = ["trace", "debug", "info", "warn", "error", "fatal"];
    const safeLevel = validLevels.includes(level) ? level : "info" as const;

    const payload: Record<string, unknown> = {
      ...(raw.payload && typeof raw.payload === "object" ? raw.payload as Record<string, unknown> : {}),
      source: "frontend",
    };

    emit(
      safeLevel,
      raw.event as string,
      payload,
      "event",
      {
        traceId: typeof raw.traceId === "string" ? raw.traceId : undefined,
        sessionId: typeof raw.sessionId === "string" ? raw.sessionId : undefined,
        timestamp: typeof raw.timestamp === "string" ? raw.timestamp : undefined,
      }
    );

    count++;
  }

  if (dropped > 0) {
    emit("warn", "telemetry.ingest.dropped", { dropped, total: rawEvents.length });
  }

  return new Response(JSON.stringify({ ok: true, count }), { headers: CORS });
}

export const handleTelemetryIngest = withObservability(_handleTelemetryIngest);
