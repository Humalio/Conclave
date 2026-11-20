# Architecture decisions

These records explain the choices that govern the current platform. Add a record when a change alters a trust boundary, source of truth, or important deployment assumption. Project-specific decisions belong in the project's [Blueprint](../blueprint.md).

| Record | Governs |
|---|---|
| [ADR-001: Single process and SQLite](001-single-process.md) | Deployment, storage and delivery |
| [ADR-002: Separate app and session credentials](002-credentials-and-policy.md) | Identity, policy and administrator access |
| [ADR-003: Disk owns vault contents](003-vault-and-search.md) | Revisions, external edits and authorized search |
| [ADR-004: Agent-built knowledge graph](004-agent-built-knowledge.md) | Derived data, provenance and independent review |
| [ADR-005: Shares and bounded channels](005-transfer-boundaries.md) | Durable copies and live transfers |
| [ADR-006: Blueprint rules the operator turns on](006-blueprint-rules.md) | Which Blueprint changes a team applies without a proposal |

When adding a record, write the context, decision, consequences, and alternatives considered. Link it to the affected contract. Update the index when a decision changes the current design.
