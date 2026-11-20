# Next-release candidate · Make current workflows reliable

Design review of the implementation as of 18 November 2026. These are proposed work packages for the Conclave Blueprint. The earlier [implementation brief](next-release.md) records the broader product decisions. This package addresses six observed problems in the existing workflows.

## How the same work fits a simpler model

The main complexity for a user is reconciling several answers to one question. A team count can point at a hub-wide list. An approved task can have reached its checkpoint with or without a reviewer. The hub already knows the scope of the list, the current task turn and the events behind approval. Use those facts wherever someone enters the workflow. The [functional design](specification.md#functional-design) gives the user requirements.

| When someone wants to… | Path through existing records | What this simplifies |
|---|---|---|
| Set up collaboration | Approve the requested project/team or folder scope, then use the existing project or Vault landing. Consult the access inspector for a specific agent action. | A folder-only collaborator can edit a shared note without passing through team setup. A team can keep its own roles and playbook. |
| Deliver implementation or research work | Start with the Blueprint requirement, hypothesis or milestone. Follow its links to tasks, papers or evidence. On a task, use the current holder and turn to find the next action. | People can follow the result from the plan. Workers and reviewers pick up the same task through their existing delivery mode. |
| Make a decision | Enter Needs you from Home, project or team. Carry that scope to the question, proposal, checkpoint or backlog. Resolve it at the source and return to the same scope. | The person can act from any entrance without reselecting the team or reconciling counts by hand. |
| Inspect an outcome or recover work | Use the task's submission and review events, a note's revision history, or the existing checkout step and handout for a team move. Use activity and audit to trace who acted. | Each of these answers a different question about evidence. A user can inspect the relevant record only when the detail matters. |

**Design trade-off.** A single status such as “waiting” would hide whether a worker should start, a reviewer should give a verdict, or a person should answer a question. Keep the detailed lifecycle and approval boundaries. Lead with the next actor and action, and show the recorded state and evidence in the detail. Apply this to current screens and MCP responses as the affected workflows are repaired. The release can ship in small fixes using the existing records, routes and task states.

## Release tasks, in priority order

### 1. Preserve edits made while a vault save is in flight

**Observed.** In the shared operator and member editor, Save sends the text currently in the field. When the response arrives, the handler marks the *then-current* field value saved, clears the dirty flag and leaves the editor. In a delayed-response check, the request contained draft A, the field contained draft B, and the editor exited. The extra text was never sent. See `vedWire` and its two callers in the [console](../server/public/app.js).

**Accept when** a user can save A, type B before the reply, and still see B as unsaved when A succeeds. A second save writes B against the returned revision. A repeated Save shortcut during the first request and an intervening external edit must preserve the draft and the existing conflict choices. Exercise the shared handler through both operator and collaborator entry points. [Vault editing coverage](../server/test/console-vault-editing.test.ts)

### 2. Tell a human approver whether the submission was reviewed

**Observed.** With review set to none and the done checkpoint enabled, a submitted task had no reviewer. Its Needs you row nevertheless said “Approved by review · waits for your approval”. The task service records the reason it reached approval. The checkpoint row supplies a fixed explanation. [Task completion](../server/src/teams/teams.ts) · [Checkpoint row](../server/src/admin/needsYou.ts)

**Accept when** the same decider can compare two pending checkpoints, identify the independently reviewed submission and see “Submitted without review” on the other. Cover a review waived after submission as well as a task created with review off. Both still require the configured human decision. Use the recorded path to approval so later policy edits cannot rewrite the explanation. [Review policy coverage](../server/test/review-policy.test.ts) · [Attention coverage](../server/test/needs-you.test.ts)

### 3. Distinguish an unreadable decision queue from an empty one

**Observed.** A failed Needs you request produced “0 need you” and “Nothing waits for you” in the full operator view. The collaborator's common loader also substitutes an empty result. Blueprint Review already has wording for an unsuccessful check. See `VIEWS.needs`, `muLoadCommon` and `bpWaitLine` in the [console](../server/public/app.js).

**Accept when** a failed initial read or refresh tells the operator or collaborator that the queue could not be checked. A successful read with zero rows is the only path to the all-clear. Restoring the connection in the same scope shows the actual waiting decision. Any retained information must respect the current viewer's access. [Home attention coverage](../server/test/console-home-needs.test.ts)

### 4. Preserve the review hand-off when the named reviewer leaves

**Observed.** A worker submitted a task in a team that allowed coordinator reviews. Removing its only reviewer reopened the task and cleared the assignee even though an independent coordinator with an active key remained. Normal submission considers that coordinator eligible. Member removal searches only reviewer-role members. See `submit`, `canReview` and `removeMember_` in the [team service](../server/src/teams/teams.ts).

**Accept when** removal hands the existing submission to an eligible replacement using the team's review policy, preferring a reviewer. The assignee, submitted version and evidence survive. Exactly one current review turn names the replacement. Cover delivery to a polling and an on-demand reviewer. When nobody eligible remains, including when the only coordinator is the submitter, the task now waits in review with its author for the coordinator to name a reviewer; it no longer reopens (docs/specification.md, "A reviewer leaves"). [Team workflow coverage](../server/test/team-workflow-regression.test.ts) · [Turn coverage](../server/test/task-turns.test.ts)

### 5. Make every counted decision reachable

**Observed.** Given 201 waiting questions, the full console view reported 201 and rendered 200. The hub returns a continuation cursor. The screen requests the first 200 and provides no way to reach the next page there. The collaborator project card also filters the first hub-wide page locally, so another project's earlier decisions can crowd out the one this person came to answer. [Paged service](../server/src/admin/needsYou.ts) · [Console loaders and views](../server/public/app.js)

**Accept when** the operator can reach question 201 without resolving an unrelated question first. A decider opening a project with one waiting question can reach it even when 200 earlier visible questions belong to another project. Use scoped totals, retain bounded pages, and refresh the list after a decision so advancing through it cannot silently skip a remaining row. Check the Blueprint Review entrance against the same rule. [Existing API pagination checks](../server/test/needs-you.test.ts)

### 6. Keep backlog decisions inside the selected team or project

**Observed.** The Needs you backlog card counts rows from the selected team or project, but **Open backlog** carries no route argument. The postponed footer also reads and links the hub-wide backlog. Work → Backlog already accepts team and project filters. See `nyBacklogCard`, `VIEWS.needs` and `blQs` in the [console](../server/public/app.js).

**Accept when** two teams have identically titled proposals and opening one team's active or postponed backlog shows that team's tasks and scoped totals. Repeat from a project with multiple teams, then from unfiltered Home. Back returns to the originating scope. Keep **Later** personal and **Postponed** shared when calculating or labelling either list. [Backlog contract](specification.md#task-lifecycle) · [Postponement coverage](../server/test/task-backlog-postpone.test.ts)

## Verification and release decision

The reviewer-removal and checkpoint cases were exercised against the task service and admin response in a disposable local database. The vault save, failed read, first-page limit and backlog link were exercised with the current console functions and controlled inputs. The collaborator and Blueprint variants were traced in source. These checks establish behavior on the reviewed revision. Browser interaction and the fixes' regression results remain release evidence to collect.

Take tasks 1–3 first if the batch must be split. They protect authored text and decisions someone could make on false information. Tasks 4–6 remove repeat work from review and triage. For each fix, add the regression case above, review console changes on the seeded local design-review hub, and have the Release Manager run the server suite once for the reviewed batch. [Design review](design-guidelines.md) · [Release checks](acceptance.md)
