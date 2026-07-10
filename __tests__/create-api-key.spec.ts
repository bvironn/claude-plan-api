import { describe, it, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hashKey } from "../src/domain/api-keys.ts";
import { parseCreateKeyArgs } from "../scripts/create-api-key.ts";

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

  // -------------------------------------------------------------------------
  // --admin flag: end-to-end is_admin persistence + R1-001 fail-fast (R3-001)
  // -------------------------------------------------------------------------

  it("--admin mints an ADMIN key (is_admin = 1) end-to-end", async () => {
    const cwd = makeTmp();
    const { code, stdout } = await runCli(["--admin", "root-admin"], { API_KEY_PEPPER: "cli-test-pepper" }, cwd);

    expect(code).toBe(0);
    // Output distinguishes an admin key from a normal one.
    expect(stdout).toContain("ADMIN");

    const db = new Database(join(cwd, "logs", "telemetry.db"));
    const row = db.query<{ label: string; is_admin: number }, []>(
      "SELECT label, is_admin FROM api_keys"
    ).get();
    db.close();

    expect(row).not.toBeNull();
    expect(row!.label).toBe("root-admin");
    // The ONLY admin-minting path in the system actually sets the flag.
    expect(row!.is_admin).toBe(1);
  });

  it("without --admin mints a NON-admin key (is_admin = 0)", async () => {
    const cwd = makeTmp();
    const { code } = await runCli(["teammate"], { API_KEY_PEPPER: "cli-test-pepper" }, cwd);

    expect(code).toBe(0);
    const db = new Database(join(cwd, "logs", "telemetry.db"));
    const row = db.query<{ label: string; is_admin: number }, []>(
      "SELECT label, is_admin FROM api_keys"
    ).get();
    db.close();

    expect(row!.label).toBe("teammate");
    expect(row!.is_admin).toBe(0);
  });

  it("R1-001: a mistyped flag (--Admin) exits non-zero, prints an error, and mints NOTHING", async () => {
    const cwd = makeTmp();
    const { code, stdout, stderr } = await runCli(["--Admin", "my-label"], { API_KEY_PEPPER: "cli-test-pepper" }, cwd);

    // Must NOT silently absorb the typo as a label and mint a garbage key.
    expect(code).not.toBe(0);
    expect(stderr).toContain("Unknown option");
    expect(stdout).not.toMatch(FULL_KEY_RE);
    // The parser rejects before initStorage(), so no DB/api_keys row is created.
  });
});

// ---------------------------------------------------------------------------
// Pure argv parser (R3-001 + R1-001). No subprocess, no DB — the script body is
// guarded by `import.meta.main`, so importing `parseCreateKeyArgs` is side-free.
// This is the fast, exhaustive coverage of the flag-vs-label parsing contract;
// the subprocess tests above prove it wires through to real is_admin/exit codes.
// ---------------------------------------------------------------------------

describe("parseCreateKeyArgs — happy paths", () => {
  it("parses a bare label as a non-admin key", () => {
    expect(parseCreateKeyArgs(["ci-runner"])).toEqual({
      ok: true,
      label: "ci-runner",
      isAdmin: false,
    });
  });

  it("parses --admin before the label as an admin key", () => {
    expect(parseCreateKeyArgs(["--admin", "root"])).toEqual({
      ok: true,
      label: "root",
      isAdmin: true,
    });
  });

  it("accepts --admin AFTER the label too (flag position is free)", () => {
    expect(parseCreateKeyArgs(["root", "--admin"])).toEqual({
      ok: true,
      label: "root",
      isAdmin: true,
    });
  });

  it("trims surrounding whitespace from the label", () => {
    expect(parseCreateKeyArgs(["  spaced-label  "])).toEqual({
      ok: true,
      label: "spaced-label",
      isAdmin: false,
    });
  });
});

describe("parseCreateKeyArgs — R1-001 fail-fast on malformed input", () => {
  // Each of these mistyped flags previously became the LABEL (garbage key,
  // is_admin silently false, exit 0). They must now be hard errors instead.
  it.each([["--Admin"], ["--admin=1"], ["-admin"], ["--administrator"]])(
    "rejects the mistyped flag %s instead of absorbing it into the label",
    (flag) => {
      const result = parseCreateKeyArgs([flag, "my-label"]);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain(flag);
    },
  );

  it("rejects a mistyped flag even when it appears alone (would-be label)", () => {
    const result = parseCreateKeyArgs(["--Admin"]);
    expect(result.ok).toBe(false);
  });

  it("errors on a missing label (empty argv)", () => {
    const result = parseCreateKeyArgs([]);
    expect(result.ok).toBe(false);
  });

  it("errors on --admin with no label", () => {
    const result = parseCreateKeyArgs(["--admin"]);
    expect(result.ok).toBe(false);
  });

  it("errors on a blank/whitespace-only label", () => {
    const result = parseCreateKeyArgs(["--admin", "   "]);
    expect(result.ok).toBe(false);
  });

  it("errors on more than one positional label argument", () => {
    const result = parseCreateKeyArgs(["label-one", "label-two"]);
    expect(result.ok).toBe(false);
  });
});
