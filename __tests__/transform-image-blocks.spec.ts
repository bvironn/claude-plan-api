import { describe, test, expect } from "bun:test";
import {
  openaiToAnthropic,
  toAnthropicContentBlocks,
} from "../src/transform/openai-to-anthropic.ts";

type Block = Record<string, unknown>;

// =============================================================================
// Phase 1 — Pure helper: toAnthropicContentBlocks
// =============================================================================
//
// These tests exercise the helper in isolation. Per spec REQ-Image Block
// Translation and REQ-Drop Policy:
//   - image_url (object form, string form) and input_image translate to
//     Anthropic-native `image` blocks with `base64` or `url` source.
//   - Anthropic-native image blocks pass through unchanged.
//   - Malformed blocks (no extractable URL) are dropped; sibling blocks survive.
//   - Unknown URL schemes (file://, gs://, etc.) are dropped — security guard.
// -----------------------------------------------------------------------------

describe("toAnthropicContentBlocks — pure helper", () => {
  // 1.2: image_url object form with data URI
  test("image_url object form with data:image/png base64 → Anthropic image base64", () => {
    const out = toAnthropicContentBlocks([
      { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo" } },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo" },
    });
  });

  // 1.3: image_url string form with data URI
  test("image_url string form with data:image/jpeg base64 → identical Anthropic image base64", () => {
    const out = toAnthropicContentBlocks([
      { type: "image_url", image_url: "data:image/jpeg;base64,/9j/4AAQSkZJRg" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: "/9j/4AAQSkZJRg" },
    });
  });

  // 1.4: input_image (Responses API) — both object and string url forms
  test("input_image object form (Responses API) translates identically to image_url", () => {
    const out = toAnthropicContentBlocks([
      { type: "input_image", image_url: { url: "data:image/webp;base64,UklGRg" } },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/webp", data: "UklGRg" },
    });
  });

  test("input_image string form (Responses API) translates identically to image_url", () => {
    const out = toAnthropicContentBlocks([
      { type: "input_image", image_url: "data:image/gif;base64,R0lGODdh" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/gif", data: "R0lGODdh" },
    });
  });

  // 1.5: HTTPS URL → url source
  test("image_url with HTTPS URL → Anthropic image url source", () => {
    const out = toAnthropicContentBlocks([
      { type: "image_url", image_url: { url: "https://example.com/x.png" } },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      type: "image",
      source: { type: "url", url: "https://example.com/x.png" },
    });
  });

  test("image_url with HTTP URL (non-TLS) is also accepted as url source", () => {
    const out = toAnthropicContentBlocks([
      { type: "image_url", image_url: { url: "http://example.com/y.jpg" } },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      type: "image",
      source: { type: "url", url: "http://example.com/y.jpg" },
    });
  });

  // 1.6: Anthropic-native image pass-through
  test("Anthropic-native image block passes through unchanged", () => {
    const native: Block = {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "AAAA" },
    };
    const out = toAnthropicContentBlocks([native]);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual(native);
  });

  test("text block passes through unchanged", () => {
    const text: Block = { type: "text", text: "hello" };
    const out = toAnthropicContentBlocks([text]);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual(text);
  });

  // 1.7: malformed image_url adjacent to text → image dropped, text survives
  test("malformed image_url with no url is dropped; sibling text block survives", () => {
    const out = toAnthropicContentBlocks([
      { type: "image_url", image_url: {} },
      { type: "text", text: "hi" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ type: "text", text: "hi" });
  });

  // 1.8: unsupported scheme → drop (security guard)
  test("file:// scheme is dropped (security guard) — block array becomes empty", () => {
    const out = toAnthropicContentBlocks([
      { type: "image_url", image_url: { url: "file:///etc/passwd" } },
    ]);
    expect(out).toHaveLength(0);
  });

  test("gs:// scheme is also dropped", () => {
    const out = toAnthropicContentBlocks([
      { type: "image_url", image_url: { url: "gs://bucket/object.png" } },
    ]);
    expect(out).toHaveLength(0);
  });
});

// =============================================================================
// Phase 2 — End-to-End through openaiToAnthropic
// =============================================================================
//
// These tests prove the helper is wired into BOTH application sites
// (user-array branch and tool-message branch) and that cache_control
// lands on the translated image when it is the last block.
// -----------------------------------------------------------------------------

describe("openaiToAnthropic — vision e2e", () => {
  // 2.1: User content [text, image_url] → translated to [text, image]
  test("user message with mixed [text, image_url] content → translated [text, image]", () => {
    const { body } = openaiToAnthropic({
      model: "sonnet",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "see" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
          ],
        },
      ],
    });

    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(1);
    const blocks = messages[0]!.content as Block[];
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.type).toBe("text");
    expect(blocks[0]!.text).toBe("see");
    expect(blocks[1]!.type).toBe("image");
    expect(blocks[1]!.source).toEqual({
      type: "base64",
      media_type: "image/png",
      data: "AAA",
    });
  });

  // 2.2: Tool message with array content → tool_result.content is ARRAY
  test("role:tool message with array content → tool_result.content is translated array, NOT stringified", () => {
    const { body } = openaiToAnthropic({
      model: "sonnet",
      messages: [
        { role: "user", content: "look at this" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_1", function: { name: "read_image", arguments: "{}" } },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_1",
          content: [
            { type: "text", text: "out" },
            { type: "image_url", image_url: { url: "data:image/png;base64,BBB" } },
          ],
        },
      ],
    });

    const messages = body.messages as Array<Record<string, unknown>>;
    // Last message is the synthetic user-batch carrying the tool_result.
    const last = messages[messages.length - 1]!;
    expect(last.role).toBe("user");
    const blocks = last.content as Block[];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe("tool_result");

    const toolResultContent = blocks[0]!.content;
    expect(Array.isArray(toolResultContent)).toBe(true);
    const inner = toolResultContent as Block[];
    expect(inner).toHaveLength(2);
    expect(inner[0]).toEqual({ type: "text", text: "out" });
    expect(inner[1]!.type).toBe("image");
    expect(inner[1]!.source).toEqual({
      type: "base64",
      media_type: "image/png",
      data: "BBB",
    });
  });

  // 2.3: Tool message with STRING content → unchanged legacy path
  test("role:tool message with string content → tool_result.content === 'ok' (legacy unchanged)", () => {
    const { body } = openaiToAnthropic({
      model: "sonnet",
      messages: [
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_x", function: { name: "do_thing", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "call_x", content: "ok" },
      ],
    });

    const messages = body.messages as Array<Record<string, unknown>>;
    const last = messages[messages.length - 1]!;
    const blocks = last.content as Block[];
    expect(blocks[0]!.type).toBe("tool_result");
    expect(blocks[0]!.content).toBe("ok");
  });

  // 2.4: User with string content → unchanged (no array wrapping by helper)
  test("user with string content → still string (or single text block after cache_control wrap)", () => {
    const { body } = openaiToAnthropic({
      model: "sonnet",
      messages: [{ role: "user", content: "plain" }],
    });

    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(1);
    // addCacheControlToLastUserBlock wraps a string into a single text block.
    // The helper itself must NOT have wrapped it — but the cache_control pass
    // still does. Verify the resulting text equals "plain" exactly.
    const content = messages[0]!.content;
    if (typeof content === "string") {
      expect(content).toBe("plain");
    } else {
      const blocks = content as Block[];
      expect(blocks).toHaveLength(1);
      expect(blocks[0]!.type).toBe("text");
      expect(blocks[0]!.text).toBe("plain");
    }
  });

  // 2.5: cache_control lands on translated image when it is the last block
  test("when last user block is a translated image, cache_control lands on it; type and source intact", () => {
    const { body } = openaiToAnthropic({
      model: "sonnet",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "describe" },
            { type: "image_url", image_url: { url: "data:image/png;base64,CCC" } },
          ],
        },
      ],
    });

    const messages = body.messages as Array<Record<string, unknown>>;
    const blocks = messages[0]!.content as Block[];
    const lastBlock = blocks[blocks.length - 1]!;
    // Block must be the translated `image`, with intact source AND cache_control.
    expect(lastBlock.type).toBe("image");
    expect(lastBlock.source).toEqual({
      type: "base64",
      media_type: "image/png",
      data: "CCC",
    });
    expect(lastBlock.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });
});
