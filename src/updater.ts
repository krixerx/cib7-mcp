import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const GITHUB_REPO = "krixerx/cib7-mcp";
const GITHUB_RAW_URL = `https://raw.githubusercontent.com/${GITHUB_REPO}/master/package.json`;

export interface UpdateCheckResult {
  updateAvailable: boolean;
  currentVersion: string;
  latestVersion: string | null;
  error?: string;
}

export interface UpdateResult {
  success: boolean;
  previousVersion: string;
  newVersion: string;
  message: string;
}

/**
 * Get the project root directory (parent of dist/).
 */
function getProjectRoot(): string {
  const thisFile = fileURLToPath(import.meta.url);
  // In dist/updater.js, so project root is one level up
  return resolve(dirname(thisFile), "..");
}

/**
 * Read the local package.json version.
 */
function getLocalVersion(): string {
  const pkgPath = resolve(getProjectRoot(), "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  return pkg.version;
}

/**
 * Fetch the latest version from GitHub (raw package.json from master).
 */
async function fetchLatestVersion(): Promise<string> {
  const response = await fetch(GITHUB_RAW_URL);
  if (!response.ok) {
    throw new Error(`GitHub fetch failed: ${response.status} ${response.statusText}`);
  }
  const pkg = await response.json();
  return pkg.version;
}

/**
 * Check if the local installation is a git repo (can be updated via git pull).
 */
function isGitRepo(): boolean {
  return existsSync(resolve(getProjectRoot(), ".git"));
}

/**
 * Check if an update is available by comparing local vs remote version.
 */
export async function checkForUpdates(): Promise<UpdateCheckResult> {
  const currentVersion = getLocalVersion();
  try {
    const latestVersion = await fetchLatestVersion();
    const updateAvailable = latestVersion !== currentVersion;
    return { updateAvailable, currentVersion, latestVersion };
  } catch (err) {
    return {
      updateAvailable: false,
      currentVersion,
      latestVersion: null,
      error: `Could not check for updates: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Check if the package was installed via npm (globally or via npx).
 */
function isNpmInstall(): boolean {
  const projectRoot = getProjectRoot();
  // npm installs have node_modules/.package-lock.json or live inside a global node_modules
  // A git clone has .git; an npm install does not and typically lacks src/
  return !isGitRepo() && !existsSync(resolve(projectRoot, "src"));
}

/**
 * Perform the update. Detects the installation method and uses the
 * appropriate strategy:
 * - Git clone: git pull + npm install + npm run build
 * - npm global install: npm update -g cib7-mcp
 * Returns result with instructions to restart.
 */
export async function performUpdate(): Promise<UpdateResult> {
  const projectRoot = getProjectRoot();
  const previousVersion = getLocalVersion();

  if (isNpmInstall()) {
    // npm-installed: use npm to update
    try {
      console.error("[updater] Updating via npm...");
      execSync("npm install -g cib7-mcp@latest", { stdio: "pipe", timeout: 120000 });

      const newVersion = getLocalVersion();
      return {
        success: true,
        previousVersion,
        newVersion,
        message:
          `Updated from ${previousVersion} to ${newVersion} via npm. ` +
          "The MCP server must be restarted for changes to take effect. " +
          "Please restart the MCP server (close and reopen your AI assistant, or restart the MCP client).",
      };
    } catch (err) {
      return {
        success: false,
        previousVersion,
        newVersion: previousVersion,
        message:
          `npm update failed: ${err instanceof Error ? err.message : String(err)}. ` +
          `You can update manually by running: npm install -g cib7-mcp@latest`,
      };
    }
  }

  if (!isGitRepo()) {
    return {
      success: false,
      previousVersion,
      newVersion: previousVersion,
      message:
        "Cannot determine installation method. Update manually with one of:\n" +
        "- npm install -g cib7-mcp@latest (if installed via npm)\n" +
        `- git clone https://github.com/${GITHUB_REPO} && npm install && npm run build (for development)`,
    };
  }

  try {
    // Step 1: git pull
    console.error("[updater] Pulling latest changes from GitHub...");
    execSync("git pull origin master", { cwd: projectRoot, stdio: "pipe", timeout: 30000 });

    // Step 2: npm install
    console.error("[updater] Installing dependencies...");
    execSync("npm install", { cwd: projectRoot, stdio: "pipe", timeout: 120000 });

    // Step 3: npm run build
    console.error("[updater] Building...");
    execSync("npm run build", { cwd: projectRoot, stdio: "pipe", timeout: 60000 });

    const newVersion = getLocalVersion();

    return {
      success: true,
      previousVersion,
      newVersion,
      message:
        `Updated from ${previousVersion} to ${newVersion}. ` +
        "The MCP server must be restarted for changes to take effect. " +
        "Please restart the MCP server (close and reopen your AI assistant, or restart the MCP client).",
    };
  } catch (err) {
    return {
      success: false,
      previousVersion,
      newVersion: previousVersion,
      message: `Update failed: ${err instanceof Error ? err.message : String(err)}. The server is still running on version ${previousVersion}.`,
    };
  }
}

/**
 * Non-blocking startup check. Logs to stderr if an update is available.
 * Returns the check result for use by the server.
 */
export async function startupUpdateCheck(): Promise<UpdateCheckResult> {
  try {
    const result = await checkForUpdates();
    if (result.updateAvailable) {
      console.error(
        `[cib7-mcp] Update available: ${result.currentVersion} → ${result.latestVersion}. ` +
        `Use the check_for_updates or self_update tool to upgrade.`,
      );
    }
    return result;
  } catch {
    // Silent failure on startup — don't block the server
    return { updateAvailable: false, currentVersion: "unknown", latestVersion: null };
  }
}
