// POST /v1/tokens/count
//
// OpenAI-flavored token counting. Accepts a body in the same shape as
// /v1/chat/completions and returns { input_tokens, model }. Internally we
// transform the body OpenAI → Anthropic using the exact same pipeline
// used for real chat requests, then hand it to Anthropic's
// /v1/messages/count_tokens. This guarantees the reported count reflects
// what the user would actually be charged for when sending the same body
// to /v1/chat/completions.

import { openaiToAnthropic } from "../../transform/openai-to-anthropic.ts";
import { countTokens, CountTokensError } from "../../upstream/count-tokens-client.ts";
import { emit } from "../../observability/logger.ts";

interface CountResponse {
  input_tokens: number;
  model: string;
}

export async function handleTokensCount(req: Request): Promise<Response> {
  let openaiBody: Record<string, unknown>;
  try {
    openaiBody = await req.json() as Record<string, unknown>;
  } catch {
    return Response.json({ error: { message: "Invalid JSON body" } }, { status: 400 });
  }

  if (!Array.isArray(openaiBody.messages)) {
    return Response.json(
      { error: { message: "`messages` array is required" } },
      { status: 400 },
    );
  }

  // Reuse the real transform so the count mirrors the exact messages +
  // system shape that /v1/chat/completions would produce.
  const { body: fullBody } = openaiToAnthropic(openaiBody);

  // /v1/messages/count_tokens is far stricter than /v1/messages: it rejects
  // max_tokens, context_management, output_config, thinking, stream, metadata,
  // temperature, and cache_control (anywhere inside system/messages). We
  // project down to the minimal accepted surface: model, system, messages,
  // and tools/tool_choice. Cache_control and scope are stripped in-place.
  const countBody = projectForCountTokens(fullBody);

  try {
    const { inputTokens } = await countTokens(countBody);
    const response: CountResponse = {
      input_tokens: inputTokens,
      model: countBody.model as string,
    };
    return Response.json(response);
  } catch (err) {
    if (err instanceof CountTokensError) {
      // Forward the upstream status so the client can distinguish bad
      // input (400) from transient server errors (5xx).
      emit("warn", "tokens.count.upstream_error", {
        status: err.status,
        body: err.bodyText.slice(0, 200),
      });
      return Response.json(
        { error: { message: `upstream count_tokens ${err.status}` } },
        { status: err.status >= 400 && err.status < 600 ? err.status : 502 },
      );
    }
    emit("error", "tokens.count.unhandled", { error: (err as Error).message });
    return Response.json({ error: { message: "internal error" } }, { status: 500 });
  }
}

// Keys that /v1/messages/count_tokens accepts. Everything else is silently
// dropped (sending extras triggers "Extra inputs are not permitted" 400s).
const COUNT_TOKENS_ALLOWED_KEYS = new Set([
  "model", "system", "messages", "tools", "tool_choice",
]);

/**
 * Build the minimal payload accepted by count_tokens. Deep-clones only
 * what we need: the model id, the system array (with cache_control stripped
 * from each entry), the messages array (with cache_control stripped from
 * every content block), and optional tools.
 */
function projectForCountTokens(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(body)) {
    if (!COUNT_TOKENS_ALLOWED_KEYS.has(key)) continue;
    out[key] = body[key];
  }
  if (Array.isArray(out.system)) {
    out.system = (out.system as unknown[]).map((e) => stripCacheControl(e));
  }
  if (Array.isArray(out.messages)) {
    out.messages = (out.messages as unknown[]).map((msg) => {
      if (!msg || typeof msg !== "object") return msg;
      const m = { ...(msg as Record<string, unknown>) };
      if (Array.isArray(m.content)) {
        m.content = (m.content as unknown[]).map((b) => stripCacheControl(b));
      }
      return m;
    });
  }
  return out;
}

function stripCacheControl(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const { cache_control: _drop, ...rest } = value as Record<string, unknown>;
  return rest;
}
