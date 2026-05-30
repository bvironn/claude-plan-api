import { openaiToAnthropic, anthropicToOpenai } from "../../transform/openai-to-anthropic.ts";
import { streamAnthropicToOpenai } from "../../transform/streaming.ts";
import { callAnthropic } from "../../upstream/anthropic-client.ts";
import { detectTrailingToolErrors, resetToolErrorCounter } from "../../guards/anti-loop.ts";
import { emit } from "../../observability/logger.ts";

/**
 * Derive a stable session id from the first message's content. The OpenAI/Anthropic
 * content can be a plain string or an array of content blocks; `Array.prototype.slice`
 * on the array shape would yield an Array (a broken Map key), so coerce explicitly.
 */
export function extractSessionId(content: unknown): string {
  if (typeof content === "string" && content.length > 0) return content.slice(0, 40);
  if (Array.isArray(content)) {
    const first = content[0] as Record<string, unknown> | undefined;
    if (first && typeof first.text === "string" && first.text.length > 0) {
      return first.text.slice(0, 40);
    }
  }
  return `session-${Date.now()}`;
}

export async function handleChat(req: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return new Response(
      JSON.stringify({ error: { message: "Invalid JSON", type: "invalid_request_error" } }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }

  const messages = (body.messages as Array<Record<string, unknown>>) ?? [];
  const sessionId = extractSessionId(messages[0]?.content);

  const stream = body.stream === true;
  const model = (body.model as string) ?? "";

  const { body: anthropicBody, toolMap } = openaiToAnthropic(body);

  const trailing = detectTrailingToolErrors(messages, sessionId);
  if (trailing >= 3) {
    emit("warn", "chat.loopGuard", { sessionId, trailing });
    return new Response(
      JSON.stringify({ error: { message: "Loop detected: too many consecutive tool errors" } }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }

  const upstream = await callAnthropic(anthropicBody, stream, model);

  if (stream) {
    return streamAnthropicToOpenai(upstream, model, toolMap);
  }

  const data = await upstream.json() as Record<string, unknown>;
  return anthropicToOpenai(data, model, toolMap);
}
