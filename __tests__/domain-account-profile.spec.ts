import { describe, test, expect, spyOn, beforeEach, afterEach } from "bun:test";
import { __normalizeProfileForTests as normalize } from "../src/domain/account.ts";
import * as logger from "../src/observability/logger.ts";

// Module-reset utility: each call returns a freshly-evaluated copy of
// src/domain/account.ts with `cachedProfile` and `inflight` cleared. We
// abuse Bun's module loader: a different `?v=N` query string forces a
// re-evaluation, giving us a pristine module-level state per test. The
// re-imported module still pulls `emit` from the canonical logger module,
// so spies set up on logger.ts capture its emit calls correctly.
let __accountModuleCounter = 0;
async function loadFreshAccountModule(): Promise<typeof import("../src/domain/account.ts")> {
  __accountModuleCounter += 1;
  return await import(`../src/domain/account.ts?v=${__accountModuleCounter}`);
}

describe("account.normalize — happy path shape from Anthropic", () => {
  // This is the literal shape returned by Anthropic's /api/oauth/profile
  // for a claude_max subscription. If Anthropic changes the shape, this
  // test breaks immediately instead of failing silently in production.
  const REAL_SHAPE = {
    account: {
      uuid: "38c3c6a3-5f60-4d83-80dc-a51f4077b21c",
      full_name: "Geomakes",
      display_name: "Geomakes",
      email: "admin@gmhost.es",
      has_claude_max: true,
      has_claude_pro: false,
      created_at: "2026-03-23T16:35:22.593962Z",
    },
    organization: {
      uuid: "718d8b6c-cd26-4b8d-ab03-43d06006b8c7",
      name: "admin@gmhost.es's Organization",
      organization_type: "claude_max",
      billing_type: "stripe_subscription",
      rate_limit_tier: "default_claude_max_20x",
      has_extra_usage_enabled: false,
      subscription_status: "active",
      subscription_created_at: "2026-03-23T17:28:47.853323Z",
      cc_onboarding_flags: {},
      claude_code_trial_ends_at: null,
    },
    application: {
      uuid: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
      name: "Claude Code",
      slug: "claude-code",
    },
  };

  test("account fields are lifted into camelCase", () => {
    const p = normalize(REAL_SHAPE);
    expect(p.account).toEqual({
      uuid: "38c3c6a3-5f60-4d83-80dc-a51f4077b21c",
      fullName: "Geomakes",
      displayName: "Geomakes",
      email: "admin@gmhost.es",
      hasClaudeMax: true,
      hasClaudePro: false,
      createdAt: "2026-03-23T16:35:22.593962Z",
    });
  });

  test("organization fields are lifted into camelCase", () => {
    const p = normalize(REAL_SHAPE);
    expect(p.organization).toEqual({
      uuid: "718d8b6c-cd26-4b8d-ab03-43d06006b8c7",
      name: "admin@gmhost.es's Organization",
      organizationType: "claude_max",
      billingType: "stripe_subscription",
      rateLimitTier: "default_claude_max_20x",
      hasExtraUsageEnabled: false,
      subscriptionStatus: "active",
      subscriptionCreatedAt: "2026-03-23T17:28:47.853323Z",
      claudeCodeTrialEndsAt: null,
    });
  });

  test("application fields are lifted", () => {
    const p = normalize(REAL_SHAPE);
    expect(p.application).toEqual({
      uuid: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
      name: "Claude Code",
      slug: "claude-code",
    });
  });

  test("fetchedAt is a recent ISO timestamp", () => {
    const before = Date.now();
    const p = normalize(REAL_SHAPE);
    const after = Date.now();
    const t = Date.parse(p.fetchedAt);
    expect(Number.isNaN(t)).toBe(false);
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(after);
  });
});

