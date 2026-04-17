import { MAX_CONSECUTIVE_TOOL_ERRORS } from "../config.ts";
import { emit } from "../observability/logger.ts";

export { MAX_CONSECUTIVE_TOOL_ERRORS };

const toolErrorCounters: Map<string, number> = new Map();

export function trackToolError(sessionId: string): boolean {
  const count = (toolErrorCounters.get(sessionId) || 0) + 1;
  toolErrorCounters.set(sessionId, count);
  emit("warn", "guard.toolError", { sessionId, count, threshold: MAX_CONSECUTIVE_TOOL_ERRORS });
  if (count >= MAX_CONSECUTIVE_TOOL_ERRORS) {
    toolErrorCounters.delete(sessionId);
    emit("error", "guard.loopDetected", { sessionId, count });
    return true;
  }
  return false;
}

export function resetToolErrorCounter(sessionId: string) {
  toolErrorCounters.delete(sessionId);
}

export function detectTrailingToolErrors(messages: Array<Record<string, unknown>>): number {
  let trailingErrors = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg) break;
    if (msg.role === "tool" && typeof msg.content === "string" && msg.content.includes("unavailable tool")) {
      trailingErrors++;
    } else {
      break;
    }
  }
  return trailingErrors;
}
