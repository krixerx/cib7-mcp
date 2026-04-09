import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Cib7Client } from "./cib7-client.js";
import { NotFoundError } from "./cib7-client.js";
import { diagnoseStuckProcess, incidentReport } from "./prompts.js";
import { performBrowserLogin, getInstanceId } from "./auth.js";
import { deleteInstance, getRefreshContext, storeRefreshContext } from "./auth-store.js";
import { ensureAuthenticated } from "./permissions.js";
import type { TokenManager } from "./token-manager.js";
import type { AuthConfig, UserSession } from "./types.js";
import { checkForUpdates, performUpdate, type UpdateCheckResult } from "./updater.js";

/**
 * Mutable runtime configuration. Allows switching CIB7 and Keycloak
 * targets at runtime via the set_server tool.
 */
export interface RuntimeConfig {
  cib7Url: string;
  authConfig: AuthConfig | null;
}

const API_REFERENCE = `# CIB Seven REST API Reference (Supported Endpoints)

## Process Instances
- \`GET /process-instance/{id}\` — Get a single process instance by ID
  - Returns: id, definitionId, businessKey, ended, suspended
- \`POST /history/process-instance\` — Search historic process instances with JSON body filters
  - Filters: processDefinitionKey, businessKey, active, suspended, completed
  - Pagination: maxResults, firstResult query params

## Incidents
- \`GET /incident\` — List open incidents
  - Query params: processInstanceId, incidentType, maxResults, firstResult
  - incidentType values: failedJob, failedExternalTask

## Activity History
- \`GET /history/activity-instance\` — Get execution trace for a process instance
  - Query params: processInstanceId, sortBy=startTime, sortOrder=asc
  - Activities with startTime but no endTime are currently waiting

## Process Variables
- \`GET /process-instance/{id}/variables\` — Get all variables for a process instance
  - Returns map of variable name to {value, type, valueInfo}
  - Sensitive values may be redacted

## Process Definitions
- \`GET /process-definition/{id}/xml\` — Get BPMN XML for a process definition
  - Returns: id, bpmn20Xml (diagram elements stripped for readability)

## Jobs
- \`GET /job\` — List jobs (service task executions)
  - Query params: processInstanceId, maxResults, firstResult
  - Key fields: retries (0 = engine stopped retrying), exceptionMessage
`;

