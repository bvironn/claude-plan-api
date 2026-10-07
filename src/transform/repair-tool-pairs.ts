import type { AnthropicMessage } from "../types.ts";
import { emit } from "../observability/logger.ts";

/**
 * Reconcile `tool_use` / `tool_result` pairing before dispatch to Anthropic.
 *
 * Anthropic requires every `tool_use` to be answered by a `tool_result` in the
 * IMMEDIATELY following message, and every `tool_result` to answer a
 * `tool_use` in the immediately preceding one. Clients break this when a turn
 * is interrupted, a tool execution is aborted, or history is compacted or
 * truncated mid-pair. Pairing is therefore checked by adjacency, per
 * occurrence — not by "the id appears somewhere in the conversation", which
 * lets a non-adjacent or replayed id slip through and earn a 400.
 *
 * Two strategies (ported from the upstream plugin, #250 / #263):
 *
 * - `placeholder` (default): never deletes a block from an assistant turn.
 *   Orphaned `tool_result`s (user side) are removed; every `tool_use` still
 *   lacking an adjacent result gets a synthesized `is_error` result. The
 *   model keeps the record of what it tried, and `thinking` /
 *   `redacted_thinking` blocks stay byte-identical, as Anthropic's
 *   thinking-preservation contract demands.
 * - `drop`: removes orphaned blocks. An assistant turn carrying thinking
 *   blocks is omitted whole rather than partially rewritten. Iterated to a
 *   fixed point so cascades (an omitted turn orphaning the result after it)
 *   are fully reconciled.
 *
 * Select with `TOOL_REPAIR_MODE=drop`; anything else means `placeholder`.
 */
export type ToolRepairMode = "placeholder" | "drop";

/** Content of a synthesized `tool_result` whose real output is missing. */
export const TOOL_RESULT_PLACEHOLDER =
  "Tool result unavailable (removed during context compaction).";

export function resolveToolRepairMode(
  env: Record<string, string | undefined> = Bun.env,
): ToolRepairMode {
  return env.TOOL_REPAIR_MODE?.trim().toLowerCase() === "drop" ? "drop" : "placeholder";
}

type Block = Record<string, unknown>;

const THINKING_TYPES = new Set(["thinking", "redacted_thinking"]);

function toolUseIdOf(block: Block): string | undefined {
  return block.type === "tool_use" && typeof block.id === "string" ? block.id : undefined;
}

function toolResultIdOf(block: Block): string | undefined {
  return block.type === "tool_result" && typeof block.tool_use_id === "string"
    ? block.tool_use_id
    : undefined;
}

function hasThinkingBlock(message: AnthropicMessage): boolean {
  return (
    message.role === "assistant" &&
    Array.isArray(message.content) &&
    message.content.some((b) => THINKING_TYPES.has(b.type as string))
  );
}

function toolUseHasAdjacentResult(messages: AnthropicMessage[], index: number, id: string): boolean {
  const next = messages[index + 1];
  if (!next || !Array.isArray(next.content)) return false;
  return next.content.some((b) => toolResultIdOf(b) === id);
}

function toolResultHasAdjacentUse(messages: AnthropicMessage[], index: number, id: string): boolean {
  const prev = messages[index - 1];
  if (!prev || !Array.isArray(prev.content)) return false;
  return prev.content.some((b) => toolUseIdOf(b) === id);
}

interface DropStats {
  orphanedUseCount: number;
  orphanedResultCount: number;
  droppedMessageCount: number;
  omittedThinkingTurns: number;
}

function dropPass(
  messages: AnthropicMessage[],
  stats: DropStats,
): { next: AnthropicMessage[]; changed: boolean } {
  let changed = false;
  const out: AnthropicMessage[] = [];

  messages.forEach((message, index) => {
    if (!Array.isArray(message.content)) {
      out.push(message);
      return;
    }

    const hasOrphanUse = message.content.some((b) => {
      const id = toolUseIdOf(b);
      return id !== undefined && !toolUseHasAdjacentResult(messages, index, id);
    });

    // A thinking turn may be kept whole or dropped whole, never rewritten.
    // Its valid tool_uses go with it; their results become orphans and are
    // removed on the next fixed-point pass.
    if (hasOrphanUse && hasThinkingBlock(message)) {
      changed = true;
      stats.omittedThinkingTurns++;
      stats.droppedMessageCount++;
      stats.orphanedUseCount += message.content.filter((b) => toolUseIdOf(b) !== undefined).length;
      return;
    }

    const filtered = message.content.filter((b) => {
      const useId = toolUseIdOf(b);
      if (useId !== undefined) {
        const ok = toolUseHasAdjacentResult(messages, index, useId);
        if (!ok) stats.orphanedUseCount++;
        return ok;
      }
      const resultId = toolResultIdOf(b);
      if (resultId !== undefined) {
        const ok = toolResultHasAdjacentUse(messages, index, resultId);
        if (!ok) stats.orphanedResultCount++;
        return ok;
      }
      return true;
    });

    if (filtered.length === message.content.length) {
      out.push(message);
      return;
    }
    changed = true;
    if (filtered.length === 0) {
      stats.droppedMessageCount++;
      return;
    }
    out.push({ ...message, content: filtered });
  });

  return { next: out, changed };
}

