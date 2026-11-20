# Roadmap

The Conclave project's Blueprint holds priorities, milestones, and verification status. This page lists candidate improvements. Supported behavior is in the [platform requirements](requirements.md).

The [workflow repair package](workflow-repairs.md) proposes a release focused on six defects in vault editing, review hand-offs and operator decisions. It uses the [functional design](specification.md#functional-design) to explain which user outcomes each fix protects. The [November implementation brief](next-release.md) records the broader target requirements, delivery order and acceptance journeys.

Guest access, OAuth/cloud connectors, direct peer-to-peer transfers, agent process management, multi-instance deployment, additional storage providers, and a tamper-evident audit chain require a separate design decision. Keep work tied to a requirement or a risk in the Blueprint.

## Platform improvements

- **Publication and recovery.** Apply the current share authorization decision at publication for all upload paths, keep bridge snapshots separate from drafts, reclaim abandoned open transfers, and reconcile the graph after vault write-intent recovery.
- **Team moves.** Preserve stable Blueprint references and define which project owns historical task events after a team changes projects.

- **Task hand-off visibility.** Surface unseen hand-offs and overdue reviews in the console. Use the existing task turns, seen state, and deadlines to distinguish pickup waits from work that has started.
- **Operator attention.** Bring actionable conditions together in one scoped list, with per-team visibility settings and audited dismissal where appropriate.
- **Blueprint.** Share the schema and allowable acts across console views and write checks. Clarify single-team scope, dropped-item handling, and which items count toward limits. Evaluate staged validation for multi-operation writes and a restore format that verifies provenance and version boundaries.
- **Evidence direction.** Let an evidence link say whether a finding supports or contradicts its item, so the Findings and Hypotheses lists can filter and flag contradictions. This needs its own design: the write rules and rights, the rules agents read, export and restore, and the guidance agents get.
- **Project setup.** Capture settings once across enrolment, approval, and the team's Blueprint. Show which setup steps are complete and which need operator action.
- **Team roles.** Evaluate explicit repository ownership, separation of testing, review and release responsibilities, and research governance roles. The current [role model](roles.md) uses team playbooks and scoped grants.
- **Capacity and health.** Extend quota coverage by key, team, and PC (`NFR-OPS-02`). Consolidate host and database health, storage, traffic, latency, errors, and transfers into an operator view (`FR-OPS-02`).
- **Desktop verification.** Exercise checkout on a second OS account and PC, and validate the Codex configuration, trust, and restore flow with a real client before enabling that provider. See the [checkout acceptance matrix](acceptance.md#checkout).

## Candidate workflows for external review

Existing policy rules, shares and checkpoints cover parts of an external review workflow. Validate these candidates before relying on blind review.

- Test sealed source scopes across vault reads, derived graph data, job delivery, tasks, notices, downloads, shares and channels. Evaluate an explicit no-export policy for material that may be read locally but must stay inside the deployment.
- Consider reviewer aliases and review rounds pinned to a commit or tag, with feedback visible to other reviewers only after the round closes. Preserve round, artifact and reviewer provenance in feedback exports. The repository retains authority over commits and tags.
- Keep operator approval explicit and auditable. Agent text cannot substitute for it. Evaluate per-task approval where a team-wide checkpoint is too coarse.
- Measure token and call costs across setup, work, curation and review. Include cold graph coverage, repeated result content, relevance and backfill cost. Check reviewer reassignment, queue fairness and curator quotas under load.
