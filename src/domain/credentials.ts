import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { Credentials } from "../types.ts";
import { getCredentialsPath, REFRESH_URL, CLIENT_ID, REFRESH_MARGIN_MS } from "../config.ts";
import { emit } from "../observability/logger.ts";
import { withSpan } from "../observability/tracer.ts";
import { fetchWithRetry, parseRetryAfterMs, sleepUnlessAborted } from "../upstream/fetch-retry.ts";
import {
  classifyRefreshFailure,
  clearRefreshOutcome,
  getRefreshCooldownUntil,
  getRefreshFailureKind,
  isRefreshCooldownActive,
  noteRefreshTerminal,
  noteRefreshTransient,
  type RefreshFailureKind,
} from "./refresh-backoff.ts";
import { acquireRefreshLock } from "./refresh-lock.ts";

/**
 * OAuth credential lifecycle for the single Claude Code account whose
 * `.credentials.json` this gateway serves from.
 *
 * The file is shared: the `claude` CLI and other gateway processes may
 * refresh it at any time, and refresh tokens rotate (a used one is dead).
 * So every decision re-reads the file first and adopts a usable token written
 * by someone else, writes back with a compare-and-swap, and treats rate
 * limits on the token endpoint as transient. Ported from the upstream plugin
 * (#246, #248, #252, #260, #264).
 */

/** A token closer than this to expiry is not worth sending. */
const USABLE_MARGIN_MS = 60_000;
const OAUTH_TIMEOUT_MS = 15_000;

let credentials: Credentials | null = null;
let refreshPromise: Promise<Credentials | null> | null = null;

/** Raised when no usable token can be produced for a request. */
export class CredentialsUnavailableError extends Error {
  constructor(readonly kind: RefreshFailureKind | null) {
    super(
      kind === "transient"
        ? "OAuth token refresh is rate-limited; retry shortly."
        : "Claude Code credentials are unavailable or expired. Run `claude` on the gateway host to re-authenticate.",
    );
    this.name = "CredentialsUnavailableError";
  }

  /**
   * 429 for a transient refresh rate limit (clients back off and retry); 503
   * for a dead refresh token — never 401, which clients would read as "your
   * gateway API key is wrong".
   */
  get status(): number {
    return this.kind === "transient" ? 429 : 503;
  }

  toResponse(): Response {
    return Response.json(
      { error: { message: this.message, type: this.kind === "transient" ? "rate_limit_error" : "credentials_unavailable", code: this.status } },
      { status: this.status, headers: this.kind === "transient" ? { "retry-after": "5" } : undefined },
    );
  }
}

function usable(c: Credentials | null, marginMs = USABLE_MARGIN_MS): c is Credentials {
  return c !== null && c.accessToken.trim().length > 0 && c.expiresAt > Date.now() + marginMs;
}

/** Short non-reversible tag so logs can correlate tokens without leaking them. */
function fingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 8);
}

/**
 * Parse a `.credentials.json` blob. Returns null for anything that is not a
 * complete OAuth credential. Fractional `expiresAt` values are truncated.
 */
export function parseCredentialsBlob(raw: string): Credentials | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const oauth = (parsed as { claudeAiOauth?: Record<string, unknown> } | null)?.claudeAiOauth;
  if (!oauth || typeof oauth !== "object") return null;
  const { accessToken, refreshToken, expiresAt } = oauth;
  if (typeof accessToken !== "string" || typeof refreshToken !== "string" || typeof expiresAt !== "number") {
    return null;
  }
  if (!Number.isFinite(expiresAt)) return null;
  return { ...(oauth as object), accessToken, refreshToken, expiresAt: Math.trunc(expiresAt) } as Credentials;
}

/** Read the store without touching in-memory state. Never throws. */
export function readStoredCredentials(): Credentials | null {
  try {
    return parseCredentialsBlob(readFileSync(getCredentialsPath(), "utf8"));
  } catch {
    return null;
  }
}

export function getCredentials(): Credentials {
  if (!credentials) throw new Error("Credentials not loaded");
  return credentials;
}

