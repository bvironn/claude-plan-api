import { describe, test, expect, spyOn, beforeEach, afterEach, mock } from "bun:test";

// Mock credentials BEFORE importing modules that transitively reach it.
// buildHeaders calls getCredentials() eagerly; anthropic-client calls refreshToken + getCredentials.
mock.module("../src/domain/credentials.ts", () => ({
  getCredentials: () => ({ accessToken: "test-token", refreshToken: "rt", expiresAt: Date.now() + 60_000 }),
  refreshToken: async () => {},
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
    expect(before.split(",")).toContain("context-1m-2025-08-07");

    const after = buildBetas(
      "claude-opus-4-6",
      false,
      new Set(["context-1m-2025-08-07"])
    );
    const parts = after.split(",");
    expect(parts).not.toContain("context-1m-2025-08-07");
    expect(parts).toContain("oauth-2025-04-20");
  });

  test("REQ-7 omitted/empty excluded matches pre-change output", () => {
    const base = buildBetas("claude-opus-4-6", false);
    const withEmpty = buildBetas("claude-opus-4-6", false, new Set());
    expect(withEmpty).toBe(base);
  });
});

describe("headers — REQ-8: buildHeaders threads excluded through", () => {
  test("REQ-8 anthropic-beta header omits excluded beta", () => {
    const headers = buildHeaders("claude-opus-4-6", false, new Set(["context-1m-2025-08-07"]));
    const beta = headers["anthropic-beta"]!;
    expect(beta.split(",")).not.toContain("context-1m-2025-08-07");
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
      expect(seenBetaHeaders[0]!.split(",")).toContain("context-1m-2025-08-07");
      expect(seenBetaHeaders[1]!.split(",")).not.toContain("context-1m-2025-08-07");
      // State recorded
      expect(getExcludedBetas("claude-opus-4-6").has("context-1m-2025-08-07")).toBe(true);
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
        beta: "context-1m-2025-08-07",
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
});
