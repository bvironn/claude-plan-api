import { describe, test, expect, spyOn, afterEach } from "bun:test";
import { openaiToAnthropic } from "../src/transform/openai-to-anthropic.ts";
import * as logger from "../src/observability/logger.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tool(name: string, extra?: Record<string, unknown>) {
  return {
    type: "function" as const,
    function: { name, description: "desc", parameters: { type: "object", properties: {} }, ...extra },
  };
}

function transformWithTools(
  toolNames: string[],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const { body } = openaiToAnthropic({
    model: "sonnet",
    messages: [{ role: "user", content: "hi" }],
    tools: toolNames.map((n) => tool(n)),
    ...overrides,
  });
  return body;
}

// ---------------------------------------------------------------------------
// tool_choice string mappings (Tasks 2.1)
// ---------------------------------------------------------------------------

describe("openaiToAnthropic — tool_choice string mapping", () => {
  test('"none" maps to {type:"none"}', () => {
    const body = transformWithTools(["my_func"], { tool_choice: "none" });
    expect(body.tool_choice).toEqual({ type: "none" });
  });

  test('"required" maps to {type:"any"}', () => {
    const body = transformWithTools(["my_func"], { tool_choice: "required" });
    expect((body.tool_choice as Record<string, unknown>).type).toBe("any");
  });

  test('"auto" maps to {type:"auto"}', () => {
    const body = transformWithTools(["my_func"], { tool_choice: "auto" });
    expect((body.tool_choice as Record<string, unknown>).type).toBe("auto");
  });

  test("absent tool_choice defaults to {type:\"auto\"} when tools present", () => {
    const body = transformWithTools(["my_func"]);
    expect((body.tool_choice as Record<string, unknown>).type).toBe("auto");
  });
});

// ---------------------------------------------------------------------------
// tool_choice object mapping — named function (Task 2.1)
// ---------------------------------------------------------------------------

describe("openaiToAnthropic — tool_choice named function", () => {
  test("named function resolves via ToolMap to mcp_-prefixed name", () => {
    const body = transformWithTools(["my_func"], {
      tool_choice: { type: "function", function: { name: "my_func" } },
    });
    const tc = body.tool_choice as Record<string, unknown>;
    expect(tc.type).toBe("tool");
    // mcp_ prefix is applied by mapToolName; my_func → mcp_MyFunc
    expect(typeof tc.name).toBe("string");
    expect((tc.name as string).startsWith("mcp_")).toBe(true);
    expect((tc.name as string).toLowerCase()).toContain("myfunc");
  });

  test("unknown function name falls back to {type:\"auto\"} and emits warn", () => {
    const emitSpy = spyOn(logger, "emit");
    try {
      const body = transformWithTools(["my_func"], {
        tool_choice: { type: "function", function: { name: "unknown_func" } },
      });
      const tc = body.tool_choice as Record<string, unknown>;
      expect(tc.type).toBe("auto");

      const warnCalls = emitSpy.mock.calls.filter(
        (c) => c[0] === "warn" && c[1] === "transform.tool_choice.unknown_function",
      );
      expect(warnCalls.length).toBeGreaterThanOrEqual(1);
    } finally {
      emitSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// parallel_tool_calls mapping (Task 2.2)
// ---------------------------------------------------------------------------

describe("openaiToAnthropic — parallel_tool_calls", () => {
  test("parallel_tool_calls:false adds disable_parallel_tool_use:true", () => {
    const body = transformWithTools(["my_func"], { parallel_tool_calls: false });
    const tc = body.tool_choice as Record<string, unknown>;
    expect(tc.disable_parallel_tool_use).toBe(true);
  });

  test("parallel_tool_calls:false + tool_choice:required → {type:any, disable_parallel_tool_use:true}", () => {
    const body = transformWithTools(["my_func"], {
      parallel_tool_calls: false,
      tool_choice: "required",
    });
    const tc = body.tool_choice as Record<string, unknown>;
    expect(tc.type).toBe("any");
    expect(tc.disable_parallel_tool_use).toBe(true);
  });

  test('parallel_tool_calls:false + tool_choice:"none" → {type:none} WITHOUT disable_parallel_tool_use', () => {
    const body = transformWithTools(["my_func"], {
      parallel_tool_calls: false,
      tool_choice: "none",
    });
    const tc = body.tool_choice as Record<string, unknown>;
    expect(tc.type).toBe("none");
    expect(tc.disable_parallel_tool_use).toBeUndefined();
  });

  test("parallel_tool_calls absent → no disable_parallel_tool_use", () => {
    const body = transformWithTools(["my_func"]);
    const tc = body.tool_choice as Record<string, unknown>;
    expect(tc.disable_parallel_tool_use).toBeUndefined();
  });

  test("parallel_tool_calls:true → no disable_parallel_tool_use", () => {
    const body = transformWithTools(["my_func"], { parallel_tool_calls: true });
    const tc = body.tool_choice as Record<string, unknown>;
    expect(tc.disable_parallel_tool_use).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// strict forwarding (Task 2.3)
// ---------------------------------------------------------------------------

describe("openaiToAnthropic — strict forwarding", () => {
  test("tool with function.strict:true → upstream tool includes strict:true", () => {
    const { body } = openaiToAnthropic({
      model: "sonnet",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          type: "function",
          function: {
            name: "strict_func",
            description: "a strict function",
            parameters: { type: "object", properties: {} },
            strict: true,
          },
        },
      ],
    });
    const tools = body.tools as Array<Record<string, unknown>>;
    expect(tools[0]?.strict).toBe(true);
  });

  test("tool without strict → upstream tool has no strict field", () => {
    const { body } = openaiToAnthropic({
      model: "sonnet",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          type: "function",
          function: {
            name: "no_strict_func",
            description: "no strict",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
    });
    const tools = body.tools as Array<Record<string, unknown>>;
    expect("strict" in tools[0]!).toBe(false);
  });
});
