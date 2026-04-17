// Model registry.
//
// Source of truth: Anthropic's GET /v1/models (see upstream/models-client.ts).
// The registry is populated on first use and re-populated every time
// GET /v1/models is hit (per the "transparent refetch" product decision).
//
// Fallbacks exist for two reasons:
//   1. Bootstrapping — the first POST /v1/messages may arrive before any
//      GET /v1/models; a sync fallback lets the transform keep working.
//   2. Resilience — if the upstream fetch fails (network, auth, 5xx), we
//      still serve something reasonable instead of 500-ing the client.
//
// The fallback is the last-known-good static table. It was previously the
// authoritative table; we keep it as a safety net only.

import type { UpstreamModel } from "../upstream/models-client.ts";
import { fetchUpstreamModels } from "../upstream/models-client.ts";
import { emit } from "../observability/logger.ts";

export interface ModelCapabilities {
  adaptiveThinking: boolean;
  contextManagement: boolean;
  outputEffort: boolean;
}

// --- Fallback catalog (used when the upstream is unavailable) --------------
//
// Reflects the last verified hardcoded table. Intentionally conservative:
// where the upstream disagrees, the upstream wins at runtime because the
// registry is populated lazily on boot (see `ensureRegistry`).

const FALLBACK_MODELS: readonly UpstreamModel[] = [
  { id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6", createdAt: null,
    adaptiveThinking: true, contextManagement: true, outputEffort: true, structuredOutputs: true },
  { id: "claude-opus-4-6", displayName: "Claude Opus 4.6", createdAt: null,
    adaptiveThinking: true, contextManagement: true, outputEffort: true, structuredOutputs: true },
  { id: "claude-opus-4-5-20251101", displayName: "Claude Opus 4.5", createdAt: null,
    adaptiveThinking: false, contextManagement: false, outputEffort: false, structuredOutputs: false },
  { id: "claude-haiku-4-5-20251001", displayName: "Claude Haiku 4.5", createdAt: null,
    adaptiveThinking: false, contextManagement: false, outputEffort: false, structuredOutputs: false },
  { id: "claude-sonnet-4-5-20250929", displayName: "Claude Sonnet 4.5", createdAt: null,
    adaptiveThinking: false, contextManagement: false, outputEffort: false, structuredOutputs: false },
  { id: "claude-opus-4-1-20250805", displayName: "Claude Opus 4.1", createdAt: null,
    adaptiveThinking: false, contextManagement: false, outputEffort: false, structuredOutputs: false },
  { id: "claude-opus-4-20250514", displayName: "Claude Opus 4", createdAt: null,
    adaptiveThinking: false, contextManagement: false, outputEffort: false, structuredOutputs: false },
  { id: "claude-sonnet-4-20250514", displayName: "Claude Sonnet 4", createdAt: null,
    adaptiveThinking: false, contextManagement: false, outputEffort: false, structuredOutputs: false },
  { id: "claude-3-haiku-20240307", displayName: "Claude 3 Haiku", createdAt: null,
    adaptiveThinking: false, contextManagement: false, outputEffort: false, structuredOutputs: false },
];

const DEFAULT_CAPABILITIES: ModelCapabilities = {
  adaptiveThinking: false,
  contextManagement: false,
  outputEffort: false,
};

// --- Registry state --------------------------------------------------------

// Current view of the catalog. null until the first successful fetch.
let registry: UpstreamModel[] | null = null;

// De-duplicates concurrent fetches so a burst of requests results in one
// upstream call, not N.
let inflight: Promise<UpstreamModel[]> | null = null;

function currentCatalog(): readonly UpstreamModel[] {
  return registry ?? FALLBACK_MODELS;
}

function indexById(catalog: readonly UpstreamModel[]): Map<string, UpstreamModel> {
  const map = new Map<string, UpstreamModel>();
  for (const m of catalog) map.set(m.id, m);
  return map;
}

// --- Public API ------------------------------------------------------------

/**
 * Force a fresh fetch from the upstream. Returns the new catalog. On
 * failure, leaves the existing registry intact and returns what we had
 * (or the static fallback if we had nothing).
 *
 * This is what `GET /v1/models` calls — "transparent refetch" means every
 * client-facing request triggers a pull.
 */
