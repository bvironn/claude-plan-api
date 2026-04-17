import { ensureProfile, refreshProfile, getProfileSnapshot } from "../../domain/account.ts";
import { emit } from "../../observability/logger.ts";

/**
 * GET /api/account/profile
 *
 * Returns the cached Anthropic profile (account + organization + application)
 * transformed to our normalized camelCase shape. If the cache is cold, does
 * a lazy fetch. Supports ?refresh=1 to force a refetch against Anthropic.
 *
 * Response body: FullProfile | { error: string }
 */
export async function handleAccountProfile(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const wantRefresh = url.searchParams.get("refresh") === "1";

  try {
    const profile = wantRefresh ? await refreshProfile() : await ensureProfile();
    if (!profile) {
      // Upstream failed and nothing cached. Return 502 so the client knows
      // it's not a 404 for the endpoint itself.
      return Response.json(
        { error: "account profile unavailable from upstream" },
        { status: 502 },
      );
    }
    return Response.json(profile);
  } catch (err) {
    emit("error", "account.profile.route.error", { error: (err as Error).message });
    // Fall back to last snapshot if we have one.
    const snap = getProfileSnapshot();
    if (snap) return Response.json(snap);
    return Response.json({ error: "account profile unavailable" }, { status: 502 });
  }
}
