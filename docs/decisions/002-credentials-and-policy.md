# ADR-002: Separate app and session credentials

**Context.** A desktop app can share one MCP configuration across many conversations. The device, a model label, and transport state cannot identify which job is authorized.

**Decision.** Authenticate the client installation with an app bearer and the conversation with a separate session key exchanged for an app-bound token. Apply deterministic rule lists with default deny, explicit deny precedence and an app cap. Treat templates as copied rules, and team/temporary grants as scoped sources subject to the same checks. Keep administration on a separate cookie/CSRF boundary with scrypt passwords and optional TOTP. Do not add guest or OAuth entry points to this deployment model.

**Consequences.** Different conversations using one app can receive independent grants, and the operator can narrow or revoke them centrally. Session handoffs still contain bearer credentials; possession can impersonate the session. Policy remains inspectable, but the simulator must account for app caps and dynamic domain state when claiming to show effective access. See [specification](../specification.md) and [threat model](../threat-model.md).
