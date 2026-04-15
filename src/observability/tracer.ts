import { AsyncLocalStorage } from "node:async_hooks";
import type { TraceContext } from "./types.ts";

const store = new AsyncLocalStorage<TraceContext>();

export function newTraceId(): string {
  return crypto.randomUUID();
}

export function runWithTrace<T>(ctx: TraceContext, fn: () => T): T {
  return store.run(ctx, fn);
}

export function currentTrace(): TraceContext | undefined {
  return store.getStore();
}

export async function withSpan<T>(
  name: string,
  fn: (ctx: TraceContext) => Promise<T>,
  attrs: Record<string, unknown> = {}
): Promise<T> {
  // Imported lazily to avoid circular deps — logger/storage import tracer
  const { emit } = await import("./logger.ts");
  const parent = currentTrace();
  const spanId = newTraceId();
  const traceId = parent?.traceId ?? newTraceId();
  const ctx: TraceContext = {
    traceId,
    spanId,
    parentSpanId: parent?.spanId ?? null,
    sessionId: parent?.sessionId ?? "",
    startedAt: Date.now(),
    attributes: { ...attrs },
  };
  const started = performance.now();
  emit("debug", `${name}.start`, { spanId, parentSpanId: ctx.parentSpanId, ...attrs });
  try {
    const result = await store.run(ctx, () => fn(ctx));
    const duration = performance.now() - started;
    emit("debug", `${name}.end`, { spanId, duration, ...attrs });
    return result;
  } catch (err) {
    const duration = performance.now() - started;
    emit("error", `${name}.error`, {
      spanId,
      duration,
      error: (err as Error).message,
      stack: (err as Error).stack,
      ...attrs,
    });
    throw err;
  }
}
