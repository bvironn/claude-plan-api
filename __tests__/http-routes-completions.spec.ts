import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { handleCompletions } from "../src/http/routes/completions.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function postJSON(body: unknown): Request {
  return new Request("http://localhost/v1/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Build a minimal Anthropic-style JSON response for non-streaming mocks */
function anthropicOkResponse(text = "a + b") {
  return JSON.stringify({
    id: "msg_test123",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text }],
    model: "claude-sonnet-4-6",
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 5 },
  });
}

/** Build a minimal SSE stream that emits one text delta then terminates */
function anthropicStreamResponse(text = "completion"): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const events = [
    `data: ${JSON.stringify({ type: "message_start", message: { id: "msg_stream1", usage: { input_tokens: 10 } } })}\n\n`,
    `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
    `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}\n\n`,
    `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } })}\n\n`,
    `data: [DONE]\n\n`,
  ];

  return new ReadableStream({
    start(controller) {
      for (const ev of events) {
        controller.enqueue(encoder.encode(ev));
      }
      controller.close();
    },
  });
}

// ---------------------------------------------------------------------------
// Spies
// ---------------------------------------------------------------------------

let fetchSpy: ReturnType<typeof spyOn> | null = null;
let credentialsSpy: ReturnType<typeof spyOn> | null = null;
let ensureValidTokenSpy: ReturnType<typeof spyOn> | null = null;
let ensureAccountUuidSpy: ReturnType<typeof spyOn> | null = null;

beforeEach(async () => {
  const credModule = await import("../src/domain/credentials.ts");
  credentialsSpy = spyOn(credModule, "getCredentials").mockReturnValue({
    accessToken: "fake-token",
    refreshToken: "fake-refresh",
    expiresAt: Date.now() + 3_600_000,
  } as ReturnType<typeof credModule.getCredentials>);
  ensureValidTokenSpy = spyOn(credModule, "ensureValidToken").mockResolvedValue(undefined);

  const accountModule = await import("../src/domain/account.ts");
  ensureAccountUuidSpy = spyOn(accountModule, "ensureAccountUuid").mockResolvedValue(null);

  // Default: non-streaming success
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () =>
    new Response(anthropicOkResponse(), { status: 200 })
  ) as unknown as typeof fetch);
});

afterEach(() => {
  fetchSpy?.mockRestore();
  credentialsSpy?.mockRestore();
  ensureValidTokenSpy?.mockRestore();
  ensureAccountUuidSpy?.mockRestore();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /v1/completions — validation", () => {
  // Task 4.1 RED — Missing prompt → 400
  test("returns 400 when prompt is missing", async () => {
    const res = await handleCompletions(postJSON({ model: "claude-sonnet-4-6" }));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { message: string; type: string } };
    expect(body.error).toBeDefined();
    expect(body.error.message).toContain("prompt");
    expect(body.error.type).toBe("invalid_request_error");
  });

  // Triangulation: also missing when body is empty
  test("returns 400 when body has no model and no prompt", async () => {
    const res = await handleCompletions(postJSON({}));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { message: string } };
    expect(body.error.message).toContain("prompt");
  });
});

describe("POST /v1/completions — non-streaming response shape", () => {
  // Task 4.2 RED — Non-streaming success shape
  test("returns 200 with object: text_completion and choices[0].text", async () => {
    const res = await handleCompletions(postJSON({
      model: "claude-sonnet-4-6",
      prompt: "def add(",
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as {
      object: string;
      choices: Array<{ text: string; index: number; finish_reason: string }>;
      model: string;
      id: string;
    };
    expect(body.object).toBe("text_completion");
    expect(Array.isArray(body.choices)).toBe(true);
    expect(body.choices.length).toBeGreaterThan(0);
    expect(typeof body.choices[0]!.text).toBe("string");
    expect(body.choices[0]!.index).toBe(0);
    expect(typeof body.choices[0]!.finish_reason).toBe("string");
  });

  // Task 4.2 triangulation — choices[0].text carries completion content
  test("choices[0].text contains the completion returned by upstream", async () => {
    fetchSpy!.mockImplementationOnce(async () =>
      new Response(anthropicOkResponse("a + b"), { status: 200 }),
    );
    const res = await handleCompletions(postJSON({
      model: "claude-sonnet-4-6",
      prompt: "def add(",
    }));
    const body = await res.json() as { choices: Array<{ text: string }> };
    expect(body.choices[0]!.text).toBe("a + b");
  });

  // Task 4.2 triangulation — object field value
  test("object field is text_completion (not chat.completion)", async () => {
    const res = await handleCompletions(postJSON({
      model: "claude-sonnet-4-6",
      prompt: "function hello(",
    }));
    const body = await res.json() as { object: string };
    expect(body.object).toBe("text_completion");
  });
});

describe("POST /v1/completions — FIM translation", () => {
  // Task 4.3 RED — FIM with suffix: tokens in upstream messages
  test("FIM with suffix: upstream user message contains fim_prefix/fim_suffix/fim_middle tokens", async () => {
    await handleCompletions(postJSON({
      model: "claude-sonnet-4-6",
      prompt: "def add(",
      suffix: "\n    return a + b",
    }));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy!.mock.calls[0]!;
    const sent = JSON.parse((init as RequestInit).body as string) as {
      messages: Array<{ role: string; content: unknown }>;
      system: Array<{ type: string; text: string }>;
    };

    // Find the user message that carries FIM tokens
    const userMessages = sent.messages.filter((m) => m.role === "user");
    expect(userMessages.length).toBeGreaterThan(0);

    // content may be a string or array of blocks — flatten to text
    const userText = userMessages.map((m) => {
      if (typeof m.content === "string") return m.content;
      if (Array.isArray(m.content)) {
        return (m.content as Array<{ type: string; text?: string }>)
          .map((b) => b.text ?? "")
          .join("");
      }
      return "";
    }).join("");

    expect(userText).toContain("<|fim_prefix|>def add(");
    expect(userText).toContain("<|fim_suffix|>\n    return a + b");
    expect(userText).toContain("<|fim_middle|>");
  });

  // Task 4.4 RED — FIM without suffix: only prefix + middle tokens
  test("FIM without suffix: upstream user message has only fim_prefix and fim_middle", async () => {
    await handleCompletions(postJSON({
      model: "claude-sonnet-4-6",
      prompt: "def add(",
    }));

    const [, init] = fetchSpy!.mock.calls[0]!;
    const sent = JSON.parse((init as RequestInit).body as string) as {
      messages: Array<{ role: string; content: unknown }>;
    };

    const userText = sent.messages
      .filter((m) => m.role === "user")
      .map((m) => {
        if (typeof m.content === "string") return m.content;
        if (Array.isArray(m.content)) {
          return (m.content as Array<{ type: string; text?: string }>)
            .map((b) => b.text ?? "")
            .join("");
        }
        return "";
      })
      .join("");

    expect(userText).toContain("<|fim_prefix|>def add(");
    expect(userText).toContain("<|fim_middle|>");
    expect(userText).not.toContain("<|fim_suffix|>");
  });

  // Task 4.5 RED — clean_system: true is forwarded upstream
  test("clean_system: true is set in the upstream request body", async () => {
    await handleCompletions(postJSON({
      model: "claude-sonnet-4-6",
      prompt: "class Foo:",
    }));

    const [, init] = fetchSpy!.mock.calls[0]!;
    const sent = JSON.parse((init as RequestInit).body as string) as {
      system: Array<{ type: string; text: string }>;
    };

    // With clean_system: true the system array should NOT contain the
    // "You are Claude Code" identity entry — only the billing header.
    const claudeIdentityEntry = sent.system.find(
      (s) => s.type === "text" && s.text.includes("You are Claude Code"),
    );
    expect(claudeIdentityEntry).toBeUndefined();
  });
});

describe("POST /v1/completions — streaming", () => {
  // Task 4.6 RED — Streaming: SSE Content-Type, text_completion chunks, [DONE]
  test("streaming: Content-Type is text/event-stream", async () => {
    fetchSpy!.mockImplementationOnce(async () =>
      new Response(anthropicStreamResponse("a + b"), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    );

    const res = await handleCompletions(postJSON({
      model: "claude-sonnet-4-6",
      prompt: "def add(",
      stream: true,
    }));

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
  });

  test("streaming: each chunk has object: text_completion and choices[0].text", async () => {
    fetchSpy!.mockImplementationOnce(async () =>
      new Response(anthropicStreamResponse("hello"), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    );

    const res = await handleCompletions(postJSON({
      model: "claude-sonnet-4-6",
      prompt: "say hello",
      stream: true,
    }));

    const fullText = await res.text();
    const dataLines = fullText
      .split("\n")
      .filter((l) => l.startsWith("data: ") && !l.includes("[DONE]"));

    expect(dataLines.length).toBeGreaterThan(0);

    // W-03 fix: separate finish-reason chunks from content chunks, then assert
    // unconditionally that every non-finish chunk carries choices[0].text.
    const chunks = dataLines.map((line) =>
      JSON.parse(line.slice(6)) as {
        object: string;
        choices: Array<{ text?: string; finish_reason: string | null }>;
      },
    );

    const contentChunks = chunks.filter(
      (c) => c.choices[0] && c.choices[0].finish_reason === null,
    );
    const finishChunks = chunks.filter(
      (c) => c.choices[0] && c.choices[0].finish_reason !== null,
    );

    // Every chunk must use the text_completion object shape
    for (const chunk of chunks) {
      expect(chunk.object).toBe("text_completion");
    }
    // Every non-finish chunk MUST have choices[0].text as a string
    expect(contentChunks.length).toBeGreaterThan(0);
    for (const chunk of contentChunks) {
      expect(typeof chunk.choices[0]!.text).toBe("string");
    }
    // Finish chunks should have finish_reason set
    for (const chunk of finishChunks) {
      expect(chunk.choices[0]!.finish_reason).toBeTruthy();
    }
  });

  test("streaming: last SSE event is data: [DONE]", async () => {
    fetchSpy!.mockImplementationOnce(async () =>
      new Response(anthropicStreamResponse("x"), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    );

    const res = await handleCompletions(postJSON({
      model: "claude-sonnet-4-6",
      prompt: "x",
      stream: true,
    }));

    const fullText = await res.text();
    const nonEmptyLines = fullText.split("\n").filter((l) => l.trim() !== "");
    const lastLine = nonEmptyLines[nonEmptyLines.length - 1];
    expect(lastLine).toBe("data: [DONE]");
  });
});

describe("POST /v1/completions — upstream errors", () => {
  // Task 4.7 RED — Non-streaming upstream non-2xx propagates
  test("upstream 400 error propagates to response status", async () => {
    fetchSpy!.mockImplementationOnce(async () =>
      new Response(JSON.stringify({ error: { message: "invalid model" } }), { status: 400 }),
    );
    const res = await handleCompletions(postJSON({
      model: "bogus-model",
      prompt: "test",
    }));
    expect(res.status).toBe(400);
  });

  test("upstream 503 error propagates to response status", async () => {
    fetchSpy!.mockImplementationOnce(async () =>
      new Response("Service unavailable", { status: 503 }),
    );
    const res = await handleCompletions(postJSON({
      model: "claude-sonnet-4-6",
      prompt: "test",
    }));
    expect(res.status).toBe(503);
  });

  // W-02: Upstream error in the streaming path — the !res.ok guard fires BEFORE
  // the stream starts, so the caller should receive a plain error Response (not SSE).
  test("streaming: upstream 503 returns plain error response (not an SSE stream)", async () => {
    fetchSpy!.mockImplementationOnce(async () =>
      new Response(JSON.stringify({ error: { message: "upstream down" } }), { status: 503 }),
    );
    const res = await handleCompletions(postJSON({
      model: "claude-sonnet-4-6",
      prompt: "test",
      stream: true,
    }));
    expect(res.status).toBe(503);
    // Must NOT be an SSE stream — the Content-Type should not be text/event-stream
    expect(res.headers.get("Content-Type")).not.toContain("text/event-stream");
  });
});

describe("POST /v1/completions — unsupported parameters", () => {
  // W-01: Unsupported params (e.g. best_of) must be silently ignored and
  // must NOT be forwarded to the upstream Anthropic request body.
  test("unsupported param best_of is not forwarded to the upstream request body", async () => {
    await handleCompletions(postJSON({
      model: "claude-sonnet-4-6",
      prompt: "def add(",
      best_of: 3,
    }));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy!.mock.calls[0]!;
    const sent = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;

    // The Anthropic body must not carry best_of at any level
    expect("best_of" in sent).toBe(false);
  });
});

describe("POST /v1/completions — FIM suffix edge cases", () => {
  // S-01: An empty string suffix should be treated as absent — no fim_suffix tokens.
  test("empty string suffix is treated as absent (no fim_suffix tokens emitted)", async () => {
    await handleCompletions(postJSON({
      model: "claude-sonnet-4-6",
      prompt: "def add(",
      suffix: "",
    }));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy!.mock.calls[0]!;
    const sent = JSON.parse((init as RequestInit).body as string) as {
      messages: Array<{ role: string; content: unknown }>;
    };

    const userText = sent.messages
      .filter((m) => m.role === "user")
      .map((m) => {
        if (typeof m.content === "string") return m.content;
        if (Array.isArray(m.content)) {
          return (m.content as Array<{ type: string; text?: string }>)
            .map((b) => b.text ?? "")
            .join("");
        }
        return "";
      })
      .join("");

    expect(userText).toContain("<|fim_prefix|>def add(");
    expect(userText).toContain("<|fim_middle|>");
    expect(userText).not.toContain("<|fim_suffix|>");
  });
});
