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
