import { describe, it, expect, afterEach } from "bun:test";
import { isApiKeyRequired, getApiKeyPepper } from "../src/config.ts";

// These flags are read at CALL TIME from Bun.env (mirroring
// isClaudeCodeIdentityEnabled) so tests can flip enforcement without
// re-importing the module. Save/restore the env around each test.
const savedRequire = Bun.env.REQUIRE_API_KEY;
const savedPepper = Bun.env.API_KEY_PEPPER;

afterEach(() => {
  if (savedRequire === undefined) delete Bun.env.REQUIRE_API_KEY;
  else Bun.env.REQUIRE_API_KEY = savedRequire;
  if (savedPepper === undefined) delete Bun.env.API_KEY_PEPPER;
  else Bun.env.API_KEY_PEPPER = savedPepper;
});

describe("config — isApiKeyRequired()", () => {
  it("is true only when REQUIRE_API_KEY === 'true'", () => {
    Bun.env.REQUIRE_API_KEY = "true";
    expect(isApiKeyRequired()).toBe(true);
  });

  it("defaults to false when REQUIRE_API_KEY is unset", () => {
    delete Bun.env.REQUIRE_API_KEY;
    expect(isApiKeyRequired()).toBe(false);
  });

  it("is false for any non-'true' value (e.g. '1', 'false', 'TRUE')", () => {
    Bun.env.REQUIRE_API_KEY = "1";
    expect(isApiKeyRequired()).toBe(false);
    Bun.env.REQUIRE_API_KEY = "false";
    expect(isApiKeyRequired()).toBe(false);
    Bun.env.REQUIRE_API_KEY = "TRUE";
    expect(isApiKeyRequired()).toBe(false);
  });

  it("reflects call-time env changes without re-importing", () => {
    Bun.env.REQUIRE_API_KEY = "false";
    expect(isApiKeyRequired()).toBe(false);
    Bun.env.REQUIRE_API_KEY = "true";
    expect(isApiKeyRequired()).toBe(true);
  });
});

describe("config — getApiKeyPepper()", () => {
  it("returns the configured pepper secret", () => {
    Bun.env.API_KEY_PEPPER = "s3cr3t-pepper";
    expect(getApiKeyPepper()).toBe("s3cr3t-pepper");
  });

  it("returns '' when API_KEY_PEPPER is unset", () => {
    delete Bun.env.API_KEY_PEPPER;
    expect(getApiKeyPepper()).toBe("");
  });

  it("reflects call-time changes to API_KEY_PEPPER", () => {
    Bun.env.API_KEY_PEPPER = "first";
    expect(getApiKeyPepper()).toBe("first");
    Bun.env.API_KEY_PEPPER = "rotated";
    expect(getApiKeyPepper()).toBe("rotated");
  });
});
