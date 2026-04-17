// Upstream client for Anthropic's GET /v1/models endpoint.
//
// Discovery: Anthropic accepts OAuth (Bearer) on /v1/models ONLY when the
// `anthropic-beta: oauth-2025-04-20` header is present. Without that beta
// the server replies 401 "OAuth authentication is currently not supported."
//
// The response carries a `capabilities` object per model that declares the
// real per-model feature support (adaptive thinking, context management,
// effort, structured outputs). This is the source of truth that replaces
// the historical hardcoded MODEL_CAPABILITIES table.

import { VERSION } from "../config.ts";
import { ensureValidToken, getCredentials } from "../domain/credentials.ts";
import { SESSION_ID } from "../session.ts";
import { emit } from "../observability/logger.ts";
import { withSpan } from "../observability/tracer.ts";

export interface UpstreamModel {
  id: string;
  displayName: string;
  createdAt: string | null;

  // Token limits declared by the upstream. Null means "not declared" —
  // transform code falls back to a global default.
  maxInputTokens: number | null;
  maxOutputTokens: number | null;

  // OAuth-sensitive features we already gate on.
  adaptiveThinking: boolean;
  thinkingEnabled: boolean;
  contextManagement: boolean;
  outputEffort: boolean;
  structuredOutputs: boolean;

  // Content/input capabilities. Useful for dashboard display and pre-flight
  // validation (e.g. reject images routed to an image-less model).
  imageInput: boolean;
  pdfInput: boolean;
  citations: boolean;
  codeExecution: boolean;
  batch: boolean; // OAuth plan cannot use batches, but the flag is exposed.

  // Effort levels supported by this specific model. Empty when outputEffort is false.
  effortLevels: string[];

  // Context management edit types declared supported (e.g. clear_thinking_20251015,
  // clear_tool_uses_20250919, compact_20260112). Ordered as declared by upstream.
  contextManagementEdits: string[];
}

interface AnthropicSupportedFlag { supported?: boolean }

interface AnthropicEffortCapability {
  supported?: boolean;
  // Per-level support flags. Anthropic uses arbitrary keys (low, medium,
  // high, max today; more tomorrow). Each value is { supported: boolean }.
  [level: string]: AnthropicSupportedFlag | boolean | undefined;
}

interface AnthropicContextManagementCapability {
  supported?: boolean;
  // Per-edit-type flags. Keys are arbitrary (clear_thinking_20251015,
  // clear_tool_uses_20250919, compact_20260112 today).
  [edit: string]: AnthropicSupportedFlag | boolean | undefined;
}

interface AnthropicModelCapabilities {
  thinking?: { supported?: boolean; types?: { adaptive?: AnthropicSupportedFlag; enabled?: AnthropicSupportedFlag } };
  context_management?: AnthropicContextManagementCapability;
  effort?: AnthropicEffortCapability;
  structured_outputs?: AnthropicSupportedFlag;
  image_input?: AnthropicSupportedFlag;
  pdf_input?: AnthropicSupportedFlag;
  citations?: AnthropicSupportedFlag;
  code_execution?: AnthropicSupportedFlag;
  batch?: AnthropicSupportedFlag;
}

interface AnthropicModelEntry {
  id: string;
  display_name?: string;
  created_at?: string;
  max_input_tokens?: number;
  max_tokens?: number;
  capabilities?: AnthropicModelCapabilities;
}

interface AnthropicModelsResponse {
  data: AnthropicModelEntry[];
}

const MODELS_URL = "https://api.anthropic.com/v1/models?beta=true&limit=1000";

function extractEffortLevels(effort: AnthropicEffortCapability | undefined): string[] {
  if (!effort || effort.supported !== true) return [];
  const levels: string[] = [];
  for (const [key, value] of Object.entries(effort)) {
    if (key === "supported") continue;
    if (value && typeof value === "object" && (value as AnthropicSupportedFlag).supported === true) {
      levels.push(key);
    }
  }
  return levels;
}

function extractContextManagementEdits(
  ctx: AnthropicContextManagementCapability | undefined,
): string[] {
  if (!ctx || ctx.supported !== true) return [];
  const edits: string[] = [];
  for (const [key, value] of Object.entries(ctx)) {
    if (key === "supported") continue;
    if (value && typeof value === "object" && (value as AnthropicSupportedFlag).supported === true) {
      edits.push(key);
    }
  }
  return edits;
}

function normalize(entry: AnthropicModelEntry): UpstreamModel {
  const caps = entry.capabilities ?? {};
  return {
    id: entry.id,
    displayName: entry.display_name ?? entry.id,
    createdAt: entry.created_at ?? null,
    maxInputTokens: entry.max_input_tokens ?? null,
    maxOutputTokens: entry.max_tokens ?? null,
    adaptiveThinking: caps.thinking?.types?.adaptive?.supported === true,
    thinkingEnabled: caps.thinking?.types?.enabled?.supported === true,
    contextManagement: caps.context_management?.supported === true,
    outputEffort: caps.effort?.supported === true,
    structuredOutputs: caps.structured_outputs?.supported === true,
    imageInput: caps.image_input?.supported === true,
    pdfInput: caps.pdf_input?.supported === true,
    citations: caps.citations?.supported === true,
    codeExecution: caps.code_execution?.supported === true,
    batch: caps.batch?.supported === true,
    effortLevels: extractEffortLevels(caps.effort),
    contextManagementEdits: extractContextManagementEdits(caps.context_management),
  };
}

/**
 * Fetch the current model catalog from Anthropic using OAuth + the
 * mandatory `oauth-2025-04-20` beta. Throws on non-2xx so the caller
 * can fall back to the static catalog.
 */
export async function fetchUpstreamModels(): Promise<UpstreamModel[]> {
  return withSpan("upstream.models.fetch", async () => {
    await ensureValidToken();

    const res = await fetch(MODELS_URL, {
      headers: {
        authorization: `Bearer ${getCredentials().accessToken}`,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20",
        "anthropic-dangerous-direct-browser-access": "true",
        "x-app": "cli",
        "user-agent": `claude-cli/${VERSION} (external, cli)`,
        "x-claude-code-session-id": SESSION_ID,
        "x-client-request-id": crypto.randomUUID(),
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      emit("warn", "upstream.models.fetch.failed", {
        status: res.status,
        body: body.slice(0, 500),
      });
      throw new Error(`upstream /v1/models returned ${res.status}`);
    }

    const json = (await res.json()) as AnthropicModelsResponse;
    const models = (json.data ?? []).map(normalize);
    emit("debug", "upstream.models.fetch.success", { count: models.length });
    return models;
  });
}
