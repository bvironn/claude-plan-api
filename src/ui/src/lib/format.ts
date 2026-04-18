/**
 * Presentation-layer formatters. Pure functions, no React.
 */

/** "1.2 s" for >= 1000, "234 ms" otherwise. `null` → "—". */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return "—"
  if (ms >= 1000) return `${(ms / 1000).toFixed(ms >= 10_000 ? 1 : 2)} s`
  return `${Math.round(ms)} ms`
}

/** "12.3k" for >= 1000, "123" otherwise. `undefined` → "—". */
export function formatTokens(n: number | null | undefined): string {
  if (n == null) return "—"
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

/** "just now" / "2m ago" / "3h ago" / absolute date for >24h old. */
export function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return "—"
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return iso
  const diff = Date.now() - then
  if (diff < 5_000) return "just now"
  if (diff < 60_000) return `${Math.floor(diff / 1_000)}s ago`
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return new Date(iso).toLocaleString()
}

/** JSON.parse that returns null on failure — safe for rendering raw body fields. */
export function parseOrNull<T = unknown>(input: string | null | undefined): T | null {
  if (!input) return null
  try {
    return JSON.parse(input) as T
  } catch {
    return null
  }
}

/** Pretty-print JSON for display, returning the original string on parse failure. */
export function prettyJson(input: string | null | undefined, indent = 2): string {
  if (!input) return ""
  try {
    return JSON.stringify(JSON.parse(input), null, indent)
  } catch {
    return input
  }
}

/** First N chars of a string, appending "…" if truncated. */
export function truncate(s: string, n = 80): string {
  if (s.length <= n) return s
  return `${s.slice(0, n - 1)}…`
}

/**
 * Heuristic to separate the FORWARDED system/agent-context from the user's
 * actual question in the first user message.
 *
 * Why heuristic: the gateway no longer wraps the forwarded system prompt in
 * a distinctive marker (the marker was triggering Anthropic's safety
 * redaction of thinking blocks — removing it was the fix). The forwarded
 * system text and the user's real question are simply joined with "\n\n".
 *
 * Heuristic rule: if the combined text is "large" (>= 600 chars) AND
 * contains at least one `\n\n`, treat everything BEFORE the last `\n\n`
 * as the forwarded-system/agent-context, and everything AFTER as the
 * user's real input. Short or unseparated messages are treated as pure
 * user input — no split.
 *
 * Worst case: a user's genuine multi-paragraph question with a `\n\n`
 * and total length > 600 chars gets its last paragraph shown as "user
 * input" and the earlier paragraphs hidden behind the "Context" card.
 * The Context card is expandable, so nothing is lost — just the first
 * impression is slightly off. The 95% case (OpenCode / Cline invocations
 * where the agent-context is 10-50 KB and the user question is a single
 * short paragraph) reads correctly.
 */

const SPLIT_MIN_SIZE = 600

/** @deprecated — kept exported for backwards compatibility with old imports.
 *  The gateway no longer wraps system prompts with this marker. */
export const CONTEXT_PREAMBLE_MARKER = ""

export function splitContextPreamble(text: string): {
  context?: string
  userInput: string
} {
  if (text.length < SPLIT_MIN_SIZE) {
    return { userInput: text }
  }
  const lastSep = text.lastIndexOf("\n\n")
  if (lastSep === -1) {
    // No separator in a long message — can't split safely; show as-is.
    return { userInput: text }
  }
  const candidateContext = text.slice(0, lastSep)
  const candidateInput = text.slice(lastSep + 2)
  // Sanity check: if the "user input" part is ALSO huge (>= half of the
  // text), the split is probably wrong and the whole thing is user input.
  if (candidateInput.length >= text.length / 2) {
    return { userInput: text }
  }
  return {
    context: candidateContext,
    userInput: candidateInput,
  }
}
