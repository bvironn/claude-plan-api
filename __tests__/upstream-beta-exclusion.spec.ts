import { describe, test, expect, spyOn, beforeEach, afterEach, mock } from "bun:test";

// Mock credentials BEFORE importing modules that transitively reach it.
// buildHeaders calls getCredentials() eagerly; anthropic-client recovers 401s
// via reloadCredentialsFromSource + forceRefresh.
mock.module("../src/domain/credentials.ts", () => ({
  getCredentials: () => ({ accessToken: "test-token", refreshToken: "rt", expiresAt: Date.now() + 60_000 }),
  refreshToken: async () => {},
  reloadCredentialsFromSource: () => null,
  forceRefresh: async () => null,
  ensureValidToken: async () => {},
  CredentialsUnavailableError: class extends Error {},
}));

import {
  LONG_CONTEXT_BETAS,
  isLongContextError,
  getExcludedBetas,
  addExcludedBeta,
  getNextBetaToExclude,
  resetExcludedBetas,
} from "../src/upstream/beta-exclusion.ts";
import { buildBetas, buildHeaders } from "../src/upstream/headers.ts";
import { callAnthropic } from "../src/upstream/anthropic-client.ts";
import * as logger from "../src/observability/logger.ts";

const LONG_CTX_BODY = JSON.stringify({
  error: { type: "invalid_request_error", message: "Extra usage is required for long context requests" },
});

const LONG_CTX_BODY_RAW = "Extra usage is required for long context requests";
const LONG_CTX_BODY_ALT = "long context beta is not yet available";
const OUT_OF_EXTRA_USAGE_RAW = "You're out of extra usage";
const OUT_OF_EXTRA_USAGE_FULL =
  "You're out of extra usage. Add more at claude.ai/settings/usage and keep going.";
const OUT_OF_EXTRA_USAGE_JSON = JSON.stringify({
  error: { type: "invalid_request_error", message: OUT_OF_EXTRA_USAGE_FULL },
});

const UNRELATED_400 = JSON.stringify({ error: { type: "invalid_request_error", message: "bad shape" } });

beforeEach(() => {
  resetExcludedBetas();
});

afterEach(() => {
  resetExcludedBetas();
});

describe("beta-exclusion — REQ-1: isLongContextError detection", () => {
  test("REQ-1 returns true for known substrings (raw + JSON-wrapped)", () => {
    expect(isLongContextError(LONG_CTX_BODY_RAW)).toBe(true);
    expect(isLongContextError(LONG_CTX_BODY)).toBe(true);
    expect(isLongContextError(LONG_CTX_BODY_ALT)).toBe(true);
  });

  test("REQ-6 returns false for empty, malformed JSON, or unrelated errors", () => {
    expect(isLongContextError("")).toBe(false);
    expect(isLongContextError("{not json")).toBe(false);
    expect(isLongContextError(UNRELATED_400)).toBe(false);
  });

  test("REQ-1 detects out-of-extra-usage error (Max-subscription quota path) — raw, full sentence, JSON-wrapped", () => {
    expect(isLongContextError(OUT_OF_EXTRA_USAGE_RAW)).toBe(true);
    expect(isLongContextError(OUT_OF_EXTRA_USAGE_FULL)).toBe(true);
    expect(isLongContextError(OUT_OF_EXTRA_USAGE_JSON)).toBe(true);
  });
});

describe("beta-exclusion — REQ-11: getNextBetaToExclude ordering", () => {
  test("REQ-11 returns LONG_CONTEXT_BETAS[0] when set empty", () => {
    expect(getNextBetaToExclude("claude-opus-4-6")).toBe(LONG_CONTEXT_BETAS[0]!);
  });

  test("REQ-11 returns null when all betas excluded", () => {
    for (const b of LONG_CONTEXT_BETAS) addExcludedBeta("claude-opus-4-6", b);
    expect(getNextBetaToExclude("claude-opus-4-6")).toBeNull();
  });

  test("REQ-11 iterates in declaration order", () => {
    // if list has only one, first call returns it and second returns null
    const first = getNextBetaToExclude("claude-opus-4-6");
    expect(first).toBe(LONG_CONTEXT_BETAS[0]!);
    addExcludedBeta("claude-opus-4-6", first!);
    const second = getNextBetaToExclude("claude-opus-4-6");
    if (LONG_CONTEXT_BETAS.length > 1) {
      expect(second).toBe(LONG_CONTEXT_BETAS[1]!);
    } else {
      expect(second).toBeNull();
    }
  });
});

