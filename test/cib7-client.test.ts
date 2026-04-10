import { describe, it, expect, vi, beforeEach } from "vitest";
import { createCib7Client, normalizeBaseUrl, NotFoundError } from "../src/cib7-client.js";
import type { AuthProvider } from "../src/types.js";

describe("normalizeBaseUrl", () => {
  it("passes through URL as-is", () => {
    expect(normalizeBaseUrl("http://localhost:6009/rest")).toBe(
      "http://localhost:6009/rest"
    );
  });

  it("strips trailing slash", () => {
    expect(normalizeBaseUrl("http://localhost:6009/rest/")).toBe(
      "http://localhost:6009/rest"
    );
  });

  it("strips multiple trailing slashes", () => {
    expect(normalizeBaseUrl("http://localhost:6009/rest///")).toBe(
      "http://localhost:6009/rest"
    );
  });

  it("handles URL without path", () => {
    expect(normalizeBaseUrl("http://localhost:6009")).toBe(
      "http://localhost:6009"
    );
  });
});

describe("createCib7Client", () => {
  let mockAuth: AuthProvider;
  let mockRedactor: (obj: Record<string, unknown>) => Record<string, unknown>;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockAuth = {
      getToken: vi.fn().mockResolvedValue("test-token"),
    };
    mockRedactor = (obj) => obj;
  });

  function mockFetch(response: object, status = 200) {
    return vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: async () => response,
      text: async () => JSON.stringify(response),
    } as Response);
  }

  it("sends Authorization header with token", async () => {
    let capturedHeaders: Record<string, string> = {};
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return { ok: true, status: 200, json: async () => ({ id: "123" }), text: async () => "" } as Response;
    });
    const client = createCib7Client("http://localhost:6009/rest", mockAuth, mockRedactor);
    await client.getProcessInstance("123");

    expect(capturedHeaders["Authorization"]).toBe("Bearer test-token");
    expect(capturedHeaders["Accept"]).toBe("application/json");
  });

  it("throws on 401 without retrying", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false, status: 401, json: async () => ({}), text: async () => "",
    } as Response);

    const client = createCib7Client("http://localhost:6009/rest", mockAuth, mockRedactor);
    await expect(client.getProcessInstance("123")).rejects.toThrow("Authentication failed");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("throws on 403", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false, status: 403, json: async () => ({}), text: async () => "",
    } as Response);

    const client = createCib7Client("http://localhost:6009/rest", mockAuth, mockRedactor);
    await expect(client.getProcessInstance("123")).rejects.toThrow("Authentication failed");
  });

  it("throws NotFoundError on 404", async () => {
    mockFetch({}, 404);
    const client = createCib7Client("http://localhost:6009/rest", mockAuth, mockRedactor);
    await expect(client.getProcessInstance("123")).rejects.toThrow(NotFoundError);
  });

  it("throws with engine error message on 500", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false, status: 500,
      json: async () => ({ message: "Engine error details" }),
      text: async () => "",
    } as Response);

    const client = createCib7Client("http://localhost:6009/rest", mockAuth, mockRedactor);
    await expect(client.getProcessInstance("123")).rejects.toThrow("Engine error details");
  });

  it("throws connectivity error on fetch failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));

    const client = createCib7Client("http://localhost:6009/rest", mockAuth, mockRedactor);
    await expect(client.getProcessInstance("123")).rejects.toThrow("Cannot reach CIB Seven");
  });

  it("applies redaction to process variables", async () => {
    mockFetch({ password: { value: "secret", type: "String", valueInfo: {} } });
    const redactorSpy = vi.fn((obj: Record<string, unknown>) => {
      return { password: { value: "[REDACTED]", type: "String", valueInfo: {} } };
    });

    const client = createCib7Client("http://localhost:6009/rest", mockAuth, redactorSpy);
    const vars = await client.getProcessVariables("123");
    expect(redactorSpy).toHaveBeenCalled();
    expect((vars as Record<string, { value: unknown }>).password.value).toBe("[REDACTED]");
  });

  it("works without auth token in unauthenticated mode", async () => {
    const noAuth: AuthProvider = {
      getToken: vi.fn().mockResolvedValue(null),
      invalidateToken: vi.fn(),
    };
    const fetchSpy = mockFetch({ id: "123" });

    const client = createCib7Client("http://localhost:6009/rest", noAuth, mockRedactor);
    await client.getProcessInstance("123");

    const headers = (fetchSpy.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it("countProcessInstances POSTs filters to /history/process-instance/count and returns the count", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ count: 42 }),
      text: async () => "",
    } as Response);

    const client = createCib7Client("http://localhost:6009/rest", mockAuth, mockRedactor);
    const count = await client.countProcessInstances({
      processDefinitionKey: "orderProcess",
      startedAfter: "2025-01-01T00:00:00.000Z",
      startedBefore: "2025-01-02T00:00:00.000Z",
    });

    expect(count).toBe(42);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("http://localhost:6009/rest/history/process-instance/count");
    expect(init?.method).toBe("POST");
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(body.processDefinitionKey).toBe("orderProcess");
    expect(body.startedAfter).toBe("2025-01-01T00:00:00.000Z");
    expect(body.startedBefore).toBe("2025-01-02T00:00:00.000Z");
    // Count endpoint must not carry pagination fields.
    expect(body.maxResults).toBeUndefined();
    expect(body.firstResult).toBeUndefined();
  });

  it("listProcessInstances passes expanded filters through on the body", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [],
      text: async () => "",
    } as Response);

    const client = createCib7Client("http://localhost:6009/rest", mockAuth, mockRedactor);
    await client.listProcessInstances({
      processDefinitionKey: "orderProcess",
      startedAfter: "2025-01-01T00:00:00.000Z",
      startedBefore: "2025-02-01T00:00:00.000Z",
      withIncidents: true,
      sortBy: "startTime",
      sortOrder: "desc",
      maxResults: 100,
      firstResult: 0,
    });

    const [url, init] = fetchSpy.mock.calls[0];
    // Pagination stays on the query string, filters go on the body (Camunda quirk).
    expect(url).toBe(
      "http://localhost:6009/rest/history/process-instance?maxResults=100&firstResult=0"
    );
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(body.processDefinitionKey).toBe("orderProcess");
    expect(body.startedAfter).toBe("2025-01-01T00:00:00.000Z");
    expect(body.startedBefore).toBe("2025-02-01T00:00:00.000Z");
    expect(body.withIncidents).toBe(true);
    expect(body.sortBy).toBe("startTime");
    expect(body.sortOrder).toBe("desc");
    expect(body.maxResults).toBeUndefined();
    expect(body.firstResult).toBeUndefined();
  });
});
