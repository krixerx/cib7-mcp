#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createAuthProvider, parseAuthConfig } from "./auth.js";
import { createCib7Client } from "./cib7-client.js";
import { createRedactor } from "./redaction.js";
import { createServer } from "./server.js";

// Node version check
const [major] = process.versions.node.split(".").map(Number);
if (major < 18) {
  console.error(
    `cib7-mcp requires Node.js 18 or later. You are running Node.js ${process.versions.node}.`
  );
  process.exit(1);
}

async function main() {
  // Parse configuration from environment
  const cib7Url = process.env.CIB7_URL;
  if (!cib7Url) {
    console.error(
      "CIB7_URL environment variable is required. Set it to your CIB Seven REST API URL (e.g., http://localhost:6009/rest)."
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

  const authProvider = createAuthProvider(authConfig);
  const client = createCib7Client(cib7Url, authProvider, redactor);
  const server = createServer(client);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error(
    `cib7-mcp started. Connected to ${cib7Url}${authConfig ? " (Keycloak auth)" : " (unauthenticated)"}`
  );
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
