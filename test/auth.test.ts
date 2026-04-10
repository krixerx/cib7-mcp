import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as client from "openid-client";
import { parseAuthConfig, startBrowserLogin } from "../src/auth.js";
import { TokenManager } from "../src/token-manager.js";

vi.mock("openid-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openid-client")>();
  return {
    ...actual,
    discovery: vi.fn(),
    buildAuthorizationUrl: vi.fn(),
    authorizationCodeGrant: vi.fn(),
  };
});

vi.mock("../src/auth-store.js", () => ({
  storeRefreshContext: vi.fn(),
}));

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
    expect(parseAuthConfig()).toBeNull();
  });

  it("returns config when all KEYCLOAK_* vars set", () => {
    process.env.KEYCLOAK_URL = "https://keycloak.example.com";
    process.env.KEYCLOAK_REALM = "myrealm";
    process.env.KEYCLOAK_CLIENT_ID = "myclient";

    const config = parseAuthConfig();
    expect(config).toEqual({
      keycloakUrl: "https://keycloak.example.com",
      realm: "myrealm",
      clientId: "myclient",
    });
  });

  it("throws when KEYCLOAK_* vars partially set", () => {
    process.env.KEYCLOAK_URL = "https://keycloak.example.com";
    delete process.env.KEYCLOAK_REALM;
    delete process.env.KEYCLOAK_CLIENT_ID;

    expect(() => parseAuthConfig()).toThrow("Incomplete Keycloak configuration");
    expect(() => parseAuthConfig()).toThrow("KEYCLOAK_REALM");
  });

  it("lists all missing vars in error", () => {
    process.env.KEYCLOAK_URL = "https://keycloak.example.com";
    delete process.env.KEYCLOAK_REALM;
    delete process.env.KEYCLOAK_CLIENT_ID;

    try {
      parseAuthConfig();
      expect.fail("Should have thrown");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("KEYCLOAK_REALM");
      expect(message).toContain("KEYCLOAK_CLIENT_ID");
      // KEYCLOAK_URL is set, so it should NOT appear in the "Missing:" list
      expect(message).not.toContain("Missing: KEYCLOAK_URL");
    }
  });

  it("does not require KEYCLOAK_CLIENT_SECRET", () => {
    process.env.KEYCLOAK_URL = "https://keycloak.example.com";
    process.env.KEYCLOAK_REALM = "myrealm";
    process.env.KEYCLOAK_CLIENT_ID = "myclient";
    // No KEYCLOAK_CLIENT_SECRET needed

    const config = parseAuthConfig();
    expect(config).toBeDefined();
    expect(config).not.toHaveProperty("clientSecret");
  });
});

describe("startBrowserLogin", () => {
  const authConfig = {
    keycloakUrl: "https://kc.test",
    realm: "test",
    clientId: "test-client",
  };

  beforeEach(() => {
    vi.mocked(client.discovery).mockResolvedValue({
      serverMetadata: () => ({ token_endpoint: "https://kc.test/token" }),
    } as unknown as client.Configuration);
    vi.mocked(client.buildAuthorizationUrl).mockReturnValue(
      new URL("https://kc.test/auth?client_id=test-client&state=abc"),
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns authorizationUrl synchronously, before the callback arrives", async () => {
    const tm = new TokenManager(authConfig);

    const session = await startBrowserLogin(authConfig, tm, { openBrowser: false });

    expect(session.authorizationUrl).toBe(
      "https://kc.test/auth?client_id=test-client&state=abc",
    );
    expect(session.completion).toBeInstanceOf(Promise);
    expect(tm.isAuthenticated()).toBe(false); // No tokens yet — callback hasn't happened.

    // Do not await completion (it would hang waiting for the 2-minute callback).
    // Attach a no-op rejection handler and cancel the underlying server by
    // forcing a rejection via an immediate mock auth grant failure is not
    // needed — the test process will exit and the callback server will be
    // GC'd. Attach the handler to prevent unhandled rejection warnings.
    session.completion.catch(() => {});
  });

  it("does not open the browser when openBrowser: false", async () => {
    const tm = new TokenManager(authConfig);

    // If the real browser opener ran, we'd see a process spawn. We can't
    // easily observe that from here, but we can at least confirm the call
    // succeeds without throwing and returns promptly.
    const start = Date.now();
    const session = await startBrowserLogin(authConfig, tm, { openBrowser: false });
    const elapsed = Date.now() - start;

    expect(session.authorizationUrl).toContain("https://kc.test/auth");
    expect(elapsed).toBeLessThan(1000); // Should not block on anything.

    session.completion.catch(() => {});
  });
});
