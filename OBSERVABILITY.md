# Observability

## Overview

Most backend requests flow through the full observability pipeline.

Note: telemetry endpoints under `/api/telemetry*` are intentionally excluded from middleware tracing to avoid self-observation loops.

```
HTTP Request
     │
     ▼
┌─────────────────────────────────────────────────────────────┐
│  withObservability() middleware  (src/observability/        │
│  middleware.ts)                                             │
│                                                             │
│  • generates traceId + spanId (crypto.randomUUID)           │
│  • creates TraceContext in AsyncLocalStorage                 │
│  • reads ip, user-agent from headers                        │
│  • clones body for logging (POST/PUT/PATCH)                 │
│  • emits http.request.start, inserts requests row           │
│  • calls route handler                                      │
│  • emits http.request.end, updates requests row             │
│  • injects x-trace-id response header                       │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
               Route Handler (business logic)
               may call emit() / withSpan()
                          │
                          ▼
               emit() in src/observability/logger.ts
                          │
               ┌──────────┼──────────────┐
               ▼          ▼              ▼
          pino logger   SQLite        event-bus
          (multistream) insertEvent() publish()
               │                         │
    ┌──────────┼──────────┐              ▼
    ▼          ▼          ▼        SSE subscribers
  app.log   http.log  events.log  (GET /api/telemetry/stream)
  error.log perf.log
```

---

## Backend pipeline

### Modules

#### `src/observability/logger.ts`

Central `emit()` function — the single entry point for all telemetry writes. Builds a `TelemetryEvent` by merging:
- caller-supplied `level`, `event`, `payload`
- current trace context from `AsyncLocalStorage` (`traceId`, `spanId`, `sessionId`)
- optional `EmitOverrides` for frontend-originated events (traceId, sessionId, timestamp)

Writes to three sinks simultaneously:
1. **pino multistream**: `app.log` (all levels) + `error.log` (level ≥ error) + `stdout` (always, so systemd `journalctl` has live visibility in every environment)
2. **Tagged streams**: `http.log` (stream=`http`), `events.log` (stream=`event`), `performance.log` (stream=`perf`)
3. **SQLite**: `insertEvent()` from storage.ts
4. **Event bus**: `publish()` from event-bus.ts → SSE clients

Convenience wrappers: `logHttp()`, `logEvent()`, `logPerf()`, `logError()`.

Log streams are built asynchronously at startup via `pino-roll` (daily rotation, 50MB size limit). A synchronous stdout fallback is used while streams initialize.

#### `src/observability/tracer.ts`

`AsyncLocalStorage`-backed trace context store. Key exports:

- `newTraceId()` — `crypto.randomUUID()`
- `runWithTrace(ctx, fn)` — runs `fn` inside the ALS store with `ctx`
- `currentTrace()` — retrieves active `TraceContext` from current async context
- `withSpan(name, fn, attrs?)` — creates a child span, emits `{name}.start` / `{name}.end` / `{name}.error` with duration, re-throws on error

#### `src/observability/storage.ts`

SQLite facade using `bun:sqlite`. Initializes with WAL mode + NORMAL synchronous for safe concurrent reads.

**Tables:**

`events` table:
| column | type | description |
|---|---|---|
| id | INTEGER PK | autoincrement |
| timestamp | TEXT | ISO 8601 |
| level | TEXT | trace/debug/info/warn/error/fatal |
| trace_id | TEXT | from AsyncLocalStorage or override |
| span_id | TEXT | current span |
| parent_span_id | TEXT | parent span (nullable) |
| session_id | TEXT | server process session UUID |
| user_session_id | TEXT | frontend session ID (frontend events) |
| event | TEXT | dotted event name, e.g. `http.request.start` |
| stream | TEXT | http / event / perf / app |
| payload | TEXT | JSON-stringified payload |
| duration_ms | REAL | duration if applicable |
| stack | TEXT | error stack trace |
| http_method | TEXT | HTTP method |
| http_path | TEXT | request path |
| http_status | INTEGER | response status code |
| ip | TEXT | client IP |
| user_agent | TEXT | client User-Agent |

Indexes: `timestamp`, `trace_id`, `level`, `stream`, `event`

