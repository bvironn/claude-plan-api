import { ensureValidToken } from "../../domain/credentials.ts";
import { ensureAccountUuid } from "../../domain/account.ts";
import { openaiToAnthropic, CapabilityMismatchError } from "../../transform/openai-to-anthropic.ts";
import { anthropicToOpenai } from "../../transform/anthropic-to-openai.ts";
import { streamAnthropicToOpenai } from "../../transform/streaming.ts";
import { callAnthropic } from "../../upstream/anthropic-client.ts";
import { detectTrailingToolErrors, resetToolErrorCounter, MAX_CONSECUTIVE_TOOL_ERRORS } from "../../guards/anti-loop.ts";
import { emit } from "../../observability/logger.ts";
import { updateRequest } from "../../observability/storage.ts";
import { currentTrace } from "../../observability/tracer.ts";

/**
 * Derive a stable, string session id from the first message's content.
 *
 * Handles three shapes:
 *   - string  → slice to 40 chars
 *   - array   → use first text block's `.text`, slice to 40 chars
 *   - other   → fall back to session-{timestamp}
 *
 * The old code was `(content as string)?.slice(0,40) || fallback`.
 * For an array value, Array.prototype.slice returns an Array — which is
 * truthy — so the `||` fallback never fired, and sessionId was an Array
 * used as a Map key (issue #6).
 */
export function extractSessionId(content: unknown): string {
  if (typeof content === "string") {
    return content.slice(0, 40);
  }
  if (Array.isArray(content)) {
    const first = content[0] as Record<string, unknown> | undefined;
    if (first && typeof first.text === "string") {
      return first.text.slice(0, 40);
    }
    return `session-${Date.now()}`;
  }
  return `session-${Date.now()}`;
}

export async function handleChat(req: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await req.json() as Record<string, unknown>;
  } catch {
    return Response.json(
      { error: { message: "Invalid JSON body", type: "invalid_request_error" } },
      { status: 400 },
    );
  }

  const messages = (body.messages as Array<Record<string, unknown>>) || [];
  const sessionId = extractSessionId(messages[0]?.content);

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

  let anthropicBody: Record<string, unknown>;
  let isStructuredOutput: boolean;
  let toolMap: ReturnType<typeof openaiToAnthropic>["toolMap"];
  try {
    ({ body: anthropicBody, isStructuredOutput, toolMap } = openaiToAnthropic(body));
  } catch (err) {
    // A confirmed-negative vision request (live registry says the model has no
    // image support) is mapped to a structured 400 proxy_error — mirroring the
    // anti-loop guard shape above. All other errors propagate unchanged.
    if (err instanceof CapabilityMismatchError) {
      emit("error", "chat.capabilityMismatch", { model: err.model, reason: err.reason });
      return Response.json({
        error: {
          message: `Model ${err.model} does not support image input.`,
          type: "proxy_error",
          code: 400,
        },
      }, { status: 400 });
    }
    throw err;
  }
  const model = anthropicBody.model as string;
  const isStream = anthropicBody.stream as boolean;

  // Record model + stream flag + post-transform upstream body on the request
  // record EARLY (before the upstream fetch). Capturing `upstream_request_body`
  // here is what lets operators verify via telemetry that fields like
  // `thinking` and `output_config` are actually being injected into the
  // Anthropic request — the incoming client `request_body` alone does not
  // show what finally went upstream.
  const trace = currentTrace();
  if (trace?.traceId) {
    updateRequest(trace.traceId, {
      model,
      is_stream: isStream ? 1 : 0,
      upstream_request_body: JSON.stringify(anthropicBody).slice(0, 5 * 1024 * 1024),
    });
  }

  const res = await callAnthropic(anthropicBody, { model, isStream, isStructuredOutput });

  if (!res.ok) {
    return res;
  }

  resetToolErrorCounter(sessionId);

  if (isStream) {
    // Encode SSE chunks to bytes BEFORE handing the stream to Bun. Bun's HTTP
    // response sink segfaults (native use-after-free in `writeLatin1`) when a
    // STRING-typed ReadableStream body is torn down on an immediate client
    // abort (Bun ≤1.3.14). Feeding pre-encoded Uint8Array chunks routes around
    // the Latin1→UTF8 sink path that crashes. `streamAnthropicToOpenai` keeps
    // emitting strings (tests + the FIM/completions transform depend on that),
    // so we encode here at the HTTP boundary.
    const enc = new TextEncoder();
    const byteStream = streamAnthropicToOpenai(res.body!, model, toolMap, req.signal).pipeThrough(
      new TransformStream<string, Uint8Array>({
        transform(chunk, controller) { controller.enqueue(enc.encode(chunk)); },
      }),
    );
    return new Response(byteStream, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
    });
  }

  const data = await res.json() as Record<string, unknown>;
  const openaiResponse = anthropicToOpenai(data, model, toolMap);

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
