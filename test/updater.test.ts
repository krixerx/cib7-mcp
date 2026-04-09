import { describe, it, expect, vi, beforeEach } from "vitest";
import { checkForUpdates } from "../src/updater.js";

describe("checkForUpdates", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("detects when an update is available", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ version: "99.0.0" }),
    } as Response);

    const result = await checkForUpdates();
    expect(result.updateAvailable).toBe(true);
    expect(result.latestVersion).toBe("99.0.0");
    expect(result.currentVersion).toBeTruthy();
  });

  it("reports no update when versions match", async () => {
    // Read the actual local version to match
    const { readFileSync } = await import("node:fs");
    const { resolve, dirname } = await import("node:path");
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf-8"));

    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ version: pkg.version }),
    } as Response);

    const result = await checkForUpdates();
    expect(result.updateAvailable).toBe(false);
    expect(result.currentVersion).toBe(pkg.version);
    expect(result.latestVersion).toBe(pkg.version);
  });

  it("returns error when GitHub is unreachable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network error"));

    const result = await checkForUpdates();
    expect(result.updateAvailable).toBe(false);
    expect(result.error).toContain("Could not check for updates");
    expect(result.latestVersion).toBeNull();
  });

  it("returns error on non-200 response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
    } as Response);

    const result = await checkForUpdates();
    expect(result.updateAvailable).toBe(false);
    expect(result.error).toContain("GitHub fetch failed");
    expect(result.latestVersion).toBeNull();
  });
});
