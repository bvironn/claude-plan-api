# Delta for account-profile

> **Framing (read this first)**: `hasExtraUsageEnabled` lives on
> `OrganizationProfile` (`src/domain/account.ts:30`), normalized from upstream
> `organization.has_extra_usage_enabled`. It is **org-scoped** in Anthropic's
> data model — multiple account UUIDs can share one organization — so this
> change does NOT alias it onto `AccountProfile`. The spec records the
> existing org-scoped contract and closes coverage gaps around it. No
> production types or runtime semantics change.

## ADDED Requirements

### Requirement: Propagation of `hasExtraUsageEnabled: true`

The system SHALL faithfully propagate `organization.has_extra_usage_enabled === true` from the upstream `/api/oauth/profile` payload through normalization, cache, and the JSON response body of `GET /api/account/profile`. The value MUST remain a JSON boolean — never stringified, never coerced to `1`/`0`.

#### Scenario: Upstream `true` reaches the HTTP response

- GIVEN Anthropic returns a profile with `organization.has_extra_usage_enabled: true`
- WHEN a client calls `GET /api/account/profile`
- THEN the response body has `organization.hasExtraUsageEnabled === true`
- AND the value is a JSON boolean (not the string `"true"`)

#### Scenario: Domain layer surfaces `true`

- GIVEN the same upstream payload as above
- WHEN `ensureProfile()` resolves
- THEN the cached `FullProfile.organization.hasExtraUsageEnabled` is the boolean `true`

### Requirement: Strict gating of the flag normalization

The system SHALL coerce `organization.has_extra_usage_enabled` to `false` whenever the upstream value is anything other than the literal boolean `true`. This covers `undefined`, `null`, missing keys, numeric `0` or `1`, and the strings `"true"` or `"false"`.

#### Scenario: String `"true"` is rejected

- GIVEN upstream sends `organization.has_extra_usage_enabled: "true"`
- WHEN normalization runs
- THEN the normalized `OrganizationProfile.hasExtraUsageEnabled` is `false`

#### Scenario: Numeric `1` is rejected

- GIVEN upstream sends `organization.has_extra_usage_enabled: 1`
- WHEN normalization runs
- THEN the normalized value is `false`

#### Scenario: Missing key is treated as `false`

- GIVEN upstream omits `organization.has_extra_usage_enabled` entirely
- WHEN normalization runs
- THEN the normalized value is `false`

#### Scenario: Literal boolean `true` is accepted

- GIVEN upstream sends `organization.has_extra_usage_enabled: true`
- WHEN normalization runs
- THEN the normalized value is `true`

### Requirement: Structured log shape on successful fetch

The system SHALL emit a log event named `account.profile.fetched` at `info` level whenever `ensureProfile()` resolves with a non-null profile. The payload MUST include — at minimum — the following keys: `hasExtraUsageEnabled` (boolean), `accountUuid`, `organizationUuid`, `organizationType`, `subscriptionStatus`, and `rateLimitTier`. Extra keys MAY appear; the named keys MUST NOT be missing.

#### Scenario: Success path emits the named event

- GIVEN `ensureProfile()` is called with no cached profile
- WHEN the upstream fetch resolves with a valid profile
- THEN exactly one `emit("info", "account.profile.fetched", payload)` call is made
- AND `payload` contains keys `hasExtraUsageEnabled`, `accountUuid`, `organizationUuid`, `organizationType`, `subscriptionStatus`, `rateLimitTier`
- AND `payload.hasExtraUsageEnabled` matches the normalized boolean for that profile

#### Scenario: Failure path does not emit the success event

- GIVEN the upstream fetch fails or returns a non-2xx status
- WHEN `ensureProfile()` rejects or returns null
- THEN no `account.profile.fetched` info event is emitted for that call

### Requirement: In-flight de-duplication of concurrent fetches

The system SHALL fire at most one upstream `/api/oauth/profile` request when multiple `ensureProfile()` calls happen concurrently while the cache is empty. All concurrent callers MUST resolve to the same `FullProfile` reference. After the in-flight promise settles, the internal `inflight` slot MUST be cleared.

#### Scenario: Two concurrent calls share one fetch

- GIVEN no cached profile and no in-flight request
- WHEN two `ensureProfile()` calls are awaited concurrently (e.g. `Promise.all([ensureProfile(), ensureProfile()])`)
- THEN the upstream `fetch` mock is invoked exactly once
- AND both promises resolve to the same `FullProfile` reference (`===`)

#### Scenario: `inflight` slot clears after settle

- GIVEN the concurrent fetch from the previous scenario has settled
- WHEN a new `ensureProfile()` is called against an empty cache
- THEN a new upstream `fetch` is invoked (the slot did not stay pinned)

### Requirement: Cache-hit avoids upstream fetch

The system SHALL return the cached `FullProfile` without invoking upstream `fetch` when `ensureProfile()` is called after a successful prior fetch and the cache has not been invalidated. `refreshProfile()`, by contrast, SHALL always invoke upstream `fetch` regardless of cache state (existing behavior at `src/domain/account.ts:75-79`, recorded here as a committed contract).

#### Scenario: Second call is a cache hit

- GIVEN a successful prior `ensureProfile()` populated the cache
- WHEN a subsequent `ensureProfile()` is called with no refresh flag
- THEN no upstream `fetch` is invoked
- AND the same cached `FullProfile` is returned

#### Scenario: `refreshProfile()` bypasses the cache

- GIVEN the cache already holds a `FullProfile`
- WHEN `refreshProfile()` is called
- THEN upstream `fetch` is invoked exactly once
- AND the cache is replaced with the new result

## Tests

Each requirement maps to the test file(s) below. `sdd-tasks` decides whether
to extend an existing block or add a new fixture; the spec only commits the
contract.

| Requirement | Test file(s) |
|---|---|
| Propagation of `hasExtraUsageEnabled: true` | `__tests__/domain-account-profile.spec.ts`, `__tests__/http-routes-account.spec.ts` |
| Strict gating of normalization | `__tests__/domain-account-profile.spec.ts` (some scenarios already covered at lines 120-129; extend or add) |
| Structured log shape on success | `__tests__/domain-account-profile.spec.ts` (new test, `spyOn` on `observability/logger`) |
| In-flight de-duplication | `__tests__/domain-account-profile.spec.ts` (new test, controlled `Promise` mock; assert call count) |
| Cache-hit avoids upstream fetch | `__tests__/domain-account-profile.spec.ts` (new test; reset module cache in `beforeEach`) |

## Design notes

- **Org-scoped flag, not account-scoped.** `hasExtraUsageEnabled` lives on
  `OrganizationProfile` because Anthropic's `/api/oauth/profile` returns it
  under `organization.has_extra_usage_enabled`. Multiple account UUIDs may
  share one organization; aliasing the flag onto `AccountProfile` would
  create two sources of truth. This delta does NOT add that alias.
- **"Coverage" means tests, not tooling.** This change adds test scenarios
  to lock the existing contract. It does NOT introduce coverage tooling
  (c8/istanbul); `coverage.available: false` in `openspec/config.yaml` is
  a separate, larger change.
- **ES-module cache caveat.** `bun:test` caches ES modules across tests in
  the same file, so the cache-hit scenario requires resetting the module
  (e.g. `mock.module` or dynamic re-import) in its `beforeEach`. The
  existing `?refresh=1` workaround in route specs exists for this reason
  and should NOT be the pattern for the new unit tests.
