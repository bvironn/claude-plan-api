const STOP_REASON_MAP: Record<string, string> = {
  end_turn: "stop",
  max_tokens: "length",
  stop_sequence: "stop",
  tool_use: "tool_calls",
  refusal: "content_filter",
  model_context_window_exceeded: "length",
  pause_turn: "stop",
};

/**
 * Map an Anthropic stop_reason to an OpenAI finish_reason.
 * Any unmapped or non-string value falls back to "stop".
 */
export function toFinishReason(stopReason: unknown): string {
  if (typeof stopReason !== "string") return "stop";
  return STOP_REASON_MAP[stopReason] ?? "stop";
}
