# Exploration: API-Key Authentication

## Current State

`claude-plan-api` is an Anthropic ↔ OpenAI proxy/gateway. Today it has **zero
request authentication** — confirmed by direct inspection, not assumed:

- `src/http/server.ts` (`startServer` → `Bun.serve({ fetch })`) dispatches every
  request straight to a route handler by `(method, pathname)` match. There is no
  guard/middleware layer before dispatch — the only pre-dispatch branch is the
  `OPTIONS` CORS preflight (lines 46-55).
- `src/guards/anti-loop.ts` is the only file under `src/guards/` and it is a
  tool-call loop breaker for the chat transform, unrelated to auth.
- No file in `src/` references `Authorization` (as a header check) or
  `X-API-Key`/`x-api-key`. The single `Authorization` mention
  (`server.ts:52`) is just the CORS `Access-Control-Allow-Headers` allow-list.
- `src/domain/credentials.ts` and `src/domain/account.ts` model the proxy's
  **own single outbound OAuth credential** to Anthropic (one operator, one
  Claude Max/Pro subscription) — not inbound client identity. There is no
  user/team-member/tenant concept anywhere in `src/domain/`.
- The README (`BIND_HOST` row) and `src/config.ts` comments make the current
  trust model explicit: the server binds to `127.0.0.1` **by design**, "so the
  gateway is not exposed to the network by accident — the server proxies to
  Anthropic using the operator's Claude Code OAuth token, so an open bind
  would let any reachable client consume the operator's subscription."
  README also states: "Not production-ready in the enterprise sense. Not
  audited for security... Not a replacement for a real API key if your
  workload needs SLA." **This confirms the codebase is greenfield for auth
  — there is no dormant/disabled mechanism to reuse — and that adding
  multi-key auth is also an implicit deployment-model shift** (see Risks).

### Request flow (verified)

```
Bun.serve({ fetch })                         [server.ts:39-99]
 └─ OPTIONS?  → 204 CORS preflight, bypasses everything else
 └─ else, in order:
     GET  /health                    → observedHealth        (withObservability)
     GET  /v1/models                 → observedModels         (withObservability)
     POST /v1/chat/completions       → observedChat           (withObservability)
     POST /v1/completions            → observedCompletions    (withObservability)
     POST /v1/tokens/count           → observedTokensCount    (withObservability)
     GET  /api/account/profile       → observedAccountProfile (withObservability)
     GET  /api/telemetry/logs        → handleTelemetryLogs      (pre-wrapped, withObservability)
     GET  /api/telemetry/stream      → handleTelemetryStream    (pre-wrapped, withObservability)
     GET  /api/telemetry/metrics     → handleTelemetryMetrics   (pre-wrapped, withObservability)
     GET  /api/telemetry/requests    → handleTelemetryRequests  (pre-wrapped, withObservability)
     GET  /api/telemetry/requests/*  → handleTelemetryRequestById (pre-wrapped, withObservability)
     GET  /api/telemetry/export      → handleTelemetryExport    (pre-wrapped, withObservability)
     GET  (anything else)            → serveStatic() then serveSpaFallback()  [NOT wrapped]
     else                            → 404 JSON
```

Every JSON API route — proxy endpoints AND telemetry read endpoints — passes
through `withObservability()` (`src/observability/middleware.ts`), either
wrapped once in `server.ts` (proxy routes) or wrapped at the bottom of each
telemetry route file (telemetry routes). **This is the single existing
choke point that already covers 11 of the 12+ handled routes.** Only two
things bypass it entirely: the `OPTIONS` preflight, and static asset /
SPA-fallback serving (`serveStatic`/`serveSpaFallback`, called directly from
`server.ts`, never wrapped).

Important nuance inside `withObservability` itself: it has a
`SILENT_PATH_PREFIXES = ["/api/telemetry"]` early-return — for those paths it
calls `handler(req)` immediately and skips trace creation / `insertRequest`
logging (to avoid the dashboard's own polling from spamming the requests
table). **Where exactly an API-key check is inserted relative to that
early-return determines whether telemetry reads get the same auth enforcement
as proxy calls** — this is a concrete decision for `sdd-design`, not something
this phase should resolve.

### Test-harness implication (verified)

