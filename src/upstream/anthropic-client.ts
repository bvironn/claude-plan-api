import { ANTHROPIC_API, MAX_RETRIES } from "../config.ts";
import { refreshToken } from "../domain/credentials.ts";
import { buildHeaders } from "./headers.ts";
import { emit } from "../observability/logger.ts";
import { withSpan } from "../observability/tracer.ts";

export async function callAnthropic(
  anthropicBody: Record<string, unknown>,
  options: { model: string; isStream: boolean; isStructuredOutput?: boolean }
): Promise<Response> {
  const { model, isStructuredOutput = false } = options;
  const headers = buildHeaders(model, isStructuredOutput);

  return withSpan("upstream.anthropic.call", async () => {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const res = await fetch(ANTHROPIC_API, {
        method: "POST",
        headers,
        body: JSON.stringify(anthropicBody),
      });

      if (res.ok) {
        emit("info", "upstream.anthropic.response", {
          status: res.status,
          model,
          attempt,
          contentType: res.headers.get("content-type"),
        });
        return res;
      }

      const errorBody = await res.text();

      if (res.status === 401 && attempt === 0) {
        emit("warn", "upstream.anthropic.401", { attempt, model });
        await refreshToken();
        // Rebuild headers after token refresh
        const newCreds = (await import("../domain/credentials.ts")).getCredentials();
        headers["authorization"] = `Bearer ${newCreds.accessToken}`;
        continue;
      }

      if ((res.status === 429 || res.status === 529) && attempt < MAX_RETRIES) {
        const wait = parseInt(res.headers.get("retry-after") || "") || 2 ** attempt;
        emit("warn", "upstream.retry", {
          status: res.status,
          attempt,
          retryAfter: wait,
          model,
        });
        await Bun.sleep(wait * 1000);
        continue;
      }

      emit("error", "upstream.anthropic.error", {
        status: res.status,
        attempt,
        model,
        errorBody: errorBody.slice(0, 500),
      });
      return Response.json({ error: { message: errorBody, type: "error", code: res.status } }, { status: res.status });
    }

    emit("error", "upstream.anthropic.maxRetries", { model, maxRetries: MAX_RETRIES });
    return Response.json({ error: { message: "Max retries exceeded", type: "error", code: 502 } }, { status: 502 });
  }, { model });
}
