import { describe, test, expect } from "bun:test";
import { openaiToAnthropic } from "../src/transform/openai-to-anthropic.ts";

type Block = Record<string, unknown>;

const EPHEMERAL_1H = { type: "ephemeral", ttl: "1h" };

/**
 * Recursively count `cache_control` keys anywhere in the outbound body.
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

function makeTool(name: string) {
  return {
    type: "function",
    function: { name, description: "", parameters: { type: "object", properties: {} } },
  };
}

/**
 * Find all messages with a given role and return their last content block.
 */
function userMessages(body: Record<string, unknown>): Array<Block[]> {
  const messages = body.messages as Block[];
  return messages
    .filter((m) => m.role === "user")
    .map((m) => m.content as Block[]);
}

describe("cache_control breakpoint planner (S7)", () => {
  // -------------------------------------------------------------------------
  // Billing block exclusion invariant
  // -------------------------------------------------------------------------

  test("system[0] billing block NEVER carries cache_control — slots available", () => {
    const { body } = openaiToAnthropic({
      model: "sonnet",
      clean_system: false, // identity ON — plenty of slots
      messages: [
        { role: "user", content: "msg1" },
        { role: "user", content: "msg2" },
        { role: "user", content: "msg3" },
      ],
    });

    const system = body.system as Block[];
    // system[0] is always the billing header
    expect(system[0]!.cache_control).toBeUndefined();
  });

  test("system[0] billing block has no cache_control when identity is absent (clean_system)", () => {
    const { body } = openaiToAnthropic({
      model: "sonnet",
      clean_system: true, // identity OFF
      messages: [
        { role: "user", content: "msg1" },
        { role: "user", content: "msg2" },
      ],
    });

    const system = body.system as Block[];
    expect(system[0]!.cache_control).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Four breakpoints when all slots active
  // -------------------------------------------------------------------------

  test("four breakpoints when identity on, tools present, 3+ user messages", () => {
    const { body } = openaiToAnthropic({
      model: "sonnet",
      clean_system: false, // identity slot 1
      messages: [
        { role: "user", content: "first user" },
        { role: "user", content: "second user" },
        { role: "user", content: "third user" },
      ],
      tools: [makeTool("search")], // tools slot 2
    });

    const total = countCacheControl(body);
    expect(total).toBe(4);
    // Verify system[0] is not included
    const system = body.system as Block[];
    expect(system[0]!.cache_control).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Two breakpoints when identity off, no tools
  // -------------------------------------------------------------------------

  test("two breakpoints when identity off, no tools, 3+ user messages", () => {
    const { body } = openaiToAnthropic({
      model: "sonnet",
      clean_system: true, // identity OFF
      messages: [
        { role: "user", content: "first user" },
        { role: "user", content: "second user" },
        { role: "user", content: "third user" },
      ],
      // no tools
    });

    const total = countCacheControl(body);
    expect(total).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Intermediate breakpoint placement
  // -------------------------------------------------------------------------

  test("intermediate breakpoint placed on first user message when exactly 2 user messages, tools present, identity off", () => {
    // 2 user messages, tools (slot 1), identity off → budget = 4-0-1 = 3
    // Slots: tool (1) + last user (2) + intermediate/first user (3) = 3 total
    const { body } = openaiToAnthropic({
      model: "sonnet",
      clean_system: true, // identity OFF → budget = 4 - 0 - 1 = 3
      messages: [
        { role: "user", content: "first user" },
        { role: "user", content: "second user" },
      ],
      tools: [makeTool("search")],
    });

    const messages = body.messages as Block[];
    const userMsgs = messages.filter((m) => m.role === "user");
    expect(userMsgs).toHaveLength(2);

    // First user message's last block should have cache_control (intermediate)
    const firstUserContent = userMsgs[0]!.content as Block[];
    const firstLastBlock = firstUserContent[firstUserContent.length - 1]!;
    expect(firstLastBlock.cache_control).toEqual(EPHEMERAL_1H);

    // Last (second) user message's last block should also have cache_control
    const lastUserContent = userMsgs[1]!.content as Block[];
    const lastBlock = lastUserContent[lastUserContent.length - 1]!;
    expect(lastBlock.cache_control).toEqual(EPHEMERAL_1H);
  });

  test("intermediate breakpoint placed on third user message (second-to-last) when 4 user messages exist", () => {
    const { body } = openaiToAnthropic({
      model: "sonnet",
      clean_system: true, // identity OFF
      messages: [
        { role: "user", content: "first user" },
        { role: "user", content: "second user" },
        { role: "user", content: "third user" },
        { role: "user", content: "fourth user" },
      ],
      // no tools → budget = 4 - 0 - 0 = 4
    });

    const messages = body.messages as Block[];
    const userMsgs = messages.filter((m) => m.role === "user");
    expect(userMsgs).toHaveLength(4);

    // Third user message (index 2 = second-to-last) carries intermediate cache_control
    const thirdContent = userMsgs[2]!.content as Block[];
    const thirdLastBlock = thirdContent[thirdContent.length - 1]!;
    expect(thirdLastBlock.cache_control).toEqual(EPHEMERAL_1H);

    // Fourth user message (index 3 = last) carries final cache_control
    const fourthContent = userMsgs[3]!.content as Block[];
    const fourthLastBlock = fourthContent[fourthContent.length - 1]!;
    expect(fourthLastBlock.cache_control).toEqual(EPHEMERAL_1H);

    // First and second user messages should NOT carry cache_control from the planner
    const firstContent = userMsgs[0]!.content as Block[];
    const firstLastBlock = firstContent[firstContent.length - 1]!;
    expect(firstLastBlock.cache_control).toBeUndefined();

    const secondContent = userMsgs[1]!.content as Block[];
    const secondLastBlock = secondContent[secondContent.length - 1]!;
    expect(secondLastBlock.cache_control).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Skip rule: fewer than 2 user messages
  // -------------------------------------------------------------------------

  test("single user message — no intermediate breakpoint placed", () => {
    const { body } = openaiToAnthropic({
      model: "sonnet",
      clean_system: true, // identity OFF
      messages: [{ role: "user", content: "only user" }],
    });

    const messages = body.messages as Block[];
    const userMsgs = messages.filter((m) => m.role === "user");
    expect(userMsgs).toHaveLength(1);

    // Only the single user message gets cache_control (the final slot)
    const content = userMsgs[0]!.content as Block[];
    const lastBlock = content[content.length - 1]!;
    expect(lastBlock.cache_control).toEqual(EPHEMERAL_1H);

    // Total: 1 (no identity, no tools, no intermediate)
    const total = countCacheControl(body);
    expect(total).toBe(1);
  });

  test("zero user messages — no user-message breakpoints placed", () => {
    // A request with only an assistant message (unusual but valid)
    // We need at least one message; use an assistant message.
    // Actually we need to pass messages that are valid for the transform.
    // Let's use a single system message that becomes no user messages.
    // The simplest way: one system-only message (maps to no messages array entries).
    const { body } = openaiToAnthropic({
      model: "sonnet",
      clean_system: true,
      messages: [{ role: "system", content: "only system" }],
    });

    const messages = body.messages as Block[];
    const userMsgs = messages.filter((m) => m.role === "user");
    expect(userMsgs).toHaveLength(0);

    // No user-message cache_control markers
    const userCacheCount = countCacheControl(messages);
    expect(userCacheCount).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Budget exhaustion: intermediate dropped first
  // -------------------------------------------------------------------------

  test("intermediate breakpoint absent when only one user message exists — total three (skip rule, not eviction)", () => {
    // budget = 4 - identity(1) - tools(1) = 2. With only 1 user message there is
    // no second-to-last to anchor the intermediate slot, so it is naturally absent.
    // The eviction-priority invariant is enforced structurally: budget >= 2 always,
    // so the guard in applyCacheBreakpoints never evicts intermediate when >= 2 users exist.
    const { body } = openaiToAnthropic({
      model: "sonnet",
      clean_system: false, // identity ON
      messages: [
        { role: "user", content: "only user" },
      ],
      tools: [makeTool("search")],
    });

    // identity (1) + tool (1) + last user (1) = 3 total
    const total = countCacheControl(body);
    expect(total).toBe(3);

    const messages = body.messages as Block[];
    const userMsgs = messages.filter((m) => m.role === "user");
    expect(userMsgs).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Client-supplied cache_control on messages[] is stripped
  // -------------------------------------------------------------------------

  test("client-supplied cache_control on messages[] content blocks is stripped before planning", () => {
    // The client injects a cache_control marker on a user message content block.
    // After stripping, only the planner's markers should survive.
    const { body } = openaiToAnthropic({
      model: "sonnet",
      clean_system: true, // identity OFF
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "user with injected cache_control",
              cache_control: { type: "ephemeral", ttl: "5m" }, // client marker
            },
          ],
        },
        {
          role: "user",
          content: "second user message",
        },
      ],
      // no tools
    });

    const messages = body.messages as Block[];
    const userMsgs = messages.filter((m) => m.role === "user");
    expect(userMsgs).toHaveLength(2);

    // First user message (intermediate slot): client "5m" marker stripped, planner "1h" marker placed.
    // With 2 user messages and no identity/tools, budget=4 → intermediate IS placed unconditionally.
    const firstContent = userMsgs[0]!.content as Block[];
    const firstBlock = firstContent[firstContent.length - 1]!;
    // Hard assertion — no conditional. Intermediate slot is always filled when budget allows.
    expect(firstBlock.cache_control).toEqual(EPHEMERAL_1H);

    // The "5m" client marker must NOT survive anywhere in messages
    const messagesStr = JSON.stringify(messages);
    expect(messagesStr).not.toContain('"ttl":"5m"');
  });

  // -------------------------------------------------------------------------
  // C1 regression: client cache_control nested inside tool_result.content must be stripped
  // -------------------------------------------------------------------------

  test("client cache_control nested in tool_result.content is stripped — total upstream markers ≤ 4", () => {
    // Reproduces the C1 probe: a tool-role message whose array content carries
    // a client-supplied cache_control marker with ttl:"5m". The strip pass must
    // recurse into block.content arrays (tool_result nesting) so the smuggled
    // marker never reaches the upstream body.
    //
    // Setup: identity ON (slot 1), tools present (slot 2), one user message (slot 3),
    // plus a tool_result carrying a nested cache_control → would be slot 5 without fix.
    const { body } = openaiToAnthropic({
      model: "sonnet",
      clean_system: false, // identity ON — slot 1
      messages: [
        { role: "user", content: "user turn" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "search", arguments: "{}" },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_1",
          // Array content on a tool message → becomes tool_result.content[]
          content: [
            {
              type: "text",
              text: "tool result text",
              cache_control: { type: "ephemeral", ttl: "5m" }, // smuggled client marker
            },
          ],
        },
        { role: "user", content: "follow-up" },
      ],
      tools: [makeTool("search")], // tools present — slot 2
    });

    // The total upstream cache_control count MUST NOT exceed 4.
    const total = countCacheControl(body);
    expect(total).toBeLessThanOrEqual(4);

    // The client's "5m" ttl marker must not survive anywhere in the body.
    const bodyStr = JSON.stringify(body);
    expect(bodyStr).not.toContain('"ttl":"5m"');
  });

  // -------------------------------------------------------------------------
  // Post-repair placement — discriminating fixture
  // -------------------------------------------------------------------------

  test("planner runs after repairToolPairs: breakpoint lands on surviving user block, not on orphaned tool_result", () => {
    // Discriminating fixture: the orphaned tool_result message is LAST in the
    // conversation (as an OpenAI "tool" role), so in Anthropic format it becomes
    // the last "user" message before repair.
    //
    // Under the pre-change pipeline (planner before repair):
    //   1. Planner sees the orphaned tool_result batch as last "user" message.
    //   2. Planner places cache_control on its last block.
    //   3. repairToolPairs removes the orphan batch → cache_control gone.
    //   4. The real last user message has NO breakpoint. ← WRONG
    //
    // Under the fixed pipeline (repair then planner):
    //   1. repairToolPairs removes the orphan batch first.
    //   2. Planner sees only the real user message as last user.
    //   3. Planner places cache_control on the real last user message. ← CORRECT
    //
    // This fixture FAILS under the pre-change order and PASSES under the
    // planner-after-repairToolPairs order.
    const { body } = openaiToAnthropic({
      model: "sonnet",
      clean_system: true, // identity OFF, no tools → budget = 4
      messages: [
        { role: "user", content: "real user message" },
        // orphaned tool_result (no preceding assistant tool_use) appended LAST
        { role: "tool", tool_call_id: "orphan_id", content: "orphan result" },
      ],
    });

    const messages = body.messages as Block[];
    const userMsgs = messages.filter((m) => m.role === "user");

    // After repair the orphan batch is gone → exactly 1 user message remains.
    expect(userMsgs).toHaveLength(1);

    // That surviving user message MUST carry the breakpoint.
    const lastUser = userMsgs[userMsgs.length - 1]!;
    const content = lastUser.content as Block[];
    const lastBlock = content[content.length - 1]!;
    // Hard assertion — no conditional. Planner must have placed the marker here.
    expect(lastBlock.cache_control).toEqual(EPHEMERAL_1H);

    // Total: exactly 1 (no identity, no tools, no intermediate — only 1 user).
    const total = countCacheControl(body);
    expect(total).toBe(1);
  });
});
