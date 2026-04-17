import { describe, test, expect } from "bun:test";
import { openaiToAnthropic } from "../src/transform/openai-to-anthropic.ts";
import { MODEL_CAPABILITIES, getModelCapabilities } from "../src/domain/models.ts";

describe("openaiToAnthropic — model capability gating", () => {
  // --- REQ-1: Adaptive thinking gated off for legacy models ---
  test("REQ-1: claude-sonnet-4-5-20250929 does NOT get adaptive thinking", () => {
    const { body } = openaiToAnthropic({
      model: "claude-sonnet-4-5-20250929",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(body.thinking).toBeUndefined();
  });

  // --- REQ-1 (positive): Adaptive thinking gated on for capable models ---
  test("REQ-2: claude-sonnet-4-6 gets adaptive thinking", () => {
    const { body } = openaiToAnthropic({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(body.thinking).toEqual({ type: "adaptive" });
  });

  // --- REQ-2: Context management gated off for non-capable models ---
  test("REQ-3: claude-opus-4-5-20251101 does NOT get context_management", () => {
    const { body } = openaiToAnthropic({
      model: "claude-opus-4-5-20251101",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(body.context_management).toBeUndefined();
  });

  // Positive counterpart for context_management — forces real logic (triangulation)
  test("REQ-3b: claude-opus-4-6 DOES get context_management", () => {
    const { body } = openaiToAnthropic({
      model: "claude-opus-4-6",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(body.context_management).toEqual({
      edits: [{ type: "clear_thinking_20251015", keep: "all" }],
    });
  });

  // --- REQ-3: Output effort gated off for non-capable models ---
  test("REQ-4: claude-haiku-4-5-20251001 omits output_config.effort", () => {
    const { body } = openaiToAnthropic({
      model: "claude-haiku-4-5-20251001",
      messages: [{ role: "user", content: "hi" }],
    });
    const outputConfig = body.output_config as Record<string, unknown> | undefined;
    // Either output_config is entirely absent, or it exists but has no `effort`
    if (outputConfig !== undefined) {
      expect(outputConfig.effort).toBeUndefined();
    } else {
      expect(outputConfig).toBeUndefined();
    }
  });

  // Positive counterpart for output effort
  test("REQ-4b: claude-sonnet-4-6 gets output_config.effort = medium", () => {
    const { body } = openaiToAnthropic({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(body.output_config).toEqual({ effort: "medium" });
  });

  // --- REQ-4: Structured output bypass — all three features suppressed ---
  test("REQ-5: structured output suppresses thinking, context_management, and effort", () => {
    const { body } = openaiToAnthropic({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
      response_format: {
        type: "json_schema",
        json_schema: { schema: { type: "object", properties: {} } },
      },
    });
    expect(body.thinking).toBeUndefined();
    expect(body.context_management).toBeUndefined();
    const outputConfig = body.output_config as Record<string, unknown>;
    // In structured-output mode, output_config exists but holds ONLY the schema, no effort
    expect(outputConfig.effort).toBeUndefined();
    expect(outputConfig.format).toEqual({
      type: "json_schema",
      schema: { type: "object", properties: {} },
    });
  });

  // --- REQ-5: Unknown/future model defaults to all-false ---
  // NOTE: `resolveModel` falls back to sonnet-4-6 for unrecognized inputs, so
  // the unknown-default path in `openaiToAnthropic` is only reachable when a
  // model IS resolved but is NOT yet in MODEL_CAPABILITIES. We simulate that
  // by temporarily removing an entry, then restoring it.
  test("REQ-6: model resolved but missing from MODEL_CAPABILITIES defaults to no gated features", () => {
    const key = "claude-sonnet-4-6";
    const saved = MODEL_CAPABILITIES[key];
    delete MODEL_CAPABILITIES[key];
    try {
      const { body } = openaiToAnthropic({
        model: key,
        messages: [{ role: "user", content: "hi" }],
      });
      expect(body.thinking).toBeUndefined();
      expect(body.context_management).toBeUndefined();
      expect(body.output_config).toBeUndefined();
    } finally {
      MODEL_CAPABILITIES[key] = saved!;
    }
  });

  // --- REQ-6: Capability map testability — helper returns map entry ---
  test("REQ-7: getModelCapabilities returns explicit entry and default for unknown", () => {
    // Explicit entry
    expect(getModelCapabilities("claude-sonnet-4-6")).toEqual({
      adaptiveThinking: true,
      contextManagement: true,
      outputEffort: true,
    });
    // Legacy entry
    expect(getModelCapabilities("claude-sonnet-4-5-20250929")).toEqual({
      adaptiveThinking: false,
      contextManagement: false,
      outputEffort: false,
    });
    // Unknown model → safe default
    expect(getModelCapabilities("totally-unknown-model-9000")).toEqual({
      adaptiveThinking: false,
      contextManagement: false,
      outputEffort: false,
    });
    // Map export is mutable-capable (testability requirement)
    expect(MODEL_CAPABILITIES["claude-sonnet-4-6"]).toBeDefined();
  });

  // --- REQ-7: Regression test for the exact production 400 ---
  test("REQ-8: sonnet-4-5 regression — body has no adaptive thinking", () => {
    // This is the EXACT model that triggered the production 400
    // "adaptive thinking is not supported on this model"
    const { body } = openaiToAnthropic({
      model: "claude-sonnet-4-5-20250929",
      messages: [{ role: "user", content: "production regression" }],
    });
    expect(body.thinking).toBeUndefined();
    // Also assert nothing leaked in context_management / output_config
    expect(body.context_management).toBeUndefined();
    expect(body.output_config).toBeUndefined();
  });
});
