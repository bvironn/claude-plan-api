import { describe, test, expect } from "bun:test";
import { buildOpenAiUsage } from "../src/transform/usage.ts";
import { anthropicToOpenai } from "../src/transform/anthropic-to-openai.ts";
import { streamAnthropicToOpenai } from "../src/transform/streaming.ts";
import { createToolMap } from "../src/domain/tool-mapping.ts";

// ---------------------------------------------------------------------------
// Unit tests — buildOpenAiUsage()
// ---------------------------------------------------------------------------

describe("buildOpenAiUsage — unit", () => {
  test("all cache fields present: reads and creation", () => {
    const result = buildOpenAiUsage({
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 500,
      cache_creation_input_tokens: 200,
    });
    expect(result.prompt_tokens).toBe(100);
    expect(result.completion_tokens).toBe(50);
    expect(result.total_tokens).toBe(150);
    expect(result.prompt_tokens_details.cached_tokens).toBe(500);
    expect(result.cache_creation_input_tokens).toBe(200);
  });

  test("only reads present: creation absent", () => {
    const result = buildOpenAiUsage({
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 300,
    });
    expect(result.prompt_tokens_details.cached_tokens).toBe(300);
    expect(result.cache_creation_input_tokens).toBeUndefined();
  });

  test("only creation present (>0): emits cache_creation_input_tokens", () => {
    const result = buildOpenAiUsage({
      input_tokens: 100,
      output_tokens: 20,
      cache_creation_input_tokens: 150,
    });
    expect(result.prompt_tokens_details.cached_tokens).toBe(0);
    expect(result.cache_creation_input_tokens).toBe(150);
  });

  test("all cache fields absent: cached_tokens=0, cache_creation_input_tokens absent", () => {
    const result = buildOpenAiUsage({
      input_tokens: 100,
      output_tokens: 20,
    });
    expect(result.prompt_tokens_details.cached_tokens).toBe(0);
    expect(result.cache_creation_input_tokens).toBeUndefined();
    // Verify the key is truly absent (not just undefined)
    expect("cache_creation_input_tokens" in result).toBe(false);
  });

  test("cache_creation_input_tokens=0: field omitted (design: emit only when >0)", () => {
    const result = buildOpenAiUsage({
      input_tokens: 100,
      output_tokens: 20,
      cache_creation_input_tokens: 0,
    });
    expect(result.cache_creation_input_tokens).toBeUndefined();
    expect("cache_creation_input_tokens" in result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Consumer integration — anthropicToOpenai()
// ---------------------------------------------------------------------------

function makeAnthropicResponse(usage: Record<string, number>): Record<string, unknown> {
  return {
    id: "msg_usage",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "hello" }],
    model: "claude-sonnet",
    stop_reason: "end_turn",
    usage,
  };
}

describe("anthropicToOpenai — cache usage", () => {
  test("cache read tokens surfaced in prompt_tokens_details.cached_tokens", () => {
    const result = anthropicToOpenai(
      makeAnthropicResponse({ input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 500 }),
      "claude-sonnet",
      createToolMap(),
    );
    const usage = result.usage as Record<string, unknown>;
    const details = usage.prompt_tokens_details as Record<string, number>;
    expect(details.cached_tokens).toBe(500);
  });

  test("cache creation tokens surfaced when >0", () => {
    const result = anthropicToOpenai(
      makeAnthropicResponse({ input_tokens: 100, output_tokens: 5, cache_creation_input_tokens: 200 }),
      "claude-sonnet",
      createToolMap(),
    );
    const usage = result.usage as Record<string, unknown>;
    expect(usage.cache_creation_input_tokens).toBe(200);
  });

  test("upstream omits cache fields: cached_tokens=0, cache_creation absent", () => {
    const result = anthropicToOpenai(
      makeAnthropicResponse({ input_tokens: 100, output_tokens: 5 }),
      "claude-sonnet",
      createToolMap(),
    );
    const usage = result.usage as Record<string, unknown>;
    const details = usage.prompt_tokens_details as Record<string, number>;
    expect(details.cached_tokens).toBe(0);
    expect("cache_creation_input_tokens" in usage).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Consumer integration — streamAnthropicToOpenai()
// ---------------------------------------------------------------------------

function buildSseStream(events: Record<string, unknown>[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const ev of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`));
      }
      try { controller.close(); } catch {}
    },
  });
}

async function getFinishChunkUsage(
  messageStartUsage: Record<string, unknown>,
): Promise<Record<string, unknown> | undefined> {
  const upstream = buildSseStream([
    { type: "message_start", message: { id: "msg_usage_stream", usage: { input_tokens: 10, ...messageStartUsage } } },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
  ]);
  const out = streamAnthropicToOpenai(upstream, "claude-test", createToolMap());
  const reader = out.getReader();
  const chunks: string[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (typeof value === "string") chunks.push(value);
    else if (value instanceof Uint8Array) chunks.push(new TextDecoder().decode(value));
  }
  const joined = chunks.join("");
  const frames = joined.split("\n\n").filter(Boolean);
  for (const f of frames) {
    if (!f.startsWith("data: ")) continue;
    const json = f.slice(6).trim();
    if (!json || json === "[DONE]") continue;
    try {
      const parsed = JSON.parse(json) as Record<string, unknown>;
      const choices = parsed.choices as Array<{ finish_reason?: string }> | undefined;
      if (choices?.[0]?.finish_reason != null) return parsed.usage as Record<string, unknown>;
    } catch {}
  }
  return undefined;
}

describe("streamAnthropicToOpenai — cache usage in finish chunk", () => {
  test("cache read tokens surfaced in finish chunk", async () => {
    const usage = await getFinishChunkUsage({ cache_read_input_tokens: 300 });
    expect(usage).toBeDefined();
    const details = usage!.prompt_tokens_details as Record<string, number>;
    expect(details.cached_tokens).toBe(300);
  });

  test("cache creation tokens surfaced in finish chunk when >0", async () => {
    const usage = await getFinishChunkUsage({ cache_creation_input_tokens: 150 });
    expect(usage).toBeDefined();
    expect(usage!.cache_creation_input_tokens).toBe(150);
  });

  test("cache fields absent: cached_tokens=0, cache_creation absent", async () => {
    const usage = await getFinishChunkUsage({});
    expect(usage).toBeDefined();
    const details = usage!.prompt_tokens_details as Record<string, number>;
    expect(details.cached_tokens).toBe(0);
    expect("cache_creation_input_tokens" in usage!).toBe(false);
  });
});
