import { describe, it, expect, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import * as http from "node:http";
import { CallbackServer } from "../src/callback-server.js";

vi.mock("node:http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:http")>();
  return {
    ...actual,
    default: actual,
    createServer: vi.fn(actual.createServer),
  };
});

describe("CallbackServer", () => {
  let server: CallbackServer;

  afterEach(() => {
    server?.stop();
  });

  it("assigns a real port after listening", async () => {
    server = new CallbackServer();
    const state = "test-state-123";
    server.start(state); // don't await — it waits for the callback

    await server.listening;

    expect(server.port).toBeGreaterThan(0);
    expect(server.redirectUri).toBe(`http://127.0.0.1:${server.port}/callback`);
  });

  it("rejects listening promise when not started", async () => {
    server = new CallbackServer();
    await expect(server.listening).rejects.toThrow("Server not started");
  });

  it("resolves with code and state on valid callback", async () => {
    server = new CallbackServer();
    const state = "valid-state";
    const resultPromise = server.start(state);

    await server.listening;

    // Simulate the OAuth callback
    const res = await fetch(
      `http://127.0.0.1:${server.port}/callback?code=auth-code-123&state=${state}`,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Access Authorized");

    const result = await resultPromise;
    expect(result.code).toBe("auth-code-123");
    expect(result.state).toBe(state);
  });

  it("rejects on state mismatch", async () => {
    server = new CallbackServer();
    const resultPromise = server.start("expected-state");
    // Attach rejection handler early to prevent unhandled rejection warning
    resultPromise.catch(() => {});

    await server.listening;

    const res = await fetch(
      `http://127.0.0.1:${server.port}/callback?code=abc&state=wrong-state`,
    );
    expect(res.status).toBe(400);

    await expect(resultPromise).rejects.toThrow("state mismatch");
  });

  it("rejects on missing code", async () => {
    server = new CallbackServer();
    const resultPromise = server.start("some-state");
    resultPromise.catch(() => {});

    await server.listening;

    const res = await fetch(
      `http://127.0.0.1:${server.port}/callback?state=some-state`,
    );
    expect(res.status).toBe(400);

    await expect(resultPromise).rejects.toThrow("missing code or state");
  });

  it("rejects on OAuth error callback", async () => {
    server = new CallbackServer();
    const resultPromise = server.start("some-state");
    resultPromise.catch(() => {});

    await server.listening;

    const res = await fetch(
      `http://127.0.0.1:${server.port}/callback?error=access_denied&error_description=User+denied`,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Access Denied");

    await expect(resultPromise).rejects.toThrow("access_denied");
  });

  it("returns 404 for non-callback paths", async () => {
    server = new CallbackServer();
    server.start("some-state");

    await server.listening;

    const res = await fetch(`http://127.0.0.1:${server.port}/other`);
    expect(res.status).toBe(404);
  });

  it("stops cleanly", async () => {
    server = new CallbackServer();
    server.start("some-state");
    await server.listening;
    const port = server.port;

    server.stop();

    // Fetch should fail after stop
    await expect(
      fetch(`http://127.0.0.1:${port}/callback?code=x&state=some-state`),
    ).rejects.toThrow();
  });

  it("rejects listening promise when server fails to bind", async () => {
    // Stub http.createServer to return a fake that emits an error on listen,
    // simulating EADDRINUSE or similar bind failures.
    const fake = new EventEmitter() as EventEmitter & {
      listen: (port: number, host: string, cb: () => void) => void;
      close: () => void;
      address: () => null;
    };
    fake.listen = (_port: number, _host: string, _cb: () => void) => {
      // Emit error asynchronously, mirroring real node:http behaviour when
      // a bind fails — the listen callback never fires.
      setImmediate(() => fake.emit("error", new Error("EADDRINUSE: simulated bind failure")));
    };
    fake.close = () => {};
    fake.address = () => null;

    const mockedCreateServer = vi.mocked(http.createServer);
    const originalImpl = mockedCreateServer.getMockImplementation();
    mockedCreateServer.mockReturnValueOnce(fake as unknown as http.Server);

    try {
      server = new CallbackServer();
      const resultPromise = server.start("some-state");
      // Attach rejection handler early so the failure is observed on both
      // the outer callback promise and the listening promise.
      resultPromise.catch(() => {});

      await expect(server.listening).rejects.toThrow("Callback server failed");
      await expect(resultPromise).rejects.toThrow("Callback server failed");
    } finally {
      if (originalImpl) {
        mockedCreateServer.mockImplementation(originalImpl);
      }
    }
  });
});