/** Load credentials from disk into memory. Throws when the file is unusable (boot). */
export function readCredentials(): Credentials {
  const path = getCredentialsPath();
  const stored = parseCredentialsBlob(readFileSync(path, "utf8"));
  if (!stored) throw new Error(`No valid claudeAiOauth credentials in ${path}`);
  credentials = stored;
  emit("debug", "credentials.read", { path });
  return stored;
}

/**
 * Persist refreshed credentials, but only if the store still holds the token
 * we refreshed from. Otherwise someone else (the CLI, another process) has
 * rotated it meanwhile and overwriting would clobber a newer token. Unrelated
 * fields in the file are preserved; the write is atomic and mode 0600.
 */
export function writeBackCredentials(next: Credentials, expectedPriorAccessToken?: string): boolean {
  const path = getCredentialsPath();
  try {
    const raw = readFileSync(path, "utf8");
    if (expectedPriorAccessToken !== undefined) {
      const stored = parseCredentialsBlob(raw);
      if (stored?.accessToken !== expectedPriorAccessToken) {
        emit("warn", stored ? "credentials.writeback.skippedStale" : "credentials.writeback.skippedUnparseable", {
          expected: fingerprint(expectedPriorAccessToken),
          stored: stored ? fingerprint(stored.accessToken) : null,
        });
        return false;
      }
    }
    const blob = JSON.parse(raw) as Record<string, unknown>;
    blob.claudeAiOauth = {
      ...((blob.claudeAiOauth as object | undefined) ?? {}),
      accessToken: next.accessToken,
      refreshToken: next.refreshToken,
      expiresAt: next.expiresAt,
    };
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(blob, null, 2), { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, path);
    emit("debug", "credentials.written", { expiresAt: next.expiresAt });
    return true;
  } catch (err) {
    emit("error", "credentials.writeback.failed", { error: String(err) });
    return false;
  }
}

// ---------------------------------------------------------------------------
// OAuth token endpoint
// ---------------------------------------------------------------------------

/**
 * Turn a token-endpoint success body into credentials. A missing
 * `refresh_token` keeps the current one; an absolute `expires_at` (ms) is used
 * only when it lies in the future, else `expires_in` (default 10h).
 */
export function parseOAuthResponse(raw: string, currentRefreshToken: string, now = Date.now()): Credentials | null {
  let data: { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; expires_at?: unknown };
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data?.access_token !== "string" || data.access_token.length === 0) return null;
  const expiresIn = typeof data.expires_in === "number" ? data.expires_in : 36_000;
  const expiresAt =
    typeof data.expires_at === "number" && data.expires_at > now
      ? Math.trunc(data.expires_at)
      : Math.trunc(now + expiresIn * 1000);
  return {
    accessToken: data.access_token,
    refreshToken: typeof data.refresh_token === "string" && data.refresh_token ? data.refresh_token : currentRefreshToken,
    expiresAt,
  };
}

/**
 * Non-secret failure reason from a token-endpoint error body. Handles the
 * OAuth shape (`{ error, error_description }`) and the API envelope
 * (`{ error: { type, message } }`).
 */
export function extractOAuthError(raw: string): { oauthError?: string; oauthErrorDescription?: string } {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return {};
  const d = data as { error?: unknown; error_description?: unknown };
  const out: { oauthError?: string; oauthErrorDescription?: string } = {};
  if (typeof d.error === "string") {
    out.oauthError = d.error.slice(0, 200);
  } else if (d.error && typeof d.error === "object") {
    const nested = d.error as { type?: unknown; message?: unknown };
    if (typeof nested.type === "string") out.oauthError = nested.type.slice(0, 200);
    if (typeof nested.message === "string") out.oauthErrorDescription = nested.message.slice(0, 500);
  }
  if (typeof d.error_description === "string") out.oauthErrorDescription = d.error_description.slice(0, 500);
  return out;
}

export type RefreshOutcome =
  | { kind: "ok"; creds: Credentials }
  | { kind: "transient"; status: number; oauthError?: string; retryAfterMs?: number }
  | { kind: "terminal"; status: number; oauthError?: string };

