/**
 * Pure per-key metric derivation.
 *
 * Given the `requests` rows attributed to a single API key (via `api_key_id`,
 * fetched with `listRequests({ apiKeyId })`), compute the usage metrics the
 * detail view renders. Every value here traces to a real `requests` column —
 * NO cost/pricing is invented, because the schema has no pricing column.
 *
 * This module is intentionally free of React and DOM so it is trivially
 * unit-testable and side-effect free.
 */

import type { ApiKeyMeta } from "./api"
import type { RequestRecord } from "./types"

/** One row of the per-model breakdown table. */
export interface PerModelMetric {
  model: string
  count: number
  tokensIn: number
  tokensOut: number
}

/** Aggregate metrics for one API key, derived only from real `requests` columns. */
export interface KeyMetrics {
  requestCount: number
  tokensIn: number
  tokensOut: number
  cacheReadTokens: number
  cacheCreationTokens: number
  /** Failed requests (`status >= 400`) divided by total. `0` when no requests. */
  errorRate: number
  /** Per-model breakdown, sorted by request count descending. */
  perModel: PerModelMetric[]
  /** ISO timestamp of the earliest attributed request, or `null` when none. */
  firstActivity: string | null
  /** ISO timestamp of the latest attributed request, or `null` when none. */
  lastActivity: string | null
}

/** Label used when a request row has no `model` value. */
const UNKNOWN_MODEL = "(unknown)"

/** HTTP status at or above which a request counts as failed. */
const ERROR_STATUS_THRESHOLD = 400

/**
 * Resolve the API key whose `id` matches a route string param (`/keys/$keyId`).
 *
 * Route params arrive as strings; this parses the id and returns the matching
 * key or `null`. A `null` result is the not-found signal the detail route
 * renders as a clean "key not found" state — it MUST never throw, so a
 * non-numeric or empty param resolves to `null` rather than crashing.
 */
export function findApiKeyById(
  keys: ApiKeyMeta[],
  keyIdParam: string,
): ApiKeyMeta | null {
  const id = Number(keyIdParam)
  if (!Number.isInteger(id) || keyIdParam.trim() === "") return null
  return keys.find((k) => k.id === id) ?? null
}

export function deriveKeyMetrics(requests: RequestRecord[]): KeyMetrics {
  let tokensIn = 0
  let tokensOut = 0
  let cacheReadTokens = 0
  let cacheCreationTokens = 0
  let failedCount = 0
  let firstActivity: string | null = null
  let lastActivity: string | null = null

  // Preserve first-seen order for stable tie-breaking, then sort by count.
  const perModelMap = new Map<string, PerModelMetric>()

  for (const r of requests) {
    const inT = r.inputTokens ?? 0
    const outT = r.outputTokens ?? 0
    tokensIn += inT
    tokensOut += outT
    cacheReadTokens += r.cacheReadTokens ?? 0
    cacheCreationTokens += r.cacheCreationTokens ?? 0

    if (r.status != null && r.status >= ERROR_STATUS_THRESHOLD) {
      failedCount += 1
    }

    if (r.timestamp) {
      if (firstActivity == null || r.timestamp < firstActivity) firstActivity = r.timestamp
      if (lastActivity == null || r.timestamp > lastActivity) lastActivity = r.timestamp
    }

    const model = r.model ?? UNKNOWN_MODEL
    const existing = perModelMap.get(model)
    if (existing) {
      existing.count += 1
      existing.tokensIn += inT
      existing.tokensOut += outT
    } else {
      perModelMap.set(model, { model, count: 1, tokensIn: inT, tokensOut: outT })
    }
  }

  const requestCount = requests.length
  const errorRate = requestCount === 0 ? 0 : failedCount / requestCount

  const perModel = [...perModelMap.values()].sort((a, b) => b.count - a.count)

  return {
    requestCount,
    tokensIn,
    tokensOut,
    cacheReadTokens,
    cacheCreationTokens,
    errorRate,
    perModel,
    firstActivity,
    lastActivity,
  }
}
