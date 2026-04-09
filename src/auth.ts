/**
 * PKCE browser-based authentication flow for Keycloak.
 *
 * Uses openid-client v6 for OIDC discovery, PKCE generation,
 * authorization URL building, and code exchange. No client secret
 * needed (public client).
 */

import { exec } from "node:child_process";
import * as client from "openid-client";
import { storeRefreshContext } from "./auth-store.js";
import { CallbackServer } from "./callback-server.js";
import type { TokenManager } from "./token-manager.js";
import type { AuthConfig } from "./types.js";

/**
 * Perform browser-based PKCE login flow.
 *
 * 1. Discover OIDC endpoints from Keycloak
 * 2. Generate PKCE code_verifier + code_challenge
 * 3. Open browser to Keycloak login page
 * 4. Wait for callback with authorization code
 * 5. Exchange code for tokens
 * 6. Store tokens in TokenManager + persist refresh context
 */
export async function performBrowserLogin(
  authConfig: AuthConfig,
  tokenManager: TokenManager,
): Promise<{ userEmail: string | null; expiresInMinutes: number; authorizationUrl: string }> {
  const issuerUrl = new URL(`/realms/${authConfig.realm}`, authConfig.keycloakUrl);

  // Step 1: OIDC discovery (public client, no secret)
  let oidcConfig: client.Configuration;
  try {
    oidcConfig = await client.discovery(
      issuerUrl,
      authConfig.clientId,
      undefined,
      client.None(),
    );
  } catch (err) {
    throw new Error(
      `Cannot reach Keycloak at ${authConfig.keycloakUrl}. ` +
      `Check KEYCLOAK_URL and network connectivity. ` +
      `${err instanceof Error ? err.message : ""}`,
    );
  }

  // Step 2: Generate PKCE pair and state
  const codeVerifier = client.randomPKCECodeVerifier();
  const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
  const state = client.randomState();

  // Step 3: Start callback server and build auth URL
  const callbackServer = new CallbackServer();
  const callbackPromise = callbackServer.start(state);

  // Wait for the server to be listening before reading the port
  await callbackServer.listening;

  const redirectUri = callbackServer.redirectUri;

  const authUrl = client.buildAuthorizationUrl(oidcConfig, {
    redirect_uri: redirectUri,
    scope: "openid email profile",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
  });

  const authorizationUrl = authUrl.href;

  // Step 4: Open browser
  openBrowser(authorizationUrl);

  try {
    // Step 5: Wait for callback with auth code
    const { code } = await callbackPromise;

    // Step 6: Exchange code for tokens
    // Build a URL that looks like what the callback server received
    const callbackUrl = new URL(`${redirectUri}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`);

    const tokenSet = await client.authorizationCodeGrant(
      oidcConfig,
      callbackUrl,
      { pkceCodeVerifier: codeVerifier },
    );

    // Get the token endpoint from server metadata for refresh
    const serverMeta = oidcConfig.serverMetadata();
    const tokenEndpoint = serverMeta.token_endpoint ?? "";

    // Store tokens
    tokenManager.storeTokens(
      tokenSet.access_token,
      tokenSet.refresh_token ?? null,
      tokenSet.expires_in ?? 300,
      tokenEndpoint,
      authConfig.clientId,
    );

    // Persist refresh context for cross-session auth
    const refreshCtx = tokenManager.refreshContext;
    if (refreshCtx) {
      const instanceId = `${authConfig.keycloakUrl}/${authConfig.realm}`;
      storeRefreshContext(
        instanceId,
        refreshCtx,
        authConfig.keycloakUrl,
        authConfig.realm,
      );
    }

    return {
      userEmail: tokenManager.userEmail,
      expiresInMinutes: tokenManager.expiresInMinutes,
      authorizationUrl,
    };
  } catch (err) {
    callbackServer.stop();
    throw err;
  }
}

export function parseAuthConfig(): AuthConfig | null {
  const keycloakUrl = process.env.KEYCLOAK_URL;
  const realm = process.env.KEYCLOAK_REALM;
  const clientId = process.env.KEYCLOAK_CLIENT_ID;

  if (!keycloakUrl && !realm && !clientId) {
    return null; // Unauthenticated mode
  }

  if (!keycloakUrl || !realm || !clientId) {
    const missing = [];
    if (!keycloakUrl) missing.push("KEYCLOAK_URL");
    if (!realm) missing.push("KEYCLOAK_REALM");
    if (!clientId) missing.push("KEYCLOAK_CLIENT_ID");
    throw new Error(
      `Incomplete Keycloak configuration. Missing: ${missing.join(", ")}. ` +
      `Either set all KEYCLOAK_URL, KEYCLOAK_REALM, KEYCLOAK_CLIENT_ID or none.`,
    );
  }

  return { keycloakUrl, realm, clientId };
}

/**
 * Derive an instance ID from the auth config for persistent storage.
 */
export function getInstanceId(config: AuthConfig): string {
  return `${config.keycloakUrl}/${config.realm}`;
}

function openBrowser(url: string): void {
  const platform = process.platform;
  let cmd: string;

  if (platform === "win32") {
    cmd = `start "" "${url}"`;
  } else if (platform === "darwin") {
    cmd = `open "${url}"`;
  } else {
    cmd = `xdg-open "${url}"`;
  }

  exec(cmd, (err) => {
    if (err) {
      // Log to stderr, don't throw. The URL is shown in the tool result anyway.
      console.error(`Failed to open browser: ${err.message}`);
      console.error(`Please open this URL manually: ${url}`);
    }
  });
}
