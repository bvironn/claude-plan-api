import { describe, test, expect, beforeEach } from "bun:test";
import {
  mapToolName,
  unmapToolName,
  resetDynamicMap,
} from "../src/domain/tool-mapping.ts";

beforeEach(() => {
  resetDynamicMap();
});

describe("mapToolName — wire-format prefix", () => {
  test("single-word input gets prefixed and PascalCased", () => {
    expect(mapToolName("bash")).toBe("mcp_Bash");
  });

  test("already-prefixed input is not double-prefixed", () => {
    expect(mapToolName("mcp_Bash")).toBe("mcp_Bash");
  });
});

describe("mapToolName — unconditional first-char uppercase (REGRESSION)", () => {
  test("namespaced lowercase (production regression: engram__mem_save)", () => {
    expect(mapToolName("engram__mem_save")).toBe("mcp_Engram__mem_save");
  });

  test("namespaced variant: engram__mem_search", () => {
    expect(mapToolName("engram__mem_search")).toBe("mcp_Engram__mem_search");
  });

  test("triple-namespaced: foo__bar__baz", () => {
    expect(mapToolName("foo__bar__baz")).toBe("mcp_Foo__bar__baz");
  });

  test("already PascalCase passthrough — no double-cap, no internal mutation", () => {
    expect(mapToolName("WebFetch")).toBe("mcp_WebFetch");
  });
});

describe("mapToolName — canonicalization precedence", () => {
  test("alias map wins over autoCanonical: task → Agent (semantic)", () => {
    expect(mapToolName("task")).toBe("mcp_Agent");
  });

  test("alias map wins for compound words: webfetch → WebFetch", () => {
    expect(mapToolName("webfetch")).toBe("mcp_WebFetch");
  });

  test("autoCanonical handles snake_case: web_search → WebSearch", () => {
    expect(mapToolName("web_search")).toBe("mcp_WebSearch");
  });

  test("sanitization fallback applies casing: my-weird.tool → My_weird_tool", () => {
    expect(mapToolName("my-weird.tool")).toBe("mcp_My_weird_tool");
  });

  test("leading-digit sanitization with casing: 1password → T1password", () => {
    expect(mapToolName("1password")).toBe("mcp_T1password");
  });
});

describe("mapToolName — idempotence", () => {
  test("stable on already-correct wire name: mcp_Bash → mcp_Bash", () => {
    expect(mapToolName("mcp_Bash")).toBe("mcp_Bash");
  });

  test("corrects pre-prefixed lowercase: mcp_engram__mem_save → mcp_Engram__mem_save", () => {
    expect(mapToolName("mcp_engram__mem_save")).toBe("mcp_Engram__mem_save");
  });

  // Idempotence property — feeding the output back into mapToolName must yield
  // the same wire name. Different keys in the toolMap (the input is now the
  // wire name itself) but the result must be stable.
  test("property: mapToolName(mapToolName(x)) === mapToolName(x) for all inputs", () => {
    const inputs = [
      "bash",
      "mcp_Bash",
      "engram__mem_save",
      "engram__mem_search",
      "foo__bar__baz",
      "WebFetch",
      "task",
      "webfetch",
      "web_search",
      "my-weird.tool",
      "1password",
      "mcp_engram__mem_save",
    ];
    for (const x of inputs) {
      // Each input gets a fresh map so the dedup loop doesn't disambiguate
      // collisions across the property check (e.g. "bash" and "mcp_Bash" both
      // canonicalize to "mcp_Bash" — without a reset the second would become
      // "mcp_Bash_2" and break the property).
      resetDynamicMap();
      const once = mapToolName(x);
      const twice = mapToolName(once);
      expect(twice).toBe(once);
    }
  });
});

describe("unmapToolName — round-trip", () => {
  test("round-trip preserves original input via reverse map", () => {
    const wire = mapToolName("engram__mem_save");
    expect(wire).toBe("mcp_Engram__mem_save");
    expect(unmapToolName(wire)).toBe("engram__mem_save");
  });
});
