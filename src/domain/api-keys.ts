import { getApiKeyPepper } from "../config.ts";

/**
 * API-key domain: pure key generation, fast-hash validation, header extraction,
 * and per-`Request` attribution transport. No I/O, no storage — the guard and
 * the issuance CLI compose these with `storage.ts`.
 *
 * Key format (design decision #4): `cpk_<prefix>.<secret>`.
 *   - `cpk_` is a stable, display-safe scheme identifier (Stripe/GitHub style).
 *   - `<prefix>` is a short non-secret hex handle, persisted plaintext + indexed
 *     so a key can be identified in logs/UI without exposing the secret.
 *   - `<secret>` is a 256-bit high-entropy hex string. It is shown to the
 *     operator exactly once at issuance and is NEVER persisted — only its
 *     `HMAC-SHA256(pepper, full)` digest is stored.
 */

const KEY_SCHEME = "cpk_";
const PREFIX_ENTROPY_BYTES = 4; // → 8 hex chars of public handle
const SECRET_ENTROPY_BYTES = 32; // → 64 hex chars, 256-bit secret

export interface GeneratedKey {
  /** Display-safe public handle, e.g. `cpk_1a2b3c4d`. Persisted + indexed. */
  prefix: string;
  /** High-entropy 256-bit hex secret. Shown once, never persisted. */
  secret: string;
  /** The full plaintext key presented to clients: `${prefix}.${secret}`. */
  full: string;
}

/** Hex-encode `bytes` cryptographically-random bytes (Web Crypto, Bun-native). */
function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let hex = "";
  for (const b of buf) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/**
 * Mint a new API key. Returns the split parts and the composed `full` key.
 * The caller persists `prefix` + `hashKey(full)` and prints `full` once.
 */
export function generateKey(): GeneratedKey {
  const prefix = `${KEY_SCHEME}${randomHex(PREFIX_ENTROPY_BYTES)}`;
  const secret = randomHex(SECRET_ENTROPY_BYTES);
  return { prefix, secret, full: `${prefix}.${secret}` };
}

/**
 * Compute the storage digest for a full plaintext key:
 * `HMAC-SHA256(API_KEY_PEPPER, full)` as lowercase hex.
 *
 * Fast (sub-ms) by design — NOT an adaptive hash — because it runs on every
 * gated request. The pepper is read at call time so rotating it invalidates
 * every issued key (kill switch) without a re-import.
 */
export function hashKey(full: string): string {
  return new Bun.CryptoHasher("sha256", getApiKeyPepper()).update(full).digest("hex");
}

/**
 * Extract a presented key from request headers. `Authorization: Bearer <key>`
 * takes precedence over `X-API-Key: <key>`; a request with neither (or a
 * malformed Authorization and no X-API-Key) is treated as unauthenticated
 * (`null`).
 */
export function parseKeyFromHeaders(req: Request): string | null {
  const authorization = req.headers.get("authorization");
  if (authorization) {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (match) return match[1]!.trim();
  }
  const xApiKey = req.headers.get("x-api-key");
  if (xApiKey && xApiKey.trim()) return xApiKey.trim();
  return null;
}

// ---------------------------------------------------------------------------
// Attribution transport (design decision #5): a module-level WeakMap keyed by
// the `Request` identity. The guard `set`s the validated key id; the
// observability middleware `get`s it when building `insertRequest`. Same `req`
// object flows fetch → observedX → withObservability, so no header mutation is
// needed and entries are GC-collected with the request.
// ---------------------------------------------------------------------------

const requestKeyIds = new WeakMap<Request, number>();

/** Attribute a validated `api_keys.id` to this request. */
export function setRequestKeyId(req: Request, id: number): void {
  requestKeyIds.set(req, id);
}

/** Read the attributed `api_keys.id` for this request, or `undefined`. */
export function getRequestKeyId(req: Request): number | undefined {
  return requestKeyIds.get(req);
}
