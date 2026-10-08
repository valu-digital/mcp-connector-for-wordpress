# MCP Connector For WordPress

A local MCP server that bridges Claude Desktop (or any compatible MCP host) to your WordPress site via the [WordPress MCP Adapter](https://github.com/WordPress/mcp-adapter).

Every tool, resource, and prompt registered through the WordPress Abilities API is discovered at runtime and proxied transparently. The connector itself has no built-in WordPress knowledge — the available capabilities depend entirely on the abilities registered on your WordPress site.

---

## Prerequisites

| Requirement                                                       | Notes                                                                                     |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Node.js ≥ 18                                                      | Claude Desktop ships with Node.js 24.13.0 built-in                                        |
| WordPress ≥ 6.8                                                   | Target site                                                                               |
| [WordPress MCP Adapter](https://github.com/WordPress/mcp-adapter) | Must be installed on the WordPress site — this determines what capabilities are available |
| WordPress Abilities API                                           | Abilities must be registered via `wp_register_ability()` for the adapter to expose them   |

---

## Installation

### 1. Download

Download the latest `.mcpb` bundle from [GitHub Releases](https://github.com/valu-digital/mcp-connector-for-wordpress/releases).

### 2. Generate a WordPress Application Password

1. Log in to WordPress as an administrator
2. Go to **Users → Your Profile**
3. Scroll to **Application Passwords**
4. Enter a name (e.g. `Claude Desktop`) and click **Add New Application Password**
5. Copy the generated password — it will look like `xxxx xxxx xxxx xxxx xxxx xxxx`

### 3. Install in Claude Desktop

1. Open Claude Desktop and go to **Settings → Extensions**
2. Click **Advanced settings**
3. Click **Install Extension**
4. Browse and select the downloaded `.mcpb` file
5. Click **Install**, then click **Install** again to confirm
6. Fill in your WordPress site URL, username, and Application Password, then click **Save**
7. Set **Tool permissions** — allow the read-only tools (Discover Abilities, Get Ability Info) and the write tool (Execute Ability) as needed
8. Enable the extension with the toggle

---

## Configuration reference

| Variable                  | Required | Description                                                                                                            |
| ------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------- |
| `WP_API_URL`              | Yes      | Base URL of your WordPress site, e.g. `https://example.com`                                                            |
| `WP_USERNAME`             | Yes      | WordPress administrator username                                                                                       |
| `WP_APP_PASSWORD`         | Yes      | Application Password (spaces allowed)                                                                                  |
| `WP_MCP_PROTOCOL_VERSION` | No       | MCP schema revision: `2025-11-25` (default, session-based) or `2026-07-28` (sessionless, requires MCP Adapter ≥ 0.7.0) |
| `DEBUG`                   | No       | Set to `mcp-connector` for verbose debug output on stderr                                                              |

---

## Available tools

The connector exposes three meta-tools that dynamically proxy capabilities from the [WordPress MCP Adapter](https://github.com/WordPress/mcp-adapter):

| Tool                             | Description                                                                                                                                 | Hint        |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `mcp-adapter-discover-abilities` | List all abilities (tools, resources, prompts) available on the connected WordPress site, with their names, descriptions, and input schemas | Read-only   |
| `mcp-adapter-execute-ability`    | Execute any ability by name with the given arguments — available abilities depend on what is registered on your WordPress site              | Destructive |
| `mcp-adapter-get-ability-info`   | Get detailed information about a specific ability including its full input/output schema                                                    | Read-only   |

### What capabilities will be available?

The connector discovers all abilities at runtime from your WordPress site via the [WordPress MCP Adapter](https://github.com/WordPress/mcp-adapter). The adapter converts abilities registered through the WordPress Abilities API (`wp_register_ability()`) into MCP tools, resources, and prompts.

The exact set of capabilities depends on:

- Which plugins or themes register abilities on your site
- How those abilities are configured
- Which users have permission to access them

Use `mcp-adapter-discover-abilities` to see what is available on your specific site. The adapter may expose **tools** (executable actions), **resources** (read-only data endpoints), and **prompts** (guided workflow templates).

---

## Usage examples

### Example 1: Discover available abilities

**User prompt:**

> What tools are available on my WordPress site?

**What happens:**
The agent calls `mcp-adapter-discover-abilities` to list all tools, resources, and prompts registered on the WordPress site.

**Expected output:**
A categorised list of all abilities available on the connected site, with their names, descriptions, and input schemas.

### Example 2: Get details about a specific ability

**User prompt:**

> Tell me more about the "create-post" tool — what arguments does it accept?

**What happens:**
The agent calls `mcp-adapter-get-ability-info` with `name: "create-post"` to retrieve the full input/output schema.

**Expected output:**
The tool's description, required and optional parameters, their types, and any constraints.

> **Note:** The tool name `create-post` is used here as an illustration. The actual tools available depend on the abilities registered on your WordPress site. Use the discover ability first to see what is available.

### Example 3: Execute an ability

**User prompt:**

> Create a draft blog post titled "Spring Product Launch" with a short intro paragraph.

**What happens:**

1. The agent calls `mcp-adapter-discover-abilities` (if it hasn't already) to find the appropriate tool.
2. The agent calls `mcp-adapter-execute-ability` with the tool name and arguments discovered in step 1.
3. The WordPress site processes the request and returns the result.

**Expected output:**
The result from the WordPress site, such as a confirmation with a post ID and permalink.

> **Note:** This example assumes a post-creation ability is registered on your WordPress site. The exact tool names and arguments depend on the abilities registered via the WordPress Abilities API.

---

## Troubleshooting

**404 — endpoint not found**

- Confirm the [WordPress MCP Adapter](https://github.com/WordPress/mcp-adapter) is installed
- Confirm abilities are registered on the site (the adapter exposes abilities registered via the Abilities API)
- Verify `WP_API_URL` has no trailing slash and matches the site URL exactly

**401 / 403 — authentication failed**

- Re-generate the Application Password in WordPress
- Ensure the username matches exactly (case-sensitive)
- Check that the user has permission to access the registered abilities

**Timeout errors**

- The WordPress site may be slow or unreachable; check server response times
- Set `DEBUG=mcp-connector` to see detailed request logs

**Enable debug logging**
Add `"DEBUG": "mcp-connector"` to the env section in your MCP config. All debug output goes to stderr and will appear in Claude Desktop's MCP server logs.

---

## Privacy

This MCP server acts as a transparent bridge between the MCP host (e.g. Claude Desktop) and your WordPress site. It does **not** collect, store, or transmit any data to third parties.

All communication flows directly from the local MCP server to your WordPress site over HTTPS using your provided credentials. No analytics, telemetry, or tracking is included.

For the full privacy policy, see [PRIVACY.md](https://github.com/valu-digital/mcp-connector-for-wordpress/blob/main/PRIVACY.md).

---

## Support

- **Issues**: [GitHub Issues](https://github.com/valu-digital/mcp-connector-for-wordpress/issues)
- **Author**: [Valu Digital Oy](https://valu.fi)

---

## Development

```bash
# Clone and install
git clone https://github.com/valu-digital/mcp-connector-for-wordpress.git
cd mcp-connector-for-wordpress
npm install

# Build
npm run build

# Build in watch mode
npm run dev

# Run all checks (typecheck + lint + format)
npm run check

# Run directly with env vars
WP_API_URL=https://your-site.com \
WP_USERNAME=admin \
WP_APP_PASSWORD="xxxx xxxx xxxx xxxx" \
DEBUG=mcp-connector \
node dist/index.js
```

To test with Claude Desktop, add this to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mcp-connector-for-wordpress": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-connector-for-wordpress/dist/index.js"],
      "env": {
        "WP_API_URL": "https://your-site.com",
        "WP_USERNAME": "your-wp-username",
        "WP_APP_PASSWORD": "xxxx xxxx xxxx xxxx xxxx xxxx"
      }
    }
  }
}
```

The server speaks MCP over stdin/stdout. Use the [MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector) for interactive testing:

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

---

## License

GPL-2.0-or-later

---

## Credits

Built by [Valu Digital Oy](https://valu.fi).
