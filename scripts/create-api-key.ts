#!/usr/bin/env bun
/**
 * Issue a new inbound API key for the gateway.
 *
 * Usage:
 *   API_KEY_PEPPER=<secret> bun scripts/create-api-key.ts [--admin] <label>
 *
 * Prints the full `cpk_<prefix>.<secret>` key exactly ONCE. Only its
 * `HMAC-SHA256(API_KEY_PEPPER, full)` digest is persisted in `api_keys` — the
 * plaintext secret is never stored and cannot be recovered afterward. Present
 * the key on a gated route via `Authorization: Bearer <key>` or `X-API-Key`.
 *
 * `--admin` mints an ADMIN key (`is_admin = 1`): the ONLY way to grant
 * dashboard access. The proxy surface (`/v1/*`) accepts any valid key, but the
 * dashboard data layer (`/api/*`) requires an admin key. This CLI is the sole
 * admin-minting path (host shell access only) — the UI's create endpoint always
 * mints non-admin keys, so there is no browser self-escalation path.
 *
 * Two gate-review guardrails distinguish this from `scripts/purge-telemetry.ts`
 * (which opens a raw `Database`):
 *   1. Fail-fast if `API_KEY_PEPPER` is empty BEFORE generating a key —
 *      otherwise we'd mint a key whose digest could never be matched.
 *   2. Go through `initStorage()` (not a raw `new Database`) so the schema
 *      (the `api_keys` table + indexes) is guaranteed to exist.
 */
import { getApiKeyPepper } from "../src/config.ts";
import { initStorage, insertApiKey } from "../src/observability/storage.ts";
import { generateKey, hashKey } from "../src/domain/api-keys.ts";

const USAGE =
  "Usage: API_KEY_PEPPER=<secret> bun scripts/create-api-key.ts [--admin] <label>\n" +
  "  --admin  mint an admin key with dashboard (/api/*) access";

/** Parsed CLI arguments, or a hard error the caller must surface + exit(1) on. */
export type CreateKeyArgs =
  | { ok: true; label: string; isAdmin: boolean }
  | { ok: false; error: string };

/**
 * Parse argv (already sliced past the runtime + script path). Accepts a bare
 * `--admin` flag in ANY position plus exactly ONE positional `<label>`.
 *
 * Fail-fast (R1-001): any OTHER `-`/`--`-prefixed token (a flag typo like
 * `--Admin`, `--admin=1`, `-admin`) is a hard error — it is NEVER silently
 * absorbed into the label. A missing/blank label, or more than one positional,
 * is likewise rejected. This closes the "garbage label + silently non-admin +
 * exit 0" trap of the previous naive `includes()`/`find()` parsing.
 */
export function parseCreateKeyArgs(argv: string[]): CreateKeyArgs {
  let isAdmin = false;
  const positionals: string[] = [];
  for (const arg of argv) {
    if (arg === "--admin") {
      isAdmin = true;
      continue;
    }
    if (arg.startsWith("-")) {
      // A flag we don't recognise (typo or unsupported) — refuse, don't guess.
      return { ok: false, error: `Unknown option: ${arg}` };
    }
    positionals.push(arg);
  }
  if (positionals.length > 1) {
    return {
      ok: false,
      error: `Expected a single <label>, got ${positionals.length} positional arguments`,
    };
  }
  const label = positionals[0]?.trim() ?? "";
  if (label === "") {
    return { ok: false, error: "Missing required <label> argument" };
  }
  return { ok: true, label, isAdmin };
}

/** CLI entrypoint. Guarded by `import.meta.main` so importing the module (e.g.
 * for unit tests) triggers NO argv reads, DB init, or `process.exit`. */
function main(): void {
  const parsed = parseCreateKeyArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(parsed.error);
    console.error(USAGE);
    process.exit(1);
  }
  const { label, isAdmin } = parsed;

  // Guardrail #1: fail-fast on a missing/empty pepper, BEFORE minting anything.
  const pepper = getApiKeyPepper();
  if (!pepper) {
    console.error(
      "API_KEY_PEPPER is not set. Refusing to issue a key that could never authenticate."
    );
    console.error("Set a strong server secret first, e.g.:");
    console.error("  export API_KEY_PEPPER=$(openssl rand -hex 32)");
    process.exit(1);
  }

  // Guardrail #2: initialise storage through the canonical path so the api_keys
  // table + indexes exist (idempotent — safe on an existing telemetry.db).
  initStorage();

  const { prefix, full } = generateKey();
  const id = insertApiKey({
    prefix,
    key_hash: hashKey(full),
    label,
    created_at: new Date().toISOString(),
    revoked_at: null,
    is_admin: isAdmin ? 1 : 0,
  });

  console.log(`Created ${isAdmin ? "ADMIN " : ""}API key #${id} (label: ${label})`);
  console.log("");
  console.log(`  ${full}`);
  console.log("");
  console.log(
    "This is the ONLY time the key is shown. Store it now — only its hash is persisted."
  );
}

if (import.meta.main) {
  main();
}
