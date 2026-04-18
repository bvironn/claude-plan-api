import { describe, it, expect } from "bun:test";
import { anthropicToOpenai } from "../src/transform/anthropic-to-openai.ts";
import { streamAnthropicToOpenai } from "../src/transform/streaming.ts";

// ---------------------------------------------------------------------------
// Helpers (mirrors the style in transform-streaming-buffer-flush.spec.ts)
// ---------------------------------------------------------------------------

function sseLine(obj: Record<string, unknown>): string {
  return `data: ${JSON.stringify(obj)}`;
}

function buildSseStream(events: Record<string, unknown>[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const ev of events) {
        controller.enqueue(encoder.encode(sseLine(ev) + "\n\n"));
      }
      try { controller.close(); } catch {}
    },
  });
}

async function drainAll(readable: ReadableStream): Promise<string[]> {
  const reader = readable.getReader();
  const out: string[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (typeof value === "string") out.push(value);
    else if (value instanceof Uint8Array) out.push(new TextDecoder().decode(value));
  }
  return out;
}

function parseChatCompletionChunks(chunks: string[]): Array<Record<string, unknown>> {
  const joined = chunks.join("");
  const frames = joined.split("\n\n").filter(Boolean);
  const parsed: Array<Record<string, unknown>> = [];
  for (const f of frames) {
    if (!f.startsWith("data: ")) continue;
    const json = f.slice(6).trim();
    if (!json || json === "[DONE]") continue;
    try { parsed.push(JSON.parse(json)); } catch {}
  }
  return parsed;
}

type Delta = Record<string, unknown>;
function deltas(parsed: Array<Record<string, unknown>>): Delta[] {
  return parsed
    .map((p) => {
      const choices = p.choices as Array<{ delta?: Delta }> | undefined;
      return choices?.[0]?.delta ?? {};
    });
}

// ---------------------------------------------------------------------------
// Non-streaming — anthropicToOpenai
// ---------------------------------------------------------------------------

