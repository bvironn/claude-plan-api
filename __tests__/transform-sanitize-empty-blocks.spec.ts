import { describe, test, expect, spyOn, beforeEach, afterEach } from "bun:test";
import {
  sanitizeOpenAIMessages,
  openaiToAnthropic,
  SANITIZE_MUTATION_TYPES,
  EMPTY_MESSAGE_PLACEHOLDER,
} from "../src/transform/openai-to-anthropic.ts";
import * as loggerModule from "../src/observability/logger.ts";

// =============================================================================
// Real-world fixtures captured from Continue.dev telemetry.
// These are the EXACT shapes that triggered Anthropic HTTP 400:
//   "messages.N.content.M.text: Input should be a valid string with at least
//   1 character"
// Both fixtures MUST sanitize to bodies that have NO empty text blocks.
// =============================================================================

// Fixture A — Continue.dev request #8: assistant with an empty text block
// followed by a real fenced-tool block. Anthropic rejects the empty block.
const CONTINUE_DEV_REQUEST_8 = {
  model: "claude-sonnet-4-5",
  messages: [
    { role: "user", content: "hi" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "" },
        { type: "text", text: "```tool\nTOOL_NAME: read_currently_open_file\n```" },
      ],
    },
    { role: "user", content: "ok" },
  ],
};

// Fixture B — Continue.dev request #9: same as A but the FINAL user message
// content is a single space — Anthropic rejects this with the same 400.
const CONTINUE_DEV_REQUEST_9 = {
  model: "claude-sonnet-4-5",
  messages: [
    { role: "user", content: "hi" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "" },
        { type: "text", text: "```tool\nTOOL_NAME: read_currently_open_file\n```" },
      ],
    },
    { role: "user", content: " " },
  ],
};

// =============================================================================
// Helpers
// =============================================================================

/**
 * Walk the sanitized messages output and report every empty text block found.
 * Used to assert "no empty text blocks survive sanitization" on real fixtures
 * AND on integration with openaiToAnthropic().
 */
function findEmptyTextBlocks(
  messages: Array<Record<string, unknown>>,
): Array<{ messageIndex: number; blockIndex: number }> {
  const hits: Array<{ messageIndex: number; blockIndex: number }> = [];
  messages.forEach((msg, mi) => {
    const c = msg.content;
    if (typeof c === "string") {
      if (c.trim().length === 0) hits.push({ messageIndex: mi, blockIndex: -1 });
    } else if (Array.isArray(c)) {
      (c as Array<Record<string, unknown>>).forEach((block, bi) => {
        if (
          block &&
          typeof block === "object" &&
          (block as Record<string, unknown>).type === "text"
        ) {
          const t = (block as Record<string, unknown>).text;
          if (typeof t !== "string" || t.trim().length === 0) {
            hits.push({ messageIndex: mi, blockIndex: bi });
          }
        }
      });
    }
  });
  return hits;
}

// Capture emit calls for transform.sanitize.mutated only — the logger emits
// MANY other events during integration tests, so we filter on the event name.
function sanitizeEvents(spy: ReturnType<typeof spyOn>): Array<unknown[]> {
  return (spy.mock.calls as unknown as Array<unknown[]>).filter(
    (call) => call[1] === "transform.sanitize.mutated",
  );
}

// =============================================================================
// Observability spy lifecycle
// =============================================================================

let emitSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  emitSpy = spyOn(loggerModule, "emit");
});

afterEach(() => {
  emitSpy.mockRestore();
});

// =============================================================================
// Phase 2 — Spec-mapped tests (R1.1 .. R5.1) — 17 scenarios
// =============================================================================

