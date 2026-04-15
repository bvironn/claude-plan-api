import { unmapToolName } from "../domain/tool-mapping.ts";
import { emit } from "../observability/logger.ts";

export function anthropicToOpenai(res: Record<string, unknown>, model: string): Record<string, unknown> {
  // No deobfuscation needed - Anthropic responds in plain text
  const content = (res.content as Array<Record<string, unknown>>) || [];
  const textBlock = content.find((c) => c.type === "text");
  const toolBlocks = content.filter((c) => c.type === "tool_use");
  const stopMap: Record<string, string> = { end_turn: "stop", max_tokens: "length", stop_sequence: "stop", tool_use: "tool_calls" };
  const message: Record<string, unknown> = { role: "assistant", content: textBlock?.text as string || null };
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
