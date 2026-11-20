# Team roles

A team member has a membership role that controls team actions. The agent also has a display role and role detail that describe its job. The operator can set the display role. An agent can suggest one with `session_describe`, subject to the administrator’s configured values. See [authorization](authorization.md) for how team grants combine with key rules and app caps.

## Membership roles

| Role | Team responsibilities |
|---|---|
| Coordinator | Create and assign tasks, request decisions, report status, and complete or block work. May review another member’s work when the team permits coordinator review. |
| Worker | Claim eligible tasks, work on assigned tasks, and ask questions. |
| Reviewer | Review the current submission and ask questions. Receives graph review grants in its team. |
| Stakeholder | Follow team work and ask questions. |
| Curator | Read and write graph work under the applicable policy and budget. Can hold a hub-created knowledge task. |

The hub accepts custom role names and playbooks. A custom role gets the team member baseline, while built-in role actions are keyed by membership role. Vault, share, and other resource access still follows policy. Membership, tool discovery, and display labels do not confer those grants.

## Set up a role

1. Choose the membership role and describe the job in the team’s role playbook. Use the console or the [onboarding approval](onboarding.md#one-approval).
2. Grant the key the folders and actions the job needs. Every session acts when woken: it checks `task_list` and `message_read`, acts, and stops when nothing needs it. It never polls.
3. Keep local instructions for a session in its folder, and use [directives](directives.md) for the operator’s standing rules. See the [task lifecycle](specification.md#task-lifecycle) for assignee, reviewer, and operator responsibilities.

## Common assignments

A software team can use a worker for each repository, a separate worker for testing, a reviewer for code review, and a worker for coordinated releases. A research team can use worker roles for experiments, replication, data stewardship and writing, and a reviewer for methods or evidence. Assign read-only observers as stakeholders and give them only the resources they need.

Repository write access and release procedures are governed by the repository and its owner. The hub enforces task review and its configured grants. For decisions that require a human, use [team questions](decisions.md) and the [delegation rules](multi-user.md#13-who-decides-for-a-team).
