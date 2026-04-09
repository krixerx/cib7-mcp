/**
 * Persistent token storage at ~/.config/cib7-mcp/auth.json
 *
 * Stores refresh tokens and Keycloak config per-instance so users
 * don't need to re-login after restarting the MCP server.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AuthStoreData, AuthStoreInstance, RefreshContext } from "./types.js";

const AUTH_DIR = path.join(os.homedir(), ".config", "cib7-mcp");
const AUTH_FILE = path.join(AUTH_DIR, "auth.json");
const STORE_VERSION = 1;

function load(): AuthStoreData {
  try {
    if (fs.existsSync(AUTH_FILE)) {
      const raw = fs.readFileSync(AUTH_FILE, "utf-8");
      return JSON.parse(raw) as AuthStoreData;
    }
  } catch {
    // Corrupted file, start fresh
  }
  return { version: STORE_VERSION, instances: {} };
}

function save(data: AuthStoreData): void {
  fs.mkdirSync(AUTH_DIR, { recursive: true });

  // Atomic write: write to temp file, then rename
  const tmpFile = AUTH_FILE + ".tmp";
  fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmpFile, AUTH_FILE);
}

function getInstance(instanceId: string): AuthStoreInstance {
  const data = load();
  return data.instances[instanceId] ?? {};
}

function setInstance(instanceId: string, fields: Partial<AuthStoreInstance>): void {
  const data = load();
  data.instances[instanceId] = { ...(data.instances[instanceId] ?? {}), ...fields };
  data.version = STORE_VERSION;
  save(data);
}

export function getRefreshContext(instanceId: string): RefreshContext | null {
  const inst = getInstance(instanceId);
  if (inst.refreshToken && inst.tokenEndpoint && inst.clientId) {
    return {
      refreshToken: inst.refreshToken,
      tokenEndpoint: inst.tokenEndpoint,
      clientId: inst.clientId,
    };
  }
  return null;
}

export function storeRefreshContext(
  instanceId: string,
  context: RefreshContext,
  keycloakUrl?: string,
  keycloakRealm?: string,
): void {
  const fields: Partial<AuthStoreInstance> = {
    refreshToken: context.refreshToken,
    tokenEndpoint: context.tokenEndpoint,
    clientId: context.clientId,
  };
  if (keycloakUrl) fields.keycloakUrl = keycloakUrl;
  if (keycloakRealm) fields.keycloakRealm = keycloakRealm;
  setInstance(instanceId, fields);
}

export function deleteInstance(instanceId: string): void {
  const data = load();
  delete data.instances[instanceId];
  save(data);
}
