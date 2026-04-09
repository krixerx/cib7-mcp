#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { parseAuthConfig, getInstanceId } from "./auth.js";
import { getRefreshContext } from "./auth-store.js";
import { createCib7Client } from "./cib7-client.js";
import { createRedactor } from "./redaction.js";
import { createServer, type RuntimeConfig } from "./server.js";
import { TokenManager } from "./token-manager.js";

// Node version check
const [major] = process.versions.node.split(".").map(Number);
if (major < 18) {
  console.error(
    `cib7-mcp requires Node.js 18 or later. You are running Node.js ${process.versions.node}.`,
  );
  process.exit(1);
}

async function main() {
  // Parse configuration from environment
  const cib7Url = process.env.CIB7_URL;
  if (!cib7Url) {
    console.error(
      "CIB7_URL environment variable is required. Set it to your CIB Seven REST API URL (e.g., http://localhost:6009/rest).",
    );
    process.exit(1);
  }

  // Auth config (optional — if not set, runs unauthenticated)
  let authConfig;
  try {
    authConfig = parseAuthConfig();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  // Redaction config (optional)
  let redactor;
  try {
    redactor = createRedactor(process.env.CIB7_REDACT_PATTERNS);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  // Mutable runtime config — set_server tool can change these at runtime
  const runtimeConfig: RuntimeConfig = {
    cib7Url,
    authConfig,
  };

  // Token manager (handles in-memory tokens + auto-refresh)
  const tokenManager = new TokenManager(authConfig);

  // Try to restore session from stored refresh token
  if (authConfig) {
    const instanceId = getInstanceId(authConfig);
    const storedCtx = getRefreshContext(instanceId);
    if (storedCtx) {
      const restored = await tokenManager.tryStoredRefresh(storedCtx);
      if (restored) {
        console.error(`Session restored for ${tokenManager.userEmail}`);
      }
    }
  }

  // Auth provider adapter for the HTTP client
  const authProvider = {
    async getToken(): Promise<string | null> {
      if (!runtimeConfig.authConfig) return null;
      if (!tokenManager.isAuthenticated()) return null;
      try {
        return await tokenManager.getAccessToken();
      } catch {
        return null;
      }
    },
    invalidateToken(): void {
      // Don't clear tokens on 401 - let ensureAuthenticated handle refresh
    },
  };

  // Client uses a getter so it picks up URL changes from set_server
  const client = createCib7Client(() => runtimeConfig.cib7Url, authProvider, redactor);
  const server = createServer(client, tokenManager, runtimeConfig);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error(
    `cib7-mcp started. Connected to ${cib7Url}${authConfig ? " (Keycloak PKCE auth)" : " (unauthenticated)"}`,
  );
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
