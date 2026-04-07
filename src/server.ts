import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Cib7Client } from "./cib7-client.js";
import { NotFoundError } from "./cib7-client.js";
import { diagnoseStuckProcess, incidentReport } from "./prompts.js";

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

export function createServer(client: Cib7Client): McpServer {
  const server = new McpServer({
    name: "cib7-mcp",
    version: "0.1.0",
  });

  // === TOOLS ===

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