const CONCEPTS = `# CIB Seven Operational Concepts

## Process Instance States
- **ACTIVE** — Running normally, executing activities
- **SUSPENDED** — Manually paused by an operator. No activities execute until resumed.
- **COMPLETED** — All activities finished normally
- **EXTERNALLY_TERMINATED** — Cancelled by an operator or API call

## Incidents
An incident records that something went wrong during process execution.
- **failedJob** — A service task, timer, or other job threw an exception. The engine retried (default 3 times) and gave up. The process is stuck at this activity until the incident is resolved.
- **failedExternalTask** — An external task worker reported a failure.

## Jobs and Retries
Jobs are units of work the engine executes (service tasks, timers, etc.).
- **retries > 0** — Engine will retry the job automatically
- **retries = 0** — Engine gave up. An incident was created. Manual intervention needed.
- **exceptionMessage** — The error from the last failed execution attempt

## Activities
Activities are the steps in a BPMN process (tasks, gateways, events).
- An activity with \`startTime\` but no \`endTime\` is currently executing or waiting.
- \`activityType\` values: startEvent, endEvent, userTask, serviceTask, exclusiveGateway, parallelGateway, callActivity, etc.

## Business Key
A domain-level identifier for a process instance (e.g., order number, case ID). More meaningful than the internal UUID. Set when the process starts.

## Process Definition vs Instance
- **Definition** — The BPMN model (the blueprint). Has a key, version, and deployment.
- **Instance** — A running execution of a definition. Has an ID, state, and variables.
`;

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

  // Helper: ensure auth before tool execution (no-op if unauthenticated mode)
  async function requireAuth(): Promise<void> {
    if (!runtimeConfig.authConfig) return; // Unauthenticated mode, skip
    await ensureAuthenticated(tokenManager, currentInstanceId());
  }

  // === AUTH TOOLS ===

  server.tool(
    "auth_login",
    `Authenticate with CIB Seven. Two modes:
- If a JWT token is provided, it is used directly (no browser login needed).
- Otherwise, opens the default browser to the Keycloak login page for PKCE authentication.

Call this tool when any other tool returns "Not authenticated. Call auth_login first."`,
    {
      token: z.string().optional().describe("A pre-obtained JWT access token. When provided, the token is used directly and the browser login flow is skipped."),
    },
    async ({ token }) => {
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

      try {
        const result = await performBrowserLogin(runtimeConfig.authConfig, tokenManager);
        return toolResult({
          success: true,
          message: `Authenticated as ${result.userEmail}. Session valid for ${result.expiresInMinutes} minutes.`,
          userEmail: result.userEmail,
          sessionExpiresInMinutes: result.expiresInMinutes,
          roles: tokenManager.roles,
        });
      } catch (err) {
        return toolError(
          `Authentication failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  );

  server.tool(
    "auth_status",
    `Check current authentication status. Shows whether you are logged in, your user email, session expiry, and assigned roles.`,
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
    `Sign out and clear all stored credentials. Removes both in-memory tokens and persisted refresh tokens.`,
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
    `Switch the CIB Seven and Keycloak target at runtime — no restart needed.

Provide the CIB Seven REST API URL and optionally the Keycloak authentication settings. If Keycloak settings are provided, you will need to call auth_login afterwards to authenticate against the new server.

If Keycloak settings are omitted, the server switches to unauthenticated mode.

Examples:
- Switch to Benin production: set_server(cib7Url="https://camunda.monentreprise.bj/rest", keycloakUrl="https://login.monentreprise.bj", keycloakRealm="BJ", keycloakClientId="camunda")
- Switch to local dev: set_server(cib7Url="http://localhost:6009/rest")`,
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
    `Check if a newer version of cib7-mcp is available on GitHub.

Compares the locally installed version against the latest version on the master branch of https://github.com/krixerx/cib7-mcp.

If an update is available, ask the user if they want to upgrade using the self_update tool.`,
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
    `Update cib7-mcp to the latest version from GitHub.

This will:
1. Pull the latest code from https://github.com/krixerx/cib7-mcp
2. Install dependencies (npm install)
3. Rebuild the project (npm run build)

After a successful update, the MCP server must be restarted for changes to take effect.
Always ask the user for confirmation before calling this tool.`,
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
    `Look up a CIB Seven process instance by its ID. Returns the instance's current state, definition reference, business key, and suspension status.

Use this when you have a specific process instance ID and need to understand its current state. If you only have a business key or definition key, use list_process_instances instead.

Key response fields:
- suspended: true means manually paused by an operator
- ended: true means the process completed or was cancelled
- businessKey: the domain identifier (e.g. order number, case ID)
- definitionId: use this to fetch the BPMN XML via get_process_definition_xml`,
    { processInstanceId: z.string().describe("The UUID of the process instance") },
    async ({ processInstanceId }) => {
      try {
        await requireAuth();
        const result = await client.getProcessInstance(processInstanceId);
        return toolResult(result);
      } catch (err) {
        if (err instanceof NotFoundError) {
          return toolResult(`Process instance ${processInstanceId} not found. Verify the ID is correct and the instance hasn't been deleted from history.`);
        }
        return toolError(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.tool(
    "list_process_instances",
    `Search for process instances using filters. Uses the history API to find both running and completed instances.

Use this when you need to find process instances by business key, definition key, or state. Returns an array of historic process instances.

Filter options:
- processDefinitionKey: the BPMN process ID (e.g., "orderProcess")
- businessKey: domain identifier (e.g., "ORDER-12345")
- state: ACTIVE, COMPLETED, SUSPENDED, or EXTERNALLY_TERMINATED
- maxResults: limit results (default 25)
- firstResult: offset for pagination`,
    {
      processDefinitionKey: z.string().optional().describe("Filter by BPMN process definition key"),
      businessKey: z.string().optional().describe("Filter by business key"),
      active: z.boolean().optional().describe("Only active (running) instances"),
      suspended: z.boolean().optional().describe("Only suspended instances"),
      completed: z.boolean().optional().describe("Only completed instances"),
      maxResults: z.number().optional().describe("Max results to return (default 25)"),
      firstResult: z.number().optional().describe("Offset for pagination (default 0)"),
    },
    async (params) => {
      try {
        await requireAuth();
        const result = await client.listProcessInstances(params);
        return toolResult(result);
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.tool(
    "list_incidents",
    `List open incidents in the process engine. Incidents record things that went wrong during execution.

Key incident types:
- failedJob: a service task or timer threw an exception and the engine gave up retrying (retries=0)
- failedExternalTask: an external task worker reported a failure

Use without filters to see all open incidents. Filter by processInstanceId to see incidents for a specific process.`,
    {
      processInstanceId: z.string().optional().describe("Filter by process instance ID"),
      incidentType: z.string().optional().describe("Filter by type: failedJob, failedExternalTask"),
      maxResults: z.string().optional().describe("Max results (default 25)"),
      firstResult: z.string().optional().describe("Offset for pagination (default 0)"),
    },
    async (params) => {
      try {
        await requireAuth();
        const queryParams: Record<string, string> = {};
        if (params.processInstanceId) queryParams.processInstanceId = params.processInstanceId;
        if (params.incidentType) queryParams.incidentType = params.incidentType;
        if (params.maxResults) queryParams.maxResults = params.maxResults;
        if (params.firstResult) queryParams.firstResult = params.firstResult;
        const result = await client.listIncidents(queryParams);
        return toolResult(result);
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.tool(
    "get_activity_history",
    `Get the execution trace for a process instance — every activity that ran, in order.

This shows you exactly what happened: which tasks executed, in what order, and how long each took. Activities with a startTime but no endTime are currently executing or waiting.

Key fields:
- activityType: startEvent, serviceTask, userTask, exclusiveGateway, etc.
- activityName: human-readable name from the BPMN model
- startTime/endTime: when the activity started and finished
- durationInMillis: how long it took (null if still running)
- canceled: true if the activity was interrupted`,
    {
      processInstanceId: z.string().describe("The process instance ID to trace"),
    },
    async ({ processInstanceId }) => {
      try {
        await requireAuth();
        const result = await client.getActivityHistory(processInstanceId);
        return toolResult(result);
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    }
  );

  server.tool(
    "get_process_variables",
    `Get all variables for a process instance. Variables hold the data that drives process execution — form inputs, API responses, decision results.

Sensitive variable values may be redacted (shown as [REDACTED]) based on configured patterns.

Common variable patterns:
- Error flags or status fields that indicate why a process is waiting
- Retry counters that show how many times something was attempted
- Input data from forms or API calls`,
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
    `Fetch the BPMN XML model for a process definition. This is the blueprint — it shows the expected flow of the process.

Use the definitionId from get_process_instance to fetch the model. The XML includes all activities, gateways, sequence flows, and conditions. Diagram layout elements are stripped for readability.

Read the XML to understand:
- The expected happy path (sequence of activities)
- Gateway conditions (what determines which path is taken)
- Error boundary events (what happens when activities fail)
- Timer events (scheduled waits or timeouts)`,
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
    `Get job execution details for a process instance. Jobs are units of work the engine executes — service tasks, timers, message events.

Key fields:
- retries: how many retry attempts remain. 0 means the engine gave up and created an incident.
- exceptionMessage: the error from the last failed execution attempt
- dueDate: when the job is scheduled to execute (for timers)
- suspended: true if the job is paused`,
    {
      processInstanceId: z.string().optional().describe("Filter jobs by process instance ID"),
      maxResults: z.string().optional().describe("Max results (default 25)"),
      firstResult: z.string().optional().describe("Offset for pagination (default 0)"),
    },
    async (params) => {
      try {
        await requireAuth();
        const queryParams: Record<string, string> = {};
        if (params.processInstanceId) queryParams.processInstanceId = params.processInstanceId;
        if (params.maxResults) queryParams.maxResults = params.maxResults;
        if (params.firstResult) queryParams.firstResult = params.firstResult;
        const result = await client.getJobs(queryParams);
        return toolResult(result);
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

  server.resource(
    "cib7://api-reference",
    "cib7://api-reference",
    { mimeType: "text/markdown" },
    async () => ({
      contents: [
        {
          uri: "cib7://api-reference",
          text: API_REFERENCE,
          mimeType: "text/markdown",
        },
      ],
    })
  );

  server.resource(
    "cib7://concepts",
    "cib7://concepts",
    { mimeType: "text/markdown" },
    async () => ({
      contents: [
        {
          uri: "cib7://concepts",
          text: CONCEPTS,
          mimeType: "text/markdown",
        },
      ],
    })
  );

  return server;
}