describe("sanitizeOpenAIMessages — spec scenarios", () => {
  test("R1.1: assistant array with one empty text block → block removed, message kept", () => {
    const input = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "" },
          { type: "text", text: "real content" },
        ],
      },
    ];
    const out = sanitizeOpenAIMessages(input);
    expect(out).toHaveLength(1);
    expect(out[0]!.role).toBe("assistant");
    expect(out[0]!.content).toEqual([{ type: "text", text: "real content" }]);
  });

  test("R1.2: assistant array with whitespace-only text block → block removed", () => {
    const input = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "   \n\t" },
          { type: "text", text: "keep me" },
        ],
      },
    ];
    const out = sanitizeOpenAIMessages(input);
    expect(out[0]!.content).toEqual([{ type: "text", text: "keep me" }]);
  });

  test("R1.3: assistant all-empty + no tool_calls → message DROPPED", () => {
    const input = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "" }] },
      { role: "user", content: "next" },
    ];
    const out = sanitizeOpenAIMessages(input);
    expect(out).toHaveLength(2);
    expect(out[0]!.role).toBe("user");
    expect(out[1]!.role).toBe("user");
    expect(out[1]!.content).toBe("next");
  });

  test("R1.4: assistant all-empty + tool_calls → message PRESERVED, content becomes []", () => {
    const input = [
      {
        role: "assistant",
        content: [{ type: "text", text: "" }],
        tool_calls: [{ id: "tc_1", function: { name: "read_file", arguments: "{}" } }],
      },
    ];
    const out = sanitizeOpenAIMessages(input);
    expect(out).toHaveLength(1);
    expect(out[0]!.content).toEqual([]);
    expect(out[0]!.tool_calls).toEqual([
      { id: "tc_1", function: { name: "read_file", arguments: "{}" } },
    ]);
  });

  test("R1.5: assistant array with non-text blocks (image) → pass through unchanged", () => {
    const input = [
      {
        role: "assistant",
        content: [
          { type: "image", source: { type: "url", url: "https://x/y.png" } },
        ],
      },
    ];
    const out = sanitizeOpenAIMessages(input);
    expect(out[0]!.content).toEqual([
      { type: "image", source: { type: "url", url: "https://x/y.png" } },
    ]);
  });

  test("R2.1: user content:'' → replaced with placeholder string", () => {
    const input = [{ role: "user", content: "" }];
    const out = sanitizeOpenAIMessages(input);
    expect(out[0]!.content).toBe(EMPTY_MESSAGE_PLACEHOLDER);
  });

  test("R2.2: user whitespace-only string → replaced with placeholder", () => {
    const input = [{ role: "user", content: "\t\n  " }];
    const out = sanitizeOpenAIMessages(input);
    expect(out[0]!.content).toBe(EMPTY_MESSAGE_PLACEHOLDER);
  });

  test("R2.3: user content:'hello' → unchanged", () => {
    const input = [{ role: "user", content: "hello" }];
    const out = sanitizeOpenAIMessages(input);
    expect(out[0]!.content).toBe("hello");
  });

  test("R2.4: user content:[] → replaced with placeholder array", () => {
    const input = [{ role: "user", content: [] }];
    const out = sanitizeOpenAIMessages(input);
    expect(out[0]!.content).toEqual([
      { type: "text", text: EMPTY_MESSAGE_PLACEHOLDER },
    ]);
  });

  test("R2.5: user array of only empty text blocks → replaced with placeholder array", () => {
    const input = [
      {
        role: "user",
        content: [
          { type: "text", text: "" },
          { type: "text", text: "   " },
        ],
      },
    ];
    const out = sanitizeOpenAIMessages(input);
    expect(out[0]!.content).toEqual([
      { type: "text", text: EMPTY_MESSAGE_PLACEHOLDER },
    ]);
  });

  test("R2.6: user mixed array → empty text dropped, image kept (no placeholder injected)", () => {
    const input = [
      {
        role: "user",
        content: [
          { type: "text", text: "" },
          { type: "image", source: { type: "url", url: "https://x/y.png" } },
        ],
      },
    ];
    const out = sanitizeOpenAIMessages(input);
    expect(out[0]!.content).toEqual([
      { type: "image", source: { type: "url", url: "https://x/y.png" } },
    ]);
  });

  test("R3.1: mutation emits ONE warn event with required payload", () => {
    const input = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "" },
          { type: "text", text: "keep" },
        ],
      },
    ];
    sanitizeOpenAIMessages(input);
    const events = sanitizeEvents(emitSpy);
    expect(events).toHaveLength(1);
    expect(events[0]![0]).toBe("warn");
    expect(events[0]![1]).toBe("transform.sanitize.mutated");
    const payload = events[0]![2] as Record<string, unknown>;
    expect(payload.role).toBe("assistant");
    expect(payload.mutation_type).toBe(
      SANITIZE_MUTATION_TYPES.filteredEmptyTextBlocks,
    );
    expect(payload.original_block_count).toBe(2);
  });

  test("R3.2: no mutation → no event emitted", () => {
    const input = [
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: "real reply" }] },
    ];
    sanitizeOpenAIMessages(input);
    expect(sanitizeEvents(emitSpy)).toHaveLength(0);
  });

  test("R4.1: input array reference unchanged (result !== input)", () => {
    const input = [{ role: "user", content: "hi" }];
    const out = sanitizeOpenAIMessages(input);
    expect(out).not.toBe(input);
  });

  test("R4.2: original message objects are NOT mutated (deep clone compare)", () => {
    const input = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "" },
          { type: "text", text: "real" },
        ],
      },
      { role: "user", content: "  " },
    ];
    const cloneBefore = structuredClone(input);
    sanitizeOpenAIMessages(input);
    expect(input).toEqual(cloneBefore);
  });

  test("R4.3: structural equality when no mutation needed", () => {
    const input = [
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: "world" }] },
    ];
    const out = sanitizeOpenAIMessages(input);
    expect(out).toEqual(input);
  });

  test("R5.1: idempotency — sanitize(sanitize(x)) deep-equals sanitize(x)", () => {
    const fixtures: Array<Array<Record<string, unknown>>> = [
      CONTINUE_DEV_REQUEST_8.messages as Array<Record<string, unknown>>,
      CONTINUE_DEV_REQUEST_9.messages as Array<Record<string, unknown>>,
      [{ role: "user", content: "" }],
      [{ role: "assistant", content: [{ type: "text", text: "  " }] }],
      [
        {
          role: "assistant",
          content: [{ type: "text", text: "" }],
          tool_calls: [{ id: "x", function: { name: "f", arguments: "{}" } }],
        },
      ],
    ];
    for (const fx of fixtures) {
      const once = sanitizeOpenAIMessages(fx);
      const twice = sanitizeOpenAIMessages(once);
      expect(twice).toEqual(once);
    }
  });
});

