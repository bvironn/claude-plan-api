# Tasks: API-Key Authentication

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~547 (4 new files + 7 modified + 4 test files) |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR1: Foundation → PR2: Core Auth → PR3: Integration → PR4: Docs |
| Delivery strategy | auto-forecast (ask on risk) |
| Chain strategy | pending |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: pending
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Notes |
|------|------|-----------|-------|
| 1 | Config, types, storage schema + query functions + storage tests | PR 1 | Base=main; standalone mergeable; tests colocated |
| 2 | Domain key gen/validation + enforcement guard + unit tests | PR 2 | Base=main after PR1; spyOn storage + call-time env |
| 3 | Server wiring, CLI issuance, usage route + integration tests | PR 3 | Base=main after PR2; extends existing dispatch test pattern (`__tests__/observability.spec.ts`) |
| 4 | README documentation update | PR 4 | Base=main; independent after feature is live |

---

## Phase 1: Foundation — Config, Types, Storage

- [x] 1.1 Add `isApiKeyRequired()` and `getApiKeyPepper()` call-time env functions to `src/config.ts`
- [x] 1.2 Add `RequestRecord.api_key_id?`, `ApiKeyRecord`, `UsageByKey` types to `src/observability/types.ts`
- [x] 1.3 Add `api_keys` table creation + `requests.api_key_id` column via `ensureColumn()` in `src/observability/storage.ts` `initStorage()`
- [x] 1.4 Implement `insertApiKey()`, `getApiKeyByHash()`, `getUsageByApiKey()` in `src/observability/storage.ts`
- [x] 1.5 Modify `insertRequest()` to accept optional `api_key_id` param in storage.ts
- [x] 1.6 Write storage tests: `getUsageByApiKey` totals/time-window via `initStorage(":memory:")` + `insertRequest` (TDD: test before code)

## Phase 2: Core Auth — Domain + Guard

- [x] 2.1 Write domain unit tests: key format, `hashKey()` determinism+pepper sensitivity, `parseKeyFromHeaders()` Bearer/X-API-Key precedence, WeakMap set/get (TDD: test first)
- [x] 2.2 Write guard unit tests: exempt→null, gated missing/invalid/revoked→401, gated valid→null+attributed (TDD: test first)
- [x] 2.3 Create `src/domain/api-keys.ts`: `generateKey()` (cpk_ prefix.secret), `hashKey()` (HMAC-SHA256 with pepper), `parseKeyFromHeaders()`, request→keyId WeakMap
- [x] 2.4 Create `src/guards/api-key.ts`: `enforceApiKey(req): Response | null` — gated predicate `/v1/*`||`/api/*`, HMAC hash lookup, 401 short-circuit, emit warn on reject

## Phase 3: Integration — Wiring, CLI, Route

- [x] 3.1 Export `handleRequest(req)` from `src/http/server.ts`; wire `enforceApiKey` as first statement in `fetch()` try-block (before existing routes). Also wired attribution: `src/observability/middleware.ts` now sets `api_key_id: getRequestKeyId(req)` on `insertRequest` (design File Changes row; required for Per-Request Key Attribution)
- [x] 3.2 Register `/api/telemetry/usage` route in server.ts calling `handleTelemetryUsage`
- [x] 3.3 Export `handleTelemetryUsage` from `src/http/routes/telemetry/index.ts`
- [x] 3.4 Create `src/http/routes/telemetry/usage.ts`: GET handler returning per-key aggregated usage with timeFrom/timeTo; wrapped with `withObservability`
- [x] 3.5 Create `scripts/create-api-key.ts`: call `initStorage()` before storage usage, fail-fast if `API_KEY_PEPPER` is missing/empty, generate key → hash → `insertApiKey` → print full `prefix.secret` once
- [x] 3.6 Extend dispatch-level integration test (pattern from `__tests__/observability.spec.ts`): import `handleRequest`; test 401 on gated routes, 200 on exempt, valid key pass, `REQUIRE_API_KEY=false` bypass, telemetry route also gated

## Phase 4: Documentation

- [ ] 4.1 Update README.md Configuration table: add `REQUIRE_API_KEY` and `API_KEY_PEPPER` rows (name, type, default, purpose)
- [ ] 4.2 Add API auth section to README: issuance via `scripts/create-api-key.ts`, `Authorization: Bearer` / `X-API-Key` usage, `REQUIRE_API_KEY` flag (default false)
- [ ] 4.3 Remove or update the stale "not a replacement for a real API key" disclaimer line implying zero request auth

---

## Implementation Order

Phase 1 first (types + storage are dependencies for everything else). Phase 2 second (domain + guard are the core logic, testable with storage). Phase 3 third (wires everything together — requires all prior phases). Phase 4 last (documents the live feature). Each phase groups its test-first RED tasks before the corresponding GREEN implementation.

### Gate-Review Notes Carried Forward

1. **scripts/create-api-key.ts empty pepper check** (phase 3.5): fail-fast before generating a key with a missing/empty `API_KEY_PEPPER`.
2. **scripts/create-api-key.ts initStorage() call** (phase 3.5): unlike `purge-telemetry.ts` which opens raw `Database`, the CLI must call `initStorage()` before using storage functions.
3. **Integration test framing** (phase 3.6): this extends the existing dispatch-level pattern from `__tests__/observability.spec.ts` (which already spawns the real server via `Bun.spawn`), not "the first of its kind."
