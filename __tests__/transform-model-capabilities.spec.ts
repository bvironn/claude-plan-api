import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { openaiToAnthropic } from "../src/transform/openai-to-anthropic.ts";
import {
  __seedRegistryForTests,
  getModelCapabilities,
} from "../src/domain/models.ts";
import type { UpstreamModel } from "../src/upstream/models-client.ts";

// Tests run against a seeded registry so we exercise the capability gating
// deterministically without hitting the network. The seed mirrors a
// realistic upstream response: families that support adaptive thinking,
// families that don't, legacy models, and a minimal / unknown model.
const SEEDED_REGISTRY: UpstreamModel[] = [
  { id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6", createdAt: null,
    adaptiveThinking: true, contextManagement: true, outputEffort: true, structuredOutputs: true,
    effortLevels: ["low", "medium", "high", "max"] },
  { id: "claude-opus-4-6", displayName: "Claude Opus 4.6", createdAt: null,
    adaptiveThinking: true, contextManagement: true, outputEffort: true, structuredOutputs: true,
    effortLevels: ["low", "medium", "high", "max"] },
  { id: "claude-sonnet-4-5-20250929", displayName: "Claude Sonnet 4.5", createdAt: null,
    adaptiveThinking: false, contextManagement: true, outputEffort: false, structuredOutputs: true,
    effortLevels: [] },
  { id: "claude-opus-4-5-20251101", displayName: "Claude Opus 4.5", createdAt: null,
    adaptiveThinking: false, contextManagement: true, outputEffort: true, structuredOutputs: true,
    effortLevels: ["low", "medium", "high"] }, // deliberately no "max" — mirrors real upstream
  { id: "claude-haiku-4-5-20251001", displayName: "Claude Haiku 4.5", createdAt: null,
    adaptiveThinking: false, contextManagement: true, outputEffort: false, structuredOutputs: true,
    effortLevels: [] },
  // A model intentionally left out: "totally-unknown-model-9000" → default all-false.
];

let restore: (() => void) | null = null;

beforeAll(() => {
  restore = __seedRegistryForTests(SEEDED_REGISTRY);
});

