import { describe, test, expect } from "bun:test";
import {
  openaiToAnthropic,
  CONTEXT_PREAMBLE,
} from "../src/transform/openai-to-anthropic.ts";

type Block = Record<string, unknown>;

function firstMessage(result: { body: Record<string, unknown> }) {
  const messages = result.body.messages as Array<Record<string, unknown>>;
  return messages[0]!;
}

describe("openaiToAnthropic — client system prompt forwarding", () => {
  // --- REQ-1: Forward client system prompt as first-user-message prefix ---
  test("REQ-1: single system + user message — preamble+system prepended to first user message", () => {
    const { body } = openaiToAnthropic({
      model: "sonnet",
      messages: [
        { role: "system", content: "You are OpenCode" },
        { role: "user", content: "hi" },
      ],
    });

    const msg = (body.messages as Array<Record<string, unknown>>)[0]!;
    // After addCacheControlToLastUserText the string content is wrapped into
    // an array with a single text block. Extract the text from whichever
    // shape is present.
    let text: string;
    if (typeof msg.content === "string") {
      text = msg.content;
    } else {
      const blocks = msg.content as Block[];
      const textBlock = blocks.find((b) => b.type === "text");
      text = (textBlock?.text as string) ?? "";
    }

    expect(text).toBe(`${CONTEXT_PREAMBLE}You are OpenCode\n\nhi`);
  });

  // --- REQ-2: Preserve Anthropic system[] block layout ---
  test("REQ-2: system[] retains exactly billing + identity (no client prompt leaks in)", () => {
    const { body } = openaiToAnthropic({
      model: "sonnet",
      messages: [
        { role: "system", content: "LEAK-CANARY-CLIENT-PROMPT" },
        { role: "user", content: "hi" },
      ],
    });

    const system = body.system as Block[];
    expect(system).toHaveLength(2);

    // First: billing header; second: Claude Code identity. Neither may include
    // the client prompt text.
    const billing = system[0]!.text as string;
    const identity = system[1]!.text as string;

    expect(billing.startsWith("x-anthropic-billing-header:")).toBe(true);
    expect(identity).toBe("You are Claude Code, Anthropic's official CLI for Claude.");
    expect(billing.includes("LEAK-CANARY-CLIENT-PROMPT")).toBe(false);
    expect(identity.includes("LEAK-CANARY-CLIENT-PROMPT")).toBe(false);
  });

  // --- REQ-3: No injection when no client system prompt ---
  test("REQ-3: user-only input — no preamble prepended", () => {
    const { body } = openaiToAnthropic({
      model: "sonnet",
      messages: [{ role: "user", content: "hi" }],
    });

    const msg = (body.messages as Array<Record<string, unknown>>)[0]!;
    // Content is an array after addCacheControlToLastUserText; verify the
    // single text block is exactly "hi" with no preamble.
    const blocks = msg.content as Block[];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe("text");
    expect(blocks[0]!.text).toBe("hi");
    // CONTEXT_PREAMBLE is now "" (aligned with the plugin). The absence of
    // a client system prompt is simply tested by the text equality above.
  });

  // --- REQ-4: No injection on empty system prompt ---
  test("REQ-4: empty-string system message is a no-op", () => {
    const { body } = openaiToAnthropic({
      model: "sonnet",
      messages: [
        { role: "system", content: "" },
        { role: "user", content: "hi" },
      ],
    });

    const msg = (body.messages as Array<Record<string, unknown>>)[0]!;
    const blocks = msg.content as Block[];
    const textBlock = blocks.find((b) => b.type === "text")!;
    expect(textBlock.text).toBe("hi");
    // Empty-string system is equivalent to no system (tested by text=="hi").
  });

  // --- REQ-5: Handle string content on first user message ---
  test("REQ-5: string content — prefix via concatenation", () => {
    const { body } = openaiToAnthropic({
      model: "sonnet",
      messages: [
        { role: "system", content: "A" },
        { role: "user", content: "hi" },
      ],
    });

    const msg = (body.messages as Array<Record<string, unknown>>)[0]!;
    // addCacheControlToLastUserText wraps strings into array form. Before
    // that wrapping our injection ran on a string; verify the resulting
    // text equals the expected concatenation.
    const blocks = msg.content as Block[];
    const textBlock = blocks.find((b) => b.type === "text")!;
    expect(textBlock.text).toBe(`${CONTEXT_PREAMBLE}A\n\nhi`);
  });

  // --- REQ-6: Handle array content with existing text block ---
  test("REQ-6: array content with text block — text block is mutated, length preserved", () => {
    const { body } = openaiToAnthropic({
      model: "sonnet",
      messages: [
        { role: "system", content: "A" },
        {
          role: "user",
          content: [
            { type: "text", text: "hi" },
            { type: "image_url", image_url: { url: "data:image/png;base64,x" } },
          ],
        },
      ],
    });

    const msg = (body.messages as Array<Record<string, unknown>>)[0]!;
    const blocks = msg.content as Block[];
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.type).toBe("text");
    expect(blocks[0]!.text).toBe(`${CONTEXT_PREAMBLE}A\n\nhi`);
    expect(blocks[1]!.type).toBe("image_url");
  });

  // --- REQ-7: Handle array content without text block ---
  test("REQ-7: image-only first user — new text block unshifted at index 0", () => {
    const { body } = openaiToAnthropic({
      model: "sonnet",
      messages: [
        { role: "system", content: "A" },
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: "data:image/png;base64,x" } },
          ],
        },
      ],
    });

    const msg = (body.messages as Array<Record<string, unknown>>)[0]!;
    const blocks = msg.content as Block[];
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.type).toBe("text");
    expect(blocks[0]!.text).toBe(`${CONTEXT_PREAMBLE}A\n\n`);
    expect(blocks[1]!.type).toBe("image_url");
  });

  // --- REQ-8: Drop client system when no user message exists ---
  test("REQ-8: system + assistant only — client system dropped silently, no synthetic user", () => {
    const { body } = openaiToAnthropic({
      model: "sonnet",
      messages: [
        { role: "system", content: "A" },
        { role: "assistant", content: "hello back" },
      ],
    });

    const messages = body.messages as Array<Record<string, unknown>>;
    // Only the assistant survives; no user message was synthesized.
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe("assistant");
    // Client system "A" never appears in the body because there's no user
    // message to prepend it to. Verify "A" is gone.
    const serialized = JSON.stringify(body);
    expect(serialized.includes("\"A\"")).toBe(false);
    expect(serialized.includes("A\\n\\n")).toBe(false);
  });

  // --- REQ-9: Prefix only the first user message ---
  test("REQ-9: multi-turn — only first user message is prefixed, later user turns untouched", () => {
    const { body } = openaiToAnthropic({
      model: "sonnet",
      messages: [
        { role: "system", content: "A" },
        { role: "user", content: "first" },
        { role: "assistant", content: "reply" },
        { role: "user", content: "second" },
      ],
    });

    const messages = body.messages as Array<Record<string, unknown>>;
    // [0] user (prefixed), [1] assistant, [2] user (untouched)
    expect(messages[0]!.role).toBe("user");
    expect(messages[1]!.role).toBe("assistant");
    expect(messages[2]!.role).toBe("user");

    // First user content may be a string (only the LAST user message gets
    // wrapped into an array by addCacheControlToLastUserText).
    const firstContent = messages[0]!.content;
    let firstText: string;
    if (typeof firstContent === "string") {
      firstText = firstContent;
    } else {
      const firstBlocks = firstContent as Block[];
      firstText = (firstBlocks.find((b) => b.type === "text")!.text as string);
    }
    expect(firstText.startsWith(`${CONTEXT_PREAMBLE}A\n\n`)).toBe(true);
    expect(firstText).toBe(`${CONTEXT_PREAMBLE}A\n\nfirst`);

    // Second user turn must be untouched — plain string "second", no prefix.
    // Note: addCacheControlToLastUserText converts the LAST user text to an
    // array-with-cache-control. So messages[2].content is an array with one
    // text block whose text === "second".
    const secondContent = messages[2]!.content;
    if (typeof secondContent === "string") {
      expect(secondContent).toBe("second");
    } else {
      const secondBlocks = secondContent as Block[];
      const secondText = (secondBlocks.find((b) => b.type === "text")!.text as string);
      expect(secondText).toBe("second");
      // Also verify the client system "A" didn't leak into the later turn.
      expect(secondText.startsWith("A\n\n")).toBe(false);
    }
  });

  // --- REQ-10: No regressions — billing header stable vs original user text ---
  test("REQ-10: billing header is computed from ORIGINAL first user text (not preamble+system)", () => {
    // Same user text "hi", two different client system prompts. The billing
    // header (which hashes the first user text) must be IDENTICAL across
    // both calls — proving billing sees the original text, not the injected
    // preamble.
    const a = openaiToAnthropic({
      model: "sonnet",
      messages: [
        { role: "system", content: "Persona A — long detailed persona" },
        { role: "user", content: "hi" },
      ],
    });
    const b = openaiToAnthropic({
      model: "sonnet",
      messages: [
        { role: "system", content: "Persona B — completely different" },
        { role: "user", content: "hi" },
      ],
    });

    const billingA = (a.body.system as Block[])[0]!.text as string;
    const billingB = (b.body.system as Block[])[0]!.text as string;

    expect(billingA).toBe(billingB);
    expect(billingA.startsWith("x-anthropic-billing-header:")).toBe(true);
  });
});
