import { refreshRegistry, getCatalogSnapshot } from "../../domain/models.ts";
import type { UpstreamModel } from "../../upstream/models-client.ts";
import { emit } from "../../observability/logger.ts";

/**
 * OpenAI-compatible model list. Every call triggers a fresh fetch against
 * Anthropic's /v1/models (see refreshRegistry). If the upstream fails we
 * degrade to whatever catalog the registry holds (live or static).
 *
 * Effort variants are expanded as separate entries using the ":" separator
 * (OpenRouter convention). Each entry includes max_input_tokens,
 * max_output_tokens, and a capabilities object derived from the upstream.
 * Clients that speak OpenAI-strict will ignore the extra fields; clients
 * that speak OpenRouter-style metadata will pick them up.
 */
export async function handleModels(): Promise<Response> {
  let catalog;
  try {
    catalog = await refreshRegistry();
  } catch (err) {
    emit("error", "models.route.fallback", { reason: (err as Error).message });
    catalog = getCatalogSnapshot();
  }

  const data: ModelEntry[] = [];

  for (const m of catalog) {
    const base = toEntry(m);
    data.push(base);
    for (const level of m.effortLevels) {
      data.push({ ...base, id: `${m.id}:${level}`, effort: level });
    }
  }

  return Response.json({ object: "list", data });
}

interface ModelEntry {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  display_name: string;
  max_input_tokens: number | null;
  max_output_tokens: number | null;
  effort?: string;
  effort_levels: string[];
  context_management_edits: string[];
  capabilities: {
    adaptive_thinking: boolean;
    thinking_enabled: boolean;
    context_management: boolean;
    output_effort: boolean;
    structured_outputs: boolean;
    image_input: boolean;
    pdf_input: boolean;
    citations: boolean;
    code_execution: boolean;
    batch: boolean;
  };
}

function toEntry(m: UpstreamModel): ModelEntry {
  return {
    id: m.id,
    object: "model",
    created: m.createdAt ? Math.floor(Date.parse(m.createdAt) / 1000) : 0,
    owned_by: "anthropic",
    display_name: m.displayName,
    max_input_tokens: m.maxInputTokens,
    max_output_tokens: m.maxOutputTokens,
    effort_levels: [...m.effortLevels],
    context_management_edits: [...m.contextManagementEdits],
    capabilities: {
      adaptive_thinking: m.adaptiveThinking,
      thinking_enabled: m.thinkingEnabled,
      context_management: m.contextManagement,
      output_effort: m.outputEffort,
      structured_outputs: m.structuredOutputs,
      image_input: m.imageInput,
      pdf_input: m.pdfInput,
      citations: m.citations,
      code_execution: m.codeExecution,
      batch: m.batch,
    },
  };
}
