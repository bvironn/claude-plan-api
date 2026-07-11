<div align="center">

# claude-plan-api

**OpenAI-compatible gateway for Claude Max.**
*Speaks the dialect. Logs every byte. Ships the dashboard.*

![Bun](https://img.shields.io/badge/Bun-latest-fbf0df?logo=bun&logoColor=000)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=fff)
![License](https://img.shields.io/badge/license-MIT-1f1d1a)

experimental · unaffiliated with Anthropic · do not deploy to paying users

</div>

---

## Pitch

Nothing you couldn't build yourself in a weekend, except we spent about
twenty commits tracking down one specific server behaviour so you don't have
to.

Three things it does, in this order of importance:

1. **Speaks the OpenAI dialect**, so your existing tools just work.
2. **Logs every byte of every call** — client body, transformed upstream
   body, raw SSE stream, timings, tokens, reasoning. Everything. On disk.
3. **Ships a dashboard** that treats an LLM call as a first-class object:
   readable, searchable, replayable.

## Disclaimer

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

## Quickstart

Bun (latest stable), an authenticated Claude Code install
(`~/.claude/.credentials.json`), and outbound HTTPS to `api.anthropic.com`.

```bash
bun install
bun run src/index.ts                                # default port 3456
curl -s http://127.0.0.1:3456/v1/models | jq '.data[0]'
# → { id, object, created, owned_by }
```

If you get `401 Unauthorized`, re-run `claude` once to refresh credentials.
Pass a different port as the first CLI arg: `bun run src/index.ts 3457`.

## API

OpenAI-compatible surface, plus a telemetry surface that exposes the audit
log over HTTP. Point any existing OpenAI client at the base URL and it works.
Event model and SQLite schema: [`OBSERVABILITY.md`](./OBSERVABILITY.md).

| Endpoint | Scope | Purpose |
| --- | --- | --- |
| `GET /health` | platform | liveness |
| `GET /v1/models` | OpenAI-compat | upstream catalog with derived effort variants |
| `POST /v1/chat/completions` | OpenAI-compat | streaming and non-streaming chat |
| `POST /v1/completions` | OpenAI-compat | FIM / legacy completion |
| `POST /v1/tokens/count` | gateway | token count for a message set |
| `GET /api/account/profile` | gateway | cached OAuth profile |
| `GET /api/telemetry/requests` | telemetry | recorded requests, filterable |
| `GET /api/telemetry/requests/:traceId` | telemetry | single request with body and SSE events |
| `GET /api/telemetry/logs` | telemetry | raw event log |
| `GET /api/telemetry/stream` | telemetry | SSE live feed of new events |
| `GET /api/telemetry/metrics` | telemetry | aggregated metrics for a window |
| `GET /api/telemetry/export` | telemetry | CSV or JSON export |

The SQLite store at `logs/telemetry.db` is also directly queryable. No
abstraction to learn, no ORM to fight.

### Persistence and the database location

The store defaults to `logs/telemetry.db`, **relative to the process working
directory**. `logs/` is gitignored, so a deploy that cleans or replaces the
working tree (`git clean -fdx`, a fresh checkout) wipes it. Set
`TELEMETRY_DB_PATH` to an absolute path **outside** the deploy tree to keep data
across redeploys, e.g. under systemd:

```ini
# /etc/systemd/system/claude-plan-api.service
StateDirectory=claude-plan-api                     # creates /var/lib/claude-plan-api
Environment=TELEMETRY_DB_PATH=/var/lib/claude-plan-api/telemetry.db
```

The DB runs in WAL mode: committed rows sit in the `telemetry.db-wal` sidecar
until a checkpoint folds them into the main file. The app checkpoints
periodically and on graceful shutdown, so a normal restart is safe. Do **not**
back up or copy `telemetry.db` alone while the service is stopped uncleanly —
copy the `-wal`/`-shm` sidecars too, or checkpoint first
(`sqlite3 telemetry.db 'PRAGMA wal_checkpoint(TRUNCATE);'`).

## Authentication

Inbound requests to the JSON API — `/v1/*` (OpenAI-compat) and `/api/*`
(telemetry) — can be gated behind per-member API keys. It is **off by default**:
until an operator issues keys and flips the cutover flag, every caller passes,
so existing setups keep working with zero changes. `GET /health`, `/`, and
static assets are never gated.

### Quick path

1. **Set a server secret.** `API_KEY_PEPPER` is mixed into every key digest;
   without it, keys can be neither issued nor verified.

   ```bash
   export API_KEY_PEPPER=$(openssl rand -hex 32)
   ```

2. **Issue a key.** The plaintext is printed exactly once — only its hash is
   stored.

   ```bash
   bun scripts/create-api-key.ts "alice-laptop"
   # → cpk_1a2b3c4d.<secret>
   ```

3. **Present the key** on any gated request, via either header:

   ```bash
   curl -H "Authorization: Bearer cpk_1a2b3c4d.<secret>" \
     http://127.0.0.1:3456/v1/models
   # …or…
   curl -H "X-API-Key: cpk_1a2b3c4d.<secret>" \
     http://127.0.0.1:3456/v1/models
   ```

4. **Turn enforcement on** once every caller has a key:

   ```bash
   REQUIRE_API_KEY=true bun run src/index.ts
   ```

### Details

| Topic | Behaviour |
| --- | --- |
| Cutover flag | `REQUIRE_API_KEY` (default `false`). While `false` the gateway checks no keys at all — issue keys first, flip last. |
| Key format | `cpk_<prefix>.<secret>`. Only `HMAC-SHA256(API_KEY_PEPPER, key)` is persisted in the `api_keys` table; the secret is never stored and cannot be recovered. |
| Header precedence | `Authorization: Bearer <key>` wins over `X-API-Key: <key>`. |
| Rejected requests | On a gated route a missing, unknown, or revoked key gets `401` with a `WWW-Authenticate: Bearer` header, before any route or telemetry write runs. |
| Rotating the pepper | Changing `API_KEY_PEPPER` invalidates every issued key at once — a kill switch. |

Each authenticated request is attributed to its issuing key; per-key usage is
exposed at `GET /api/telemetry/usage`.

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

Backend (`src/`) is a Bun native HTTP server. Durable storage is just the
SQLite event store; everything else in memory is rebuildable cache.

| Path | Concern |
| --- | --- |
| `src/http/` | routing, static, middleware |
| `src/transform/` | OpenAI ↔ Anthropic translation (request and response) |
| `src/upstream/` | Anthropic client, headers, billing, count-tokens |
| `src/observability/` | event bus, SQLite store, tracer, logger |
| `src/guards/` | request-shape guards — anti-loop |
| `src/domain/` | account, credentials, models, tool-mapping |
| `src/ui/` | Vite + React 19 SPA — separate sub-project |

Frontend is Vite + React 19 + TanStack Router + TanStack Query + Tailwind v4
+ shadcn/ui. Builds to a static SPA served by the backend on the same port.
No CORS dance, no separate deploy.

## Development & build

### Run

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

### Build

```bash
cd src/ui
bun run build                 # tsr generate && tsc -b && vite build → src/ui/dist/
```

The backend picks up the bundle automatically; if no build exists, `GET /`
returns a 503 telling you to build.

### Test

```bash
bun test                      # full backend suite
bunx tsc --noEmit             # backend typecheck
cd src/ui && bun run typecheck
```

Strict TDD for behavioural changes (see [`CLAUDE.md`](./CLAUDE.md)); `bun test` is the merge gate.

## Configuration

| Variable | Type | Default | Purpose |
| --- | --- | --- | --- |
| `PORT` | integer | `3456` | Listen port; the first CLI arg overrides this. |
| `BIND_HOST` | string | `127.0.0.1` | Loopback by default. Set to `0.0.0.0` or a specific IP only if you knowingly want LAN or public exposure — remember the gateway authenticates to Anthropic with **your** OAuth token. |
| `CREDENTIALS_PATH` | path | `~/.claude/.credentials.json` | OAuth credentials source. |
| `ANTHROPIC_CLI_VERSION` | string | `2.1.112` | CLI version reported in user-agent and billing header. MUST match an Anthropic-recognised Claude Code release; unrecognised versions trigger safety policies (including redacted thinking). |
| `MAX_RETRY_AFTER_MS` | integer (ms) | `30000` | Upper bound on honoured upstream `retry-after`. Anthropic returns hour-scale values when a Max quota is exhausted; this cap prevents the proxy from hanging indefinitely. |
| `CLAUDE_CODE_IDENTITY` | boolean | `false` | Inject the official `"You are Claude Code, Anthropic's official CLI for Claude."` identity block into `system[]`. **Off by default** (neutral voice — best for general chat UIs). Set `true` to make the model identify/behave as the Claude Code CLI. Does **not** affect the mandatory billing header. See the callout below. |
| `REQUIRE_API_KEY` | boolean | `false` | Cutover flag for inbound API-key enforcement. While `false` (default) the gateway checks no keys and every caller passes, so existing setups keep working. Set `true` — after issuing keys with `scripts/create-api-key.ts` — to require a valid key on gated routes (`/v1/*`, `/api/*`). See [§Authentication](#authentication). |
| `API_KEY_PEPPER` | string | `""` (unset) | Server-side secret mixed into every key digest (`HMAC-SHA256(pepper, key)`). Required to issue **or** verify keys — issuance and verification fail when empty. Rotating it invalidates every issued key at once (kill switch). |

> ### ⚠️ `CLAUDE_CODE_IDENTITY` — check this first if requests start failing
>
> Every upstream request carries up to two `system[]` blocks:
>
> 1. **`x-anthropic-billing-header`** — **always sent, non-negotiable.** Anthropic requires it on OAuth requests to account usage against your Max plan. The gateway has no mode that omits it; dropping it would `4xx` every call.
> 2. **The identity block** `"You are Claude Code, Anthropic's official CLI for Claude."` — **optional, off by default**, controlled by this switch.
>
> **Why this matters for failures.** Anthropic's OAuth endpoint rejects *third-party* system prompts placed in `system[]` — e.g. a client sending `"You are OpenCode, a terminal assistant"`. This gateway already neutralizes that by relocating any client-supplied system prompt into the first `user` message, so it never reaches `system[]`. The **only** identity the gateway ever puts in `system[]` is the official Claude Code one above, and only when `CLAUDE_CODE_IDENTITY=true`.
>
> Leave it **off** for a clean, neutral assistant (the default). Flip it **on** only if you specifically want Claude-Code-flavored behavior. If you see unexplained `4xx` rebounds, the shape of `system[]` is the first place to look.

## Adaptive thinking — the short version

Anthropic exposes two thinking contracts on the same endpoint: `enabled`
(opaque ciphertext, useless for audit) and `adaptive` + `summarized`
(plaintext deltas matching the official CLI). This gateway picks the second
— see [`docs/adaptive-thinking.md`](./docs/adaptive-thinking.md).

## Project status & scope

Not production-ready in the enterprise sense. Not audited for security. Not
supported by Anthropic. Not multi-tenant — it reads credentials from disk and
uses them. Per-member API keys can now gate the JSON API (see
[§Authentication](#authentication)), but the gateway still carries no SLA — keep
latency- or uptime-critical workloads off it.

It is a tool for people who want to see, in full colour, what their LLM is
doing on a Claude Max subscription, today.

## Further reading

| File | Contents |
| --- | --- |
| [`OBSERVABILITY.md`](./OBSERVABILITY.md) | event model, SQLite schema, API surface, retention |
| [`CLAUDE.md`](./CLAUDE.md) | agent conventions for this codebase (Bun-first rules) |
| [`docs/adaptive-thinking.md`](./docs/adaptive-thinking.md) | the long version of §Adaptive thinking |
| [`docs/audit-2026-04-17.md`](./docs/audit-2026-04-17.md) | a snapshot audit of the gateway behaviour |
| [`openspec/`](./openspec/) | spec-driven change history |

## License

[MIT](./LICENSE).
