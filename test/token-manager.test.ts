import { describe, it, expect, beforeEach } from "vitest";
import { TokenManager } from "../src/token-manager.js";

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
});
