export interface ProcessInstance {
  id: string;
  definitionId: string;
  businessKey: string | null;
  caseInstanceId: string | null;
  ended: boolean;
  suspended: boolean;
  tenantId: string | null;
}

export interface HistoricProcessInstance {
  id: string;
  processDefinitionId: string;
  processDefinitionKey: string;
  processDefinitionName: string | null;
  businessKey: string | null;
  startTime: string;
  endTime: string | null;
  durationInMillis: number | null;
  state: string;
  startUserId: string | null;
  deleteReason: string | null;
  superProcessInstanceId: string | null;
  tenantId: string | null;
}

export interface Incident {
  id: string;
  processDefinitionId: string;
  processInstanceId: string;
  executionId: string;
  incidentTimestamp: string;
  incidentType: string;
  activityId: string;
  causeIncidentId: string;
  rootCauseIncidentId: string;
  configuration: string;
  incidentMessage: string | null;
  tenantId: string | null;
  jobDefinitionId: string | null;
}

export interface HistoricActivityInstance {
  id: string;
  activityId: string;
  activityName: string | null;
  activityType: string;
  processDefinitionId: string;
  processInstanceId: string;
  executionId: string;
  taskId: string | null;
  assignee: string | null;
  calledProcessInstanceId: string | null;
  startTime: string;
  endTime: string | null;
  durationInMillis: number | null;
  canceled: boolean;
  completeScope: boolean;
  tenantId: string | null;
}

export interface ProcessVariable {
  value: unknown;
  type: string;
  valueInfo: Record<string, unknown>;
}

export type ProcessVariables = Record<string, ProcessVariable>;

export interface ProcessDefinitionXml {
  id: string;
  bpmn20Xml: string;
}

export interface Job {
  id: string;
  jobDefinitionId: string;
  processInstanceId: string;
  processDefinitionId: string;
  processDefinitionKey: string;
  executionId: string;
  exceptionMessage: string | null;
  retries: number;
  dueDate: string | null;
  suspended: boolean;
  priority: number;
  tenantId: string | null;
  createTime: string;
}

export interface AuthConfig {
  keycloakUrl: string;
  realm: string;
  clientId: string;
}

export interface RefreshContext {
  refreshToken: string;
  tokenEndpoint: string;
  clientId: string;
}

export interface AuthStoreData {
  version: number;
  instances: Record<string, AuthStoreInstance>;
}

export interface AuthStoreInstance {
  refreshToken?: string;
  tokenEndpoint?: string;
  clientId?: string;
  keycloakUrl?: string;
  keycloakRealm?: string;
}

export interface AuthProvider {
  getToken(): Promise<string | null>;
}

export interface UserSession {
  authenticated: boolean;
  userEmail: string | null;
  roles: string[];
  expiresInMinutes: number;
}
