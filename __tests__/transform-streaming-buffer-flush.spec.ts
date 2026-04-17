import { describe, it, expect, spyOn } from "bun:test";
import { streamAnthropicToOpenai } from "../src/transform/streaming.ts";
import * as logger from "../src/observability/logger.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** SSE event factory — returns `data: {...}` (no trailing newlines). */
function sseLine(obj: Record<string, unknown>): string {
  return `data: ${JSON.stringify(obj)}`;
}

/**
 * Build a ReadableStream<Uint8Array> from an array of SSE event objects.
 * - If `omitFinalNewline` is true, the last event is emitted WITHOUT a trailing `\n\n`.
 * - Otherwise every event is delimited by `\n\n`.
 */
function buildSseStream(
  events: Record<string, unknown>[],
  omitFinalNewline = false,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < events.length; i++) {
        const isLast = i === events.length - 1;
        const suffix = isLast && omitFinalNewline ? "" : "\n\n";
        controller.enqueue(encoder.encode(sseLine(events[i]!) + suffix));
      }
      try { controller.close(); } catch {}
    },
  });
}

/** Build a stream from raw string chunks (caller controls exact bytes). */
function buildRawStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      try { controller.close(); } catch {}
    },
  });
}

/** Build a stream from raw Uint8Array chunks (for multi-byte boundary tests). */
function buildBytesStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      try { controller.close(); } catch {}
    },
  });
}

/** Drain the downstream stream to completion and return decoded string chunks. */
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

/** Parse all `data: {json}\n\n` frames from collected chunks into JSON objects. */
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

/** Helper to find emit calls by event name. */
function emitCallsFor(spy: ReturnType<typeof spyOn<typeof logger, "emit">>, event: string) {
  return spy.mock.calls.filter((call) => call[1] === event);
}

