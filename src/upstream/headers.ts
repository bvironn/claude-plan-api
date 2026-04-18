import { getCredentials } from "../domain/credentials.ts";
import { SESSION_ID } from "../session.ts";
import { VERSION } from "../config.ts";

export function buildBetas(
  model: string,
  isStructuredOutput = false,
  excluded?: Set<string>,
): string {
  // NOTE on `redact-thinking-2026-02-12`: intentionally OMITTED.
  //
  // That beta instructs Anthropic to emit thinking blocks with empty
  // `thinking` plaintext + a signed ciphertext (only the signature arrives
  // on the wire). The official Claude Code CLI enables it for privacy
  // reasons — their UX hides chain-of-thought by design. Our gateway is an
  // AUDIT proxy; the operator explicitly wants the plaintext to render it
  // in the dashboard's Reasoning block. Removing the beta makes Anthropic
  // stream real `thinking_delta` events, which `anthropic-to-openai` +
  // `streaming.ts` already know how to propagate to the client as
  // `reasoning_content`.
  //
  // `interleaved-thinking-2025-05-14` stays — it's a separate beta that
  // lets thinking blocks interleave with tool_use blocks in a single
  // response (required for modern agent flows).
  if (isStructuredOutput) {
    const parts = [
      "oauth-2025-04-20",
      "interleaved-thinking-2025-05-14",
      "context-management-2025-06-27",
      "prompt-caching-scope-2026-01-05",
      "advisor-tool-2026-03-01",
      "structured-outputs-2025-12-15",
    ];
    return filterExcluded(parts, excluded).join(",");
  }

  const parts = [
    "claude-code-20250219",
    "oauth-2025-04-20",
    "interleaved-thinking-2025-05-14",
    "context-management-2025-06-27",
    "prompt-caching-scope-2026-01-05",
    "advisor-tool-2026-03-01",
    "advanced-tool-use-2025-11-20",
    "effort-2025-11-24",
  ];

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
  return {
    authorization: `Bearer ${getCredentials().accessToken}`,
    "anthropic-version": "2023-06-01",
    "anthropic-beta": buildBetas(model, isStructuredOutput, excluded),
    "anthropic-dangerous-direct-browser-access": "true",
    "x-app": "cli",
    "user-agent": `claude-cli/${VERSION} (external, cli)`,
    "content-type": "application/json",
    "x-stainless-arch": "x64",
    "x-stainless-lang": "js",
    "x-stainless-os": "Linux",
    "x-stainless-package-version": "0.81.0",
    "x-stainless-retry-count": "0",
    "x-stainless-runtime": "node",
    "x-stainless-runtime-version": "v24.3.0",
    "x-stainless-timeout": "600",
    "x-claude-code-session-id": SESSION_ID,
    "x-client-request-id": crypto.randomUUID(),
  };
}
