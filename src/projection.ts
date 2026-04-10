import type {
  HistoricActivityInstance,
  HistoricProcessInstance,
  Incident,
  Job,
} from "./types.js";

/**
 * Response projection for list tools.
 *
 * MCP tool responses are paid in tokens by every LLM client, so large list
 * responses blow the context budget fast. The default "summary" view keeps
 * only the fields a caller needs to decide the next action; "full" preserves
 * the raw engine shape for drill-down.
 *
 * Default is "summary". When a summary response is returned, `hint` tells
 * the model that more fields are available via view="full".
 */

export type View = "summary" | "full";

export interface ProjectedResponse<T> {
  view: View;
  count: number;
  items: T[];
  hint?: string;
}

const SUMMARY_HINT = 'Summary view. Re-call with view="full" for all fields.';

// ---- HistoricProcessInstance --------------------------------------------

export interface HistoricProcessInstanceSummary {
  id: string;
  processDefinitionId: string;
  processDefinitionKey: string;
  businessKey: string | null;
  startTime: string;
  endTime: string | null;
  state: string;
}

function summarizeHistoricProcessInstance(
  r: HistoricProcessInstance,
): HistoricProcessInstanceSummary {
  return {
    id: r.id,
    processDefinitionId: r.processDefinitionId,
    processDefinitionKey: r.processDefinitionKey,
    businessKey: r.businessKey,
    startTime: r.startTime,
    endTime: r.endTime,
    state: r.state,
  };
}

export function projectHistoricProcessInstances(
  rows: HistoricProcessInstance[],
  view: View,
): ProjectedResponse<HistoricProcessInstance | HistoricProcessInstanceSummary> {
  if (view === "full") {
    return { view, count: rows.length, items: rows };
  }
  return {
    view: "summary",
    count: rows.length,
    items: rows.map(summarizeHistoricProcessInstance),
    hint: SUMMARY_HINT,
  };
}

// ---- HistoricActivityInstance -------------------------------------------

export interface HistoricActivityInstanceSummary {
  activityId: string;
  activityName: string | null;
  activityType: string;
  startTime: string;
  endTime: string | null;
  durationInMillis: number | null;
  canceled: boolean;
}

function summarizeHistoricActivityInstance(
  r: HistoricActivityInstance,
): HistoricActivityInstanceSummary {
  return {
    activityId: r.activityId,
    activityName: r.activityName,
    activityType: r.activityType,
    startTime: r.startTime,
    endTime: r.endTime,
    durationInMillis: r.durationInMillis,
    canceled: r.canceled,
  };
}

export function projectActivityHistory(
  rows: HistoricActivityInstance[],
  view: View,
): ProjectedResponse<HistoricActivityInstance | HistoricActivityInstanceSummary> {
  if (view === "full") {
    return { view, count: rows.length, items: rows };
  }
  return {
    view: "summary",
    count: rows.length,
    items: rows.map(summarizeHistoricActivityInstance),
    hint: SUMMARY_HINT,
  };
}

// ---- Incident -----------------------------------------------------------

export interface IncidentSummary {
  id: string;
  processInstanceId: string;
  incidentTimestamp: string;
  incidentType: string;
  activityId: string;
  incidentMessage: string | null;
}

function summarizeIncident(r: Incident): IncidentSummary {
  return {
    id: r.id,
    processInstanceId: r.processInstanceId,
    incidentTimestamp: r.incidentTimestamp,
    incidentType: r.incidentType,
    activityId: r.activityId,
    incidentMessage: r.incidentMessage,
  };
}

export function projectIncidents(
  rows: Incident[],
  view: View,
): ProjectedResponse<Incident | IncidentSummary> {
  if (view === "full") {
    return { view, count: rows.length, items: rows };
  }
  return {
    view: "summary",
    count: rows.length,
    items: rows.map(summarizeIncident),
    hint: SUMMARY_HINT,
  };
}

// ---- Job ---------------------------------------------------------------

export interface JobSummary {
  id: string;
  processInstanceId: string;
  exceptionMessage: string | null;
  retries: number;
  dueDate: string | null;
  suspended: boolean;
  createTime: string;
}

function summarizeJob(r: Job): JobSummary {
  return {
    id: r.id,
    processInstanceId: r.processInstanceId,
    exceptionMessage: r.exceptionMessage,
    retries: r.retries,
    dueDate: r.dueDate,
    suspended: r.suspended,
    createTime: r.createTime,
  };
}

export function projectJobs(
  rows: Job[],
  view: View,
): ProjectedResponse<Job | JobSummary> {
  if (view === "full") {
    return { view, count: rows.length, items: rows };
  }
  return {
    view: "summary",
    count: rows.length,
    items: rows.map(summarizeJob),
    hint: SUMMARY_HINT,
  };
}
