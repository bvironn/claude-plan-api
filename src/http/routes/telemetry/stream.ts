import { subscribe } from "../../../observability/event-bus.ts";
import { withObservability } from "../../../observability/middleware.ts";

async function _handleTelemetryStream(_req: Request): Promise<Response> {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(": connected\nretry: 3000\n\n"));

      const unsubscribe = subscribe((evt) => {
        try {
          controller.enqueue(
            encoder.encode(`event: telemetry\ndata: ${JSON.stringify(evt)}\n\n`)
          );
        } catch {
          // client gone — cleanup will happen on cancel
        }
      });

      const keepalive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        } catch {}
      }, 15_000);

      (controller as unknown as Record<string, unknown>)._cleanup = () => {
        unsubscribe();
        clearInterval(keepalive);
      };
    },
    cancel() {
      const self = this as unknown as Record<string, unknown>;
      (self._cleanup as (() => void) | undefined)?.();
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

export const handleTelemetryStream = withObservability(_handleTelemetryStream);
