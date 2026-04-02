# Privacy Policy

**MCP Connector For WordPress**
Last updated: 2026-04-01

## Overview

MCP Connector For WordPress ("the Connector") is a local MCP server that acts as a transparent bridge between an MCP host application (e.g. Claude Desktop) and a remote WordPress site. This privacy policy describes what data the Connector processes and how it is handled.

## What data the Connector processes

The Connector processes the following data in transit between the MCP host and your WordPress site:

- **Authentication credentials** — Your WordPress username and Application Password, used to authenticate requests to your WordPress site. These are stored locally in your MCP host configuration and transmitted to your WordPress site via HTTPS using HTTP Basic Authentication.
- **MCP protocol messages** — Tool calls, resource reads, and prompt requests exchanged between the MCP host and your WordPress site. The content of these messages depends on the abilities registered on your WordPress site and the requests made by the AI agent.
- **Session identifiers** — A session ID provided by the WordPress MCP Adapter, held in memory for the duration of the connection.

## What the Connector does NOT do

- **No data collection** — The Connector does not collect, store, aggregate, or analyse any personal data or usage data.
- **No third-party transmission** — The Connector does not send data to any party other than your WordPress site. There are no analytics, telemetry, tracking pixels, or advertising integrations.
- **No persistent storage** — The Connector does not write any data to disk. All processed data exists only in memory for the duration of the session.
- **No logging of personal data** — Debug logs (when enabled) are written to local stderr only and do not contain authentication credentials or personal data.

## Data flow

All data flows directly between two endpoints controlled by you:

1. **Your local machine** — where the MCP host and the Connector run
2. **Your WordPress site** — where the WordPress MCP Adapter processes requests

No intermediary servers, cloud services, or third-party infrastructure are involved in the data flow.

## Legal basis for processing (GDPR Art. 6)

The Connector processes data solely to perform the service you have configured it to provide — bridging MCP protocol messages to your WordPress site. The legal basis for this processing is:

- **Art. 6(1)(b)** — Processing necessary for the performance of the service at the user's request.
- **Art. 6(1)(f)** — Legitimate interest in enabling the configured integration, where no personal data is retained or shared beyond what is strictly necessary for the request-response cycle.

## Data retention

The Connector retains no data beyond the active session. When the process exits, all in-memory data (session IDs, message content) is discarded. No data is written to persistent storage.

## Data transfers

The Connector communicates with the WordPress site URL you configure. If your WordPress site is hosted outside the European Economic Area (EEA), the data transfer to that site is initiated and controlled by you. The Connector itself does not determine or influence where your WordPress site is hosted.

## Your rights

Under the GDPR, you have the right to access, rectify, erase, restrict processing of, and port your personal data. Since the Connector does not collect or store any personal data, these rights are most relevant in relation to the data stored on your WordPress site, which is governed by your WordPress site's own privacy policy.

## Security

- All communication with the WordPress site uses HTTPS (TLS encryption in transit).
- Authentication credentials are transmitted using HTTP Basic Authentication over HTTPS.
- For local development environments using self-signed certificates, TLS verification is disabled automatically with a warning logged to stderr.

## Changes to this policy

Updates to this privacy policy will be published in the project repository at https://github.com/valu-digital/mcp-connector-for-wordpress. The "Last updated" date at the top of this document indicates when the policy was last revised.

## Contact

For questions about this privacy policy or the Connector's data practices, contact:

Valu Digital Oy
Email: info@valu.fi
https://valu.fi
