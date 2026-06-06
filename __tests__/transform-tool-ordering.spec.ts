import { describe, test, expect } from "bun:test";
import { openaiToAnthropic } from "../src/transform/openai-to-anthropic.ts";

type Block = Record<string, unknown>;

function makeTool(name: string) {
  return {
    type: "function",
    function: {
      name,
      description: `${name} tool`,
      parameters: { type: "object", properties: {} },
    },
  };
}

function transform(tools: unknown[], overrides: Record<string, unknown> = {}) {
  return openaiToAnthropic({
    model: "sonnet",
    messages: [{ role: "user", content: "hi" }],
    tools,
    ...overrides,
  });
}

describe("openaiToAnthropic — deterministic tool ordering", () => {
  test("tools in non-alphabetical order are sorted before mapping", () => {
    // Client sends ["search", "calculator", "fetch"] — should become alpha order
    const { body } = transform([
      makeTool("search"),
      makeTool("calculator"),
      makeTool("fetch"),
    ]);

    const tools = body.tools as Block[];
    expect(tools).toHaveLength(3);
    // After sort: calculator < fetch < search
    expect(tools[0]!.name).toBe("mcp_Calculator");
    expect(tools[1]!.name).toBe("mcp_Fetch");
    expect(tools[2]!.name).toBe("mcp_Search");
  });

  test("same tool set in two different arrival orders produces identical upstream arrays", () => {
    // Request A: ["b_tool", "a_tool"]
    const { body: bodyA } = transform([makeTool("b_tool"), makeTool("a_tool")]);
    // Request B: ["a_tool", "b_tool"]
    const { body: bodyB } = transform([makeTool("a_tool"), makeTool("b_tool")]);

    const toolsA = bodyA.tools as Block[];
    const toolsB = bodyB.tools as Block[];

    expect(toolsA).toHaveLength(2);
    expect(toolsB).toHaveLength(2);

    // Both should have same order
    expect(toolsA[0]!.name).toEqual(toolsB[0]!.name);
    expect(toolsA[1]!.name).toEqual(toolsB[1]!.name);

    // cache_control should be on the same last element in both
    expect(toolsA[1]!.cache_control).toBeDefined();
    expect(toolsB[1]!.cache_control).toBeDefined();
    expect(toolsA[0]!.cache_control).toBeUndefined();
    expect(toolsB[0]!.cache_control).toBeUndefined();
  });

  test("cache_control lands on the last tool after sort (z_tool > a_tool)", () => {
    // ["z_tool", "a_tool"] — after sort: a_tool, z_tool; cache_control on z_tool
    // a_tool → mcp_ATool (snake_case PascalCase), z_tool → mcp_ZTool
    const { body } = transform([makeTool("z_tool"), makeTool("a_tool")]);

    const tools = body.tools as Block[];
    expect(tools).toHaveLength(2);
    // a_tool comes first after sort
    expect(tools[0]!.name).toBe("mcp_ATool");
    // z_tool is last — must carry cache_control
    expect(tools[1]!.name).toBe("mcp_ZTool");
    expect(tools[1]!.cache_control).toBeDefined();
    expect(tools[0]!.cache_control).toBeUndefined();
  });

  test("single tool is unaffected by sort", () => {
    const { body } = transform([makeTool("only_tool")]);
    const tools = body.tools as Block[];
    expect(tools).toHaveLength(1);
    expect(tools[0]!.cache_control).toBeDefined();
  });

  test("body.tools original array is NOT mutated by the sort", () => {
    const original = [makeTool("z_tool"), makeTool("a_tool")];
    const originalOrder = original.map((t) => t.function.name);

    transform(original);

    // Original array should still be in the same order
    expect(original.map((t) => t.function.name)).toEqual(originalOrder);
  });

  test("tool_choice named function lookup still works after sort", () => {
    // The ToolMap must be keyed by client name, so tool_choice lookup
    // must succeed regardless of sort order.
    // a_tool → mcp_ATool (snake_case PascalCase via autoCanonical)
    const { body } = transform(
      [makeTool("z_tool"), makeTool("a_tool")],
      { tool_choice: { type: "function", function: { name: "a_tool" } } },
    );

    // tool_choice must resolve to the mapped name for a_tool
    const tc = body.tool_choice as Block;
    expect(tc.type).toBe("tool");
    expect(tc.name).toBe("mcp_ATool");
  });
});