`__tests__/http-routes-chat.spec.ts` (and the sibling `http-routes-*.spec.ts`
files) import and call `handleChat`/route functions **directly** — they never
go through `startServer()`/`Bun.serve`. Grepping all of `__tests__/` for
`startServer`/`Bun.serve` returns zero matches. This means:
- A pre-dispatch auth check placed in `server.ts`'s `fetch()` (before route
  matching) would NOT be exercised by any existing test and would NOT break
  any existing test — but it also means no existing test proves the routes
  are protected; new integration-style tests (actual `fetch()` against a
  running/`Bun.serve`-backed server, or a request through the exported
  `fetch` handler) would be required to prove auth is enforced end-to-end.
- A check placed inside `withObservability` WOULD be exercised implicitly by
  any test that calls an already-wrapped exported handler (e.g.
  `handleTelemetryLogs`), so existing tests could break if they don't send a
  key — this needs to be flagged for the design/tasks phase's TDD planning.

## Affected Areas

- `src/http/server.ts` — the route dispatch table; most natural place for a
  single pre-dispatch auth gate, or the place that decides *which* handlers
  get the check if done per-handler.
- `src/observability/middleware.ts` (`withObservability`) — the existing
  universal pre-handler wrapper; alternate/complementary hook point already
  covering 11/12+ routes, but conflates auth with observability concerns and
  currently skips telemetry paths early.
- `src/observability/storage.ts` — `bun:sqlite` schema (`requests`, `events`
  tables) and query layer (`RequestFilters`, `queryRequests`, `countRequests`,
  `getMetrics`). Already has the exact idioms needed for #3/#4 (see below).
- `src/observability/types.ts` — `RequestRecord` interface; would need an
  `api_key_id`/`api_key_label` field if the requests table gains that column.
- `src/domain/` — currently has no identity/user concept at all; a new file
  (e.g. `src/domain/api-keys.ts`) would be the natural home for key
  generation/validation, following the existing module-per-concern pattern
  (`credentials.ts`, `account.ts`).
- `src/config.ts` — would gain any new env vars (e.g. an opt-out/migration
  flag) following the existing `Bun.env.X ?? default` pattern.
- `src/http/routes/telemetry/*.ts` — the aggregation queries needed for
  requirement #4 either extend `RequestFilters`/`getMetrics()` here, or need
  a new sibling route (e.g. `handleTelemetryUsageByKey`).
- `scripts/` — existing precedent (`scripts/purge-telemetry.ts`) for
  standalone `bun run scripts/*.ts` admin utilities that open
  `logs/telemetry.db` directly; a `scripts/create-api-key.ts` would fit this
  convention for key issuance/management, unless a design instead prefers an
  authenticated admin HTTP route.
- `README.md` — the `BIND_HOST` security note and "Not audited for security /
  not a replacement for a real API key" disclaimer would both need revision
  once auth exists — flagging for awareness, not concluding the fix here.

## Storage Schema — Fit for Extension

`initStorage()` (`storage.ts:8-71`) already uses an **idempotent additive
migration pattern**: `CREATE TABLE IF NOT EXISTS` + a small `ensureColumn()`
helper that does `PRAGMA table_info` + `ALTER TABLE ADD COLUMN` if missing,
called once per startup (used today to add `upstream_request_body` to
pre-existing DBs without data loss). This is a reusable, already-proven
pattern for whatever schema change auth needs — no new migration tooling
required.

Two structurally different options exist for how usage-per-key ties to the
existing `requests` table, both viable with this pattern:

1. **New `api_keys` table + FK-style join column on `requests`** (e.g.
   `requests.api_key_id INTEGER`). Normalized: key metadata (label/team
   member name, created_at, revoked flag, optional quota) lives once in
   `api_keys`; `requests` just carries the reference. **Caveat verified**:
   this codebase's `bun:sqlite` connection never sets
   `PRAGMA foreign_keys = ON` (grepped — only `journal_mode`/`synchronous`
   pragmas exist), so any FK would be advisory only, not DB-enforced, unless
   design explicitly adds that pragma (which then requires auditing existing
   insert/delete paths for orphan risk).
