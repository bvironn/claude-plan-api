import { describe, test, expect } from "bun:test";
import {
  openaiToAnthropic,
  CONTEXT_PREAMBLE,
} from "../src/transform/openai-to-anthropic.ts";

type Block = Record<string, unknown>;

function firstUserText(body: Record<string, unknown>): string {
  const msg = (body.messages as Array<Record<string, unknown>>)[0]!;
  if (typeof msg.content === "string") return msg.content;
  const blocks = msg.content as Block[];
  return (blocks.find((b) => b.type === "text")?.text as string) ?? "";
}

// OpenAI's `developer` role (o1+ models) is the system-level instruction
// channel. Anthropic only accepts `user`/`assistant` in messages[] and takes
// system as a separate field. To be truly OpenAI-compatible, the gateway must
// treat `developer` exactly like `system`: collect it and forward it (via the
// first-user-message prefix, the same OAuth-400 mitigation used for system).
describe("openaiToAnthropic — developer role (OpenAI o1+ system channel)", () => {
  // --- REQ-1: developer collected as system prompt, prepended to first user ---
  test("REQ-1: single developer + user — developer text prepended to first user message", () => {
    const { body } = openaiToAnthropic({
      model: "sonnet",
      messages: [
        { role: "developer", content: "You are OpenCode" },
        { role: "user", content: "hi" },
      ],
    });

    expect(firstUserText(body)).toBe(`${CONTEXT_PREAMBLE}You are OpenCode\n\nhi`);
  });

  // --- REQ-2: developer must NOT leak as a message role into messages[] ---
  test("REQ-2: no message carries role 'developer' (Anthropic would 400)", () => {
    const { body } = openaiToAnthropic({
      model: "sonnet",
      messages: [
        { role: "developer", content: "instructions" },
        { role: "user", content: "hi" },
      ],
    });

    const messages = body.messages as Array<Record<string, unknown>>;
    for (const m of messages) {
      expect(m.role).not.toBe("developer");
    }
    // Only the user message survives in messages[].
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe("user");
  });

  // --- REQ-3: developer + system both present → concatenated in array order ---
  test("REQ-3: developer + system concatenated in order, then prepended to user", () => {
    const { body } = openaiToAnthropic({
      model: "sonnet",
      messages: [
        { role: "developer", content: "DEV" },
        { role: "system", content: "SYS" },
        { role: "user", content: "hi" },
      ],
    });

    expect(firstUserText(body)).toBe(`${CONTEXT_PREAMBLE}DEV\n\nSYS\n\nhi`);
  });

  // --- REQ-4: developer never reaches system[] directly (OAuth-400 path) ---
  test("REQ-4: system[] stays billing-only — developer text does not leak there", () => {
    const { body } = openaiToAnthropic({
      model: "sonnet",
      clean_system: true, // billing-only, no identity
      messages: [
        { role: "developer", content: "LEAK-CANARY-DEV" },
        { role: "user", content: "hi" },
      ],
    });

    const system = body.system as Block[];
    expect(system).toHaveLength(1);
    expect((system[0]!.text as string).startsWith("x-anthropic-billing-header:")).toBe(true);
    for (const entry of system) {
      expect((entry.text as string).includes("LEAK-CANARY-DEV")).toBe(false);
    }
  });

  // --- REQ-5: empty developer message is a no-op (mirrors empty system) ---
  test("REQ-5: empty-string developer message does not inject a prefix", () => {
    const { body } = openaiToAnthropic({
      model: "sonnet",
      messages: [
        { role: "developer", content: "" },
        { role: "user", content: "hi" },
      ],
    });

    expect(firstUserText(body)).toBe("hi");
  });
});
