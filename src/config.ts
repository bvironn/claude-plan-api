import { join } from "node:path";
import { homedir } from "node:os";

export const PORT = parseInt(process.argv[2] || Bun.env.PORT || "3456", 10);
export const CREDENTIALS_PATH = Bun.env.CREDENTIALS_PATH || join(homedir(), ".claude", ".credentials.json");
export const ANTHROPIC_API = "https://api.anthropic.com/v1/messages?beta=true";
export const REFRESH_URL = "https://claude.ai/v1/oauth/token";
export const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
// Claude CLI version reported in user-agent, billing header, and billing
// hash signature. MUST match a version Anthropic recognises as an official
// Claude Code release — unrecognised versions trigger safety policies
// (including redacted thinking). The reference plugin `opencode-claude-auth`
// uses "2.1.90" as its default, which is a known-accepted release.
//
// Override with env var if you're tracking a newer accepted version:
//   ANTHROPIC_CLI_VERSION=2.1.95
export const VERSION = Bun.env.ANTHROPIC_CLI_VERSION ?? "2.1.90";
export const SALT = "59cf53e54c78";
export const MAX_RETRIES = 3;
export const REFRESH_MARGIN_MS = 5 * 60 * 1000;
export const MAX_CONSECUTIVE_TOOL_ERRORS = 2;
