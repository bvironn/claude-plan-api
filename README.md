<div align="center">

```
   ┌─ openai dialect ─┐         ┌─ anthropic ─┐
   │                  │ ──────▶ │              │
   │   /v1/chat/...   │ ◀────── │  /messages   │
   └──────────────────┘         └──────────────┘
              │                        │
              └──── full audit ────────┘
                       on disk
```

# claude-plan-api

**OpenAI-compatible gateway for Claude Max.**
*Speaks the dialect. Logs every byte. Ships the dashboard.*

[Run it](#run-it) · [API](#api) · [Dashboard](#dashboard) · [Plaintext reasoning](#about-that-plaintext-reasoning) · [Architecture](#architecture) · [Disclaimer](#disclaimer-being-honest-about-it)

![Bun](https://img.shields.io/badge/Bun-latest-fbf0df?logo=bun&logoColor=000)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=fff)
![Tests](https://img.shields.io/badge/tests-195%20passing-3fb950)
![License](https://img.shields.io/badge/license-MIT-1f1d1a)

</div>

---

Nothing you couldn't build yourself in a weekend, except we spent about
twenty commits tracking down one specific server behaviour so you don't have
to.

Three things it does, in this order of importance:

1. **Speaks the OpenAI dialect**, so your existing tools just work.
2. **Logs every byte of every call** — client body, transformed upstream
   body, raw SSE stream, timings, tokens, reasoning. Everything. On disk.
3. **Ships a dashboard** that treats an LLM call as a first-class object:
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

## Requirements

| | |
| --- | --- |
| Runtime | Bun, latest stable |
| Credentials | Authenticated Claude Code install (`~/.claude/.credentials.json`, override with `CREDENTIALS_PATH`) |
| Disk | A few hundred MB if you log heavily; SQLite WAL grows with traffic |
| Network | Outbound HTTPS to `api.anthropic.com` |

## Run it

```bash
bun install
bun run src/index.ts          # port 3456
bun run src/index.ts 3457     # override
```

The backend serves the prebuilt dashboard from `src/ui/dist/`. If no build
exists, `GET /` returns a 503 telling you to build — see [Build](#build).

## API

OpenAI-compatible surface, plus a telemetry surface that exposes the audit
log over HTTP. Point any existing OpenAI client at the base URL and it works.

| Endpoint | Scope | Purpose |
| --- | --- | --- |
| `GET /health` | platform | liveness |
| `GET /v1/models` | OpenAI-compat | upstream catalog with derived effort variants |
| `POST /v1/chat/completions` | OpenAI-compat | streaming and non-streaming chat |
| `POST /v1/tokens/count` | OpenAI-compat | token count for a message set |
| `GET /api/account/profile` | gateway | cached OAuth profile |
| `GET /api/telemetry/requests` | telemetry | recorded requests, filterable |
| `GET /api/telemetry/requests/:traceId` | telemetry | single request with body and SSE events |
| `GET /api/telemetry/logs` | telemetry | raw event log |
| `GET /api/telemetry/stream` | telemetry | SSE live feed of new events |
| `GET /api/telemetry/metrics` | telemetry | aggregated metrics for a window |
| `GET /api/telemetry/export` | telemetry | CSV or JSON export |

```bash
curl -s "http://127.0.0.1:3456/api/telemetry/requests?limit=5" \
  | jq '.requests[] | {traceId, model, duration, inputTokens, outputTokens}'
```

The SQLite store at `logs/telemetry.db` is also directly queryable. No
abstraction to learn, no ORM to fight.

## Dashboard

All routes are URL-driven and shareable. A dashboard without keyboard nav is
cosplay, so this one has it.

| Route | Contents |
| --- | --- |
| `/` | requests list with filters, keyboard nav, pagination |
| `/sessions` | conversations grouped from consecutive turns |
| `/s/:sessionId` | all turns of a conversation, sticky per-turn header |
| `/r/:traceId` | full transcript, technical panel, span timeline, replay, export |
| `/live` | SSE event stream, pausable, level and stream filters |
| `/metrics` | requests, latency, errors, tokens — window toggle 1m / 5m / 1h / 24h |
| `/compare?a=X&b=Y` | two transcripts side by side with scroll-sync |

| Key | Action |
| --- | --- |
| `/` | focus search |
| `j` `k` | move row selection |
| `Enter` | open selected |
| `Esc` | clear / back |

## Architecture

```
   client                  gateway                     upstream
  ────────                ──────────                  ───────────
                        ┌──────────┐
   OpenAI ───POST───▶   │transform │   ──POST──▶     Anthropic
   client    /v1        │ openai → │     /v1            API
                        │ anthropic│
                        └─────┬────┘
                              │ every request,
                              │ every byte,
                              │ every SSE event
                              ▼
                       ┌──────────┐
                       │  SQLite  │  ─read─▶  Dashboard
                       │ telemetry│           Vite SPA
                       │   .db    │           Live · Replay · Compare · Export
                       └──────────┘
```

Backend (`src/`) is a Bun native HTTP server. Stateless apart from the SQLite
event store and an in-memory credential cache.

| Path | Concern |
| --- | --- |
| `src/http/` | routing, static, middleware |
| `src/transform/` | OpenAI ↔ Anthropic translation (request and response) |
| `src/upstream/` | Anthropic client, headers, billing, count-tokens |
| `src/observability/` | event bus, SQLite store, tracer, logger |
| `src/domain/` | account, credentials, models, tool-mapping |
| `src/ui/` | Vite + React 19 SPA — separate sub-project |

Frontend is Vite + React 19 + TanStack Router (file-based) + TanStack Query +
Tailwind v4 + shadcn/ui. Builds to a static SPA served by the backend on the
same port. No CORS dance, no separate deploy, no nginx config.

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

The backend picks up the bundle automatically on the next request.

## Test and typecheck

```bash
bun test                      # full backend suite — 195 tests
bunx tsc --noEmit             # backend typecheck — 0 errors
cd src/ui && bun run typecheck
```

The repo follows Strict TDD for behavioural changes (see `CLAUDE.md`). `bun
test` is the merge gate.

## Configuration

| Env | Default | Notes |
| --- | --- | --- |
| `PORT` | `3456` | first CLI arg overrides |
| `BIND_HOST` | `127.0.0.1` | Defaults to loopback so the proxy is not exposed by accident. Set to `0.0.0.0` (or a specific IP) only if you knowingly want to expose the service — remember this gateway authenticates to Anthropic with **your** OAuth token. |
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

## What this is not

Not production-ready in the enterprise sense. Not audited for security. Not
supported by Anthropic. Not multi-tenant — it reads credentials from disk and
uses them. Not a replacement for a real API key if your workload needs SLA.

It is a tool for people who want to see, in full colour, what their LLM is
doing on a Claude Max subscription, today.

## Further reading

| File | Contents |
| --- | --- |
| [`OBSERVABILITY.md`](./OBSERVABILITY.md) | event model, SQLite schema, API surface, retention |
| [`CLAUDE.md`](./CLAUDE.md) | agent conventions for this codebase (Bun-first rules) |
| [`LICENSE`](./LICENSE) | MIT |

---

<div align="center">

Built with **Bun** · **TypeScript** · **React 19** · **TanStack** · **shadcn/ui** · **SQLite**

</div>
