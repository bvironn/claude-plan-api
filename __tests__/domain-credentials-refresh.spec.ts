import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CredentialsUnavailableError,
  __setCredentialsForTests,
  ensureValidToken,
  extractOAuthError,
  getCredentials,
  parseCredentialsBlob,
  parseOAuthResponse,
  readCredentials,
  refreshIfNeeded,
  writeBackCredentials,
} from "../src/domain/credentials.ts";
import { getRefreshFailureKind, isRefreshCooldownActive, resetRefreshBackoffState } from "../src/domain/refresh-backoff.ts";
import { acquireRefreshLock } from "../src/domain/refresh-lock.ts";
import { callAnthropic } from "../src/upstream/anthropic-client.ts";

const HOUR = 3_600_000;
let dir: string;
let credPath: string;
let fetchSpy: ReturnType<typeof spyOn> | null = null;
const prevEnv = { CREDENTIALS_PATH: Bun.env.CREDENTIALS_PATH, REFRESH_LOCK_DIR: Bun.env.REFRESH_LOCK_DIR };

function writeStore(accessToken: string, refreshToken: string, expiresAt: number, extra: Record<string, unknown> = {}) {
  writeFileSync(
    credPath,
    JSON.stringify({ claudeAiOauth: { accessToken, refreshToken, expiresAt, scopes: ["user:inference"], ...extra }, mcpOAuth: { keep: true } }),
    { mode: 0o600 },
  );
}

function storedToken(): string {
  return JSON.parse(readFileSync(credPath, "utf8")).claudeAiOauth.accessToken;
}

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (url: string, init?: RequestInit) =>
    handler(String(url), init)) as unknown as typeof fetch);
  return fetchSpy;
}

function tokenResponse(access: string, refresh?: string) {
  return new Response(JSON.stringify({ access_token: access, refresh_token: refresh, expires_in: 28_800 }), { status: 200 });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "creds-"));
  credPath = join(dir, ".credentials.json");
  Bun.env.CREDENTIALS_PATH = credPath;
  Bun.env.REFRESH_LOCK_DIR = join(dir, "locks");
  resetRefreshBackoffState();
  __setCredentialsForTests(null);
});

afterEach(() => {
  fetchSpy?.mockRestore();
  fetchSpy = null;
  rmSync(dir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(prevEnv)) {
    if (v === undefined) delete Bun.env[k];
    else Bun.env[k] = v;
  }
});

describe("OAuth response / error parsing", () => {
  test("missing refresh_token keeps the current one; default expiry is 10h", () => {
    const now = 1_000_000;
    const creds = parseOAuthResponse(JSON.stringify({ access_token: "a" }), "rt-old", now)!;
    expect(creds.refreshToken).toBe("rt-old");
    expect(creds.expiresAt).toBe(now + 36_000_000);
  });

  test("a seconds-precision expires_at is ignored in favour of expires_in", () => {
    const now = Date.now();
    const creds = parseOAuthResponse(
      JSON.stringify({ access_token: "a", expires_at: Math.floor(now / 1000), expires_in: 60 }),
      "rt",
      now,
    )!;
    expect(creds.expiresAt).toBe(now + 60_000);
  });

  test("no access_token → null", () => {
    expect(parseOAuthResponse(JSON.stringify({ error: "x" }), "rt")).toBeNull();
    expect(parseOAuthResponse("not json", "rt")).toBeNull();
  });

  test("extractOAuthError reads both error shapes and ignores non-objects", () => {
    expect(extractOAuthError(JSON.stringify({ error: "invalid_grant", error_description: "dead" }))).toEqual({
      oauthError: "invalid_grant",
      oauthErrorDescription: "dead",
    });
    expect(extractOAuthError(JSON.stringify({ error: { type: "rate_limit_error", message: "slow" } }))).toEqual({
      oauthError: "rate_limit_error",
      oauthErrorDescription: "slow",
    });
    expect(extractOAuthError("null")).toEqual({});
    expect(extractOAuthError("[1]")).toEqual({});
  });

  test("parseCredentialsBlob truncates fractional expiresAt and rejects partial blobs", () => {
    const c = parseCredentialsBlob(JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "r", expiresAt: 1234.9 } }))!;
    expect(c.expiresAt).toBe(1234);
    expect(parseCredentialsBlob(JSON.stringify({ mcpOAuth: {} }))).toBeNull();
    expect(parseCredentialsBlob(JSON.stringify({ claudeAiOauth: { accessToken: "a" } }))).toBeNull();
  });
});