2. **Denormalized key attribution directly on `requests`** (e.g.
   `requests.api_key_label TEXT` written at insert time, no join table, or a
   flat `api_keys` table used only for validation with usage rows
   self-contained). Simpler queries (no JOIN for aggregation), but key
   rename/rotation doesn't retroactively relabel historical rows (which may
   be desirable for audit-immutability, or undesirable if "current key name"
   is expected).

Either way, the **aggregation query itself is a solved shape already in this
codebase** — `getMetrics()` (`storage.ts:341-386`) already does
time-windowed `SUM(...)`/`GROUP BY` over `requests` with a `since` ISO
timestamp bound, and `RequestFilters`/`buildRequestWhere` already supports
arbitrary `timeFrom`/`timeTo` range filters plus `LIMIT`/`OFFSET`/`order`.
Adding `GROUP BY api_key_id` (or `api_key_label`) with the same `timeFrom`/
`timeTo` bounds is a direct extension of an existing, tested idiom — not new
technology.

**Token consumption is already recorded per-request**: `requests.input_tokens`,
`output_tokens`, `cache_read_tokens`, `cache_creation_tokens` are populated
today via `updateRequest(traceId, {...})` from `chat.ts` (and presumably
`completions.ts`, `tokens.ts` — same pattern). Requirement #3 ("tokens
consumed, endpoint, timestamp") is **95% already satisfied by the existing
`requests` table** — `path` (endpoint), `timestamp`, and token columns all
exist today. The only new piece is attributing each row to an API key.

## Key Storage & Validation — Options

No existing hashing/crypto dependency in `package.json` (only `pino`,
`pino-roll`). Bun ships `Bun.password` (bcrypt/argon2, for slow adaptive
hashing) and Web Crypto (`crypto.subtle`) / `Bun.CryptoHasher` (for fast
deterministic hashing) natively — no new dependency needed either way.

- **Plaintext storage**: simplest, but if `logs/telemetry.db` (or wherever
  keys are stored) leaks, every key leaks live. Note the existing DB already
  stores full request/response bodies in plaintext (pre-existing exposure
  surface), but that is not a reason to compound the risk for credentials
  specifically — credentials are a different risk class than request bodies.
- **Hashed at rest with a fast deterministic hash (SHA-256, optionally HMAC
  with a server-side pepper)**: the technically correct choice for API keys
  that must be checked on **every single request** at proxy-level latency
  budgets. `Bun.password` (bcrypt/argon2) is intentionally slow
  (~50-100ms+ per verify by design, meant for infrequent human password
  checks) — using it per-request here would add real, avoidable latency to
  every proxied call. A SHA-256/HMAC lookup against an indexed column is
  sub-millisecond and is the right tool.
- **Self-identifying key format** (e.g. `sk-<random>` prefix, hash only the
  suffix, or hash the whole thing but keep a short unhashed prefix for
  display/lookup like Stripe/GitHub tokens do) is an option worth surfacing
  to `sdd-design` for UX (operators can tell keys apart in logs/UI without
  ever storing/displaying the secret).

Per-request auth overhead is **not a real bottleneck** either way: this proxy
already makes a network round-trip to `api.anthropic.com` per request
(hundreds of ms), so an indexed SQLite hash lookup (sub-ms) is negligible in
comparison.

## "Team Member" Identity — Confirmed Greenfield

Grepped `src/domain/` fully: `account.ts` (single cached Anthropic OAuth
profile for the operator), `credentials.ts` (single OAuth token pair),
`models.ts` (model registry/catalog), `tool-mapping.ts` (tool name
translation). **None model an inbound user/team-member/tenant.** There is no
existing "user" table, session concept for callers, or role/permission
system to extend or collide with. A `team_member`/`api_keys` concept is
being introduced from scratch — this simplifies the design (no legacy schema
to reconcile) but also means every piece (issuance, storage, validation,
rotation, revocation, aggregation) needs to be designed, not adapted.

## Approaches

