// Account / organization profile from the Anthropic OAuth profile endpoint.
//
// The endpoint returns three top-level objects: account, organization,
// application. Historically the proxy only captured account.uuid and a
// handful of log fields. We now cache the entire profile so the dashboard
// and pre-flight checks (e.g. has_extra_usage_enabled) can consume it.

import { getCredentials } from "./credentials.ts";
import { SESSION_ID, DEVICE_ID } from "../session.ts";
import { VERSION } from "../config.ts";
import { emit } from "../observability/logger.ts";

export interface AccountProfile {
  uuid: string | null;
  fullName: string | null;
  displayName: string | null;
  email: string | null;
  hasClaudeMax: boolean;
  hasClaudePro: boolean;
  createdAt: string | null;
}

export interface OrganizationProfile {
  uuid: string | null;
  name: string | null;
  organizationType: string | null;
  billingType: string | null;
  rateLimitTier: string | null;
  hasExtraUsageEnabled: boolean;
  subscriptionStatus: string | null;
  subscriptionCreatedAt: string | null;
  claudeCodeTrialEndsAt: string | null;
}

export interface ApplicationProfile {
  uuid: string | null;
  name: string | null;
  slug: string | null;
}

export interface FullProfile {
  account: AccountProfile;
  organization: OrganizationProfile;
  application: ApplicationProfile;
  fetchedAt: string;
}

let cachedProfile: FullProfile | null = null;
let inflight: Promise<FullProfile | null> | null = null;

export function getAccountUuid(): string | null {
  return cachedProfile?.account.uuid ?? null;
}

export function getProfileSnapshot(): FullProfile | null {
  return cachedProfile;
}

/**
 * Fetch the profile from the upstream and cache it. Returns null on
 * failure so callers can degrade gracefully. De-dups concurrent calls.
 */
export async function ensureProfile(): Promise<FullProfile | null> {
  if (cachedProfile) return cachedProfile;
  if (inflight) return inflight;
  inflight = fetchProfile().finally(() => { inflight = null; });
  return inflight;
}

/**
 * Force a refresh of the cached profile. Used by the dashboard /
 * admin endpoint.
 */
export async function refreshProfile(): Promise<FullProfile | null> {
  const fresh = await fetchProfile();
  if (fresh) cachedProfile = fresh;
  return cachedProfile;
}

/**
 * Legacy alias for callers that only care about the account uuid being
 * populated. Kept for back-compat with older call sites.
 */
export async function ensureAccountUuid(): Promise<string | null> {
  await ensureProfile();
  return getAccountUuid();
}

async function fetchProfile(): Promise<FullProfile | null> {
  emit("debug", "account.profile.fetch", {});
  try {
    const res = await fetch("https://api.anthropic.com/api/oauth/profile", {
      headers: {
        authorization: `Bearer ${getCredentials().accessToken}`,
        "user-agent": `claude-cli/${VERSION} (external, cli)`,
        "anthropic-beta": "oauth-2025-04-20",
        accept: "application/json",
      },
    });
    if (!res.ok) {
      emit("warn", "account.profile.fetch.failed", { status: res.status });
      return null;
    }
    const data = await res.json() as Record<string, unknown>;
    const profile = normalize(data);
    cachedProfile = profile;
    emit("info", "account.profile.fetched", {
      accountUuid: profile.account.uuid,
      organizationUuid: profile.organization.uuid,
      organizationType: profile.organization.organizationType,
      subscriptionStatus: profile.organization.subscriptionStatus,
      rateLimitTier: profile.organization.rateLimitTier,
      hasExtraUsageEnabled: profile.organization.hasExtraUsageEnabled,
    });
    return profile;
  } catch (err) {
    emit("warn", "account.profile.fetch.error", { error: (err as Error).message });
    return null;
  }
}

/** Test-only: normalizes a raw /api/oauth/profile response. */
export function __normalizeProfileForTests(raw: Record<string, unknown>): FullProfile {
  return normalize(raw);
}

function normalize(raw: Record<string, unknown>): FullProfile {
  const acc = (raw.account ?? {}) as Record<string, unknown>;
  const org = (raw.organization ?? {}) as Record<string, unknown>;
  const app = (raw.application ?? {}) as Record<string, unknown>;
  return {
    account: {
      uuid: asString(acc.uuid),
      fullName: asString(acc.full_name),
      displayName: asString(acc.display_name),
      email: asString(acc.email),
      hasClaudeMax: acc.has_claude_max === true,
      hasClaudePro: acc.has_claude_pro === true,
      createdAt: asString(acc.created_at),
    },
    organization: {
      uuid: asString(org.uuid),
      name: asString(org.name),
      organizationType: asString(org.organization_type),
      billingType: asString(org.billing_type),
      rateLimitTier: asString(org.rate_limit_tier),
      hasExtraUsageEnabled: org.has_extra_usage_enabled === true,
      subscriptionStatus: asString(org.subscription_status),
      subscriptionCreatedAt: asString(org.subscription_created_at),
      claudeCodeTrialEndsAt: asString(org.claude_code_trial_ends_at),
    },
    application: {
      uuid: asString(app.uuid),
      name: asString(app.name),
      slug: asString(app.slug),
    },
    fetchedAt: new Date().toISOString(),
  };
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

export function buildUserMetadata(): Record<string, unknown> {
  return {
    user_id: JSON.stringify({
      device_id: DEVICE_ID,
      account_uuid: getAccountUuid(),
      session_id: SESSION_ID,
    }),
  };
}
