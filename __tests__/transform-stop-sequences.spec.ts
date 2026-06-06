import { describe, test, expect } from "bun:test";
import { openaiToAnthropic } from "../src/transform/openai-to-anthropic.ts";

function transform(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const { body } = openaiToAnthropic({
    model: "sonnet",
    messages: [{ role: "user", content: "hi" }],
    ...overrides,
  });
  return body;
}

describe("openaiToAnthropic — stop to stop_sequences mapping", () => {
  test('string stop becomes single-element array', () => {
    const body = transform({ stop: "\n" });
    expect(body.stop_sequences).toEqual(["\n"]);
  });

  test("array stop forwarded as-is", () => {
    const body = transform({ stop: ["STOP", "END"] });
    expect(body.stop_sequences).toEqual(["STOP", "END"]);
  });

  test("empty array omits stop_sequences", () => {
    const body = transform({ stop: [] });
    expect("stop_sequences" in body).toBe(false);
  });

  test("absent stop omits stop_sequences", () => {
    const body = transform();
    expect("stop_sequences" in body).toBe(false);
  });

  test("empty string stop omits stop_sequences", () => {
    const body = transform({ stop: "" });
    expect("stop_sequences" in body).toBe(false);
  });

  test("array containing only empty strings omits stop_sequences", () => {
    const body = transform({ stop: ["", ""] });
    expect("stop_sequences" in body).toBe(false);
  });

  test("mixed array with empty strings — empty entries stripped", () => {
    const body = transform({ stop: ["", "x"] });
    expect(body.stop_sequences).toEqual(["x"]);
  });
});
