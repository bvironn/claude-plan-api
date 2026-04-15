import { join } from "node:path";
import { homedir } from "node:os";

export const PORT = parseInt(process.argv[2] || Bun.env.PORT || "3456", 10);
export const CREDENTIALS_PATH = Bun.env.CREDENTIALS_PATH || join(homedir(), ".claude", ".credentials.json");
export const ANTHROPIC_API = "https://api.anthropic.com/v1/messages?beta=true";
export const REFRESH_URL = "https://claude.ai/v1/oauth/token";
export const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const VERSION = "2.1.108";
export const SALT = "59cf53e54c78";
export const MAX_RETRIES = 3;
export const REFRESH_MARGIN_MS = 5 * 60 * 1000;
export const MAX_CONSECUTIVE_TOOL_ERRORS = 2;