describe("beta-exclusion — REQ-4: exclusion persists within session", () => {
  test("REQ-4 addExcludedBeta then getExcludedBetas includes it", () => {
    addExcludedBeta("claude-opus-4-6", "context-1m-2025-08-07");
    expect(getExcludedBetas("claude-opus-4-6").has("context-1m-2025-08-07")).toBe(true);
  });
});

describe("beta-exclusion — REQ-5: per-model independence", () => {
  test("REQ-5 exclusion on one model does not appear on another", () => {
    addExcludedBeta("claude-opus-4-6", "context-1m-2025-08-07");
    expect(getExcludedBetas("claude-opus-4-7").has("context-1m-2025-08-07")).toBe(false);
  });
});

describe("headers — REQ-7: buildBetas respects excluded set", () => {
  test("REQ-7 omits excluded beta, retains others", () => {
    const before = buildBetas("claude-opus-4-6", false);
    expect(before.split(",")).toContain("interleaved-thinking-2025-05-14");

    const after = buildBetas(
      "claude-opus-4-6",
      false,
      new Set(["interleaved-thinking-2025-05-14"])
    );
    const parts = after.split(",");
    expect(parts).not.toContain("interleaved-thinking-2025-05-14");
    expect(parts).toContain("oauth-2025-04-20");
  });

  test("REQ-7 omitted/empty excluded matches pre-change output", () => {
    const base = buildBetas("claude-opus-4-6", false);
    const withEmpty = buildBetas("claude-opus-4-6", false, new Set());
    expect(withEmpty).toBe(base);
  });
});

describe("headers — structured-outputs beta", () => {
  test("structured-output path (isStructuredOutput:true) includes a structured-outputs- beta", () => {
    const betas = buildBetas("claude-sonnet-4-6", true);
    const parts = betas.split(",");
    expect(parts.some((b) => /structured-outputs-/.test(b))).toBe(true);
  });

  test("chat path matches the Claude CLI and sends no structured-outputs beta", () => {
    const betas = buildBetas("claude-sonnet-4-6", false);
    const parts = betas.split(",");
    expect(parts.some((b) => /structured-outputs-/.test(b))).toBe(false);
  });
});

// Pinned from opencode-claude-auth v2.2.1 (Claude CLI 2.1.257 intercept).
describe("headers — Claude CLI 2.1.257 beta parity", () => {
  const BASE = [
    "claude-code-20250219",
    "oauth-2025-04-20",
    "interleaved-thinking-2025-05-14",
    "prompt-caching-scope-2026-01-05",
    "context-management-2025-06-27",
    "advisor-tool-2026-03-01",
    "thinking-token-count-2026-05-13",
    "extended-cache-ttl-2025-04-11",
  ];

  test.each([
    ["claude-opus-4-7", [...BASE, "effort-2025-11-24"]],
    ["claude-opus-4-6", [...BASE, "effort-2025-11-24"]],
    ["claude-sonnet-4-6", [...BASE, "effort-2025-11-24"]],
    ["claude-opus-4-5-20251101", [...BASE, "effort-2025-11-24"]],
    ["claude-sonnet-4-5-20250929", BASE],
    ["claude-haiku-4-5-20251001", BASE],
    ["claude-opus-4-8", BASE],
    ["claude-opus-5-5", BASE],
    ["claude-fable-5-1", BASE],
  ])("%s", (model, expected) => {
    expect(buildBetas(model as string, false).split(",")).toEqual(expected as string[]);
  });

  test("context-1m is never sent", () => {
    for (const m of ["claude-opus-4-6", "claude-sonnet-4-6", "claude-opus-5-5"]) {
      expect(buildBetas(m, false)).not.toContain("context-1m");
    }
  });

  test("buildHeaders carries the SDK fingerprint headers", () => {
    const headers = buildHeaders("claude-opus-5-5");
    expect(headers["anthropic-dangerous-direct-browser-access"]).toBe("true");
    expect(headers["x-stainless-lang"]).toBe("js");
    expect(headers["x-stainless-package-version"]).toBe("0.81.0");
    expect(headers["user-agent"]).toMatch(/^claude-cli\/[\d.]+ \(external, sdk-cli\)$/);
  });
});

