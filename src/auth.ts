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

export interface BrowserLoginSession {
  authorizationUrl: string;
  completion: Promise<{ userEmail: string | null; expiresInMinutes: number }>;
}

export interface StartBrowserLoginOptions {
  openBrowser?: boolean;
}

/**
 * Start a browser-based PKCE login flow.
 *
 * Two-phase so the caller gets the authorization URL synchronously before
 * the OAuth callback arrives. Useful for headless/remote environments where
 * the user must open the URL manually.
 *
 * 1. Discover OIDC endpoints from Keycloak
 * 2. Generate PKCE code_verifier + code_challenge
 * 3. Start the callback server and build the auth URL
 * 4. Optionally open the browser
 * 5. Return {authorizationUrl, completion} immediately
 *
 * The `completion` promise resolves once the callback arrives, the code is
 * exchanged for tokens, and the refresh context has been persisted.
 */
export async function startBrowserLogin(
  authConfig: AuthConfig,
  tokenManager: TokenManager,
  options: StartBrowserLoginOptions = {},
): Promise<BrowserLoginSession> {
  const shouldOpenBrowser = options.openBrowser ?? true;
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

  // Wait for the server to be listening (or fail) before reading the port.
  try {
    await callbackServer.listening;
  } catch (err) {
    // Surface the rejection from callbackPromise so it does not stay
    // unhandled, then rethrow a clean error to the caller.
    callbackPromise.catch(() => {});
    throw err;
  }

  const redirectUri = callbackServer.redirectUri;

  const authUrl = client.buildAuthorizationUrl(oidcConfig, {
    redirect_uri: redirectUri,
    scope: "openid email profile",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
  });

  const authorizationUrl = authUrl.href;

  // Step 4: Open browser (skip in headless mode)
  if (shouldOpenBrowser) {
    openBrowser(authorizationUrl);
  }

  // Step 5: Return immediately with a completion promise the caller can await.
  const completion = (async () => {
    try {
      const { code } = await callbackPromise;

      const callbackUrl = new URL(
        `${redirectUri}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
      );

      const tokenSet = await client.authorizationCodeGrant(
        oidcConfig,
        callbackUrl,
        { pkceCodeVerifier: codeVerifier },
      );

      const serverMeta = oidcConfig.serverMetadata();
      const tokenEndpoint = serverMeta.token_endpoint ?? "";

      tokenManager.storeTokens(
        tokenSet.access_token,
        tokenSet.refresh_token ?? null,
        tokenSet.expires_in ?? 300,
        tokenEndpoint,
        authConfig.clientId,
      );

      const refreshCtx = tokenManager.refreshContext;
      if (refreshCtx) {
        const instanceId = `${authConfig.keycloakUrl}/${authConfig.realm}`;
        try {
          storeRefreshContext(
            instanceId,
            refreshCtx,
            authConfig.keycloakUrl,
            authConfig.realm,
          );
        } catch (err) {
          // Persistence is best-effort: the in-memory session is still valid.
          console.error(
            `Failed to persist refresh token: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      return {
        userEmail: tokenManager.userEmail,
        expiresInMinutes: tokenManager.expiresInMinutes,
      };
    } catch (err) {
      callbackServer.stop();
      throw err;
    }
  })();

  return { authorizationUrl, completion };
}

/**
 * Backwards-compatible wrapper: start the browser login and await completion.
 */
export async function performBrowserLogin(
  authConfig: AuthConfig,
  tokenManager: TokenManager,
): Promise<{ userEmail: string | null; expiresInMinutes: number; authorizationUrl: string }> {
  const session = await startBrowserLogin(authConfig, tokenManager);
  const result = await session.completion;
  return {
    userEmail: result.userEmail,
    expiresInMinutes: result.expiresInMinutes,
    authorizationUrl: session.authorizationUrl,
  };
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