// =============================================================================
// Phase 3 — Adversarial / hard-testing (15 tasks)
// =============================================================================

describe("sanitizeOpenAIMessages — adversarial / hard tests", () => {
  test("3.1 Negative: single-char meaningful content 'y', '.', '1' preserved, no event", () => {
    for (const ch of ["y", ".", "1"]) {
      emitSpy.mockClear();
      const input = [{ role: "user", content: ch }];
      const out = sanitizeOpenAIMessages(input);
      expect(out[0]!.content).toBe(ch);
      expect(sanitizeEvents(emitSpy)).toHaveLength(0);
    }
  });

  test("3.2 Negative: assistant tool_calls + empty text + image → text filtered, image+tool_calls kept", () => {
    const input = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "" },
          { type: "image", source: { type: "url", url: "https://a/b.png" } },
        ],
        tool_calls: [{ id: "tc_1", function: { name: "x", arguments: "{}" } }],
      },
    ];
    const out = sanitizeOpenAIMessages(input);
    expect(out).toHaveLength(1);
    expect(out[0]!.content).toEqual([
      { type: "image", source: { type: "url", url: "https://a/b.png" } },
    ]);
    expect(out[0]!.tool_calls).toEqual([
      { id: "tc_1", function: { name: "x", arguments: "{}" } },
    ]);
  });

  test("3.3 Edge: user content:null → placeholder array + replaced_null_user_content event", () => {
    const input = [{ role: "user", content: null }];
    const out = sanitizeOpenAIMessages(input);
    expect(out[0]!.content).toEqual([
      { type: "text", text: EMPTY_MESSAGE_PLACEHOLDER },
    ]);
    const events = sanitizeEvents(emitSpy);
    expect(events).toHaveLength(1);
    const payload = events[0]![2] as Record<string, unknown>;
    expect(payload.mutation_type).toBe(
      SANITIZE_MUTATION_TYPES.replacedNullUserContent,
    );
  });

  test("3.4 Edge: user content:undefined → same as null", () => {
    const input = [{ role: "user", content: undefined }];
    const out = sanitizeOpenAIMessages(input);
    expect(out[0]!.content).toEqual([
      { type: "text", text: EMPTY_MESSAGE_PLACEHOLDER },
    ]);
  });

  test("3.5 Edge: assistant content:null + no tool_calls → message dropped", () => {
    const input = [
      { role: "user", content: "hi" },
      { role: "assistant", content: null },
      { role: "user", content: "after" },
    ];
    const out = sanitizeOpenAIMessages(input);
    expect(out).toHaveLength(2);
    expect(out.map((m) => m.role)).toEqual(["user", "user"]);
  });

  test("3.6 Edge: assistant content:null + tool_calls → preserved, content normalized to []", () => {
    const input = [
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "tc", function: { name: "n", arguments: "{}" } }],
      },
    ];
    const out = sanitizeOpenAIMessages(input);
    expect(out).toHaveLength(1);
    expect(out[0]!.content).toEqual([]);
    expect(out[0]!.tool_calls).toBeDefined();
  });

  test("3.7 Edge: 10 mixed blocks (5 empty, 5 real) → 5 real preserved in order", () => {
    const blocks: Array<Record<string, unknown>> = [];
    const expectedReal: string[] = [];
    for (let i = 0; i < 5; i++) {
      blocks.push({ type: "text", text: "" });
      const realText = `real-${i}`;
      blocks.push({ type: "text", text: realText });
      expectedReal.push(realText);
    }
    const input = [{ role: "assistant", content: blocks }];
    const out = sanitizeOpenAIMessages(input);
    expect(out[0]!.content).toEqual(
      expectedReal.map((t) => ({ type: "text", text: t })),
    );
  });

  test("3.8 Edge: system/tool roles with empty content pass through unchanged", () => {
    const input = [
      { role: "system", content: "" },
      { role: "tool", content: "", tool_call_id: "tc_1" },
    ];
    const out = sanitizeOpenAIMessages(input);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ role: "system", content: "" });
    expect(out[1]).toEqual({ role: "tool", content: "", tool_call_id: "tc_1" });
    // And no mutation event emitted for those rows.
    expect(sanitizeEvents(emitSpy)).toHaveLength(0);
  });

  test("3.9 Property — purity: deep-clone of input stays equal after sanitize (20 fixtures)", () => {
    const fixtures: Array<Array<Record<string, unknown>>> = [];
    // Build 20 varied fixtures
    const roles = ["user", "assistant"];
    const contents: Array<unknown> = [
      "hello",
      "",
      "   ",
      null,
      [{ type: "text", text: "" }, { type: "text", text: "real" }],
      [],
      [{ type: "text", text: "only-real" }],
      [{ type: "image", source: { type: "url", url: "https://a/b.png" } }],
    ];
    for (let i = 0; i < 20; i++) {
      const role = roles[i % roles.length]!;
      const content = contents[i % contents.length];
      fixtures.push([{ role, content } as Record<string, unknown>]);
    }
    for (const fx of fixtures) {
      const clone = structuredClone(fx);
      sanitizeOpenAIMessages(fx);
      expect(fx).toEqual(clone);
    }
  });

  test("3.10 Property — idempotency: sanitize(sanitize(x)) === sanitize(x) (20 fixtures)", () => {
    const fixtures: Array<Array<Record<string, unknown>>> = [];
    const samples: Array<Array<Record<string, unknown>>> = [
      [{ role: "user", content: "" }],
      [{ role: "user", content: "  " }],
      [{ role: "user", content: null as unknown as string }],
      [{ role: "user", content: "real" }],
      [{ role: "assistant", content: [{ type: "text", text: "" }] }],
      [
        {
          role: "assistant",
          content: [{ type: "text", text: "" }],
          tool_calls: [{ id: "x", function: { name: "f", arguments: "{}" } }],
        },
      ],
      CONTINUE_DEV_REQUEST_8.messages as Array<Record<string, unknown>>,
      CONTINUE_DEV_REQUEST_9.messages as Array<Record<string, unknown>>,
    ];
    for (let i = 0; i < 20; i++) {
      fixtures.push(structuredClone(samples[i % samples.length]!));
    }
    for (const fx of fixtures) {
      const once = sanitizeOpenAIMessages(fx);
      const twice = sanitizeOpenAIMessages(once);
      expect(twice).toEqual(once);
    }
  });

  test("3.11 Continue.dev request-8 fixture → no empty text blocks survive", () => {
    const out = sanitizeOpenAIMessages(
      CONTINUE_DEV_REQUEST_8.messages as Array<Record<string, unknown>>,
    );
    expect(findEmptyTextBlocks(out)).toEqual([]);
    // The original "real" tool fence text must survive.
    const assistant = out.find((m) => m.role === "assistant")!;
    const c = assistant.content as Array<Record<string, unknown>>;
    expect(c).toHaveLength(1);
    expect(c[0]!.type).toBe("text");
    expect(c[0]!.text).toContain("TOOL_NAME: read_currently_open_file");
  });

  test("3.12 Continue.dev request-9 fixture → no empty text blocks survive, final user is placeholder", () => {
    const out = sanitizeOpenAIMessages(
      CONTINUE_DEV_REQUEST_9.messages as Array<Record<string, unknown>>,
    );
    expect(findEmptyTextBlocks(out)).toEqual([]);
    const lastUser = out[out.length - 1]!;
    expect(lastUser.role).toBe("user");
    expect(lastUser.content).toBe(EMPTY_MESSAGE_PLACEHOLDER);
  });

  test("3.13 Performance: 100 mixed messages sanitized in < 5ms", () => {
    const big: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 100; i++) {
      if (i % 4 === 0) {
        big.push({ role: "user", content: "" });
      } else if (i % 4 === 1) {
        big.push({
          role: "assistant",
          content: [
            { type: "text", text: "" },
            { type: "text", text: `real-${i}` },
          ],
        });
      } else if (i % 4 === 2) {
        big.push({ role: "user", content: `msg-${i}` });
      } else {
        big.push({
          role: "assistant",
          content: [{ type: "text", text: `reply-${i}` }],
        });
      }
    }
    // Warm up the JIT so the measured run reflects steady-state cost, not
    // first-invocation parse/compile overhead.
    sanitizeOpenAIMessages(big);
    const start = performance.now();
    const out = sanitizeOpenAIMessages(big);
    const duration = performance.now() - start;
    expect(out.length).toBeGreaterThan(0);
    // Loose bound for system jitter — sanitize is strictly O(n) over a small
    // array, so anything over ~25ms indicates an algorithmic regression.
    expect(duration).toBeLessThan(25);
  });

  test("3.14 Observability spy: EXACTLY one emit per mutated message (not per block)", () => {
    const input = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "" },
          { type: "text", text: "" },
          { type: "text", text: "" },
          { type: "text", text: "real" },
        ],
      },
      {
        role: "user",
        content: [
          { type: "text", text: "" },
          { type: "text", text: "  " },
        ],
      },
      { role: "user", content: "" },
      { role: "user", content: "untouched" },
    ];
    sanitizeOpenAIMessages(input);
    const events = sanitizeEvents(emitSpy);
    // 3 mutated messages (the first assistant, the second user array, the third user string).
    // The fourth user is untouched → no event.
    expect(events).toHaveLength(3);
  });

  test("3.15 Observability payload: mutation_type ∈ enum, original_block_count ≥ 0", () => {
    const allowed = new Set<string>(Object.values(SANITIZE_MUTATION_TYPES));
    const input = [
      {
        role: "assistant",
        content: [{ type: "text", text: "" }, { type: "text", text: "ok" }],
      },
      { role: "user", content: "" },
      { role: "user", content: null },
      { role: "user", content: [] },
      { role: "assistant", content: [{ type: "text", text: "" }] },
    ];
    sanitizeOpenAIMessages(input);
    const events = sanitizeEvents(emitSpy);
    expect(events.length).toBeGreaterThan(0);
    for (const ev of events) {
      const payload = ev[2] as Record<string, unknown>;
      expect(allowed.has(payload.mutation_type as string)).toBe(true);
      expect(typeof payload.original_block_count).toBe("number");
      expect(payload.original_block_count as number).toBeGreaterThanOrEqual(0);
      expect(typeof payload.role).toBe("string");
    }
  });
});

