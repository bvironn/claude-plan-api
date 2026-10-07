import { describe, test, expect } from "bun:test";
import { redact } from "../src/observability/logger.ts";

describe("log payload redaction", () => {
  test("secret-named keys are redacted", () => {
    expect(redact({ accessToken: "x", refresh_token: "y", authorization: "Bearer z", model: "m" })).toEqual({
      accessToken: "REDACTED",
      refresh_token: "REDACTED",
      authorization: "REDACTED",
      model: "m",
    });
  });

  test("token-shaped values are redacted under any key", () => {
    expect(redact({ note: "sk-ant-oat01-abcdef", jwt: "eyJhbGciOiJIUzI1NiJ9.x" })).toEqual({
      note: "REDACTED",
      jwt: "REDACTED",
    });
  });

  test("returns the same object when nothing matches", () => {
    const payload = { status: 401, model: "claude-opus-5-5", error: "unauthorized" };
    expect(redact(payload)).toBe(payload);
  });
});
