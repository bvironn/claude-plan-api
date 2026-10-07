import { describe, test, expect, spyOn, afterEach } from "bun:test";
import type { AnthropicMessage } from "../src/types.ts";
import {
  repairToolPairs,
  synthesizeMissingToolResults,
  applyToolRepair,
  resolveToolRepairMode,
  TOOL_RESULT_PLACEHOLDER,
} from "../src/transform/repair-tool-pairs.ts";
import * as logger from "../src/observability/logger.ts";
import { openaiToAnthropic } from "../src/transform/openai-to-anthropic.ts";

describe("repairToolPairs", () => {
  afterEach(() => {
    // Defensive — individual tests restore their own spies, but guard against
    // any spy that silently leaked past a failed assertion.
  });

  // --- REQ-1: Strip orphaned tool_use blocks ---
  test("REQ-1: strips tool_use block when no matching tool_result exists", () => {
    const messages: AnthropicMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "I will search." },
          { type: "tool_use", id: "toolu_orphan", name: "Search", input: {} },
        ],
      },
      { role: "user", content: "follow up" },
    ];

    const result = repairToolPairs(messages);

    expect(result).toHaveLength(2);
    const assistant = result[0]!;
    expect(Array.isArray(assistant.content)).toBe(true);
    const blocks = assistant.content as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe("text");
    expect(blocks[0]!.text).toBe("I will search.");
    // Verify the orphan is truly gone
    const hasOrphan = blocks.some((b) => b.type === "tool_use" && b.id === "toolu_orphan");
    expect(hasOrphan).toBe(false);
  });

  // --- REQ-2: Strip orphaned tool_result blocks ---
  test("REQ-2: strips tool_result block when no prior matching tool_use exists", () => {
    const messages: AnthropicMessage[] = [
      { role: "user", content: "hi" },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_orphan", content: "stale" },
          { type: "text", text: "still here" },
        ],
      },
    ];

    const result = repairToolPairs(messages);

    expect(result).toHaveLength(2);
    const second = result[1]!;
    const blocks = second.content as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe("text");
    expect(blocks[0]!.text).toBe("still here");
  });

  // --- REQ-3: Preserve sibling blocks ---
  test("REQ-3: preserves text siblings of an orphan tool_use", () => {
    const messages: AnthropicMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "plan" },
          { type: "tool_use", id: "toolu_orphan", name: "X", input: {} },
          { type: "text", text: "more" },
        ],
      },
    ];

    const result = repairToolPairs(messages);

    expect(result).toHaveLength(1);
    const blocks = result[0]!.content as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ type: "text", text: "plan" });
    expect(blocks[1]).toEqual({ type: "text", text: "more" });
  });

  // --- REQ-4: Drop empty messages ---
  test("REQ-4: drops message entirely when its only block is an orphan", () => {
    const messages: AnthropicMessage[] = [
      { role: "user", content: "before" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_orphan", name: "X", input: {} },
        ],
      },
      { role: "user", content: "after" },
    ];

    const result = repairToolPairs(messages);

    expect(result).toHaveLength(2);
    expect(result[0]!.role).toBe("user");
    expect(result[0]!.content).toBe("before");
    expect(result[1]!.role).toBe("user");
    expect(result[1]!.content).toBe("after");
  });

  // --- REQ-5: Pass through valid pairs ---
  test("REQ-5: leaves matched tool_use / tool_result pairs unchanged", () => {
    const messages: AnthropicMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_valid", name: "Search", input: { q: "ok" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_valid", content: "result" },
        ],
      },
    ];

    const result = repairToolPairs(messages);

    expect(result).toEqual(messages);
  });

  // --- REQ-6: String content passthrough ---
  test("REQ-6: passes messages with string content through unchanged", () => {
    const messages: AnthropicMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "world" },
    ];

    const result = repairToolPairs(messages);

    expect(result).toEqual(messages);
    expect(result[0]!.content).toBe("hello");
    expect(result[1]!.content).toBe("world");
  });

  // --- REQ-7: No-op when no orphans (referential equality) ---
  test("REQ-7: returns the same array reference when no orphans are present", () => {
    const messages: AnthropicMessage[] = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "ok" },
          { type: "tool_use", id: "toolu_a", name: "Read", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_a", content: "done" },
        ],
      },
    ];

    const result = repairToolPairs(messages);

    expect(result).toBe(messages);
  });

  // --- REQ-8: Debug telemetry ---
  test("REQ-8: emits a debug event with orphan counts when repair fires", () => {
    const spy = spyOn(logger, "emit");
    try {
      const messages: AnthropicMessage[] = [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_orphan_use", name: "X", input: {} },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_orphan_result", content: "stale" },
          ],
        },
      ];

      repairToolPairs(messages);

      const matching = spy.mock.calls.filter(
        (call) => call[0] === "debug" && call[1] === "transform.repairToolPairs"
      );
      expect(matching).toHaveLength(1);
      const payload = matching[0]![2] as Record<string, unknown>;
      expect(payload.orphanedUseCount).toBe(1);
      expect(payload.orphanedResultCount).toBe(1);
      expect(payload.droppedMessageCount).toBe(2);
    } finally {
      spy.mockRestore();
    }
  });

  // --- REQ-9: Post-translation integration (drop mode) ---
  test("REQ-9: openaiToAnthropic in drop mode leaves no orphan tool_use/tool_result blocks", () => {
    const prev = Bun.env.TOOL_REPAIR_MODE;
    Bun.env.TOOL_REPAIR_MODE = "drop";
    try {
      const { body: result } = openaiToAnthropic(orphanCallBody());
      const messages = result.messages as AnthropicMessage[];
      for (const m of messages) {
        if (!Array.isArray(m.content)) continue;
        for (const block of m.content as Array<Record<string, unknown>>) {
          expect(block.type === "tool_use" || block.type === "tool_result").toBe(false);
        }
      }
      expect(userTexts(messages)).toContain("please search");
      expect(userTexts(messages)).toContain("follow up");
    } finally {
      if (prev === undefined) delete Bun.env.TOOL_REPAIR_MODE;
      else Bun.env.TOOL_REPAIR_MODE = prev;
    }
  });

  // --- Adjacency (upstream #250) ---
  test("drops a tool_use whose result exists but is not in the next message", () => {
    const messages: AnthropicMessage[] = [
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "X", input: {} }] },
      { role: "user", content: [{ type: "text", text: "interrupting" }] },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "late" }] },
    ];
    const result = repairToolPairs(messages);
    const blocks = result.flatMap((m) => (Array.isArray(m.content) ? m.content : []));
    expect(blocks.some((b) => b.type === "tool_use")).toBe(false);
    expect(blocks.some((b) => b.type === "tool_result")).toBe(false);
  });

  test("a replayed tool_use id is judged per occurrence", () => {
    const messages: AnthropicMessage[] = [
      { role: "assistant", content: [{ type: "tool_use", id: "dup", name: "X", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "dup", content: "r" }] },
      { role: "assistant", content: [{ type: "text", text: "again" }, { type: "tool_use", id: "dup", name: "X", input: {} }] },
      { role: "user", content: "no result here" },
    ];
    const result = repairToolPairs(messages);
    expect(result[1]!.content).toEqual(messages[1]!.content);
    expect(result[2]!.content).toEqual([{ type: "text", text: "again" }]);
  });

  test("drop mode omits a thinking turn whole instead of rewriting it, then cascades", () => {
    const messages: AnthropicMessage[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hmm", signature: "sig" },
          { type: "tool_use", id: "ok", name: "X", input: {} },
          { type: "tool_use", id: "orphan", name: "Y", input: {} },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "ok", content: "r" }] },
      { role: "user", content: "next" },
    ];
    const result = repairToolPairs(messages);
    expect(result).toEqual([
      { role: "user", content: "go" },
      { role: "user", content: "next" },
    ]);
  });
});

