/**
 * WordPress MCP HTTP client.
 *
 * Bridges local MCP stdio transport → remote WordPress MCP HTTP endpoint.
 * The WordPress MCP adapter exposes a JSON-RPC 2.0 endpoint at:
 *   <site>/wp-json/mcp/mcp-adapter-default-server
 *
 * Two MCP protocol revisions are supported (MCP Adapter ≥ 0.7.0):
 *
 * 2025-11-25 — session-based lifecycle:
 *   1. POST initialize (no session header) → receive Mcp-Session-Id in response header
 *   2. All subsequent requests include Mcp-Session-Id and MCP-Protocol-Version headers
 *   3. Sessions expire after 24 h of inactivity; client reinitialises automatically
 *
 * 2026-07-28 — sessionless:
 *   Every request carries protocol version, client capabilities, and client info
 *   in params._meta, mirrored by MCP-Protocol-Version, Mcp-Method, Mcp-Name, and
 *   any Mcp-Param-* headers declared by the tool's input schema (x-mcp-header).
 */

import { log } from "./logger.js";

const TIMEOUT_MS = 30_000;
const MAX_RETRIES = 1;

const CLIENT_INFO = {
  name: "mcp-connector-for-wordpress",
  version: "0.2.0",
};

export const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2026-07-28",
] as const;

export type ProtocolVersion = (typeof SUPPORTED_PROTOCOL_VERSIONS)[number];

export const DEFAULT_PROTOCOL_VERSION: ProtocolVersion = "2025-11-25";

/**
 * Resolve a configured protocol version, falling back to the default when empty.
 * Throws for values the WordPress MCP Adapter does not support.
 */
export function parseProtocolVersion(
  value: string | undefined,
): ProtocolVersion {
  const trimmed = value?.trim();
  if (!trimmed) return DEFAULT_PROTOCOL_VERSION;

  const match = SUPPORTED_PROTOCOL_VERSIONS.find((v) => v === trimmed);
  if (!match) {
    throw new Error(
      `Unsupported MCP protocol version "${trimmed}". ` +
        `Use one of: ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")}.`,
    );
  }
  return match;
}

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

/**
 * Encode a header value, using the MCP Base64 sentinel for anything that is not
 * plain printable ASCII or that HTTP would strip (leading/trailing whitespace).
 */
