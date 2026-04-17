import { ANTHROPIC_API, MAX_RETRIES } from "../config.ts";
import { refreshToken } from "../domain/credentials.ts";
import { buildHeaders } from "./headers.ts";
import {
  LONG_CONTEXT_BETAS,
  isLongContextError,
  getExcludedBetas,
  addExcludedBeta,
  getNextBetaToExclude,
} from "./beta-exclusion.ts";
import { emit } from "../observability/logger.ts";
import { withSpan } from "../observability/tracer.ts";

export async function callAnthropic(
  anthropicBody: Record<string, unknown>,
  options: { model: string; isStream: boolean; isStructuredOutput?: boolean }
): Promise<Response> {
  const { model, isStructuredOutput = false } = options;
  let excluded = getExcludedBetas(model);
  let headers = buildHeaders(model, isStructuredOutput, excluded);

  return withSpan("upstream.anthropic.call", async () => {
    let betaExclusionAttempts = 0;

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

      // Read body via clone so the original Response stays readable if we
      // need to surface it later without re-fetching.
      const clonedForBody = res.clone();
      const errorBody = await clonedForBody.text();

      if (res.status === 401 && attempt === 0) {
        emit("warn", "upstream.anthropic.401", { attempt, model });
        await refreshToken();
        const newCreds = (await import("../domain/credentials.ts")).getCredentials();
        headers["authorization"] = `Bearer ${newCreds.accessToken}`;
        continue;
      }

      // Beta-exclusion retry: fires on 400 or 429 bodies that match the
      // long-context signature. Bounded by LONG_CONTEXT_BETAS.length and
      // placed BEFORE the generic 429/529 backoff so a long-context 429
      // drops a beta instead of burning backoff budget.
      if (
        (res.status === 400 || res.status === 429) &&
        betaExclusionAttempts < LONG_CONTEXT_BETAS.length &&
        isLongContextError(errorBody)
      ) {
        const next = getNextBetaToExclude(model);
        if (next !== null) {
          addExcludedBeta(model, next);
          betaExclusionAttempts++;
          emit("warn", "upstream.beta_excluded", {
            model,
            beta: next,
            attempt: betaExclusionAttempts,
            reason: "long_context",
          });
          excluded = getExcludedBetas(model);
          headers = buildHeaders(model, isStructuredOutput, excluded);
          continue;
        }
        // next === null: fall through to normal handling below.
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
