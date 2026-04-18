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