`requests` table:
| column | type | description |
|---|---|---|
| id | INTEGER PK | autoincrement |
| trace_id | TEXT UNIQUE | one row per request |
| timestamp | TEXT | when request arrived |
| method | TEXT | GET/POST/etc |
| path | TEXT | URL pathname |
| status | INTEGER | response code (filled on end) |
| duration_ms | REAL | total handler time |
| ip | TEXT | client IP |
| user_agent | TEXT | client UA |
| model | TEXT | Claude model if chat request |
| is_stream | INTEGER | 1 if SSE streaming |
| input_tokens | INTEGER | Claude input token count |
| output_tokens | INTEGER | Claude output token count |
| cache_read_tokens | INTEGER | cache hit tokens |
| cache_creation_tokens | INTEGER | cache write tokens |
| request_body | TEXT | raw request body (clipped) |
| response_body | TEXT | raw response body (chat routes) |
| error | TEXT | error message if handler threw |

Indexes: `timestamp`, `status`, `path`

Exported query helpers: `queryEvents()`, `queryRequests()`, `countEvents()`, `countRequests()`, `getMetrics()`, `insertEvent()`, `insertRequest()`, `updateRequest()`, `queryEventsRaw()`, `queryRequestsRaw()`, `getRequestByTrace()`

#### `src/observability/event-bus.ts`

In-memory pub/sub for real-time SSE delivery. A `Set<Subscriber>` holds callbacks. `publish(event)` fans out to all subscribers synchronously (errors per subscriber are swallowed). `subscribe(fn)` returns an unsubscribe closure.

#### `src/observability/middleware.ts`

`withObservability(handler)` — wraps any route handler with the full trace lifecycle:
1. Generates `traceId` + `spanId` via `newTraceId()`
2. Extracts `ip` from `x-forwarded-for` / `x-real-ip` headers
3. Clones the request body (so the original stream is still consumable)
4. Runs the handler inside `runWithTrace()` so all nested `emit()` calls inherit the context
5. Emits `http.request.start` (stream=`http`) with method, path, query, ip, userAgent, body
6. Calls `insertRequest()` with the partial record
7. On success: emits `http.request.end`, calls `updateRequest()` with status + duration
8. On error: emits `http.request.error`, updates record with status=500, re-throws
9. Adds `x-trace-id` header to the final response

Important behavior:

- Requests whose path starts with `/api/telemetry` bypass this middleware (`SILENT_PATH_PREFIXES`), so they do not generate `http.request.*` events.

#### `src/observability/globals.ts`

Installs four Node.js process handlers on startup:
- `unhandledRejection` → `process.unhandledRejection` event (fatal)
- `uncaughtException` → `process.uncaughtException` event (fatal)
- `SIGTERM` → `process.shutdown` event (info)
- `SIGINT` → `process.shutdown` event (info)

---

### Log files (`logs/`)

pino-roll v4 names files with a numeric suffix (e.g. `app.1.log`) that increments on each rotation.

| file | content |
|---|---|
| `app.*.log` | all events, all levels — main application log |
| `error.*.log` | only events with level ≥ `error` |
| `http.*.log` | events emitted with `stream="http"` (request start/end/error) |
| `events.*.log` | events emitted with `stream="event"` (frontend events, domain events) |
| `performance.*.log` | events emitted with `stream="perf"` (span timings) |
| `telemetry.db` | SQLite — full queryable store |

---

### Event shape

Every event written to SQLite / pino / event-bus:

```ts
{
  timestamp: string;        // ISO 8601
  level: "trace"|"debug"|"info"|"warn"|"error"|"fatal";
  traceId?: string;         // UUID from AsyncLocalStorage
  spanId?: string;          // current span UUID
  parentSpanId?: string | null;
  sessionId?: string;       // server process UUID (or frontend session)
  userSessionId?: string;   // frontend session ID (frontend events only)
  event: string;            // dotted name: "http.request.start"
  stream?: "http"|"event"|"perf"|"app";
  payload?: Record<string, unknown>;
  duration?: number;        // ms
  stack?: string;           // error stacks
  httpMethod?: string;
  httpPath?: string;
  httpStatus?: number;
  ip?: string;
  userAgent?: string;
}
```

