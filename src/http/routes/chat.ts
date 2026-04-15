import { ensureValidToken } from "../../domain/credentials.ts";
import { ensureAccountUuid } from "../../domain/account.ts";
import { openaiToAnthropic } from "../../transform/openai-to-anthropic.ts";
import { anthropicToOpenai } from "../../transform/anthropic-to-openai.ts";
import { streamAnthropicToOpenai } from "../../transform/streaming.ts";
import { callAnthropic } from "../../upstream/anthropic-client.ts";
import { detectTrailingToolErrors, resetToolErrorCounter, MAX_CONSECUTIVE_TOOL_ERRORS } from "../../guards/anti-loop.ts";
import { emit } from "../../observability/logger.ts";
import { updateRequest } from "../../observability/storage.ts";
import { currentTrace } from "../../observability/tracer.ts";

export async function handleChat(req: Request): Promise<Response> {
  const body = await req.json() as Record<string, unknown>;
  const messages = (body.messages as Array<Record<string, unknown>>) || [];
  const sessionId = (messages[0]?.content as string)?.slice(0, 40) || `session-${Date.now()}`;

  const trailingErrors = detectTrailingToolErrors(messages);
  if (trailingErrors >= MAX_CONSECUTIVE_TOOL_ERRORS) {
    emit("error", "chat.loopGuard", { trailingErrors, sessionId });
    return Response.json({
      error: {
        message: `Loop detected: ${trailingErrors} consecutive invalid tool errors. Check tool mapping in proxy.`,
        type: "proxy_error",
        code: 400,
      }
    }, { status: 400 });
  }

  await ensureValidToken();
  await ensureAccountUuid();

  const { body: anthropicBody, isStructuredOutput } = openaiToAnthropic(body);
  const model = anthropicBody.model as string;
  const isStream = anthropicBody.stream as boolean;

  // Record model + stream flag on the request record early
  const trace = currentTrace();
  if (trace?.traceId) {
    updateRequest(trace.traceId, { model, is_stream: isStream ? 1 : 0 });
  }

  const res = await callAnthropic(anthropicBody, { model, isStream, isStructuredOutput });

  if (!res.ok) {
    return res;
  }

  resetToolErrorCounter(sessionId);

  if (isStream) {
    return new Response(streamAnthropicToOpenai(res.body!, model), {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
    });
  }

  const data = await res.json() as Record<string, unknown>;
  const openaiResponse = anthropicToOpenai(data, model);

  // Capture response body + token usage for non-streaming
  if (trace?.traceId) {
    const usage = data.usage as Record<string, number> | undefined;
    updateRequest(trace.traceId, {
      response_body: JSON.stringify(openaiResponse).slice(0, 5 * 1024 * 1024),
      input_tokens: usage?.input_tokens,
      output_tokens: usage?.output_tokens,
      cache_read_tokens: usage?.cache_read_input_tokens,
      cache_creation_tokens: usage?.cache_creation_input_tokens,
    });
  }

  return Response.json(openaiResponse);
}
