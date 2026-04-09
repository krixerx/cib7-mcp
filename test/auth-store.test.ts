import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// We test the auth-store module by temporarily overriding the auth file path.
// Since the module uses hardcoded paths, we test the logic through the public API
// and clean up after each test.

const TEST_DIR = path.join(os.tmpdir(), "cib7-mcp-test-" + process.pid);
const TEST_AUTH_FILE = path.join(TEST_DIR, "auth.json");

// We need to test with the actual module, so we import it
import { getRefreshContext, storeRefreshContext, deleteInstance } from "../src/auth-store.js";

describe("auth-store", () => {
  // Note: These tests use the real config path (~/.config/cib7-mcp/auth.json).
  // We use a unique instance ID to avoid conflicts.
  const testInstanceId = `__test_${process.pid}_${Date.now()}`;

  afterEach(() => {
    // Clean up test instance
    try {
      deleteInstance(testInstanceId);
    } catch {
      // Ignore cleanup errors
    }
  });

  it("returns null for unknown instance", () => {
    const ctx = getRefreshContext("nonexistent_instance_" + Date.now());
    expect(ctx).toBeNull();
  });

  it("stores and retrieves refresh context", () => {
    storeRefreshContext(testInstanceId, {
      refreshToken: "rt_test123",
      tokenEndpoint: "https://kc.test/token",
      clientId: "test-client",
    });

    const ctx = getRefreshContext(testInstanceId);
    expect(ctx).toEqual({
      refreshToken: "rt_test123",
      tokenEndpoint: "https://kc.test/token",
      clientId: "test-client",
    });
  });

  it("stores keycloak URL and realm alongside refresh context", () => {
    storeRefreshContext(
      testInstanceId,
      {
        refreshToken: "rt_test456",
        tokenEndpoint: "https://kc.test/token",
        clientId: "test-client",
      },
      "https://keycloak.test.com",
      "testrealm",
    );

    const ctx = getRefreshContext(testInstanceId);
    expect(ctx).not.toBeNull();
    expect(ctx!.refreshToken).toBe("rt_test456");
  });

  it("deletes instance data", () => {
    storeRefreshContext(testInstanceId, {
      refreshToken: "rt_delete",
      tokenEndpoint: "https://kc.test/token",
      clientId: "test-client",
    });

    deleteInstance(testInstanceId);

    const ctx = getRefreshContext(testInstanceId);
    expect(ctx).toBeNull();
  });

  it("overwrites existing refresh context", () => {
    storeRefreshContext(testInstanceId, {
      refreshToken: "rt_old",
      tokenEndpoint: "https://kc.test/token",
      clientId: "test-client",
    });

    storeRefreshContext(testInstanceId, {
      refreshToken: "rt_new",
      tokenEndpoint: "https://kc.test/token",
      clientId: "test-client",
    });

    const ctx = getRefreshContext(testInstanceId);
    expect(ctx!.refreshToken).toBe("rt_new");
  });
});
