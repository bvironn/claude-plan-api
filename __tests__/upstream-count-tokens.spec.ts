import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { countTokens, CountTokensError } from "../src/upstream/count-tokens-client.ts";

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

  fetchSpy = spyOn(globalThis, "fetch");
});

afterEach(() => {
  fetchSpy?.mockRestore();
  credentialsSpy?.mockRestore();
  ensureValidTokenSpy?.mockRestore();
});

describe("countTokens — happy path", () => {
  test("returns input_tokens from upstream", async () => {
    fetchSpy!.mockImplementation(async () =>
      new Response(JSON.stringify({ input_tokens: 42 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await countTokens({
      model: "claude-haiku-4-5-20251001",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(result).toEqual({ inputTokens: 42 });
  });

  test("sends OAuth beta + version headers to the correct URL", async () => {
    fetchSpy!.mockImplementation(async () =>
      new Response(JSON.stringify({ input_tokens: 7 }), { status: 200 }),
    );

    await countTokens({ model: "x", messages: [] });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy!.mock.calls[0]!;
    expect(String(url)).toBe("https://api.anthropic.com/v1/messages/count_tokens?beta=true");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["anthropic-beta"]).toBe("oauth-2025-04-20");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers.authorization).toBe("Bearer fake-token");
    expect(headers["content-type"]).toBe("application/json");
  });

  test("body is forwarded verbatim as JSON", async () => {
    fetchSpy!.mockImplementation(async () =>
      new Response(JSON.stringify({ input_tokens: 1 }), { status: 200 }),
    );

    const payload = {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hello world" }],
    };
    await countTokens(payload);

    const [, init] = fetchSpy!.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual(payload);
  });
});

describe("countTokens — error paths", () => {
  test("throws CountTokensError on non-2xx with upstream status", async () => {
    fetchSpy!.mockImplementation(async () =>
      new Response(JSON.stringify({ error: { message: "bad model" } }), { status: 400 }),
    );

    try {
      await countTokens({ model: "bogus", messages: [] });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CountTokensError);
      expect((err as CountTokensError).status).toBe(400);
      expect((err as CountTokensError).bodyText).toContain("bad model");
    }
  });

  test("throws when response is missing input_tokens", async () => {
    fetchSpy!.mockImplementation(async () =>
      new Response(JSON.stringify({ unrelated: "field" }), { status: 200 }),
    );

    try {
      await countTokens({ model: "x", messages: [] });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CountTokensError);
      expect((err as CountTokensError).status).toBe(500);
    }
  });

  test("propagates network errors", async () => {
    fetchSpy!.mockImplementation(async () => {
      throw new Error("ECONNREFUSED");
    });

    try {
      await countTokens({ model: "x", messages: [] });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as Error).message).toContain("ECONNREFUSED");
    }
  });
});
