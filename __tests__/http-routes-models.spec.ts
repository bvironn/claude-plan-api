import { describe, test, expect, beforeAll, afterAll, spyOn } from "bun:test";
import { handleModels } from "../src/http/routes/models.ts";
import { __seedRegistryForTests } from "../src/domain/models.ts";
import type { UpstreamModel } from "../src/upstream/models-client.ts";

// Seed a small deterministic catalog so we can assert on the exact shape
// without relying on the live upstream.
const SEED: UpstreamModel[] = [
  {
    id: "test-capable-model",
    displayName: "Test Capable",
    createdAt: "2026-04-14T00:00:00Z",
    maxInputTokens: 1_000_000,
    maxOutputTokens: 128_000,
    adaptiveThinking: true,
    thinkingEnabled: false,
    contextManagement: true,
    outputEffort: true,
    structuredOutputs: true,
    imageInput: true,
    pdfInput: true,
    citations: true,
    codeExecution: true,
    batch: true,
    effortLevels: ["low", "medium", "high", "max"],
    contextManagementEdits: ["clear_thinking_20251015", "compact_20260112"],
  },
  {
    id: "test-noeffort-model",
    displayName: "Test No Effort",
    createdAt: null,
    maxInputTokens: 200_000,
    maxOutputTokens: 32_000,
    adaptiveThinking: false,
    thinkingEnabled: false,
    contextManagement: false,
    outputEffort: false,
    structuredOutputs: false,
    imageInput: false,
    pdfInput: false,
    citations: false,
    codeExecution: false,
    batch: false,
    effortLevels: [],
    contextManagementEdits: [],
  },
];

let restore: (() => void) | null = null;
let fetchSpy: ReturnType<typeof spyOn> | null = null;

beforeAll(async () => {
  // Block real upstream calls: refreshRegistry calls fetchUpstreamModels
  // which needs credentials. Force it to throw so the route falls back to
  // the seeded registry.
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new Error("fetch blocked in test");
  });

  const credModule = await import("../src/domain/credentials.ts");
  spyOn(credModule, "ensureValidToken").mockRejectedValue(new Error("no creds"));

  restore = __seedRegistryForTests(SEED);
});

afterAll(() => {
  restore?.();
  fetchSpy?.mockRestore();
});

describe("GET /v1/models — response shape", () => {
  test("returns object:list with data array", async () => {
    const res = await handleModels();
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.object).toBe("list");
    expect(Array.isArray(body.data)).toBe(true);
  });

  test("capable model expands into base + one entry per effort level", async () => {
    const res = await handleModels();
    const body = await res.json() as { data: Array<{ id: string; effort?: string }> };
    const ids = body.data.map((m) => m.id).filter((id) => id.startsWith("test-capable-model"));
    expect(ids).toEqual([
      "test-capable-model",
      "test-capable-model:low",
      "test-capable-model:medium",
      "test-capable-model:high",
      "test-capable-model:max",
    ]);
    // Variants carry the effort label
    const variants = body.data.filter((m) => m.id.includes(":"));
    for (const v of variants) {
      expect(v.effort).toBeDefined();
    }
  });

  test("non-effort model appears exactly once (no variants)", async () => {
    const res = await handleModels();
    const body = await res.json() as { data: Array<{ id: string }> };
    const ids = body.data.filter((m) => m.id.startsWith("test-noeffort-model")).map((m) => m.id);
    expect(ids).toEqual(["test-noeffort-model"]);
  });

  test("each entry carries the extended metadata contract", async () => {
    const res = await handleModels();
    const body = await res.json() as { data: Array<Record<string, unknown>> };
    const base = body.data.find((m) => m.id === "test-capable-model")!;

    // Spec-required OpenAI fields
    expect(base.object).toBe("model");
    expect(base.owned_by).toBe("anthropic");
    expect(typeof base.created).toBe("number");

    // Our extension fields
    expect(base.display_name).toBe("Test Capable");
    expect(base.max_input_tokens).toBe(1_000_000);
    expect(base.max_output_tokens).toBe(128_000);
    expect(base.effort_levels).toEqual(["low", "medium", "high", "max"]);
    expect(base.context_management_edits).toEqual([
      "clear_thinking_20251015",
      "compact_20260112",
    ]);

    // capabilities object has every declared flag
    const caps = base.capabilities as Record<string, unknown>;
    expect(caps.adaptive_thinking).toBe(true);
    expect(caps.thinking_enabled).toBe(false);
    expect(caps.context_management).toBe(true);
    expect(caps.output_effort).toBe(true);
    expect(caps.structured_outputs).toBe(true);
    expect(caps.image_input).toBe(true);
    expect(caps.pdf_input).toBe(true);
    expect(caps.citations).toBe(true);
    expect(caps.code_execution).toBe(true);
    expect(caps.batch).toBe(true);
  });

  test("created=0 when upstream omits createdAt", async () => {
    const res = await handleModels();
    const body = await res.json() as { data: Array<{ id: string; created: number }> };
    const entry = body.data.find((m) => m.id === "test-noeffort-model")!;
    expect(entry.created).toBe(0);
  });

  test("created is epoch seconds when createdAt is ISO", async () => {
    const res = await handleModels();
    const body = await res.json() as { data: Array<{ id: string; created: number }> };
    const entry = body.data.find((m) => m.id === "test-capable-model")!;
    expect(entry.created).toBe(Math.floor(Date.parse("2026-04-14T00:00:00Z") / 1000));
  });
});