/** Exchange a refresh token and classify the result. Never throws. */
export async function refreshViaOAuth(refreshToken: string, timeoutMs = OAUTH_TIMEOUT_MS): Promise<RefreshOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchWithRetry(REFRESH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: CLIENT_ID }).toString(),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = extractOAuthError(await res.text().catch(() => ""));
      const kind = classifyRefreshFailure(detail.oauthError);
      emit("error", "credentials.refresh.failed", { status: res.status, kind, ...detail });
      return kind === "terminal"
        ? { kind, status: res.status, oauthError: detail.oauthError }
        : { kind, status: res.status, oauthError: detail.oauthError, retryAfterMs: parseRetryAfterMs(res.headers.get("retry-after")) };
    }
    const creds = parseOAuthResponse(await res.text(), refreshToken);
    if (!creds) {
      // A 200 we cannot parse is an endpoint hiccup, not a dead token.
      emit("error", "credentials.refresh.failed", { status: res.status, kind: "transient", error: "no access_token in response" });
      return { kind: "transient", status: res.status };
    }
    return { kind: "ok", creds };
  } catch (err) {
    emit("error", "credentials.refresh.failed", { status: 0, kind: "transient", error: String(err) });
    return { kind: "transient", status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Refresh orchestration
// ---------------------------------------------------------------------------

/** Adopt a token another writer stored, if it differs from `rejected` and is usable. */
function adoptFromStore(rejectedAccessToken?: string): Credentials | null {
  const stored = readStoredCredentials();
  if (usable(stored) && stored.accessToken !== rejectedAccessToken) {
    credentials = stored;
    clearRefreshOutcome();
    emit("info", "credentials.adopted", { token: fingerprint(stored.accessToken) });
    return stored;
  }
  return null;
}

const LOCK_ADOPT_WAIT_MS = 5_000;
const LOCK_ADOPT_POLL_MS = 250;

async function waitForAdopt(rejectedAccessToken: string): Promise<Credentials | null> {
  const deadline = Date.now() + LOCK_ADOPT_WAIT_MS;
  for (;;) {
    const adopted = adoptFromStore(rejectedAccessToken);
    if (adopted) return adopted;
    if (Date.now() >= deadline) return null;
    await Bun.sleep(LOCK_ADOPT_POLL_MS);
  }
}

async function performRefresh(current: Credentials, force: boolean): Promise<Credentials | null> {
  return withSpan("credentials.refresh", async () => {
    emit("info", "credentials.expired", { expiresAt: current.expiresAt, force });
    const outcome = await refreshViaOAuth(current.refreshToken);

    if (outcome.kind === "ok" && usable(outcome.creds)) {
      clearRefreshOutcome();
      credentials = outcome.creds;
      // Memory stays authoritative even if the write is refused.
      writeBackCredentials(outcome.creds, current.accessToken);
      emit("info", "credentials.refresh.success", {});
      return outcome.creds;
    }

    if (outcome.kind === "terminal") {
      noteRefreshTerminal();
    } else {
      const cooldownMs = noteRefreshTransient({
        retryAfterMs: outcome.kind === "transient" ? outcome.retryAfterMs : undefined,
      });
      emit("warn", "credentials.refresh.transient", {
        status: outcome.kind === "transient" ? outcome.status : 200,
        cooldownMs,
      });
    }

    // Another writer may have rotated the token during the round trip —
    // which is also the usual reason our refresh token was rejected.
    const adopted = adoptFromStore(current.accessToken);
    if (adopted) return adopted;
    // Keep serving a still-usable token (proactive path, or forced on 401).
    if (!force && usable(current)) return current;
    return null;
  });
}

/**
 * Return credentials valid for at least `thresholdMs`, refreshing if needed.
 * Returns null (never throws) when no usable token can be produced; consult
 * `getRefreshFailureKind()` to tell a rate limit from a dead refresh token.
 *
 * `force` refreshes even a token that looks valid locally (the API just
 * rejected it with a 401).
 */
export async function refreshIfNeeded(
  thresholdMs = USABLE_MARGIN_MS,
  { force = false }: { force?: boolean } = {},
): Promise<Credentials | null> {
  // Pick up a token rotated externally. Adopt a usable stored token always;
  // an unusable one only when ours is unusable too, so a failed write-back
  // never resurrects the pre-refresh token.
  const stored = readStoredCredentials();
  if (stored && (!credentials || usable(stored) || !usable(credentials))) credentials = stored;
  if (!credentials) return null;

  const current = credentials;
  if (!force && usable(current, thresholdMs)) return current;

  // A recent refresh was rate-limited: don't re-hit the endpoint until the
  // cooldown clears. Serve what we have if it still works.
  if (isRefreshCooldownActive()) {
    const adopted = adoptFromStore(current.accessToken);
    if (adopted) return adopted;
    emit("warn", "credentials.refresh.cooldownSkip", { until: getRefreshCooldownUntil() });
    return !force && usable(current) ? current : null;
  }

  // In-process single-flight: a rotation kills the refresh token the other
  // caller would use.
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    const lock = acquireRefreshLock(getCredentialsPath());
    if (!lock) {
      // Another gateway process is refreshing; adopt what it writes.
      emit("info", "credentials.lock.busy", {});
      return (await waitForAdopt(current.accessToken)) ?? (!force && usable(current) ? current : null);
    }
    try {
      return await performRefresh(current, force);
    } finally {
      lock.release();
    }
  })().finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}

