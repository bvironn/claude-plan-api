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
