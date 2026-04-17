import { refreshRegistry, getCatalogSnapshot } from "../../domain/models.ts";
import { emit } from "../../observability/logger.ts";

/**
 * OpenAI-compatible model list. By product decision this endpoint is a
 * transparent proxy: every call triggers a fresh fetch against Anthropic's
 * /v1/models (see refreshRegistry). If the upstream fails for any reason
 * we degrade to whatever catalog the registry holds (live or static).
 */
export async function handleModels(): Promise<Response> {
  let catalog;
  try {
    catalog = await refreshRegistry();
  } catch (err) {
    // refreshRegistry swallows upstream errors, but guard anyway so we
    // never leak a 500 out of this endpoint.
    emit("error", "models.route.fallback", { reason: (err as Error).message });
    catalog = getCatalogSnapshot();
  }

  const data = catalog.map((m) => ({
    id: m.id,
    object: "model" as const,
    created: m.createdAt ? Math.floor(Date.parse(m.createdAt) / 1000) : 0,
    owned_by: "anthropic",
  }));

  return Response.json({ object: "list", data });
}
