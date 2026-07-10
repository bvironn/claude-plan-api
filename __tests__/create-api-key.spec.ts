import { describe, it, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hashKey } from "../src/domain/api-keys.ts";

// Absolute path to the CLI so it resolves regardless of the spawned cwd.
const SCRIPT = fileURLToPath(new URL("../scripts/create-api-key.ts", import.meta.url));

const tmpDirs: string[] = [];
function makeTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "cpk-cli-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function runCli(
  args: string[],
  env: Record<string, string>,
  cwd: string
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, SCRIPT, ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

const FULL_KEY_RE = /cpk_[0-9a-f]+\.[0-9a-f]+/;

describe("CLI — scripts/create-api-key.ts", () => {
  it("fail-fast: refuses to issue a key when API_KEY_PEPPER is empty (no key generated)", async () => {
    const cwd = makeTmp();
    const { code, stdout, stderr } = await runCli(["ci-runner"], { API_KEY_PEPPER: "" }, cwd);

    // Gate-review finding: must exit non-zero BEFORE generating an unusable key.
    expect(code).not.toBe(0);
    expect(stderr).toContain("API_KEY_PEPPER");
    // Crucially, no key was minted or printed.
    expect(stdout).not.toMatch(FULL_KEY_RE);
    expect(stdout).not.toContain("cpk_");
  });

  it("happy path: prints the full key exactly once and stores only its hash", async () => {
    const cwd = makeTmp();
    const pepper = "cli-test-pepper";
    const { code, stdout } = await runCli(["ci-runner"], { API_KEY_PEPPER: pepper }, cwd);

    expect(code).toBe(0);

    // Full plaintext key printed exactly once (spec: shown once).
    const matches = stdout.match(new RegExp(FULL_KEY_RE, "g")) ?? [];
    expect(matches).toHaveLength(1);
    const full = matches[0]!;
    expect(full.startsWith("cpk_")).toBe(true);

    // The CLI called initStorage() (gate-review finding), so the DB + schema
    // exist under the spawned cwd.
    const db = new Database(join(cwd, "logs", "telemetry.db"));
    const row = db.query<
      { prefix: string; key_hash: string; label: string; revoked_at: string | null },
      []
    >("SELECT prefix, key_hash, label, revoked_at FROM api_keys").get();
    db.close();

    expect(row).not.toBeNull();
    expect(row!.label).toBe("ci-runner");
    expect(row!.revoked_at).toBeNull();
    expect(row!.prefix.startsWith("cpk_")).toBe(true);

    // Only the DIGEST is persisted — never the plaintext secret.
    expect(row!.key_hash).not.toContain(full);
    const secret = full.split(".")[1]!;
    expect(row!.key_hash).not.toContain(secret);

    // The stored digest is exactly HMAC-SHA256(pepper, full): the printed key
    // would authenticate on a gated route (spec: presenting it authenticates).
    const savedPepper = Bun.env.API_KEY_PEPPER;
    Bun.env.API_KEY_PEPPER = pepper;
    try {
      expect(row!.key_hash).toBe(hashKey(full));
    } finally {
      if (savedPepper === undefined) delete Bun.env.API_KEY_PEPPER;
      else Bun.env.API_KEY_PEPPER = savedPepper;
    }
  });
});