afterAll(() => {
  restore?.();
});

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

  // --- REQ-2: Context management now tracks upstream truth ---
  //
  // Historical note: before migrating to upstream-as-truth, the proxy
  // assumed claude-opus-4-5 did NOT support context_management. The real
  // /v1/models response declares it supported, so we now send it.
  test("REQ-3: claude-opus-4-5-20251101 DOES get context_management per upstream", () => {
    const { body } = openaiToAnthropic({
      model: "claude-opus-4-5-20251101",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(body.context_management).toEqual({
      edits: [{ type: "clear_thinking_20251015", keep: "all" }],
    });
  });

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

  // When no effort is supplied by the caller, we do NOT force one —
  // omitting output_config.effort lets Anthropic use its own default.
  test("REQ-4b: capable model with no effort in body omits output_config entirely", () => {
    const { body } = openaiToAnthropic({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(body.output_config).toBeUndefined();
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

  // --- REQ-5: Model absent from registry defaults to all-false ---
  //
  // resolveModel falls back to claude-sonnet-4-6 for unknown inputs, so to
  // exercise the "registered but unknown capability" branch we seed a
  // temporary registry lacking the target id and then query through a
  // fresh openaiToAnthropic call.
  test("REQ-6: model resolved but missing from registry defaults to no gated features", () => {
    const undo = __seedRegistryForTests([
      // Only one entry; claude-sonnet-4-6 is absent so resolveModel falls
      // back to the first id, which has all caps disabled.
      { id: "null-capable-model", displayName: "null", createdAt: null,
        adaptiveThinking: false, contextManagement: false, outputEffort: false, structuredOutputs: false },
    ]);
    try {
      const { body } = openaiToAnthropic({
        model: "null-capable-model",
        messages: [{ role: "user", content: "hi" }],
      });
      expect(body.thinking).toBeUndefined();
      expect(body.context_management).toBeUndefined();
      expect(body.output_config).toBeUndefined();
    } finally {
      undo();
    }
  });

  // --- REQ-6: getModelCapabilities reads from the registry ---
  test("REQ-7: getModelCapabilities returns registry entry and default for unknown", () => {
    // Known capable entry from the seed
    expect(getModelCapabilities("claude-sonnet-4-6")).toEqual({
      adaptiveThinking: true,
      contextManagement: true,
      outputEffort: true,
    });
    // Known legacy entry from the seed (mirrors upstream: ctx-mgmt true, no adaptive/effort)
    expect(getModelCapabilities("claude-sonnet-4-5-20250929")).toEqual({
      adaptiveThinking: false,
      contextManagement: true,
      outputEffort: false,
    });
    // Unknown model → safe default
    expect(getModelCapabilities("totally-unknown-model-9000")).toEqual({
      adaptiveThinking: false,
      contextManagement: false,
      outputEffort: false,
    });
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
  });
});

describe("openaiToAnthropic — effort variants", () => {
  // --- Body → output_config.effort (OpenAI dialect) ---
  test("reasoning_effort=high in body → output_config.effort=high", () => {
    const { body } = openaiToAnthropic({
      model: "claude-sonnet-4-6",
      reasoning_effort: "high",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(body.output_config).toEqual({ effort: "high" });
  });

  test("output_config.effort=max in body (Anthropic dialect) → kept", () => {
    const { body } = openaiToAnthropic({
      model: "claude-opus-4-6",
      output_config: { effort: "max" },
      messages: [{ role: "user", content: "hi" }],
    });
    expect(body.output_config).toEqual({ effort: "max" });
  });

  // --- Suffix → output_config.effort (OpenRouter dialect) ---
  test("model id with :high suffix → effort=high, base id resolved", () => {
    const { body } = openaiToAnthropic({
      model: "claude-opus-4-6:high",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(body.output_config).toEqual({ effort: "high" });
    expect(body.model).toBe("claude-opus-4-6"); // suffix stripped
  });

  test("model id with :max suffix on model that supports max → kept", () => {
    const { body } = openaiToAnthropic({
      model: "claude-sonnet-4-6:max",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(body.output_config).toEqual({ effort: "max" });
  });

  // --- Precedence: body wins over suffix ---
  test("body effort overrides suffix effort when both present", () => {
    const { body } = openaiToAnthropic({
      model: "claude-opus-4-6:low",
      reasoning_effort: "max",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(body.output_config).toEqual({ effort: "max" });
  });

  // --- "default" sentinel → omit effort ---
  test("reasoning_effort=default → output_config omitted", () => {
    const { body } = openaiToAnthropic({
      model: "claude-sonnet-4-6",
      reasoning_effort: "default",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(body.output_config).toBeUndefined();
  });

  // --- Non-native values dropped (not mapped) ---
  test("reasoning_effort=xhigh → dropped, output_config omitted (no silent mapping)", () => {
    const { body } = openaiToAnthropic({
      model: "claude-sonnet-4-6",
      reasoning_effort: "xhigh",
      messages: [{ role: "user", content: "hi" }],
    });
    // xhigh is NOT declared by Anthropic; we drop it rather than invent a mapping to max.
    expect(body.output_config).toBeUndefined();
  });

  // --- Per-model level validation: Opus 4.5 does NOT support max ---
  test("claude-opus-4-5 with effort=max → dropped (upstream declares only low/medium/high)", () => {
    const { body } = openaiToAnthropic({
      model: "claude-opus-4-5-20251101",
      reasoning_effort: "max",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(body.output_config).toBeUndefined();
  });

  test("claude-opus-4-5 with effort=high → accepted (declared)", () => {
    const { body } = openaiToAnthropic({
      model: "claude-opus-4-5-20251101",
      reasoning_effort: "high",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(body.output_config).toEqual({ effort: "high" });
  });

  // --- Model without effort capability: any value dropped ---
  test("claude-haiku with reasoning_effort=high → dropped (model has no effort cap)", () => {
    const { body } = openaiToAnthropic({
      model: "claude-haiku-4-5-20251001",
      reasoning_effort: "high",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(body.output_config).toBeUndefined();
  });

  test("claude-haiku:high suffix → suffix ignored (haiku has no effort)", () => {
    const { body } = openaiToAnthropic({
      model: "claude-haiku-4-5-20251001:high",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(body.output_config).toBeUndefined();
  });

  // --- Structured output still wins — effort never leaks into structured-output shape ---
  test("structured_output + reasoning_effort=high → effort dropped, format kept", () => {
    const { body } = openaiToAnthropic({
      model: "claude-sonnet-4-6",
      reasoning_effort: "high",
      response_format: {
        type: "json_schema",
        json_schema: { schema: { type: "object", properties: {} } },
      },
      messages: [{ role: "user", content: "hi" }],
    });
    const outputConfig = body.output_config as Record<string, unknown>;
    expect(outputConfig.effort).toBeUndefined();
    expect(outputConfig.format).toBeDefined();
  });
});
