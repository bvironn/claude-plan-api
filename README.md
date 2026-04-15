# claude-plan-api

OpenAI-compatible gateway for Claude Max/Pro, with first-class observability and an integrated dashboard.

## What This Repo Contains

- `src/`: Bun backend API gateway (`/v1/chat/completions`, `/v1/models`, `/health`)
- `dashboard/`: Next.js UI for telemetry, logs, requests, sessions, and live stream
- `logs/`: runtime log files and `telemetry.db` SQLite store
- `__tests__/`: backend observability integration tests

## Requirements

- Bun (recommended latest stable)
- Claude Code authenticated locally (`~/.claude/.credentials.json`)

## Quick Start

### 1) Install backend deps

```bash
bun install
```

### 2) Start backend

```bash
bun run src/index.ts
```

Default port is `3456`.

### 3) Install dashboard deps

```bash
cd dashboard && bun install
```

### 4) Start dashboard

```bash
cd dashboard && bun run dev
```

Dashboard runs on `http://localhost:3000` and proxies telemetry API calls to backend (`http://127.0.0.1:3456` by default).

## API Endpoints

Core:

- `GET /health`
- `GET /v1/models`
- `POST /v1/chat/completions`

Telemetry:

- `POST /api/telemetry`
- `GET /api/telemetry/logs`
- `GET /api/telemetry/stream`
- `GET /api/telemetry/metrics`
- `GET /api/telemetry/requests`
- `GET /api/telemetry/requests/:traceId`
- `GET /api/telemetry/export`

## Configuration

Backend:

- `PORT` (default: `3456`)
- `CREDENTIALS_PATH` (default: `~/.claude/.credentials.json`)

Dashboard:

- `BACKEND_URL` (server-side, default: `http://127.0.0.1:3456`)
- `NEXT_PUBLIC_API_URL` (optional direct backend override)

## Testing

Run backend tests:

```bash
bun test
```

Run specific observability suite:

```bash
bun test __tests__/observability.spec.ts
```

## Docs

- Detailed observability internals: `OBSERVABILITY.md`
- Dashboard app notes: `dashboard/README.md`
