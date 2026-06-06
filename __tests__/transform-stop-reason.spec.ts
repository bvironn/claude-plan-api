import { describe, test, expect } from "bun:test";
import { toFinishReason } from "../src/transform/stop-reason.ts";
import { anthropicToOpenai } from "../src/transform/anthropic-to-openai.ts";
import { streamAnthropicToOpenai } from "../src/transform/streaming.ts";
import { createToolMap } from "../src/domain/tool-mapping.ts";

// ---------------------------------------------------------------------------
// Unit tests — toFinishReason()
// ---------------------------------------------------------------------------

describe("toFinishReason — unit", () => {
  test("end_turn maps to stop", () => {
    expect(toFinishReason("end_turn")).toBe("stop");
  });

  test("max_tokens maps to length", () => {
    expect(toFinishReason("max_tokens")).toBe("length");
  });

  test("stop_sequence maps to stop", () => {
    expect(toFinishReason("stop_sequence")).toBe("stop");
  });

  test("tool_use maps to tool_calls", () => {
    expect(toFinishReason("tool_use")).toBe("tool_calls");
  });

  test("refusal maps to content_filter", () => {
    expect(toFinishReason("refusal")).toBe("content_filter");
  });

  test("model_context_window_exceeded maps to length", () => {
    expect(toFinishReason("model_context_window_exceeded")).toBe("length");
  });

  test("pause_turn maps to stop", () => {
    expect(toFinishReason("pause_turn")).toBe("stop");
  });

  test("unknown value falls back to stop", () => {
    expect(toFinishReason("some_future_reason")).toBe("stop");
    expect(toFinishReason(undefined)).toBe("stop");
    expect(toFinishReason(null)).toBe("stop");
    expect(toFinishReason(42)).toBe("stop");
  });
});

// ---------------------------------------------------------------------------
// Consumer integration — anthropicToOpenai()
// ---------------------------------------------------------------------------

function makeAnthropicResponse(stopReason: string): Record<string, unknown> {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "hello" }],
    model: "claude-sonnet",
    stop_reason: stopReason,
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

describe("anthropicToOpenai — stop_reason mapping via shared module", () => {
  test("refusal maps to content_filter", () => {
    const result = anthropicToOpenai(makeAnthropicResponse("refusal"), "claude-sonnet", createToolMap());
    const choices = result.choices as Array<{ finish_reason: string }>;
    expect(choices[0]?.finish_reason).toBe("content_filter");
  });

  test("model_context_window_exceeded maps to length", () => {
    const result = anthropicToOpenai(makeAnthropicResponse("model_context_window_exceeded"), "claude-sonnet", createToolMap());
    const choices = result.choices as Array<{ finish_reason: string }>;
    expect(choices[0]?.finish_reason).toBe("length");
  });

  test("pause_turn maps to stop", () => {
    const result = anthropicToOpenai(makeAnthropicResponse("pause_turn"), "claude-sonnet", createToolMap());
    const choices = result.choices as Array<{ finish_reason: string }>;
    expect(choices[0]?.finish_reason).toBe("stop");
  });

  test("unknown stop_reason falls back to stop", () => {
    const result = anthropicToOpenai(makeAnthropicResponse("some_future_reason"), "claude-sonnet", createToolMap());
    const choices = result.choices as Array<{ finish_reason: string }>;
    expect(choices[0]?.finish_reason).toBe("stop");
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

async function getFinishChunk(
  stopReason: string,
): Promise<Record<string, unknown> | undefined> {
  const upstream = buildSseStream([
    { type: "message_start", message: { id: "msg_sr", usage: { input_tokens: 1 } } },
    { type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: 1 } },
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
      if (choices?.[0]?.finish_reason != null) return parsed;
    } catch {}
  }
  return undefined;
}

describe("streamAnthropicToOpenai — stop_reason mapping via shared module", () => {
  test("refusal maps to content_filter in stream finish chunk", async () => {
    const chunk = await getFinishChunk("refusal");
    expect(chunk).toBeDefined();
    const choices = chunk!.choices as Array<{ finish_reason: string }>;
    expect(choices[0]?.finish_reason).toBe("content_filter");
  });

  test("model_context_window_exceeded maps to length in stream finish chunk", async () => {
    const chunk = await getFinishChunk("model_context_window_exceeded");
    expect(chunk).toBeDefined();
    const choices = chunk!.choices as Array<{ finish_reason: string }>;
    expect(choices[0]?.finish_reason).toBe("length");
  });

  test("both paths produce identical output for same input (end_turn)", async () => {
    const streamChunk = await getFinishChunk("end_turn");
    const choices = streamChunk!.choices as Array<{ finish_reason: string }>;
    const streamResult = choices[0]?.finish_reason;

    const nonStreamResult = anthropicToOpenai(makeAnthropicResponse("end_turn"), "claude-sonnet", createToolMap());
    const nonStreamChoices = nonStreamResult.choices as Array<{ finish_reason: string }>;

    expect(streamResult).toBe(nonStreamChoices[0]?.finish_reason);
  });
});
