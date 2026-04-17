import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { handleTokensCount } from "../src/http/routes/tokens.ts";

let fetchSpy: ReturnType<typeof spyOn> | null = null;
let credentialsSpy: ReturnType<typeof spyOn> | null = null;
let ensureValidTokenSpy: ReturnType<typeof spyOn> | null = null;

beforeEach(async () => {
  const credModule = await import("../src/domain/credentials.ts");
  credentialsSpy = spyOn(credModule, "getCredentials").mockReturnValue({
    accessToken: "fake-token",
    refreshToken: "fake-refresh",
    expiresAt: Date.now() + 3_600_000,
  } as ReturnType<typeof credModule.getCredentials>);
  ensureValidTokenSpy = spyOn(credModule, "ensureValidToken").mockResolvedValue(undefined);

  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () =>
    new Response(JSON.stringify({ input_tokens: 11 }), { status: 200 }),
  );
});

afterEach(() => {
  fetchSpy?.mockRestore();
  credentialsSpy?.mockRestore();
  ensureValidTokenSpy?.mockRestore();
});

function postJSON(body: unknown): Request {
  return new Request("http://localhost/v1/tokens/count", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /v1/tokens/count", () => {
  test("returns input_tokens and resolved model for valid OpenAI body", async () => {
    const res = await handleTokensCount(postJSON({
      model: "claude-haiku-4-5-20251001",
      messages: [{ role: "user", content: "hello" }],
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as { input_tokens: number; model: string };
    expect(body.input_tokens).toBe(11);
    expect(body.model).toBe("claude-haiku-4-5-20251001");
  });

  test("resolves effort-suffix model id to base (same as /v1/chat/completions)", async () => {
    const res = await handleTokensCount(postJSON({
      model: "claude-opus-4-6:high",
      messages: [{ role: "user", content: "test" }],
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as { model: string };
    expect(body.model).toBe("claude-opus-4-6"); // suffix stripped
  });

  test("forwards to count_tokens upstream with the transformed messages", async () => {
    await handleTokensCount(postJSON({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
    }));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy!.mock.calls[0]!;
    expect(String(url)).toBe("https://api.anthropic.com/v1/messages/count_tokens?beta=true");
    const sent = JSON.parse((init as RequestInit).body as string);
    expect(sent.model).toBe("claude-sonnet-4-6");
    expect(Array.isArray(sent.messages)).toBe(true);
    expect(sent.messages.length).toBeGreaterThan(0);
    expect(Array.isArray(sent.system)).toBe(true);
    // stream field is dropped (not in the allowed-keys set)
    expect(sent.stream).toBeUndefined();
  });

  test("400 on missing body", async () => {
    const req = new Request("http://localhost/v1/tokens/count", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    const res = await handleTokensCount(req);
    expect(res.status).toBe(400);
  });

  test("400 when `messages` is missing", async () => {
    const res = await handleTokensCount(postJSON({ model: "claude-haiku-4-5-20251001" }));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { message: string } };
    expect(body.error.message).toContain("messages");
  });

  test("forwards upstream 400 as client 400", async () => {
    fetchSpy!.mockImplementationOnce(async () =>
      new Response(JSON.stringify({ error: { message: "invalid model" } }), { status: 400 }),
    );
    const res = await handleTokensCount(postJSON({
      model: "bogus",
      messages: [{ role: "user", content: "x" }],
    }));
    expect(res.status).toBe(400);
  });

  test("forwards upstream 5xx", async () => {
    fetchSpy!.mockImplementationOnce(async () => new Response("down", { status: 503 }));
    const res = await handleTokensCount(postJSON({
      model: "claude-haiku-4-5-20251001",
      messages: [{ role: "user", content: "x" }],
    }));
    expect(res.status).toBe(503);
  });

  test("projects body to the minimal surface accepted by count_tokens", async () => {
    await handleTokensCount(postJSON({
      model: "claude-sonnet-4-6",
      reasoning_effort: "high",
      max_tokens: 4096,
      messages: [{ role: "user", content: "hi" }],
    }));
    const [, init] = fetchSpy!.mock.calls[0]!;
    const sent = JSON.parse((init as RequestInit).body as string);

    // Allowed keys only: model, system, messages, optional tools/tool_choice.
    // Everything else the transform adds (metadata, stream, max_tokens,
    // output_config, thinking, context_management, temperature) is dropped.
    const allowed = new Set(["model", "system", "messages", "tools", "tool_choice"]);
    for (const k of Object.keys(sent)) {
      expect(allowed.has(k)).toBe(true);
    }
    expect(sent.model).toBe("claude-sonnet-4-6");

    // cache_control removed from every system entry
    for (const entry of sent.system ?? []) {
      expect(entry.cache_control).toBeUndefined();
    }

    // cache_control removed from every message content block
    for (const msg of sent.messages ?? []) {
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          expect(block.cache_control).toBeUndefined();
        }
      }
    }
  });
});
