import pino from "pino";
import pinoRoll from "pino-roll";
import { mkdirSync } from "node:fs";
import { SESSION_ID } from "../session.ts";
import { publish } from "./event-bus.ts";
import { insertEvent } from "./storage.ts";
import { currentTrace } from "./tracer.ts";
import type { LogLevel, LogStream, TelemetryEvent } from "./types.ts";

mkdirSync("logs", { recursive: true });

// --- build multi-stream --------------------------------------------------

// pino-roll streams (one per file). We create them lazily at startup via
// an async IIFE so we don't block module load. The logger falls back to
// stdout-only until streams are ready (first request won't have files yet,
// but this is fine — it's < 1 second on startup).

let logger!: pino.Logger;

// Base pino options shared across all child loggers
const pinoOpts: pino.LoggerOptions = {
  level: "trace",
  timestamp: () => `,"time":"${new Date().toISOString()}"`,
  formatters: {
    level(label) { return { level: label }; },
  },
};

function attachStreamErrorGuard(stream: NodeJS.WritableStream, name: string): NodeJS.WritableStream {
  // pino-roll occasionally emits EPIPE during rotation if the old handle is
  // torn down before the new one is ready. Without a listener, those bubble
  // to process.uncaughtException and trigger an emit() cascade. Swallow them
  // and fall back to stderr so we still see something in journalctl.
  stream.on("error", (err: Error) => {
    process.stderr.write(`[logger-stream-error:${name}] ${err.message}\n`);
  });
  return stream;
}

async function buildLogger() {
  const rollOpts = { frequency: "daily" as const, size: "50m" as const, mkdir: true };
  const [appStream, errStream, httpStream, eventStream, perfStream] = await Promise.all([
    pinoRoll({ file: "logs/app.log", ...rollOpts }),
    pinoRoll({ file: "logs/error.log", ...rollOpts }),
    pinoRoll({ file: "logs/http.log", ...rollOpts }),
    pinoRoll({ file: "logs/events.log", ...rollOpts }),
    pinoRoll({ file: "logs/performance.log", ...rollOpts }),
  ]);

  attachStreamErrorGuard(appStream, "app");
  attachStreamErrorGuard(errStream, "error");
  attachStreamErrorGuard(httpStream, "http");
  attachStreamErrorGuard(eventStream, "event");
  attachStreamErrorGuard(perfStream, "perf");

  // stdout is ALWAYS in the multistream — both dev and prod. This duplicates
  // output to systemd journalctl (or whatever supervisor is running us) so
  // operators get live visibility without having to tail logs/*.log. Rolling
  // files (logs/app.log, logs/error.log) remain the canonical historical
  // store; stdout is an ephemeral live view. High-traffic deployments may
  // want to cap the journal with `journalctl --vacuum-size=...` or
  // `Storage=volatile` in systemd — that's an operator concern, not a logger
  // concern.
  const streams: pino.StreamEntry[] = [
    { level: "trace", stream: appStream },
    { level: "error", stream: errStream },
    { level: "trace", stream: process.stdout },
  ];

  logger = pino(pinoOpts, pino.multistream(streams));

  // Attach named child streams for tagged writes
  (logger as unknown as Record<string, unknown>)._httpStream = httpStream;
  (logger as unknown as Record<string, unknown>)._eventStream = eventStream;
  (logger as unknown as Record<string, unknown>)._perfStream = perfStream;
}

// Kick off stream construction — don't await at module level
const _ready = buildLogger().catch((err) => {
  // If file streams fail, fall back to stdout only
  logger = pino(pinoOpts, process.stdout);
  console.error("[observability] Failed to open log streams:", err);
});

// Fallback synchronous logger used before async streams are ready
logger = pino(pinoOpts, process.stdout);

// --- central emit function -----------------------------------------------

export interface EmitOverrides {
  traceId?: string;
  sessionId?: string;
  userSessionId?: string;
  timestamp?: string;
}

export function emit(
  level: LogLevel,
  event: string,
  payload: Record<string, unknown> = {},
  stream?: LogStream,
  overrides?: EmitOverrides
): void {
  const trace = currentTrace();
  const timestamp = overrides?.timestamp ?? new Date().toISOString();

  const telEvent: TelemetryEvent = {
    timestamp,
    level,
    traceId: overrides?.traceId ?? trace?.traceId,
    spanId: trace?.spanId,
    parentSpanId: trace?.parentSpanId ?? null,
    sessionId: overrides?.sessionId ?? trace?.sessionId ?? SESSION_ID,
    userSessionId: overrides?.userSessionId,
    event,
    stream,
    payload,
    duration: payload.duration as number | undefined,
    stack: payload.stack as string | undefined,
    httpMethod: payload.method as string | undefined,
    httpPath: payload.path as string | undefined,
    httpStatus: payload.status as number | undefined,
    ip: payload.ip as string | undefined,
    userAgent: payload.userAgent as string | undefined,
  };

  // 1. pino log
  const logPayload = {
    traceId: telEvent.traceId,
    spanId: telEvent.spanId,
    parentSpanId: telEvent.parentSpanId,
    sessionId: telEvent.sessionId,
    event,
    stream,
    payload,
  };

  try {
    logger[level]?.(logPayload);
  } catch {}

  // Write to specialised tagged streams if logger is fully initialised
  const l = logger as unknown as Record<string, unknown>;
  if (stream === "http" && l._httpStream) {
    try {
      const httpLine = JSON.stringify({ ...logPayload, time: timestamp, level }) + "\n";
      (l._httpStream as NodeJS.WritableStream).write(httpLine);
    } catch {}
  } else if (stream === "event" && l._eventStream) {
    try {
      const eventLine = JSON.stringify({ ...logPayload, time: timestamp, level }) + "\n";
      (l._eventStream as NodeJS.WritableStream).write(eventLine);
    } catch {}
  } else if (stream === "perf" && l._perfStream) {
    try {
      const perfLine = JSON.stringify({ ...logPayload, time: timestamp, level }) + "\n";
      (l._perfStream as NodeJS.WritableStream).write(perfLine);
    } catch {}
  }

  // 2. SQLite insert
  insertEvent(telEvent);

  // 3. Event bus publish
  publish(telEvent);
}

// --- convenience helpers -------------------------------------------------

export function logHttp(level: LogLevel, event: string, payload: Record<string, unknown> = {}): void {
  emit(level, event, payload, "http");
}

export function logEvent(level: LogLevel, event: string, payload: Record<string, unknown> = {}): void {
  emit(level, event, payload, "event");
}

export function logPerf(level: LogLevel, event: string, payload: Record<string, unknown> = {}): void {
  emit(level, event, payload, "perf");
}

export function logError(event: string, err: Error, payload: Record<string, unknown> = {}): void {
  emit("error", event, { ...payload, error: err.message, stack: err.stack });
}

export { logger };