describe("headers — REQ-8: buildHeaders threads excluded through", () => {
  test("REQ-8 anthropic-beta header omits excluded beta", () => {
    const headers = buildHeaders("claude-opus-4-6", false, new Set(["interleaved-thinking-2025-05-14"]));
    const beta = headers["anthropic-beta"]!;
    expect(beta.split(",")).not.toContain("interleaved-thinking-2025-05-14");
  });
});

describe("callAnthropic — retry + telemetry", () => {
  test("REQ-2 400 long-context triggers exclusion, rebuilds headers, retries and succeeds", async () => {
    const fetchSpy = spyOn(globalThis, "fetch");
    let callCount = 0;
    const seenBetaHeaders: string[] = [];
    fetchSpy.mockImplementation((async (_url: string, init?: RequestInit) => {
      callCount++;
      const hdr = (init?.headers as Record<string, string>)["anthropic-beta"] || "";
      seenBetaHeaders.push(hdr);
      if (callCount === 1) {
        return new Response(LONG_CTX_BODY, { status: 400 });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch);

    try {
      const res = await callAnthropic({ model: "claude-opus-4-6" }, { model: "claude-opus-4-6", isStream: false });
      expect(res.status).toBe(200);
      expect(callCount).toBe(2);
      // First request had the beta; retry omitted it.
      expect(seenBetaHeaders[0]!.split(",")).toContain("interleaved-thinking-2025-05-14");
      expect(seenBetaHeaders[1]!.split(",")).not.toContain("interleaved-thinking-2025-05-14");
      // State recorded
      expect(getExcludedBetas("claude-opus-4-6").has("interleaved-thinking-2025-05-14")).toBe(true);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("REQ-3 when all betas pre-excluded, original 400 returned, no extra fetch", async () => {
    for (const b of LONG_CONTEXT_BETAS) addExcludedBeta("claude-opus-4-6", b);

    const fetchSpy = spyOn(globalThis, "fetch");
    let callCount = 0;
    fetchSpy.mockImplementation((async () => {
      callCount++;
      return new Response(LONG_CTX_BODY, { status: 400 });
    }) as unknown as typeof fetch);

    try {
      const res = await callAnthropic({ model: "claude-opus-4-6" }, { model: "claude-opus-4-6", isStream: false });
      expect(res.status).toBe(400);
      expect(callCount).toBe(1); // no retry fired
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("REQ-9 emits upstream.beta_excluded warn once with correct payload", async () => {
    const fetchSpy = spyOn(globalThis, "fetch");
    const emitSpy = spyOn(logger, "emit");
    let callCount = 0;
    fetchSpy.mockImplementation((async () => {
      callCount++;
      if (callCount === 1) return new Response(LONG_CTX_BODY, { status: 400 });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch);

    try {
      const res = await callAnthropic({ model: "claude-opus-4-6" }, { model: "claude-opus-4-6", isStream: false });
      expect(res.status).toBe(200);

      const exclusionCalls = emitSpy.mock.calls.filter(
        (c) => c[1] === "upstream.beta_excluded"
      );
      expect(exclusionCalls.length).toBe(1);
      const [level, event, payload] = exclusionCalls[0]!;
      expect(level).toBe("warn");
      expect(event).toBe("upstream.beta_excluded");
      expect(payload).toMatchObject({
        model: "claude-opus-4-6",
        beta: "interleaved-thinking-2025-05-14",
        attempt: 1,
        reason: "long_context",
      });
    } finally {
      fetchSpy.mockRestore();
      emitSpy.mockRestore();
    }
  });

  test("REQ-10 non-long-context 400 returned unchanged, no exclusion, no retry", async () => {
    const fetchSpy = spyOn(globalThis, "fetch");
    let callCount = 0;
    fetchSpy.mockImplementation((async () => {
      callCount++;
      return new Response(UNRELATED_400, { status: 400 });
    }) as unknown as typeof fetch);

    try {
      const res = await callAnthropic({ model: "claude-opus-4-6" }, { model: "claude-opus-4-6", isStream: false });
      expect(res.status).toBe(400);
      expect(callCount).toBe(1);
      expect(getExcludedBetas("claude-opus-4-6").size).toBe(0);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("REQ-12 429 with retry-after > MAX_RETRY_AFTER_MS surfaces immediately, no sleep, no retry", async () => {
    // Mirrors opencode-claude-auth#211: when the upstream signals a
    // quota-reset (hour-scale retry-after), the proxy must NOT block on
    // Bun.sleep() — surface the response so the caller can see the error.
    const fetchSpy = spyOn(globalThis, "fetch");
    let callCount = 0;
    fetchSpy.mockImplementation((async () => {
      callCount++;
      return new Response("quota exhausted", {
        status: 429,
        headers: { "retry-after": "3600" }, // 1 hour, far above the 30s cap
      });
    }) as unknown as typeof fetch);

    try {
      const start = Date.now();
      const res = await callAnthropic(
        { model: "claude-opus-4-6" },
        { model: "claude-opus-4-6", isStream: false }
      );
      const elapsed = Date.now() - start;
      expect(res.status).toBe(429);
      expect(callCount).toBe(1); // no retry fired
      expect(elapsed).toBeLessThan(5_000); // no hour-long sleep
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("REQ-12 429 with retry-after within cap still retries (cap engages only above threshold)", async () => {
    const fetchSpy = spyOn(globalThis, "fetch");
    let callCount = 0;
    fetchSpy.mockImplementation((async () => {
      callCount++;
      if (callCount === 1) {
        return new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "0" }, // within cap, zero-second backoff
        });
      }
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch);

    try {
      const res = await callAnthropic(
        { model: "claude-opus-4-6" },
        { model: "claude-opus-4-6", isStream: false }
      );
      expect(res.status).toBe(200);
      expect(callCount).toBe(2); // retried once
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("callAnthropic — entitlement 429 (credits_required)", () => {
  const CREDITS_BODY = JSON.stringify({
    type: "error",
    error: {
      type: "rate_limit_error",
      message: "Usage credits are required for this model.",
      details: { error_code: "credits_required", model: "claude-fable-5-1" },
    },
  });

  test("returns 403 at once without retrying", async () => {
    const fetchSpy = spyOn(globalThis, "fetch");
    let callCount = 0;
    fetchSpy.mockImplementation((async () => {
      callCount++;
      return new Response(CREDITS_BODY, { status: 429, headers: { "retry-after": "1" } });
    }) as unknown as typeof fetch);

    try {
      const res = await callAnthropic({ model: "claude-fable-5-1" }, { model: "claude-fable-5-1", isStream: false });
      expect(callCount).toBe(1);
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { message: string; type: string; code: string } };
      expect(body.error).toEqual({
        message: "Usage credits are required for this model.",
        type: "permission_error",
        code: "credits_required",
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("getEntitlementErrorCode ignores ordinary rate limits", async () => {
    const { getEntitlementErrorCode } = await import("../src/upstream/anthropic-client.ts");
    expect(getEntitlementErrorCode(CREDITS_BODY)).toBe("credits_required");
    expect(getEntitlementErrorCode(JSON.stringify({ error: { type: "rate_limit_error", message: "slow down" } }))).toBeNull();
    expect(getEntitlementErrorCode("rate limited")).toBeNull();
  });
});
