# Exploration: API Key Admin UI (list, create, revoke) + Usage Telemetry

## Current State

### Backend (verified by reading source, not assumed)

`api-key-authentication` (merged, live on this host via `claude-plan-api.service`,
`.env` has `REQUIRE_API_KEY=true` and a non-loopback `BIND_HOST=10.0.40.18`
bound to the netbird interface) shipped:

- `src/domain/api-keys.ts` — `generateKey()` (`{prefix, secret, full}`),
  `hashKey(full)` (HMAC-SHA256 with `API_KEY_PEPPER`, call-time env read),
  `parseKeyFromHeaders(req)` (Bearer, then `X-API-Key`), plus a
  `WeakMap<Request, number>` request→keyId attribution transport. Pure, no I/O.
- `src/guards/api-key.ts` — `enforceApiKey(req)`, the pre-dispatch gate. Gates
  `pathname.startsWith("/v1/") || startsWith("/api/")` (`isGated()`, line 40-42)
  — **this already covers `/api/telemetry/*` and any new `/api/keys*` route for
  free**, no new guard wiring needed for admin routes.
- `src/observability/storage.ts` (479 lines) — `api_keys` table
  (`id, prefix, key_hash, label, created_at, revoked_at`), `insertApiKey(rec)`
  (line 362, does NOT swallow errors — UNIQUE `key_hash` collisions surface),
  `getApiKeyByHash(hash)` (line 375, `WHERE key_hash=? AND revoked_at IS NULL`
  — active-only), `getUsageByApiKey(filters)` (line 394, aggregated
  request/token totals per key, optional `timeFrom`/`timeTo`, `LEFT JOIN
  api_keys`). **No `listApiKeys()` and no `revokeApiKey(id)` exist yet** —
  confirmed via grep, zero matches.
- `src/http/routes/telemetry/usage.ts` — `GET /api/telemetry/usage` **already
  implemented and gated**, wraps `getUsageByApiKey` in the exact DTO shape a
  "usage per key" UI view would need (`{generated_at, time_from, time_to,
  keys:[{api_key_id, prefix, label, requests, tokens_in, tokens_out,
  cache_read_tokens, cache_creation_tokens}]}`). No backend work needed here —
  only a UI to consume it.
- `scripts/create-api-key.ts` — CLI issuance: fail-fast on empty pepper →
  `initStorage()` → `generateKey()` + `hashKey()` + `insertApiKey()` → print
  `full` once. This is the exact call sequence an HTTP create-route would
  reuse; **zero new domain logic required for "create"**, only route wiring.

### Frontend (verified by reading source)

`src/ui/` is Bun HTML-imports + React 19 + TanStack Router (file-based routes
in `src/ui/src/routes/`) + TanStack Query + Tailwind + shadcn/ui. Existing nav
(`app-header.tsx` `NAV` array): Requests, Sessions, Live, Metrics — no Keys
entry. `CopyButton` (`components/layout/copy-button.tsx`) already implements
the "show a secret once, click to copy" UX the create-key flow needs, reusable
as-is.

`src/ui/src/lib/api.ts`'s `getJson()` helper (the ONLY fetch path in the file)
sends `headers: { Accept: "application/json" }` — **no `Authorization` or
`X-API-Key` header, anywhere in the file**. Every exported call targets a
gated prefix:

| Call | Path | Gated by `isGated()`? |
|------|------|------------------------|
| `listRequests` | `/api/telemetry/requests` | Yes |
| `getRequest` | `/api/telemetry/requests/:id` | Yes |
| `listLogs` | `/api/telemetry/logs` | Yes |
| `getMetrics` | `/api/telemetry/metrics` | Yes |
| `replay` | `POST /v1/chat/completions` | Yes |

A grep across `src/ui/src` for `localStorage|Authorization|apiKey|API_KEY`
found only unrelated theme-provider `localStorage` usage — **no key-entry or
key-storage mechanism exists in the UI today, at all.**

### Live verification against this host (not assumed — curled directly)

```
GET /health                    → 200 {"status":"ok"}          (exempt, as designed)
GET /api/telemetry/metrics     → 401 {"error":{"message":"Unauthorized","code":401}}  (no header)
GET /api/telemetry/metrics     → 401 (same, with a bogus Bearer token)
GET /  and GET /sessions       → 503 {"error":{"message":"UI not built. Run: cd src/ui && bun run build"}}
```

`src/ui/dist` does not exist on this host — **the dashboard has never actually
been built/deployed here**, so this specific 401-vs-dashboard interaction has
not yet been hit by a real browser session. The finding below is derived from
reading `api.ts` (confirmed no auth header is ever attached) combined with the
live curl proof that the exact paths it calls return 401 without one — not
from observing a live failure in a browser.

## Critical Finding: the dashboard already needs a key-entry mechanism today, independent of admin actions