1. **Single pre-dispatch gate in `server.ts` before route matching** — one
   `validateApiKey(req)` call inside `fetch()`, before the `if (method ===
   ...)` chain, returning 401 on failure. Explicit allow-list for
   unauthenticated paths (e.g. `/health`, static/SPA) passed as a parameter
   or checked inline.
   - Pros: single obvious location; trivially audit-able (all routes
     protected unless explicitly excluded); doesn't touch
     `withObservability` (keeps observability and auth as separate
     concerns); zero risk to existing route-handler unit tests (they call
     handlers directly, bypassing `fetch()` entirely).
   - Cons: new code path with zero existing test coverage today (would
     need new integration tests exercising the real `fetch()` handler,
     which no current test file does); duplicated logic if some routes need
     different auth rules (e.g. UI dashboard vs. proxy endpoints) unless
     parameterized carefully.
   - Effort: Low–Medium.

2. **Fold into `withObservability`** — add the key check at the top (or
   just after trace context creation) of `withObservability()`.
   - Pros: reuses the one wrapper that already touches 11+ of the current
     routes; auth + request logging naturally co-located (can log
     `api_key_id` on the same `insertRequest`/`updateRequest` call already
     happening there).
   - Cons: conflates two concerns (SRP); does NOT cover static/SPA serving
     (never wrapped) or `OPTIONS`, so the UI dashboard question is
     unresolved by this approach alone; the `SILENT_PATH_PREFIXES`
     early-return means telemetry paths need explicit handling to decide if
     they're covered; existing tests that call already-wrapped exported
     handlers (e.g. `handleTelemetryLogs`) directly could start failing if
     they don't inject a valid key — needs to be scoped into TDD/task
     planning.
   - Effort: Low, but with hidden coupling cost.

3. **Hybrid — thin `requireApiKey()` guard function in a new
   `src/guards/api-key.ts` (matching the existing `src/guards/` module
   pattern), invoked explicitly per-route or per-route-group in `server.ts`**
   — not folded into `withObservability`, not a single blanket gate, but an
   explicit call site per route (or wrapped alongside `withObservability` at
   each `observedX = withObservability(handleX)` composition site, e.g.
   `withApiKey(withObservability(handleX))`).
   - Pros: most explicit — each route's protection status is visible at its
     wiring site in `server.ts`; easiest to selectively exempt `/health` or
     the UI dashboard without special-casing path prefixes inside a shared
     wrapper; matches the existing `src/guards/` convention
     (`anti-loop.ts` is also a small, single-purpose guard module).
   - Cons: more call sites to keep consistent (risk of forgetting to wrap a
     new route in the future) unless paired with a lint/test that asserts
     every non-exempt route is wrapped.
   - Effort: Medium.

`sdd-design` should pick between (1)/(3) — or a combination — with an explicit
decision on whether telemetry read routes and/or the UI dashboard require a
key too (see Open Questions). Approach (2) is included for completeness but
is the weakest fit given the SRP and test-coupling concerns above.

## Aggregation Query Approach (for requirement #4)

Given `getMetrics()` and `RequestFilters` already exist, two low-risk
extension paths:

- **Extend `RequestFilters`** with `apiKeyId?: string` (or label), add
  `GROUP BY api_key_id` variants of `countRequests`/a new
  `getUsageByApiKey(filters)` function returning per-key totals
  (`SUM(input_tokens)`, `SUM(output_tokens)`, request count) bounded by the
  existing `timeFrom`/`timeTo`. This mirrors `getMetrics()`'s existing
  `tokenRow` query almost exactly, just adding a `GROUP BY`.
- **New telemetry route** (e.g. `GET /api/telemetry/usage?groupBy=apiKey`)
  vs. **extending `/api/telemetry/metrics`** with an optional
  `?apiKeyId=` filter. Either fits the existing route-per-concern layout
  under `src/http/routes/telemetry/`.

No new query technology needed — this is squarely inside patterns
`storage.ts` already proves out.

## Open Questions for sdd-propose / sdd-design