describe("writeBackCredentials", () => {
  test("refuses to overwrite a token rotated by someone else", () => {
    writeStore("external", "rt-x", Date.now() + HOUR);
    const ok = writeBackCredentials({ accessToken: "ours", refreshToken: "rt", expiresAt: Date.now() + HOUR }, "original");
    expect(ok).toBe(false);
    expect(storedToken()).toBe("external");
  });

  test("writes when the store still holds the expected token, preserving other fields, mode 0600", () => {
    writeStore("original", "rt", Date.now() + HOUR);
    const ok = writeBackCredentials({ accessToken: "ours", refreshToken: "rt2", expiresAt: 42 }, "original");
    expect(ok).toBe(true);
    const blob = JSON.parse(readFileSync(credPath, "utf8"));
    expect(blob.claudeAiOauth).toEqual({ accessToken: "ours", refreshToken: "rt2", expiresAt: 42, scopes: ["user:inference"] });
    expect(blob.mcpOAuth).toEqual({ keep: true });
    expect(statSync(credPath).mode & 0o777).toBe(0o600);
  });
});

describe("refreshIfNeeded", () => {
  test("adopts a token rotated externally without hitting the endpoint", async () => {
    writeStore("old", "rt", Date.now() + 30_000);
    readCredentials();
    writeStore("rotated", "rt2", Date.now() + HOUR);
    const spy = mockFetch(() => new Response("should not be called", { status: 500 }));

    const creds = await refreshIfNeeded(5 * 60_000);
    expect(creds?.accessToken).toBe("rotated");
    expect(spy).not.toHaveBeenCalled();
  });

  test("refreshes an expiring token and writes it back", async () => {
    writeStore("old", "rt", Date.now() + 30_000);
    readCredentials();
    mockFetch(() => tokenResponse("fresh", "rt-new"));

    const creds = await refreshIfNeeded(5 * 60_000);
    expect(creds?.accessToken).toBe("fresh");
    expect(storedToken()).toBe("fresh");
    expect(getCredentials().refreshToken).toBe("rt-new");
  });

  test("concurrent callers share one refresh", async () => {
    writeStore("old", "rt", Date.now() + 30_000);
    readCredentials();
    const spy = mockFetch(async () => {
      await Bun.sleep(20);
      return tokenResponse("fresh", "rt-new");
    });
    const [a, b] = await Promise.all([refreshIfNeeded(5 * 60_000), refreshIfNeeded(5 * 60_000)]);
    expect(a?.accessToken).toBe("fresh");
    expect(b?.accessToken).toBe("fresh");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test("a transient 429 keeps serving the still-usable token and sets a cooldown", async () => {
    writeStore("old", "rt", Date.now() + 3 * 60_000);
    readCredentials();
    const spy = mockFetch(() =>
      new Response(JSON.stringify({ error: { type: "rate_limit_error", message: "slow down" } }), {
        status: 429,
        headers: { "retry-after": "999" }, // above the retry cap → no in-call retry
      }),
    );

    const creds = await refreshIfNeeded(5 * 60_000);
    expect(creds?.accessToken).toBe("old");
    expect(isRefreshCooldownActive()).toBe(true);
    expect(getRefreshFailureKind()).toBe("transient");

    // Within the cooldown the endpoint is not hit again.
    await refreshIfNeeded(5 * 60_000);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test("waits out another process holding the refresh lock and adopts its token", async () => {
    writeStore("old", "rt", Date.now() + 30_000);
    readCredentials();
    const held = acquireRefreshLock(credPath)!;
    const spy = mockFetch(() => new Response("should not be called", { status: 500 }));
    setTimeout(() => writeStore("from-sibling", "rt2", Date.now() + HOUR), 100);

    const creds = await refreshIfNeeded(5 * 60_000);
    held.release();
    expect(creds?.accessToken).toBe("from-sibling");
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("ensureValidToken", () => {
  test("dead refresh token with an expired access token → 503 CredentialsUnavailableError", async () => {
    writeStore("old", "rt", Date.now() - 1000);
    readCredentials();
    mockFetch(() => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));

    const err = await ensureValidToken({ wait: true, maxWaitMs: 5_000 }).catch((e) => e);
    expect(err).toBeInstanceOf(CredentialsUnavailableError);
    expect((err as CredentialsUnavailableError).kind).toBe("terminal");
    expect((err as CredentialsUnavailableError).status).toBe(503);
  });

  test("transient failure with an expired token waits and adopts a token stored meanwhile", async () => {
    writeStore("old", "rt", Date.now() - 1000);
    readCredentials();
    mockFetch(() => new Response(JSON.stringify({ error: { type: "rate_limit_error" } }), { status: 429, headers: { "retry-after": "999" } }));
    setTimeout(() => writeStore("from-cli", "rt2", Date.now() + HOUR), 300);

    await ensureValidToken({ wait: true, maxWaitMs: 10_000 });
    expect(getCredentials().accessToken).toBe("from-cli");
  });

  test("transient failure without wait → 429 response with retry-after", async () => {
    writeStore("old", "rt", Date.now() - 1000);
    readCredentials();
    mockFetch(() => new Response("", { status: 503 }));

    const err = (await ensureValidToken().catch((e) => e)) as CredentialsUnavailableError;
    expect(err.status).toBe(429);
    const res = err.toResponse();
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("5");
  });
});

describe("callAnthropic 401 recovery", () => {
  const API = "https://api.anthropic.com/v1/messages";

  test("adopts a token rotated on disk and retries with it", async () => {
    writeStore("rejected", "rt", Date.now() + HOUR);
    readCredentials();
    writeStore("rotated", "rt2", Date.now() + HOUR);
    const seen: string[] = [];
    mockFetch((url, init) => {
      if (!url.startsWith(API)) return new Response("unexpected", { status: 500 });
      const auth = (init?.headers as Record<string, string>).authorization!;
      seen.push(auth);
      return auth === "Bearer rotated" ? new Response("{}", { status: 200 }) : new Response("unauthorized", { status: 401 });
    });

    const res = await callAnthropic({ model: "claude-opus-5-5" }, { model: "claude-opus-5-5", isStream: false });
    expect(res.status).toBe(200);
    expect(seen).toEqual(["Bearer rejected", "Bearer rotated"]);
  });

  test("forces a refresh when the store still holds the rejected token", async () => {
    writeStore("rejected", "rt", Date.now() + HOUR);
    readCredentials();
    mockFetch((url, init) => {
      if (!url.startsWith(API)) return tokenResponse("refreshed", "rt2");
      const auth = (init?.headers as Record<string, string>).authorization!;
      return auth === "Bearer refreshed" ? new Response("{}", { status: 200 }) : new Response("unauthorized", { status: 401 });
    });

    const res = await callAnthropic({ model: "claude-opus-5-5" }, { model: "claude-opus-5-5", isStream: false });
    expect(res.status).toBe(200);
    expect(storedToken()).toBe("refreshed");
  });

  test("a 401 that survives recovery is returned, not thrown", async () => {
    writeStore("rejected", "rt", Date.now() + HOUR);
    readCredentials();
    mockFetch((url) =>
      url.startsWith(API)
        ? new Response("unauthorized", { status: 401 })
        : new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
    );

    const res = await callAnthropic({ model: "claude-opus-5-5" }, { model: "claude-opus-5-5", isStream: false });
    expect(res.status).toBe(401);
  });

  test("a 429 retries once with a token rotated on disk", async () => {
    writeStore("exhausted", "rt", Date.now() + HOUR);
    readCredentials();
    writeStore("switched", "rt2", Date.now() + HOUR);
    mockFetch((_url, init) => {
      const auth = (init?.headers as Record<string, string>).authorization!;
      return auth === "Bearer switched"
        ? new Response("{}", { status: 200 })
        : new Response("rate limited", { status: 429, headers: { "retry-after": "999" } });
    });

    const res = await callAnthropic({ model: "claude-opus-5-5" }, { model: "claude-opus-5-5", isStream: false });
    expect(res.status).toBe(200);
  });
});
