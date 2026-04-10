import { describe, it, expect, vi, beforeEach } from "vitest";
import { TokenManager } from "../src/token-manager.js";
import * as client from "openid-client";

vi.mock("openid-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openid-client")>();
  return {
    ...actual,
    discovery: vi.fn(),
    refreshTokenGrant: vi.fn(),
  };
});

// A minimal JWT for testing (header.payload.signature)
// Payload: { "email": "test@example.com", "preferred_username": "testuser",
//   "realm_access": { "roles": ["viewer", "default-roles"] },
//   "resource_access": { "myclient": { "roles": ["operator"] } } }
function makeTestJwt(claims: Record<string, unknown> = {}): string {
  const defaultClaims = {
    email: "test@example.com",
    preferred_username: "testuser",
    realm_access: { roles: ["viewer", "default-roles"] },
    resource_access: { myclient: { roles: ["operator"] } },
    ...claims,
  };
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(defaultClaims)).toString("base64url");
  const signature = "fakesignature";
  return `${header}.${payload}.${signature}`;
}

describe("TokenManager", () => {
  let tm: TokenManager;

  beforeEach(() => {
    tm = new TokenManager(null);
  });

  it("starts unauthenticated", () => {
    expect(tm.isAuthenticated()).toBe(false);
    expect(tm.userEmail).toBeNull();
    expect(tm.roles).toEqual([]);
  });

  it("stores tokens and extracts email/roles from JWT", () => {
    const jwt = makeTestJwt();
    tm.storeTokens(jwt, "refresh123", 3600);

    expect(tm.isAuthenticated()).toBe(true);
    expect(tm.userEmail).toBe("test@example.com");
    expect(tm.roles).toContain("viewer");
    expect(tm.roles).toContain("operator");
    expect(tm.expiresInMinutes).toBeGreaterThan(50);
  });

  it("falls back to preferred_username when email is missing", () => {
    const jwt = makeTestJwt({ email: undefined });
    tm.storeTokens(jwt, null, 3600);

    expect(tm.userEmail).toBe("testuser");
  });

  it("deduplicates roles", () => {
    const jwt = makeTestJwt({
      realm_access: { roles: ["viewer"] },
      resource_access: { a: { roles: ["viewer", "operator"] } },
    });
    tm.storeTokens(jwt, null, 3600);

    expect(tm.roles).toEqual(["viewer", "operator"]);
  });

  it("clears tokens on clearTokens()", () => {
    const jwt = makeTestJwt();
    tm.storeTokens(jwt, "refresh123", 3600);
    tm.clearTokens();

    expect(tm.isAuthenticated()).toBe(false);
    expect(tm.userEmail).toBeNull();
    expect(tm.roles).toEqual([]);
  });

  it("reports expired when expiresAt is in the past", () => {
    const jwt = makeTestJwt();
    tm.storeTokens(jwt, null, 0); // expires immediately

    expect(tm.isTokenExpired()).toBe(true);
  });

  it("returns refresh context when all fields present", () => {
    const jwt = makeTestJwt();
    tm.storeTokens(jwt, "refresh123", 3600, "https://kc/token", "myid");

    const ctx = tm.refreshContext;
    expect(ctx).toEqual({
      refreshToken: "refresh123",
      tokenEndpoint: "https://kc/token",
      clientId: "myid",
    });
  });

  it("returns null refresh context when refresh token missing", () => {
    const jwt = makeTestJwt();
    tm.storeTokens(jwt, null, 3600);

    expect(tm.refreshContext).toBeNull();
  });

  it("throws when getAccessToken called without authentication", async () => {
    await expect(tm.getAccessToken()).rejects.toThrow("Not authenticated");
  });

  it("returns roles as a copy (not mutable reference)", () => {
    const jwt = makeTestJwt();
    tm.storeTokens(jwt, null, 3600);

    const roles1 = tm.roles;
    roles1.push("hacked");
    expect(tm.roles).not.toContain("hacked");
  });

  it("accepts an onTokenRefresh callback", () => {
    const cb = vi.fn();
    tm.onTokenRefresh = cb;

    // The callback is only invoked during refresh(), which requires OIDC.
    // Here we just verify the setter works and doesn't throw.
    expect(() => { tm.onTokenRefresh = null; }).not.toThrow();
  });

  it("setStaticToken reads expiry from JWT", () => {
    const futureExp = Math.floor(Date.now() / 1000) + 7200; // 2 hours from now
    const jwt = makeTestJwt({ exp: futureExp });
    tm.setStaticToken(jwt);

    expect(tm.isAuthenticated()).toBe(true);
    expect(tm.isTokenExpired()).toBe(false);
    // Should be roughly 120 minutes
    expect(tm.expiresInMinutes).toBeGreaterThan(110);
    expect(tm.expiresInMinutes).toBeLessThanOrEqual(120);
  });

  it("setStaticToken defaults to 1 hour when no exp claim", () => {
    const jwt = makeTestJwt({}); // no exp
    tm.setStaticToken(jwt);

    expect(tm.isAuthenticated()).toBe(true);
    expect(tm.expiresInMinutes).toBeGreaterThan(55);
    expect(tm.expiresInMinutes).toBeLessThanOrEqual(60);
  });

  it("keeps refreshed session alive when onTokenRefresh callback throws", async () => {
    const authed = new TokenManager({
      keycloakUrl: "https://kc.test",
      realm: "test",
      clientId: "test-client",
    });

    // Seed an expired session with a refresh token so refresh() proceeds.
    const initialJwt = makeTestJwt({ email: "initial@example.com" });
    authed.storeTokens(initialJwt, "old-refresh", 0, "https://kc.test/token", "test-client");

    // Short-circuit OIDC discovery.
    const fakeConfig = {} as client.Configuration;
    vi.mocked(client.discovery).mockResolvedValue(fakeConfig);

    // Return a successful refresh with a rotated refresh token.
    const newJwt = makeTestJwt({ email: "refreshed@example.com" });
    vi.mocked(client.refreshTokenGrant).mockResolvedValue({
      access_token: newJwt,
      refresh_token: "new-refresh",
      expires_in: 3600,
      token_type: "Bearer",
      expiresIn: () => 3600,
    } as unknown as Awaited<ReturnType<typeof client.refreshTokenGrant>>);

    // Persistence callback blows up — simulating a disk write failure.
    authed.onTokenRefresh = () => {
      throw new Error("ENOSPC: no space left on device");
    };

    const token = await authed.getAccessToken();

    // The refreshed in-memory session must survive the persist failure.
    expect(token).toBe(newJwt);
    expect(authed.isAuthenticated()).toBe(true);
    expect(authed.userEmail).toBe("refreshed@example.com");
    expect(authed.expiresInMinutes).toBeGreaterThan(50);

    vi.restoreAllMocks();
  });

  it("setStaticToken clears refresh context", () => {
    const jwt = makeTestJwt();
    // First store with refresh token
    tm.storeTokens(jwt, "refresh-tok", 3600, "https://kc/token", "client-id");
    expect(tm.refreshContext).not.toBeNull();

    // Static token should clear it
    tm.setStaticToken(jwt);
    expect(tm.refreshContext).toBeNull();
  });
});
