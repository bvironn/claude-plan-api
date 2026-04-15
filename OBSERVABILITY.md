# Observability

## Overview

Every HTTP request flows through the full observability pipeline:

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
1. **pino multistream**: `app.log` (all levels) + `error.log` (level ≥ error) + stdout in dev mode
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

## Frontend pipeline (`dashboard/`)

### Modules

#### `dashboard/src/lib/telemetry/capture.ts`

`capture(event, payload)` — the frontend equivalent of backend `emit()`. Calls `enqueue()` from buffer.ts with the event + sessionId + timestamp.

`start()` installs all DOM/API interceptors (idempotent via `initialized` guard). Called once by `ObservabilityProvider` on mount.

Internal interceptors:

- **click**: `document.addEventListener("click", ...)` capture=true — fires on every DOM click before other handlers
- **navigation**: monkey-patches `history.pushState` / `history.replaceState`, listens to `popstate`
- **fetch**: replaces `window.fetch` with a wrapper that emits start/end/error events, skip if `x-telemetry-internal: 1`
- **XHR**: monkey-patches `XMLHttpRequest.prototype.open` / `.send` to attach `_tel` metadata and fire start/loadend
- **errors**: `window.onerror`, `window.onunhandledrejection`
- **web-vitals**: lazy `import("web-vitals")` → CLS, FCP, LCP, INP, TTFB
- **scroll**: tracks `maxScrollPct` (high-water mark) via passive scroll listener
- **visibility**: `visibilitychange`, `focus`, `blur`, `pagehide`

#### `dashboard/src/lib/telemetry/buffer.ts`

IndexedDB queue with interval-based flushing. Guarantees delivery even on quick page unloads via `navigator.sendBeacon`.

Key constants:
- `FLUSH_INTERVAL_MS = 5000` — flush timer interval
- `FLUSH_BATCH_MAX = 50` — max events per flush batch
- `FLUSH_ENDPOINT = "/api/proxy/telemetry"` — routes through Next.js proxy to backend

`enqueue(event)` — adds to IndexedDB; triggers an immediate flush if the queue reaches `FLUSH_BATCH_MAX`.

`flushBatch(max)` — reads up to `max` events from IDB, deletes them, sends via `fetch` with `x-telemetry-internal: 1`.

`sendBeaconFlush()` — synchronous IDB read + `navigator.sendBeacon` for pagehide/visibilitychange=hidden.

`start()` — opens IDB, starts the flush interval, registers visibility/pagehide listeners.

#### `dashboard/src/components/observability-provider.tsx`

Client component that:
1. Calls `startBuffer()` and `startCapture()` on mount (React `useEffect`)
2. Wraps the entire app tree in a `ReactErrorBoundary` class component
3. `ReactErrorBoundary.componentDidCatch` emits `react.error` with message + stack + componentStack

---

### Captured events

| Event | When it fires | Key payload fields |
|---|---|---|
| `session.start` | On `start()` init | `url`, `referrer`, `userAgent` |
| `ui.click` | Any DOM click | `selector`, `text` (≤80 chars), `x`, `y`, `button`, `pageUrl` |
| `ui.nav` | `pushState` / `replaceState` / `popstate` | `type`, `url` |
| `net.fetch.start` | Before any `fetch()` call | `url`, `method`, `traceId` |
| `net.fetch.end` | After fetch resolves | `url`, `method`, `traceId`, `status`, `duration` (ms) |
| `net.fetch.error` | If fetch throws | `url`, `method`, `traceId`, `error`, `duration` |
| `net.xhr.start` | On `XMLHttpRequest.send()` | `url`, `method`, `traceId` |
| `net.xhr.end` | On XHR `loadend` | `url`, `method`, `traceId`, `status`, `duration` |
| `js.error` | `window.onerror` | `message`, `source`, `lineno`, `colno`, `stack` |
| `js.unhandledRejection` | `window.onunhandledrejection` | `reason`, `stack` |
| `web-vitals.CLS` | Core Web Vital | `value`, `rating` |
| `web-vitals.FCP` | Core Web Vital | `value`, `rating` |
| `web-vitals.LCP` | Core Web Vital | `value`, `rating` |
| `web-vitals.INP` | Core Web Vital | `value`, `rating` |
| `web-vitals.TTFB` | Core Web Vital | `value`, `rating` |
| `page.hidden` | `visibilitychange` → hidden | `url`, `timeOnPageMs`, `maxScrollPct` |
| `page.exit` | `pagehide` | `url`, `timeOnPageMs`, `maxScrollPct` |
| `window.focus` | window focus | `url` |
| `window.blur` | window blur | `url` |
| `react.error` | React error boundary | `message`, `stack`, `componentStack` |

Note: `net.fetch.*` skips calls that carry `x-telemetry-internal: 1` to prevent infinite loops when the buffer itself flushes.

---

### Adding tracking to a new React component — RECIPE

