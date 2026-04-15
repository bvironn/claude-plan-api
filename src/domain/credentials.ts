import { readFileSync, writeFileSync } from "node:fs";
import type { Credentials } from "../types.ts";
import { CREDENTIALS_PATH, REFRESH_URL, CLIENT_ID, REFRESH_MARGIN_MS } from "../config.ts";
import { emit } from "../observability/logger.ts";
import { withSpan } from "../observability/tracer.ts";

let credentials: Credentials | null = null;
let refreshPromise: Promise<void> | null = null;

export function getCredentials(): Credentials {
  if (!credentials) throw new Error("Credentials not loaded");
  return credentials;
}

export function readCredentials(): Credentials {
  const raw = JSON.parse(readFileSync(CREDENTIALS_PATH, "utf8"));
  credentials = raw.claudeAiOauth;
  emit("debug", "credentials.read", { path: CREDENTIALS_PATH });
  return credentials!;
}

export function writeCredentials(accessToken: string, refreshToken: string, expiresIn: number) {
  const raw = JSON.parse(readFileSync(CREDENTIALS_PATH, "utf8"));
  raw.claudeAiOauth.accessToken = accessToken;
  raw.claudeAiOauth.refreshToken = refreshToken;
  raw.claudeAiOauth.expiresAt = Date.now() + expiresIn * 1000;
  writeFileSync(CREDENTIALS_PATH, JSON.stringify(raw, null, 2));
  credentials = raw.claudeAiOauth;
  emit("debug", "credentials.written", { expiresAt: credentials!.expiresAt });
}

export async function refreshToken(): Promise<void> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    await withSpan("credentials.refresh", async () => {
      const res = await fetch(REFRESH_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: credentials!.refreshToken,
          client_id: CLIENT_ID,
        }),
      });
      if (!res.ok) {
        emit("error", "credentials.refresh.failed", { status: res.status });
        throw new Error(`Refresh failed: ${res.status}`);
      }
      const data = await res.json() as Record<string, unknown>;
      writeCredentials(
        data.access_token as string,
        data.refresh_token as string,
        data.expires_in as number
      );
      emit("info", "credentials.refresh.success", {});
    });
  })().finally(() => { refreshPromise = null; });
  return refreshPromise;
}

export async function ensureValidToken() {
  readCredentials();
  if (Date.now() > credentials!.expiresAt - REFRESH_MARGIN_MS) {
    emit("info", "credentials.expired", { expiresAt: credentials!.expiresAt });
    await refreshToken();
  }
}
