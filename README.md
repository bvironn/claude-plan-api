# claude-plan-api

OpenAI-compatible gateway for Claude Max. Nothing you couldn't build yourself
in a weekend, except we spent about twenty commits tracking down one specific
server behaviour so you don't have to.

Three things it does, in this order of importance:

1. Speaks the OpenAI dialect, so your existing tools just work.
2. Logs every byte of every call — client body, transformed upstream body, raw
   SSE stream, timings, tokens, reasoning. Everything. On disk.
3. Ships a dashboard that treats an LLM call as a first-class object:
   readable, searchable, replayable.

## Disclaimer, being honest about it

This gateway authenticates with Anthropic using your Claude Code OAuth
credentials. Anthropic's Terms of Service state those tokens are for official
clients. This project is not an official client — it is a community
workaround, and a pragmatic one.

Anthropic can break it tomorrow by changing the OAuth flow or the billing
signature contract. We have already seen them tighten screws around thinking
redaction mid-2026. If one day the gateway stops working, it is not you, it
is the moving ground.

Use at your own discretion. Do not put this behind a product you charge money
for.

## Features

- **OpenAI-compatible API** at `/v1/chat/completions`, `/v1/models`,
  `/v1/tokens/count`. Point an existing OpenAI client at it, it works.
- **Full-fidelity audit** of every call. Not "enough for debugging" — every
  byte, every event, every timing, on disk, queryable with any SQLite client.
- **Integrated dashboard** at `/`. Requests list, full transcript, sessions,
  live event stream, metrics, side-by-side compare, replay, export.
- **Plaintext reasoning** instead of ciphertext. If that sentence sounds
  unnecessary, read the *About that plaintext reasoning* section below and it
  will stop sounding unnecessary.

## Requirements

- Bun, latest stable.
- An authenticated Claude Code install. Credentials are read from
  `~/.claude/.credentials.json` (override with `CREDENTIALS_PATH`).

## Run it

```bash
bun install
bun run src/index.ts          # port 3456
bun run src/index.ts 3457     # override
```

The backend serves the prebuilt dashboard from `src/ui/dist/`. If no build
exists, `GET /` returns a 503 telling you to build — see below.

## API

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | liveness |
| `GET /v1/models` | upstream catalog with derived effort variants |
| `POST /v1/chat/completions` | streaming and non-streaming chat |
| `POST /v1/tokens/count` | token count for a message set |
| `GET /api/account/profile` | cached OAuth profile |
| `GET /api/telemetry/requests` | recorded requests, filterable |
| `GET /api/telemetry/requests/:traceId` | single request with body and SSE events |
| `GET /api/telemetry/logs` | raw event log |
| `GET /api/telemetry/stream` | SSE live feed of new events |
| `GET /api/telemetry/metrics` | aggregated metrics for a window |
| `GET /api/telemetry/export` | CSV or JSON export |

```bash
curl -s "http://127.0.0.1:3456/api/telemetry/requests?limit=5" \
  | jq '.requests[] | {traceId, model, duration, inputTokens, outputTokens}'
```

The SQLite store at `logs/telemetry.db` is also directly queryable. No
abstraction to learn, no ORM to fight.

## Dashboard

All routes are URL-driven and shareable.

| Route | Contents |
| --- | --- |
| `/` | requests list with filters, keyboard nav, pagination |
| `/sessions` | conversations grouped from consecutive turns |
| `/s/:sessionId` | all turns of a conversation, sticky per-turn header |
| `/r/:traceId` | full transcript, technical panel, span timeline, replay, export |
| `/live` | SSE event stream, pausable, level and stream filters |
| `/metrics` | requests, latency, errors, tokens — window toggle 1m / 5m / 1h / 24h |
| `/compare?a=X&b=Y` | two transcripts side by side with scroll-sync |

Keyboard: `/` focuses search, `j` and `k` move row selection, `Enter` opens,
`Esc` clears. A dashboard without keyboard nav is cosplay.

## Development

Two terminals from the repo root:

```bash
# backend
bun run src/index.ts 3457

# UI
cd src/ui
bun install
bun run dev                   # http://localhost:5173
```

Vite proxies `/api`, `/v1`, and `/health` to `http://127.0.0.1:3457`. HMR is on.

## Build

```bash
cd src/ui
bun run build                 # tsr generate && tsc -b && vite build → src/ui/dist/
```

The backend picks up the bundle automatically on the next request. No separate
deploy, no CORS dance, no nginx config.

## Test and typecheck

```bash
bun test                      # full backend suite
cd src/ui && bun run typecheck
```

## Configuration

| Env | Default | Notes |
| --- | --- | --- |
| `PORT` | `3456` | first CLI arg overrides |
| `CREDENTIALS_PATH` | `~/.claude/.credentials.json` | OAuth credentials source |

## About that plaintext reasoning

Anthropic exposes two different contracts for thinking on the same endpoint,
and the documentation does not make the distinction obvious. They are not
interchangeable.

Send `thinking: { type: "enabled", budget_tokens: N }` and the server assumes
you intend to re-inject the ciphertext signature on the next turn. You get
back an empty thinking block shell and a signed blob that is opaque to anyone
without Anthropic's private keys. Private compute. Great for multi-turn agent
frameworks that want opacity. Useless for an audit pipeline where you want to
actually read what the model was thinking.

Send `thinking: { type: "adaptive", display: "summarized" }` together with
`output_config: { effort }` and the server emits `thinking_delta` events
containing the model's reasoning in plaintext. It is summarized — not the raw
internal monologue — but it is readable, and it matches what the official
Claude Code CLI and the OpenCode anthropic plugin emit on the wire.

This gateway picks the second form. That is the entire unlock. Dozens of
commits of investigation, one field difference, one lesson learned: when you
claim byte-for-byte parity with another client, verify it with a real wire
capture. Reading their source is not the same thing.

## Architecture

Backend (`src/`) is a Bun native HTTP server. Stateless apart from the SQLite
event store and an in-memory credential cache. Routes under `src/http/`,
OpenAI ↔ Anthropic translation under `src/transform/`, upstream client under
`src/upstream/`, observability under `src/observability/`.

Frontend (`src/ui/`) is Vite + React 19 + TanStack Router (file-based) +
TanStack Query + Tailwind v4 + shadcn/ui. Builds to a static SPA served by the
backend on the same port.

## What this is not

Not production-ready in the enterprise sense. Not audited for security. Not
supported by Anthropic. Not multi-tenant — it reads credentials from disk and
uses them. Not a replacement for a real API key if your workload needs SLA.

It is a tool for people who want to see, in full colour, what their LLM is
doing on a Claude Max subscription, today.

## Further reading

- `OBSERVABILITY.md` — event model, SQLite schema, API surface, retention
- `CLAUDE.md` — agent conventions for this codebase