Every existing telemetry view (`Requests`, `Sessions`, `Live`, `Metrics`) calls
`getJson()`/`replay()` against `/api/telemetry/*` or `/v1/*` — both gated
prefixes — and `getJson()` never attaches credentials. **As soon as someone
runs `bun run build` and deploys the UI to this host** (`REQUIRE_API_KEY=true`
already set), every one of those pre-existing read-only views will 401 on
first load, with no way for the operator to supply a key.

This is not a new problem introduced by this change — the prior
`api-key-authentication` design.md explicitly flagged it and deferred it:
> "Dashboard serves an unauthenticated shell; its data endpoints stay
> protected. Cookie/session dashboard auth is a separate future change."
(Assumptions section, `api-key-authentication/design.md:69`)

**Consequence for scope**: this change cannot be scoped as "just add admin
key-management UI on top of an already-working dashboard" — the dashboard's
*existing* telemetry views are equally blocked. Whatever mechanism lets an
operator authenticate the dashboard for the new Keys page will also be what
unblocks Requests/Sessions/Live/Metrics. There is no smaller version of this
problem that only touches admin actions.

## Affected Areas

| File | Why |
|------|-----|
| `src/observability/storage.ts` | Add `listApiKeys()` (metadata-only SELECT, explicitly excluding `key_hash`) and `revokeApiKey(id)` (soft-delete `UPDATE ... SET revoked_at WHERE id=? AND revoked_at IS NULL`) |
| `src/observability/types.ts` | Possibly a metadata-only DTO type distinct from `ApiKeyRecord` (which includes `key_hash`) so route handlers can't accidentally leak the hash |
| `src/http/routes/` | New route(s) for list/create/revoke — land under `/api/*` to inherit `enforceApiKey` for free |
| `src/http/server.ts` | Wire new route(s) into `handleRequest`'s dispatch chain |
| `src/ui/src/lib/api.ts` | Add key-management calls; also where any auth-header-attaching fetch wrapper would live if the dashboard gets self-auth |
| `src/ui/src/routes/` | New `keys.tsx` (or similar) route |
| `src/ui/src/components/layout/app-header.tsx` | New `NAV` entry |
| `src/ui/src/components/layout/copy-button.tsx` | Reusable as-is for one-time secret display on create |
| `scripts/create-api-key.ts` | Reference pattern for the HTTP create route (same `generateKey`→`hashKey`→`insertApiKey` sequence) |
| `__tests__/api-key-storage.spec.ts`, `api-key-guard.spec.ts`, `api-key-dispatch.spec.ts` | Existing test files to extend for new storage fns / routes |

## Approaches

### A. Dashboard self-auth: client-side key entry + localStorage + Bearer header on every fetch
A prompt/settings affordance where the operator pastes their own API key once;
stored in `localStorage`; a thin wrapper around `fetch` in `api.ts` attaches
`Authorization: Bearer <key>` to every call.
- **Pros**: No new backend auth concept — reuses the exact key model that
  already exists (`api_keys` table, `enforceApiKey`); minimal effort (one
  fetch wrapper + one settings UI); matches common internal-tool patterns
  (Stripe/GitHub-style dashboards where you paste your own key).
- **Cons**: Key sits in `localStorage`, readable by any JS running on the
  page (XSS exposure surface) — mitigated somewhat since this is a
  netbird-VPN-only internal tool, but not eliminated; per-browser/device
  setup (no cross-device session); no built-in expiry/rotation UX.
- **Effort**: Low.

### B. Cookie/session-based dashboard auth, separate from Bearer keys
A login endpoint exchanges a valid API key for an `HttpOnly` session cookie;
subsequent dashboard calls ride the cookie instead of a header.
- **Pros**: `HttpOnly` cookie isn't readable by page JS (better XSS
  posture); familiar "login" UX pattern for a web dashboard.
- **Cons**: A genuinely new auth concept layered on top of the existing
  Bearer-key model (two credential mechanisms to reason about); needs CSRF
  consideration once cookies drive write actions (create/revoke); this is
  exactly the "cookie/session dashboard auth" the prior change explicitly
  called out as a *separate* future change, not this one — larger scope
  than the admin-UI ask.
- **Effort**: Medium-High.

### C. Network-layer auth in front of the dashboard (reverse proxy / basic auth / mTLS)
Push dashboard access control to infrastructure instead of the app.
- **Pros**: Zero application code changes for the auth boundary itself.
- **Cons**: No reverse proxy currently sits in front of `Bun.serve` (systemd
  unit runs `bun run start` directly, bound straight to the netbird
  interface) — this would be new infrastructure, not a code change, and out
  of step with the rest of this Bun-native codebase; doesn't produce
  per-operator attribution for "who revoked this key" (still need SOMETHING
  app-level for that if it matters).
- **Effort**: Medium (infra, not app), and orthogonal to this change's scope.

### D. Do nothing about dashboard self-auth; ship admin routes as CLI/API-only
Keep the dashboard exempt from needing a key, and don't build a UI at all (or
build it but accept it stays broken under `REQUIRE_API_KEY=true`).
- **Pros**: Zero new risk.
- **Cons**: Doesn't satisfy the actual ask (a UI to manage keys); doesn't fix
  the already-existing gap that even read-only telemetry views hit. Named
  here only as the baseline for comparison, not a real option.

