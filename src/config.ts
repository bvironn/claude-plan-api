import { join } from "node:path";
import { homedir } from "node:os";

export const PORT = parseInt(process.argv[2] || Bun.env.PORT || "3456", 10);
// Bind address for the HTTP server. Defaults to loopback so the gateway is
// not exposed to the network by accident — the server proxies to Anthropic
// using the operator's Claude Code OAuth token, so an open bind would let
// any reachable client consume the operator's subscription. Opt into LAN or
// public exposure explicitly with `BIND_HOST=0.0.0.0` (or a specific IP).
export const BIND_HOST = Bun.env.BIND_HOST ?? "127.0.0.1";
export const CREDENTIALS_PATH = Bun.env.CREDENTIALS_PATH || join(homedir(), ".claude", ".credentials.json");
export const ANTHROPIC_API = "https://api.anthropic.com/v1/messages?beta=true";
export const REFRESH_URL = "https://claude.ai/v1/oauth/token";
export const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
// Claude CLI version reported in user-agent, billing header, and billing
// hash signature. MUST match a version Anthropic recognises as an official
// Claude Code release — unrecognised versions trigger safety policies
// (including redacted thinking). The reference plugin `opencode-claude-auth`
// bumped to "2.1.112" (see PR #207) which observes the real Claude Code
// 2.1.112 request shape; we follow because Anthropic may stop recognising
// the older 2.1.90 fingerprint over time.
//
// Override with env var if you need to track a different accepted version:
//   ANTHROPIC_CLI_VERSION=2.1.95
export const VERSION = Bun.env.ANTHROPIC_CLI_VERSION ?? "2.1.112";
export const SALT = "59cf53e54c78";
export const MAX_RETRIES = 3;
export const REFRESH_MARGIN_MS = 5 * 60 * 1000;
export const MAX_CONSECUTIVE_TOOL_ERRORS = 2;
/**
 * Inject the official Claude Code identity block — "You are Claude Code,
 * Anthropic's official CLI for Claude." — into the upstream system[] array.
 *
 * OFF by default: the model answers with a neutral voice, which is what
 * general chat UIs (OpenWebUI, LibreChat, etc.) want. Set CLAUDE_CODE_IDENTITY=true
 * to make the model identify/behave as the Claude Code CLI.
 *
 * Read at CALL TIME (not import time) on purpose, so a per-request override and
 * tests can flip it without re-importing the module.
 *
 * This does NOT control the mandatory x-anthropic-billing-header, which is
 * ALWAYS sent — Anthropic requires it on OAuth requests for usage accounting.
 */
export function isClaudeCodeIdentityEnabled(): boolean {
  return Bun.env.CLAUDE_CODE_IDENTITY === "true";
}
/**
 * Whether inbound requests to gated JSON API routes (`/v1/*`, `/api/*`) must
 * present a valid API key. OFF by default so existing callers keep working
 * during the grace period; the operator flips `REQUIRE_API_KEY=true` after
 * seeding keys with `scripts/create-api-key.ts`.
 *
 * Read at CALL TIME (not import time) on purpose — mirrors
 * `isClaudeCodeIdentityEnabled()` — so a test or per-request override can flip
 * enforcement without re-importing the module.
 */
export function isApiKeyRequired(): boolean {
  return Bun.env.REQUIRE_API_KEY === "true";
}

/**
 * Server-side secret mixed into the API-key digest (`HMAC-SHA256(pepper, key)`).
 * Rotating it invalidates every issued key — a kill switch. Returns "" when
 * unset; callers that require a key (issuance, enforcement) MUST fail fast on
 * an empty pepper.
 *
 * Read at CALL TIME to match the rest of the API-key config surface.
 */
export function getApiKeyPepper(): string {
  return Bun.env.API_KEY_PEPPER ?? "";
}

// Upper bound (ms) on how long we honour an upstream `retry-after` before
// surfacing the error to the caller. Anthropic returns hour-scale values
// when a Max subscription has exhausted its quota; without this cap the
// proxy hangs indefinitely. Override with `MAX_RETRY_AFTER_MS` if you need
// a longer window. Mirrors opencode-claude-auth#211.
export const MAX_RETRY_AFTER_MS = parseInt(
  Bun.env.MAX_RETRY_AFTER_MS ?? "30000",
  10
);
