import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const TEST_DIR = path.join(os.tmpdir(), "cib7-mcp-test-" + process.pid);

// Point the auth store at our temp directory before importing
process.env.CIB7_AUTH_DIR = TEST_DIR;

import { getRefreshContext, storeRefreshContext, deleteInstance } from "../src/auth-store.js";

describe("auth-store", () => {
  const testInstanceId = `__test_${process.pid}_${Date.now()}`;

  beforeEach(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    // Remove the entire temp directory
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
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
