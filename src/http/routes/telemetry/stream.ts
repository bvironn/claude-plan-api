import { subscribe } from "../../../observability/event-bus.ts";
import { withObservability } from "../../../observability/middleware.ts";

export async function _handleTelemetryStreamForTest(_req: Request): Promise<Response> {
  const encoder = new TextEncoder();

  // Hoisted so cancel() can reference them directly without relying on `this`
  let unsubscribe: (() => void) | undefined;
  let keepalive: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(": connected\nretry: 3000\n\n"));

      unsubscribe = subscribe((evt) => {
        try {
          controller.enqueue(
            encoder.encode(`event: telemetry\ndata: ${JSON.stringify(evt)}\n\n`)
          );
        } catch {
          // client gone — cleanup will happen on cancel
        }
      });

      keepalive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        } catch {}
      }, 15_000);
    },
    cancel() {
      unsubscribe?.();
      if (keepalive !== undefined) clearInterval(keepalive);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "X-Accel-Buffering": "no",
    },
  });
}

export const handleTelemetryStream = withObservability(_handleTelemetryStreamForTest);
