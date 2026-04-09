/**
 * Role constants and authentication guards for MCP tools.
 *
 * Currently enforces viewer role. Architecture supports
 * future operator role for process modification actions.
 */

import { getRefreshContext } from "./auth-store.js";
import type { TokenManager } from "./token-manager.js";

export const ROLE_VIEWER = "viewer";
// Future: export const ROLE_OPERATOR = "operator";

/**
 * Ensure the user is authenticated and return a valid access token.
 *
 * Priority chain:
 * 1. Valid cached token -> return immediately
 * 2. Token needs refresh -> attempt refresh
 * 3. Stored refresh context -> attempt stored refresh
 * 4. Throw error directing Claude to call auth_login
 */
export async function ensureAuthenticated(
  tokenManager: TokenManager,
  instanceId: string,
): Promise<string> {
  // Step 1: Valid cached token
  if (tokenManager.isAuthenticated() && !tokenManager.isTokenExpired()) {
    return tokenManager.getAccessToken();
  }

  // Step 2: Token needs refresh (in-memory refresh token)
  if (tokenManager.isAuthenticated()) {
    try {
      return await tokenManager.getAccessToken(); // triggers refresh
    } catch {
      // Fall through to stored context
    }
  }

  // Step 3: Stored refresh context
  const storedCtx = getRefreshContext(instanceId);
  if (storedCtx) {
    const success = await tokenManager.tryStoredRefresh(storedCtx);
    if (success) {
      return tokenManager.getAccessToken();
    }
  }

  // Step 4: No valid auth
  throw new Error("Not authenticated. Call auth_login first.");
}
