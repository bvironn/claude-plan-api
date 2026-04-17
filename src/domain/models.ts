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