function orphanCallBody(): Record<string, unknown> {
  return {
    model: "sonnet",
    messages: [
      { role: "user", content: "please search" },
      {
        role: "assistant",
        content: "working on it",
        tool_calls: [
          {
            id: "toolu_orphan_call",
            type: "function",
            function: { name: "search", arguments: JSON.stringify({ q: "hi" }) },
          },
        ],
      },
      { role: "user", content: "follow up" },
    ],
  };
}

function userTexts(messages: AnthropicMessage[]): unknown[] {
  return messages
    .filter((m) => m.role === "user")
    .map((m) => (typeof m.content === "string"
      ? m.content
      : (m.content as Array<Record<string, unknown>>).find((b) => b.type === "text")?.text));
}

/** Every tool_use is answered in the next message and every tool_result answers the previous one. */
function expectAdjacentPairs(messages: AnthropicMessage[]): void {
  messages.forEach((m, i) => {
    if (!Array.isArray(m.content)) return;
    for (const b of m.content) {
      if (b.type === "tool_use") {
        const next = messages[i + 1];
        expect(Array.isArray(next?.content) && (next!.content as Array<Record<string, unknown>>).some((r) => r.tool_use_id === b.id)).toBe(true);
      }
      if (b.type === "tool_result") {
        const prev = messages[i - 1];
        expect(Array.isArray(prev?.content) && (prev!.content as Array<Record<string, unknown>>).some((u) => u.id === b.tool_use_id)).toBe(true);
      }
    }
  });
}

