import { refreshRegistry, getCatalogSnapshot } from "../../domain/models.ts";
import type { UpstreamModel } from "../../upstream/models-client.ts";
import { emit } from "../../observability/logger.ts";

/**
 * OpenAI-compatible model list. Every call triggers a fresh fetch against
 * Anthropic's /v1/models (see refreshRegistry). If the upstream fails we
 * degrade to whatever catalog the registry holds (live or static).
 *
 * Effort variants are expanded as separate entries using the ":" separator
 * (OpenRouter convention). For each model whose upstream declares
 * effort.supported=true, we publish the base id plus one entry per
 * supported level. Haiku and other non-effort models appear once.
 *
 * The supported levels are derived from the upstream (UpstreamModel.effortLevels)
 * so that if Anthropic adds a new level tomorrow it shows up automatically.
 */
export async function handleModels(): Promise<Response> {
  let catalog;
  try {
    catalog = await refreshRegistry();
  } catch (err) {
    emit("error", "models.route.fallback", { reason: (err as Error).message });
    catalog = getCatalogSnapshot();
  }

  const data: Array<{ id: string; object: "model"; created: number; owned_by: string }> = [];

  for (const m of catalog) {
    const created = timestampFor(m);
    data.push({ id: m.id, object: "model", created, owned_by: "anthropic" });

    for (const level of m.effortLevels) {
      data.push({
        id: `${m.id}:${level}`,
        object: "model",
        created,
        owned_by: "anthropic",
      });
    }
  }

  return Response.json({ object: "list", data });
}

function timestampFor(m: UpstreamModel): number {
  return m.createdAt ? Math.floor(Date.parse(m.createdAt) / 1000) : 0;
}
