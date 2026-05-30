/**
 * Regression tests for:
 *   Issue #4: /v1/chat/completions returns 500 on malformed JSON instead of 400
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { handleChat } from "../src/http/routes/chat.ts";

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
