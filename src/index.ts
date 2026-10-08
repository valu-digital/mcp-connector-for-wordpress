/**
 * MCP Connector for WordPress — local MCP server (stdio) → WordPress MCP HTTP bridge.
 *
 * All WordPress tools, resources, and prompts are discovered dynamically from
 * the remote WordPress MCP adapter at startup and proxied transparently.
 *
 * Environment variables (injected by the MCPB host from user_config):
 *   WP_API_URL       — base URL of the WordPress site, e.g. https://example.com
 *   WP_USERNAME      — WordPress username (administrator)
 *   WP_APP_PASSWORD  — WordPress Application Password (spaces allowed)
 *   WP_MCP_PROTOCOL_VERSION — MCP protocol revision: 2025-11-25 (default) or 2026-07-28
 *   DEBUG            — set to "mcp-connector" for verbose debug logging
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { WordPressClient, parseProtocolVersion } from "./wp-client.js";
import { log } from "./logger.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    log.error(`Missing required environment variable: ${name}`);
    log.error(
      "Configure WP_API_URL, WP_USERNAME, and WP_APP_PASSWORD in the bundle settings.",
    );
    process.exit(1);
  }
  return value;
}

function resolveProtocolVersion() {
  try {
    return parseProtocolVersion(process.env.WP_MCP_PROTOCOL_VERSION);
  } catch (err) {
    log.error((err as Error).message);
    process.exit(1);
  }
}

const protocolVersion = resolveProtocolVersion();

const wpClient = new WordPressClient({
  baseUrl: requireEnv("WP_API_URL"),
  username: requireEnv("WP_USERNAME"),
  appPassword: requireEnv("WP_APP_PASSWORD"),
  protocolVersion,
});

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "mcp-connector-for-wordpress", version: "0.2.0" },
  {
    capabilities: {
      tools: {},
      resources: {},
      prompts: {},
    },
  },
);

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return (await wpClient.request("tools/list", {})) as {
    tools: unknown[];
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  log.debug(`Tool call: ${name}`);

  try {
    return (await wpClient.request("tools/call", {
      name,
      arguments: args ?? {},
    })) as { content: unknown[] };
  } catch (err) {
    log.error(`Tool "${name}" failed:`, (err as Error).message);
    return {
      content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
      isError: true,
    };
  }
});

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return (await wpClient.request("resources/list", {})) as {
    resources: unknown[];
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  log.debug(`Resource read: ${request.params.uri}`);
  return (await wpClient.request("resources/read", {
    uri: request.params.uri,
  })) as { contents: unknown[] };
});

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

server.setRequestHandler(ListPromptsRequestSchema, async () => {
  return (await wpClient.request("prompts/list", {})) as {
    prompts: unknown[];
  };
});

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  log.debug(`Prompt: ${request.params.name}`);
  return (await wpClient.request("prompts/get", {
    name: request.params.name,
    arguments: request.params.arguments,
  })) as { messages: unknown[] };
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

process.on("uncaughtException", (err) => {
  log.error("Uncaught exception:", err);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  log.error("Unhandled rejection:", String(reason));
  process.exit(1);
});

async function main(): Promise<void> {
  log.info("Starting MCP Connector for WordPress…");

  // Connect the stdio transport FIRST so the MCP host completes its handshake.
  // WordPress session initialisation happens lazily on the first request —
  // attempting it before the transport is connected causes the host to close
  // the connection because it receives no MCP response to its own initialize.
  const transport = new StdioServerTransport();
  await server.connect(transport);

  log.info(
    protocolVersion === "2026-07-28"
      ? "Ready — requests are sessionless (MCP 2026-07-28)"
      : "Ready — WordPress session will be established on first request",
  );
}

main().catch((err) => {
  log.error("Fatal startup error:", err);
  process.exit(1);
});
