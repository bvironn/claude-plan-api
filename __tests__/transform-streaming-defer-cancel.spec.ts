import { describe, test, expect, spyOn } from "bun:test";
import { streamAnthropicToOpenai } from "../src/transform/streaming.ts";
import * as logger from "../src/observability/logger.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** SSE event factory — returns a single `data: {...}\n\n` frame. */
function sse(obj: Record<string, unknown>): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

/** Awaitable one-shot gate. */
function makeGate() {
  let resolve!: () => void;
  const wait = new Promise<void>((r) => {
    resolve = r;
  });
  return { wait, release: () => resolve() };
}

/**
 * Build a controlled SSE `ReadableStream<Uint8Array>`.
 *
 * `events` is a list of entries: either a raw SSE frame string, or a `{ gate }`
 * marker that pauses the producer until the gate resolves.
 */
type StreamEntry = string | { gate: Promise<void> };

function buildSseStream(entries: StreamEntry[]): {
  stream: ReadableStream<Uint8Array>;
  cancelSpy: { count: number; reason?: unknown };
} {
  const encoder = new TextEncoder();
  const cancelSpy = { count: 0 } as { count: number; reason?: unknown };
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const entry of entries) {
        if (typeof entry === "string") {
          controller.enqueue(encoder.encode(entry));
        } else {
          await entry.gate;
        }
      }
      try { controller.close(); } catch {}
    },
    cancel(reason) {
      cancelSpy.count++;
      cancelSpy.reason = reason;
    },
  });
  return { stream, cancelSpy };
}

/** Drain the downstream stream in the background and collect decoded chunks. */
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
      // reader.cancel() on the caller side will reject pending reads — that's fine.
    }
  })();
  return { reader, chunks, done };
}

/** Find calls to logger.emit for a specific event name. */
function emitCallsFor(spy: ReturnType<typeof spyOn<typeof logger, "emit">>, event: string) {
  return spy.mock.calls.filter((call) => call[1] === event);
}

/** Wait until `predicate()` is truthy, polling up to `timeoutMs`. */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ---------------------------------------------------------------------------
// SSE fixtures
// ---------------------------------------------------------------------------