/** Awaitable one-shot gate (for defer-cancel test). */
function makeGate() {
  let resolve!: () => void;
  const wait = new Promise<void>((r) => { resolve = r; });
  return { wait, release: () => resolve() };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("streamAnthropicToOpenai — end-of-stream buffer flush", () => {
  // REQ-1: trailing message_delta WITHOUT final \n\n must still be captured
  it("REQ-1: trailing message_delta without \\n\\n is drained and emits finish_reason + usage", async () => {
    const upstream = buildSseStream(
      [
        { type: "message_start", message: { id: "msg_1", usage: { input_tokens: 10 } } },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 42 } },
      ],
      /* omitFinalNewline */ true,
    );

    const emitSpy = spyOn(logger, "emit");
    try {
      const out = streamAnthropicToOpenai(upstream, "claude-flush-req1");
      const chunks = await drainAll(out);
      const parsed = parseChatCompletionChunks(chunks);

      // Final chunk must have finish_reason "stop" and usage.completion_tokens === 42
      const lastWithFinish = [...parsed].reverse().find((c) => {
        const choices = c.choices as Array<{ finish_reason?: unknown }> | undefined;
        return choices?.[0]?.finish_reason != null;
      });
      expect(lastWithFinish).toBeDefined();
      const choices = lastWithFinish!.choices as Array<{ finish_reason?: string }>;
      expect(choices[0]?.finish_reason).toBe("stop");
      const usage = lastWithFinish!.usage as Record<string, number> | undefined;
      expect(usage?.completion_tokens).toBe(42);

      // stream.end telemetry must carry outputTokens: 42
      const endCalls = emitCallsFor(emitSpy, "stream.end");
      expect(endCalls.length).toBe(1);
      const endPayload = endCalls[0]?.[2] as Record<string, unknown>;
      expect(endPayload.outputTokens).toBe(42);

      // [DONE] marker still emitted
      expect(chunks.join("")).toContain("data: [DONE]\n\n");
    } finally {
      emitSpy.mockRestore();
    }
  });

  // REQ-2: clean stream with proper \n\n must produce byte-identical happy-path output
  it("REQ-2: clean stream ending with \\n\\n produces no duplicate chunks from flush path", async () => {
    const upstream = buildSseStream(
      [
        { type: "message_start", message: { id: "msg_2", usage: { input_tokens: 5 } } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } },
      ],
      /* omitFinalNewline */ false,
    );

    const emitSpy = spyOn(logger, "emit");
    try {
      const out = streamAnthropicToOpenai(upstream, "claude-flush-req2");
      const chunks = await drainAll(out);
      const parsed = parseChatCompletionChunks(chunks);

      // Expected chunks (from main loop ONLY, no flush duplicates):
      //   1. text_delta "hello"   (with role:"assistant" on first chunk)
      //   2. message_delta stop   (finish_reason "stop", usage)
      expect(parsed.length).toBe(2);

      // First chunk: content "hello" with role "assistant"
      const firstChoices = parsed[0]!.choices as Array<{ delta?: Record<string, unknown>; finish_reason?: unknown }>;
      expect(firstChoices[0]?.delta?.content).toBe("hello");
      expect(firstChoices[0]?.delta?.role).toBe("assistant");
      expect(firstChoices[0]?.finish_reason).toBeNull();

      // Second chunk: finish_reason "stop", completion_tokens 7
      const secondChoices = parsed[1]!.choices as Array<{ finish_reason?: string }>;
      expect(secondChoices[0]?.finish_reason).toBe("stop");
      const usage = parsed[1]!.usage as Record<string, number>;
      expect(usage.completion_tokens).toBe(7);

      // [DONE] present exactly once
      const doneCount = (chunks.join("").match(/data: \[DONE\]\n\n/g) ?? []).length;
      expect(doneCount).toBe(1);

      // stream.end emitted exactly once (no duplicate from flush)
      expect(emitCallsFor(emitSpy, "stream.end").length).toBe(1);
    } finally {
      emitSpy.mockRestore();
    }
  });

  // REQ-3: truncated trailing JSON must be silently skipped, [DONE] still emitted, no throw
  it("REQ-3: truncated JSON in residual buffer is silently skipped and [DONE] is emitted", async () => {
    // Emit message_start cleanly (with \n\n), then a residual truncated partial line.
    const upstream = buildRawStream([
      `data: {"type":"message_start","message":{"id":"msg_trunc","usage":{"input_tokens":1}}}\n\n`,
      `data: {"type":"message_de`, // truncated — no closing
    ]);

    const emitSpy = spyOn(logger, "emit");
    try {
      const out = streamAnthropicToOpenai(upstream, "claude-flush-req3");
      // Must not throw
      const chunks = await drainAll(out);

      // [DONE] marker present
      expect(chunks.join("")).toContain("data: [DONE]\n\n");

      // No stream.error emitted (parse error was swallowed)
      expect(emitCallsFor(emitSpy, "stream.error").length).toBe(0);

      // stream.end still emitted
      expect(emitCallsFor(emitSpy, "stream.end").length).toBe(1);
    } finally {
      emitSpy.mockRestore();
    }
  });

  // REQ-4: multi-byte UTF-8 split across chunk boundary + no trailing \n\n
  // The two-byte `é` (0xC3 0xA9) is split: part in main loop, part held by TextDecoder,
  // released only when decoder.decode() (no args) is called at flush time.
  it("REQ-4: multi-byte UTF-8 char held by TextDecoder is flushed at end-of-stream", async () => {
    const encoder = new TextEncoder();
    // First chunk: message_start + the beginning of the message_delta ending with partial UTF-8
    // We'll build a JSON that ends with `"é"` — the `é` is 2 bytes.
    const header = `data: {"type":"message_start","message":{"id":"msg_utf8","usage":{"input_tokens":1}}}\n\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"`;
    // The rest closes BOTH the inner delta object AND the outer event object:
    // `é"}}` → bytes: [0xC3, 0xA9, 0x22, 0x7D, 0x7D]. No trailing \n\n — forces the
    // residual through the end-of-stream flush path.
    const tailComplete = `é"}}`;
    const headerBytes = encoder.encode(header);
    const tailBytes = encoder.encode(tailComplete);

    // Split the `é` across two chunks: send 0xC3 in the first tail chunk, then the
    // remaining bytes (0xA9 + `"}}`) in the second.
    const chunk1 = new Uint8Array(headerBytes.length + 1);
    chunk1.set(headerBytes, 0);
    chunk1[headerBytes.length] = tailBytes[0]!; // 0xC3 (first byte of é)

    const chunk2 = tailBytes.slice(1); // [0xA9, 0x22, 0x7D, 0x7D] — second byte of é + `"}}`

    const upstream = buildBytesStream([chunk1, chunk2]);

    const out = streamAnthropicToOpenai(upstream, "claude-flush-req4");
    const chunks = await drainAll(out);
    const parsed = parseChatCompletionChunks(chunks);

    // Look for a chunk whose content contains "é"
    const contentChunks = parsed
      .map((c) => {
        const choices = c.choices as Array<{ delta?: { content?: string } }> | undefined;
        return choices?.[0]?.delta?.content;
      })
      .filter((x): x is string => typeof x === "string");

    expect(contentChunks.join("")).toContain("é");
  });

  // REQ-5: deferred-cancel force-close must NOT trigger flush path
  it("REQ-5: deferred-cancel force-close skips the flush block (no duplicate chunks or stream.end)", async () => {
    const gate = makeGate();
    const encoder = new TextEncoder();

    // Fixture: message_start, tool_use_start_0, a partial tool_use delta, gate pause,
    // then content_block_stop_0 which resolves the deferred cancel via post-event hook.
    const upstream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode(
          `data: {"type":"message_start","message":{"id":"msg_defer","usage":{"input_tokens":1}}}\n\n`,
        ));
        controller.enqueue(encoder.encode(
          `data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_0","name":"Search"}}\n\n`,
        ));
        controller.enqueue(encoder.encode(
          `data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"q\\":1}"}}\n\n`,
        ));
        await gate.wait;
        controller.enqueue(encoder.encode(
          `data: {"type":"content_block_stop","index":0}\n\n`,
        ));
        try { controller.close(); } catch {}
      },
    });

    const emitSpy = spyOn(logger, "emit");
    try {
      const out = streamAnthropicToOpenai(upstream, "claude-flush-req5");
      const reader = out.getReader();
      const chunks: string[] = [];
      const drainDone = (async () => {
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (typeof value === "string") chunks.push(value);
            else if (value instanceof Uint8Array) chunks.push(new TextDecoder().decode(value));
          }
        } catch { /* cancel rejects pending reads — expected */ }
      })();

      // Wait for stream.start
      let waited = 0;
      while (emitCallsFor(emitSpy, "stream.start").length === 0 && waited < 1000) {
        await new Promise((r) => setTimeout(r, 5)); waited += 5;
      }
      await new Promise((r) => setTimeout(r, 30));

      // Cancel mid tool_use → defers
      await reader.cancel("client gone");

      // Defer telemetry fires
      expect(emitCallsFor(emitSpy, "stream.client_disconnect_deferred").length).toBe(1);

      gate.release();

      // Wait for force-close completion
      let waited2 = 0;
      while (emitCallsFor(emitSpy, "stream.client_disconnect_completed").length === 0 && waited2 < 2000) {
        await new Promise((r) => setTimeout(r, 10)); waited2 += 10;
      }
      expect(emitCallsFor(emitSpy, "stream.client_disconnect_completed").length).toBe(1);

      await drainDone;

      // No duplicate stream.end (should be exactly 1, emitted in finally of the main body)
      expect(emitCallsFor(emitSpy, "stream.end").length).toBe(1);

      // No [DONE] marker was emitted (deferred force-close path sets closed=true BEFORE
      // the `if (!closed) [DONE]` block; therefore [DONE] is suppressed. Also no flush
      // chunks leaked into the output.)
      expect(chunks.join("")).not.toContain("data: [DONE]");
    } finally {
      emitSpy.mockRestore();
    }
  });
});
