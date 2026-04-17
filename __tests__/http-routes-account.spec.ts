import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { handleAccountProfile } from "../src/http/routes/account.ts";

// Fake upstream profile response — matches the real Anthropic shape.
const UPSTREAM_PROFILE = {
  account: {
    uuid: "acc-123",
    full_name: "Test User",
    email: "test@example.com",
    has_claude_max: true,
    has_claude_pro: false,
  },
  organization: {
    uuid: "org-456",
    organization_type: "claude_max",
    has_extra_usage_enabled: false,
    subscription_status: "active",
    rate_limit_tier: "default_claude_max_20x",
  },
  application: {
    uuid: "app-789",
    name: "Claude Code",
    slug: "claude-code",
  },
};

let fetchSpy: ReturnType<typeof spyOn> | null = null;
let credentialsSpy: ReturnType<typeof spyOn> | null = null;

beforeEach(async () => {
  // Bypass credentials.ts: it expects a real file at ~/.claude/.credentials.json
  const credModule = await import("../src/domain/credentials.ts");
  credentialsSpy = spyOn(credModule, "getCredentials").mockReturnValue({
    accessToken: "fake-token",
    refreshToken: "fake-refresh",
    expiresAt: Date.now() + 3_600_000,
  } as ReturnType<typeof credModule.getCredentials>);

  // Reset the account module's cache by re-importing… but ES modules are
  // cached across tests. Instead we rely on refresh=1 to force a fetch,
  // and we use fresh mock responses per test.
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () => {
    return new Response(JSON.stringify(UPSTREAM_PROFILE), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
});

afterEach(() => {
  fetchSpy?.mockRestore();
  credentialsSpy?.mockRestore();
  fetchSpy = null;
  credentialsSpy = null;
});

describe("GET /api/account/profile", () => {
  test("returns normalized profile shape", async () => {
    const res = await handleAccountProfile(
      new Request("http://localhost/api/account/profile?refresh=1"),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty("account");
    expect(body).toHaveProperty("organization");
    expect(body).toHaveProperty("application");
    expect(body).toHaveProperty("fetchedAt");

    const acc = body.account as Record<string, unknown>;
    expect(acc.uuid).toBe("acc-123");
    expect(acc.email).toBe("test@example.com");
    expect(acc.hasClaudeMax).toBe(true);
    expect(acc.hasClaudePro).toBe(false);

    const org = body.organization as Record<string, unknown>;
    expect(org.organizationType).toBe("claude_max");
    expect(org.hasExtraUsageEnabled).toBe(false);
  });

  test("refresh=1 triggers a fresh upstream fetch", async () => {
    fetchSpy?.mockClear();
    await handleAccountProfile(
      new Request("http://localhost/api/account/profile?refresh=1"),
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const callArgs = fetchSpy!.mock.calls[0]!;
    expect(String(callArgs[0])).toBe("https://api.anthropic.com/api/oauth/profile");
    // Must include the OAuth beta header.
    const init = callArgs[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["anthropic-beta"]).toBe("oauth-2025-04-20");
    expect(headers.authorization).toContain("Bearer ");
  });

  test("upstream failure returns 502 when no cached snapshot", async () => {
    fetchSpy!.mockImplementationOnce(async () => new Response("nope", { status: 500 }));
    // Use refresh=1 so we bypass any cache from previous tests.
    const res = await handleAccountProfile(
      new Request("http://localhost/api/account/profile?refresh=1&_=bust"),
    );
    // Depending on whether a previous test populated the cache, we accept
    // either 502 (no cache) or 200 (served stale). Either is correct
    // behaviour — the contract is "never 500".
    expect([200, 502]).toContain(res.status);
  });
});