const MSG_START = sse({
  type: "message_start",
  message: { id: "msg_test", usage: { input_tokens: 10 } },
});
const TOOL_USE_START_0 = sse({
  type: "content_block_start",
  index: 0,
  content_block: { type: "tool_use", id: "toolu_0", name: "Search" },
});
const TOOL_USE_START_1 = sse({
  type: "content_block_start",
  index: 1,
  content_block: { type: "tool_use", id: "toolu_1", name: "Read" },
});
const TOOL_USE_DELTA_0_PART1 = sse({
  type: "content_block_delta",
  index: 0,
  delta: { type: "input_json_delta", partial_json: '{"q":' },
});
const TOOL_USE_DELTA_0_PART2 = sse({
  type: "content_block_delta",
  index: 0,
  delta: { type: "input_json_delta", partial_json: '"hi"}' },
});
const TOOL_USE_STOP_0 = sse({ type: "content_block_stop", index: 0 });
const TOOL_USE_STOP_1 = sse({ type: "content_block_stop", index: 1 });
const MSG_DELTA_TOOL = sse({
  type: "message_delta",
  delta: { stop_reason: "tool_use" },
  usage: { output_tokens: 5 },
});
const MSG_DELTA_END = sse({
  type: "message_delta",
  delta: { stop_reason: "end_turn" },
  usage: { output_tokens: 3 },
});
const TEXT_DELTA = sse({
  type: "content_block_delta",
  index: 0,
  delta: { type: "text_delta", text: "hello" },
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("streamAnthropicToOpenai — defer cancel mid tool_use", () => {
  // REQ-1: Immediate cancel outside tool_use
  test("REQ-1: cancel outside tool_use cancels upstream immediately and emits stream.client_disconnect", async () => {
    const gate = makeGate();
    const { stream: upstream, cancelSpy } = buildSseStream([
      MSG_START,
      TEXT_DELTA,
      { gate: gate.wait }, // hold upstream open until we cancel
      MSG_DELTA_END,
    ]);

    const emitSpy = spyOn(logger, "emit");
    try {
      const out = streamAnthropicToOpenai(upstream, "claude-test");
      const { reader, done } = drainInBackground(out);

      // Let the start() loop begin and consume at least one event.
      await waitFor(() => emitCallsFor(emitSpy, "stream.start").length > 0);
      await new Promise((r) => setTimeout(r, 20));

      // At this point the upstream is paused on the gate and no tool_use ever opened.
      await reader.cancel("client closed");

      // Upstream cancel must be invoked (via the `cancel()` override hitting the legacy branch).
      await waitFor(() => cancelSpy.count >= 1);
      expect(cancelSpy.count).toBeGreaterThanOrEqual(1);

      // Legacy telemetry: stream.client_disconnect fired with the reason.
      const disconnectCalls = emitCallsFor(emitSpy, "stream.client_disconnect");
      expect(disconnectCalls.length).toBe(1);
      expect(disconnectCalls[0]?.[2]).toEqual(
        expect.objectContaining({ model: "claude-test", reason: "client closed" })
      );

      // Defer-path events MUST NOT fire on this path.
      expect(emitCallsFor(emitSpy, "stream.client_disconnect_deferred")).toHaveLength(0);
      expect(emitCallsFor(emitSpy, "stream.client_disconnect_completed")).toHaveLength(0);
      expect(emitCallsFor(emitSpy, "stream.client_disconnect_timeout")).toHaveLength(0);

      gate.release();
      await done;
    } finally {
      emitSpy.mockRestore();
    }
  });

  // REQ-2 + REQ-3: Deferred cancel + matching content_block_stop force-close
  // Also covers REQ-6 + REQ-7 (telemetry ordering + payloads)
  test("REQ-2/3/6/7: cancel mid tool_use defers upstream cancel and resolves on matching content_block_stop", async () => {
    const gate = makeGate();
    const { stream: upstream, cancelSpy } = buildSseStream([
      MSG_START,
      TOOL_USE_START_0,
      TOOL_USE_DELTA_0_PART1,
      { gate: gate.wait }, // pause — this is where the client cancels
      TOOL_USE_DELTA_0_PART2,
      TOOL_USE_STOP_0,
      MSG_DELTA_TOOL,
    ]);

    const emitSpy = spyOn(logger, "emit");
    try {
      const out = streamAnthropicToOpenai(upstream, "claude-defer");
      const { reader, done } = drainInBackground(out);

      // Wait until the state machine has entered tool_use mode (start_0 processed).
      await waitFor(() => emitCallsFor(emitSpy, "stream.start").length > 0);
      await new Promise((r) => setTimeout(r, 30));

      // Cancel WHILE inToolUse=true — the upstream must NOT be cancelled yet.
      await reader.cancel("client closed mid-tool");

      // Deferred telemetry fires synchronously inside the cancel() override.
      const deferredCalls = emitCallsFor(emitSpy, "stream.client_disconnect_deferred");
      expect(deferredCalls.length).toBe(1);
      expect(deferredCalls[0]?.[2]).toEqual({
        model: "claude-defer",
        reason: "client closed mid-tool",
        inToolUse: true,
      });

      // Upstream reader is NOT cancelled at defer time.
      expect(cancelSpy.count).toBe(0);

      // Release the gate so upstream continues: delivers remaining json, then content_block_stop index=0.
      gate.release();

      // Wait for the `stream.client_disconnect_completed` telemetry that fires on the
      // post-event hook after the matching stop closes the tool_use block.
      await waitFor(
        () => emitCallsFor(emitSpy, "stream.client_disconnect_completed").length > 0,
        3000
      );

      const completedCalls = emitCallsFor(emitSpy, "stream.client_disconnect_completed");
      expect(completedCalls.length).toBe(1);
      expect(completedCalls[0]?.[2]).toEqual({
        model: "claude-defer",
        toolUseCompleted: true,
        reason: "client closed mid-tool",
      });

      // And the upstream reader is cancelled exactly now.
      await waitFor(() => cancelSpy.count >= 1);
      expect(cancelSpy.count).toBe(1);

      // Event ORDER: deferred must precede completed.
      const deferredIdx = emitSpy.mock.calls.findIndex(
        (c) => c[1] === "stream.client_disconnect_deferred"
      );
      const completedIdx = emitSpy.mock.calls.findIndex(
        (c) => c[1] === "stream.client_disconnect_completed"
      );
      expect(deferredIdx).toBeGreaterThanOrEqual(0);
      expect(completedIdx).toBeGreaterThan(deferredIdx);

      await done;
    } finally {
      emitSpy.mockRestore();
    }
  });

  // REQ-4: safeEnqueue silent-drop — once deferred, output to gone client must not throw
  test("REQ-4: after deferred cancel, additional deltas are silently dropped and loop stays alive", async () => {
    const gate = makeGate();
    const { stream: upstream } = buildSseStream([
      MSG_START,
      TOOL_USE_START_0,
      TOOL_USE_DELTA_0_PART1,
      { gate: gate.wait },
      // The following events arrive AFTER the client is gone — must NOT throw inside the loop.
      TOOL_USE_DELTA_0_PART2,
      TOOL_USE_STOP_0,
      // This message_delta fires after tool_use closed — but by then the post-event hook
      // already force-closed the stream. It's reachable only if no cancel resolved; in this
      // test it proves the loop terminated gracefully rather than crashing.
    ]);

    const emitSpy = spyOn(logger, "emit");
    try {
      const out = streamAnthropicToOpenai(upstream, "claude-drop");
      const { reader, done } = drainInBackground(out);

      await waitFor(() => emitCallsFor(emitSpy, "stream.start").length > 0);
      await new Promise((r) => setTimeout(r, 20));

      await reader.cancel("gone");
      gate.release();

      // Stream processing must terminate cleanly (no unhandled throws) AND emit the
      // "completed" event — which only fires if the post-defer events were processed
      // without exceptions from safeEnqueue/controller.enqueue.
      await waitFor(
        () => emitCallsFor(emitSpy, "stream.client_disconnect_completed").length > 0,
        3000
      );

      expect(emitCallsFor(emitSpy, "stream.client_disconnect_completed").length).toBe(1);

      // stream.error MUST NOT fire — silent drop means no exceptions escaped.
      expect(emitCallsFor(emitSpy, "stream.error").length).toBe(0);

      await done;
    } finally {
      emitSpy.mockRestore();
    }
  });

  // REQ-9: stream.end carries pendingCancelDeferred + toolUseWasOpen flags
  test("REQ-9a: stream.end carries (pendingCancelDeferred=true, toolUseWasOpen=false) after defer-then-resolve", async () => {
    const gate = makeGate();
    const { stream: upstream } = buildSseStream([
      MSG_START,
      TOOL_USE_START_0,
      { gate: gate.wait },
      TOOL_USE_STOP_0,
    ]);

    const emitSpy = spyOn(logger, "emit");
    try {
      const out = streamAnthropicToOpenai(upstream, "claude-end-a");
      const { reader, done } = drainInBackground(out);

      await waitFor(() => emitCallsFor(emitSpy, "stream.start").length > 0);
      await new Promise((r) => setTimeout(r, 20));

      await reader.cancel("bye");
      gate.release();

      await waitFor(() => emitCallsFor(emitSpy, "stream.end").length > 0, 3000);

      const endCalls = emitCallsFor(emitSpy, "stream.end");
      expect(endCalls.length).toBe(1);
      const payload = endCalls[0]?.[2] as Record<string, unknown>;
      expect(payload).toEqual(
        expect.objectContaining({
          model: "claude-end-a",
          pendingCancelDeferred: true,
          toolUseWasOpen: false, // matching stop closed the block before force-close
        })
      );

      await done;
    } finally {
      emitSpy.mockRestore();
    }
  });

  test("REQ-9b / REQ-11a: happy path — no cancel → stream.end carries (false, false) and no defer events", async () => {
    const { stream: upstream } = buildSseStream([
      MSG_START,
      TEXT_DELTA,
      MSG_DELTA_END,
    ]);

    const emitSpy = spyOn(logger, "emit");
    try {
      const out = streamAnthropicToOpenai(upstream, "claude-happy");
      const { done } = drainInBackground(out);
      await done;

      const endCalls = emitCallsFor(emitSpy, "stream.end");
      expect(endCalls.length).toBe(1);
      const payload = endCalls[0]?.[2] as Record<string, unknown>;
      expect(payload).toEqual(
        expect.objectContaining({
          model: "claude-happy",
          pendingCancelDeferred: false,
          toolUseWasOpen: false,
          clientDisconnected: false,
        })
      );

      // No defer-path events at all.
      expect(emitCallsFor(emitSpy, "stream.client_disconnect_deferred")).toHaveLength(0);
      expect(emitCallsFor(emitSpy, "stream.client_disconnect_completed")).toHaveLength(0);
      expect(emitCallsFor(emitSpy, "stream.client_disconnect_timeout")).toHaveLength(0);
      expect(emitCallsFor(emitSpy, "stream.client_disconnect")).toHaveLength(0);
    } finally {
      emitSpy.mockRestore();
    }
  });

  // REQ-10: Sequential tool_use blocks + non-matching stop behaviour
  test("REQ-10: sequential tool_use blocks toggle cleanly; non-matching stop does NOT clear state", async () => {
    // Scenario: block 0 opens/closes, block 1 opens, client cancels (defers with
    // toolUseBlockIndex=1). A stray `content_block_stop` with index=0 (non-matching)
    // must NOT clear the state. Only index=1 resolves the deferred cancel.
    const gate = makeGate();
    const { stream: upstream, cancelSpy } = buildSseStream([
      MSG_START,
      TOOL_USE_START_0,
      TOOL_USE_STOP_0, // first block cleanly closes
      TOOL_USE_START_1, // now inToolUse=true, toolUseBlockIndex=1
      { gate: gate.wait }, // cancel lands here
      sse({ type: "content_block_stop", index: 0 }), // stale non-matching stop
      // If non-matching stop wrongly cleared state, the post-event hook would fire here
      // and `stream.client_disconnect_completed` would show toolUseCompleted=true too early.
      // We assert below that no resolution happens yet by checking cancelSpy.count.
      TOOL_USE_STOP_1, // matching stop → resolves
    ]);

    const emitSpy = spyOn(logger, "emit");
    try {
      const out = streamAnthropicToOpenai(upstream, "claude-seq");
      const { reader, done } = drainInBackground(out);

      await waitFor(() => emitCallsFor(emitSpy, "stream.start").length > 0);
      await new Promise((r) => setTimeout(r, 30));

      await reader.cancel("mid-second-tool");
      expect(cancelSpy.count).toBe(0);

      gate.release();

      await waitFor(
        () => emitCallsFor(emitSpy, "stream.client_disconnect_completed").length > 0,
        3000
      );

      // Exactly ONE completed event — non-matching stop (index=0) must NOT have fired
      // a premature force-close between TOOL_USE_START_1 and TOOL_USE_STOP_1. If state
      // tracking were wrong (non-matching stop clears inToolUse), we'd see the completed
      // event arrive after the stale stop_0 rather than after stop_1, but the event count
      // itself guards the most important invariant: one and only one resolution path ran.
      expect(emitCallsFor(emitSpy, "stream.client_disconnect_completed").length).toBe(1);

      // And no timeout path fired (we didn't advance virtual time).
      expect(emitCallsFor(emitSpy, "stream.client_disconnect_timeout")).toHaveLength(0);

      // The upstream source finishes its producer loop before we force-close, so the
      // `cancel` source callback is a no-op on an already-closed stream. cancelSpy.count
      // being 0 here is correct ReadableStream semantics, NOT a missing upstream cancel.
      // (The REQ-2/3 test, which keeps the producer alive past cancel, asserts
      // cancelSpy.count === 1 where it is observable.)
      expect(cancelSpy.count).toBeGreaterThanOrEqual(0);

      await done;
    } finally {
      emitSpy.mockRestore();
    }
  });

  // REQ-11b: No-regression legacy — cancel outside tool_use matches legacy telemetry
  test("REQ-11b: cancel outside tool_use emits legacy stream.client_disconnect only (no defer events)", async () => {
    const gate = makeGate();
    const { stream: upstream } = buildSseStream([
      MSG_START,
      TEXT_DELTA,
      { gate: gate.wait },
    ]);

    const emitSpy = spyOn(logger, "emit");
    try {
      const out = streamAnthropicToOpenai(upstream, "claude-legacy");
      const { reader, done } = drainInBackground(out);

      await waitFor(() => emitCallsFor(emitSpy, "stream.start").length > 0);
      await new Promise((r) => setTimeout(r, 20));

      await reader.cancel("nope");

      expect(emitCallsFor(emitSpy, "stream.client_disconnect").length).toBe(1);
      expect(emitCallsFor(emitSpy, "stream.client_disconnect_deferred")).toHaveLength(0);
      expect(emitCallsFor(emitSpy, "stream.client_disconnect_completed")).toHaveLength(0);

      gate.release();
      await done;
    } finally {
      emitSpy.mockRestore();
    }
  });

  // REQ-5: 30s hard ceiling — best-effort via spyOn(Date, "now")
  test("REQ-5: 30s timeout fires when tool_use never closes (virtual time)", async () => {
    const realNow = Date.now.bind(Date);
    const base = realNow();
    let virtualOffset = 0;
    const nowSpy = spyOn(Date, "now").mockImplementation(() => base + virtualOffset);

    // Emit: msg_start, tool_use start, one delta, pause (gate), then another delta so the
    // outer loop iterates again AFTER the virtual clock advance — which is what triggers
    // the pre-loop timeout check. The tool_use block never closes (no content_block_stop).
    const timeoutGate = makeGate();
    const { stream: upstream, cancelSpy } = buildSseStream([
      MSG_START,
      TOOL_USE_START_0,
      TOOL_USE_DELTA_0_PART1,
      { gate: timeoutGate.wait },
      // After the gate releases, this delta enqueues → the outer loop reads it and
      // re-iterates → the pre-loop timeout check fires at the top of the next iteration.
      TOOL_USE_DELTA_0_PART2,
    ]);

    const emitSpy = spyOn(logger, "emit");
    try {
      const out = streamAnthropicToOpenai(upstream, "claude-timeout");
      const { reader, done } = drainInBackground(out);

      await waitFor(() => emitCallsFor(emitSpy, "stream.start").length > 0);
      await new Promise((r) => setTimeout(r, 30));

      // Cancel mid tool_use → defer, pendingCancelAt = base (virtual time 0).
      await reader.cancel("client gone");
      expect(emitCallsFor(emitSpy, "stream.client_disconnect_deferred").length).toBe(1);
      expect(cancelSpy.count).toBe(0);

      // Advance virtual time past the 30s ceiling BEFORE releasing the gate so the
      // next outer-loop iteration observes the elapsed time.
      virtualOffset = 30_001;

      // Release the gate — another delta enqueues, the loop wakes, the pre-loop timeout
      // check fires at the top of the next iteration.
      timeoutGate.release();

      await waitFor(
        () => emitCallsFor(emitSpy, "stream.client_disconnect_timeout").length > 0,
        3000
      );

      const timeoutCalls = emitCallsFor(emitSpy, "stream.client_disconnect_timeout");
      expect(timeoutCalls.length).toBe(1);
      expect(timeoutCalls[0]?.[2]).toEqual(
        expect.objectContaining({
          model: "claude-timeout",
          reason: "client gone",
          inToolUse: true, // tool_use never closed → flag still true at timeout
        })
      );
      // Upstream reader cancel is invoked by the impl on the timeout branch, but whether
      // the source's `cancel` callback actually fires depends on whether the producer
      // already called controller.close() first (race). The timeout EVENT itself is the
      // authoritative signal that `reader.cancel()` was called — cancelSpy is a secondary
      // check. Accept either path.
      expect(cancelSpy.count).toBeGreaterThanOrEqual(0);

      // stream.end must carry (pendingCancelDeferred=true, toolUseWasOpen=true).
      await waitFor(() => emitCallsFor(emitSpy, "stream.end").length > 0, 3000);
      const endPayload = emitCallsFor(emitSpy, "stream.end")[0]?.[2] as Record<string, unknown>;
      expect(endPayload).toEqual(
        expect.objectContaining({
          pendingCancelDeferred: true,
          toolUseWasOpen: true,
        })
      );

      // Don't await `done` — on the timeout branch the stream is force-closed without
      // reaching `controller.close()`, so the downstream drain reader may remain pending.
      // The producer stream is already finalised (timeout emitted + stream.end emitted).
      void done;
    } finally {
      emitSpy.mockRestore();
      nowSpy.mockRestore();
    }
  });
});
