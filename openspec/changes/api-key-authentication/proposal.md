# Proposal: API-Key Authentication

## Intent

`claude-plan-api` currently has **zero request authentication** and binds to
loopback because a single operator's Anthropic OAuth token backs every proxied
call. The team now needs per-member API keys so each request is authenticated,
attributed, and its real token usage is queryable per key. This shifts the trust
model from "one trusted operator" to "multiple identified callers."

## Scope

### In Scope
- New `api_keys` store + fast-hash validation of `Authorization: Bearer` / `X-API-Key`.
- Enforcement gate rejecting unauthenticated JSON API requests with 401.
- Per-request key attribution on the existing `requests` table (`api_key_id`).
- Aggregated per-key usage query (totals + `timeFrom`/`timeTo` range) via telemetry route.
- CLI key issuance script + docs so team members can obtain a key.

### Out of Scope (explicit follow-ups)
- **Quotas/alerts (req #5)** → deferred to a follow-up change `api-key-quotas`.
- Admin HTTP endpoint / UI for key management (CLI is the first slice).
- Authenticating static/SPA dashboard serving and flipping `BIND_HOST` (stays loopback).

## Capabilities

### New Capabilities
- `api-key-auth`: key model, generation, SHA-256/HMAC hashing, header validation, and the cross-cutting 401 enforcement gate.
- `api-key-usage`: per-key attribution on `requests` + aggregated usage query/route.

### Modified Capabilities
- `project-readme`: document how to issue/use a key and that request auth now exists (supersedes the "not a replacement for a real API key" line).

## Approach

Introduce `src/domain/api-keys.ts` (generation/validation) and a
`src/guards/api-key.ts` guard (matches existing `anti-loop.ts` convention),
invoked at dispatch in `server.ts`. Keys use a display-safe
`prefix_secret` format; only a SHA-256/HMAC-with-pepper digest is stored, looked
up on an indexed column (sub-ms). Attribution reuses the existing idempotent
`ensureColumn()` migration and `getMetrics()` `SUM/GROUP BY` idiom.

## Key Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 Enforcement scope | All JSON API routes (`/v1/*`, `/api/*` incl. telemetry) require a key; `/health` and static/SPA serving exempt | Telemetry leaks tokens + bodies → must gate; static shell isn't sensitive, its data routes are |
| 2 Cutover | Env flag `REQUIRE_API_KEY` (default `false`), grace period, operator flips to `true` after seeding keys | Internal tool with existing scripts; avoids a hard break |
| 3 Storage shape | Normalized `api_keys` table + `requests.api_key_id` | Rotation/rename metadata lives once; audit rows keep the ref |
| 4 Issuance | CLI `scripts/create-api-key.ts` | Matches `purge-telemetry.ts`; shell access = already trusted |
| 5 Scope boundary | Quotas/alerts OUT → `api-key-quotas` follow-up | Protects 400-line review budget; #1–#4 already touch schema+dispatch+route |
| 6 Hashing | SHA-256/HMAC+pepper, NOT `Bun.password` | Per-request check; bcrypt/argon2 (~50-100ms) is a latency regression |

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/domain/api-keys.ts` | New | Key gen/hash/validate |
| `src/guards/api-key.ts` | New | 401 enforcement guard |
| `src/http/server.ts` | Modified | Wire guard + exemptions |
| `src/observability/storage.ts` + `types.ts` | Modified | `api_keys` table, `api_key_id` column, `getUsageByApiKey()` |
| `src/http/routes/telemetry/*` | Modified | Usage-by-key route |
| `src/config.ts` | Modified | `REQUIRE_API_KEY`, `API_KEY_PEPPER` |
| `scripts/create-api-key.ts` | New | Issuance CLI |

## Assumptions (auto-mode — correct later if wrong)

- Internal team tool, no external consumers; grace-period cutover is acceptable.
- Dashboard serves an unauthenticated shell; its data endpoints stay protected. Cookie/session dashboard auth is a separate future change.
- FK on `api_key_id` stays **advisory** (app-enforced); `PRAGMA foreign_keys=ON` deferred to avoid auditing all insert/delete paths now.
- `BIND_HOST` stays `127.0.0.1`; auth alone does not sanction public exposure.

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Breaking existing callers on cutover | High | `REQUIRE_API_KEY=false` default + grace period |
| Trust-model / network-exposure misread | Med | Keep loopback bind; document auth ≠ safe public exposure |
| No dispatch-level test today | High | Add first real `Bun.serve`/`fetch()` integration test proving 401 |
| Orphan `api_key_id` (unenforced FK) | Low | Only write validated ids; revisit pragma in design |

## Rollback Plan

- Set `REQUIRE_API_KEY=false` to instantly disable enforcement (no redeploy of logic).
- Guard is additive and isolated in `server.ts` — revert the wiring commit to remove the gate; `api_keys` table and `api_key_id` column are additive (`IF NOT EXISTS`/`ensureColumn`) and safe to leave in place with no data loss.
- `create-api-key.ts` is standalone; deleting it has no runtime impact.

## Dependencies

- None new. Bun-native `Bun.CryptoHasher`/Web Crypto for hashing; existing `bun:sqlite` migration pattern.

## Success Criteria

- [ ] Request without a valid key → 401 on every gated route when `REQUIRE_API_KEY=true`.
- [ ] `/health` and static/SPA serving reachable without a key.
- [ ] Each logged request row carries the issuing `api_key_id`.
- [ ] Per-key usage query returns correct totals for a `timeFrom`/`timeTo` window.
- [ ] `scripts/create-api-key.ts` issues a working key; secret shown once, only the hash stored.
- [ ] New integration test proves enforcement at the HTTP boundary.
