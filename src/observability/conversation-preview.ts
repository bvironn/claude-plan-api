/**
 * Backend mirror of the UI's first-user-text heuristic
 * (`src/ui/src/lib/sessions.ts` → `firstUserTextFromRequest` and
 * `src/ui/src/lib/format.ts` → `splitContextPreamble`).
 *
 * The slim list projection omits the raw request/response/upstream bodies, but
 * the dashboard derives conversation identity from the first user message inside
 * those bodies. To keep session grouping identical without shipping the bodies,
 * the list endpoint computes `firstUserPreview` on-read and ships it in both the
 * slim and full shapes (design decision #2). This module MUST stay behaviorally
 * identical to the UI heuristic so `groupIntoConversations` yields the same
 * conversation ids on the slim shape as on the full shape (grouping parity).
 *
 * Pure function: no side effects, deterministic, trivially testable.
 */

/** Mirror of `format.ts` SPLIT_MIN_SIZE — messages shorter than this never split. */
const SPLIT_MIN_SIZE = 600;

/** Default preview cap. MUST be >= the grouping key length (400) so the preview
 *  is never truncated below the hash window used by `groupIntoConversations`. */
const DEFAULT_MAX_LEN = 400;

/**
 * Flatten a message `content` (string, or array of text/content blocks) into a
 * single string. Mirrors the UI's `flattenContent`.
 */
function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === "string") {
        parts.push(block);
      } else if (block && typeof block === "object") {
        const b = block as Record<string, unknown>;
        if (typeof b.text === "string") parts.push(b.text);
        else if (typeof b.content === "string") parts.push(b.content);
      }
    }
    return parts.join("\n");
  }
  return "";
}

/**
 * Separate the forwarded system/agent-context preamble from the user's actual
 * question. Mirrors the UI's `splitContextPreamble`: only long messages
 * (>= 600 chars) that contain a `\n\n` split, treating everything before the
 * last `\n\n` as context and everything after as the real user input; a "user
 * input" half that is itself >= half the text is treated as no-split.
 */
function splitContextPreamble(text: string): { userInput: string } {
  if (text.length < SPLIT_MIN_SIZE) return { userInput: text };
  const lastSep = text.lastIndexOf("\n\n");
  if (lastSep === -1) return { userInput: text };
  const candidateInput = text.slice(lastSep + 2);
  if (candidateInput.length >= text.length / 2) return { userInput: text };
  return { userInput: candidateInput };
}

/**
 * Extract a capped, preamble-stripped preview of the first user message in a
 * stringified chat request body (OpenAI or Anthropic shape — both use
 * `messages[].role/content`). Returns `null` for null/empty/unparseable bodies,
 * non-chat bodies, or bodies with no user message.
 */
export function firstUserPreview(
  body: string | null | undefined,
  maxLen: number = DEFAULT_MAX_LEN,
): string | null {
  if (!body) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;

  const messages = (parsed as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return null;

  const firstUser = messages.find(
    (m) => m && typeof m === "object" && (m as { role?: unknown }).role === "user",
  );
  if (!firstUser) return null;

  const raw = flattenContent((firstUser as { content?: unknown }).content);
  if (!raw) return null;

  const { userInput } = splitContextPreamble(raw);
  const text = userInput || raw;
  return text.slice(0, maxLen);
}
