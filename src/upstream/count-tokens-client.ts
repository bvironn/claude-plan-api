// Client for Anthropic's POST /v1/messages/count_tokens endpoint.
//
// Accepts an Anthropic-shaped body and returns the upstream's token count.
// Works over OAuth with the same oauth-2025-04-20 beta the rest of the proxy
// uses. We intentionally keep the client dumb: the /v1/tokens/count route
// composes it with the OpenAI→Anthropic transform.

import { VERSION } from "../config.ts";
import { ensureValidToken, getCredentials } from "../domain/credentials.ts";
import { SESSION_ID } from "../session.ts";
import { emit } from "../observability/logger.ts";
import { withSpan } from "../observability/tracer.ts";

export interface CountTokensResult {
  inputTokens: number;
}

const COUNT_URL = "https://api.anthropic.com/v1/messages/count_tokens?beta=true";

/**
 * Call Anthropic's count_tokens endpoint with an Anthropic-shaped body.
 * Throws on non-2xx so the caller can translate into an HTTP response.
 */
export async function countTokens(anthropicBody: Record<string, unknown>): Promise<CountTokensResult> {
  return withSpan("upstream.count_tokens.fetch", async () => {
    await ensureValidToken();

    const res = await fetch(COUNT_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${getCredentials().accessToken}`,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20",
        "anthropic-dangerous-direct-browser-access": "true",
        "content-type": "application/json",
        "x-app": "cli",
        "user-agent": `claude-cli/${VERSION} (external, cli)`,
        "x-claude-code-session-id": SESSION_ID,
      },
      body: JSON.stringify(anthropicBody),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      emit("warn", "upstream.count_tokens.failed", {
        status: res.status,
        body: text.slice(0, 400),
      });
      throw new CountTokensError(res.status, text);
    }

    const json = (await res.json()) as { input_tokens?: unknown };
    if (typeof json.input_tokens !== "number") {
      throw new CountTokensError(500, "upstream returned no input_tokens");
    }
    return { inputTokens: json.input_tokens };
  });
}

export class CountTokensError extends Error {
  constructor(
    public readonly status: number,
    public readonly bodyText: string,
  ) {
    super(`count_tokens upstream error: ${status}`);
    this.name = "CountTokensError";
  }
}
