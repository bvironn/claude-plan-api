# claude-plan-api

OpenAI-compatible gateway for Claude Max/Pro, with first-class observability. Ships with an audit dashboard (React + TanStack Router + shadcn/ui) and the raw HTTP API + SQLite store for scripting.

## What This Repo Contains

- `src/`: Bun backend API gateway (`/v1/chat/completions`, `/v1/models`, `/health`, `/api/telemetry/*`)
- `src/ui/`: Audit dashboard — Vite + React 19 + TanStack Router + TanStack Query + Tailwind v4 + shadcn/ui (nova preset)
- `logs/`: runtime log files and `telemetry.db` SQLite store
- `__tests__/`: backend integration tests

## Requirements

- Bun (recommended latest stable)
- Claude Code authenticated locally (`~/.claude/.credentials.json`)

## Quick Start

### 1) Install deps

```bash
bun install
```

### 2) Start the gateway

```bash
bun run src/index.ts
```

Default port is `3456`. Pass an alternate port as the first arg: `bun run src/index.ts 3457`.

## API Endpoints

Core:

- `GET /health`
- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/tokens/count`
- `GET /api/account/profile`

Audit (read-only HTTP surface over the observability store):

- `GET /api/telemetry/logs` — event query (filters: level, stream, event, traceId, sessionId, search, from, to, limit, offset, order)
- `GET /api/telemetry/stream` — SSE live stream
- `GET /api/telemetry/metrics` — aggregated metrics for a time window
- `GET /api/telemetry/requests` — request records (one row per HTTP request, with `upstreamRequestBody` for `/v1/chat/completions` calls)
- `GET /api/telemetry/requests/:traceId` — single request plus its event timeline
- `GET /api/telemetry/export` — download events or requests as CSV/JSON

Example:

```bash
# see the last 5 chat completions with upstream body
curl -s "http://127.0.0.1:3456/api/telemetry/requests?limit=5" | jq '.requests[] | {traceId, model, duration, upstreamRequestBody}'
```

The SQLite store (`logs/telemetry.db`) is also directly queryable with any SQLite client.

## Configuration

- `PORT` (default: `3456`)
- `CREDENTIALS_PATH` (default: `~/.claude/.credentials.json`)
- `NODE_ENV` — not used for log routing; stdout is always included in the multistream so journalctl always sees live output.

## Testing

```bash
bun test
```

Specific suites:

```bash
bun test __tests__/observability.spec.ts
bun test __tests__/transform-thinking-passthrough.spec.ts
```

## Audit Dashboard

The dashboard is a static SPA bundled into `src/ui/dist/` and served by the backend alongside the API (same process, same port). In production, hitting `GET /` on the gateway serves the compiled dashboard; in development you run the Vite dev server with a proxy to the backend.

### Routes

- `/` — Requests list (filters: model, status, free-text search; URL-driven)
- `/sessions` — Conversations grouped from consecutive turns
- `/s/:sessionId` — All turns of a conversation, sticky-header per turn
- `/r/:traceId` — Full transcript (system blocks, messages, tools, reasoning) + technical side panel + span timeline + Replay + Export (JSON / Markdown)
- `/live` — Real-time SSE stream of telemetry events, pausable, level/stream filters
- `/metrics` — Aggregated metrics with window toggle (1m / 5m / 1h / 24h) + charts
- `/compare?a=<traceA>&b=<traceB>` — Side-by-side transcripts with scroll-sync

### Keyboard shortcuts (global)

- `/` — focus search input on the current route
- `j` / `k` — move list selection down / up (on the Requests list)
- `Enter` — open the selected row
- `Esc` — clear selection / blur focused input

### Dev loop

From the repo root, run the gateway and the Vite dev server in two terminals:

```bash
# terminal 1 — backend gateway (default port 3456, but we prefer 3457 for dev)
bun run src/index.ts 3457

# terminal 2 — UI dev server (Vite @ http://localhost:5173 with /api, /v1, /health proxied to 3457)
cd src/ui
bun install   # first time only
bun run dev
```

Open http://localhost:5173 in your browser. HMR is on. Every `/api/*`, `/v1/*`, `/health` request is proxied to `http://127.0.0.1:3457`.

### Build for production

The backend only serves `src/ui/dist/` if it exists on disk; build it once, then the gateway picks it up automatically on next request:

```bash
cd src/ui
bun run build     # runs `tsr generate && tsc -b && vite build` → writes src/ui/dist/
```

Then start the gateway as usual; `GET http://localhost:3456/` will now return the compiled SPA, and unknown GET paths fall through to `/index.html` for client-side routing.

### Typecheck

```bash
cd src/ui
bun run typecheck   # runs `tsr generate && tsc --noEmit`
```

## Docs

- Observability internals: `OBSERVABILITY.md`
