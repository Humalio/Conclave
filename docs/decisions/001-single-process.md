# ADR-001: Single process and SQLite

**Context.** A small self-hosted hub needs durable policy, audit, and coordination with minimal operator setup.

**Decision.** Use Node.js and TypeScript in one Fastify process with SQLite WAL and explicit migrations. Use stateless MCP requests and application login tokens instead of depending on a transport session. Persist room sequences and work items; use bounded pull with acknowledgements instead of requiring push connections or a broker.

**Consequences.** One instance is straightforward to deploy and back up. Delivery can repeat and presence is inferred from recorded signals. Poll wakeups, path locks and relay buffers are local to the process; adding replicas requires a new consistency and coordination model. See [architecture](../architecture.md).
