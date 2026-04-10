import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * On-demand reference content served as MCP resources.
 *
 * These guides hold the playbook / cookbook content that used to live inline
 * in tool descriptions. Tool descriptions are paid on every turn by every
 * client; resources are only fetched when the model decides it needs them.
 * Move anything verbose (examples, "common flows", field reference) here
 * and leave only a short pointer in the tool description.
 */

const API_REFERENCE = `# CIB Seven REST API Reference (Supported Endpoints)

## Process Instances
- \`GET /process-instance/{id}\` — Get a single process instance by ID
  - Returns: id, definitionId, businessKey, ended, suspended
- \`POST /history/process-instance\` — Search historic process instances with JSON body filters
  - Filters: processDefinitionKey, processDefinitionKeyIn, processDefinitionName, businessKey, active, suspended, completed, startedBy, startedAfter, startedBefore, finishedAfter, finishedBefore, withIncidents, incidentStatus, sortBy, sortOrder
  - Pagination: maxResults, firstResult query params
- \`POST /history/process-instance/count\` — Count historic process instances
  - Same body filters as list; returns {count: N}. Cheap — no row fetch.

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

const QUERYING_GUIDE = `# Querying Process Instances — Cookbook

Picking the right tool saves round-trips and tokens.

## Which tool?
- **\`get_process_instance\`** — One known ID, need current runtime state. Queries the runtime DB, so it only sees active/suspended instances. Completed or terminated instances return "not found" here.
- **\`list_process_instances\`** — Search filter → rows. Uses the history API, so it covers both running and completed instances.
- **\`count_process_instances\`** — Same filter surface as list, returns a number. Use for "how many?" questions — no row fetch, no pagination.
- **\`process_instance_stats\`** — Histogram of starts over a date range, bucketed by day/week/month. Internally loops count over windows; cheap compared to listing rows.

## Common flows
- "Find instances of process X" → \`processDefinitionKey\`
- "Find instances started last week" → \`startedAfter\` / \`startedBefore\`
- "Find instances by order number" → \`businessKey\`
- "Find instances with incidents" → \`withIncidents: true\`
- "How many processes are running right now?" → \`count_process_instances\` + \`active: true\`
- "How many instances of X started today?" → \`count\` + \`processDefinitionKey\` + \`startedAfter\`
- "Daily starts for the last 30 days" → \`stats\` with \`from=today-30d\`, \`to=today\`, \`periodUnit=day\`
- "Monthly volume for X this year" → \`stats\` with \`processDefinitionKey\`, \`periodUnit=month\`
- "What day had the most starts this year?" → \`stats\` with \`periodUnit=day\`, read \`summary.max\`

## Dates
ISO-8601. Either \`2025-03-15\` or \`2025-03-15T00:00:00.000+0000\` work. A plain date is treated as local midnight.

## Sorting
\`list_process_instances\` defaults to engine order. Pass \`sortBy="startTime"\` and \`sortOrder="desc"\` for newest-first.

## Stats windows
Right-open \`[start, nextStart)\`. Week windows advance by 7 days from \`from\` — they are NOT aligned to Monday unless \`from\` is a Monday. Month windows advance by calendar month. \`maxBuckets\` (default 500) guards against runaway queries.
`;