describe("account.normalize — defensive coercion", () => {
  test("missing account object → all null / false", () => {
    const p = normalize({});
    expect(p.account).toEqual({
      uuid: null, fullName: null, displayName: null, email: null,
      hasClaudeMax: false, hasClaudePro: false, createdAt: null,
    });
  });

  test("missing organization → all null / false", () => {
    const p = normalize({});
    expect(p.organization).toEqual({
      uuid: null, name: null, organizationType: null, billingType: null,
      rateLimitTier: null, hasExtraUsageEnabled: false,
      subscriptionStatus: null, subscriptionCreatedAt: null, claudeCodeTrialEndsAt: null,
    });
  });

  test("missing application → all null", () => {
    const p = normalize({});
    expect(p.application).toEqual({ uuid: null, name: null, slug: null });
  });

  test("non-string values become null (never crash)", () => {
    const p = normalize({
      account: { uuid: 12345, email: null, has_claude_max: "yes" },
      organization: { rate_limit_tier: { nested: "yes" } },
    });
    expect(p.account.uuid).toBeNull();
    expect(p.account.email).toBeNull();
    // "has_claude_max: 'yes'" is not `=== true`, so we correctly default to false.
    expect(p.account.hasClaudeMax).toBe(false);
    expect(p.organization.rateLimitTier).toBeNull();
  });

  test("has_extra_usage_enabled is false unless upstream sends literal true", () => {
    // R2: strict gating — only the JSON boolean `true` flips the flag on.
    // Everything else (including null, "false", and literal false) coerces to false.
    expect(normalize({ organization: { has_extra_usage_enabled: true } })
      .organization.hasExtraUsageEnabled).toBe(true);
    expect(normalize({ organization: { has_extra_usage_enabled: 1 } })
      .organization.hasExtraUsageEnabled).toBe(false);
    expect(normalize({ organization: { has_extra_usage_enabled: "true" } })
      .organization.hasExtraUsageEnabled).toBe(false);
    expect(normalize({ organization: {} })
      .organization.hasExtraUsageEnabled).toBe(false);
    // R2 additions: null, string "false", and literal false must all coerce to false.
    expect(normalize({ organization: { has_extra_usage_enabled: null } })
      .organization.hasExtraUsageEnabled).toBe(false);
    expect(normalize({ organization: { has_extra_usage_enabled: "false" } })
      .organization.hasExtraUsageEnabled).toBe(false);
    expect(normalize({ organization: { has_extra_usage_enabled: false } })
      .organization.hasExtraUsageEnabled).toBe(false);
  });

  test("unknown extra keys in raw payload are ignored silently", () => {
    const p = normalize({
      account: { uuid: "x", mystery_field: "yolo" },
      organization: { future_flag: true },
      something_top_level: 42,
    });
    expect(p.account.uuid).toBe("x");
    expect(p.organization.uuid).toBeNull();
    // No crash, no warnings. Forward-compat.
  });

  test("has_extra_usage_enabled: true propagates as strict boolean true", () => {
    // R1 (domain layer): upstream `true` must reach FullProfile.organization
    // as the JSON boolean `true`, never coerced to 1, "true", or truthy-anything.
    const p = normalize({
      organization: { has_extra_usage_enabled: true },
    });
    expect(p.organization.hasExtraUsageEnabled).toBe(true);
    // Strict identity check — guard against accidental === "true" regressions.
    expect(p.organization.hasExtraUsageEnabled === true).toBe(true);
    expect(typeof p.organization.hasExtraUsageEnabled).toBe("boolean");
  });
});

describe("account.fetchProfile — log emit shape", () => {
  // R3: ensureProfile() must emit exactly one `account.profile.fetched`
  // info event on success, with a payload containing the six named keys.
  // On upstream failure (non-2xx or thrown), it must NOT emit that event.

  // Minimal upstream payload — only what's needed to exercise emit.
  const UPSTREAM = {
    account: {
      uuid: "acc-r3",
      full_name: "R3 User",
      email: "r3@example.com",
      has_claude_max: true,
    },
    organization: {
      uuid: "org-r3",
      organization_type: "claude_max",
      has_extra_usage_enabled: true,
      subscription_status: "active",
      rate_limit_tier: "default_claude_max_20x",
    },
    application: { uuid: "app-r3", name: "Claude Code", slug: "claude-code" },
  };

  let emitSpy: ReturnType<typeof spyOn> | null = null;
  let fetchSpy: ReturnType<typeof spyOn> | null = null;
  let credentialsSpy: ReturnType<typeof spyOn> | null = null;

  beforeEach(async () => {
    const credModule = await import("../src/domain/credentials.ts");
    credentialsSpy = spyOn(credModule, "getCredentials").mockReturnValue({
      accessToken: "fake-token",
      refreshToken: "fake-refresh",
      expiresAt: Date.now() + 3_600_000,
    } as ReturnType<typeof credModule.getCredentials>);
    emitSpy = spyOn(logger, "emit");
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
      return new Response(JSON.stringify(UPSTREAM), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch);
  });

  afterEach(() => {
    emitSpy?.mockRestore();
    fetchSpy?.mockRestore();
    credentialsSpy?.mockRestore();
    emitSpy = null;
    fetchSpy = null;
    credentialsSpy = null;
  });

  test("success path emits exactly one account.profile.fetched info event with the six named keys", async () => {
    const account = await loadFreshAccountModule();
    const profile = await account.ensureProfile();
    expect(profile).not.toBeNull();

    const fetchedCalls = emitSpy!.mock.calls.filter((c) => c[1] === "account.profile.fetched");
    expect(fetchedCalls.length).toBe(1);

    const [level, , payload] = fetchedCalls[0]!;
    expect(level).toBe("info");
    const p = payload as Record<string, unknown>;
    // Six named keys MUST be present (spec R3). Extra keys are allowed.
    expect(p).toHaveProperty("accountUuid");
    expect(p).toHaveProperty("organizationUuid");
    expect(p).toHaveProperty("organizationType");
    expect(p).toHaveProperty("subscriptionStatus");
    expect(p).toHaveProperty("rateLimitTier");
    expect(p).toHaveProperty("hasExtraUsageEnabled");
    // hasExtraUsageEnabled must match the normalized boolean for that profile.
    expect(p.hasExtraUsageEnabled).toBe(true);
    expect(p.accountUuid).toBe("acc-r3");
    expect(p.organizationUuid).toBe("org-r3");
  });

  test("failure path (non-2xx upstream) does NOT emit account.profile.fetched", async () => {
    fetchSpy!.mockImplementation((async () =>
      new Response("nope", { status: 500 })) as unknown as typeof fetch);
    const account = await loadFreshAccountModule();
    const profile = await account.ensureProfile();
    expect(profile).toBeNull();
    const fetchedCalls = emitSpy!.mock.calls.filter((c) => c[1] === "account.profile.fetched");
    expect(fetchedCalls.length).toBe(0);
  });
});
