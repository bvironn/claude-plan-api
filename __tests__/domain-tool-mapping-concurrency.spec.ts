import { describe, test, expect } from "bun:test";
import {
  createToolMap,
  mapToolName,
  unmapToolName,
} from "../src/domain/tool-mapping.ts";
import { openaiToAnthropic } from "../src/transform/openai-to-anthropic.ts";
import { anthropicToOpenai } from "../src/transform/anthropic-to-openai.ts";

// =============================================================================
// Regression (#1): the dynamic tool map must be PER-REQUEST, not module-global.
//
// Old behaviour: `openaiToAnthropic()` reset module-level `toolMap` /
// `toolMapReverse` at request start. `unmapToolName` was called LATER, mid-
// stream, when the upstream response arrived. A second concurrent request
// reset the global maps between request A's map-build and request A's reverse
// lookup, corrupting A's lookup and leaking B's names into A's response.
//
// Fix: map state lives in a request-scoped object created by `createToolMap()`
// and threaded through `mapToolName(name, map)` / `unmapToolName(name, map)`.
// Two interleaved requests must NOT clobber each other.
// =============================================================================

describe("tool-mapping — per-request scoping (#1)", () => {
  test("createToolMap returns isolated, independently-mutable maps", () => {
    const a = createToolMap();
    const b = createToolMap();
    expect(a).not.toBe(b);

    mapToolName("task", a); // a: task -> mcp_Agent
    // b has NOT seen "task" yet — its reverse map must be empty for mcp_Agent.
    expect(unmapToolName("mcp_Agent", b)).not.toBe("task");
    // a's reverse map resolves correctly.
    expect(unmapToolName("mcp_Agent", a)).toBe("task");
  });

  test("interleaved requests: B starting does NOT clobber A's reverse lookup", () => {
    // ---- Request A: build its map (as openaiToAnthropic would at request start)
    const mapA = createToolMap();
    const wireA = mapToolName("task", mapA); // semantic alias → mcp_Agent
    expect(wireA).toBe("mcp_Agent");

    // ---- Request B starts concurrently and builds ITS OWN map. With the old
    // module-global design this is exactly the moment that reset A's reverse
    // map. With per-request scoping it touches only mapB.
    const mapB = createToolMap();
    const wireB = mapToolName("agent", mapB); // also → mcp_Agent, but in mapB
    expect(wireB).toBe("mcp_Agent");
    // Also map a DIFFERENT tool in B to prove cross-contamination is impossible.
    mapToolName("read", mapB); // mapB: read -> mcp_Read

    // ---- Request A's reverse lookup happens LATER (mid-stream). It MUST still
    // return A's original tool name, unaffected by B's activity.
    expect(unmapToolName("mcp_Agent", mapA)).toBe("task");

    // ---- B's reverse lookup is independent and correct.
    expect(unmapToolName("mcp_Agent", mapB)).toBe("agent");
    expect(unmapToolName("mcp_Read", mapB)).toBe("read");

    // ---- A never learned about B's "read" tool: its reverse map has no entry,
    // so it falls back to the prefix-strip heuristic (lowercased), NOT B's name.
    expect(unmapToolName("mcp_Read", mapA)).toBe("read"); // fallback, not leaked state
    // But crucially A's reverse map does not contain a B-only mapped name as a
    // first-class entry — proven by the dedup-suffix case below.
  });

  test("dedup suffix is per-request: A's mcp_Bash_2 does not leak into B", () => {
    const mapA = createToolMap();
    expect(mapToolName("bash", mapA)).toBe("mcp_Bash");
    expect(mapToolName("Bash", mapA)).toBe("mcp_Bash_2"); // dedup within A
    expect(unmapToolName("mcp_Bash_2", mapA)).toBe("Bash");

    // Fresh request B: "bash" must map to mcp_Bash (no _2 carried over) and B's
    // reverse map for mcp_Bash_2 must NOT resolve to A's "Bash".
    const mapB = createToolMap();
    expect(mapToolName("bash", mapB)).toBe("mcp_Bash");
    expect(unmapToolName("mcp_Bash_2", mapB)).not.toBe("Bash");
  });

  // ===========================================================================
  // End-to-end NON-STREAMING path (the chat.ts stream:false branch).
  //
  // This is the exact gap the earlier #1 fix left open: the non-streaming
  // branch called `anthropicToOpenai(data, model)` with NO map, so it fell back
  // to a module-global reverse map. Under concurrency, request B's
  // openaiToAnthropic() repopulated that global between A's map-build and A's
  // unmap, leaking B's names into A's response.
  //
  // Now both openaiToAnthropic() (forward) and anthropicToOpenai() (reverse)
  // operate on the SAME request-scoped TransformResult.toolMap. The module
  // global was removed entirely, so there is no shared state left to race.
  // ===========================================================================
  test("non-streaming: A's reverse map is not clobbered by B (full transform pipeline)", () => {
    // ---- Request A enters chat.ts: openaiToAnthropic builds A's forward map.
    const reqA = openaiToAnthropic({
      model: "sonnet",
      tools: [
        { type: "function", function: { name: "search", description: "A", parameters: {} } },
      ],
    });
    const wireA = (reqA.body.tools as Array<Record<string, unknown>>)[0]!.name as string;
    expect(wireA).toBe("mcp_Search");

    // ---- Request B starts concurrently and builds ITS OWN forward map for a
    // DIFFERENT original that canonicalizes to the SAME wire name. With the old
    // module-global design this is the exact moment that clobbered A's reverse
    // entry for mcp_Search.
    const reqB = openaiToAnthropic({
      model: "sonnet",
      tools: [
        { type: "function", function: { name: "Search", description: "B", parameters: {} } },
      ],
    });
    // B's "Search" canonicalizes to mcp_Search too; both requests share the
    // wire name but each owns an independent reverse map.
    const wireB = (reqB.body.tools as Array<Record<string, unknown>>)[0]!.name as string;
    expect(wireB).toBe("mcp_Search");

    // ---- A's NON-STREAMING response arrives LATER and is transformed with A's
    // own toolMap (as chat.ts now does: anthropicToOpenai(data, model, toolMap)).
    const responseA = {
      content: [{ type: "tool_use", id: "call_a", name: wireA, input: { q: "x" } }],
    };
    const openaiA = anthropicToOpenai(responseA, "sonnet", reqA.toolMap);
    const toolCallsA = (
      (openaiA.choices as Array<Record<string, unknown>>)[0]!.message as Record<string, unknown>
    ).tool_calls as Array<Record<string, unknown>>;
    // MUST be A's original tool name ("search"), never clobbered to B's "Search".
    expect((toolCallsA[0]!.function as Record<string, unknown>).name).toBe("search");

    // ---- And B's response, transformed with B's map, resolves to B's original.
    const responseB = {
      content: [{ type: "tool_use", id: "call_b", name: wireB, input: {} }],
    };
    const openaiB = anthropicToOpenai(responseB, "sonnet", reqB.toolMap);
    const toolCallsB = (
      (openaiB.choices as Array<Record<string, unknown>>)[0]!.message as Record<string, unknown>
    ).tool_calls as Array<Record<string, unknown>>;
    expect((toolCallsB[0]!.function as Record<string, unknown>).name).toBe("Search");
  });
});
