import { getCredentials } from "../domain/credentials.ts";
import { SESSION_ID } from "../session.ts";
import { VERSION } from "../config.ts";

/**
 * Build the `anthropic-beta` header value for upstream requests.
 *
 * The beta set mirrors the reference plugin `opencode-claude-auth` v2.2.1,
 * whose config is regenerated from live Claude CLI 2.1.257 traffic
 * (upstream PR #279). Anthropic fingerprints OAuth requests against what the
 * real CLI sends, so drifting from it risks safety policies (redacted
 * thinking, misleading "out of extra usage" 400s).
 *
 * Per-model rules (upstream `modelOverrides`, first match wins):
 *   - haiku           → never receives `effort-2025-11-24`
 *   - opus-4-5 / 4-6 / 4-7 → add `effort-2025-11-24`
 *   - everything else (sonnet-4-5, opus-4-8, 5.x, fable) → base set only
 *
 * `context-1m-2025-08-07` is NEVER sent: the API grants 1M context natively
 * and the beta only triggers "Extra usage is required" on plans without
 * long-context billing (upstream v2.0.0, PR #240).
 */

export const BASE_BETAS: readonly string[] = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  "interleaved-thinking-2025-05-14",
  "prompt-caching-scope-2026-01-05",
  "context-management-2025-06-27",
  "advisor-tool-2026-03-01",
  "thinking-token-count-2026-05-13",
  "extended-cache-ttl-2025-04-11",
];

export const EFFORT_BETA = "effort-2025-11-24";
export const STRUCTURED_OUTPUTS_BETA = "structured-outputs-2025-12-15";

interface ModelOverride {
  exclude?: readonly string[];
  add?: readonly string[];
}

// Ordered: first substring match wins. Keep "haiku" ahead of any version
// pattern so claude-haiku-4-5 never receives effort.
const MODEL_OVERRIDES: ReadonlyArray<[pattern: string, override: ModelOverride]> = [
  ["haiku", { exclude: [EFFORT_BETA] }],
  ["opus-4-5", { add: [EFFORT_BETA] }],
  ["4-6", { add: [EFFORT_BETA] }],
  ["4-7", { add: [EFFORT_BETA] }],
];

function getModelOverride(model: string): ModelOverride | null {
  const m = model.toLowerCase();
  for (const [pattern, override] of MODEL_OVERRIDES) {
    if (m.includes(pattern)) return override;
  }
  return null;
}

export function buildBetas(
  model: string,
  isStructuredOutput = false,
  excluded?: Set<string>,
): string {
  let parts = [...BASE_BETAS];

  const override = getModelOverride(model);
  if (override?.exclude) {
    const exclude = override.exclude;
    parts = parts.filter((b) => !exclude.includes(b));
  }
  if (override?.add) {
    for (const b of override.add) if (!parts.includes(b)) parts.push(b);
  }

  // Structured-output requests carry `output_config.format`, which needs the
  // structured-outputs beta on top of the CLI base set.
  if (isStructuredOutput) parts.push(STRUCTURED_OUTPUTS_BETA);

  return filterExcluded(parts, excluded).join(",");
}

function filterExcluded(parts: string[], excluded?: Set<string>): string[] {
  if (!excluded || excluded.size === 0) return parts;
  return parts.filter((b) => !excluded.has(b));
}

/**
 * `x-stainless-*` headers the Anthropic TypeScript SDK attaches, which the
 * real Claude CLI therefore sends. Restored for fingerprint parity in
 * upstream PR #207.
 */
function getStainlessHeaders(): Record<string, string> {
  return {
    "x-stainless-arch": process.arch,
    "x-stainless-lang": "js",
    "x-stainless-os": process.platform === "darwin" ? "MacOS" : process.platform === "linux" ? "Linux" : process.platform,
    "x-stainless-package-version": "0.81.0",
    "x-stainless-retry-count": "0",
    "x-stainless-runtime": "node",
    "x-stainless-runtime-version": process.version,
    "x-stainless-timeout": "600",
  };
}

export function buildHeaders(
  model: string,
  isStructuredOutput = false,
  excluded?: Set<string>,
  accessToken: string = getCredentials().accessToken,
): Record<string, string> {
  return {
    authorization: `Bearer ${accessToken}`,
    "anthropic-version": "2023-06-01",
    "anthropic-beta": buildBetas(model, isStructuredOutput, excluded),
    "anthropic-dangerous-direct-browser-access": "true",
    "x-app": "cli",
    // `sdk-cli` entrypoint since Claude Code 2.1.112 (upstream PR #207); must
    // match `cc_entrypoint` in the billing header.
    "user-agent": `claude-cli/${VERSION} (external, sdk-cli)`,
    "x-client-request-id": crypto.randomUUID(),
    "X-Claude-Code-Session-Id": SESSION_ID,
    ...getStainlessHeaders(),
  };
}
