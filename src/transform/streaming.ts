import { unmapToolName } from "../domain/tool-mapping.ts";
import { emit } from "../observability/logger.ts";
import { updateRequest } from "../observability/storage.ts";
import { currentTrace } from "../observability/tracer.ts";

const MAX_RESPONSE_BODY = 5 * 1024 * 1024; // 5 MB

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

  return new ReadableStream({
    async start(controller) {
      emit("info", "stream.start", { model });
      const reader = anthropicStream.getReader();
      try {
        while (true) {
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
            if (!json || json === "[DONE]") continue;
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
                const name = unmapToolName(event.content_block.name);
                controller.enqueue(chunk({
                  id: msgId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model,
                  choices: [{ index: 0, delta: { ...(sentRole ? {} : { role: "assistant" }), tool_calls: [{ index: toolIndex, id: event.content_block.id, type: "function", function: { name, arguments: "" } }] }, finish_reason: null }],
                }));
                sentRole = true;
              } else if (event.type === "content_block_delta") {
                if (event.delta?.type === "input_json_delta" && event.delta.partial_json) {
                  controller.enqueue(chunk({
                    id: msgId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model,
                    choices: [{ index: 0, delta: { tool_calls: [{ index: toolIndex, function: { arguments: event.delta.partial_json } }] }, finish_reason: null }],
                  }));
                } else if (event.delta?.text) {
                  controller.enqueue(chunk({
                    id: msgId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model,
                    choices: [{ index: 0, delta: { ...(sentRole ? {} : { role: "assistant" }), content: event.delta.text }, finish_reason: null }],
                  }));
                  sentRole = true;
                }
              } else if (event.type === "message_delta") {
                if (event.usage) usage.output_tokens = event.usage.output_tokens || 0;
                controller.enqueue(chunk({
                  id: msgId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model,
                  choices: [{ index: 0, delta: {}, finish_reason: stopMap[event.delta?.stop_reason] || "stop" }],
                  usage: { prompt_tokens: usage.input_tokens, completion_tokens: usage.output_tokens, total_tokens: usage.input_tokens + usage.output_tokens },
                }));
              }
            } catch {}
          }
        }
        controller.enqueue("data: [DONE]\n\n");
        controller.close();

        emit("info", "stream.end", {
          model,
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          cacheReadTokens: usage.cache_read_input_tokens,
          cacheCreationTokens: usage.cache_creation_input_tokens,
        });

        // Update request record with token usage + response body
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
      } catch (err) {
        emit("error", "stream.error", { model, error: (err as Error).message, stack: (err as Error).stack });
        controller.error(err);
      }
    },
  });
}
