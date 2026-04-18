import { getCredentials } from "../domain/credentials.ts";
import { SESSION_ID } from "../session.ts";
import { VERSION } from "../config.ts";

/**
 * Build the `anthropic-beta` header value for upstream requests.
 *
 * Design: the beta set is aligned with the `opencode-claude-auth` plugin
 * (the reference implementation that is known to stream thinking
 * plaintext successfully against OAuth-authenticated Claude plans).
 *
 * CRITICAL OMISSIONS — these are NOT in the set and for a reason:
 *
 * - `redact-thinking-2026-02-12` → would force Anthropic to emit empty
 *   thinking shells + signed ciphertext only. The official Claude CLI
 *   enables it for privacy. This gateway is an AUDIT proxy where the
 *   operator wants to read the chain-of-thought; omitting the beta
 *   unlocks real `thinking_delta` streaming.
 * - `advisor-tool-2026-03-01` and `advanced-tool-use-2025-11-20` → these
 *   also correlate with redacted-thinking behaviour in observation.
 *   Keeping the beta set tight matches the plugin's proven shape.
 *
 * `interleaved-thinking-2025-05-14` STAYS for adaptive-thinking models so
 * thinking blocks can interleave with tool_use in a single response
 * (required for agent flows). Haiku excludes it (does not support
 * adaptive thinking).
 *
 * `effort-2025-11-24` is per-model: only attached to opus/sonnet 4.6+
 * and 4.7+ where the effort parameter is supported.
 */

// Models where the `effort-2025-11-24` beta is required.
const EFFORT_MODEL_PATTERNS = ["4-6", "4-7"] as const;

// Models that must NOT receive `interleaved-thinking-2025-05-14` (they
// don't support adaptive thinking — Anthropic rejects the beta).
const NO_INTERLEAVED_PATTERNS = ["haiku"] as const;

function modelMatches(model: string, patterns: readonly string[]): boolean {
  const m = model.toLowerCase();
  return patterns.some((p) => m.includes(p));
}

export function buildBetas(
  model: string,
  isStructuredOutput = false,
  excluded?: Set<string>,
): string {
  const modelSupportsEffort = modelMatches(model, EFFORT_MODEL_PATTERNS);
  const modelSupportsInterleavedThinking = !modelMatches(model, NO_INTERLEAVED_PATTERNS);

  if (isStructuredOutput) {
    // Structured-output path: same base set plus the structured-outputs beta.
    // No effort beta (structured-outputs suppresses thinking + effort anyway).
    const parts: string[] = [
      "oauth-2025-04-20",
      "context-management-2025-06-27",
      "prompt-caching-scope-2026-01-05",
      "structured-outputs-2025-12-15",
    ];
    if (modelSupportsInterleavedThinking) {
      parts.splice(1, 0, "interleaved-thinking-2025-05-14");
    }
    return filterExcluded(parts, excluded).join(",");
  }

  // Base chat path — aligned with the REAL opencode-claude-auth + OpenCode
  // outbound request (captured byte-for-byte in
  // `scripts/bare-thinking-test.ts` validation). The code of the plugin
  // in isolation lists only 5 of these, but OpenCode's anthropic SDK
  // merges in `structured-outputs-2025-11-13` and
  // `fine-grained-tool-streaming-2025-05-14` on every request. Both
  // correlate with the plaintext-thinking codepath on OAuth accounts;
  // omitting them is one of the reasons we were getting redacted
  // thinking. Order here mirrors the plugin's post-merge output.
  const parts: string[] = [
    "claude-code-20250219",
    "oauth-2025-04-20",
    "prompt-caching-scope-2026-01-05",
    "context-management-2025-06-27",
  ];
  if (modelSupportsInterleavedThinking) {
    parts.splice(2, 0, "interleaved-thinking-2025-05-14");
  }
  if (modelSupportsEffort) {
    parts.push("effort-2025-11-24");
  }
  // Append betas injected by OpenCode's anthropic SDK; kept after the
  // effort beta to preserve plugin order verbatim.
  parts.push("structured-outputs-2025-11-13");
  parts.push("fine-grained-tool-streaming-2025-05-14");

  // Long-context beta: kept as a default for claude-opus-4-6 specifically
  // because the existing retry loop in `anthropic-client.ts` relies on
  // `addExcludedBeta` to DROP it when the upstream rejects a long-context
  // request. Removing it from default would invalidate that defensive path
  // and its tests. For opus-4-7 and other models, context-1m is opt-in
  // (the plugin's approach) — we don't pre-add it.
  if (model === "claude-opus-4-6") {
    const idx = parts.indexOf("oauth-2025-04-20");
    parts.splice(idx + 1, 0, "context-1m-2025-08-07");
  }

  return filterExcluded(parts, excluded).join(",");
}

function filterExcluded(parts: string[], excluded?: Set<string>): string[] {
  if (!excluded || excluded.size === 0) return parts;
  return parts.filter((b) => !excluded.has(b));
}

export function buildHeaders(
  model: string,
  isStructuredOutput = false,
  excluded?: Set<string>,
): Record<string, string> {
  // Header set aligned with the `opencode-claude-auth` plugin.
  //
  // REMOVED (previously present, but the plugin does not send them and
  // our thinking-plaintext investigation pointed to these as the most
  // likely reason Anthropic redacts thinking for our traffic):
  //   - `anthropic-dangerous-direct-browser-access: true` — signals to
  //     Anthropic that the client is a browser-style consumer; appears
  //     to trigger safety redactions, including thinking_delta being
  //     stripped from the stream.
  //   - All `x-stainless-*` headers — the plugin never sets them;
  //     they suggest "requests coming from the Anthropic SDK" which
  //     may also factor into redaction policy.
  //   - `content-type: application/json` — the fetch polyfill sets it
  //     automatically when the body is a JSON string, so we don't need
  //     to duplicate it. (If it becomes necessary we can re-add, but
  //     the plugin omits it and works.)
  return {
    authorization: `Bearer ${getCredentials().accessToken}`,
    "anthropic-version": "2023-06-01",
    "anthropic-beta": buildBetas(model, isStructuredOutput, excluded),
    "x-app": "cli",
    "user-agent": `claude-cli/${VERSION} (external, cli)`,
    "x-client-request-id": crypto.randomUUID(),
    "X-Claude-Code-Session-Id": SESSION_ID,
  };
}