Import and call `capture()` directly anywhere in client components:

```tsx
"use client";
import { capture } from "@/lib/telemetry/capture";

function ExportButton() {
  const handleClick = () => {
    capture("ui.custom", {
      feature: "export",
      format: "csv",
      rowCount: 1234,
    });
    // ... do the export
  };

  return <button onClick={handleClick}>Export CSV</button>;
}
```

For tracking form submissions:

```tsx
capture("form.submit", {
  formId: "settings",
  fieldCount: 5,
  hasErrors: false,
});
```

Note: `capture()` is a no-op in SSR (`typeof window === "undefined"` guard), so it's safe to call in any component without conditional checks.

---

### Configuration

| Variable | Default | Description |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | via next.config.ts rewrite | Direct backend URL; overrides proxy |
| `BACKEND_URL` (server-side) | `http://127.0.0.1:3456` | Used by `/api/proxy/[...path]/route.ts` |
| Flush interval | `5000` ms | `FLUSH_INTERVAL_MS` in `buffer.ts` |
| Flush batch size | `50` events | `FLUSH_BATCH_MAX` in `buffer.ts` |
| Flush endpoint | `/api/proxy/telemetry` | Routes through Next.js to `BACKEND_URL/api/telemetry` |

---

## Dashboard usage (`/observability`)

- **Overview tab**: Live metrics cards (requests total, latency p50/p95, error count, events/min) + Recharts line chart of request rate over time + errors-by-route bar chart + device breakdown pie + click heatmap. Auto-refreshes every 10s.
- **Logs tab**: `EventsTable` — filterable by level, stream, event name, full-text search; sortable; paginated. Click any row to open the event payload drawer.
- **Requests tab**: `RequestsTable` — request-level view with method, path, status, duration, model; sortable; pagination. Click a row for the full `RequestDrawer` with all token counts, request/response bodies, and span timeline.
- **Sessions tab**: `SessionTimeline` — groups events by `sessionId`, renders a chronological event list per session.
- **Live tab**: `LiveStream` — connects to `GET /api/telemetry/stream` (SSE), tails events in real time with auto-reconnect (3s initial, up to 30s backoff).
- **Theme toggle**: top-right corner, persists in `localStorage` via `next-themes`.
- **Export button**: `ExportMenu` dropdown — exports events or requests as CSV or JSON via `GET /api/telemetry/export`.
- **Deep link**: `/observability/request/:traceId` renders a single-request view for shareable links.

---

## API Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Returns `{ status: "ok" }` |
| GET | `/v1/models` | List available Claude models |
| POST | `/v1/chat/completions` | OpenAI-compatible chat proxy |
| POST | `/api/telemetry` | Ingest frontend events (batch, max 500) |
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

### Backend only

```bash
bun src/index.ts [port]
# default port: 3456
```

### Dashboard

```bash
cd dashboard && bun run dev
# serves on :3000; proxies /api/proxy/* → http://127.0.0.1:3456
```

### Both together

```bash
(bun src/index.ts &) && (cd dashboard && bun run dev)
```

---

## Testing

```bash
bun test __tests__/observability.spec.ts
```

The test suite:
1. Spawns a backend server on port 3998
2. Verifies `GET /health` → `x-trace-id` header → SQLite `requests` + `events` rows
3. Posts a `ui.click` event via `POST /api/telemetry` and queries it back via `/api/telemetry/logs`
4. Opens SSE on `/api/telemetry/stream`, triggers requests, verifies events are received
5. Verifies `/api/telemetry/metrics` returns the expected shape with `requests_total > 0`
6. Verifies `/api/telemetry/export?format=csv` returns an attachment with correct CSV headers
7. Posts a `guard.toolError` event and confirms it persists through the ingest → SQLite → API pipeline
8. Verifies `/api/telemetry` accepts `x-telemetry-internal: 1` without error (anti-loop header)

---

## Troubleshooting

- **`logs/` not created**: Directory is auto-created by both `logger.ts` and `storage.ts` on startup. If permissions are wrong, check the process user.
- **Dashboard shows 0 events**: Verify backend is running on port 3456 (`bun src/index.ts`). The dashboard proxy reads `BACKEND_URL` env var (defaults to `http://127.0.0.1:3456`).
- **SSE shows "Connecting…" forever**: Check backend is up. The `LiveStream` component auto-reconnects with exponential backoff (3s → 30s cap) via EventSource.
- **SQLite "database is locked"**: WAL mode is on; concurrent readers are safe. A write conflict under heavy load would be transient — the `catch {}` in `insertEvent()` swallows it without crashing.
- **Log file names are `app.1.log` not `app.log`**: This is pino-roll v4 behavior. The suffix increments on each rotation. Use a glob like `app.*.log` to tail all rotations.
- **pino-roll streams not ready on first request**: Streams are built asynchronously; the synchronous stdout logger is active immediately. File writes land within ~1s of startup and are available for all subsequent requests.