*(Not designing a final choice per the explore-phase mandate — flagging A as
the lowest-effort, most-pattern-consistent option worth leading with in the
proposal's Key Decisions table, with B as the documented "more secure but
bigger scope" alternative.)*

## Backend routes needed (shape only, not finalized)

1. **List** — `GET /api/keys` (or similar `/api/*` path so `enforceApiKey`
   covers it automatically). Needs new `listApiKeys()` in `storage.ts`:
   `SELECT id, prefix, label, created_at, revoked_at FROM api_keys ORDER BY
   created_at DESC` — explicitly select columns, never `SELECT *`, so
   `key_hash` can never leak through this path even if the route handler is
   careless. Mirrors `getApiKeyByHash`'s query style.
2. **Create** — `POST /api/keys`. Reuses `generateKey()` + `hashKey()` +
   `insertApiKey()` verbatim from the existing CLI script; returns
   `{id, prefix, full}` once, same contract as `create-api-key.ts`'s stdout.
3. **Revoke** — `POST /api/keys/:id/revoke` (soft-delete, not `DELETE`).
   Needs new `revokeApiKey(id)` in `storage.ts`:
   `UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`,
   returning whether a row was actually affected so revoking an
   already-revoked or nonexistent id is a clean idempotent no-op, not a
   crash. Matches the existing `revoked_at IS NULL` active-key semantics
   `getApiKeyByHash` already relies on — no schema change needed.
4. **Usage** — `GET /api/telemetry/usage` — **already exists, already
   gated, already returns the right shape.** No backend work.

All three new routes land inside the already-gated `/api/*` prefix, so they
get `enforceApiKey` enforcement for free with zero new guard code — see the
privilege-separation risk below for why "free enforcement" isn't the same as
"correctly scoped enforcement."

## Risks

1. **Dashboard has no working auth-header mechanism today.** Confirmed via
   live curl (401, no header) and via reading `api.ts` (no
   Authorization/X-API-Key ever sent). This blocks the *entire* dashboard,
   not just new admin views, the moment the UI is built and deployed here.
2. **No privilege separation on `api_keys`.** Any valid key, gated only by
   `isGated()`'s blanket `/api/*` match, would be able to create or revoke
   *any* key, including keys belonging to other team members, with no
   admin/role concept. This is a materially larger blast radius than the
   prior change's read-only telemetry surface — a leaked or malicious key
   can now mint backdoor keys or lock out the whole team. The prior change's
   Decision #4 accepted "shell access = already trusted" for CLI issuance;
   HTTP issuance removes the "shell access" barrier entirely. **Not
   resolving this here — flagging for the proposal phase.**
3. **Revocation is irreversible** (no un-revoke path in the existing
   schema/functions) — a destructive UI action needs a confirm step. Also
   raises a self-lockout question: should an operator be able to revoke the
   same key currently authenticating their own dashboard session?
4. **Not validated in a real browser.** `src/ui/dist` doesn't exist on this
   host — this exploration is grounded in source reading + direct API curls,
   not an observed live dashboard failure. Recommend building+deploying to
   confirm before/during design.
5. **`getJson()`'s error handling is generic.** Any dashboard-auth UX needs
   to special-case a `401` response to trigger a "enter your API key" flow
   rather than surfacing a raw `Error` / toast, which `getJson()` doesn't
   distinguish today.

## Open Questions for Proposal Phase

1. Which dashboard self-auth approach (A/B/C from above, or a proposal-phase
   refinement) — this blocks even the read-only "list keys" view, not just
   create/revoke.
2. Privilege separation: is "any valid key can manage all keys" acceptable
   for this internal team tool (mirrors today's CLI trust model), or does it
   need an admin/role flag on `api_keys` before HTTP issuance ships?
3. Revocation UX: confirm-before-revoke step? Should an operator be allowed
   to revoke the key currently authenticating their own session?
4. Route namespacing: flat `/api/keys` (joins the existing `/api/*`
   telemetry namespace) vs. a distinct `/api/admin/*` prefix to visually/
   architecturally set apart the higher-privilege surface for future
   role-gating? (Both are equally gated today either way — this is a
   naming/architecture question, not a security one, given current
   `isGated()` semantics.)
5. Nav placement: should a "Keys" tab be visually distinguished from the
   existing read-only Requests/Sessions/Live/Metrics tabs, given it exposes
   secrets and destructive actions?
6. Audit trail: `insertRequest`'s existing `api_key_id` attribution already
   records which key performed which HTTP call — should this double as "who
   created/revoked which key" for free, or does that need an explicit
   confirm in design?

## Ready for Proposal

Yes — with open question #1 (dashboard self-auth mechanism) as the first
agenda item, since it gates everything else including the read-only Keys
list view, and open question #2 (privilege separation) as the second, since
it changes whether "create/revoke" ship as-is or need a role concept first.
