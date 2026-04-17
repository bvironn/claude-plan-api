export const MODEL_MAP: Record<string, string> = {
  "claude-sonnet-4-6": "claude-sonnet-4-6",
  "claude-opus-4-6": "claude-opus-4-6",
  "claude-opus-4-5": "claude-opus-4-5-20251101",
  "claude-haiku-4-5": "claude-haiku-4-5-20251001",
  "claude-sonnet-4-5": "claude-sonnet-4-5-20250929",
  "claude-opus-4-1": "claude-opus-4-1-20250805",
  "claude-opus-4": "claude-opus-4-20250514",
  "claude-sonnet-4": "claude-sonnet-4-20250514",
  "claude-opus-4-5-20251101": "claude-opus-4-5-20251101",
  "claude-haiku-4-5-20251001": "claude-haiku-4-5-20251001",
  "claude-sonnet-4-5-20250929": "claude-sonnet-4-5-20250929",
  "claude-opus-4-1-20250805": "claude-opus-4-1-20250805",
  "claude-opus-4-20250514": "claude-opus-4-20250514",
  "claude-sonnet-4-20250514": "claude-sonnet-4-20250514",
  "claude-3-haiku-20240307": "claude-3-haiku-20240307",
  sonnet: "claude-sonnet-4-6",
  opus: "claude-opus-4-6",
  haiku: "claude-haiku-4-5-20251001",
};

export const MODELS_LIST = [
  "claude-sonnet-4-6",
  "claude-opus-4-6",
  "claude-opus-4-5-20251101",
  "claude-haiku-4-5-20251001",
  "claude-sonnet-4-5-20250929",
  "claude-opus-4-1-20250805",
  "claude-opus-4-20250514",
  "claude-sonnet-4-20250514",
  "claude-3-haiku-20240307",
].map((id) => ({ id, object: "model" as const, owned_by: "anthropic" }));

export function resolveModel(input: string): string {
  return (
    MODEL_MAP[input] ||
    MODEL_MAP[input.replace(/^(openai|claude-local)\//, "")] ||
    MODEL_MAP["sonnet"] ||
    "claude-sonnet-4-6"
  );
}

export interface ModelCapabilities {
  adaptiveThinking: boolean;
  contextManagement: boolean;
  outputEffort: boolean;
}

/**
 * Per-model capability allowlist for OAuth-internal inference features.
 * Only models explicitly listed get these features. Unknown models
 * default to all FALSE — safer than accidentally sending a feature
 * the model does not support (triggers 400 "adaptive thinking is not
 * supported on this model" from Anthropic).
 *
 * To allow a new model: add an explicit entry with the capabilities
 * it supports.
 */
export const MODEL_CAPABILITIES: Record<string, ModelCapabilities> = {
  // 4-6+ models support all three OAuth-internal features
  "claude-sonnet-4-6": { adaptiveThinking: true, contextManagement: true, outputEffort: true },
  "claude-opus-4-6": { adaptiveThinking: true, contextManagement: true, outputEffort: true },

  // 4-5 models: NO adaptive thinking (verified via 400 logs), context_management
  // and output_effort status unverified — conservative: false until proven.
  "claude-sonnet-4-5-20250929": { adaptiveThinking: false, contextManagement: false, outputEffort: false },
  "claude-opus-4-5-20251101": { adaptiveThinking: false, contextManagement: false, outputEffort: false },

  // Older models: no OAuth-internal features
  "claude-sonnet-4-20250514": { adaptiveThinking: false, contextManagement: false, outputEffort: false },
  "claude-opus-4-1-20250805": { adaptiveThinking: false, contextManagement: false, outputEffort: false },
  "claude-opus-4-20250514": { adaptiveThinking: false, contextManagement: false, outputEffort: false },

  // Haiku: no thinking, no effort (matches existing haiku disable-effort override in headers.ts)
  "claude-haiku-4-5-20251001": { adaptiveThinking: false, contextManagement: false, outputEffort: false },
  "claude-3-haiku-20240307": { adaptiveThinking: false, contextManagement: false, outputEffort: false },
};

const DEFAULT_CAPABILITIES: ModelCapabilities = {
  adaptiveThinking: false,
  contextManagement: false,
  outputEffort: false,
};

/**
 * Get capabilities for a model. Unknown models default to all-false
 * (safe default — never send OAuth-internal features to unverified models).
 */
export function getModelCapabilities(model: string): ModelCapabilities {
  return MODEL_CAPABILITIES[model] ?? DEFAULT_CAPABILITIES;
}
