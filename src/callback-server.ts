/**
 * Local HTTP server for receiving the OAuth authorization code callback.
 *
 * Listens on 127.0.0.1 with a dynamic port. After Keycloak redirects
 * the browser to /callback?code=...&state=..., this server captures
 * the code, shows a success/error page, and resolves the Promise.
 */

import * as http from "node:http";
import { URL } from "node:url";

const CALLBACK_TIMEOUT_MS = 120_000; // 2 minutes

interface CallbackResult {
  code: string;
  state: string;
}

export class CallbackServer {
  private server: http.Server | null = null;
  private _port = 0;
  private _listeningPromise: Promise<void> | null = null;
  private _resolveListening: (() => void) | null = null;
  private _rejectListening: ((err: Error) => void) | null = null;
  private _isListening = false;

  get port(): number {
    return this._port;
  }

  get redirectUri(): string {
    return `http://127.0.0.1:${this._port}/callback`;
  }

  /**
   * Resolves once the server is listening and the port is assigned.
   * Rejects if the server fails to bind.
   */
  get listening(): Promise<void> {
    return this._listeningPromise ?? Promise.reject(new Error("Server not started"));
  }

  /**
   * Start the server and wait for the OAuth callback.
   * Returns a Promise that resolves with the authorization code.
   */
  start(expectedState: string): Promise<CallbackResult> {
    this._listeningPromise = new Promise<void>((resolve, reject) => {
      this._resolveListening = resolve;
      this._rejectListening = reject;
    });
    // Attach a no-op rejection handler so that a listening failure does not
    // crash the process as an unhandled rejection if the caller never awaits
    // `listening` (e.g. when the outer `start()` promise's error handler
    // handles it first).
    this._listeningPromise.catch(() => {});

    return new Promise<CallbackResult>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        if (!req.url) {
          res.writeHead(404);
          res.end();
          return;
        }

        const url = new URL(req.url, `http://127.0.0.1:${this._port}`);

        if (url.pathname !== "/callback") {
          res.writeHead(404);
          res.end();
          return;
        }

        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const error = url.searchParams.get("error");
        const errorDescription = url.searchParams.get("error_description");

        if (error) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(errorPage(error, errorDescription ?? "Unknown error"));
          cleanup();
          reject(new Error(`Authentication failed: ${error}. ${errorDescription ?? ""}`));
          return;
        }

        if (!code || !state) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(errorPage("missing_params", "Missing code or state parameter"));
          cleanup();
          reject(new Error("Authentication failed: missing code or state in callback"));
          return;
        }

        if (state !== expectedState) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(errorPage("state_mismatch", "Security validation failed (state mismatch)"));
          cleanup();
          reject(new Error("Authentication failed: state mismatch (CSRF protection)"));
          return;
        }

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(successPage());
        cleanup();
        resolve({ code, state });
      });

      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Authentication timed out: no callback received within ${CALLBACK_TIMEOUT_MS / 1000} seconds`));
      }, CALLBACK_TIMEOUT_MS);

      const cleanup = () => {
        clearTimeout(timeout);
        this.stop();
      };

      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          this._port = addr.port;
        }
        this.server = server;
        this._isListening = true;
        this._resolveListening?.();
      });

      server.on("error", (err) => {
        const failure = new Error(`Callback server failed: ${err.message}`);
        // If the server never reached listening state, reject the listening
        // promise so callers awaiting it don't hang forever.
        if (!this._isListening) {
          this._rejectListening?.(failure);
        }
        cleanup();
        reject(failure);
      });
    });
  }

  stop(): void {
    this._isListening = false;
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }
}

function successPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CIB Seven MCP - Authenticated</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
      min-height: 100vh; display: flex; align-items: center; justify-content: center;
      background-color: #f4f4f4; color: #1a1a1a; padding: 24px;
    }
    .container {
      background: #fff; width: 100%; max-width: 480px; padding: 48px;
      box-shadow: 0 2px 12px rgba(0,0,0,0.08); border-top: 4px solid #107c10;
    }
    h1 { font-size: 28px; font-weight: 700; margin-bottom: 16px; }
    p { font-size: 16px; line-height: 1.5; color: #5e5e5e; margin-bottom: 24px; }
    .hint { font-size: 14px; color: #5e5e5e; display: flex; align-items: center; }
    .check { display: inline-block; width: 16px; height: 16px; background: #107c10;
      color: #fff; border-radius: 50%; text-align: center; line-height: 16px;
      font-size: 10px; margin-right: 8px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Access Authorized</h1>
    <p>Your CIB Seven MCP server is now authenticated. You can close this window and return to Claude.</p>
    <div class="hint"><span class="check">&#10003;</span> You can close this window.</div>
  </div>
</body>
</html>`;
}

function errorPage(error: string, description: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CIB Seven MCP - Access Denied</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
      min-height: 100vh; display: flex; align-items: center; justify-content: center;
      background-color: #f4f4f4; color: #1a1a1a; padding: 24px;
    }
    .container {
      background: #fff; width: 100%; max-width: 480px; padding: 48px;
      box-shadow: 0 2px 12px rgba(0,0,0,0.08); border-top: 4px solid #e60000;
    }
    h1 { font-size: 28px; font-weight: 700; margin-bottom: 16px; }
    p { font-size: 16px; line-height: 1.5; color: #5e5e5e; margin-bottom: 24px; }
    .error-code { font-family: monospace; background: #f0f0f0; padding: 8px 12px;
      font-size: 14px; display: inline-block; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Access Denied</h1>
    <p>${escapeHtml(description)}</p>
    <div class="error-code">${escapeHtml(error)}</div>
  </div>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
