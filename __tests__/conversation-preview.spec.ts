import { describe, it, expect } from "bun:test";
import { firstUserPreview } from "../src/observability/conversation-preview.ts";

/**
 * `firstUserPreview` is the backend mirror of the UI's first-user-text
 * heuristic (`src/ui/src/lib/sessions.ts` + `format.splitContextPreamble`). It
 * extracts the first user message's text from a stringified chat request body,
 * strips the forwarded context preamble, and caps the result — so the slim list
 * projection can ship a server-derived `firstUserPreview` and session grouping
 * stays byte-for-byte identical (design decision #2).
 */

describe("firstUserPreview — extraction", () => {
  it("extracts the first user message from an OpenAI-shape body (string content)", () => {
    const body = JSON.stringify({
      model: "gpt",
      messages: [
        { role: "system", content: "you are helpful" },
        { role: "user", content: "What is a closure?" },
        { role: "assistant", content: "..." },
      ],
    });
    expect(firstUserPreview(body)).toBe("What is a closure?");
  });

  it("extracts the first user message from an Anthropic-shape body (array content blocks)", () => {
    const body = JSON.stringify({
      model: "claude",
      max_tokens: 100,
      messages: [
        { role: "user", content: [{ type: "text", text: "Explain promises" }] },
        { role: "assistant", content: [{ type: "text", text: "sure" }] },
      ],
    });
    expect(firstUserPreview(body)).toBe("Explain promises");
  });

  it("returns only the first USER message even when it is not first in the array", () => {
    const body = JSON.stringify({
      messages: [
        { role: "assistant", content: "greeting" },
        { role: "user", content: "second-position question" },
      ],
    });
    expect(firstUserPreview(body)).toBe("second-position question");
  });
});

describe("firstUserPreview — preamble split", () => {
  it("strips a long forwarded-context preamble and returns the trailing user input", () => {
    const preamble = "CONTEXT: ".concat("x".repeat(700)); // > 600 chars → split eligible
    const question = "Now, what does this function do?";
    const body = JSON.stringify({
      messages: [{ role: "user", content: `${preamble}\n\n${question}` }],
    });
    expect(firstUserPreview(body)).toBe(question);
  });

  it("does NOT split a short message even if it contains a blank line", () => {
    const text = "line one\n\nline two";
    const body = JSON.stringify({ messages: [{ role: "user", content: text }] });
    expect(firstUserPreview(body)).toBe(text);
  });
});

describe("firstUserPreview — cap + null cases", () => {
  it("caps the preview at 400 characters by default", () => {
    const long = "a".repeat(1000);
    const body = JSON.stringify({ messages: [{ role: "user", content: long }] });
    const out = firstUserPreview(body);
    expect(out).not.toBeNull();
    expect(out!.length).toBe(400);
    expect(out).toBe("a".repeat(400));
  });

  it("returns null for a null / empty body", () => {
    expect(firstUserPreview(null)).toBeNull();
    expect(firstUserPreview("")).toBeNull();
    expect(firstUserPreview(undefined)).toBeNull();
  });

  it("returns null for an unparseable body", () => {
    expect(firstUserPreview("not json {")).toBeNull();
  });

  it("returns null when there is no messages array (non-chat body)", () => {
    expect(firstUserPreview(JSON.stringify({ prompt: "legacy completion" }))).toBeNull();
  });

  it("returns null when there is no user message at all", () => {
    const body = JSON.stringify({ messages: [{ role: "system", content: "only system" }] });
    expect(firstUserPreview(body)).toBeNull();
  });
});