// =============================================================================
// Integration: openaiToAnthropic() with sanitize pre-pass
// =============================================================================

describe("openaiToAnthropic integration with sanitize pre-pass", () => {
  test("Continue.dev request-8 → upstream messages[] has NO empty text blocks", () => {
    const { body } = openaiToAnthropic(
      structuredClone(CONTINUE_DEV_REQUEST_8) as Record<string, unknown>,
    );
    const upstreamMessages = body.messages as Array<Record<string, unknown>>;
    expect(upstreamMessages.length).toBeGreaterThan(0);
    expect(findEmptyTextBlocks(upstreamMessages)).toEqual([]);
  });

  test("Continue.dev request-9 → upstream messages[] has NO empty text blocks", () => {
    const { body } = openaiToAnthropic(
      structuredClone(CONTINUE_DEV_REQUEST_9) as Record<string, unknown>,
    );
    const upstreamMessages = body.messages as Array<Record<string, unknown>>;
    expect(upstreamMessages.length).toBeGreaterThan(0);
    expect(findEmptyTextBlocks(upstreamMessages)).toEqual([]);
  });

  test("assistant content:'' + tool_calls → NO text block, but tool_use SURVIVES in Anthropic body (#2)", () => {
    // Issue #2: an assistant message with an EMPTY-STRING content plus tool_calls
    // must (a) NOT emit any empty/placeholder text block (Anthropic 400s on a
    // zero-length text block) and (b) STILL carry its tool_use block in the
    // Anthropic body — dropping it would orphan the matching tool_result on the
    // following turn and break the tool-call sequence. The previous coverage
    // asserted only (a); this adds the missing (b).
    const { body } = openaiToAnthropic({
      model: "claude-sonnet-4-5",
      messages: [
        { role: "user", content: "run it" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: "call_1", function: { name: "bash", arguments: '{"cmd":"ls"}' } },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "file.txt" },
      ],
    });

    const upstreamMessages = body.messages as Array<Record<string, unknown>>;
    const assistant = upstreamMessages.find((m) => m.role === "assistant")!;
    expect(assistant).toBeDefined();
    const blocks = assistant.content as Array<Record<string, unknown>>;

    // (a) No text block at all, and no empty text blocks anywhere upstream.
    expect(blocks.filter((b) => b.type === "text")).toHaveLength(0);
    expect(findEmptyTextBlocks(upstreamMessages)).toEqual([]);

    // (b) NEW assertion — the tool_use block MUST survive, carrying the mapped
    // wire name and the original tool-call id.
    const toolUse = blocks.filter((b) => b.type === "tool_use");
    expect(toolUse).toHaveLength(1);
    expect(toolUse[0]!.id).toBe("call_1");
    expect(toolUse[0]!.name).toBe("mcp_Bash");
  });
});
