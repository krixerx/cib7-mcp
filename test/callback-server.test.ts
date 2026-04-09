import { describe, it, expect, afterEach } from "vitest";
import { CallbackServer } from "../src/callback-server.js";

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
});
