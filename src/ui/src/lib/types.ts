/**
 * Shared UI types.
 *
 * These mirror the backend camelCase JSON shapes exactly. The backend route
 * mapper (`src/http/routes/telemetry/requests.ts` for /requests, etc.) is
 * the source of truth; these type declarations are a hand-written mirror
 * so the UI gets compile-time safety without codegen.
 */

// ---------------------------------------------------------------------------
// Request record (from GET /api/telemetry/requests and .../requests/:traceId)
// ---------------------------------------------------------------------------

export interface RequestRecord {
  id: number
  traceId: string
  timestamp: string
  method: string
  path: string
  status: number | null
  duration: number | null
  model: string | null
  isStream: boolean
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  requestBody: string | null
  responseBody: string | null
  upstreamRequestBody: string | null
  error: string | null
  ip?: string
  userAgent?: string
}

// ---------------------------------------------------------------------------
// Telemetry event (from GET /api/telemetry/logs and the SSE stream)
// ---------------------------------------------------------------------------

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal"
export type LogStream = "http" | "event" | "perf" | "app"

export interface TelemetryEvent {
  timestamp: string
  level: LogLevel
  traceId?: string
  spanId?: string
  parentSpanId?: string | null
  sessionId?: string
  userSessionId?: string
  event: string
  stream?: LogStream
  payload?: Record<string, unknown>
  duration?: number
  stack?: string
  httpMethod?: string
  httpPath?: string
  httpStatus?: number
  ip?: string
  userAgent?: string
}

// ---------------------------------------------------------------------------
// Metrics (from GET /api/telemetry/metrics?window=N)
// ---------------------------------------------------------------------------

export interface Metrics {
  eventsPerMin: number
  activeErrors: number
  latencyP50: number
  latencyP95: number
  latencyP99: number
  requestsTotal: number
  requestsByStatus: Record<number, number>
  tokensIn: number
  tokensOut: number
  cacheReadTokens: number
  cacheCreationTokens: number
  errorsByRoute: Record<string, number>
}

// ---------------------------------------------------------------------------
// Inside requestBody / upstreamRequestBody / responseBody (nested JSON)
// ---------------------------------------------------------------------------
// These describe what lives INSIDE the stringified JSON of the three body
// fields above. Use `parseOrNull` from `format.ts` to safely parse.

/** What the client sent to POST /v1/chat/completions (OpenAI shape). */
export interface OpenAIChatRequestBody {
  model?: string
  messages?: Array<{
    role: "system" | "user" | "assistant" | "tool"
    content: string | Array<Record<string, unknown>>
    tool_calls?: Array<Record<string, unknown>>
    tool_call_id?: string
    name?: string
  }>
  stream?: boolean
  max_tokens?: number
  temperature?: number
  response_format?: Record<string, unknown>
  reasoning_effort?: string
  options?: {
    reasoning_effort?: string
    effort?: string
    [k: string]: unknown
  }
  tools?: Array<Record<string, unknown>>
  [k: string]: unknown
}

/** What the gateway sent to api.anthropic.com (Anthropic shape). */
export interface AnthropicRequestBody {
  model: string
  max_tokens: number
  stream?: boolean
  system?: Array<{ type: "text"; text: string; cache_control?: Record<string, unknown> }>
  messages: Array<{
    role: "user" | "assistant"
    content: string | Array<Record<string, unknown>>
  }>
  metadata?: Record<string, unknown>
  temperature?: number
  thinking?: { type: "adaptive" | "enabled"; budget_tokens?: number }
  context_management?: { edits: Array<{ type: string; keep: string }> }
  output_config?: { effort?: string; format?: Record<string, unknown> }
  tools?: Array<{ name: string; description?: string; input_schema?: Record<string, unknown> }>
  [k: string]: unknown
}

/** What the gateway returned to the client (OpenAI shape). */
export interface OpenAIChatResponseBody {
  id?: string
  object?: string
  created?: number
  model?: string
  choices: Array<{
    index: number
    message: {
      role: "assistant"
      content: string | null
      reasoning_content?: string
      reasoning_details?: Array<Record<string, unknown>>
      tool_calls?: Array<{
        id: string
        type: "function"
        function: { name: string; arguments: string }
      }>
    }
    finish_reason?: string
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    completion_tokens_details?: { reasoning_tokens?: number }
  }
}

// ---------------------------------------------------------------------------
// Filters for /api/telemetry/requests
// ---------------------------------------------------------------------------

export interface RequestFilters {
  status?: number[]
  method?: string
  path?: string
  traceId?: string
  model?: string
  from?: string
  to?: string
  minDuration?: number
  maxDuration?: number
  search?: string
  limit?: number
  offset?: number
  order?: "asc" | "desc"
}
