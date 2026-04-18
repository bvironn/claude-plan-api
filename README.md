# claude-plan-api

OpenAI-compatible gateway for Claude Max/Pro, with first-class observability. Audit is consumed directly via the HTTP API (curl, scripts, SQLite) — no bundled UI.

## What This Repo Contains

- `src/`: Bun backend API gateway (`/v1/chat/completions`, `/v1/models`, `/health`, `/api/telemetry/*`)
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

## Docs

- Observability internals: `OBSERVABILITY.md`
