import { ensureValidToken } from "../../domain/credentials.ts";
import { ensureAccountUuid } from "../../domain/account.ts";
import { openaiToAnthropic } from "../../transform/openai-to-anthropic.ts";
import { anthropicToOpenai } from "../../transform/anthropic-to-openai.ts";
import { streamAnthropicToOpenai } from "../../transform/streaming.ts";
import { callAnthropic } from "../../upstream/anthropic-client.ts";
import { emit } from "../../observability/logger.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CompletionsRequest {
  model: string;
  prompt: string;
  suffix?: string;
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
  stop?: string;
}

// ---------------------------------------------------------------------------
// Phase 1.2 — FIM message builder
// ---------------------------------------------------------------------------

/**
 * Build the `messages[]` array for a FIM (Fill-in-the-Middle) request.
 *
 * When `suffix` is present the user message uses the full three-token form:
 *   <|fim_prefix|>{prompt}<|fim_suffix|>{suffix}<|fim_middle|>
 *
 * When `suffix` is absent only the prefix and middle tokens are emitted:
 *   <|fim_prefix|>{prompt}<|fim_middle|>
 */
export function buildFimMessages(
  prompt: string,
  suffix?: string,
): Array<{ role: string; content: string }> {
  const fimUser =
    suffix !== undefined && suffix.length > 0
      ? `<|fim_prefix|>${prompt}<|fim_suffix|>${suffix}<|fim_middle|>`
      : `<|fim_prefix|>${prompt}<|fim_middle|>`;

  return [
    {
      role: "system",
      content:
        "Return ONLY the completion text. Do not include any explanation, introduction, or markdown code fences.",
    },
    {
      role: "user",
      content: fimUser,
    },
  ];
}

// ---------------------------------------------------------------------------
// Phase 1.3 — Response reshaper (non-streaming)
// ---------------------------------------------------------------------------

/**
 * Take the `chat.completion` shaped object returned by `anthropicToOpenai()`
 * and reshape it into the `text_completion` shape expected by OpenAI's legacy
 * completions endpoint.
 */
export function reshapeToTextCompletion(
  chatResp: Record<string, unknown>,
  model: string,
): Record<string, unknown> {
  const chatChoices = (chatResp.choices as Array<Record<string, unknown>>) ?? [];
  const firstChoice = chatChoices[0] ?? {};
  const message = (firstChoice.message as Record<string, unknown>) ?? {};
  const text = (message.content as string) ?? "";

  return {
    id: chatResp.id ?? `cmpl-${Date.now()}`,
    object: "text_completion",
    created: chatResp.created ?? Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        text,
        index: 0,
        finish_reason: firstChoice.finish_reason ?? "stop",
      },
    ],
    usage: chatResp.usage,
  };
}

// ---------------------------------------------------------------------------
// Phase 2.1 — Streaming rewriter: chat.completion.chunk → text_completion
// ---------------------------------------------------------------------------

/**
 * Rewrites each SSE chunk from `streamAnthropicToOpenai` from chat shape to
 * text_completion shape:
 *   object: "chat.completion.chunk"  →  "text_completion"
 *   choices[0].delta.content         →  choices[0].text
 *
 * SSE comment lines and `data: [DONE]` are forwarded unchanged.
 */
export function chatChunkToTextChunkStream(
  chatStream: ReadableStream,
  _model: string,
): ReadableStream {
  const encoder = new TextEncoder();
  let buffer = "";

  const rewriteLine = (line: string): string => {
    if (!line.startsWith("data: ")) return line + "\n";

    const payload = line.slice(6).trim();
    if (payload === "[DONE]") return "data: [DONE]\n\n";

    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      const choices = parsed.choices as Array<Record<string, unknown>> | undefined;

      const rewritten = {
        ...parsed,
        object: "text_completion",
        choices: (choices ?? []).map((c, i) => {
          if (i !== 0) return c;
          const delta = c.delta as Record<string, unknown> | undefined;
          const content = delta?.content ?? "";
          const { delta: _delta, ...rest } = c;
          return { ...rest, text: content };
        }),
      };

      return `data: ${JSON.stringify(rewritten)}\n\n`;
    } catch {
      return line + "\n";
    }
  };

  // streamAnthropicToOpenai enqueues strings (not Uint8Array), so we
  // transform string → string, then encode to Uint8Array for the Response body.
  return chatStream.pipeThrough(
    new TransformStream<string, Uint8Array>({
      transform(chunk, controller) {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop()!;
        for (const line of lines) {
          controller.enqueue(encoder.encode(rewriteLine(line)));
        }
      },
      flush(controller) {
        if (buffer.length > 0) {
          const lines = buffer.split("\n");
          buffer = "";
          for (const line of lines) {
            if (line.length > 0) controller.enqueue(encoder.encode(rewriteLine(line)));
          }
        }
      },
    }),
  );
}

// ---------------------------------------------------------------------------
// Phase 2.2-2.4 — Main handler
// ---------------------------------------------------------------------------

export async function handleCompletions(req: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json(
      { error: { message: "Invalid JSON body", type: "invalid_request_error" } },
      { status: 400 },
    );
  }

  // Validate required field
  if (!body.prompt || typeof body.prompt !== "string") {
    return Response.json(
      { error: { message: "prompt is required", type: "invalid_request_error" } },
      { status: 400 },
    );
  }

  const prompt = body.prompt as string;
  const suffix = typeof body.suffix === "string" ? body.suffix : undefined;
  const model = (body.model as string) || "claude-sonnet-4-6";
  const isStream = body.stream === true;

  await ensureValidToken();
  await ensureAccountUuid();

  // Build the synthesized chat body that openaiToAnthropic expects
  const chatBody: Record<string, unknown> = {
    model,
    messages: buildFimMessages(prompt, suffix),
    stream: isStream,
    clean_system: true,
  };
  if (typeof body.max_tokens === "number") chatBody.max_tokens = body.max_tokens;
  if (typeof body.temperature === "number") chatBody.temperature = body.temperature;
  if (body.stop !== undefined) chatBody.stop = body.stop;

  const { body: anthropicBody, isStructuredOutput } = openaiToAnthropic(chatBody);
  const resolvedModel = anthropicBody.model as string;

  emit("debug", "completions.request", { model: resolvedModel, isStream });

  const res = await callAnthropic(anthropicBody, {
    model: resolvedModel,
    isStream,
    isStructuredOutput,
  });

  if (!res.ok) {
    emit("error", "completions.upstream_error", { status: res.status });
    return res;
  }

  // --- Streaming path ---
  if (isStream) {
    const chatStream = streamAnthropicToOpenai(res.body!, resolvedModel);
    const textStream = chatChunkToTextChunkStream(chatStream, resolvedModel);
    return new Response(textStream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  // --- Non-streaming path ---
  const data = (await res.json()) as Record<string, unknown>;
  const chatResponse = anthropicToOpenai(data, resolvedModel);
  const textResponse = reshapeToTextCompletion(chatResponse, resolvedModel);

  return Response.json(textResponse);
}
