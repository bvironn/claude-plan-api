/**
 * Regression tests for:
 *   Issue #4: /v1/chat/completions returns 500 on malformed JSON instead of 400
 *   Issue #6: sessionId is not a string when messages[0].content is an array
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { handleChat, extractSessionId } from "../src/http/routes/chat.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(body: unknown, malformed = false): Request {
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: malformed ? "this is not json {{{{" : JSON.stringify(body),
  });
}

function anthropicOkResponse() {
  return JSON.stringify({
    id: "msg_test",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "hello" }],
    model: "claude-sonnet-4-6",
    stop_reason: "end_turn",
    usage: { input_tokens: 5, output_tokens: 3 },
  });
}

// ---------------------------------------------------------------------------
// Spies
// ---------------------------------------------------------------------------

let fetchSpy: ReturnType<typeof spyOn> | null = null;
let getCredentialsSpy: ReturnType<typeof spyOn> | null = null;
let ensureValidTokenSpy: ReturnType<typeof spyOn> | null = null;
let ensureAccountUuidSpy: ReturnType<typeof spyOn> | null = null;

beforeEach(async () => {
  const credModule = await import("../src/domain/credentials.ts");
  getCredentialsSpy = spyOn(credModule, "getCredentials").mockReturnValue({
    accessToken: "fake-token",
    refreshToken: "fake-refresh",
    expiresAt: Date.now() + 3_600_000,
  } as ReturnType<typeof credModule.getCredentials>);
  ensureValidTokenSpy = spyOn(credModule, "ensureValidToken").mockResolvedValue(undefined);

  const accountModule = await import("../src/domain/account.ts");
  ensureAccountUuidSpy = spyOn(accountModule, "ensureAccountUuid").mockResolvedValue(null);

  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () =>
    new Response(anthropicOkResponse(), { status: 200 })
  ) as unknown as typeof fetch);
});

afterEach(() => {
  fetchSpy?.mockRestore();
  getCredentialsSpy?.mockRestore();
  ensureValidTokenSpy?.mockRestore();
  ensureAccountUuidSpy?.mockRestore();
});

// ---------------------------------------------------------------------------
// Issue #4: malformed JSON -> 400, not 500
// ---------------------------------------------------------------------------

describe("POST /v1/chat/completions - malformed JSON (#4)", () => {
  test("returns 400 on malformed JSON body (not 500)", async () => {
    const res = await handleChat(makeRequest(null, /* malformed */ true));
    expect(res.status).toBe(400);
  });

  test("returns invalid_request_error type on malformed JSON", async () => {
    const res = await handleChat(makeRequest(null, true));
    const body = await res.json() as { error: { message: string; type: string } };
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toContain("Invalid JSON");
  });
});

// ---------------------------------------------------------------------------
// Issue #6: extractSessionId helper - always returns a string
// ---------------------------------------------------------------------------

describe("extractSessionId (#6)", () => {
  test("string content: slices to 40 chars", () => {
    const long = "a".repeat(80);
    expect(extractSessionId(long)).toBe("a".repeat(40));
    expect(typeof extractSessionId(long)).toBe("string");
  });

  test("string content shorter than 40: returns as-is", () => {
    expect(extractSessionId("hello")).toBe("hello");
  });

  test("array content with text block: uses first block's text", () => {
    const result = extractSessionId([{ type: "text", text: "hi from array" }]);
    expect(result).toBe("hi from array");
    expect(typeof result).toBe("string");
  });

  test("array content: slices to 40 chars", () => {
    const result = extractSessionId([{ type: "text", text: "b".repeat(80) }]);
    expect(result).toBe("b".repeat(40));
  });

  test("empty array: returns session-{timestamp} fallback string", () => {
    const result = extractSessionId([]);
    expect(typeof result).toBe("string");
    expect(result.startsWith("session-")).toBe(true);
  });

  test("array with no text field: returns session-{timestamp} fallback string", () => {
    const result = extractSessionId([{ type: "image" }]);
    expect(typeof result).toBe("string");
    expect(result.startsWith("session-")).toBe(true);
  });

  test("undefined content: returns session-{timestamp} fallback string", () => {
    const result = extractSessionId(undefined);
    expect(typeof result).toBe("string");
    expect(result.startsWith("session-")).toBe(true);
  });

  test("null content: returns session-{timestamp} fallback string", () => {
    const result = extractSessionId(null);
    expect(typeof result).toBe("string");
    expect(result.startsWith("session-")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Issue #6: handleChat with array-content messages - sessionId stays a string
// ---------------------------------------------------------------------------

describe("POST /v1/chat/completions - array message content (#6)", () => {
  test("does not throw when messages[0].content is an array", async () => {
    const res = await handleChat(makeRequest({
      model: "claude-sonnet-4-6",
      messages: [
        { role: "user", content: [{ type: "text", text: "hi from array content" }] },
      ],
    }));
    // Should succeed (not throw or return 500)
    expect(res.status).toBe(200);
  });
});
