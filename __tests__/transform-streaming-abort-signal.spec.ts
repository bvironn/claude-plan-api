// Regression guard for the Bun response-stream Sink use-after-free segfault.
//
// When an OpenWebUI (or any) client aborts a streaming request almost
// immediately, Bun ≤1.3.14 segfaults inside its native webcore stream Sink
// (1.3.13: `streams.finalize`/free; 1.3.14: `Sink.write`/`writeLatin1`) because
// our `controller.enqueue()` runs while Bun is tearing the sink down on abort.
//
// Fix under test: `streamAnthropicToOpenai` now takes the request `AbortSignal`
// and short-circuits every enqueue once `signal.aborted` is true, so we never
// write into a sink Bun has freed.
import { test, expect, describe } from "bun:test";
import { streamAnthropicToOpenai } from "../src/transform/streaming.ts";

function sseUpstream(events: Array<Record<string, unknown>>): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const e of events) {
        controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
      }
      controller.close();
    },
  });
}

// Reads whatever the stream emits within `ms`. On abort we deliberately never
// close the client controller (touching the sink is what crashes), so a read
// to completion would hang — hence the time-boxed collector.
async function collectWithin(reader: ReadableStreamDefaultReader, ms: number): Promise<string> {
  const dec = new TextDecoder();
  let out = "";
  const deadline = Date.now() + ms;
  // eslint-disable-next-line no-constant-condition
  while (Date.now() < deadline) {
    const r = await Promise.race([
      reader.read(),
      new Promise<"TIMEOUT">((res) => setTimeout(() => res("TIMEOUT"), Math.max(1, deadline - Date.now()))),
    ]);
    if (r === "TIMEOUT") break;
    const { done, value } = r as ReadableStreamReadResult<unknown>;
    if (done) break;
    out += typeof value === "string" ? value : dec.decode(value as Uint8Array);
  }
  return out;
}

const FULL_TURN: Array<Record<string, unknown>> = [
  { type: "message_start", message: { id: "msg_1", usage: { input_tokens: 5 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello world" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
];

describe("streamAnthropicToOpenai — AbortSignal gating (Bun Sink UAF guard)", () => {
  test("an already-aborted signal suppresses ALL client enqueues (no data written)", async () => {
    const ac = new AbortController();
    ac.abort();

    const stream = streamAnthropicToOpenai(sseUpstream(FULL_TURN), "claude-x", {}, ac.signal);
    const reader = stream.getReader();

    const out = await collectWithin(reader, 200);
    // Nothing may be written to the client sink while the request is aborted.
    expect(out).toBe("");
    await reader.cancel().catch(() => {});
  });

  test("a mid-stream abort stops further enqueues without throwing", async () => {
    const ac = new AbortController();
    const stream = streamAnthropicToOpenai(sseUpstream(FULL_TURN), "claude-x", {}, ac.signal);
    const reader = stream.getReader();

    // Abort right away, then confirm reading never yields a data chunk and
    // never throws (a native UAF would crash the process, not throw).
    ac.abort();
    const out = await collectWithin(reader, 200);
    expect(out).not.toContain("data: {");
    await reader.cancel().catch(() => {});
  });

  test("no signal (undefined) preserves default streaming behavior", async () => {
    const stream = streamAnthropicToOpenai(sseUpstream(FULL_TURN), "claude-x", {});
    const reader = stream.getReader();

    const out = await collectWithin(reader, 1000);
    expect(out).toContain('"content":"hello world"');
    expect(out).toContain("data: [DONE]");
    await reader.cancel().catch(() => {});
  });
});
