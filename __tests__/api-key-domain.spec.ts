import { describe, it, expect, afterEach } from "bun:test";
import {
  generateKey,
  hashKey,
  parseKeyFromHeaders,
  setRequestKeyId,
  getRequestKeyId,
} from "../src/domain/api-keys.ts";

// hashKey() reads API_KEY_PEPPER at CALL TIME (via getApiKeyPepper), so the
// pepper-sensitivity tests mutate the env. Save/restore around every test.
const savedPepper = Bun.env.API_KEY_PEPPER;
afterEach(() => {
  if (savedPepper === undefined) delete Bun.env.API_KEY_PEPPER;
  else Bun.env.API_KEY_PEPPER = savedPepper;
});

// ---------------------------------------------------------------------------
// generateKey() — display-safe cpk_<prefix>.<secret> format  (task 2.3)
// ---------------------------------------------------------------------------

describe("domain — generateKey()", () => {
  it("returns a full key composed as `${prefix}.${secret}`", () => {
    const key = generateKey();
    expect(key.full).toBe(`${key.prefix}.${key.secret}`);
  });

  it("uses the display-safe `cpk_` scheme with a non-secret hex prefix", () => {
    const key = generateKey();
    expect(key.prefix).toMatch(/^cpk_[0-9a-f]{8}$/);
    expect(key.full.startsWith("cpk_")).toBe(true);
    // Exactly one separator dot between the public prefix and the secret.
    expect(key.full.split(".")).toHaveLength(2);
  });

  it("emits a high-entropy 256-bit (64 hex char) secret", () => {
    const key = generateKey();
    expect(key.secret).toMatch(/^[0-9a-f]{64}$/);
    // The display-safe prefix must never embed the secret.
    expect(key.prefix.includes(key.secret)).toBe(false);
  });

  it("generates a unique secret + full key on every call (randomness)", () => {
    const a = generateKey();
    const b = generateKey();
    expect(a.secret).not.toBe(b.secret);
    expect(a.full).not.toBe(b.full);
    expect(a.prefix).not.toBe(b.prefix);
  });
});

// ---------------------------------------------------------------------------
// hashKey() — HMAC-SHA256(pepper, full), deterministic + pepper-sensitive
// ---------------------------------------------------------------------------

describe("domain — hashKey()", () => {
  it("is deterministic: same key + same pepper → same 64-hex digest", () => {
    Bun.env.API_KEY_PEPPER = "server-pepper";
    const a = hashKey("cpk_abc.secret-one");
    const b = hashKey("cpk_abc.secret-one");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is pepper-sensitive: rotating the pepper changes the digest (kill switch)", () => {
    Bun.env.API_KEY_PEPPER = "pepper-one";
    const withPepper1 = hashKey("cpk_abc.secret-one");
    Bun.env.API_KEY_PEPPER = "pepper-two";
    const withPepper2 = hashKey("cpk_abc.secret-one");
    expect(withPepper1).not.toBe(withPepper2);
  });

  it("is input-sensitive: different keys under the same pepper differ", () => {
    Bun.env.API_KEY_PEPPER = "server-pepper";
    expect(hashKey("cpk_abc.secret-one")).not.toBe(hashKey("cpk_abc.secret-two"));
  });

  it("hashes the presented plaintext key so a stored digest matches at lookup", () => {
    Bun.env.API_KEY_PEPPER = "server-pepper";
    const key = generateKey();
    // The digest stored at issuance must equal the digest recomputed from the
    // same plaintext when a client later presents it.
    expect(hashKey(key.full)).toBe(hashKey(key.full));
    expect(hashKey(key.full)).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// parseKeyFromHeaders() — Bearer, then X-API-Key, Bearer precedence
// ---------------------------------------------------------------------------

describe("domain — parseKeyFromHeaders()", () => {
  const req = (headers: Record<string, string>) =>
    new Request("http://localhost/v1/chat/completions", { headers });

  it("extracts the key from `Authorization: Bearer <key>`", () => {
    expect(parseKeyFromHeaders(req({ Authorization: "Bearer cpk_a.secretA" }))).toBe(
      "cpk_a.secretA"
    );
  });

  it("extracts the key from `X-API-Key: <key>`", () => {
    expect(parseKeyFromHeaders(req({ "X-API-Key": "cpk_b.secretB" }))).toBe("cpk_b.secretB");
  });

  it("prefers Authorization: Bearer over X-API-Key when both are present", () => {
    const parsed = parseKeyFromHeaders(
      req({ Authorization: "Bearer cpk_bearer.win", "X-API-Key": "cpk_xkey.lose" })
    );
    expect(parsed).toBe("cpk_bearer.win");
  });

  it("returns null when neither header is present (unauthenticated)", () => {
    expect(parseKeyFromHeaders(req({}))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// setRequestKeyId / getRequestKeyId — per-Request WeakMap attribution
// ---------------------------------------------------------------------------

describe("domain — request → keyId WeakMap", () => {
  it("round-trips the attributed key id for a given Request identity", () => {
    const req = new Request("http://localhost/v1/chat/completions");
    setRequestKeyId(req, 42);
    expect(getRequestKeyId(req)).toBe(42);
  });

  it("returns undefined for a Request that was never attributed", () => {
    const req = new Request("http://localhost/v1/chat/completions");
    expect(getRequestKeyId(req)).toBeUndefined();
  });

  it("keeps attribution isolated per Request identity", () => {
    const reqA = new Request("http://localhost/v1/chat/completions");
    const reqB = new Request("http://localhost/v1/chat/completions");
    setRequestKeyId(reqA, 1);
    setRequestKeyId(reqB, 2);
    expect(getRequestKeyId(reqA)).toBe(1);
    expect(getRequestKeyId(reqB)).toBe(2);
  });
});
