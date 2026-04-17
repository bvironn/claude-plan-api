import { describe, test, expect, spyOn, afterEach } from "bun:test";
import type { AnthropicMessage } from "../src/types.ts";
import { repairToolPairs } from "../src/transform/repair-tool-pairs.ts";
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

  // --- REQ-9: Post-translation integration ---
  test("REQ-9: openaiToAnthropic output has no orphan tool_use/tool_result blocks", () => {
    // Malformed OpenAI body: assistant issued a tool_call but no matching `tool` role response.
    const body: Record<string, unknown> = {
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

    const { body: result } = openaiToAnthropic(body);
    const messages = result.messages as AnthropicMessage[];

    // Walk every message: no tool_use with id="toolu_orphan_call" should survive.
    let foundOrphan = false;
    for (const m of messages) {
      if (!Array.isArray(m.content)) continue;
      for (const block of m.content as Array<Record<string, unknown>>) {
        if (block.type === "tool_use" && block.id === "toolu_orphan_call") {
          foundOrphan = true;
        }
        if (block.type === "tool_result") {
          // Any surviving tool_result must have a matching tool_use in a prior message.
          // Since the translator produced no matching tool_use, any tool_result here is also orphaned.
          foundOrphan = true;
        }
      }
    }
    expect(foundOrphan).toBe(false);

    // Sanity: the user messages ("please search", "follow up") must still be present —
    // repair should only have pruned the orphan tool_use block and any now-empty msg.
    const userTexts = messages
      .filter((m) => m.role === "user")
      .map((m) => (typeof m.content === "string"
        ? m.content
        : (m.content as Array<Record<string, unknown>>).find((b) => b.type === "text")?.text));
    expect(userTexts).toContain("please search");
    expect(userTexts).toContain("follow up");
  });
});