export async function refreshRegistry(): Promise<readonly UpstreamModel[]> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const fresh = await fetchUpstreamModels();
      registry = fresh;
      return fresh;
    } catch (err) {
      emit("warn", "models.registry.refresh.fallback", {
        reason: (err as Error).message,
        usingFallback: registry === null,
      });
      return currentCatalog();
    }
  })().finally(() => { inflight = null; });
  return inflight;
}

/**
 * Return the current catalog, populating it lazily if never fetched. Used
 * by the hot path (POST /v1/messages → getModelCapabilities). If the lazy
 * fetch fails, we return the static fallback.
 */
export async function ensureRegistry(): Promise<readonly UpstreamModel[]> {
  if (registry) return registry;
  return refreshRegistry();
}

/**
 * Synchronous snapshot. Returns whatever is in memory right now — either
 * the live registry or the static fallback. Used by code that cannot
 * await (e.g. the transform pipeline during the very first request
 * before any async fetch has completed).
 */
export function getCatalogSnapshot(): readonly UpstreamModel[] {
  return currentCatalog();
}

/**
 * Capabilities lookup for a resolved model id. Reads from the live registry
 * when available, otherwise from the static fallback, otherwise all-false.
 * Sync by design so the transform pipeline stays fast.
 */
export function getModelCapabilities(model: string): ModelCapabilities {
  const entry = indexById(currentCatalog()).get(model);
  if (!entry) return DEFAULT_CAPABILITIES;
  return {
    adaptiveThinking: entry.adaptiveThinking,
    contextManagement: entry.contextManagement,
    outputEffort: entry.outputEffort,
  };
}

/**
 * Resolve user-facing aliases (sonnet/opus/haiku and prefixed ids like
 * "openai/claude-sonnet-4-6") to a concrete upstream model id.
 *
 * Strategy:
 *   1. Exact id match in the current catalog.
 *   2. Strip known prefixes and retry exact match.
 *   3. Family alias (sonnet/opus/haiku) → the newest model of that family.
 *   4. Static aliases (kept for back-compat with existing clients).
 *   5. Last resort: claude-sonnet-4-6.
 */
export function resolveModel(input: string): string {
  const catalog = currentCatalog();
  const ids = new Set(catalog.map((m) => m.id));
  const stripped = input.replace(/^(openai|claude-local)\//, "");

  if (ids.has(input)) return input;
  if (ids.has(stripped)) return stripped;

  const familyAlias = resolveFamilyAlias(stripped, catalog);
  if (familyAlias) return familyAlias;

  // Static aliases kept for back-compat (never assumed present in registry).
  const staticAlias = STATIC_ALIASES[stripped];
  if (staticAlias && ids.has(staticAlias)) return staticAlias;

  return ids.has("claude-sonnet-4-6") ? "claude-sonnet-4-6" : catalog[0]?.id ?? "claude-sonnet-4-6";
}

/**
 * Given a family token (sonnet / opus / haiku) return the freshest id in
 * that family from the catalog. "Freshest" = earliest in the catalog order
 * (Anthropic returns newest-first) or, if no ordering info, the id without
 * a date suffix.
 */
function resolveFamilyAlias(input: string, catalog: readonly UpstreamModel[]): string | null {
  const token = input.toLowerCase();
  if (!["sonnet", "opus", "haiku"].includes(token)) return null;

  const family = catalog.filter((m) => m.id.toLowerCase().includes(token));
  if (family.length === 0) return null;

  // Prefer ids without a date suffix (e.g. "claude-sonnet-4-6" over "...-20250929").
  const undated = family.find((m) => !/\d{8}$/.test(m.id));
  return (undated ?? family[0])!.id;
}

// Static aliases kept only as a safety net when the registry is empty and
// some caller asks for an exact id that used to exist. New aliases should
// not be added here — extend resolveFamilyAlias instead.
const STATIC_ALIASES: Readonly<Record<string, string>> = {
  sonnet: "claude-sonnet-4-6",
  opus: "claude-opus-4-6",
  haiku: "claude-haiku-4-5-20251001",
};

// --- Test-only surface -----------------------------------------------------

/**
 * Test helper: seed the registry with a fixed list and return a restore
 * function. Does NOT touch the inflight fetch state.
 *
 * Lets tests exercise capability gating without hitting the network.
 */
export function __seedRegistryForTests(models: UpstreamModel[] | null): () => void {
  const prev = registry;
  registry = models;
  return () => {
    registry = prev;
  };
}