describe("anthropicToOpenai — thinking passthrough", () => {
  it("REQ-1: response with no thinking blocks omits reasoning_content and reasoning_details", () => {
    const out = anthropicToOpenai({
      id: "msg_a",
      content: [{ type: "text", text: "plain answer" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 3 },
    }, "claude-test");

    const choices = out.choices as Array<{ message: Record<string, unknown> }>;
    const msg = choices[0]!.message;
    expect(msg.content).toBe("plain answer");
    expect(msg.reasoning_content).toBeUndefined();
    expect(msg.reasoning_details).toBeUndefined();
  });

  it("REQ-2: single thinking block populates reasoning_content and reasoning_details with signature", () => {
    const out = anthropicToOpenai({
      id: "msg_b",
      content: [
        { type: "thinking", thinking: "reasoning A", signature: "sigA" },
        { type: "text", text: "final answer" },
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 3 },
    }, "claude-test");

    const msg = (out.choices as Array<{ message: Record<string, unknown> }>)[0]!.message;
    expect(msg.content).toBe("final answer");
    expect(msg.reasoning_content).toBe("reasoning A");
    expect(msg.reasoning_details).toEqual([
      { type: "thinking", thinking: "reasoning A", signature: "sigA" },
    ]);
  });

  it("REQ-3: multiple thinking blocks are concatenated with \\n\\n and preserved in reasoning_details", () => {
    const out = anthropicToOpenai({
      id: "msg_c",
      content: [
        { type: "thinking", thinking: "A", signature: "s1" },
        { type: "text", text: "mid" },
        { type: "thinking", thinking: "B", signature: "s2" },
        { type: "text", text: "tail" },
      ],
      stop_reason: "end_turn",
    }, "claude-test");

    const msg = (out.choices as Array<{ message: Record<string, unknown> }>)[0]!.message;
    expect(msg.reasoning_content).toBe("A\n\nB");
    const details = msg.reasoning_details as Array<Record<string, unknown>>;
    expect(details).toHaveLength(2);
    expect(details[0]).toEqual({ type: "thinking", thinking: "A", signature: "s1" });
    expect(details[1]).toEqual({ type: "thinking", thinking: "B", signature: "s2" });
  });

  it("REQ-4: redacted_thinking blocks appear in reasoning_details but NOT reasoning_content", () => {
    const out = anthropicToOpenai({
      id: "msg_d",
      content: [
        { type: "thinking", thinking: "visible", signature: "sigV" },
        { type: "redacted_thinking", data: "ciphertext-base64" },
        { type: "text", text: "answer" },
      ],
      stop_reason: "end_turn",
    }, "claude-test");

    const msg = (out.choices as Array<{ message: Record<string, unknown> }>)[0]!.message;
    expect(msg.reasoning_content).toBe("visible"); // redacted is NOT appended
    const details = msg.reasoning_details as Array<Record<string, unknown>>;
    expect(details).toHaveLength(2);
    expect(details[0]).toEqual({ type: "thinking", thinking: "visible", signature: "sigV" });
    expect(details[1]).toEqual({ type: "redacted_thinking", data: "ciphertext-base64" });
  });

  it("REQ-5: only redacted_thinking (no plaintext thinking) → reasoning_details present, reasoning_content absent", () => {
    const out = anthropicToOpenai({
      id: "msg_e",
      content: [
        { type: "redacted_thinking", data: "cipher-only" },
        { type: "text", text: "answer" },
      ],
      stop_reason: "end_turn",
    }, "claude-test");

    const msg = (out.choices as Array<{ message: Record<string, unknown> }>)[0]!.message;
    expect(msg.reasoning_content).toBeUndefined();
    expect(msg.reasoning_details).toEqual([{ type: "redacted_thinking", data: "cipher-only" }]);
  });
});

// ---------------------------------------------------------------------------
// Streaming — streamAnthropicToOpenai
// ---------------------------------------------------------------------------

describe("streamAnthropicToOpenai — thinking passthrough", () => {
  it("REQ-6: thinking_delta events emit reasoning_content chunks; content_block_stop emits reasoning_details with signature", async () => {
    const upstream = buildSseStream([
      { type: "message_start", message: { id: "msg_s1", usage: { input_tokens: 5 } } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "foo " } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "bar" } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig123" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "text" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "hello" } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 9 } },
    ]);

    const out = streamAnthropicToOpenai(upstream, "claude-stream-req6");
    const chunks = await drainAll(out);
    const parsed = parseChatCompletionChunks(chunks);
    const d = deltas(parsed);

    // Two reasoning_content chunks, in order
    const reasoningChunks = d
      .map((delta) => delta.reasoning_content as string | undefined)
      .filter((x): x is string => typeof x === "string");
    expect(reasoningChunks).toEqual(["foo ", "bar"]);

    // One reasoning_details chunk with the full thinking text and the signature
    const detailsChunks = d
      .map((delta) => delta.reasoning_details as Array<Record<string, unknown>> | undefined)
      .filter((x): x is Array<Record<string, unknown>> => Array.isArray(x));
    expect(detailsChunks).toHaveLength(1);
    expect(detailsChunks[0]).toEqual([
      { type: "thinking", thinking: "foo bar", signature: "sig123" },
    ]);

    // Exactly one content chunk with "hello"
    const contentChunks = d
      .map((delta) => delta.content as string | undefined)
      .filter((x): x is string => typeof x === "string");
    expect(contentChunks).toEqual(["hello"]);

    // No chunk mixes content and reasoning_content
    for (const delta of d) {
      expect(!!(delta.content && delta.reasoning_content)).toBe(false);
    }

    // [DONE] still terminates the stream
    expect(chunks.join("")).toContain("data: [DONE]\n\n");
  });

  it("REQ-7: role:assistant appears only on the first chunk that carries content OR reasoning_content", async () => {
    const upstream = buildSseStream([
      { type: "message_start", message: { id: "msg_s2", usage: { input_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "first-chunk" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "second-chunk" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
    ]);

    const out = streamAnthropicToOpenai(upstream, "claude-stream-req7");
    const chunks = await drainAll(out);
    const parsed = parseChatCompletionChunks(chunks);
    const d = deltas(parsed);

    // Only the first reasoning_content chunk should carry the role.
    const reasoningEmissions = d.filter((delta) => typeof delta.reasoning_content === "string");
    expect(reasoningEmissions).toHaveLength(2);
    expect(reasoningEmissions[0]!.role).toBe("assistant");
    expect(reasoningEmissions[1]!.role).toBeUndefined();
  });

  it("REQ-8: redacted_thinking block emits ONLY a reasoning_details chunk (no reasoning_content)", async () => {
    const upstream = buildSseStream([
      { type: "message_start", message: { id: "msg_s3", usage: { input_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "redacted_thinking", data: "cipher-x" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "text" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "ok" } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
    ]);

    const out = streamAnthropicToOpenai(upstream, "claude-stream-req8");
    const chunks = await drainAll(out);
    const parsed = parseChatCompletionChunks(chunks);
    const d = deltas(parsed);

    // No reasoning_content for a redacted-only block
    const reasoningChunks = d.filter((delta) => typeof delta.reasoning_content === "string");
    expect(reasoningChunks).toHaveLength(0);

    // Exactly one reasoning_details chunk carrying the raw redacted block
    const detailsChunks = d
      .map((delta) => delta.reasoning_details as Array<Record<string, unknown>> | undefined)
      .filter((x): x is Array<Record<string, unknown>> => Array.isArray(x));
    expect(detailsChunks).toHaveLength(1);
    expect(detailsChunks[0]).toEqual([{ type: "redacted_thinking", data: "cipher-x" }]);

    // The text chunk is still there
    const contentChunks = d
      .map((delta) => delta.content as string | undefined)
      .filter((x): x is string => typeof x === "string");
    expect(contentChunks).toEqual(["ok"]);
  });

  it("REQ-9: preserves Anthropic block order across text and thinking (thinking first, then text)", async () => {
    const upstream = buildSseStream([
      { type: "message_start", message: { id: "msg_s4", usage: { input_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "R1" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "text" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "T1" } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
    ]);

    const out = streamAnthropicToOpenai(upstream, "claude-stream-req9");
    const chunks = await drainAll(out);
    const parsed = parseChatCompletionChunks(chunks);
    const d = deltas(parsed);

    // Find indices of the first reasoning_content emission and the first content emission.
    const firstReasoningIdx = d.findIndex((delta) => typeof delta.reasoning_content === "string");
    const firstContentIdx = d.findIndex((delta) => typeof delta.content === "string");
    expect(firstReasoningIdx).toBeGreaterThanOrEqual(0);
    expect(firstContentIdx).toBeGreaterThanOrEqual(0);
    expect(firstReasoningIdx).toBeLessThan(firstContentIdx);
  });
});
