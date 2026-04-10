import { describe, it, expect } from "vitest";
import {
  projectActivityHistory,
  projectHistoricProcessInstances,
  projectIncidents,
  projectJobs,
} from "../src/projection.js";
import type {
  HistoricActivityInstance,
  HistoricProcessInstance,
  Incident,
  Job,
} from "../src/types.js";

const fullInstance: HistoricProcessInstance = {
  id: "8a7b3c4d-1234-5678-9abc-def012345678",
  processDefinitionId: "orderProcess:12:8a7b3c4d-1234-5678-9abc-def012345679",
  processDefinitionKey: "orderProcess",
  processDefinitionName: "Order Fulfillment Process",
  businessKey: "ORD-2026-001234",
  startTime: "2026-04-10T14:23:45.123+0000",
  endTime: "2026-04-10T14:45:12.456+0000",
  durationInMillis: 1287333,
  state: "COMPLETED",
  startUserId: "jane.doe@monentreprise.bj",
  deleteReason: null,
  superProcessInstanceId: null,
  tenantId: null,
};

const fullActivity: HistoricActivityInstance = {
  id: "a1b2c3d4-5678-90ab-cdef-1234567890ab",
  activityId: "ServiceTask_ValidatePayment",
  activityName: "Validate Payment Details",
  activityType: "serviceTask",
  processDefinitionId: "orderProcess:12:xyz",
  processInstanceId: "8a7b3c4d-1234-5678-9abc-def012345678",
  executionId: "e1a2b3c4",
  taskId: null,
  assignee: null,
  calledProcessInstanceId: null,
  startTime: "2026-04-10T14:23:45.123+0000",
  endTime: "2026-04-10T14:23:46.234+0000",
  durationInMillis: 1111,
  canceled: false,
  completeScope: true,
  tenantId: null,
};

const fullIncident: Incident = {
  id: "i1a2b3c4",
  processDefinitionId: "orderProcess:12:xyz",
  processInstanceId: "8a7b3c4d",
  executionId: "e1a2b3c4",
  incidentTimestamp: "2026-04-10T14:23:46.234+0000",
  incidentType: "failedJob",
  activityId: "ServiceTask_ChargeCard",
  causeIncidentId: "i1a2b3c4",
  rootCauseIncidentId: "i1a2b3c4",
  configuration: "jd1a2b3c4",
  incidentMessage: "Payment gateway unreachable after 3 retries",
  tenantId: null,
  jobDefinitionId: "jd1a2b3c4",
};

const fullJob: Job = {
  id: "j1a2b3c4",
  jobDefinitionId: "jd1a2b3c4",
  processInstanceId: "8a7b3c4d",
  processDefinitionId: "orderProcess:12:xyz",
  processDefinitionKey: "orderProcess",
  executionId: "e1a2b3c4",
  exceptionMessage: "java.net.ConnectException: Connection refused",
  retries: 0,
  dueDate: "2026-04-10T14:25:00.000+0000",
  suspended: false,
  priority: 0,
  tenantId: null,
  createTime: "2026-04-10T14:23:45.123+0000",
};

describe("projectHistoricProcessInstances", () => {
  it("returns a bare array — no wrapper", () => {
    const result = projectHistoricProcessInstances([fullInstance], "summary");
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1);
  });

  it("summary view keeps only the declared fields", () => {
    const [item] = projectHistoricProcessInstances([fullInstance], "summary");
    expect(Object.keys(item).sort()).toEqual([
      "businessKey",
      "endTime",
      "id",
      "processDefinitionId",
      "processDefinitionKey",
      "startTime",
      "state",
    ]);
  });

  it("full view returns rows untouched", () => {
    const result = projectHistoricProcessInstances([fullInstance], "full");
    expect(result).toEqual([fullInstance]);
  });

  it("preserves empty input", () => {
    const result = projectHistoricProcessInstances([], "summary");
    expect(result).toEqual([]);
  });

  it("preserves nulls in summary fields", () => {
    const withNulls: HistoricProcessInstance = {
      ...fullInstance,
      businessKey: null,
      endTime: null,
    };
    const [item] = projectHistoricProcessInstances([withNulls], "summary") as Array<Record<string, unknown>>;
    expect(item.businessKey).toBeNull();
    expect(item.endTime).toBeNull();
  });
});

describe("projectActivityHistory", () => {
  it("summary keeps the 7 declared fields and drops the rest", () => {
    const [item] = projectActivityHistory([fullActivity], "summary");
    expect(Object.keys(item).sort()).toEqual([
      "activityId",
      "activityName",
      "activityType",
      "canceled",
      "durationInMillis",
      "endTime",
      "startTime",
    ]);
  });

  it("full view is pass-through", () => {
    expect(projectActivityHistory([fullActivity], "full")).toEqual([fullActivity]);
  });
});

describe("projectIncidents", () => {
  it("summary includes the incidentMessage and drops bookkeeping fields", () => {
    const [item] = projectIncidents([fullIncident], "summary") as Array<Record<string, unknown>>;
    expect(item.incidentMessage).toBe(fullIncident.incidentMessage);
    expect(item.causeIncidentId).toBeUndefined();
    expect(item.rootCauseIncidentId).toBeUndefined();
    expect(item.configuration).toBeUndefined();
  });

  it("full view is pass-through", () => {
    expect(projectIncidents([fullIncident], "full")).toEqual([fullIncident]);
  });
});

describe("projectJobs", () => {
  it("summary keeps retries and exceptionMessage — the key triage fields", () => {
    const [item] = projectJobs([fullJob], "summary") as Array<Record<string, unknown>>;
    expect(item.retries).toBe(0);
    expect(item.exceptionMessage).toContain("ConnectException");
    expect(item.jobDefinitionId).toBeUndefined();
    expect(item.priority).toBeUndefined();
  });

  it("full view is pass-through", () => {
    expect(projectJobs([fullJob], "full")).toEqual([fullJob]);
  });
});

describe("projection produces smaller JSON than full", () => {
  it("historic process instances: summary is materially smaller", () => {
    // Summary retains processDefinitionId for drill-down to BPMN XML, so
    // the ratio is ~55% of full rather than the ~33% of a bare minimum set.
    const page = Array.from({ length: 25 }, () => fullInstance);
    const full = JSON.stringify(projectHistoricProcessInstances(page, "full"));
    const summary = JSON.stringify(projectHistoricProcessInstances(page, "summary"));
    expect(summary.length).toBeLessThan(full.length * 0.7);
  });

  it("activity history: summary drops more than half the bytes", () => {
    const page = Array.from({ length: 30 }, () => fullActivity);
    const full = JSON.stringify(projectActivityHistory(page, "full"));
    const summary = JSON.stringify(projectActivityHistory(page, "summary"));
    expect(summary.length).toBeLessThan(full.length * 0.5);
  });

  it("incidents: summary drops bookkeeping fields", () => {
    const page = Array.from({ length: 25 }, () => fullIncident);
    const full = JSON.stringify(projectIncidents(page, "full"));
    const summary = JSON.stringify(projectIncidents(page, "summary"));
    expect(summary.length).toBeLessThan(full.length * 0.7);
  });

  it("jobs: summary drops redundant definition IDs", () => {
    const page = Array.from({ length: 25 }, () => fullJob);
    const full = JSON.stringify(projectJobs(page, "full"));
    const summary = JSON.stringify(projectJobs(page, "summary"));
    expect(summary.length).toBeLessThan(full.length * 0.7);
  });
});
