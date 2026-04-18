import { unmapToolName } from "../domain/tool-mapping.ts";
import { emit } from "../observability/logger.ts";

export function anthropicToOpenai(res: Record<string, unknown>, model: string): Record<string, unknown> {
  // No deobfuscation needed - Anthropic responds in plain text
  const content = (res.content as Array<Record<string, unknown>>) || [];
  const textBlock = content.find((c) => c.type === "text");
  const toolBlocks = content.filter((c) => c.type === "tool_use");
  // Thinking passthrough: concatenate the plaintext of `thinking` blocks into
  // `reasoning_content` (the field @ai-sdk/openai-compatible reads natively,
  // see dist L578: `choice.message.reasoning_content ?? choice.message.reasoning`).
  // Also expose the RAW blocks (including signatures and redacted_thinking
  // ciphertext) via `reasoning_details` so advanced clients can echo them back
  // in multi-turn requests without Anthropic rejecting a stripped signature.
  const thinkingBlocks = content.filter(
    (c) => c.type === "thinking" || c.type === "redacted_thinking",
  );
  const reasoningText = thinkingBlocks
    .filter((c) => c.type === "thinking")
    .map((c) => (c.thinking as string) ?? "")
    .join("\n\n");
  const stopMap: Record<string, string> = { end_turn: "stop", max_tokens: "length", stop_sequence: "stop", tool_use: "tool_calls" };
  const message: Record<string, unknown> = { role: "assistant", content: textBlock?.text as string || null };
  if (reasoningText.length > 0) {
    message.reasoning_content = reasoningText;
  }
  if (thinkingBlocks.length > 0) {
    // Pass through verbatim — signature and data fields must survive intact.
    message.reasoning_details = thinkingBlocks;
  }
  if (toolBlocks.length > 0) {
    message.tool_calls = toolBlocks.map((tu) => ({
      id: tu.id,
      type: "function",
      function: { name: unmapToolName(tu.name as string), arguments: JSON.stringify(tu.input) },
    }));
  }
  const usage = res.usage as Record<string, number> || {};
  emit("debug", "transform.response", {
    contentBlocksCount: content.length,
    stopReason: res.stop_reason,
    model,
  });
  return {
    id: res.id || `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: stopMap[res.stop_reason as string] || "stop" }],
    usage: {
      prompt_tokens: usage.input_tokens || 0,
      completion_tokens: usage.output_tokens || 0,
      total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
    },
  };
}
