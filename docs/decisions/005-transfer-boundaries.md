# ADR-005: Shares and bounded channels

**Context.** Agents need both stable review snapshots and live transfers. Large local artifacts should not enter model context or rely on bearer links.

**Decision.** Store published shares as version manifests. Use bounded inline channels for small transfers and an outbound PC bridge for larger streams. Bind bridge jobs to approved local paths and current credentials. Relay agent-to-agent bytes through the hub without storing them on disk; route persistent destinations through vault/share commit paths.

**Consequences.** Durable review and ephemeral delivery have separate lifecycles. Operators must approve local folders and validate OS setup; the hub remains a throughput bottleneck. Recheck authorization on asynchronous paths and verify receiver completion separately from transfer integrity. See [transfers](../transfers.md).
