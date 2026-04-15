import { getCredentials } from "./credentials.ts";
import { SESSION_ID, DEVICE_ID } from "../session.ts";
import { VERSION } from "../config.ts";
import { emit } from "../observability/logger.ts";

let ACCOUNT_UUID: string | null = null;

export function getAccountUuid(): string | null {
  return ACCOUNT_UUID;
}

export async function ensureAccountUuid(): Promise<string | null> {
  if (ACCOUNT_UUID) return ACCOUNT_UUID;
  emit("debug", "account.uuid.fetch", {});
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
      emit("warn", "account.uuid.fetch.failed", { status: res.status });
      return null;
    }
    const data = await res.json() as Record<string, unknown>;
    const acc = (data.account as Record<string, unknown> | undefined)?.uuid;
    const org = (data.organization as Record<string, unknown> | undefined);
    if (typeof acc === "string") {
      ACCOUNT_UUID = acc;
      emit("info", "account.uuid.fetched", {
        accountUuid: ACCOUNT_UUID,
        organizationUuid: org?.uuid,
        hasClaudeMax: (data.account as Record<string, unknown>)?.has_claude_max,
        subscriptionStatus: org?.subscription_status,
        rateLimitTier: org?.rate_limit_tier,
      });
    } else {
      emit("warn", "account.uuid.fetch.noUuid", { dataKeys: Object.keys(data) });
    }
    return ACCOUNT_UUID;
  } catch (err) {
    emit("warn", "account.uuid.fetch.error", { error: (err as Error).message });
    return null;
  }
}

export function buildUserMetadata(): Record<string, unknown> {
  return {
    user_id: JSON.stringify({
      device_id: DEVICE_ID,
      account_uuid: ACCOUNT_UUID,
      session_id: SESSION_ID,
    }),
  };
}
