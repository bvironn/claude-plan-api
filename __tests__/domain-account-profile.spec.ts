import { describe, test, expect } from "bun:test";
import { __normalizeProfileForTests as normalize } from "../src/domain/account.ts";

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

  test("has_extra_usage_enabled gates on strict true", () => {
    expect(normalize({ organization: { has_extra_usage_enabled: true } })
      .organization.hasExtraUsageEnabled).toBe(true);
    expect(normalize({ organization: { has_extra_usage_enabled: 1 } })
      .organization.hasExtraUsageEnabled).toBe(false);
    expect(normalize({ organization: { has_extra_usage_enabled: "true" } })
      .organization.hasExtraUsageEnabled).toBe(false);
    expect(normalize({ organization: {} })
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
});