const REFRESH_WAIT_MS = (() => {
  const parsed = Number.parseInt(Bun.env.REFRESH_WAIT_MS ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 45_000;
})();
const REFRESH_POLL_MS = 2_500;

export interface EnsureOptions {
  /**
   * Request path: wait (bounded by REFRESH_WAIT_MS, abort-aware) through a
   * transient refresh rate limit — for this process's cooldown to clear or
   * for another writer to store a fresh token — instead of failing at once.
   */
  wait?: boolean;
  signal?: AbortSignal;
  maxWaitMs?: number;
}

/**
 * Ensure a token valid for REFRESH_MARGIN_MS when possible. Keeps serving a
 * still-usable token through a transient refresh failure; throws
 * CredentialsUnavailableError only when nothing usable is left.
 */
export async function ensureValidToken(opts: EnsureOptions = {}): Promise<void> {
  if (usable(await refreshIfNeeded(REFRESH_MARGIN_MS))) return;

  if (opts.wait && getRefreshFailureKind() !== "terminal") {
    const maxWaitMs = opts.maxWaitMs ?? REFRESH_WAIT_MS;
    const deadline = Date.now() + maxWaitMs;
    emit("warn", "credentials.wait", { maxWaitMs });
    while (Date.now() < deadline && !opts.signal?.aborted) {
      // Jittered so concurrent waiters desynchronize their re-reads.
      await sleepUnlessAborted(Math.round(REFRESH_POLL_MS * (0.5 + Math.random() * 0.5)), opts.signal);
      if (usable(await refreshIfNeeded(REFRESH_MARGIN_MS))) return;
      if (getRefreshFailureKind() === "terminal") break;
    }
  }
  throw new CredentialsUnavailableError(getRefreshFailureKind());
}

/** Back-compat: refresh now regardless of expiry. Throws when it cannot. */
export async function refreshToken(): Promise<void> {
  const creds = await refreshIfNeeded(USABLE_MARGIN_MS, { force: true });
  if (!creds) throw new CredentialsUnavailableError(getRefreshFailureKind());
}

/**
 * Re-read the store and adopt it when it holds a usable token. Used on 401 /
 * 429 to pick up a token rotated by someone else. Never throws.
 */
export function reloadCredentialsFromSource(): Credentials | null {
  const stored = readStoredCredentials();
  if (!usable(stored)) return null;
  credentials = stored;
  return stored;
}

/** OAuth refresh even though the token looks valid locally (it was just rejected). */
export async function forceRefresh(): Promise<Credentials | null> {
  return refreshIfNeeded(USABLE_MARGIN_MS, { force: true });
}

/** Test seam. */
export function __setCredentialsForTests(c: Credentials | null): void {
  credentials = c;
  refreshPromise = null;
}
