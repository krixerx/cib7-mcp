import * as client from "openid-client";
import type { AuthConfig, AuthProvider } from "./types.js";

export function createAuthProvider(config: AuthConfig | null): AuthProvider {
  if (!config) {
    return {
      getToken: async () => null,
      invalidateToken: () => {},
    };
  }

  // Capture non-null config in local constants for closure safety
  const { keycloakUrl, realm, clientId, clientSecret } = config;

  let cachedToken: string | null = null;
  let expiresAt = 0;

  const issuerUrl = new URL(`/realms/${realm}`, keycloakUrl);

  let discoveryConfig: client.Configuration | null = null;

  async function ensureDiscovery(): Promise<client.Configuration> {
    if (!discoveryConfig) {
      try {
        discoveryConfig = await client.discovery(
          issuerUrl,
          clientId,
          clientSecret
        );
      } catch (err) {
        throw new Error(
          `Cannot reach Keycloak at ${keycloakUrl}. Check KEYCLOAK_URL and network connectivity. ${err instanceof Error ? err.message : ""}`
        );
      }
    }
    return discoveryConfig;
  }

  async function acquireToken(): Promise<string> {
    const oidcConfig = await ensureDiscovery();

    let tokenSet: client.TokenEndpointResponse;
    try {
      tokenSet = await client.clientCredentialsGrant(oidcConfig);
    } catch (err) {
      throw new Error(
        `Keycloak authentication failed. Check KEYCLOAK_CLIENT_ID and KEYCLOAK_CLIENT_SECRET. ${err instanceof Error ? err.message : ""}`
      );
    }

    cachedToken = tokenSet.access_token;

    // Refresh at 80% of expiry
    const expiresIn = tokenSet.expires_in ?? 300;
    expiresAt = Date.now() + expiresIn * 800; // 80% of expires_in in ms

    return cachedToken;
  }

  return {
    async getToken(): Promise<string | null> {
      if (cachedToken && Date.now() < expiresAt) {
        return cachedToken;
      }
      return acquireToken();
    },

    invalidateToken(): void {
      cachedToken = null;
      expiresAt = 0;
    },
  };
}

export function parseAuthConfig(): AuthConfig | null {
  const keycloakUrl = process.env.KEYCLOAK_URL;
  const realm = process.env.KEYCLOAK_REALM;
  const clientId = process.env.KEYCLOAK_CLIENT_ID;
  const clientSecret = process.env.KEYCLOAK_CLIENT_SECRET;

  if (!keycloakUrl && !realm && !clientId && !clientSecret) {
    return null; // Unauthenticated mode
  }

  if (!keycloakUrl || !realm || !clientId || !clientSecret) {
    const missing = [];
    if (!keycloakUrl) missing.push("KEYCLOAK_URL");
    if (!realm) missing.push("KEYCLOAK_REALM");
    if (!clientId) missing.push("KEYCLOAK_CLIENT_ID");
    if (!clientSecret) missing.push("KEYCLOAK_CLIENT_SECRET");
    throw new Error(
      `Incomplete Keycloak configuration. Missing: ${missing.join(", ")}. Either set all KEYCLOAK_* variables or none.`
    );
  }

  return { keycloakUrl, realm, clientId, clientSecret };
}
