// Per-model, in-memory, process-lifetime tracking of Anthropic betas rejected
// by upstream. Mirrors the proven pattern from `opencode-claude-auth/src/betas.ts`,
// adapted for claude-plan-api (no env-var / model-config coupling).
//
// Betas we drop, in order, when upstream signals a long-context rejection.
// Mirrors opencode-claude-auth's `longContextBetas` minus
// `context-1m-2025-08-07`, which is never sent since upstream v2.0.0 (#240)
// — excluding a beta that isn't on the wire would only burn a retry.
export const LONG_CONTEXT_BETAS: readonly string[] = [
  "interleaved-thinking-2025-05-14",
] as const;

// Module-private state. Keyed per model id; each value is a live Set that
// callers MUST NOT mutate directly — use addExcludedBeta.
const excludedBetas: Map<string, Set<string>> = new Map();

export function isLongContextError(responseBody: string): boolean {
  return (
    responseBody.includes("Extra usage is required for long context requests") ||
    responseBody.includes("long context beta is not yet available") ||
    // Max-subscription quota exhausted for long-context requests. Treated as
    // a long-context error so the retry loop drops a beta before surfacing
    // it. Mirrors opencode-claude-auth#211.
    responseBody.includes("You're out of extra usage")
  );
}

export function getExcludedBetas(modelId: string): Set<string> {
  return excludedBetas.get(modelId) ?? new Set<string>();
}

export function addExcludedBeta(modelId: string, beta: string): void {
  const existing = excludedBetas.get(modelId) ?? new Set<string>();
  existing.add(beta);
  excludedBetas.set(modelId, existing);
}

export function getNextBetaToExclude(modelId: string): string | null {
  const excluded = getExcludedBetas(modelId);
  for (const beta of LONG_CONTEXT_BETAS) {
    if (!excluded.has(beta)) {
      return beta;
    }
  }
  return null;
}

// Test-only hook: wipes all per-model exclusion state.
export function resetExcludedBetas(): void {
  excludedBetas.clear();
}
