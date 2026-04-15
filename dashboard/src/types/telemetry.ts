// Shared types mirroring backend types

export interface TelemetryEvent {
  id?: number;
  timestamp: string;
  level: "debug" | "info" | "warn" | "error";
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  sessionId?: string;
  userSessionId?: string;
  event: string;
  stream?: string;
  payload?: Record<string, unknown>;
  duration?: number;
  stack?: string;
  http_method?: string;
  http_path?: string;
  http_status?: number;
  ip?: string;
  user_agent?: string;
}

export interface TelemetryRequest {
  traceId: string;
  timestamp: string;
  method: string;
  path: string;
  status?: number;
  duration?: number;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  sessionId?: string;
  ip?: string;
  userAgent?: string;
  error?: string;
}

export interface TelemetryMetrics {
  latency: {
    p50: number;
    p95: number;
    p99: number;
    avg: number;
    count: number;
  };
  tokens: {
    input: number;
    output: number;
    total: number;
  };
  errors: {
    count: number;
    rate: number;
  };
  requests_by_status: Record<string, number>;
  errors_by_route: Array<{ route: string; count: number }>;
  window: string;
  requests_over_time?: Array<{ time: string; count: number }>;
}

export interface LogsResponse {
  total: number;
  limit: number;
  offset: number;
  events: TelemetryEvent[];
}

export interface RequestsResponse {
  total: number;
  limit: number;
  offset: number;
  requests: TelemetryRequest[];
}

export interface RequestDetailResponse {
  request: TelemetryRequest;
  events: TelemetryEvent[];
}

export interface LogsParams {
  level?: string;
  stream?: string;
  event?: string;
  traceId?: string;
  sessionId?: string;
  search?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
  order?: "asc" | "desc";
}

export interface RequestsParams {
  from?: string;
  to?: string;
  status?: string;
  method?: string;
  path?: string;
  traceId?: string;
  model?: string;
  minDuration?: number;
  maxDuration?: number;
  search?: string;
  limit?: number;
  offset?: number;
  order?: "asc" | "desc";
}
