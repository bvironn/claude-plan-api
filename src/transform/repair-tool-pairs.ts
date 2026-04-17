import type { AnthropicMessage } from "../types.ts";
import { emit } from "../observability/logger.ts";

/**
 * Strip orphaned `tool_use` / `tool_result` blocks from an Anthropic-format
 * message array.
 *
 * A `tool_use` block is orphaned when no later user message contains a
 * `tool_result` whose `tool_use_id` matches its `id`. A `tool_result` block is
 * orphaned when no prior assistant message contains a `tool_use` whose `id`
 * matches its `tool_use_id`. Orphans cause degenerate upstream loops when
 * dispatched to Anthropic, so this pure sanitizer removes them as the final
 * step of `openaiToAnthropic`.
 *
 * Pure, O(n), immutable. Returns the SAME array reference when no orphans are
 * found (REQ-7). Emits a single `transform.repairToolPairs` debug event with
 * orphan/drop counts whenever repair fires.
 */
export function repairToolPairs(messages: AnthropicMessage[]): AnthropicMessage[] {
  // --- Pass 1: collect every tool_use id and every tool_result tool_use_id.
  const toolUseIds = new Set<string>();
  const toolResultIds = new Set<string>();

  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      const type = block["type"];
      if (type === "tool_use") {
        const id = block["id"];
        if (typeof id === "string") toolUseIds.add(id);
      } else if (type === "tool_result") {
        const toolUseId = block["tool_use_id"];
        if (typeof toolUseId === "string") toolResultIds.add(toolUseId);
      }
    }
  }

  // --- Identify orphans via set difference.
  const orphanedUses = new Set<string>();
  for (const id of toolUseIds) {
    if (!toolResultIds.has(id)) orphanedUses.add(id);
  }
  const orphanedResults = new Set<string>();
  for (const id of toolResultIds) {
    if (!toolUseIds.has(id)) orphanedResults.add(id);
  }

  // --- REQ-7: no-op short-circuit returns the same reference.
  if (orphanedUses.size === 0 && orphanedResults.size === 0) {
    return messages;
  }

  // --- Pass 2: filter orphan blocks, drop empty messages.
  const repaired: AnthropicMessage[] = [];
  let droppedMessageCount = 0;

  for (const message of messages) {
    if (!Array.isArray(message.content)) {
      repaired.push(message);
      continue;
    }

    const filtered = message.content.filter((block) => {
      const type = block["type"];
      if (type === "tool_use") {
        const id = block["id"];
        if (typeof id === "string" && orphanedUses.has(id)) return false;
      } else if (type === "tool_result") {
        const toolUseId = block["tool_use_id"];
        if (typeof toolUseId === "string" && orphanedResults.has(toolUseId)) return false;
      }
      return true;
    });

    if (filtered.length === 0) {
      droppedMessageCount += 1;
      continue;
    }

    repaired.push({ ...message, content: filtered });
  }

  emit("debug", "transform.repairToolPairs", {
    orphanedUseCount: orphanedUses.size,
    orphanedResultCount: orphanedResults.size,
    droppedMessageCount,
  });

  return repaired;
}
