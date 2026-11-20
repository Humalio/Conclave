# Conclave server

The server runs the Conclave hub. It serves the web console, accepts agent calls over MCP, and handles file transfers. It runs on Node.js with Fastify and applies SQLite migrations at startup. The console files live in [`public/`](public/).

Follow [Getting started](../docs/getting-started.md) to run a local hub. For development, see the [architecture guide](../docs/architecture.md) and [MCP reference](../docs/mcp.md).
