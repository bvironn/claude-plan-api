/**
 * Transient-vs-terminal classification and backoff for OAuth token refreshes.
 *
 * The token endpoint rate-limits refreshes with HTTP 429 `rate_limit_error`.
 * That is transient — the refresh token is still valid — so it must not
 * surface as a hard "re-authenticate" error, and the endpoint must not be
 * re-hit until the window has plausibly cleared. Only a genuinely dead
 * refresh token (`invalid_grant`, ...) is terminal. Ported from the upstream
 * plugin (#264).
 */

export type RefreshFailureKind = "transient" | "terminal";

/** Base cooldown after the first transient failure. */
export const BASE_COOLDOWN_MS = (() => {
  const parsed = Number.parseInt(Bun.env.REFRESH_COOLDOWN_MS ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 15_000;
})();

/** Hard ceiling for a single cooldown. */
export const MAX_COOLDOWN_MS = 60_000;

/** OAuth error codes meaning the refresh token itself is unusable. */
const TERMINAL_OAUTH_ERRORS = new Set([
  "invalid_grant",
  "invalid_client",
  "unauthorized_client",
  "unsupported_grant_type",
]);

export function classifyRefreshFailure(oauthError?: string): RefreshFailureKind {
  return oauthError && TERMINAL_OAUTH_ERRORS.has(oauthError) ? "terminal" : "transient";
}

interface BackoffOptions {
  retryAfterMs?: number;
  now?: number;
  rng?: () => number;
}

/**
 * Delay before the next refresh attempt: an explicit `retry-after` wins
 * (clamped to MAX_COOLDOWN_MS); otherwise base·2^(n-1), capped, with jitter
 * in [50%, 100%].
 */
export function computeBackoffMs(consecutive: number, opts: BackoffOptions = {}): number {
  if (opts.retryAfterMs !== undefined && opts.retryAfterMs > 0) {
    return Math.min(MAX_COOLDOWN_MS, opts.retryAfterMs);
  }
  const rng = opts.rng ?? Math.random;
  const exponent = Math.max(0, consecutive - 1);
  const scheduled = Math.min(MAX_COOLDOWN_MS, BASE_COOLDOWN_MS * 2 ** exponent);
  return Math.min(MAX_COOLDOWN_MS, Math.round(scheduled * (0.5 + rng() * 0.5)));
}

let cooldown: { until: number; consecutive: number } | null = null;
let lastFailureKind: RefreshFailureKind | null = null;

/** Record a transient failure; returns the cooldown applied. */
export function noteRefreshTransient(opts: BackoffOptions = {}): number {
  const now = opts.now ?? Date.now();
  const consecutive = (cooldown?.consecutive ?? 0) + 1;
  const ms = computeBackoffMs(consecutive, opts);
  cooldown = { until: now + ms, consecutive };
  lastFailureKind = "transient";
  return ms;
}

/** Record a terminal failure (dead refresh token). No cooldown. */
export function noteRefreshTerminal(): void {
  cooldown = null;
  lastFailureKind = "terminal";
}

/** Clear all backoff state after a successful refresh or adopt. */
export function clearRefreshOutcome(): void {
  cooldown = null;
  lastFailureKind = null;
}

export function isRefreshCooldownActive(now: number = Date.now()): boolean {
  return cooldown !== null && cooldown.until > now;
}

export function getRefreshCooldownUntil(): number | null {
  return cooldown?.until ?? null;
}

/** Last failure kind; an active cooldown always reads as transient. */
export function getRefreshFailureKind(): RefreshFailureKind | null {
  if (isRefreshCooldownActive()) return "transient";
  return lastFailureKind;
}

/** Test seam. */
export function resetRefreshBackoffState(): void {
  cooldown = null;
  lastFailureKind = null;
}