/**
 * Drop-strategy repair. Returns the SAME array reference when nothing is
 * orphaned. Emits one `transform.repairToolPairs` debug event when it fires.
 */
export function repairToolPairs(messages: AnthropicMessage[]): AnthropicMessage[] {
  const stats: DropStats = {
    orphanedUseCount: 0,
    orphanedResultCount: 0,
    droppedMessageCount: 0,
    omittedThinkingTurns: 0,
  };
  let current = messages;
  // Each pass strictly removes blocks, so a fixed point is reached within
  // messages.length passes.
  const maxIterations = messages.length + 2;
  let converged = false;
  for (let i = 0; i < maxIterations; i++) {
    const { next, changed } = dropPass(current, stats);
    if (!changed) {
      converged = true;
      break;
    }
    current = next;
  }

  if (!converged) {
    emit("warn", "transform.repairToolPairs.maxIterations", { messageCount: messages.length });
  }
  if (current !== messages) {
    emit("debug", "transform.repairToolPairs", { mode: "drop", ...stats });
  }
  return current;
}

function makePlaceholderResult(id: string): Block {
  return { type: "tool_result", tool_use_id: id, content: TOOL_RESULT_PLACEHOLDER, is_error: true };
}

/**
 * Placeholder-strategy repair (default). Returns the SAME array reference
 * when nothing needed fixing.
 */
export function synthesizeMissingToolResults(messages: AnthropicMessage[]): AnthropicMessage[] {
  let changed = false;
  let removedOrphanResults = 0;

  // Pass 1: strip tool_result blocks with no adjacent preceding tool_use.
  // They live in user turns, so no thinking block is affected.
  const pass1: AnthropicMessage[] = [];
  messages.forEach((message, index) => {
    if (!Array.isArray(message.content)) {
      pass1.push(message);
      return;
    }
    const filtered = message.content.filter((b) => {
      const resultId = toolResultIdOf(b);
      if (resultId === undefined) return true;
      const ok = toolResultHasAdjacentUse(messages, index, resultId);
      if (!ok) removedOrphanResults++;
      return ok;
    });
    if (filtered.length === message.content.length) {
      pass1.push(message);
      return;
    }
    changed = true;
    if (filtered.length > 0) pass1.push({ ...message, content: filtered });
  });

  // Pass 2: synthesize an adjacent result for every tool_use still lacking one.
  const synthesizedToolUseIds: string[] = [];
  const out: AnthropicMessage[] = [];
  for (let i = 0; i < pass1.length; i++) {
    const message = pass1[i]!;
    out.push(message);
    if (!Array.isArray(message.content)) continue;

    const useIds = message.content
      .map(toolUseIdOf)
      .filter((id): id is string => id !== undefined);
    if (useIds.length === 0) continue;

    const next = pass1[i + 1];
    const presentIds = new Set(
      next && Array.isArray(next.content)
        ? next.content.map(toolResultIdOf).filter((id): id is string => id !== undefined)
        : [],
    );
    const missing = useIds.filter((id) => !presentIds.has(id));
    if (missing.length === 0) continue;

    changed = true;
    synthesizedToolUseIds.push(...missing);
    const synthetic = missing.map(makePlaceholderResult);

    if (next && next.role === "user" && Array.isArray(next.content)) {
      // tool_result blocks must lead the user turn.
      out.push({ ...next, content: [...synthetic, ...next.content] });
      i++;
    } else if (next && next.role === "user" && typeof next.content === "string") {
      // Convert the plain-text turn to blocks rather than emitting two
      // consecutive user turns.
      out.push({
        ...next,
        content: next.content.length > 0 ? [...synthetic, { type: "text", text: next.content }] : synthetic,
      });
      i++;
    } else {
      out.push({ role: "user", content: synthetic });
    }
  }

  if (!changed) return messages;

  emit("debug", "transform.repairToolPairs", {
    mode: "placeholder",
    synthesizedToolUseIds,
    synthesizedCount: synthesizedToolUseIds.length,
    removedOrphanResultCount: removedOrphanResults,
  });
  return out;
}

/** Dispatch to the configured repair strategy. */
export function applyToolRepair(
  messages: AnthropicMessage[],
  mode: ToolRepairMode = resolveToolRepairMode(),
): AnthropicMessage[] {
  return mode === "drop" ? repairToolPairs(messages) : synthesizeMissingToolResults(messages);
}
