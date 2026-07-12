/**
 * Typed fetch wrappers for the gateway's audit API.
 *
 * All calls are same-origin in production (served by the backend) and
 * go through Vite's `server.proxy` in dev (targeting :3457).
 */

import type {
  RequestRecord,
  RequestFilters,
  TelemetryEvent,
  Metrics,
} from "./types"
import { authHeaders, UnauthorizedError } from "./auth"

// ---------------------------------------------------------------------------
// Fetch helper
// ---------------------------------------------------------------------------

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { Accept: "application/json", ...authHeaders() },
  })
  // A 401 means the stored key is missing/invalid/revoked. Surface a typed
  // error so the global QueryCache.onError can trigger the key-entry modal
  // instead of showing a generic failure.
  if (res.status === 401) {
    throw new UnauthorizedError()
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`GET ${url} failed: ${res.status} ${text.slice(0, 200)}`)
  }
  return (await res.json()) as T
}

/**
 * POST counterpart to `getJson`. Serializes an optional JSON `body`, attaches
 * the same Bearer auth headers, and applies the identical 401 → typed-error
 * contract so create/revoke share the key-entry recovery flow. `body` is
 * omitted for bodyless POSTs (e.g. revoke), which skips the `Content-Type`.
 */
async function postJson<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...authHeaders(),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (res.status === 401) {
    throw new UnauthorizedError()
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`POST ${url} failed: ${res.status} ${text.slice(0, 200)}`)
  }
  return (await res.json()) as T
}

/**
 * PATCH counterpart to `postJson`. Serializes the JSON `body`, attaches the
 * same Bearer auth headers, and applies the identical 401 → typed-error
 * contract so rename shares the key-entry recovery flow. Used for partial
 * updates (currently the label-only key rename).
 */
async function patchJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify(body),
  })
  if (res.status === 401) {
    throw new UnauthorizedError()
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`PATCH ${url} failed: ${res.status} ${text.slice(0, 200)}`)
  }
  return (await res.json()) as T
}

function toQuery(params: Record<string, unknown>): string {
  const entries: string[] = []
  for (const [key, val] of Object.entries(params)) {
    if (val == null || val === "") continue
    if (Array.isArray(val)) {
      if (val.length === 0) continue
      entries.push(`${encodeURIComponent(key)}=${encodeURIComponent(val.join(","))}`)
      continue
    }
    entries.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(val))}`)
  }
  return entries.length > 0 ? `?${entries.join("&")}` : ""
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export interface RequestListResponse {
  total: number
  limit: number
  offset: number
  requests: RequestRecord[]
}

/**
 * List telemetry requests. Slim by default (no request/response/upstream
 * bodies); pass `bodies: "full"` in `filters` to opt into the full shape. The
 * flag rides through `toQuery` generically — no dedicated signature change —
 * so the backend receives `?bodies=full`.
 */
export function listRequests(filters: RequestFilters = {}): Promise<RequestListResponse> {
  return getJson<RequestListResponse>(`/api/telemetry/requests${toQuery(filters as Record<string, unknown>)}`)
}

export interface RequestByTraceResponse {
  request: RequestRecord
  events: TelemetryEvent[]
}

export function getRequest(traceId: string): Promise<RequestByTraceResponse> {
  return getJson<RequestByTraceResponse>(`/api/telemetry/requests/${encodeURIComponent(traceId)}`)
}

// ---------------------------------------------------------------------------
// Logs / events
// ---------------------------------------------------------------------------

export interface LogsResponse {
  total: number
  limit: number
  offset: number
  events: TelemetryEvent[]
}

export interface LogsFilters {
  level?: LogLevel[]
  stream?: LogStream[]
  event?: string
  traceId?: string
  sessionId?: string
  search?: string
  from?: string
  to?: string
  limit?: number
  offset?: number
  order?: "asc" | "desc"
}

type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal"
type LogStream = "http" | "event" | "perf" | "app"

export function listLogs(filters: LogsFilters = {}): Promise<LogsResponse> {
  return getJson<LogsResponse>(`/api/telemetry/logs${toQuery(filters as Record<string, unknown>)}`)
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export function getMetrics(windowMs: number): Promise<Metrics> {
  return getJson<Metrics>(`/api/telemetry/metrics?window=${windowMs}`)
}

// ---------------------------------------------------------------------------
// API keys (from /api/keys — metadata list, create, revoke)
// ---------------------------------------------------------------------------
// These mirror the backend DTOs. `key_hash` is NEVER present: the list route
// selects an explicit column allowlist and the create route returns a literal
// DTO, so the secret is structurally absent from every response the UI sees.

/** Metadata-only projection of an `api_keys` row (never carries `key_hash`). */
export interface ApiKeyMeta {
  id: number
  prefix: string
  label: string
  created_at: string
  /** `null` means the key is active; an ISO timestamp means revoked. */
  revoked_at: string | null
  /**
   * `1` marks an admin key (dashboard `/api/*` access). Display-only here — the
   * UI can never create or toggle admin status; only the CLI mints admin keys.
   */
  is_admin: number
  /** UTC ISO timestamp of the most recent rotation; `null`/absent means never rotated. */
  rotated_at?: string | null
  /**
   * UTC ISO timestamp of the key's most recent attributed request, computed
   * UNWINDOWED on the backend (correlated `MAX(timestamp)` over `requests`,
   * independent of the 30-day usage window). `null` means the key was never
   * used. Mirrors the backend `ApiKeyMeta` field exactly.
   */
  last_used_at: string | null
}

