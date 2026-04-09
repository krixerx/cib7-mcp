/**
 * In-memory token lifecycle management.
 *
 * Handles token storage, automatic refresh before expiry,
 * JWT payload decoding, and extraction of user email and roles.
 */

import * as client from "openid-client";
import type { AuthConfig, RefreshContext } from "./types.js";

// Refresh tokens 5 minutes before expiry
const REFRESH_THRESHOLD_MS = 5 * 60 * 1000;

export class TokenManager {
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private expiresAt = 0;
  private tokenEndpoint: string | null = null;
  private _clientId: string | null = null;
  private _userEmail: string | null = null;
  private _roles: string[] = [];
  private oidcConfig: client.Configuration | null = null;
  private authConfig: AuthConfig | null = null;

  constructor(authConfig: AuthConfig | null) {
    this.authConfig = authConfig;
  }

  /**
   * Switch to a different auth configuration.
   * Clears all tokens and cached OIDC config so the next login
   * targets the new Keycloak instance.
   */
  updateAuthConfig(authConfig: AuthConfig | null): void {
    this.clearTokens();
    this.oidcConfig = null;
    this.authConfig = authConfig;
  }

  get userEmail(): string | null {
    return this._userEmail;
  }

  get roles(): string[] {
    return [...this._roles];
  }

  get expiresInMinutes(): number {
    if (!this.expiresAt) return 0;
    return Math.max(0, Math.floor((this.expiresAt - Date.now()) / 60_000));
  }

  isAuthenticated(): boolean {
    return this.accessToken !== null;
  }

  isTokenExpired(): boolean {
    if (!this.expiresAt) return false;
    return Date.now() >= this.expiresAt;
  }

  private needsRefresh(): boolean {
    if (!this.expiresAt) return false;
    return Date.now() + REFRESH_THRESHOLD_MS >= this.expiresAt;
  }

  storeTokens(
    accessToken: string,
    refreshToken: string | null,
    expiresIn: number,
    tokenEndpoint?: string,
    clientId?: string,
  ): void {
    this.accessToken = accessToken;
    this.refreshToken = refreshToken;
    this.expiresAt = Date.now() + expiresIn * 1000;

    if (tokenEndpoint) this.tokenEndpoint = tokenEndpoint;
    if (clientId) this._clientId = clientId;

    this._userEmail = this.extractEmail(accessToken);
    this._roles = this.extractRoles(accessToken);
  }

  async getAccessToken(): Promise<string> {
    if (!this.accessToken) {
      throw new Error("Not authenticated. Call auth_login first.");
    }

    if (this.needsRefresh()) {
      await this.refresh();
    }

    if (!this.accessToken) {
      throw new Error("Session expired. Please call auth_login again.");
    }

    return this.accessToken;
  }

  get refreshContext(): RefreshContext | null {
    if (!this.refreshToken || !this.tokenEndpoint || !this._clientId) {
      return null;
    }
    return {
      refreshToken: this.refreshToken,
      tokenEndpoint: this.tokenEndpoint,
      clientId: this._clientId,
    };
  }

  async tryStoredRefresh(context: RefreshContext): Promise<boolean> {
    this.refreshToken = context.refreshToken;
    this.tokenEndpoint = context.tokenEndpoint;
    this._clientId = context.clientId;
    try {
      await this.refresh();
      return true;
    } catch {
      this.clearTokens();
      return false;
    }
  }

  /**
   * Set a pre-obtained JWT token directly, bypassing the PKCE login flow.
   * No refresh is possible — once the token expires, re-login or a new token is needed.
   */
  setStaticToken(token: string): void {
    this.accessToken = token;
    this.refreshToken = null;
    this.tokenEndpoint = null;
    this._clientId = null;
    this._userEmail = this.extractEmail(token);
    this._roles = this.extractRoles(token);

    // Try to read expiry from the JWT; fall back to 1 hour if missing
    const claims = this.decodeJwtPayload(token);
    if (claims?.exp && typeof claims.exp === "number") {
      this.expiresAt = claims.exp * 1000;
    } else {
      this.expiresAt = Date.now() + 3600 * 1000;
    }
  }

  clearTokens(): void {
    this.accessToken = null;
    this.refreshToken = null;
    this.expiresAt = 0;
    this._userEmail = null;
    this._roles = [];
  }

  private async ensureOidcConfig(): Promise<client.Configuration> {
    if (this.oidcConfig) return this.oidcConfig;
    if (!this.authConfig) {
      throw new Error("No auth configuration available.");
    }

    const issuerUrl = new URL(
      `/realms/${this.authConfig.realm}`,
      this.authConfig.keycloakUrl,
    );

    this.oidcConfig = await client.discovery(
      issuerUrl,
      this.authConfig.clientId,
      undefined,
      client.None(),
    );

    return this.oidcConfig;
  }

  private async refresh(): Promise<void> {
    if (!this.refreshToken) {
      throw new Error("Session expired. Please call auth_login again.");
    }

    const oidcConfig = await this.ensureOidcConfig();

    try {
      const tokenSet = await client.refreshTokenGrant(oidcConfig, this.refreshToken);

      this.storeTokens(
        tokenSet.access_token,
        tokenSet.refresh_token ?? this.refreshToken,
        tokenSet.expires_in ?? 300,
      );
    } catch {
      this.clearTokens();
      throw new Error("Session expired. Please call auth_login again.");
    }
  }

  // --- JWT decoding ---

  private decodeJwtPayload(token: string): Record<string, unknown> | null {
    try {
      const parts = token.split(".");
      if (parts.length !== 3) return null;

      let payload = parts[1];
      // Add base64 padding if needed
      const padding = 4 - (payload.length % 4);
      if (padding !== 4) {
        payload += "=".repeat(padding);
      }

      const decoded = Buffer.from(payload, "base64url").toString("utf-8");
      return JSON.parse(decoded) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  private extractEmail(token: string): string | null {
    const claims = this.decodeJwtPayload(token);
    if (!claims) return null;

    const email = claims.email ?? claims.preferred_username;
    return typeof email === "string" ? email : null;
  }

  private extractRoles(token: string): string[] {
    const claims = this.decodeJwtPayload(token);
    if (!claims) return [];

    const roles: string[] = [];

    // Realm roles (Keycloak standard)
    const realmAccess = claims.realm_access as { roles?: string[] } | undefined;
    if (realmAccess?.roles) {
      roles.push(...realmAccess.roles);
    }

    // Client-specific roles
    const resourceAccess = claims.resource_access as
      | Record<string, { roles?: string[] }>
      | undefined;
    if (resourceAccess) {
      for (const access of Object.values(resourceAccess)) {
        if (access.roles) {
          roles.push(...access.roles);
        }
      }
    }

    // Deduplicate
    return [...new Set(roles)];
  }
}
