# Risk register

These risks remain relevant to the platform. The project's [Blueprint](blueprint.md) tracks owners, actions, and review status. See the [threat model](threat-model.md) for controls at each boundary.

| Risk | Operational implication |
|---|---|
| R01 · Client credentials | A session with local shell access may read client credentials or another session's handoff. Isolate client configuration and scope credentials to the work. |
| R02 · Untrusted content | Prompt injection or an authorized reader can relay confidential material. Treat embedded instructions as data and scope outbound grants. |
| R03 · Derived disclosure | Paths, counts, provenance, and graph results can reveal restricted information. Test filtering on mixed-visibility data and after revocation. |
| R04 · External filesystem changes | External writers can race the final check or change a file between observations. Keep independent vault history. |
| R05 · Path confinement | Filesystem differences and link races can affect confinement. Verify the supported filesystems and approve narrow local roots. |
| R06 · Privileged access and transport | A compromised administrator or host can expose data and keys. Isolate the service and use HTTPS where credentials cross a network. |
| R07 · Growth | Retained revisions, logs, messages, and stalled transfers consume disk or memory. Monitor storage and rehearse recovery under resource pressure. |
| R08 · Client compatibility | Client upgrades can change auth, tool discovery, and polling. Verify the intended client and transport before rollout. |
| R09 · Transfers | Bridge installation and resume depend on the local machine, readable source files, and recoverable offsets. Exercise interruption on the target environment. |
| R10 · Single failure domain | A single hub outage interrupts coordination. Restore the database, blobs, vault, and credential pepper together, and verify recovered vault data and graph coverage. |

### Retained data and host access

A deleted note may survive in revisions, backups, shares or derived graph evidence. Protect those stores at the same trust level as the vault. Retention of unreferenced blobs does not remove referenced history. The current audit log depends on host and database integrity, so someone with database write access can alter it. Keep vault and state backups access-controlled, and include retention and restore in deployment checks.
