import { describe, test, expect } from "bun:test";
import { openaiToAnthropic } from "../src/transform/openai-to-anthropic.ts";

// =============================================================================
// Regression (#2): assistant message with tool_calls + EMPTY content must NOT
// forward a malformed text block to Anthropic.
//
// Root cause: in openaiToAnthropic's `assistant + tool_calls` branch, the loose
//   if (msg.content) content.push({ type: "text", text: msg.content });
// pushes a text block whenever `msg.content` is truthy. sanitizeOpenAIMessages
// normalizes an assistant message that has tool_calls and `content: null` (or
// an all-empty array) to `content: []`. Because `[]` is truthy, the branch
// pushed `{ type: "text", text: [] }` — a NON-STRING `text` — which Anthropic
// rejects with HTTP 400 ("Input should be a valid string with at least 1
// character").
//
// These cases drive the fix END-TO-END through openaiToAnthropic().
// =============================================================================

/** Collect every text block whose `.text` is not a string (the bug signature). */
function findNonStringTextBlocks(
  messages: Array<Record<string, unknown>>,
): Array<{ messageIndex: number; blockIndex: number }> {
  const hits: Array<{ messageIndex: number; blockIndex: number }> = [];
  messages.forEach((msg, mi) => {
    const c = msg.content;
    if (Array.isArray(c)) {
      (c as Array<Record<string, unknown>>).forEach((block, bi) => {
        if (block && typeof block === "object" && block.type === "text") {
          if (typeof block.text !== "string") {
            hits.push({ messageIndex: mi, blockIndex: bi });
          }
        }
      });
    }
  });
  return hits;
}

/** Find the assistant message that carries tool_use blocks. */
function findAssistantWithToolUse(
  messages: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> | null {
  for (const msg of messages) {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    const blocks = msg.content as Array<Record<string, unknown>>;
    if (blocks.some((b) => b && b.type === "tool_use")) return blocks;
  }
  return null;
}

function buildBody(emptyContent: unknown): Record<string, unknown> {
  return {
    model: "claude-sonnet-4-5",
    messages: [
      { role: "user", content: "run the tool" },
      {
        role: "assistant",
        content: emptyContent,
        tool_calls: [
          {
            id: "tc_1",
            type: "function",
            function: { name: "read_file", arguments: '{"path":"x.ts"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "tc_1", content: "file contents" },
    ],
  };
}

describe("openaiToAnthropic — assistant tool_calls with empty content (#2)", () => {
  const cases: Array<[string, unknown]> = [
    ["null", null],
    ["[] (empty array)", []],
    ['"" (empty string)', ""],
  ];

  for (const [label, emptyContent] of cases) {
    test(`assistant tool_calls + content=${label} → no non-string text block, tool_use survives`, () => {
      const { body } = openaiToAnthropic(buildBody(emptyContent));
      const upstreamMessages = body.messages as Array<Record<string, unknown>>;

      // CORE invariant: NO text block whose `text` is a non-string value.
      expect(findNonStringTextBlocks(upstreamMessages)).toEqual([]);

      // The assistant tool_use block must still be forwarded intact.
      const assistantBlocks = findAssistantWithToolUse(upstreamMessages);
      expect(assistantBlocks).not.toBeNull();
      const toolUseBlocks = assistantBlocks!.filter((b) => b.type === "tool_use");
      expect(toolUseBlocks.length).toBe(1);
      expect((toolUseBlocks[0] as Record<string, unknown>).input).toEqual({
        path: "x.ts",
      });

      // Ideal shape: for empty content there should be NO text block at all on
      // the assistant message — only the tool_use block.
      const textBlocks = assistantBlocks!.filter((b) => b.type === "text");
      expect(textBlocks.length).toBe(0);
    });
  }

  test("assistant tool_calls + real string content → text block preserved alongside tool_use", () => {
    const body = {
      model: "claude-sonnet-4-5",
      messages: [
        { role: "user", content: "run the tool" },
        {
          role: "assistant",
          content: "Let me read that file.",
          tool_calls: [
            {
              id: "tc_1",
              type: "function",
              function: { name: "read_file", arguments: "{}" },
            },
          ],
        },
        { role: "tool", tool_call_id: "tc_1", content: "ok" },
      ],
    };

    const { body: out } = openaiToAnthropic(body as Record<string, unknown>);
    const upstreamMessages = out.messages as Array<Record<string, unknown>>;

    // No malformed text blocks.
    expect(findNonStringTextBlocks(upstreamMessages)).toEqual([]);

    const assistantBlocks = findAssistantWithToolUse(upstreamMessages);
    expect(assistantBlocks).not.toBeNull();
    const textBlocks = assistantBlocks!.filter((b) => b.type === "text");
    expect(textBlocks.length).toBe(1);
    expect((textBlocks[0] as Record<string, unknown>).text).toBe(
      "Let me read that file.",
    );
    expect(assistantBlocks!.filter((b) => b.type === "tool_use").length).toBe(1);
  });

  test("assistant tool_calls + ARRAY content with text+image → blocks spread, no array-wrapped text", () => {
    const body = {
      model: "claude-sonnet-4-5",
      messages: [
        { role: "user", content: "look and run" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Inspecting the screenshot." },
            { type: "image_url", image_url: { url: "https://x/y.png" } },
          ],
          tool_calls: [
            {
              id: "tc_1",
              type: "function",
              function: { name: "read_file", arguments: "{}" },
            },
          ],
        },
        { role: "tool", tool_call_id: "tc_1", content: "ok" },
      ],
    };

    const { body: out } = openaiToAnthropic(body as Record<string, unknown>);
    const upstreamMessages = out.messages as Array<Record<string, unknown>>;

    // No text block with a non-string `text` (no array wrapped as text).
    expect(findNonStringTextBlocks(upstreamMessages)).toEqual([]);

    const assistantBlocks = findAssistantWithToolUse(upstreamMessages);
    expect(assistantBlocks).not.toBeNull();

    // The real text block survives as a proper string.
    const textBlocks = assistantBlocks!.filter((b) => b.type === "text");
    expect(textBlocks.length).toBe(1);
    expect((textBlocks[0] as Record<string, unknown>).text).toBe(
      "Inspecting the screenshot.",
    );

    // The image block was translated to Anthropic-native shape (not dropped,
    // not wrapped).
    const imageBlocks = assistantBlocks!.filter((b) => b.type === "image");
    expect(imageBlocks.length).toBe(1);

    // tool_use still present.
    expect(assistantBlocks!.filter((b) => b.type === "tool_use").length).toBe(1);
  });
});
