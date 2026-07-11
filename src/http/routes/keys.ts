import { getApiKeyPepper } from "../../config.ts";
import { generateKey, hashKey } from "../../domain/api-keys.ts";
import { listApiKeys, insertApiKey, revokeApiKey, updateApiKeyLabel } from "../../observability/storage.ts";
import { withObservability } from "../../observability/middleware.ts";

/**
 * API-key administration routes (list / create / revoke / rename) under the
 * already-gated `/api/` prefix — they inherit `enforceApiKey` for free (design
 * decision #1).
 *
 * Unlike `/api/telemetry/*`, `/api/keys` is NOT a SILENT_PATH_PREFIX, so each
 * handler's `withObservability` wrapper writes a `requests` row attributed to
 * the acting key's `api_key_id` — a free "who minted/revoked what" audit trail
 * (design Security Note).
 *
 * Secret-leak prevention is structural, not incidental:
 *   - `listApiKeys()` SELECTs an explicit column allowlist (never `key_hash`).
 *   - the create handler returns an EXPLICIT literal DTO assembled field by
 *     field. It MUST NEVER spread `ApiKeyRecord`/the DB row, because those carry
 *     `key_hash`. `full` (the plaintext) is presented exactly once.
 */

const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
} as const;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/** GET /api/keys → `{ keys: ApiKeyMeta[] }` (metadata only, never `key_hash`). */
async function _handleKeysList(_req: Request): Promise<Response> {
  return json({ keys: listApiKeys() });
}

/**
 * POST /api/keys `{ label }` → `201 { id, prefix, label, created_at, full }`.
 *
 * Reuses the exact `generateKey()` → `hashKey()` → `insertApiKey()` sequence as
 * `scripts/create-api-key.ts` (zero new domain logic; one-time-secret contract
 * preserved). Fails fast with 500 on an empty `API_KEY_PEPPER` — refusing to
 * mint a key whose digest could never be matched (CLI guardrail #1).
 */
async function _handleKeysCreate(req: Request): Promise<Response> {
  let label: unknown;
  try {
    const body = (await req.json()) as { label?: unknown };
    label = body?.label;
  } catch {
    return json({ error: { message: "Invalid JSON body" } }, 400);
  }
  if (typeof label !== "string" || label.trim() === "") {
    return json({ error: { message: "label is required" } }, 400);
  }

  // Fail-fast BEFORE minting (mirrors the CLI): an empty pepper would yield a
  // digest that can never authenticate.
  if (!getApiKeyPepper()) {
    return json(
      { error: { message: "API_KEY_PEPPER is not set; refusing to issue a key" } },
      500
    );
  }

  const trimmed = label.trim();
  const { prefix, full } = generateKey();
  const created_at = new Date().toISOString();
  const id = insertApiKey({
    prefix,
    key_hash: hashKey(full),
    label: trimmed,
    created_at,
    revoked_at: null,
    // ALWAYS non-admin — the request body is NEVER trusted for this. Only the
    // CLI (`scripts/create-api-key.ts`, host shell access) may mint an admin
    // key. This closes any browser-session self-escalation path (defense in
    // depth: even a caller who already holds an admin key cannot mint another
    // admin key from the UI).
    is_admin: 0,
  });

  // EXPLICIT literal DTO — assembled field by field. Do NOT spread the record:
  // it carries `key_hash`. `full` is the plaintext, shown this one time only.
  return json({ id, prefix, label: trimmed, created_at, full }, 201);
}

/**
 * POST /api/keys/:id/revoke → `{ revoked: boolean }` (idempotent). `revoked` is
 * `true` iff a row transitioned active→revoked; already-revoked, unknown, or
 * non-numeric ids are a successful no-op (`false`, still 200), never an error.
 */
async function _handleKeysRevoke(req: Request): Promise<Response> {
  const { pathname } = new URL(req.url);
  const match = /^\/api\/keys\/([^/]+)\/revoke$/.exec(pathname);
  const id = match ? Number(match[1]) : Number.NaN;
  // A non-integer id can never match a row → idempotent no-op, and it avoids
  // binding NaN into the UPDATE.
  if (!Number.isInteger(id)) return json({ revoked: false });
  return json({ revoked: revokeApiKey(id) });
}

/**
 * PATCH /api/keys/:id `{ label }` → `200 ApiKeyMeta` (active-only, secret-safe).
 *
 * Updates ONLY the human-facing `label` of an ACTIVE key. Every other body
 * field is ignored — `updateApiKeyLabel(id, label)` structurally cannot touch
 * `key_hash`, `prefix`, `is_admin`, `created_at`, or `revoked_at`. The success
 * response is an EXPLICIT literal `ApiKeyMeta` DTO assembled field by field; it
 * MUST NEVER spread the DB row, which carries `key_hash`.
 *
 * State distinction (spec: revoked 409, unknown 404): a preliminary
 * `listApiKeys()` lookup classifies the target before the update. A bare
 * affected-rows check on `updateApiKeyLabel` alone cannot tell "revoked" from
 * "nonexistent" (both yield `false`), so the lookup disambiguates:
 *   - id not found            → 404
 *   - id found but revoked    → 409
 *   - id found and active     → update, then return updated metadata.
 */
async function _handleKeysRename(req: Request): Promise<Response> {
  const { pathname } = new URL(req.url);
  const match = /^\/api\/keys\/([^/]+)$/.exec(pathname);
  const id = match ? Number(match[1]) : Number.NaN;
  // A non-integer id can never match a row → 404 (mirrors revoke's NaN guard).
  if (!Number.isInteger(id)) {
    return json({ error: { message: "Not found" } }, 404);
  }

  let label: unknown;
  try {
    const body = (await req.json()) as { label?: unknown };
    label = body?.label;
  } catch {
    return json({ error: { message: "Invalid JSON body" } }, 400);
  }
  // Validation mirrors create: non-empty string after trimming.
  if (typeof label !== "string" || label.trim() === "") {
    return json({ error: { message: "label is required" } }, 400);
  }
  const trimmed = label.trim();

  // Classify the target BEFORE mutating so 404 (unknown) and 409 (revoked) are
  // distinguishable — updateApiKeyLabel returns `false` for both.
  const existing = listApiKeys().find((k) => k.id === id);
  if (!existing) {
    return json({ error: { message: "Not found" } }, 404);
  }
  if (existing.revoked_at != null) {
    return json({ error: { message: "Cannot rename a revoked key" } }, 409);
  }

  updateApiKeyLabel(id, trimmed);

  // EXPLICIT literal DTO — assembled field by field from the metadata row plus
  // the new label. Do NOT spread any record: `ApiKeyMeta` is secret-free by
  // construction, but building the literal keeps the no-leak guarantee local.
  return json({
    id: existing.id,
    prefix: existing.prefix,
    label: trimmed,
    created_at: existing.created_at,
    revoked_at: existing.revoked_at,
    is_admin: existing.is_admin,
  });
}

export const handleKeysList = withObservability(_handleKeysList);
export const handleKeysCreate = withObservability(_handleKeysCreate);
export const handleKeysRevoke = withObservability(_handleKeysRevoke);
export const handleKeysRename = withObservability(_handleKeysRename);