const DIAGNOSTICS_GUIDE = `# Diagnosing Process Incidents — Field Reference

Use this as a field reference when inspecting a specific process instance.

## \`get_process_instance\` response
- \`suspended\` — true means manually paused by an operator
- \`ended\` — true means the process completed or was cancelled
- \`businessKey\` — the domain identifier (e.g. order number)
- \`definitionId\` — use this to fetch the BPMN XML via \`get_process_definition_xml\`

Runtime-only. If this returns "not found", the instance already finished — use \`list_process_instances\` to check history.

## \`get_activity_history\` response
Every activity that ran, in order. Shows exactly what happened.
- \`activityType\` — startEvent, serviceTask, userTask, exclusiveGateway, etc.
- \`activityName\` — human-readable name from the BPMN model
- \`startTime\` / \`endTime\` — when the activity started and finished
- \`durationInMillis\` — null if still running
- \`canceled\` — true if the activity was interrupted

**An activity with \`startTime\` but no \`endTime\` is where the process is currently waiting.**

## \`list_incidents\` response
Incidents record things that went wrong during execution.
- \`failedJob\` — a service task, timer, or other job threw an exception and the engine gave up retrying (retries=0)
- \`failedExternalTask\` — an external task worker reported a failure
- \`incidentMessage\` — the error explaining why
- \`activityId\` — which step failed

Filter by \`processInstanceId\` for a specific process, or list all open incidents with no filters.

## \`get_process_variables\` response
Variables hold the data that drives execution — form inputs, API responses, decision results. Sensitive values may be redacted (shown as \`[REDACTED]\`).

Look for:
- Error flags or status fields that indicate why a process is waiting
- Retry counters
- Input data from forms or API calls

## \`get_job_details\` response
Jobs are units of work the engine executes.
- \`retries\` — attempts remaining. **\`0\` means the engine gave up and created an incident.**
- \`exceptionMessage\` — the error from the last failed attempt
- \`dueDate\` — when the job is scheduled to execute (for timers)
- \`suspended\` — true if paused

## \`get_process_definition_xml\` — the BPMN blueprint
Read the XML to understand:
- The expected happy path (sequence of activities)
- Gateway conditions (what determines which path is taken)
- Error boundary events (what happens when activities fail)
- Timer events (scheduled waits or timeouts)

Diagram layout elements are stripped for readability. Pass the \`definitionId\` from \`get_process_instance\`.
`;

const AUTH_GUIDE = `# Authentication Modes

The \`auth_login\` tool has three modes.

## token — pre-obtained JWT
Pass \`token="..."\` to \`auth_login\`. No browser, no PKCE flow. The token is used directly. Automatic refresh is NOT available in this mode — provide a new token when the current one expires.

Use when: you already have a valid access token from another source (CI, tests, operator handoff).

## interactive — default
Call \`auth_login\` with no arguments. Opens the local browser to the Keycloak login page and blocks until sign-in completes.

Use when: the MCP server is running on your local machine and a browser is available.

## headless — two-phase
Call \`auth_login(headless=true)\`. Returns the \`authorizationUrl\` immediately without opening a browser and does NOT wait for the callback. Share the URL with the user, then call \`auth_wait\` to block until they finish signing in. Times out after 2 minutes.

Use when: the server is on a remote/SSH host or inside a container where no browser is available.

## Switching targets at runtime — \`set_server\`
You can switch CIB Seven and Keycloak targets without restarting. Provide \`cib7Url\` plus either all three Keycloak params (\`keycloakUrl\`, \`keycloakRealm\`, \`keycloakClientId\`) or none.

- All three Keycloak params → authenticated mode. Call \`auth_login\` afterwards (unless a stored refresh token is available and can be silently restored).
- No Keycloak params → unauthenticated mode, all tools available without login.

Partial Keycloak configuration is rejected.
`;

interface Guide {
  uri: string;
  name: string;
  description: string;
  text: string;
}

const GUIDES: Guide[] = [
  {
    uri: "cib7://api-reference",
    name: "cib7://api-reference",
    description: "CIB Seven REST API reference — supported endpoints, filters, and response fields.",
    text: API_REFERENCE,
  },
  {
    uri: "cib7://concepts",
    name: "cib7://concepts",
    description: "Operational concepts: process states, incidents, jobs, activities, business keys.",
    text: CONCEPTS,
  },
  {
    uri: "cib7://guide/querying",
    name: "cib7://guide/querying",
    description: "Cookbook for list_process_instances / count_process_instances / process_instance_stats — which tool to use, date formats, sorting, histogram windows.",
    text: QUERYING_GUIDE,
  },
  {
    uri: "cib7://guide/diagnostics",
    name: "cib7://guide/diagnostics",
    description: "Field reference for diagnosing a stuck or failing process: activity history, incidents, variables, jobs, BPMN XML.",
    text: DIAGNOSTICS_GUIDE,
  },
  {
    uri: "cib7://guide/auth",
    name: "cib7://guide/auth",
    description: "Authentication modes — token, interactive, headless — and runtime target switching with set_server.",
    text: AUTH_GUIDE,
  },
];

export function registerResources(server: McpServer): void {
  for (const guide of GUIDES) {
    server.resource(
      guide.name,
      guide.uri,
      { description: guide.description, mimeType: "text/markdown" },
      async () => ({
        contents: [
          {
            uri: guide.uri,
            text: guide.text,
            mimeType: "text/markdown",
          },
        ],
      }),
    );
  }
}
