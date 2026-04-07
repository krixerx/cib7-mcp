import { describe, it, expect, vi } from "vitest";
import { parseAuthConfig } from "../src/auth.js";

describe("parseAuthConfig", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns null when no KEYCLOAK_* vars set", () => {
    delete process.env.KEYCLOAK_URL;
    delete process.env.KEYCLOAK_REALM;
    delete process.env.KEYCLOAK_CLIENT_ID;
    delete process.env.KEYCLOAK_CLIENT_SECRET;
    expect(parseAuthConfig()).toBeNull();
  });

  it("returns config when all KEYCLOAK_* vars set", () => {
    process.env.KEYCLOAK_URL = "https://keycloak.example.com";
    process.env.KEYCLOAK_REALM = "myrealm";
    process.env.KEYCLOAK_CLIENT_ID = "myclient";
    process.env.KEYCLOAK_CLIENT_SECRET = "mysecret";

    const config = parseAuthConfig();
    expect(config).toEqual({
      keycloakUrl: "https://keycloak.example.com",
      realm: "myrealm",
      clientId: "myclient",
      clientSecret: "mysecret",
    });
  });

  it("throws when KEYCLOAK_* vars partially set", () => {
    process.env.KEYCLOAK_URL = "https://keycloak.example.com";
    delete process.env.KEYCLOAK_REALM;
    delete process.env.KEYCLOAK_CLIENT_ID;
    delete process.env.KEYCLOAK_CLIENT_SECRET;

    expect(() => parseAuthConfig()).toThrow("Incomplete Keycloak configuration");
    expect(() => parseAuthConfig()).toThrow("KEYCLOAK_REALM");
  });

  it("lists all missing vars in error", () => {
    process.env.KEYCLOAK_URL = "https://keycloak.example.com";
    delete process.env.KEYCLOAK_REALM;
    delete process.env.KEYCLOAK_CLIENT_ID;
    process.env.KEYCLOAK_CLIENT_SECRET = "secret";

    try {
      parseAuthConfig();
      expect.fail("Should have thrown");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("KEYCLOAK_REALM");
      expect(message).toContain("KEYCLOAK_CLIENT_ID");
      expect(message).not.toContain("KEYCLOAK_URL");
      expect(message).not.toContain("KEYCLOAK_CLIENT_SECRET");
    }
  });
});
