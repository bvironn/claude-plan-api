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
    adaptiveThinking: true, contextManagement: true, outputEffort: true, structuredOutputs: true },
  { id: "claude-opus-4-6", displayName: "Claude Opus 4.6", createdAt: null,
    adaptiveThinking: true, contextManagement: true, outputEffort: true, structuredOutputs: true },
  { id: "claude-sonnet-4-5-20250929", displayName: "Claude Sonnet 4.5", createdAt: null,
    adaptiveThinking: false, contextManagement: true, outputEffort: false, structuredOutputs: true },
  { id: "claude-opus-4-5-20251101", displayName: "Claude Opus 4.5", createdAt: null,
    adaptiveThinking: false, contextManagement: true, outputEffort: true, structuredOutputs: true },
  { id: "claude-haiku-4-5-20251001", displayName: "Claude Haiku 4.5", createdAt: null,
    adaptiveThinking: false, contextManagement: true, outputEffort: false, structuredOutputs: true },
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