function encodeHeaderValue(value: string): string {
  if (/^[\x21-\x7E]([\x20-\x7E]*[\x21-\x7E])?$/.test(value) || value === "") {
    return value;
  }
  return `=?base64?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

interface WordPressClientConfig {
  baseUrl: string;
  username: string;
  appPassword: string;
  protocolVersion: ProtocolVersion;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number;
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

/** A tool input property mirrored into an Mcp-Param-* header (2026-07-28). */
interface HeaderAnnotation {
  name: string;
  path: string[];
}

export class WordPressClient {
  private endpoint: string;
  private authHeader: string;
  private protocolVersion: ProtocolVersion;
  private sessionId: string | null = null;
  private negotiatedVersion: string | null = null;
  private requestId = 0;
  private initializing: Promise<unknown> | null = null;
  private toolHeaderAnnotations = new Map<string, HeaderAnnotation[]>();

  constructor({
    baseUrl,
    username,
    appPassword,
    protocolVersion,
  }: WordPressClientConfig) {
    const url = baseUrl.replace(/\/+$/, "");
    this.endpoint = `${url}/wp-json/mcp/mcp-adapter-default-server`;
    this.authHeader = `Basic ${Buffer.from(`${username}:${appPassword}`).toString("base64")}`;
    this.protocolVersion = protocolVersion;

    if (isLocalDevUrl(url)) {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
      log.warn(
        `TLS certificate verification disabled for local dev URL: ${url}`,
      );
    }

    log.debug(`Endpoint: ${this.endpoint}`);
    log.info(`MCP protocol version: ${this.protocolVersion}`);
  }

  private get isSessionless(): boolean {
    return this.protocolVersion === "2026-07-28";
  }

  /**
   * Send the MCP initialize handshake and capture the session ID.
   * Concurrent callers share a single in-flight promise.
   * Only used by the session-based 2025-11-25 lifecycle.
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
    this.negotiatedVersion = null;

    const response = await this.post({
      jsonrpc: "2.0",
      id: this.nextId(),
      method: "initialize",
      params: {
        protocolVersion: this.protocolVersion,
        capabilities: {},
        clientInfo: CLIENT_INFO,
      },
    });

    if (response.error) {
      throw this.rpcError("initialize", response.error);
    }

    const result = response.result as {
      protocolVersion?: string;
      serverInfo?: { name?: string; version?: string };
    };
    this.negotiatedVersion = result?.protocolVersion ?? this.protocolVersion;
    if (this.negotiatedVersion !== this.protocolVersion) {
      log.warn(
        `Server negotiated protocol ${this.negotiatedVersion} instead of ${this.protocolVersion}`,
      );
    }

    try {
      await this.post({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      });
    } catch (err) {
      log.debug(
        "notifications/initialized failed (ignored):",
        (err as Error).message,
      );
    }

    const serverInfo = result?.serverInfo;
    log.info(
      `Session established — server: ${serverInfo?.name ?? "WordPress MCP"} ${serverInfo?.version ?? ""}`.trimEnd(),
    );
    return result;
  }

  /**
   * Send an MCP JSON-RPC request using the configured protocol revision.
   * In 2025-11-25 mode the session is reinitialised if it has expired.
   */
  async request(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const result = this.isSessionless
      ? await this.requestSessionless(method, params)
      : await this.requestWithSession(method, params);

    if (method === "tools/list") {
      this.cacheToolHeaderAnnotations(result);
    }
    return result;
  }

  private async requestWithSession(
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
          if (attempt < MAX_RETRIES && this.isSessionError(response.error)) {
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

  private async requestSessionless(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const existingMeta =
      params._meta && typeof params._meta === "object"
        ? (params._meta as Record<string, unknown>)
        : {};
    const body: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 0,
      method,
      params: {
        ...params,
        _meta: {
          ...existingMeta,
          "io.modelcontextprotocol/protocolVersion": this.protocolVersion,
          "io.modelcontextprotocol/clientCapabilities": {},
          "io.modelcontextprotocol/clientInfo": CLIENT_INFO,
        },
      },
    };
    const headers = await this.sessionlessHeaders(method, params);

    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        log.debug(`→ ${method}`);
        const response = await this.post(
          { ...body, id: this.nextId() },
          headers,
        );

        if (response.error) {
          throw this.rpcError(method, response.error);
        }

        log.debug(`← ${method} OK`);
        return response.result;
      } catch (err) {
        lastError = err as Error;
        if (attempt < MAX_RETRIES && this.isRetryable(lastError)) {
          log.warn(`Retrying ${method} (attempt ${attempt + 1})…`);
          continue;
        }
        throw err;
      }
    }

    throw lastError;
  }

  /**
   * Build the per-request headers that mirror the 2026-07-28 request body.
   */
  private async sessionlessHeaders(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      "MCP-Protocol-Version": this.protocolVersion,
      "Mcp-Method": method,
    };

    const nameField =
      method === "resources/read"
        ? "uri"
        : method === "tools/call" || method === "prompts/get"
          ? "name"
          : null;
    const name = nameField ? params[nameField] : undefined;
    if (typeof name === "string") {
      headers["Mcp-Name"] = encodeHeaderValue(name);
    }

    if (method === "tools/call" && typeof name === "string") {
      const args =
        params.arguments && typeof params.arguments === "object"
          ? (params.arguments as Record<string, unknown>)
          : {};
      for (const annotation of await this.getToolHeaderAnnotations(name)) {
        const value = this.valueAtPath(args, annotation.path);
        if (value === undefined || value === null) continue;
        headers[`Mcp-Param-${annotation.name}`] = encodeHeaderValue(
          String(value),
        );
      }
    }

    return headers;
  }

  /**
   * Look up a tool's x-mcp-header annotations, refreshing the tool list once
   * when the tool has not been seen yet.
   */
  private async getToolHeaderAnnotations(
    toolName: string,
  ): Promise<HeaderAnnotation[]> {
    if (!this.toolHeaderAnnotations.has(toolName)) {
      try {
        let cursor: string | undefined;
        do {
          const page = (await this.requestSessionless(
            "tools/list",
            cursor ? { cursor } : {},
          )) as { nextCursor?: string };
          this.cacheToolHeaderAnnotations(page);
          cursor = page?.nextCursor;
        } while (cursor);
      } catch (err) {
        log.warn(
          `Could not refresh tool list for "${toolName}":`,
          (err as Error).message,
        );
      }
    }
    return this.toolHeaderAnnotations.get(toolName) ?? [];
  }

  private cacheToolHeaderAnnotations(result: unknown): void {
    const tools = (result as { tools?: unknown[] })?.tools;
    if (!Array.isArray(tools)) return;

    for (const tool of tools as { name?: unknown; inputSchema?: unknown }[]) {
      if (typeof tool?.name !== "string") continue;
      const annotations: HeaderAnnotation[] = [];
      this.scanHeaderAnnotations(tool.inputSchema, [], annotations);
      this.toolHeaderAnnotations.set(tool.name, annotations);
    }
  }

  /**
   * Collect x-mcp-header annotations reachable through nested "properties"
   * keywords only, matching how the WordPress MCP Adapter validates them.
   */
  private scanHeaderAnnotations(
    schema: unknown,
    path: string[],
    out: HeaderAnnotation[],
  ): void {
    if (!schema || typeof schema !== "object") return;
    const properties = (schema as { properties?: unknown }).properties;
    if (!properties || typeof properties !== "object") return;

    for (const [key, property] of Object.entries(properties)) {
      if (!property || typeof property !== "object") continue;
      const propertyPath = [...path, key];
      const headerName = (property as Record<string, unknown>)["x-mcp-header"];
      if (typeof headerName === "string") {
        out.push({ name: headerName, path: propertyPath });
      }
      this.scanHeaderAnnotations(property, propertyPath, out);
    }
  }

  private valueAtPath(args: Record<string, unknown>, path: string[]): unknown {
    let value: unknown = args;
    for (const segment of path) {
      if (!value || typeof value !== "object" || !(segment in value)) {
        return undefined;
      }
      value = (value as Record<string, unknown>)[segment];
    }
    return value;
  }

  private async post(
    body: JsonRpcRequest,
    extraHeaders: Record<string, string> = {},
  ): Promise<JsonRpcResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: this.authHeader,
      "User-Agent": "mcp-connector-for-wordpress/0.2.0",
      ...extraHeaders,
    };

    if (this.sessionId) {
      headers["Mcp-Session-Id"] = this.sessionId;
    }
    if (this.negotiatedVersion && body.method !== "initialize") {
      headers["MCP-Protocol-Version"] = this.negotiatedVersion;
    }

    let res: Response;
    let text: string;
    try {
      res = await fetch(this.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      text = await res.text();
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

    const sessionId = res.headers.get("Mcp-Session-Id");
    if (sessionId && sessionId !== this.sessionId) {
      this.sessionId = sessionId;
      log.debug(`Session ID: ${sessionId}`);
    }

    // Notifications have no response body worth parsing.
    if (body.id === undefined) {
      return { jsonrpc: "2.0", id: 0 };
    }

    let json: JsonRpcResponse | undefined;
    try {
      json = JSON.parse(text) as JsonRpcResponse;
    } catch {
      json = undefined;
    }

    // The adapter reports protocol errors with non-2xx HTTP statuses
    // (e.g. 400 for header mismatches, 404 for unknown sessions), so a
    // JSON-RPC error body takes precedence over the generic HTTP message.
    if (!res.ok && !json?.error) {
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

    if (!json) {
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
    if (error.code === -32022) {
      return new Error(
        `WordPress MCP Adapter does not support protocol ${this.protocolVersion}` +
          (error.data ? ` — ${JSON.stringify(error.data)}` : "") +
          ". Update the MCP Adapter plugin (≥ 0.7.0) or change the MCP protocol version setting.",
      );
    }
    return new Error(
      `WordPress MCP error in "${method}": [${error.code}] ${error.message}` +
        (error.data ? ` — ${JSON.stringify(error.data)}` : ""),
    );
  }

  private isSessionError(error: JsonRpcError): boolean {
    const msg = (error.message ?? "").toLowerCase();
    return (
      error.code === -32005 ||
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
