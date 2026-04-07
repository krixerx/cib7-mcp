import { describe, it, expect } from "vitest";
import { createRedactor } from "../src/redaction.js";

describe("createRedactor", () => {
  it("returns identity function when no patterns", () => {
    const redact = createRedactor(undefined);
    const obj = { name: "test", password: "secret" };
    expect(redact(obj)).toEqual(obj);
  });

  it("returns identity function for empty string", () => {
    const redact = createRedactor("");
    const obj = { name: "test", password: "secret" };
    expect(redact(obj)).toEqual(obj);
  });

  it("redacts matching field names", () => {
    const redact = createRedactor("password.*,secret.*");
    const obj = { name: "test", password: "s3cret", secretKey: "abc123" };
    expect(redact(obj)).toEqual({
      name: "test",
      password: "[REDACTED]",
      secretKey: "[REDACTED]",
    });
  });

  it("is case-insensitive", () => {
    const redact = createRedactor("Password");
    const obj = { PASSWORD: "val", password: "val", Password: "val" };
    const result = redact(obj);
    expect(result.PASSWORD).toBe("[REDACTED]");
    expect(result.password).toBe("[REDACTED]");
    expect(result.Password).toBe("[REDACTED]");
  });

  it("redacts nested objects recursively", () => {
    const redact = createRedactor("token");
    const obj = {
      user: {
        name: "alice",
        token: "abc",
        profile: {
          token: "def",
          bio: "hello",
        },
      },
    };
    expect(redact(obj)).toEqual({
      user: {
        name: "alice",
        token: "[REDACTED]",
        profile: {
          token: "[REDACTED]",
          bio: "hello",
        },
      },
    });
  });

  it("redacts objects inside arrays", () => {
    const redact = createRedactor("secret");
    const obj = {
      items: [
        { id: 1, secret: "a" },
        { id: 2, secret: "b" },
      ],
    };
    expect(redact(obj)).toEqual({
      items: [
        { id: 1, secret: "[REDACTED]" },
        { id: 2, secret: "[REDACTED]" },
      ],
    });
  });

  it("handles null and undefined values", () => {
    const redact = createRedactor("password");
    const obj = { password: null, name: undefined, other: "val" };
    const result = redact(obj);
    expect(result.password).toBe("[REDACTED]");
    expect(result.name).toBeUndefined();
    expect(result.other).toBe("val");
  });

  it("throws on invalid regex pattern", () => {
    expect(() => createRedactor("[invalid")).toThrow("Invalid redaction pattern");
  });

  it("handles comma-delimited patterns with whitespace", () => {
    const redact = createRedactor(" password , token , secret ");
    const obj = { password: "a", token: "b", secret: "c", name: "d" };
    expect(redact(obj)).toEqual({
      password: "[REDACTED]",
      token: "[REDACTED]",
      secret: "[REDACTED]",
      name: "d",
    });
  });
});
