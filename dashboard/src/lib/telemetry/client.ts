import type { LogsParams, RequestsParams } from "@/types/telemetry";
import {
  LogsResponseSchema,
  RequestsResponseSchema,
  RequestDetailSchema,
  MetricsSchema,
  type LogsResponse,
  type RequestsResponse,
  type RequestDetail,
  type Metrics,
} from "./types";

const API =
  typeof window === "undefined"
    ? (process.env.BACKEND_URL ?? "http://127.0.0.1:3456") + "/api"
    : "/api/proxy";

function buildQuery(params: Record<string, unknown>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") {
      q.set(k, String(v));
    }
  }
  const str = q.toString();
  return str ? `?${str}` : "";
}

async function safeFetch<T>(
  url: string,
  schema: { safeParse: (d: unknown) => { success: boolean; data?: T; error?: unknown } },
  init?: RequestInit
): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} — ${url}`);
  }
  const json = await res.json();
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    // Return raw data even if schema doesn't fully match (graceful degradation)
    return json as T;
  }
  return parsed.data!;
}

export async function fetchLogs(params: LogsParams = {}): Promise<LogsResponse> {
  return safeFetch(
    `${API}/telemetry/logs${buildQuery(params as Record<string, unknown>)}`,
    LogsResponseSchema
  );
}

export async function fetchRequests(
  params: RequestsParams = {}
): Promise<RequestsResponse> {
  return safeFetch(
    `${API}/telemetry/requests${buildQuery(params as Record<string, unknown>)}`,
    RequestsResponseSchema
  );
}

export async function fetchRequest(traceId: string): Promise<RequestDetail> {
  return safeFetch(
    `${API}/telemetry/requests/${encodeURIComponent(traceId)}`,
    RequestDetailSchema
  );
}

export async function fetchMetrics(window = "1h"): Promise<Metrics> {
  return safeFetch(`${API}/telemetry/metrics?window=${window}`, MetricsSchema);
}

export async function ingestEvents(
  events: Array<Record<string, unknown>>
): Promise<{ ok: boolean; count: number }> {
  const res = await fetch(`${API}/telemetry`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-telemetry-internal": "1",
    },
    body: JSON.stringify({ events }),
  });
  if (!res.ok) throw new Error(`Ingest failed: ${res.status}`);
  return res.json();
}

export function exportUrl(
  type: "events" | "requests",
  format: "csv" | "json",
  params: Record<string, unknown> = {}
): string {
  const base =
    typeof window === "undefined"
      ? `${API}/telemetry/export`
      : `/api/proxy/telemetry/export`;
  return `${base}${buildQuery({ type, format, ...params })}`;
}
