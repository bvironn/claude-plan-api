import { getApiKeyPepper } from "../../config.ts";
import { generateKey, hashKey } from "../../domain/api-keys.ts";
import { listApiKeys, insertApiKey, revokeApiKey, updateApiKeyLabel, rotateApiKey } from "../../observability/storage.ts";
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

/**
 * POST /api/keys/:id/rotate → `200 RotatedApiKey` (active-only, plaintext once).
 *
 * In-place secret swap on the SAME `id` — mints a fresh `{prefix, full}` via
 * the identical `generateKey()` sequence as create, hashes it in the ROUTE
 * (storage never sees plaintext, mirrors `_handleKeysCreate`), and persists
 * via a single atomic `rotateApiKey()` UPDATE. The success response is an
 * EXPLICIT literal `RotatedApiKey` DTO assembled field by field; it MUST NEVER
 * spread the DB row (which carries `key_hash`) or `existing` (a stale
 * `ApiKeyMeta`, not the new state).
 *
 * State distinction (spec: revoked 409, unknown 404) mirrors `_handleKeysRename`:
 * a preliminary `listApiKeys()` lookup classifies the target BEFORE mutating,
 * because `rotateApiKey`'s bare affected-rows check alone cannot tell
 * "revoked" from "nonexistent" (both yield `false`).
 *
 * A `key_hash` UNIQUE collision from `rotateApiKey()` is deliberately NOT
 * caught here — it propagates to the server's outer try/catch (→ 5xx), and
 * the atomic UPDATE leaves the original row untouched (REQ-4).
 */
async function _handleKeysRotate(req: Request): Promise<Response> {
  const { pathname } = new URL(req.url);
  const match = /^\/api\/keys\/([^/]+)\/rotate$/.exec(pathname);
  const id = match ? Number(match[1]) : Number.NaN;
  // A non-integer id can never match a row → 404 (mirrors rename's NaN guard).
  if (!Number.isInteger(id)) {
    return json({ error: { message: "Not found" } }, 404);
  }

  // Classify the target BEFORE mutating so 404 (unknown) and 409 (revoked) are
  // distinguishable — rotateApiKey returns `false` for both.
  const existing = listApiKeys().find((k) => k.id === id);
  if (!existing) {
    return json({ error: { message: "Not found" } }, 404);
  }
  if (existing.revoked_at != null) {
    return json({ error: { message: "Cannot rotate a revoked key" } }, 409);
  }

  const { prefix, full } = generateKey();
  const rotated_at = new Date().toISOString();
  // Deliberately NOT wrapped in try/catch: a UNIQUE collision on key_hash must
  // surface (REQ-4), not be swallowed. The atomic UPDATE's WHERE clause means
  // a thrown error leaves the original row untouched.
  const rotated = rotateApiKey(id, prefix, hashKey(full), rotated_at);
  // The active-only UPDATE matches no row when the key was revoked in the window
  // since the preliminary classification (TOCTOU). Never report success with a
  // plaintext that was never persisted — re-classify the race loss as revoked.
  if (!rotated) {
    return json({ error: { message: "Cannot rotate a revoked key" } }, 409);
  }

  // EXPLICIT literal DTO — assembled field by field. Do NOT spread any row:
  // `full` is the plaintext, shown this one time only; everything else comes
  // from the preliminary lookup plus the freshly minted prefix/timestamp.
  return json({
    id: existing.id,
    prefix,
    label: existing.label,
    created_at: existing.created_at,
    revoked_at: existing.revoked_at,
    rotated_at,
    full,
  });
}

export const handleKeysList = withObservability(_handleKeysList);
export const handleKeysCreate = withObservability(_handleKeysCreate);
export const handleKeysRevoke = withObservability(_handleKeysRevoke);
export const handleKeysRename = withObservability(_handleKeysRename);
export const handleKeysRotate = withObservability(_handleKeysRotate);