describe("synthesizeMissingToolResults (placeholder mode, default)", () => {
  test("mode defaults to placeholder; TOOL_REPAIR_MODE=drop opts out", () => {
    expect(resolveToolRepairMode({})).toBe("placeholder");
    expect(resolveToolRepairMode({ TOOL_REPAIR_MODE: "garbage" })).toBe("placeholder");
    expect(resolveToolRepairMode({ TOOL_REPAIR_MODE: " DROP " })).toBe("drop");
  });

  test("returns the same reference when pairs are already adjacent", () => {
    const messages: AnthropicMessage[] = [
      { role: "assistant", content: [{ type: "tool_use", id: "a", name: "X", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "r" }] },
    ];
    expect(synthesizeMissingToolResults(messages)).toBe(messages);
  });

  test("keeps the orphan tool_use and merges a placeholder into a plain-text user turn", () => {
    const assistant: AnthropicMessage = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "plan", signature: "sig" },
        { type: "text", text: "searching" },
        { type: "tool_use", id: "t1", name: "Search", input: {} },
      ],
    };
    const result = synthesizeMissingToolResults([
      { role: "user", content: "go" },
      assistant,
      { role: "user", content: "follow up" },
    ]);
    expect(result).toHaveLength(3);
    // Assistant turn (with thinking) is untouched — same object.
    expect(result[1]).toBe(assistant);
    expect(result[2]!.content).toEqual([
      { type: "tool_result", tool_use_id: "t1", content: TOOL_RESULT_PLACEHOLDER, is_error: true },
      { type: "text", text: "follow up" },
    ]);
    expectAdjacentPairs(result);
  });

  test("synthesizes only the missing ids and puts them ahead of existing blocks", () => {
    const result = synthesizeMissingToolResults([
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "a", name: "X", input: {} },
          { type: "tool_use", id: "b", name: "Y", input: {} },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "real" }] },
    ]);
    const blocks = result[1]!.content as Array<Record<string, unknown>>;
    expect(blocks.map((b) => b.tool_use_id)).toEqual(["b", "a"]);
    expect(blocks[1]!.content).toBe("real");
    expectAdjacentPairs(result);
  });

  test("appends a user turn when the tool_use is last or followed by an assistant", () => {
    const result = synthesizeMissingToolResults([
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "tool_use", id: "x", name: "X", input: {} }] },
    ]);
    expect(result).toHaveLength(3);
    expect(result[2]!.role).toBe("user");
    expectAdjacentPairs(result);
  });

  test("removes non-adjacent tool_results, then answers the stranded tool_use", () => {
    const result = synthesizeMissingToolResults([
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "X", input: {} }] },
      { role: "user", content: [{ type: "text", text: "interrupting" }] },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "late" }] },
    ]);
    expect(result).toHaveLength(3);
    expectAdjacentPairs(result);
  });

  test("applyToolRepair dispatches on mode", () => {
    const messages: AnthropicMessage[] = [
      { role: "assistant", content: [{ type: "tool_use", id: "x", name: "X", input: {} }] },
    ];
    expect(applyToolRepair(messages, "drop")).toEqual([]);
    expect(applyToolRepair(messages, "placeholder")).toHaveLength(2);
  });

  test("openaiToAnthropic (default mode) keeps the call and pairs it with a placeholder", () => {
    const { body } = openaiToAnthropic(orphanCallBody());
    const messages = body.messages as AnthropicMessage[];
    const blocks = messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []));
    expect(blocks.some((b) => b.type === "tool_use" && b.id === "toolu_orphan_call")).toBe(true);
    expectAdjacentPairs(messages);
    expect(userTexts(messages).some((t) => typeof t === "string" && t.includes("follow up"))).toBe(true);
  });
});
