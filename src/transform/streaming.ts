import { unmapToolName } from "../domain/tool-mapping.ts";
import { emit } from "../observability/logger.ts";
import { updateRequest } from "../observability/storage.ts";
import { currentTrace } from "../observability/tracer.ts";

const MAX_RESPONSE_BODY = 5 * 1024 * 1024; // 5 MB
const PENDING_CANCEL_TIMEOUT_MS = 30_000;

export function streamAnthropicToOpenai(anthropicStream: ReadableStream<Uint8Array>, model: string): ReadableStream {
  const decoder = new TextDecoder();
  let buffer = "";
  let msgId = `chatcmpl-${Date.now()}`;
  let usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  let toolIndex = -1;
  let sentRole = false;
  let accumulatedResponse = "";
  const stopMap: Record<string, string> = { end_turn: "stop", max_tokens: "length", stop_sequence: "stop", tool_use: "tool_calls" };
  function chunk(data: Record<string, unknown>): string {
    return `data: ${JSON.stringify(data)}\n\n`;
  }

  // Capture trace at stream creation time (AsyncLocalStorage context)
  const traceAtStart = currentTrace();

  let closed = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  // Defer-cancel state: if client cancels mid tool_use, keep consuming upstream
  // until the tool_use block closes so telemetry captures the full JSON.
  let inToolUse = false;
  let toolUseBlockIndex: number | null = null;
  let pendingCancel = false;
  let pendingCancelReason: string | null = null;
  let pendingCancelAt: number | null = null;

  const safeEnqueue = (controller: ReadableStreamDefaultController, data: string): boolean => {
    if (closed) return false;
    if (pendingCancel) return true; // client gone — silently drop but keep loop alive
    try {
      controller.enqueue(data);
      return true;
    } catch {
      closed = true;
      return false;
    }
  };

  return new ReadableStream({
    async start(controller) {
      emit("info", "stream.start", { model });
      // bun-types augments ReadableStreamDefaultReader with `readMany` but
      // `anthropicStream.getReader()` returns the node:stream/web variant.
      // Cast through unknown to bridge the two typings without a runtime shim.
      reader = anthropicStream.getReader() as unknown as ReadableStreamDefaultReader<Uint8Array>;

      // Single source of truth for per-event processing. Used by the main loop
      // AND by the end-of-stream flush block so residual bytes never diverge in
      // behavior from mid-stream parsing. Returns "break" to signal the caller
      // must exit its line loop (e.g., on safeEnqueue failure when controller
      // is already closed); "continue" otherwise.
      const processEvent = (json: string): "break" | "continue" => {
        if (!json || json === "[DONE]") return "continue";
        try {
          const event = JSON.parse(json);
          if (event.type === "message_start") {
            if (event.message?.id) msgId = event.message.id;
            if (event.message?.usage) {
              usage.input_tokens = event.message.usage.input_tokens || 0;
              usage.cache_read_input_tokens = event.message.usage.cache_read_input_tokens || 0;
              usage.cache_creation_input_tokens = event.message.usage.cache_creation_input_tokens || 0;
            }
          } else if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
            toolIndex++;
            inToolUse = true;
            toolUseBlockIndex = typeof event.index === "number" ? event.index : null;
            const name = unmapToolName(event.content_block.name);
            if (!safeEnqueue(controller, chunk({
              id: msgId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model,
              choices: [{ index: 0, delta: { ...(sentRole ? {} : { role: "assistant" }), tool_calls: [{ index: toolIndex, id: event.content_block.id, type: "function", function: { name, arguments: "" } }] }, finish_reason: null }],
            }))) return "break";
            sentRole = true;
          } else if (event.type === "content_block_stop") {
            if (toolUseBlockIndex !== null && event.index === toolUseBlockIndex) {
              inToolUse = false;
              toolUseBlockIndex = null;
            }
          } else if (event.type === "content_block_delta") {
            if (event.delta?.type === "input_json_delta" && event.delta.partial_json) {
              if (!safeEnqueue(controller, chunk({
                id: msgId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model,
                choices: [{ index: 0, delta: { tool_calls: [{ index: toolIndex, function: { arguments: event.delta.partial_json } }] }, finish_reason: null }],
              }))) return "break";
            } else if (event.delta?.text) {
              if (!safeEnqueue(controller, chunk({
                id: msgId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model,
                choices: [{ index: 0, delta: { ...(sentRole ? {} : { role: "assistant" }), content: event.delta.text }, finish_reason: null }],
              }))) return "break";
              sentRole = true;
            }
          } else if (event.type === "message_delta") {
            if (event.usage) usage.output_tokens = event.usage.output_tokens || 0;
            if (!safeEnqueue(controller, chunk({
              id: msgId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model,
              choices: [{ index: 0, delta: {}, finish_reason: stopMap[event.delta?.stop_reason] || "stop" }],
              usage: { prompt_tokens: usage.input_tokens, completion_tokens: usage.output_tokens, total_tokens: usage.input_tokens + usage.output_tokens },
            }))) return "break";
          }
        } catch {}
        return "continue";
      };

      try {
        outer: while (!closed) {
          // Timeout safeguard for deferred cancel
          if (pendingCancel && pendingCancelAt !== null && Date.now() - pendingCancelAt > PENDING_CANCEL_TIMEOUT_MS) {
            emit("info", "stream.client_disconnect_timeout", { model, reason: pendingCancelReason, inToolUse });
            closed = true;
            reader?.cancel().catch(() => {});
            break outer;
          }

          if (!reader) break;
          const { done, value } = await reader.read();
          if (done) break;
          const raw = decoder.decode(value, { stream: true });
          buffer += raw;

          // Accumulate for response_body logging
          if (accumulatedResponse.length < MAX_RESPONSE_BODY) {
            accumulatedResponse += raw;
          }

          const lines = buffer.split("\n");
          buffer = lines.pop()!;
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const json = line.slice(6).trim();
            if (processEvent(json) === "break") break outer;

            // After each event: if a deferred cancel is pending and the tool_use block just closed,
            // force-close now — we captured the full JSON for telemetry.
            if (pendingCancel && !inToolUse) {
              emit("info", "stream.client_disconnect_completed", { model, toolUseCompleted: true, reason: pendingCancelReason });
              closed = true;
              reader?.cancel().catch(() => {});
              break outer;
            }
          }
        }

        // End-of-stream flush: drain any bytes held by the TextDecoder (e.g. the
        // trailing byte of a multi-byte UTF-8 char) AND any residual line left in
        // `buffer` that the main loop intentionally retained via `lines.pop()`.
        // Without this, a terminal `message_delta` emitted by upstream without a
        // final `\n\n` is silently dropped, corrupting usage and finish_reason.
        //
        // Guarded by `!closed` so cancel / timeout / defer-force-close paths skip
        // the flush — they MUST NOT re-emit chunks after the stream has been
        // force-closed on those paths.
        if (!closed) {
          buffer += decoder.decode();
          if (buffer.length > 0) {
            const tailLines = buffer.split("\n");
            buffer = "";
            for (const line of tailLines) {
              if (!line.startsWith("data: ")) continue;
              const json = line.slice(6).trim();
              if (processEvent(json) === "break") break;
            }
          }
        }

        if (!closed) {
          safeEnqueue(controller, "data: [DONE]\n\n");
          try { controller.close(); } catch {}
        }

        emit("info", "stream.end", {
          model,
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          cacheReadTokens: usage.cache_read_input_tokens,
          cacheCreationTokens: usage.cache_creation_input_tokens,
          clientDisconnected: closed,
          pendingCancelDeferred: pendingCancel,
          toolUseWasOpen: inToolUse,
        });
      } catch (err) {
        if (closed) {
          emit("info", "stream.client_disconnect", { model, reason: (err as Error).message });
        } else {
          emit("error", "stream.error", { model, error: (err as Error).message, stack: (err as Error).stack });
          try { controller.error(err); } catch {}
        }
      } finally {
        const traceId = traceAtStart?.traceId;
        if (traceId) {
          const truncated = accumulatedResponse.slice(0, MAX_RESPONSE_BODY);
          updateRequest(traceId, {
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            cache_read_tokens: usage.cache_read_input_tokens,
            cache_creation_tokens: usage.cache_creation_input_tokens,
            response_body: truncated,
            model,
            is_stream: 1,
          });
        }
      }
    },
    async cancel(reason) {
      if (inToolUse) {
        pendingCancel = true;
        pendingCancelReason = String(reason);
        pendingCancelAt = Date.now();
        emit("info", "stream.client_disconnect_deferred", { model, reason: String(reason), inToolUse: true });
        return;
      }
      closed = true;
      emit("info", "stream.client_disconnect", { model, reason: String(reason) });
      try { await reader?.cancel(); } catch {}
    },
  });
}
