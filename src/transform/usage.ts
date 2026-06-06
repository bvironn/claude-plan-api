export interface OpenAiUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details: { cached_tokens: number };
  cache_creation_input_tokens?: number; // extension; present only when > 0
}

/**
 * Build an OpenAI-compatible usage object from Anthropic usage fields.
 *
 * - prompt_tokens_details.cached_tokens is always present (defaults to 0).
 * - cache_creation_input_tokens is emitted only when the upstream value is > 0
 *   (design decision: keep vanilla OpenAI shape when caching is not active).
 */
export function buildOpenAiUsage(u: {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}): OpenAiUsage {
  const promptTokens = u.input_tokens ?? 0;
  const completionTokens = u.output_tokens ?? 0;
  const cachedTokens = u.cache_read_input_tokens ?? 0;
  const creationTokens = u.cache_creation_input_tokens ?? 0;

  const result: OpenAiUsage = {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    prompt_tokens_details: { cached_tokens: cachedTokens },
  };

  if (creationTokens > 0) {
    result.cache_creation_input_tokens = creationTokens;
  }

  return result;
}
