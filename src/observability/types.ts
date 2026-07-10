export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

export type LogStream = "http" | "event" | "perf" | "app";

export interface TelemetryEvent {
  timestamp: string;
  level: LogLevel;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string | null;
  sessionId?: string;
  userSessionId?: string;
  event: string;
  stream?: LogStream;
  payload?: Record<string, unknown>;
  duration?: number;
  stack?: string;
  httpMethod?: string;
  httpPath?: string;
  httpStatus?: number;
  ip?: string;
  userAgent?: string;
}

export interface RequestRecord {
  trace_id: string;
  timestamp: string;
  method?: string;
  path?: string;
  status?: number;
  duration_ms?: number;
  ip?: string;
  user_agent?: string;
  model?: string;
  is_stream?: number;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
  request_body?: string;
  response_body?: string;
  upstream_request_body?: string | null;
  error?: string;
  // Advisory (app-enforced) reference to the issuing api_keys.id. NULL when
  // authentication is disabled or the route is exempt.
  api_key_id?: number;
}

/**
 * A row in the `api_keys` table. Only the digest (`key_hash`) is persisted —
 * never the plaintext secret. `revoked_at` NULL means the key is active.
 * `is_admin` (0 | 1) marks a dashboard-privileged key: `/api/*` (the dashboard
 * data layer) requires `is_admin === 1`, while `/v1/*` accepts any valid key.
 * Only the CLI (`scripts/create-api-key.ts`) can mint an admin key.
 */
export interface ApiKeyRecord {
  id?: number;
  prefix: string;
  key_hash: string;
  label: string;
  created_at: string;
  revoked_at?: string | null;
  is_admin: number;
}

/**
 * Metadata-only projection of an `api_keys` row, safe to expose over HTTP.
 * Deliberately OMITS `key_hash` (and any plaintext) so a handler that returns
 * an `ApiKeyMeta` cannot leak a secret. `listApiKeys()` SELECTs exactly these
 * columns; `revoked_at` NULL means the key is active. `is_admin` is NOT secret
 * — the admin UI uses it to flag which key(s) hold dashboard access.
 */
export interface ApiKeyMeta {
  id: number;
  prefix: string;
  label: string;
  created_at: string;
  revoked_at: string | null;
  is_admin: number;
}

/**
 * Aggregated per-key usage produced by `getUsageByApiKey()`: one row per
 * attributed `api_key_id`, joined to its `api_keys` metadata, with request
 * count and summed token columns for the queried time window.
 */
export interface UsageByKey {
  api_key_id: number | null;
  prefix: string | null;
  label: string | null;
  requests: number;
  tokens_in: number;
  tokens_out: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
}

export interface TraceContext {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  sessionId: string;
  startedAt: number;
  attributes: Record<string, unknown>;
}

export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  startedAt: number;
  endedAt?: number;
  duration?: number;
  error?: Error;
}
