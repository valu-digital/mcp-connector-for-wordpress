/**
 * WordPress MCP HTTP client.
 *
 * Bridges local MCP stdio transport → remote WordPress MCP HTTP endpoint.
 * The WordPress MCP adapter exposes a JSON-RPC 2.0 endpoint at:
 *   <site>/wp-json/mcp/mcp-adapter-default-server
 *
 * Session lifecycle:
 *   1. POST initialize (no session header) → receive Mcp-Session-Id in response header
 *   2. All subsequent requests include Mcp-Session-Id header
 *   3. Sessions expire after 24 h of inactivity; client reinitialises automatically
 */

import { log } from "./logger.js";

const TIMEOUT_MS = 30_000;
const MAX_RETRIES = 1;

/**
 * Local development TLD patterns that use self-signed certificates.
 * NODE_TLS_REJECT_UNAUTHORIZED is set to '0' automatically for these hosts.
 */
const LOCAL_DEV_TLDS = [".test", ".local", ".localhost", ".internal", ".dev"];

function isLocalDevUrl(urlString: string): boolean {
  try {
    const { hostname } = new URL(urlString);
    if (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1"
    ) {
      return true;
    }
    return LOCAL_DEV_TLDS.some((tld) => hostname.endsWith(tld));
  } catch {
    return false;
  }
}

interface WordPressClientConfig {
  baseUrl: string;
  username: string;
  appPassword: string;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: JsonRpcError;
}

export class WordPressClient {
  private endpoint: string;
  private authHeader: string;
  private sessionId: string | null = null;
  private requestId = 0;
  private initializing: Promise<unknown> | null = null;

  constructor({ baseUrl, username, appPassword }: WordPressClientConfig) {
    const url = baseUrl.replace(/\/+$/, "");
    this.endpoint = `${url}/wp-json/mcp/mcp-adapter-default-server`;
    this.authHeader = `Basic ${Buffer.from(`${username}:${appPassword}`).toString("base64")}`;

    if (isLocalDevUrl(url)) {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
      log.warn(
        `TLS certificate verification disabled for local dev URL: ${url}`,
      );
    }

    log.debug(`Endpoint: ${this.endpoint}`);
  }

  /**
   * Send the MCP initialize handshake and capture the session ID.
   * Concurrent callers share a single in-flight promise.
   */
  async initialize(): Promise<unknown> {
    if (this.initializing) return this.initializing;

    this.initializing = this.doInitialize().finally(() => {
      this.initializing = null;
    });

    return this.initializing;
  }

  private async doInitialize(): Promise<unknown> {
    log.info("Initializing WordPress MCP session…");
    this.sessionId = null;

    const response = await this.post({
      jsonrpc: "2.0",
      id: this.nextId(),
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: {
          name: "mcp-connector-for-wordpress",
          version: "0.1.0",
        },
      },
    });

    if (response.error) {
      throw this.rpcError("initialize", response.error);
    }

    const serverInfo = (
      response.result as { serverInfo?: { name?: string; version?: string } }
    )?.serverInfo;
    log.info(
      `Session established — server: ${serverInfo?.name ?? "WordPress MCP"} ${serverInfo?.version ?? ""}`.trimEnd(),
    );
    return response.result;
  }

  /**
   * Send an MCP JSON-RPC request, reinitialising the session if it has expired.
   */
  async request(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    if (!this.sessionId) {
      await this.initialize();
    }

    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        log.debug(`→ ${method}`);
        const response = await this.post({
          jsonrpc: "2.0",
          id: this.nextId(),
          method,
          params,
        });

        if (response.error) {
          if (this.isSessionError(response.error)) {
            log.warn(`Session error on ${method}, reinitialising…`);
            this.sessionId = null;
            await this.initialize();
            continue;
          }
          throw this.rpcError(method, response.error);
        }

        log.debug(`← ${method} OK`);
        return response.result;
      } catch (err) {
        lastError = err as Error;
        if (attempt < MAX_RETRIES && this.isRetryable(lastError)) {
          log.warn(`Retrying ${method} (attempt ${attempt + 1})…`);
          this.sessionId = null;
          try {
            await this.initialize();
          } catch {
            /* ignore init error on retry */
          }
          continue;
        }
        throw err;
      }
    }

    throw lastError;
  }

  private async post(body: JsonRpcRequest): Promise<JsonRpcResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: this.authHeader,
      "User-Agent": "mcp-connector-for-wordpress/0.1.0",
    };

    if (this.sessionId) {
      headers["Mcp-Session-Id"] = this.sessionId;
    }

    let res: Response;
    try {
      res = await fetch(this.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        throw new Error(
          `WordPress MCP request timed out after ${TIMEOUT_MS / 1000}s (${body.method}). ` +
            "Check that the WordPress site is reachable.",
        );
      }
      throw new Error(
        `Network error reaching ${this.endpoint}: ${(err as Error).message}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      switch (res.status) {
        case 401:
          throw new Error(
            "WordPress authentication failed (401). " +
              "Verify your username and Application Password in the bundle settings.",
          );
        case 403:
          throw new Error(
            "WordPress access denied (403). " +
              'The WordPress user must have the "read" capability or higher. ' +
              "Check the MCP Connector allowed-users setting.",
          );
        case 404:
          throw new Error(
            `WordPress MCP endpoint not found (404) at ${this.endpoint}. ` +
              "Ensure the MCP Connector plugin is active, MCP is enabled in Settings, " +
              "and your WP_API_URL is correct.",
          );
        default:
          throw new Error(
            `WordPress MCP HTTP ${res.status}: ${text.slice(0, 300)}`,
          );
      }
    }

    const sessionId = res.headers.get("Mcp-Session-Id");
    if (sessionId && sessionId !== this.sessionId) {
      this.sessionId = sessionId;
      log.debug(`Session ID: ${sessionId}`);
    }

    let json: JsonRpcResponse;
    try {
      json = (await res.json()) as JsonRpcResponse;
    } catch {
      throw new Error(
        "WordPress MCP returned non-JSON response. Is the endpoint correct?",
      );
    }

    return json;
  }

  private nextId(): number {
    return ++this.requestId;
  }

  private rpcError(method: string, error: JsonRpcError): Error {
    return new Error(
      `WordPress MCP error in "${method}": [${error.code}] ${error.message}` +
        (error.data ? ` — ${JSON.stringify(error.data)}` : ""),
    );
  }

  private isSessionError(error: JsonRpcError): boolean {
    const msg = (error.message ?? "").toLowerCase();
    return (
      error.code === -32001 ||
      msg.includes("session") ||
      msg.includes("expired")
    );
  }

  private isRetryable(err: Error): boolean {
    const msg = err.message ?? "";
    return (
      msg.includes("Network error") ||
      msg.includes("timed out") ||
      msg.includes("ECONNREFUSED") ||
      msg.includes("ECONNRESET")
    );
  }
}
