import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Cib7Client } from "./cib7-client.js";
import { NotFoundError } from "./cib7-client.js";
import { diagnoseStuckProcess, incidentReport } from "./prompts.js";
import { performBrowserLogin, startBrowserLogin, getInstanceId } from "./auth.js";
import type { BrowserLoginSession } from "./auth.js";
import { deleteInstance, getRefreshContext, storeRefreshContext } from "./auth-store.js";
import { ensureAuthenticated } from "./permissions.js";
import type { TokenManager } from "./token-manager.js";
import type { AuthConfig, UserSession } from "./types.js";
import { checkForUpdates, performUpdate, type UpdateCheckResult } from "./updater.js";
import { registerResources } from "./resources.js";
import {
  projectActivityHistory,
  projectHistoricProcessInstances,
  projectIncidents,
  projectJobs,
} from "./projection.js";

/**
 * Mutable runtime configuration. Allows switching CIB7 and Keycloak
 * targets at runtime via the set_server tool.
 */
export interface RuntimeConfig {
  cib7Url: string;
  authConfig: AuthConfig | null;
}

function toolError(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

function toolResult(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
      },
    ],
  };
}

function formatPeriodLabel(date: Date, unit: "day" | "week" | "month"): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  if (unit === "month") return `${y}-${m}`;
  return `${y}-${m}-${d}`;
}