export interface ApiKeyListResponse {
  keys: ApiKeyMeta[]
}

/**
 * Create response — the ONLY place the plaintext key (`full`) is ever
 * returned. It is shown to the operator once and never retrievable again.
 */
export interface CreatedApiKey {
  id: number
  prefix: string
  label: string
  created_at: string
  full: string
}

export function listApiKeys(): Promise<ApiKeyListResponse> {
  return getJson<ApiKeyListResponse>("/api/keys")
}

export function createApiKey(label: string): Promise<CreatedApiKey> {
  return postJson<CreatedApiKey>("/api/keys", { label })
}

export function revokeApiKey(id: number): Promise<{ revoked: boolean }> {
  return postJson<{ revoked: boolean }>(`/api/keys/${id}/revoke`)
}

/**
 * Rename an existing key's human-facing `label`. PATCHes `/api/keys/:id` with a
 * `{ label }` body and returns the updated metadata (never the secret). The
 * backend restricts this to ACTIVE keys: a revoked key yields 409 and an
 * unknown id yields 404, both surfaced as a thrown `Error` here.
 */
export function renameApiKey(id: number, label: string): Promise<ApiKeyMeta> {
  return patchJson<ApiKeyMeta>(`/api/keys/${id}`, { label })
}

/**
 * Rotate response — the ONLY place the fresh plaintext key (`full`) is ever
 * returned for an EXISTING key. Mirrors `CreatedApiKey`'s one-time-secret
 * contract, plus `rotated_at` recording when the swap happened. Never carries
 * `key_hash` or the prior plaintext.
 */
export interface RotatedApiKey {
  id: number
  prefix: string
  label: string
  created_at: string
  revoked_at: string | null
  rotated_at: string
  full: string
}

/**
 * Rotate an existing key's secret in place (same `id`, fresh `prefix` +
 * secret). POSTs `/api/keys/:id/rotate` with no body and returns the
 * one-time-reveal DTO. The backend restricts this to ACTIVE keys: a revoked
 * key yields 409 and an unknown id yields 404, both surfaced as a thrown
 * `Error` here (matches `renameApiKey`).
 */
export function rotateApiKey(id: number): Promise<RotatedApiKey> {
  return postJson<RotatedApiKey>(`/api/keys/${id}/rotate`)
}

// ---------------------------------------------------------------------------
// Per-key usage (from /api/telemetry/usage)
// ---------------------------------------------------------------------------

/** One aggregated usage row per attributed `api_key_id`. */
export interface UsageByKey {
  api_key_id: number | null
  prefix: string | null
  label: string | null
  requests: number
  tokens_in: number
  tokens_out: number
  cache_read_tokens: number
  cache_creation_tokens: number
}

export interface UsageResponse {
  generated_at: string
  time_from: string | null
  time_to: string | null
  keys: UsageByKey[]
}

/**
 * Fetch per-API-key usage totals. The `/keys` table joins these to each key by
 * `api_key_id` to render a usage column.
 */
export function getUsageByApiKey(): Promise<UsageResponse> {
  return getJson<UsageResponse>("/api/telemetry/usage")
}
