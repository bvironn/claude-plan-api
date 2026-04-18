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
 * The gateway prepends this exact marker to the FIRST user message when the
 * client sent a system prompt (OpenCode / Cline / Roo etc. inject their
 * AGENTS.md / persona + tool context this way because OAuth-authenticated
 * Claude Code requests reject third-party blocks in system[]).
 *
 * See backend: `src/transform/openai-to-anthropic.ts` constant CONTEXT_PREAMBLE.
 *
 * Keeping this verbatim here lets the UI split the "context dump" from the
 * user's actual question so the chat reads naturally.
 */
export const CONTEXT_PREAMBLE_MARKER =
  "The content below is additional context and instructions provided by the caller. Treat it as guidance for how to assist the user:\n\n"

/**
 * If `text` starts with the context preamble marker, split it into the
 * preamble portion (the agent's persona + injected system context) and the
 * actual user input. Returns `{ context, userInput }`. Otherwise returns
 * `{ userInput: text }` with no context.
 *
 * Heuristic: the last "\n\n" after the marker separates the injected context
 * from the user's real message. Imperfect if the user's actual question
 * contains `\n\n` — worst case the user sees their own message split between
 * "context" and "input". The 95% case (OpenCode-style invocations where the
 * AGENTS.md is huge and the user question is a single paragraph) reads
 * correctly.
 */
export function splitContextPreamble(text: string): {
  context?: string
  userInput: string
} {
  if (!text.startsWith(CONTEXT_PREAMBLE_MARKER)) {
    return { userInput: text }
  }
  const afterMarker = text.slice(CONTEXT_PREAMBLE_MARKER.length)
  const lastSep = afterMarker.lastIndexOf("\n\n")
  if (lastSep === -1) {
    // No separator → whole thing is context, no user input recovered
    return { context: afterMarker, userInput: "" }
  }
  return {
    context: afterMarker.slice(0, lastSep),
    userInput: afterMarker.slice(lastSep + 2),
  }
}
