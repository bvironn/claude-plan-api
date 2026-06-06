import { describe, test, expect } from "bun:test";
import { openaiToAnthropic } from "../src/transform/openai-to-anthropic.ts";

type Block = Record<string, unknown>;

/**
 * Recursively count `cache_control` keys anywhere in the outbound body —
 * walks `system[]`, every `messages[*].content` array (and any nested
 * arrays/objects), and `tools[]`. Used to enforce the Anthropic 4-breakpoint
 * budget ceiling.
 */
function countCacheControl(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (Array.isArray(value)) {
    let n = 0;
    for (const item of value) n += countCacheControl(item);
    return n;
  }
  if (typeof value === "object") {
    let n = 0;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "cache_control") n += 1;
      else n += countCacheControl(v);
    }
    return n;
  }
  return 0;
}

const EPHEMERAL_1H = { type: "ephemeral", ttl: "1h" };

describe("openaiToAnthropic — cache_control breakpoints (last user block + last tool)", () => {
  // --- REQ Last-User / tool_result-only ---
  test("last user = only tool_result blocks → final tool_result carries cache_control; earlier does not", () => {
    const { body } = openaiToAnthropic({
      model: "sonnet",
      messages: [
        { role: "user", content: "start" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_1", function: { name: "read_file", arguments: "{}" } },
            { id: "call_2", function: { name: "read_file", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "first result" },
        { role: "tool", tool_call_id: "call_2", content: "second result" },
      ],
    });

    const messages = body.messages as Array<Record<string, unknown>>;
    const lastUser = messages[messages.length - 1]!;
    expect(lastUser.role).toBe("user");

    const blocks = lastUser.content as Block[];
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.type).toBe("tool_result");
    expect(blocks[1]!.type).toBe("tool_result");

    // Final block has cache_control
    expect(blocks[1]!.cache_control).toEqual(EPHEMERAL_1H);
    // Earlier block does NOT
    expect(blocks[0]!.cache_control).toBeUndefined();
  });

  // --- REQ Last-User / mixed [tool_result, text] ---
  test("last user mixes tool_result + text → only the FINAL block carries cache_control", () => {
    // Use a paired assistant tool_use → user tool_result so repairToolPairs
    // does not strip the tool_result as an orphan, then append a user text
    // turn whose content is a mixed array. The LAST user message ends with
    // a text block preceded by a tool_result block.
    const { body } = openaiToAnthropic({
      model: "sonnet",
      messages: [
        { role: "user", content: "kickoff" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_mix", function: { name: "inspector", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "call_mix", content: "inspector data" },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "call_mix", content: "bonus" },
            { type: "text", text: "please continue" },
          ],
        },
      ],
    });

    const messages = body.messages as Array<Record<string, unknown>>;
    const lastUser = messages[messages.length - 1]!;
    expect(lastUser.role).toBe("user");
    const blocks = lastUser.content as Block[];

    expect(blocks).toHaveLength(2);
    // Final block is the text block
    expect(blocks[1]!.type).toBe("text");
    expect(blocks[1]!.cache_control).toEqual(EPHEMERAL_1H);
    // Earlier tool_result must NOT have cache_control
    expect(blocks[0]!.type).toBe("tool_result");
    expect(blocks[0]!.cache_control).toBeUndefined();
  });

  // --- REQ Last-User / text-only regression ---
  test("last user = array with text block only → text block keeps cache_control (regression)", () => {
    const { body } = openaiToAnthropic({
      model: "sonnet",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "hello" }],
        },
      ],
    });

    const messages = body.messages as Array<Record<string, unknown>>;
    const blocks = messages[0]!.content as Block[];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe("text");
    expect(blocks[0]!.text).toBe("hello");
    expect(blocks[0]!.cache_control).toEqual(EPHEMERAL_1H);
  });

  // --- REQ Last-User / string content ---
  test("last user content is a plain string → normalized to single text block with cache_control", () => {
    const { body } = openaiToAnthropic({
      model: "sonnet",
      messages: [{ role: "user", content: "hi there" }],
    });

    const messages = body.messages as Array<Record<string, unknown>>;
    const blocks = messages[0]!.content as Block[];
    expect(Array.isArray(blocks)).toBe(true);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe("text");
    expect(blocks[0]!.text).toBe("hi there");
    expect(blocks[0]!.cache_control).toEqual(EPHEMERAL_1H);
  });

  // --- REQ Last-Tool / N=1 ---
  test("tools length 1 → tools[0] carries cache_control at tool level", () => {
    const { body } = openaiToAnthropic({
      model: "sonnet",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          type: "function",
          function: {
            name: "only_tool",
            description: "the only tool",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
    });

    const tools = body.tools as Block[];
    expect(tools).toHaveLength(1);
    expect(tools[0]!.cache_control).toEqual(EPHEMERAL_1H);
    // cache_control is a sibling of name/description/input_schema, not inside input_schema
    const schema = tools[0]!.input_schema as Record<string, unknown>;
    expect(schema.cache_control).toBeUndefined();
  });

  // --- REQ Last-Tool / N=3 ---
  test("tools length 3 → only tools[2] carries cache_control", () => {
    const { body } = openaiToAnthropic({
      model: "sonnet",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        { type: "function", function: { name: "a", description: "", parameters: { type: "object", properties: {} } } },
        { type: "function", function: { name: "b", description: "", parameters: { type: "object", properties: {} } } },
        { type: "function", function: { name: "c", description: "", parameters: { type: "object", properties: {} } } },
      ],
    });

    const tools = body.tools as Block[];
    expect(tools).toHaveLength(3);
    expect(tools[0]!.cache_control).toBeUndefined();
    expect(tools[1]!.cache_control).toBeUndefined();
    expect(tools[2]!.cache_control).toEqual(EPHEMERAL_1H);
  });

  // --- REQ Last-Tool / no tools ---
  test("no tools (undefined or empty) → no tool entry carries cache_control", () => {
    const { body: bodyUndef } = openaiToAnthropic({
      model: "sonnet",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(bodyUndef.tools).toBeUndefined();

    const { body: bodyEmpty } = openaiToAnthropic({
      model: "sonnet",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
    });
    // Empty tools array is dropped by the existing if-branch; no tools field set,
    // and no cache_control on anything tool-shaped anywhere.
    expect(bodyEmpty.tools).toBeUndefined();
  });

  // --- REQ Identity regression ---
  test("system[1] identity still carries cache_control (no drift)", () => {
    const { body } = openaiToAnthropic({
      model: "sonnet",
      clean_system: false,  // force identity ON so we can test cache_control on system[1]
      messages: [{ role: "user", content: "hi" }],
    });

    const system = body.system as Block[];
    expect(system).toHaveLength(2);
    expect(system[1]!.text).toBe("You are Claude Code, Anthropic's official CLI for Claude.");
    expect(system[1]!.cache_control).toEqual(EPHEMERAL_1H);
    // billing header (system[0]) must NOT have cache_control
    expect(system[0]!.cache_control).toBeUndefined();
  });

  // --- REQ Budget Ceiling ---
  // This fixture has 2 user messages: the "start" user turn and the tool_result
  // batch user turn. Under S7, with identity on and tools present, budget = 4-1-1=2
  // for user messages. With 2 user messages: last user (slot 1) + intermediate/first
  // user (slot 2) → 4 total breakpoints (identity + tools + last user + intermediate).
  test("realistic request (identity + last-user tool_results + 3 tools) → cache_control count is exactly 4 and ≤ 4", () => {
    const { body } = openaiToAnthropic({
      model: "sonnet",
      clean_system: false,  // force identity ON so the identity cache_control anchor is present
      messages: [
        { role: "user", content: "start" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_x", function: { name: "grep", arguments: "{}" } },
            { id: "call_y", function: { name: "read", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "call_x", content: "x result" },
        { role: "tool", tool_call_id: "call_y", content: "y result" },
      ],
      tools: [
        { type: "function", function: { name: "grep", description: "", parameters: { type: "object", properties: {} } } },
        { type: "function", function: { name: "read", description: "", parameters: { type: "object", properties: {} } } },
        { type: "function", function: { name: "write", description: "", parameters: { type: "object", properties: {} } } },
      ],
    });

    const total = countCacheControl(body);
    expect(total).toBeLessThanOrEqual(4);
    expect(total).toBe(4);
  });
});
