# Authorization and key lifecycle

Use the [policy engine](../server/src/policy/engine.ts) for decisions, the [catalogue](../server/src/policy/catalogue.ts) for action names, and the [key service](../server/src/keys/keys.ts) for credential state. The console simulator and MCP should use the same policy semantics. The simulator explains a rule decision; a real call can also be refused by domain state, validation, lockdown, or quota.

A rule has an effect, an action list, and a typed resource such as `tool:file_read`, `path:/vault/Projects/**`, or `agent:<id>`. Path patterns match segments: `*` stays within a segment and `**` can span segments. Evaluate current session rules, including applicable links, team rules, and temporary grants. A deny wins; no matching allow means deny. When an app cap has rules, it must also allow the action. An empty cap adds no restriction. A role description is metadata; a team role is checked by the team workflow in addition to policy.

For example, allow `tool.invoke` on `tool:file_read` and `fs.read` on `path:/vault/Projects/**`, then deny `fs.read` on `path:/vault/Projects/Private/**`. A read under Private stays denied even if a template or temporary grant would otherwise allow it. Browsing and searching need their own actions; a reachable directory does not grant access to its children. For rename, check both paths. For secondary outputs such as backlinks, recheck each source.

Keys are issued once and stored as verifiers. The app key identifies an installation; the session key identifies and scopes an agent. A connector installation's app key is its identity on the hub: it binds the installation's session keys, pairs its file transfers, sends its heartbeat and fetches PC actions, and never acts as an agent. Disconnecting uses a separate credential that can only fetch that one order and report its result. PC actions are admin-only and audited. Session tokens expire after one hour of inactivity and are bound to the issuing app key. End logins to invalidate tokens; suspend or revoke a key to stop its use. Rotation replaces the secret and ends the old logins while preserving the principal's policy. Keep the production pepper stable across upgrades and backups.

