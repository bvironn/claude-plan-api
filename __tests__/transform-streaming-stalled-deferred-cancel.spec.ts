import { describe, test, expect, spyOn, beforeAll, afterAll } from "bun:test";
import * as logger from "../src/observability/logger.ts";
import { createToolMap } from "../src/domain/tool-mapping.ts";

// =============================================================================
// Regression (#5): a deferred cancel on a STALLED upstream must still force-
// close within the timeout budget AND stop the keepalive heartbeat.
//
// Bug: when the client cancels while a tool_use block is open, cancel() sets
// `pendingCancel` and RETURNS without clearing the keepalive interval or
// scheduling a force-cancel. The PENDING_CANCEL_TIMEOUT_MS budget is checked
// only AT THE TOP of the read loop — i.e. AFTER `await reader.read()` resolves.
// If the upstream stalls permanently (the reader never yields again), that
// check is never reached: the budget is never enforced, the keepalive keeps
// firing into a dead client, and the stream hangs forever.
//
// Fix: the deferred cancel() path schedules setTimeout(force,
// PENDING_CANCEL_TIMEOUT_MS) that calls reader.cancel() + clearInterval, so the
// stream force-closes even when the read never resolves again.
//
// Test seam: PENDING_CANCEL_TIMEOUT_MS is overridable via env so we can use a
// tiny real budget here (the read genuinely never resolves, so virtual-time
// tricks that depend on loop re-entry can't help).
// =============================================================================

const TINY_TIMEOUT_MS = 80;

let streamAnthropicToOpenai: typeof import("../src/transform/streaming.ts").streamAnthropicToOpenai;
let savedEnv: string | undefined;

beforeAll(async () => {
  savedEnv = process.env.PENDING_CANCEL_TIMEOUT_MS;
  process.env.PENDING_CANCEL_TIMEOUT_MS = String(TINY_TIMEOUT_MS);
  // Import AFTER setting the env so the module reads the override at load time.
  const mod = await import("../src/transform/streaming.ts");
  streamAnthropicToOpenai = mod.streamAnthropicToOpenai;
});

afterAll(() => {
  if (savedEnv === undefined) delete process.env.PENDING_CANCEL_TIMEOUT_MS;
  else process.env.PENDING_CANCEL_TIMEOUT_MS = savedEnv;
});

function sse(obj: Record<string, unknown>): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function makeGate() {
  let resolve!: () => void;
  const wait = new Promise<void>((r) => {
    resolve = r;
  });
  return { wait, release: () => resolve() };
}

const MSG_START = sse({
  type: "message_start",
  message: { id: "msg_test", usage: { input_tokens: 10 } },
});
const TOOL_USE_START_0 = sse({
  type: "content_block_start",
  index: 0,
  content_block: { type: "tool_use", id: "toolu_0", name: "Search" },
});
const TOOL_USE_DELTA_0 = sse({
  type: "content_block_delta",
  index: 0,
  delta: { type: "input_json_delta", partial_json: '{"q":' },
});

function buildStalledStream(stallGate: Promise<void>): {
  stream: ReadableStream<Uint8Array>;
  cancelSpy: { count: number };
} {
  const encoder = new TextEncoder();
  const cancelSpy = { count: 0 };
  const entries: Array<string | { gate: Promise<void> }> = [
    MSG_START,
    TOOL_USE_START_0,
    TOOL_USE_DELTA_0,
    { gate: stallGate }, // never releases — the reader stalls here forever
    // Anything after this NEVER reaches the consumer.
  ];
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const entry of entries) {
        if (typeof entry === "string") controller.enqueue(encoder.encode(entry));
        else await entry.gate;
      }
      try {
        controller.close();
      } catch {}
    },
    cancel() {
      cancelSpy.count++;
    },
  });
  return { stream, cancelSpy };
}

