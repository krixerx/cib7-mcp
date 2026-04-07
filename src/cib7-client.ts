import { XMLParser, XMLBuilder } from "fast-xml-parser";
import type {
  AuthProvider,
  HistoricActivityInstance,
  HistoricProcessInstance,
  Incident,
  Job,
  ProcessDefinitionXml,
  ProcessInstance,
  ProcessVariables,
} from "./types.js";

export interface Cib7Client {
  getProcessInstance(id: string): Promise<ProcessInstance>;
  listProcessInstances(filters: Record<string, unknown>): Promise<HistoricProcessInstance[]>;
  listIncidents(params: Record<string, string>): Promise<Incident[]>;
  getActivityHistory(processInstanceId: string): Promise<HistoricActivityInstance[]>;
  getProcessVariables(processInstanceId: string): Promise<ProcessVariables>;
  getProcessDefinitionXml(processDefinitionId: string): Promise<ProcessDefinitionXml>;
  getJobs(params: Record<string, string>): Promise<Job[]>;
}

export function normalizeBaseUrl(url: string): string {
  // Strip trailing slash
  return url.replace(/\/+$/, "");
}

export function createCib7Client(
  rawBaseUrl: string,
  authProvider: AuthProvider,
  redactor: (obj: Record<string, unknown>) => Record<string, unknown>
): Cib7Client {
  const baseUrl = normalizeBaseUrl(rawBaseUrl);

  async function request<T>(
    path: string,
    options: RequestInit = {},
    retry = true
  ): Promise<T> {
    const token = await authProvider.getToken();

    const headers: Record<string, string> = {
      "Accept": "application/json",
      ...(options.headers as Record<string, string> || {}),
    };

    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    if (options.body && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }

    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        ...options,
        headers,
      });
    } catch (err) {
      throw new Error(
        `Cannot reach CIB Seven at ${baseUrl}. Check CIB7_URL and network connectivity. ${err instanceof Error ? err.message : ""}`
      );
    }

    if (response.status === 401 || response.status === 403) {
      if (retry) {
        authProvider.invalidateToken();
        return request<T>(path, options, false);
      }
      throw new Error(
        `Authentication failed (${response.status}). Check KEYCLOAK_* environment variables.`
      );
    }

    if (response.status === 404) {
      throw new NotFoundError(
        `Not found: ${path}. Verify the ID is correct and the resource hasn't been deleted.`
      );
    }

    if (!response.ok) {
      let errorBody: string;
      try {
        const json = await response.json() as { message?: string };
        errorBody = json.message || JSON.stringify(json);
      } catch {
        errorBody = await response.text();
      }
      throw new Error(
        `CIB Seven returned ${response.status}: ${errorBody}`
      );
    }

    return response.json() as Promise<T>;
  }

  function buildQueryString(params: Record<string, string>): string {
    const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== "");
    if (entries.length === 0) return "";
    return "?" + new URLSearchParams(entries).toString();
  }

  const xmlParser = new XMLParser({
    ignoreAttributes: false,
    preserveOrder: true,
  });
  const xmlBuilder = new XMLBuilder({
    ignoreAttributes: false,
    preserveOrder: true,
  });

  function stripBpmnDiagram(xml: string): string {
    try {
      const parsed = xmlParser.parse(xml);
      removeBpmnDi(parsed);
      return xmlBuilder.build(parsed);
    } catch {
      // If parsing fails, return original
      return xml;
    }
  }

  function removeBpmnDi(nodes: unknown[]): void {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const node = nodes[i] as Record<string, unknown>;
      for (const key of Object.keys(node)) {
        if (key.includes("BPMNDiagram") || key.includes("bpmndi:")) {
          nodes.splice(i, 1);
          break;
        } else {
          const child = node[key];
          if (Array.isArray(child)) {
            removeBpmnDi(child);
          }
        }
      }
    }
  }

  return {
    async getProcessInstance(id: string): Promise<ProcessInstance> {
      return request<ProcessInstance>(`/process-instance/${encodeURIComponent(id)}`);
    },

    async listProcessInstances(filters: Record<string, unknown>): Promise<HistoricProcessInstance[]> {
      const body = {
        maxResults: 25,
        firstResult: 0,
        ...filters,
      };
      const { maxResults, firstResult, ...queryBody } = body;
      return request<HistoricProcessInstance[]>(
        `/history/process-instance?maxResults=${maxResults}&firstResult=${firstResult}`,
        {
          method: "POST",
          body: JSON.stringify(queryBody),
        }
      );
    },

    async listIncidents(params: Record<string, string>): Promise<Incident[]> {
      const queryParams = { maxResults: "25", firstResult: "0", ...params };
      return request<Incident[]>(`/incident${buildQueryString(queryParams)}`);
    },

    async getActivityHistory(processInstanceId: string): Promise<HistoricActivityInstance[]> {
      return request<HistoricActivityInstance[]>(
        `/history/activity-instance?processInstanceId=${encodeURIComponent(processInstanceId)}&sortBy=startTime&sortOrder=asc`
      );
    },

    async getProcessVariables(processInstanceId: string): Promise<ProcessVariables> {
      const vars = await request<ProcessVariables>(
        `/process-instance/${encodeURIComponent(processInstanceId)}/variables`
      );
      return redactor(vars as unknown as Record<string, unknown>) as unknown as ProcessVariables;
    },

    async getProcessDefinitionXml(processDefinitionId: string): Promise<ProcessDefinitionXml> {
      const result = await request<ProcessDefinitionXml>(
        `/process-definition/${encodeURIComponent(processDefinitionId)}/xml`
      );
      return {
        ...result,
        bpmn20Xml: stripBpmnDiagram(result.bpmn20Xml),
      };
    },

    async getJobs(params: Record<string, string>): Promise<Job[]> {
      const queryParams = { maxResults: "25", firstResult: "0", ...params };
      return request<Job[]>(`/job${buildQueryString(queryParams)}`);
    },
  };
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}