---

### Adding tracking to a new feature — RECIPE

**Step 1.** Import the emit helper:

```ts
import { emit } from "../observability/logger.ts";
```

**Step 2.** Call `emit()` at key decision points:

```ts
emit("info", "cache.hit", { key, ttlMs: remaining });
emit("warn", "cache.miss", { key, reason: "expired" });
```

**Step 3.** For timed async work, use `withSpan()`:

```ts
import { withSpan } from "../observability/tracer.ts";

const result = await withSpan("cache.lookup", async (ctx) => {
  // ctx.traceId available; duration logged automatically on exit
  return await redis.get(key);
});
```

**Step 4.** To persist feature-specific columns in the `requests` row:

```ts
import { updateRequest } from "../observability/storage.ts";
import { currentTrace } from "../observability/tracer.ts";

const trace = currentTrace();
if (trace) {
  updateRequest(trace.traceId, { model: selectedModel });
}
```

**Example: cache.hit / cache.miss tracking**

```ts
export async function getFromCache(key: string): Promise<string | null> {
  const value = await cache.get(key);
  if (value !== null) {
    emit("debug", "cache.hit", { key, bytes: value.length }, "perf");
  } else {
    emit("debug", "cache.miss", { key }, "perf");
  }
  return value;
}
```

---

## API Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Returns `{ status: "ok" }` |
| GET | `/v1/models` | List available Claude models |
| POST | `/v1/chat/completions` | OpenAI-compatible chat proxy |
| POST | `/v1/tokens/count` | Count tokens for a given message shape |
| GET | `/api/account/profile` | Cached Anthropic profile (account, organization, application) |
| GET | `/api/telemetry/logs` | Query events with filters |
| GET | `/api/telemetry/stream` | SSE stream of live events |
| GET | `/api/telemetry/metrics` | Aggregated metrics for a time window |
| GET | `/api/telemetry/requests` | Query request records |
| GET | `/api/telemetry/requests/:traceId` | Single request by traceId |
| GET | `/api/telemetry/export` | Download events or requests as CSV/JSON |

Query parameters for `/api/telemetry/logs`:
`level`, `stream`, `event`, `traceId`, `sessionId`, `search`, `from`, `to`, `limit` (max 1000), `offset`, `order` (asc/desc)

Query parameters for `/api/telemetry/metrics`:
`window` — milliseconds (default 300000)

---

## Running

```bash
bun src/index.ts [port]
# default port: 3456
```

Run under systemd for production; journalctl shows all telemetry events (stdout is always attached to the pino multistream — see `logger.ts`).

---

## Testing

```bash
bun test __tests__/observability.spec.ts
```

The test suite:
1. Spawns a backend server on an ephemeral port.
2. Verifies `GET /health` → `x-trace-id` header → SQLite `requests` + `events` rows.
3. Opens SSE on `/api/telemetry/stream`, triggers requests, verifies events are received.
4. Verifies `/api/telemetry/metrics` returns the expected shape with `requests_total > 0`.
5. Verifies `/api/telemetry/export?format=csv` returns an attachment with correct CSV headers.

---

## Troubleshooting

- **`logs/` not created**: Directory is auto-created by both `logger.ts` and `storage.ts` on startup. If permissions are wrong, check the process user.
- **SSE shows "Connecting…" forever**: Check the server is up. Clients should implement exponential backoff (3s → 30s cap) on `EventSource` reconnects.
- **SQLite "database is locked"**: WAL mode is on; concurrent readers are safe. A write conflict under heavy load would be transient — the `catch {}` in `insertEvent()` swallows it without crashing.
- **Log file names are `app.1.log` not `app.log`**: This is pino-roll v4 behavior. The suffix increments on each rotation. Use a glob like `app.*.log` to tail all rotations.
- **pino-roll streams not ready on first request**: Streams are built asynchronously; the synchronous stdout logger is active immediately. File writes land within ~1s of startup and are available for all subsequent requests.
- **`journalctl -u claude-plan-api` is quiet**: Confirm you are on commit `0bcaf20` or later — earlier code gated stdout behind `NODE_ENV !== production`, which made the journal silent under systemd. The current logger always includes stdout.