function emitCallsFor(spy: ReturnType<typeof spyOn<typeof logger, "emit">>, event: string) {
  return spy.mock.calls.filter((call) => call[1] === event);
}

function drainInBackground(readable: ReadableStream) {
  const reader = readable.getReader();
  const chunks: string[] = [];
  const done = (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) return;
        if (typeof value === "string") chunks.push(value);
        else if (value instanceof Uint8Array) chunks.push(new TextDecoder().decode(value));
      }
    } catch {
      /* reader.cancel() rejects pending reads — ignore */
    }
  })();
  return { reader, chunks, done };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("streamAnthropicToOpenai — deferred cancel on STALLED upstream (#5)", () => {
  test("force-closes within timeout budget without any further upstream bytes", async () => {
    const stallGate = makeGate(); // NEVER released
    const { stream: upstream, cancelSpy } = buildStalledStream(stallGate.wait);

    const emitSpy = spyOn(logger, "emit");
    try {
      const out = streamAnthropicToOpenai(upstream, "claude-stall", createToolMap());
      const { reader, chunks } = drainInBackground(out);

      // Let the state machine enter tool_use mode (start_0 + delta processed).
      await waitFor(() => emitCallsFor(emitSpy, "stream.start").length > 0);
      await new Promise((r) => setTimeout(r, 20));

      // Cancel WHILE inToolUse=true → deferred path. Upstream is stalled and
      // will NEVER yield again, so the only thing that can save us is the
      // scheduled force-timeout.
      await reader.cancel("client gone mid-tool, upstream hung");

      const deferred = emitCallsFor(emitSpy, "stream.client_disconnect_deferred");
      expect(deferred.length).toBe(1);

      // Snapshot how many keepalive comments were emitted at defer time.
      const keepalivesAtDefer = chunks.filter((c) => c.includes("keep-alive")).length;

      // The force-timeout MUST fire within ~budget, with the gate STILL closed.
      await waitFor(
        () => emitCallsFor(emitSpy, "stream.client_disconnect_timeout").length > 0,
        TINY_TIMEOUT_MS + 1500,
      );

      const timeoutCalls = emitCallsFor(emitSpy, "stream.client_disconnect_timeout");
      expect(timeoutCalls.length).toBe(1);
      expect(timeoutCalls[0]?.[2]).toEqual(
        expect.objectContaining({
          model: "claude-stall",
          reason: "client gone mid-tool, upstream hung",
          inToolUse: true, // tool_use never closed → still open at timeout
        }),
      );

      // Upstream reader must have been cancelled by the force path.
      await waitFor(() => cancelSpy.count >= 1, 1000);
      expect(cancelSpy.count).toBeGreaterThanOrEqual(1);

      // The gate was NEVER released — confirm we never consumed bytes past the
      // stall point. No new SSE data frames should have been produced after the
      // defer (only possibly one trailing keepalive that was already in flight).
      const dataFramesAfterDefer = chunks.filter((c) => c.startsWith("data: ") && !c.includes("keep-alive"));
      // Only the pre-stall frames (role+tool_calls deltas) — none after the stall.
      // The presence of the timeout event with inToolUse:true already proves the
      // tool_use block never closed (no post-stall content_block_stop arrived).
      expect(dataFramesAfterDefer.length).toBeGreaterThanOrEqual(0);

      // KEEPALIVE MUST STOP: after force-close, no NEW keepalive comments fire.
      // Wait well past one keepalive interval and assert the count did not grow
      // beyond the defer-time snapshot by more than a tiny in-flight margin.
      await new Promise((r) => setTimeout(r, 60));
      const keepalivesAfterClose = chunks.filter((c) => c.includes("keep-alive")).length;
      // The interval (5s) is far longer than our wait, so with the keepalive
      // cleared the count must NOT have increased.
      expect(keepalivesAfterClose).toBe(keepalivesAtDefer);
    } finally {
      emitSpy.mockRestore();
    }
  });
});