Only an admin can move a task out of the backlog or back into it (accept, discard, demote; see the [task lifecycle](specification.md#task-lifecycle)) or change a project's task intake. These are admin routes with no MCP tool, so no policy rule can grant them to an agent, and the scope registry keeps them from members and deciders; a coordinator's `operator_request` only records that the operator asked, as relayed L1 work the operator can undo.

Agreeing a requirement is the operator's act ([blueprint](blueprint.md#4-who-may-edit-what)). The admin may hand it to one team's coordinator, for that team's own Blueprint part only, with the team setting **Coordinator agrees requirements** (`coordinator_decides_blueprint`, off by default). Each act is audited with the coordinator as actor, listed in a daily alert and can be undone from the item's History; lockdown and pause still refuse it.

Only an admin, or a team's decider within that team's ceiling ([multi-user](multi-user.md#13-who-decides-for-a-team)), can approve a temporary grant. A ceiling never overrides a deny and never covers a restricted folder. Approval can narrow actions, resource scope, and duration; it cannot override a deny. Expiration and revocation are evaluated on subsequent decisions. A transfer, queued item, or job created earlier must still pass the applicable current checks before delivery or commit. A share upload is checked again just before its version is published, after its files are staged, on every path ([transfers](transfers.md)).

A connector installation's app key is its identity on the hub: it binds the installation's session keys, pairs its file transfers, sends its heartbeat and fetches PC actions, and never acts as an agent. Disconnecting uses a separate credential that can only fetch that one order and report its result. PC actions are admin-only and audited ([connector](connector.md#pc-actions-on-the-pinned-poll)). An app key never logs in as an agent and calls no agent tool; on the bridge routes it moves only the transfers of its own PC, to and from folders the operator approved.

Live logins: an app key allows 100 live logins by default; the admin sets another limit from 1 to 500 on the key's Overview (`PUT /api/keys/:id/live-limit`, audited as `key.live_limit`, applied at the next login, saved in one transaction with its audit row). The limit is read from the app key only; a session key stores 20 and keeps it through rotation, since the column default of 100 is for app keys. A login over the limit is refused as `rate_limited` ([onboarding](onboarding.md#the-app-key-and-its-onboarding-capability)).

PC binding (see [onboarding](onboarding.md#pc-binding-of-session-keys)): every session key has a PC binding switch on its Keys overview, "Use only from <PC>" or "Free (any permitted PC)", set by `PUT /api/keys/:id/binding {machine_id}` (`null` for free) and audited as `key.binding_set`. A bound key logs in, by `session_login` or header login, only through an app key of that PC; elsewhere the login fails as an invalid key, raises `bound_key_elsewhere` (warning) and is audited. A change applies at the next login; live logins go on until ended in Keys. Rotation keeps the binding. Keys created by hand are free. Onboarded keys default to bound.

Checkout ([checkout](checkout.md) §5): a restore issues successor keys that keep the agent, its rules and its memberships. At confirm the old key's logins are suspended and the old key stops logging in; `checkout_resume` is accepted only from a login of the successor key (`new_credential_id`) made after confirm, or, when a same-user move keeps keys, from a login made after render (render ends the earlier logins). The login must also come through an app key of the target PC. A login made before confirm, on another PC, the old key, or another key is refused with `resume_refused` and audited. `checkout_*` tools are granted to every team member through the team rules (`tool:checkout_*`), still require the `checkout.handout` action on the team, and pass the team pause; only `checkout_status` passes lockdown. A session that connected before a hub update added tools lists them only after it reconnects (the HTTP transport is stateless and cannot announce new tools), so the checkout notice says to reconnect when `checkout_handout` is missing.

Reserved folder ([vault](vault.md#the-hubs-folder-99-conclave)): `/<alias>/99 Conclave/` is written only by the hub; its name is matched without regard to case. For an agent every `fs.*` write under it is refused before the rules are read (source `reserved`, "99 Conclave is written by the hub; write your documents in your project folder."), so no allow rule, template, temporary grant or app cap can grant one. A read needs an allow rule whose path names the folder in its second segment with no `*` (`path:/<alias>/99 Conclave/**`); a wider pattern such as `/<alias>/**` does not reach it, while the app key cap may stay a wildcard. Search, backlinks and the knowledge graph skip the folder. For console members it is a restricted folder, seen only when granted by name.

See [MCP calling patterns](mcp.md#calling-patterns) and [security boundaries](threat-model.md).

## Credential boundaries

App and session keys can be revoked independently. Revoking an app key affects all its logins. Revoking a session key affects that key across apps. A session token binds both credentials, and the service checks their current state. Conversations that reuse the same session key share a principal even when their login cursors differ.

The public key ID supports lookup and masked display. A peppered HMAC verifies the generated high-entropy secret. Session tokens are stored by hash. Keep the pepper separate from the database backup. See [key verification](../server/src/keys/keys.ts) and [crypto helpers](../server/src/util/crypto.ts).

## Console users

Console users ([multi-user](multi-user.md)) are `admin` or `member`. Every `/api` route declares a scope in one [registry](../server/src/admin/scopes.ts): `public`, `self`, `admin`, `filtered` or `decider`. The auth hook refuses an undeclared route to members (fail closed), so a new route is admin-only until someone scopes it, and a test fails while any registered route is undeclared. Members get `403 admin_only` on admin routes. They reach `public` and `self` routes and the filtered reads that check their grants: granted projects only, by component, filtered before paging and counts, rechecked on every call. Decider routes let a team's active deciders answer its questions, take its task acts and decide access requests inside its ceiling; the Blueprint gives members the granted projects' Blueprints and lets a decider decide the proposals routed to their team and take the operator acts of their team's part ([multi-user](multi-user.md#4-blueprint-for-members)); everything else, such as project-level items, stays with the admin. A user who must use 2FA (an external user, or one the admin marked) reaches only `/api/me`, `/api/totp/*` and `/api/logout` until TOTP is enrolled. An expired user cannot sign in, and live sessions end at the next call. A new user's first password is generated by the hub, stored as a hash and shown once to the admin, who hands it over; the user can replace it with their own, and an admin reset generates a new one and ends the user's sessions. Project grants list components and vault folders within the project's vault roots; an external user never gets a restricted folder. Out-of-grant ids answer exactly like unknown ids.

## Agent owners

Every agent records the console user who owns it (`agents.owner_user_id`); an agent without one is **unowned**. The owner is a verified person: an active console user that the admin names. The hub never infers an owner from an agent's name, host, PC, grant, file or login. Only the admin assigns or changes an owner, and every assignment is audited (`agent.owner`, with the old and new owner).

The owner is kept on every path that issues a key:

- **Manual issuance.** `POST /api/agents` and `POST /api/keys` with `new_agent` take `owner_id`. The console preselects the signed-in admin in the form, where the admin can see and change it. Without `owner_id` the agent is unowned.
- **Onboarding.** `POST /api/onboarding/:id/approve` takes `owner_id`, which becomes the owner of every agent the approval creates. A pickup that is issued again keeps the agent and its owner.
- **Recruitment.** A recruited agent gets its recruiting coordinator's owner, in auto and in propose mode. A recruit of an unowned coordinator is unowned. The owner is carried as recorded, also when that person was disabled meanwhile; owner enforcement decides what such an agent may do.
- **Key rotation and checkout.** A rotated key and a checkout's successor key belong to the same agent, so the owner does not change.

`PATCH /api/agents/:id {owner_id}` changes or clears (`null`) the owner.

**Claim all existing agents as mine.** Agents that existed before owners were recorded are unowned. The admin claims them in one audited step: Settings → Agent owners → **Claim all existing agents as mine** (`POST /api/agent-owners/claim`). It makes the signed-in admin the owner of every unowned agent, archived ones included. It keeps every agent that already has an owner, and records who claimed, when and how many agents (`agent.owner_claim`). Only the admin can do this: a member gets `403 admin_only`, and no agent tool reaches it. The step can run again later to claim agents that are unowned again.

**Owner enforcement** is a hub setting (`agent_owner.enforcement`, off by default), shown and switched in the same Settings section (`PUT /api/agent-owners/enforcement {on}`, audited `agent_owner.enforcement`). It cannot be switched on until the claim step has run; until then the hub refuses with `invalid_state`. While it is off, the owner is recorded and shown, but no decision reads it, so every agent keeps today's rules. `GET /api/agent-owners` returns the claim record, the setting and the number of unowned agents. What the owner changes while enforcement is on is described under [Owner enforcement](#owner-enforcement).

## Owner enforcement

While owner enforcement is on, every agent acts only within its owner's grant, whatever its keys allow. The owner's grant is a **ceiling** on the app key cap of every decision, so a key rule can never reach past it. The hub builds the ceilings again from the database for every operation, so these take effect on the agent's next call, queued work included:

- a narrowed or removed grant or delegation;
- a disabled or expired owner;
- a lost team membership.

An agent whose owner is disabled, or whose owner's account expires, is told at once: it gets a `permissions_changed` notice that its owner's account ended, that it keeps only the tools every session has, and to call `access_list`. An expiry is noticed by the hub's regular check (every 30 seconds), which marks the account expired once (`user.expired`) and tells that owner's live agents then, not on their next call. When the account comes back, the agents are told the same way that they work within their owner's grant again: when the admin enables a disabled account that has not expired, or lifts or moves later the expiry of an expired one that is not disabled. Moving one future date to another is no change for the agent and tells nobody. While enforcement is off, no such notice is sent, because nothing changes for the agent.

**Notices follow the owner.** A notice about a task reaches an agent only if its owner may do team work in the task's team (the `tasks` component and that team delegated, as in the mapping below). So an agent in a mixed-owner team does not hear about work in a team its owner has no part in. Notices about the agent itself (its role, its keys), about the operator's directives and about feedback are not about another owner's work and are always delivered, and so is a notice about a task with no team. An admin owner adds no ceiling, so the admin's agents get every notice. While enforcement is off, delivery is unchanged.

A vault write is checked again just before it commits, so a grant narrowed while a write is in flight refuses that write. A share publication, a channel delivery and a download are checked again when they happen, too.

**Whose ceiling applies:**

- **An admin owner** adds no ceiling: the admin's agents keep their key rules.
- **A member owner** adds the member's delegated grant, mapped to operations as in the table below.
- **An unowned agent**, or one whose owner is disabled, expired or unknown, gets an empty ceiling. It keeps only the tools every logged-in session has, and every other operation is refused.

**A delegated agent** ([checkout](checkout.md#91-delegate-one-agent)):

> While an agent is delegated to a collaborator, that collaborator's grant is a ceiling on the agent, as for a member owner, whether or not owner enforcement is on.

> While delegated, the agent also works in **contributor mode**: it may read, create, and edit what it created during the delegation; every other change it makes is a proposal. Contributor mode only narrows what the agent's role already allows (blueprint.md §4), and what it writes is labelled with the delegate.

The ceiling runs from the confirm on the delegate's PC until Take back (`basis: delegate` in the inspector, with the checkout). In contributor mode the agent writes in the vault only in the drafts folder the admin granted the delegate at Delegate, reads the team rooms the grant reaches and posts in none, takes only tasks assigned to it by name (it does not claim, is not told of open work and reviews nothing), and files no status report. Notices about tasks follow the delegate's ceiling too, whatever the owner setting. Its own checkout tools in that team pass the ceiling (`checkout_resume` on the delegate's PC, a handout for a later move): the move is the admin's, and the resume keeps its key checks. Task text it writes records the delegate as its origin, and Blueprint text it writes shows "· via <delegate>": items, revisions and proposals carry `via` with the delegate's name, and so do its actors in the work feed.

**Delegation.** A grant names what the person sees in the console. Its `delegation` names what the person's agents may do. A new grant delegates nothing.

- **A project grant** may delegate the teams of its project where the agents may do team work, and vault folders inside the grant's own folders. A project grant's vault is Read for the person, so these folders are Read for the agents too: Contribute in a project grant's delegation is refused when saved, and a Contribute delegation saved before this change maps to Read. Contribute comes only from a folder grant that delegates it (a change to the first mapping, which let a project grant delegate Contribute).
- **A folder grant** (`multi-user.md` §1.2a) may delegate folders inside its own path, each with Read or Contribute. **A Read grant caps the agent at Read:** Contribute is refused when the grant is saved, and if the grant is later narrowed to Read, its agents are capped at Read on their next call. Where a deeper folder grant of the owner sits inside it, the deeper grant decides there: a delegation from the outer grant keeps reading inside it, but loses Contribute and download where the inner grant lacks them.

`PUT /api/users/:id/grants` and `PUT /api/users/:id/folder-grants` take `delegation` per grant (`{teams, folders: [{path, mode}]}`, or `{folders}` for a folder grant). A team must belong to the grant's project and a folder must lie within the grant's folders, or the save is refused. A save that leaves `delegation` out keeps the one the grant had.

**A teamless vault agent** is an agent with a key and no team: the admin makes it by hand (`POST /api/keys` with `new_agent` and folder rules) and names its owner, or approves a [vault agent request](onboarding.md#a-vault-agent) from the owner's PC, which delegates the folders and issues the key at pickup. While owner enforcement is on, it reads and revises notes in its owner's delegated folders only, with `file_update` and a base revision. It has no team work, task board or Blueprint, because none of those is mapped without a delegated team. When the owner's folder grant goes, its next edit is refused.

**Editing delegation in the console.** Each grant on a person's page (Security → Users → the person) has a **Their agents** part. By default it delegates nothing.

- On a **project grant**, under the grant's parts and folders, the admin ticks the teams of the project where the person's agents may do team work, and adds vault folders inside the grant's folders. These folders are Read: the editor offers no Contribute there.
- On a **shared folder** (a folder grant), the admin adds folders inside the grant's path. Each is Read, or Contribute while the grant itself is Contribute. Making the grant Read sets its agent folders back to Read.

While the admin edits, the part lists the exact operations the delegation permits before anything is saved:

- for each team, what the agents may do there, with the action names, and which of the person's agents are live members of it (team work needs live membership);
- for each folder, what Read or Contribute allows, and Download when the grant has Exports;
- what stays refused whatever is delegated: deleting, renaming and restoring vault files, data channels and the bridge, and checkouts.

The list comes from the policy service itself, through `POST /api/users/:id/grants/preview` and `POST /api/users/:id/folder-grants/preview`. Each takes the same body as its save, checks it the same way, saves nothing and is admin only. The console keeps no copy of the mapping. A save that narrows a grant applies to the agents' next call, and the inspector shows the narrower ceiling at once.

**The mapping** lives in the policy service (`server/src/policy/ownerScope.ts`). Each grant component maps to these operations:

| Grant component | With | Operations the agent may do |
|---|---|---|
| tasks | a delegated team where the agent is a live member | team work on that team: tasks, reports, completion, asks, recruiting. Shares by live members of the team, and new shares. |
| messages | a delegated team | that team's room, and messages to and from its live members |
| blueprint | a delegated team | read and write the project's Blueprint, through that team |
| graph | a delegated team | read the graph |
| vault | a delegated folder of a project grant | Read: list, read, search, history and conflicts. Download needs the grant's export permission. Paths hidden from the person stay hidden. |
| folder grant | a delegated folder of that grant | Read as above. Contribute adds create and update, only while the grant itself is Contribute. Download needs that folder grant's export permission. Inside a deeper grant of the owner, that deeper grant decides. Paths hidden from the person stay hidden. |

Operations with no mapping are refused, and the refusal names the owner's grant (decision source `owner_grant`):

- data channels and the bridge;
- checkouts;
- deleting, renaming and restoring vault files;
- any operation added later until it is mapped.

**Handed-over work.** Task text, review comments and Blueprint text written by another owner's agent are labelled with that owner: `task_list` shows "(from Carol's agent)" and `bp_read` shows "· from Carol's agent". A task records the owner of the agent that created it (`tasks.origin_owner_id`, audited as `task.origin_owner`). While an agent has such a task assigned to it (`assigned`, `in_progress` or `changes_requested`), or reviews it (`in_review`), each other owner involved adds a ceiling. The ceiling applies from the moment the task is assigned, so the agent cannot act on the task text before it calls `task_start`. The owners involved are:

- the task's originating owner;
- for the assignee after a review, the reviewer's owner;
- for the reviewer, the assignee's owner.

So a collaborator with Read on a folder cannot have the admin's agent write there through a task. Once the work is handed back, that ceiling is gone. The origin is the owner of the agent that wrote the task text: the one that created it, and then the one that last changed its title, description or short summary. When another owner's agent edits the text, the origin moves to that agent's owner. The task history keeps the old one ("origin owner Dave, was Carol"), and the change is audited as `task.origin_owner` with `from`. Changing only the reviewer, review, refs or tags leaves the origin as it is.

**Inspector.** `GET /api/keys/:id/effective` and `POST /api/simulate` return `owner_ceilings`: each owner, why it applies (`owner` or `task`, with the task) and the operations it allows. It is null while enforcement is off. A `task` ceiling also names the task (`task {id, title, status, origin_owner}`, where `origin_owner` is the originating owner's name) and how the ceiling's owner is involved (`via`):

- `origin`: the owner of the agent that created the task;
- `reviewer`: the reviewer's owner, for the assignee after a review;
- `assignee`: the assignee's owner, for the reviewer.

A refused decision from `POST /api/simulate` with source `owner_grant` names the ceiling that refused it in `decision.owner`, which has the same fields as a ceiling.

In the console, the key's **Tools** tab has an **Owner's grant** card. It lists each ceiling with its owner and the operations it allows. A task ceiling also shows the task and the originating owner, for example "Task: Fix the import · created by Carol's agent". **Simulate a call** says what decided, in words: the key's rules, the app key's cap, or the owner's grant. For the owner's grant it names the owner and, for handed-over work, the task. While enforcement is off, the card says that agents follow their key rules only. These views show no PC details, credential ids or secrets.

**Account.** A collaborator's Account lists the agents they own by label, each with its effective scope:

- the delegated teams it is a live member of, with what it may do there;
- the delegated folders: Read for a project grant's, and Read or Contribute for a folder grant's, never more than the grant. For an external person, a folder at or inside a restricted folder is refused, in the preview and the save alike, because enforcement would never let their agents reach it. A folder the person cannot see under the grants as proposed, such as one restricted after the delegation was saved, is listed as **Not permitted** with the reason and no operations, as enforcement drops it; Account leaves it out.

`GET /api/me` returns the active ones as `agents [{id, label, teams: [{id, name, project_name, operations}], folders: [{path, mode}]}]` and adds `owner_enforcement`. While that is off, Account says their agents still follow only their key rules. Account names no PC, key or credential.

**A person who leaves.** Disabling a console user is never refused: their agents stop at the next call. The answer (`POST /api/users/:id/disable`) names the agents they own. The admin then hands those agents on to another active console user with `POST /api/agent-owners/:id/reassign {to}`, from the person's page in the console (**Hand on**). This is admin only, runs in one transaction and is audited (`agent.owner_reassign`). `GET /api/agent-owners/:id/agents` lists a person's agents. Only the admin, onboarding approval or the hub itself creates an agent; a member or an agent cannot.

**What the hub cannot see.** The ceiling covers what an agent does through the hub. It does not cover what the agent does in a repository or on its PC with access it has there. See the [threat model](threat-model.md).

## Terms

These words have one meaning in every document.

- **Admin:** a console user with the `admin` role. The admin sees the whole console and manages users, grants and deciders.
- **Operator:** whoever makes the hub's decisions: the admin, or for one team's questions, access requests and Blueprint part, that team's decider. Where a document says "the operator", either may act, unless it says "admin only". "Administrator" in agent-facing text means the same.
- **Decider:** a console member the admin named for a team. A decider acts as the operator for that team only, and for access requests only inside the team's ceiling ([multi-user](multi-user.md#13-who-decides-for-a-team)). Deciders write to the Blueprint through the same operator route as the admin, limited to status moves in their team's part.
- **Owner:** the console user an agent belongs to ([agent owners](#agent-owners)). Owning an agent gives the person no admin power and gives the agent no permission by itself.
- **Member:** always a console user with the `member` role, who reads the projects granted to them. A team's agents are not members: a non-coordinator agent of a team is a team agent (a worker or a reviewer), and the Blueprint rights call it `member` only inside the rights matrix.
- **Decision:** either an entry of the Blueprint (an ADR, kind `decision`) or a team question an agent asked with `team_ask` (a row of the `decisions` table, listed in the team's decision log). A question can become an ADR when its `decision` flag is set. [Decisions](decisions.md) is about team questions.