export function createServer(
  client: Cib7Client,
  tokenManager: TokenManager,
  runtimeConfig: RuntimeConfig,
): McpServer {
  const server = new McpServer({
    name: "cib7-mcp",
    version: "0.1.0",
  });

  // Helper: current instance ID for auth storage
  function currentInstanceId(): string {
    return runtimeConfig.authConfig ? getInstanceId(runtimeConfig.authConfig) : "";
  }

  // Holds an in-flight headless login so auth_wait can await it. Only one
  // headless login is tracked at a time; starting a new one replaces any
  // prior pending session.
  let pendingHeadlessLogin: BrowserLoginSession | null = null;

  // Helper: ensure auth before tool execution (no-op if unauthenticated mode)
  async function requireAuth(): Promise<void> {
    if (!runtimeConfig.authConfig) return; // Unauthenticated mode, skip
    await ensureAuthenticated(tokenManager, currentInstanceId());
  }

  // === AUTH TOOLS ===

  server.tool(
    "auth_login",
    `Authenticate with CIB Seven. Modes: \`token\` (pre-obtained JWT), \`interactive\` (default, opens browser and waits), \`headless\` (returns URL immediately, pair with auth_wait — for remote/SSH/containerised hosts). Call when any other tool returns "Not authenticated". See resource \`cib7://guide/auth\` for details.`,
    {
      token: z.string().optional().describe("A pre-obtained JWT access token. When provided, the token is used directly and the browser login flow is skipped."),
      headless: z.boolean().optional().describe("If true, do not open a local browser and return the authorization URL immediately without waiting for the callback. Pair with auth_wait."),
    },
    async ({ token, headless }) => {
      // Direct token mode — skip PKCE entirely
      if (token) {
        tokenManager.setStaticToken(token);
        return toolResult({
          success: true,
          mode: "static_token",
          message: `Authenticated as ${tokenManager.userEmail ?? "unknown user"} using provided token. Expires in ${tokenManager.expiresInMinutes} minutes. Note: automatic refresh is not available — provide a new token when this one expires.`,
          userEmail: tokenManager.userEmail,
          sessionExpiresInMinutes: tokenManager.expiresInMinutes,
          roles: tokenManager.roles,
        });
      }

      // PKCE browser login
      if (!runtimeConfig.authConfig) {
        return toolResult("Authentication is not configured. The server is running in unauthenticated mode. Use set_server to configure Keycloak, or set KEYCLOAK_URL, KEYCLOAK_REALM, and KEYCLOAK_CLIENT_ID environment variables.");
      }

      if (headless) {
        // Two-phase flow: return URL immediately, leave completion pending.
        // Tear down any previous pending session first.
        if (pendingHeadlessLogin) {
          pendingHeadlessLogin.completion.catch(() => {});
          pendingHeadlessLogin = null;
        }

        try {
          const session = await startBrowserLogin(
            runtimeConfig.authConfig,
            tokenManager,
            { openBrowser: false },
          );

          pendingHeadlessLogin = session;
          // Attach a no-op catcher so Node does not log an unhandled
          // rejection if auth_wait is never called (e.g. user gives up).
          session.completion.catch(() => {});

          return toolResult({
            success: true,
            mode: "headless_pending",
            message: "Login started. Open the authorizationUrl below in a browser to complete sign-in, then call auth_wait to block until the session is established. Auth will time out after 2 minutes.",
            authorizationUrl: session.authorizationUrl,
          });
        } catch (err) {
          return toolError(
            `Failed to start login: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      try {
        const result = await performBrowserLogin(runtimeConfig.authConfig, tokenManager);
        return toolResult({
          success: true,
          message: `Authenticated as ${result.userEmail}. Session valid for ${result.expiresInMinutes} minutes.`,
          userEmail: result.userEmail,
          sessionExpiresInMinutes: result.expiresInMinutes,
          roles: tokenManager.roles,
          authorizationUrl: result.authorizationUrl,
        });
      } catch (err) {
        return toolError(
          `Authentication failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  );

  server.tool(
    "auth_wait",
    `Block until a headless login started via auth_login(headless=true) completes. Fails if the login times out (2 min) or errors.`,
    {},
    async () => {
      if (!pendingHeadlessLogin) {
        return toolResult("No pending headless login. Call auth_login(headless=true) first to start one.");
      }
      const session = pendingHeadlessLogin;
      try {
        const result = await session.completion;
        pendingHeadlessLogin = null;
        return toolResult({
          success: true,
          message: `Authenticated as ${result.userEmail}. Session valid for ${result.expiresInMinutes} minutes.`,
          userEmail: result.userEmail,
          sessionExpiresInMinutes: result.expiresInMinutes,
          roles: tokenManager.roles,
        });
      } catch (err) {
        pendingHeadlessLogin = null;
        return toolError(
          `Authentication failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  );

  server.tool(
    "auth_status",
    `Check current authentication status: logged in, user email, session expiry, roles.`,
    {},
    async () => {
      if (!runtimeConfig.authConfig) {
        return toolResult({
          authenticated: true,
          mode: "unauthenticated",
          message: "Server running without authentication. All tools are available.",
          cib7Url: runtimeConfig.cib7Url,
        });
      }

      const session: UserSession = {
        authenticated: tokenManager.isAuthenticated() && !tokenManager.isTokenExpired(),
        userEmail: tokenManager.userEmail,
        roles: tokenManager.roles,
        expiresInMinutes: tokenManager.expiresInMinutes,
      };

      if (!session.authenticated) {
        return toolResult({
          ...session,
          cib7Url: runtimeConfig.cib7Url,
          keycloakUrl: runtimeConfig.authConfig.keycloakUrl,
          realm: runtimeConfig.authConfig.realm,
          message: "Not authenticated. Call auth_login to sign in.",
        });
      }

      return toolResult({
        ...session,
        cib7Url: runtimeConfig.cib7Url,
        keycloakUrl: runtimeConfig.authConfig.keycloakUrl,
        realm: runtimeConfig.authConfig.realm,
        message: `Authenticated as ${session.userEmail}. Session expires in ${session.expiresInMinutes} minutes.`,
      });
    },
  );

  server.tool(
    "auth_logout",
    `Sign out and clear all stored credentials (in-memory tokens and persisted refresh tokens).`,
    {},
    async () => {
      tokenManager.clearTokens();
      const instId = currentInstanceId();
      if (instId) {
        deleteInstance(instId);
      }
      return toolResult({ success: true, message: "Signed out. All tokens cleared." });
    },
  );

  // === SERVER CONFIGURATION ===

  server.tool(
    "set_server",
    `Switch the CIB Seven and Keycloak target at runtime without restart. Provide \`cib7Url\` plus all three Keycloak params for authenticated mode, or none for unauthenticated mode. Partial Keycloak config is rejected. See \`cib7://guide/auth\`.`,
    {
      cib7Url: z.string().describe("CIB Seven REST API URL (e.g., https://camunda.monentreprise.bj/rest)"),
      keycloakUrl: z.string().optional().describe("Keycloak server URL (e.g., https://login.monentreprise.bj)"),
      keycloakRealm: z.string().optional().describe("Keycloak realm name (e.g., BJ)"),
      keycloakClientId: z.string().optional().describe("Keycloak OIDC client ID (e.g., camunda)"),
    },
    async ({ cib7Url, keycloakUrl, keycloakRealm, keycloakClientId }) => {
      // Validate: all-or-nothing for Keycloak settings
      const hasAny = keycloakUrl || keycloakRealm || keycloakClientId;
      const hasAll = keycloakUrl && keycloakRealm && keycloakClientId;
      if (hasAny && !hasAll) {
        const missing = [];
        if (!keycloakUrl) missing.push("keycloakUrl");
        if (!keycloakRealm) missing.push("keycloakRealm");
        if (!keycloakClientId) missing.push("keycloakClientId");
        return toolError(
          `Incomplete Keycloak configuration. Missing: ${missing.join(", ")}. ` +
          `Provide all three (keycloakUrl, keycloakRealm, keycloakClientId) or none.`
        );
      }

      // Build new auth config
      const newAuthConfig: AuthConfig | null = hasAll
        ? { keycloakUrl: keycloakUrl!, realm: keycloakRealm!, clientId: keycloakClientId! }
        : null;

      // Apply changes
      runtimeConfig.cib7Url = cib7Url;
      runtimeConfig.authConfig = newAuthConfig;
      tokenManager.updateAuthConfig(newAuthConfig);

      // Try to restore session from stored refresh token
      let sessionRestored = false;
      if (newAuthConfig) {
        const instId = getInstanceId(newAuthConfig);
        const storedCtx = getRefreshContext(instId);
        if (storedCtx) {
          sessionRestored = await tokenManager.tryStoredRefresh(storedCtx);
        }
      }

      const result: Record<string, unknown> = {
        success: true,
        cib7Url,
        mode: newAuthConfig ? "authenticated" : "unauthenticated",
      };

      if (newAuthConfig) {
        result.keycloakUrl = newAuthConfig.keycloakUrl;
        result.realm = newAuthConfig.realm;
        result.clientId = newAuthConfig.clientId;
      }

      if (sessionRestored) {
        result.message = `Switched to ${cib7Url}. Session restored for ${tokenManager.userEmail}.`;
        result.userEmail = tokenManager.userEmail;
      } else if (newAuthConfig) {
        result.message = `Switched to ${cib7Url}. Call auth_login to authenticate against ${newAuthConfig.keycloakUrl}.`;
      } else {
        result.message = `Switched to ${cib7Url} (unauthenticated mode). All tools available without login.`;
      }

      return toolResult(result);
    },
  );

  // === UPDATE TOOLS ===

  server.tool(
    "check_for_updates",
    `Check if a newer version of cib7-mcp is available on GitHub. If an update is available, ask the user before calling self_update.`,
    {},
    async () => {
      const result = await checkForUpdates();
      if (result.error) {
        return toolResult({
          updateAvailable: false,
          currentVersion: result.currentVersion,
          message: result.error,
        });
      }
      if (result.updateAvailable) {
        return toolResult({
          updateAvailable: true,
          currentVersion: result.currentVersion,
          latestVersion: result.latestVersion,
          message: `Update available: ${result.currentVersion} → ${result.latestVersion}. Ask the user if they want to upgrade, then call self_update to apply.`,
        });
      }
      return toolResult({
        updateAvailable: false,
        currentVersion: result.currentVersion,
        latestVersion: result.latestVersion,
        message: `You are running the latest version (${result.currentVersion}).`,
      });
    },
  );

  server.tool(
    "self_update",
    `Update cib7-mcp to the latest version. Auto-detects npm vs git install. Server must be restarted after. **Always confirm with the user before calling this tool.**`,
    {},
    async () => {
      const result = await performUpdate();
      if (result.success) {
        return toolResult({
          success: true,
          previousVersion: result.previousVersion,
          newVersion: result.newVersion,
          message: result.message,
        });
      }
      return toolResult({
        success: false,
        message: result.message,
      });
    },
  );

  // === PROCESS TOOLS ===

  server.tool(
    "get_process_instance",
    `Look up a running process instance by ID. Runtime-only — completed/terminated instances return "not found"; use list_process_instances for history. See \`cib7://guide/diagnostics\` for response fields.`,
    { processInstanceId: z.string().describe("The UUID of the process instance") },
    async ({ processInstanceId }) => {
      try {
        await requireAuth();
        const result = await client.getProcessInstance(processInstanceId);
        return toolResult(result);
      } catch (err) {
        if (err instanceof NotFoundError) {
          return toolResult(`Process instance ${processInstanceId} not found in the runtime database. It may have already completed or been terminated. Use list_process_instances to check the history.`);
        }
        return toolError(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.tool(
    "list_process_instances",
    `Search historic process instances (covers running + completed via history API). Returns \`summary\` view by default — the shape hints how to fetch \`full\`. For COUNT questions use count_process_instances instead. See \`cib7://guide/querying\`.`,
    {
      processDefinitionKey: z.string().optional().describe("Filter by BPMN process definition key"),
      processDefinitionKeyIn: z.array(z.string()).optional().describe("Filter to multiple definition keys"),
      processDefinitionName: z.string().optional().describe("Filter by definition display name"),
      businessKey: z.string().optional().describe("Filter by business key"),
      startedBy: z.string().optional().describe("User ID that started the process"),
      active: z.boolean().optional().describe("Only active (running) instances"),
      suspended: z.boolean().optional().describe("Only suspended instances"),
      completed: z.boolean().optional().describe("Only completed instances"),
      startedAfter: z.string().optional().describe("Only instances started after this ISO-8601 datetime (e.g. 2025-03-01 or 2025-03-01T00:00:00.000+0000)"),
      startedBefore: z.string().optional().describe("Only instances started before this ISO-8601 datetime"),
      finishedAfter: z.string().optional().describe("Only instances finished after this ISO-8601 datetime"),
      finishedBefore: z.string().optional().describe("Only instances finished before this ISO-8601 datetime"),
      withIncidents: z.boolean().optional().describe("Only instances that currently have incidents"),
      incidentStatus: z.enum(["open", "resolved"]).optional().describe("Filter by incident status"),
      sortBy: z.enum(["instanceId", "definitionId", "definitionKey", "definitionName", "definitionVersion", "businessKey", "startTime", "endTime", "duration", "tenantId"]).optional().describe("Field to sort by"),
      sortOrder: z.enum(["asc", "desc"]).optional().describe("Sort direction"),
      maxResults: z.number().optional().describe("Max results to return (default 25)"),
      firstResult: z.number().optional().describe("Offset for pagination (default 0)"),
      view: z.enum(["summary", "full"]).optional().describe('Response shape. "summary" (default) keeps id, processDefinitionId, processDefinitionKey, businessKey, startTime, endTime, state. "full" returns every engine field.'),
    },
    async (params) => {
      try {
        await requireAuth();
        const { view, ...filters } = params;
        const rows = await client.listProcessInstances(filters);
        return toolResult(projectHistoricProcessInstances(rows, view ?? "summary"));
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.tool(
    "count_process_instances",
    `Count historic process instances matching filters. Cheap — returns a number, no row fetch. Same filter surface as list_process_instances. For day/week/month histograms use process_instance_stats. See \`cib7://guide/querying\`.`,
    {
      processDefinitionKey: z.string().optional().describe("Filter by BPMN process definition key"),
      processDefinitionKeyIn: z.array(z.string()).optional().describe("Filter to multiple definition keys"),
      processDefinitionName: z.string().optional().describe("Filter by definition display name"),
      businessKey: z.string().optional().describe("Filter by business key"),
      startedBy: z.string().optional().describe("User ID that started the process"),
      active: z.boolean().optional().describe("Only active (running) instances"),
      suspended: z.boolean().optional().describe("Only suspended instances"),
      completed: z.boolean().optional().describe("Only completed instances"),
      startedAfter: z.string().optional().describe("Only instances started after this ISO-8601 datetime"),
      startedBefore: z.string().optional().describe("Only instances started before this ISO-8601 datetime"),
      finishedAfter: z.string().optional().describe("Only instances finished after this ISO-8601 datetime"),
      finishedBefore: z.string().optional().describe("Only instances finished before this ISO-8601 datetime"),
      withIncidents: z.boolean().optional().describe("Only instances that currently have incidents"),
      incidentStatus: z.enum(["open", "resolved"]).optional().describe("Filter by incident status"),
    },
    async (params) => {
      try {
        await requireAuth();
        const count = await client.countProcessInstances(params);
        return toolResult({ count });
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.tool(
    "process_instance_stats",
    `Histogram of started process instances over a date range, bucketed by day/week/month. Returns per-period counts + summary (total, average, max, min bucket). Cheap — loops count_process_instances internally. See \`cib7://guide/querying\` for window semantics (right-open, not Monday-aligned).`,
    {
      from: z.string().describe("Start of range. ISO-8601 date or datetime (e.g. 2025-01-01 or 2025-01-01T00:00:00.000Z)"),
      to: z.string().describe("End of range, exclusive. ISO-8601 date or datetime"),
      periodUnit: z.enum(["day", "week", "month"]).describe("Bucket size"),
      processDefinitionKey: z.string().optional().describe("Filter by BPMN process definition key"),
      processDefinitionKeyIn: z.array(z.string()).optional().describe("Filter to multiple definition keys"),
      active: z.boolean().optional().describe("Only count active instances"),
      completed: z.boolean().optional().describe("Only count completed instances"),
      withIncidents: z.boolean().optional().describe("Only count instances with incidents"),
      maxBuckets: z.number().optional().describe("Safety cap on number of buckets (default 500). Prevents runaway queries."),
    },
    async (params) => {
      try {
        await requireAuth();
        const fromDate = new Date(params.from);
        const toDate = new Date(params.to);
        if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
          return toolError("Invalid from/to date. Use ISO-8601 (e.g. 2025-01-01 or 2025-01-01T00:00:00.000Z).");
        }
        if (fromDate >= toDate) {
          return toolError("'from' must be strictly before 'to'.");
        }

        const buckets: Array<{ start: Date; end: Date }> = [];
        const maxBuckets = params.maxBuckets ?? 500;
        let cursor = new Date(fromDate);
        while (cursor < toDate) {
          const next = new Date(cursor);
          if (params.periodUnit === "day") {
            next.setUTCDate(next.getUTCDate() + 1);
          } else if (params.periodUnit === "week") {
            next.setUTCDate(next.getUTCDate() + 7);
          } else {
            next.setUTCMonth(next.getUTCMonth() + 1);
          }
          const end = next > toDate ? new Date(toDate) : new Date(next);
          buckets.push({ start: new Date(cursor), end });
          cursor = next;
          if (buckets.length > maxBuckets) {
            return toolError(
              `Range produces more than ${maxBuckets} buckets. Narrow the range, use a coarser periodUnit, or raise maxBuckets.`
            );
          }
        }

        const baseFilter: Record<string, unknown> = {};
        if (params.processDefinitionKey) baseFilter.processDefinitionKey = params.processDefinitionKey;
        if (params.processDefinitionKeyIn) baseFilter.processDefinitionKeyIn = params.processDefinitionKeyIn;
        if (params.active !== undefined) baseFilter.active = params.active;
        if (params.completed !== undefined) baseFilter.completed = params.completed;
        if (params.withIncidents !== undefined) baseFilter.withIncidents = params.withIncidents;

        const concurrency = 8;
        const results: Array<{ period: string; start: string; end: string; count: number }> = new Array(buckets.length);
        let index = 0;
        async function worker(): Promise<void> {
          while (true) {
            const i = index++;
            if (i >= buckets.length) return;
            const b = buckets[i];
            const count = await client.countProcessInstances({
              ...baseFilter,
              startedAfter: b.start.toISOString(),
              startedBefore: b.end.toISOString(),
            });
            results[i] = {
              period: formatPeriodLabel(b.start, params.periodUnit),
              start: b.start.toISOString(),
              end: b.end.toISOString(),
              count,
            };
          }
        }
        await Promise.all(Array.from({ length: Math.min(concurrency, buckets.length) }, () => worker()));

        const counts = results.map((r) => r.count);
        const total = counts.reduce((a, b) => a + b, 0);
        const maxIdx = counts.indexOf(Math.max(...counts));
        const minIdx = counts.indexOf(Math.min(...counts));

        return toolResult({
          from: fromDate.toISOString(),
          to: toDate.toISOString(),
          periodUnit: params.periodUnit,
          bucketCount: results.length,
          summary: {
            total,
            average: results.length > 0 ? Math.round((total / results.length) * 100) / 100 : 0,
            max: results.length > 0 ? { period: results[maxIdx].period, count: counts[maxIdx] } : null,
            min: results.length > 0 ? { period: results[minIdx].period, count: counts[minIdx] } : null,
          },
          periods: results,
        });
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.tool(
    "list_incidents",
    `List open incidents in the process engine. Filter by processInstanceId or incidentType (\`failedJob\`, \`failedExternalTask\`). Call without filters to see all. Returns \`summary\` view by default. See \`cib7://guide/diagnostics\`.`,
    {
      processInstanceId: z.string().optional().describe("Filter by process instance ID"),
      incidentType: z.string().optional().describe("Filter by type: failedJob, failedExternalTask"),
      maxResults: z.string().optional().describe("Max results (default 25)"),
      firstResult: z.string().optional().describe("Offset for pagination (default 0)"),
      view: z.enum(["summary", "full"]).optional().describe('Response shape. "summary" (default) keeps id, processInstanceId, incidentTimestamp, incidentType, activityId, incidentMessage. "full" returns every engine field.'),
    },
    async (params) => {
      try {
        await requireAuth();
        const queryParams: Record<string, string> = {};
        if (params.processInstanceId) queryParams.processInstanceId = params.processInstanceId;
        if (params.incidentType) queryParams.incidentType = params.incidentType;
        if (params.maxResults) queryParams.maxResults = params.maxResults;
        if (params.firstResult) queryParams.firstResult = params.firstResult;
        const rows = await client.listIncidents(queryParams);
        return toolResult(projectIncidents(rows, params.view ?? "summary"));
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.tool(
    "get_activity_history",
    `Get the execution trace for a process instance — every activity that ran, in order. Activities with a \`startTime\` but no \`endTime\` are where the process is currently waiting. Returns \`summary\` view by default. See \`cib7://guide/diagnostics\`.`,
    {
      processInstanceId: z.string().describe("The process instance ID to trace"),
      view: z.enum(["summary", "full"]).optional().describe('Response shape. "summary" (default) keeps activityId, activityName, activityType, startTime, endTime, durationInMillis, canceled. "full" returns every engine field.'),
    },
    async ({ processInstanceId, view }) => {
      try {
        await requireAuth();
        const rows = await client.getActivityHistory(processInstanceId);
        return toolResult(projectActivityHistory(rows, view ?? "summary"));
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.tool(
    "get_process_variables",
    `Get all variables for a process instance. Sensitive values may be redacted as \`[REDACTED]\`. See \`cib7://guide/diagnostics\` for what to look for when diagnosing stuck processes.`,
    {
      processInstanceId: z.string().describe("The process instance ID"),
    },
    async ({ processInstanceId }) => {
      try {
        await requireAuth();
        const result = await client.getProcessVariables(processInstanceId);
        return toolResult(result);
      } catch (err) {
        if (err instanceof NotFoundError) {
          return toolResult(`Process instance ${processInstanceId} not found.`);
        }
        return toolError(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.tool(
    "get_process_definition_xml",
    `Fetch the BPMN XML model for a process definition — the blueprint showing the expected flow. Use the \`definitionId\` from get_process_instance. Diagram layout is stripped. See \`cib7://guide/diagnostics\`.`,
    {
      processDefinitionId: z.string().describe("The process definition ID (from definitionId field of a process instance)"),
    },
    async ({ processDefinitionId }) => {
      try {
        await requireAuth();
        const result = await client.getProcessDefinitionXml(processDefinitionId);
        return toolResult(result.bpmn20Xml);
      } catch (err) {
        if (err instanceof NotFoundError) {
          return toolResult(`Process definition ${processDefinitionId} not found.`);
        }
        return toolError(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.tool(
    "get_job_details",
    `Get job execution details. Jobs are units of work the engine executes (service tasks, timers, message events). \`retries=0\` means the engine gave up and an incident was created. Returns \`summary\` view by default. See \`cib7://guide/diagnostics\`.`,
    {
      processInstanceId: z.string().optional().describe("Filter jobs by process instance ID"),
      maxResults: z.string().optional().describe("Max results (default 25)"),
      firstResult: z.string().optional().describe("Offset for pagination (default 0)"),
      view: z.enum(["summary", "full"]).optional().describe('Response shape. "summary" (default) keeps id, processInstanceId, exceptionMessage, retries, dueDate, suspended, createTime. "full" returns every engine field.'),
    },
    async (params) => {
      try {
        await requireAuth();
        const queryParams: Record<string, string> = {};
        if (params.processInstanceId) queryParams.processInstanceId = params.processInstanceId;
        if (params.maxResults) queryParams.maxResults = params.maxResults;
        if (params.firstResult) queryParams.firstResult = params.firstResult;
        const rows = await client.getJobs(queryParams);
        return toolResult(projectJobs(rows, params.view ?? "summary"));
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    }
  );

  // === PROMPTS ===

  server.prompt(
    "diagnose_stuck_process",
    "Step-by-step diagnostic workflow for a process instance that appears stuck or stalled. Guides you through checking state, tracing execution, inspecting incidents and variables.",
    { processInstanceId: z.string().describe("The process instance ID to diagnose") },
    ({ processInstanceId }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: diagnoseStuckProcess(processInstanceId),
          },
        },
      ],
    })
  );

  server.prompt(
    "incident_report",
    "Generate a comprehensive report of all open incidents with affected processes, root cause analysis, and recommended actions.",
    {},
    () => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: incidentReport(),
          },
        },
      ],
    })
  );

  // === RESOURCES ===

  registerResources(server);

  return server;
}
