import { describe, test, expect } from "bun:test";
import {
  createToolMap,
  mapToolName,
  unmapToolName,
} from "../src/domain/tool-mapping.ts";

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
});
