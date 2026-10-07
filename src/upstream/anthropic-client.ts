import { ANTHROPIC_API, MAX_RETRIES, MAX_RETRY_AFTER_MS } from "../config.ts";
import { forceRefresh, getCredentials, reloadCredentialsFromSource } from "../domain/credentials.ts";
import { buildHeaders } from "./headers.ts";
import {
  LONG_CONTEXT_BETAS,
  isLongContextError,
  getExcludedBetas,
  addExcludedBeta,
  getNextBetaToExclude,
} from "./beta-exclusion.ts";
import { sleepUnlessAborted } from "./fetch-retry.ts";
import { emit } from "../observability/logger.ts";
import { withSpan } from "../observability/tracer.ts";

/**
 * Bound on 401 recovery rounds. Most cases resolve on the first: a re-read
 * picks up a token rotated externally, or a forced refresh replaces the
 * rejected one. The second covers a store rotated again mid-recovery.
 */
const MAX_AUTH_RECOVERY_ATTEMPTS = 2;

/**
 * Produce a token to retry with after `rejected` got a 401: first one rotated
 * by someone else (the `claude` CLI, another gateway process), else a forced
 * OAuth refresh. Returns null when nothing new is available. Never throws —
 * a failed recovery degrades to returning the original 401.
 */
async function recoverRejectedToken(rejected: string, model: string, attempt: number): Promise<string | null> {
  let candidate = reloadCredentialsFromSource()?.accessToken ?? null;
  if (!candidate || candidate === rejected) {
    try {
      candidate = (await forceRefresh())?.accessToken ?? null;
    } catch (err) {
      emit("warn", "upstream.auth_recovery.refresh_threw", { model, attempt, error: String(err) });
      candidate = null;
    }
  }
  if (!candidate || candidate === rejected) {
    emit("warn", "upstream.auth_recovery.exhausted", { model, attempt });
    return null;
  }
  emit("warn", "upstream.auth_recovery.retry", { model, attempt });
  return candidate;
}

/**
 * 429 `error.details.error_code` values that are entitlement denials, not
 * rate limits: the plan does not include the model (e.g. Fable on Pro
 * returns `credits_required`). Waiting cannot fix them.
 */
const NON_RETRYABLE_429_CODES = new Set(["credits_required"]);

/** The entitlement error code carried by a 429 body, or null for a real rate limit. */
export function getEntitlementErrorCode(errorBody: string): string | null {
  try {
    const code = (JSON.parse(errorBody) as { error?: { details?: { error_code?: unknown } } })?.error?.details?.error_code;
    return typeof code === "string" && NON_RETRYABLE_429_CODES.has(code) ? code : null;
  } catch {
    return null;
  }
}

/**
 * Surface an entitlement denial as 403 rather than 429: OpenAI-compatible
 * clients retry 429 automatically, which would loop on a request that can
 * never succeed with this plan.
 */
function entitlementErrorResponse(errorBody: string, code: string): Response {
  let message = "This model is not included in the current plan.";
  try {
    const m = (JSON.parse(errorBody) as { error?: { message?: unknown } })?.error?.message;
    if (typeof m === "string" && m) message = m;
  } catch {
    // keep the default
  }
  return Response.json({ error: { message, type: "permission_error", code } }, { status: 403 });
}

export async function callAnthropic(
  anthropicBody: Record<string, unknown>,
  options: {
    model: string;
    isStream: boolean;
    isStructuredOutput?: boolean;
    /**
     * Client abort signal. Only cuts short a retry backoff; it is NOT passed
     * to the upstream fetch, whose lifetime the streaming layer manages.
     */
    signal?: AbortSignal;
  }
): Promise<Response> {
  const { model, isStructuredOutput = false, signal } = options;
  let excluded = getExcludedBetas(model);
  let token = getCredentials().accessToken;
  const payload = JSON.stringify(anthropicBody);

  return withSpan("upstream.anthropic.call", async () => {
    let betaExclusionAttempts = 0;
    let authRecoveryAttempts = 0;
    let rateLimitRetries = 0;
    let rotationChecked = false;

    // Every `continue` consumes a bounded budget, so the loop terminates.
    for (let request = 0; ; request++) {
      const res = await fetch(ANTHROPIC_API, {
        method: "POST",
        headers: buildHeaders(model, isStructuredOutput, excluded, token),
        body: payload,
      });

      if (res.ok) {
        emit("info", "upstream.anthropic.response", {
          status: res.status,
          model,
          attempt: request,
          contentType: res.headers.get("content-type"),
        });
        return res;
      }

      // Read body via clone so the original Response stays readable.
      const errorBody = await res.clone().text();

      // Token rejected: adopt an externally rotated token or force a refresh.
      if (res.status === 401 && authRecoveryAttempts < MAX_AUTH_RECOVERY_ATTEMPTS) {
        authRecoveryAttempts++;
        emit("warn", "upstream.anthropic.401", { attempt: authRecoveryAttempts, model });
        const next = await recoverRejectedToken(token, model, authRecoveryAttempts);
        if (next) {
          token = next;
          continue;
        }
      }

      // Beta-exclusion retry: 400/429 bodies matching the long-context
      // signature drop a beta instead of burning backoff budget.
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
          continue;
        }
      }

      // Entitlement denial dressed as a 429: no backoff, no token rotation.
      if (res.status === 429) {
        const code = getEntitlementErrorCode(errorBody);
        if (code) {
          emit("warn", "upstream.anthropic.entitlement_denied", { model, code });
          return entitlementErrorResponse(errorBody, code);
        }
      }

      // A rate limit already resolved elsewhere (an account switch, or the
      // CLI storing a fresh token) shows up as a changed token in the store.
      // Checked once; costs one file read when nothing changed.
      if (res.status === 429 && !rotationChecked) {
        rotationChecked = true;
        const rotated = reloadCredentialsFromSource();
        if (rotated && rotated.accessToken !== token) {
          emit("warn", "upstream.rate_limit.token_changed", { model });
          token = rotated.accessToken;
          continue;
        }
      }

      if ((res.status === 429 || res.status === 529) && rateLimitRetries < MAX_RETRIES) {
        const wait = parseInt(res.headers.get("retry-after") || "") || 2 ** rateLimitRetries;
        const waitMs = wait * 1000;
        // Quota-reset retries are hour-scale; surface the response immediately
        // rather than blocking the proxy on a delay the caller can't observe.
        if (waitMs > MAX_RETRY_AFTER_MS) {
          emit("warn", "upstream.retry.cap_exceeded", {
            status: res.status,
            attempt: rateLimitRetries,
            retryAfter: wait,
            capMs: MAX_RETRY_AFTER_MS,
            model,
          });
          return res;
        }
        emit("warn", "upstream.retry", {
          status: res.status,
          attempt: rateLimitRetries,
          retryAfter: wait,
          model,
        });
        rateLimitRetries++;
        await sleepUnlessAborted(waitMs, signal);
        if (!signal?.aborted) continue;
        emit("warn", "upstream.retry.aborted", { status: res.status, model });
      }

      emit("error", "upstream.anthropic.error", {
        status: res.status,
        attempt: request,
        model,
        errorBody: errorBody.slice(0, 500),
      });
      return Response.json({ error: { message: errorBody, type: "error", code: res.status } }, { status: res.status });
    }
  }, { model });
}
