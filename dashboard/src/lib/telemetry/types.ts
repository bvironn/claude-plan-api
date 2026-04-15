import { z } from "zod";

export const TelemetryEventSchema = z.object({
  id: z.number().optional(),
  timestamp: z.string(),
  level: z.enum(["debug", "info", "warn", "error"]),
  traceId: z.string().optional(),
  spanId: z.string().optional(),
  parentSpanId: z.string().optional(),
  sessionId: z.string().optional(),
  userSessionId: z.string().optional(),
  event: z.string(),
  stream: z.string().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
  duration: z.number().optional(),
  stack: z.string().optional(),
  http_method: z.string().optional(),
  http_path: z.string().optional(),
  http_status: z.number().optional(),
  ip: z.string().optional(),
  user_agent: z.string().optional(),
});

export const LogsResponseSchema = z.object({
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
  events: z.array(TelemetryEventSchema),
});

export const TelemetryRequestSchema = z.object({
  traceId: z.string(),
  timestamp: z.string(),
  method: z.string(),
  path: z.string(),
  status: z.number().optional(),
  duration: z.number().optional(),
  model: z.string().optional(),
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  totalTokens: z.number().optional(),
  sessionId: z.string().optional(),
  ip: z.string().optional(),
  userAgent: z.string().optional(),
  error: z.string().optional(),
});

export const RequestsResponseSchema = z.object({
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
  requests: z.array(TelemetryRequestSchema),
});

export const RequestDetailSchema = z.object({
  request: TelemetryRequestSchema,
  events: z.array(TelemetryEventSchema),
});

// Matches the actual backend flat metrics shape
export const MetricsSchema = z.object({
  window_ms: z.number().optional(),
  generated_at: z.string().optional(),
  events_per_min: z.number().optional(),
  active_errors: z.number().optional(),
  requests_total: z.number().optional(),
  requests_by_status: z.record(z.string(), z.unknown()).optional(),
  latency_p50: z.number().optional(),
  latency_p95: z.number().optional(),
  latency_p99: z.number().optional(),
  tokens_in: z.number().optional(),
  tokens_out: z.number().optional(),
  cache_read_tokens: z.number().optional(),
  cache_creation_tokens: z.number().optional(),
  errors_by_route: z.record(z.string(), z.unknown()).optional(),
  // Optional structured format for future compatibility
  latency: z
    .object({
      p50: z.number(),
      p95: z.number(),
      p99: z.number(),
      avg: z.number(),
      count: z.number(),
    })
    .optional(),
  tokens: z
    .object({
      input: z.number(),
      output: z.number(),
      total: z.number(),
    })
    .optional(),
  errors: z
    .object({
      count: z.number(),
      rate: z.number(),
    })
    .optional(),
  requests_over_time: z
    .array(z.object({ time: z.string(), count: z.number() }))
    .optional(),
});

export type TelemetryEvent = z.infer<typeof TelemetryEventSchema>;
export type LogsResponse = z.infer<typeof LogsResponseSchema>;
export type TelemetryRequest = z.infer<typeof TelemetryRequestSchema>;
export type RequestsResponse = z.infer<typeof RequestsResponseSchema>;
export type RequestDetail = z.infer<typeof RequestDetailSchema>;
export type Metrics = z.infer<typeof MetricsSchema>;