1. **Scope of enforcement** — does "every request" (req #2) include the UI
   dashboard (static assets + SPA fallback, currently never wrapped by
   anything) and the telemetry read API, or only the proxy/completions
   endpoints (`/v1/*`)? This directly decides which approach above fits and
   whether the dashboard needs its own key-entry UX.
2. **Migration/cutover strategy** — today literally nothing requires a key.
   Enforcing auth with zero grace period breaks any existing script/tool
   (e.g. `scripts/bare-thinking-test.ts`, any external OpenAI-compatible
   client already pointed at this gateway) the instant it ships. Does the
   proposal want a hard cutover, an env-var opt-in/opt-out during rollout
   (e.g. `REQUIRE_API_KEY=true` default false initially), or is a hard
   break acceptable given this is explicitly a personal/small-team tool per
   the README's existing "not enterprise-audited" disclaimer?
3. **Key storage shape** — single `api_keys` table + FK-style column on
   `requests` (normalized, but FKs are unenforced given no
   `PRAGMA foreign_keys=ON` today), vs. denormalized label column on
   `requests` directly? Affects rotation/rename semantics for historical
   audit rows.
4. **Key issuance/management surface** — CLI script (`scripts/*.ts`,
   matching `purge-telemetry.ts` precedent, run by whoever has shell access
   to the box) vs. an authenticated admin HTTP route/UI panel? A CLI-only
   approach is far lower effort but requires shell access per key; an HTTP
   admin surface needs its own auth story (who can create/revoke keys for
   others?) — a second-order auth problem worth scoping explicitly.
5. **Quotas/alerts (req #5, explicitly optional/stretch)** — given the
   review-budget convention (400 changed lines/PR, chained-PR strategy) and
   that items #1-#4 already touch schema, a new domain module, dispatch
   wiring, and a new aggregation route, recommend `sdd-propose` scope this
   OUT of the first change and treat it as an explicit fast-follow, unless
   the user pushes back.
6. **BIND_HOST implication** — is this change implicitly meant to also
   unblock setting `BIND_HOST=0.0.0.0` (network exposure to real team
   members), or does auth ship first while the deployment stays loopback-only
   for now? Affects whether README's security disclaimer needs updating in
   the same change or a follow-up.
7. **Key format/UX** — plain random secret vs. `prefix_secret` display-safe
   format (Stripe/GitHub-style)? Affects how "hashed at rest" is implemented
   (whole-key hash vs. suffix-only hash with a lookup prefix).

## Risks

- **Breaking change, by construction** — any existing caller (proxy clients,
  the UI dashboard, ad-hoc scripts) that doesn't send a key will get 401s the
  moment enforcement ships, unless a migration/opt-in path is chosen
  (Open Question #2). This is not avoidable, only manageable.
- **Deployment-model assumption shift** — the codebase's current security
  posture (loopback-only bind, "your OAuth token" language, "not audited for
  security" disclaimer) assumes a single trusted operator. "Team members"
  implies multiple humans and likely non-loopback exposure. The auth
  mechanism itself doesn't fix network exposure — `BIND_HOST` still needs an
  explicit operator decision (Open Question #6). Flag this so the proposal
  doesn't accidentally imply auth alone makes public exposure "safe."
- **Coupling auth into `withObservability` risks silently breaking or
  silently not-covering routes** — see Approaches #2's cons; if design picks
  this path, the `SILENT_PATH_PREFIXES` interaction and static/SPA gap must
  be explicitly resolved, not left implicit.
- **No integration-level test today proves any route's dispatch behavior**
  (`__tests__/http-routes-*.spec.ts` all call handlers directly, never
  `Bun.serve`/`fetch()`) — whichever approach is chosen, `sdd-tasks`/
  `sdd-apply` will need to add the first real dispatch-level integration
  test in this codebase to prove enforcement actually happens at the HTTP
  boundary, not just at the unit level.
- **Unenforced FK risk** — if design chooses a normalized `api_keys` +
  `requests.api_key_id` join, and doesn't add `PRAGMA foreign_keys = ON`,
  nothing stops an orphaned `api_key_id` from being written; needs an
  explicit decision, not an oversight.
- **Performance**: LOW risk. A hashed-key indexed lookup is sub-millisecond
  next to the existing multi-hundred-ms upstream Anthropic round-trip — not
  a bottleneck either way, but bcrypt/argon2-style slow hashing (`Bun.password`)
  would be a self-inflicted latency regression if chosen for per-request
  checks (see Key Storage & Validation).

## Ready for Proposal

**Yes.** The problem space, existing foundations (observability storage/query
layer, migration pattern, guards module convention), and viable approaches
with tradeoffs are mapped. `sdd-propose` should resolve the 7 open questions
above (scope of enforcement, migration strategy, schema shape, key
issuance surface, quota/alert scoping, BIND_HOST implication, key format)
before `sdd-design` locks an architecture.
