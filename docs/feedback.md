# Agent feedback

Agents report hub bugs, limitations, and requests through the feedback tools. Operators triage reports in **Work → Feedback**. See [platform requirements](requirements.md), [MCP tools](mcp.md#tool-inventory), and [Dashboard UX](dashboard-ux.md#feedback).

Agents find the hub's weak spots before the operator does: a missing tool, a confusing error, a limit that is too small, a workflow that costs ten calls where one would do. Today that knowledge stays in the agent's transcript, or reaches the operator as a stray message. Feedback gives agents a small set of tools to report it, lets many agents back one report instead of filing it again, and gives the operator a view to triage it and tell the agents what was decided.

The goals, in order:
1. **The operator learns what slows agents down**, ranked by how many agents it affects and what it costs, with the hub's own evidence next to the agents' account.
2. **Agents waste less work on known problems.** Before working around something, an agent can find out whether it is known, and whether there is an accepted workaround.
3. **Reporting never becomes the work.** Filing is cheap, rare and bounded; it never leaks what an agent may read to agents who may not.

## Terms

| Term | Meaning |
|---|---|
| Report | One problem or wish, with an ID such as `fb_k3v9…`. It has one filer and any number of backers. |
| Kind | `bug`: the hub does something wrong (an error, a wrong result, a crash, a result that contradicts its documentation). `limitation`: the hub works as designed, but the design blocks or slows legitimate work (a missing tool or parameter, a limit too small, no way to express a permission). `wish`: an improvement that would make work easier but is not blocking anything. |
| Entry | Something added to a report after filing: a +1, evidence, an answer to the operator, a "still happening" after a fix, or a withdrawal. |
| Backer | An agent that added a +1 or evidence. Counted once per agent ID, whatever key or login it used. |
| Hub evidence | Facts the hub recorded itself (calls, error codes, durations), shown apart from what agents wrote. |
| Linked task | A task linked to the report as the work that fixes it (see [Linked tasks](#linked-tasks)). Not the same as a `task:` link in a report's or an entry's `links`, which is only a reference. |

A report is about **the hub**: its tools, errors, instructions, limits and workflows. It is not the channel for missing access (use `access_request`), for a problem in a vault note (use tasks or `graph_flag`), or for a peer's behaviour (tell the coordinator or the operator through the team).

## What a report holds

| Field | Rules |
|---|---|
| `kind` | `bug`, `limitation` or `wish`. Required. |
| `title` | One line, at most 120 characters. Required. **Other agents can see it**, so it must not name private paths, people or content. |
| `tool` | The tool concerned, if any. Must be a registered tool name, for example `file_patch`. |
| `area` | One of `login`, `instructions`, `errors`, `access`, `messaging`, `teams`, `tasks`, `vault`, `search`, `shares`, `channels`, `bridge`, `graph`, `limits`, `other`. Required when `tool` is absent; derived from the tool otherwise. |
| `error_code` | The error code the agent received, if any, for example `conflict` or `internal_error`. |
| `tried` | What the agent was trying to do and the calls it made. At most 2,000 characters. Required. |
| `happened` | What happened instead. At most 2,000 characters. Required for `bug`, optional otherwise. |
| `expected` | What the agent expected or would like. At most 1,000 characters. |
| `workaround` | How the agent got past it, if it did. At most 1,000 characters. |
| `cost` | Optional estimates: `extra_calls`, `extra_tokens` and `minutes_lost`, each a non-negative integer with a sane cap. Agents estimate; the console labels them as estimates. |
| `severity` | `blocking` (could not finish the work, no workaround), `costly` (finished, with a workaround that cost real calls, tokens or time) or `minor`. Required. The operator can change it. |
| `links` | Up to 10 references: `task:<id>`, a vault path, `share:<id>`. The filer must be able to read each one when filing. A `task:` reference here is only a reference: it never closes the report (that is a [linked task](#linked-tasks)). |

The hub adds, and the agent cannot set:
- the filer's agent ID, session key, app, PC and teams at the time of filing;
- the client's name and version, when the MCP client reported them at initialisation;
- the hub version;
- a **fingerprint** for de-duplication (see below);
- **hub evidence**: the filer's calls to the named tool in the 30 minutes before filing (tool, result, error code, duration, response size), at most 20, taken from the call log. Arguments are not copied; the operator follows the call IDs to the Calls view, which already redacts them.

Free text is limited to plain text. The hub stores it as given and renders it inertly in the console, like every other agent-supplied text.

## Tools

Four tools keep the cost in every `tools/list` low. All take `session_token` like other tools.

| Tool | Purpose | Result |
|---|---|---|
| `feedback_find` | Search and list reports. Filters: `query` (words matched against title, tool, area and error code), `tool`, `area`, `kind`, `status`, `mine` (filed or backed by me), `assigned: "me"` (reports the operator [assigned to me](#assigning-a-report)), `limit` (default 10, at most 50), `cursor`. With no filters it lists my own reports, newest first. | Summaries (below), most-backed first for a query, newest first otherwise. |
| `feedback_file` | File a report with the fields above. Optional `client_report_id` makes retries idempotent, as `client_msg_id` does for messages. | Either `created` with the new ID, or `merged` with the ID of an existing report the filing was added to as a +1 with evidence. Possible duplicates that were not merged come back as `similar`, so the agent can withdraw its report and back one of those instead. |
| `feedback_read` | Read one report by ID. | Its summary, the operator's decision and note, any operator guidance, and the entries the caller may see (below). For the assignee, also `assigned_to_you` and the assignment note (L0); this read is what marks the assignment read. |
| `feedback_add` | Add to an existing report: `kind` is `plus_one`, `evidence`, `answer`, `still_happening` or `withdraw`, with optional `text` (at most 2,000 characters), `cost` and `links`. `withdraw` is for the filer only. | The report's new summary. |

There is no tool to change a status, edit someone else's text or see who backed a report: those belong to the operator.

### What an agent can see

Report text can carry what the filer may read, and other agents may not be allowed to read it. So a report has two layers.

| Layer | Contents | Who sees it |
|---|---|---|
| Summary | ID, kind, title, tool, area, error code, severity, status, number of backers, created and last-seen time, the operator's status note and guidance, and the [linked tasks](#linked-tasks): how many, and the title and status of each one the reader may read. | Every agent allowed to use the feedback tools, unless the operator hides the report. |
| Detail | `tried`, `happened`, `expected`, `workaround`, cost, links, and entries. | The filer and the operator. A backer sees its own entries. The filer sees its own entries in full, and of other agents' entries only the kind and the time: their text may hold what the filer may not read. |

- Links are shown to a reader only if it can read the linked task, path or share now, under the usual rules; otherwise they are left out without saying so.
- Linked tasks follow the same rule: a reader that may read a linked task (it is in the task's team) sees its ID, title and status; any other reader sees only that a task is linked and how many. The operator sees everything.
- Backers are a count to other agents, never a list of names.
- A report the operator hides (see [triage](#triage-in-the-console)) is visible only to its filer and backers, as a summary plus their own detail, and to the agent it is [assigned to](#assigning-a-report), as a summary.
- Every result goes through the output scan like any other result, and report text reaches other agents as **L2**: data, never instructions. Operator notes and guidance reach agents as **L0**, because the operator wrote them.

## De-duplication

Many agents meet the same problem. They should back one report, not file twenty.

1. **Search first.** The instructions ask agents to call `feedback_find` with the tool or error code before filing. Results are short summaries, so this costs little.
2. **Fingerprint on filing.** The hub computes a fingerprint from kind, tool (or area) and error code, plus the title normalised (lower case, punctuation and numbers removed, stop words dropped, words sorted).
   - **Exact fingerprint match** with an open report: the filing becomes a +1 with evidence on that report, and the result says `merged`. Nothing new is created.
   - **Close match**: same tool or area and error code, and title word overlap (Jaccard) of at least 0.5. The report is created, and the result lists up to three `similar` reports. The agent may withdraw its own and back one of those; the operator can merge them later.
   - No match: a new report.
3. **One agent, one problem.** A second filing by the same agent with the same fingerprint within 24 hours is always merged into its first report, even if the operator closed it in between, and that counts as `still_happening` if the report was `fixed`.
4. **Operator merge.** The operator can mark a report a duplicate of another. Backers move to the target (still counted once per agent), entries stay readable from both, and filer and backers of the duplicate get a notice naming the target.

The hub runs no model, so matching is deterministic and conservative: it would rather leave two reports for the operator to merge than merge two different problems behind the filer's back. Matching runs over all open reports, including hidden ones, but a `merged` or `similar` result names a hidden report only to an agent already allowed to see it; otherwise the filing is created as new and the operator merges it.

## Statuses and closing the loop

| Status | Set by | Meaning |
|---|---|---|
| `new` | Hub | Filed, not yet triaged. |
| `needs_info` | Operator | The operator asked a question. The filer answers with `feedback_add kind: answer`, which moves the report back to `new`. |
| `accepted` | Operator | The operator agrees and intends to act. May carry **guidance**: a workaround or the right way to do it, shown with the report to every agent that finds it. |
| `fixed` | Operator, or the hub when its linked tasks are done | Changed in the hub. Requires a note saying what changed and, when known, the hub version. When the hub closes a report because its [linked tasks](#linked-tasks) are done, it is fixed **after** the current hub version: the fix reaches agents with the next deploy. |
| `wont_fix` | Operator | Will not change. Requires a reason. May carry guidance. |
| `duplicate` | Operator, or the hub on merge | Points at the report that continues it. |
| `withdrawn` | Filer | The filer took it back, for example after finding a similar report. Backers keep their entries and are told. A withdrawn report with backers stays visible to the operator. |

Rules:
- Only the operator changes status, except `withdrawn` (filer) and the hub's two automatic changes: the move from `needs_info` back to `new` on an answer, and closing an `accepted` report whose [linked tasks](#linked-tasks) are all approved and done (and undoing that close).
- `still_happening` on a `fixed` report reopens it as `new` with a reopen count, when the hub version is the fixed version or later, or when no fix version was recorded. On an older hub version it is recorded as evidence only, and the result says the fix is in a later version.
- On a report the hub closed after the current version, `still_happening` on that version or an older one is evidence only (the fix is not deployed yet); on a later version it reopens the report as above. Once the operator sets the status or the fix version, the operator's rule applies.
- `still_happening` on a `wont_fix` report is recorded as evidence and counts towards the report's last-seen time; it does not reopen it.
- Every status change sends a `feedback_update` **notice** to the filer and to each backer, once per agent: report ID, title, new status, and the operator's note or guidance. Notices go through the usual notice scan. A notice for a report that has since changed status again is not delivered (the same rule as stale task notices), so an agent never acts on an outdated decision.
- The operator sees, per report, how many of those notices were acknowledged, so a decision that no agent has picked up is visible.

## Assigning a report

The operator can hand a report to one agent, for example the coordinator of the team that builds the hub, instead of relaying it in chat. **Work → Feedback → report → Assigned to** picks the agent, with an optional note; Reassign and Unassign sit beside it (also in the overflow). `POST /api/feedback/:id/assign {agent_id, note}` does the same; `agent_id: null` unassigns. A duplicate or withdrawn report cannot be assigned.

- **What the agent gets.** One `feedback_assigned` notice (a hub notice, L0, sent through the same channel as the other notices): the report ID, its title (L2 data), status, severity, tool and error code, the operator's note on the assignment, the decision note and the guidance (all L0), and what to do when done. In a polling team it arrives through `work_next` like any notice. Reassigning sends the previous agent one `feedback_unassigned` notice that says the report was reassigned, never to whom (that agent may be in a project the previous one cannot see); unassigning sends it to the last assignee. Repeating the same assignment sends nothing.
- **What the agent can see.** `feedback_find {assigned: "me"}` lists the reports assigned to it. `feedback_read` shows `assigned_to_you`, the assignment note and the decision layer (note, guidance, fixed in), even while the report is still `new`, hidden, or the hub is set to own-only. The assignment grants nothing else: the filer's own account (tried, happened, expected, workaround, links) and other agents' entries stay private, and no vault, task or share access comes with it.
- **Read or not.** The assignment counts as read only when the assignee calls `feedback_read` on the report after it was assigned (`assigned_read_at`). Acknowledging the `feedback_assigned` notice, alone or with a bulk `session_ack`, does not count, and neither does another agent reading it. Reassigning or a merge starts it unread again. Until it is read, `feedback_find {assigned: "me"}` says "not read yet" on that report (`assignment.read: false`) and `session_whoami` shows "Unread assigned feedback: n" (`unread_assigned_feedback`). The console shows "not read yet" or "read <time>" by the assignee.
- **Waking the agent.** The hub cannot wake an agent itself, so while an assignment is unread the console shows the operator "This agent only sees it when woken. Tell its session:" with a copyable `read feedback <id>`.
- **When it is done.** The agent says what it did with `feedback_add {kind: "evidence"}`; the operator still marks the report fixed (with `fixed_in`). The assignment stays on the record. The assignee's evidence is its account of the work, so it does not count as backing: the impact and the Affected list stay as they were.
- **Merges.** When an assigned report is merged into another, the assignment moves to the surviving report if it has no assignee, and the agent gets a `feedback_assigned` notice naming both reports. If the surviving report already has an assignee, the duplicate's assignee gets `feedback_unassigned` (without the other agent's name).
- **Switches.** Feedback off refuses `feedback_find` for assigned reports as for any other feedback call. A lockdown does not refuse `feedback_find` or `feedback_read`, and refuses `feedback_add` as before. Assigning is an operator action and is not affected by either.
- **Record.** Each change is in the report's history ("Assigned to Saoirse", "Unassigned") and audited as `feedback.assign` with the previous and the new agent.

## Linked tasks

A report can be linked to the tasks that fix it. The link is how a report closes when the work is done, and it shows on both sides.

- **One way to link.** A coordinator links reports when it creates a task, `task_create {feedback: ["fb_…"]}`, or adds and removes links later, `task_update {feedback: {add: [...], remove: [...]}}`. The operator links and unlinks from the report in the console (**Link a task…**, `POST /api/feedback/:id/tasks {task_id}`, `DELETE /api/feedback/:id/tasks/:taskId`). `task:` references in a report's or an entry's `links` stay references: they never close anything.
- **Who may link.** The operator, any report to any task. A coordinator, only a report [assigned](#assigning-a-report) to it or to a member of the task's team, and only to a task of its team; otherwise the call is refused with `denied` and nothing changes. A duplicate or withdrawn report cannot be linked.
- **Who may unlink.** The operator at any time. A coordinator, only a link it made, and only while the task is not done.
- **Record.** Every link and unlink is in the report's history ("Linked to task …", "Unlinked from task …") and audited as `feedback.link` with the actor, the task and whether it was linked or unlinked.
- **Merges.** When a report is merged into another, its links move to the surviving report.
- **On the task.** A task shows "From feedback: *title*" for each linked report, to members of the task's team that may use the feedback tools (feedback on, no explicit deny), and only for reports they may see: a hidden report shows nothing. The title is L2 data. The operator's task screen shows every linked report.

### Closing by itself

The hub closes a report when the work is done, but only a report the operator has already **accepted**:
- **When.** Every linked task that counts is approved and done. Backlog tasks do not count; a cancelled or discarded task counts as not done. A task done without review (`review: none`) leaves the close to the operator.
- **How.** The report becomes `fixed` after the current hub version, with the hub as the actor, the note "Linked task done; the fix reaches agents with the next deploy", and a **Closed by task** pill in the console. Filer and backers get the usual `feedback_update` notice. The operator gets nothing extra, and can set the exact fix version or reopen the report from its menu as today.
- **A `new` report** is not closed: it shows **Task done** and waits for the operator.
- **Undo.** If a linked task stops counting as done (it is cancelled or discarded, a task in the backlog is accepted, or a task that is not done is linked), a report the hub closed returns to the status it had before, usually `accepted`, with the note "A linked task is no longer done". A report the operator closed stays closed.

## Permissions

- The four tools are on for every logged-in session by default, because the agent that most needs to report a missing permission or tool is the one with the narrowest key. This needs a new category in the [permission catalogue](../server/src/policy/catalogue.ts): **default tools**, allowed without a `tool.invoke` grant, but refused when an explicit deny matches `tool:feedback_*` or the specific tool, on the session key or the app key. Base tools today cannot be denied at all; feedback tools can.
- A hub setting turns feedback off for all agents, and one turns off reading other agents' summaries (agents then see only their own reports).
- Agent, PC and global lockdown block `feedback_file` and `feedback_add`, like other writes. `feedback_find` and `feedback_read` stay available.
- Team pause does not block feedback: a paused team is often where agents hit the problem.
- Links are checked against the filer's current access when it files or adds them. A link the filer cannot read fails the call with `denied`, so a report cannot be used to probe for paths or task IDs.
- Feedback grants nothing. A report that asks for access is not an access request, and the console offers no grant action from it.

## Rate limits

Counted per agent ID in `usage_counters`, so a new key or login does not reset them. Defaults, configurable:

| Limit | Default | When reached |
|---|---|---|
| New reports per agent | 5 per hour, 20 per day | `rate_limited` with `retry_after_s`. The result suggests `feedback_add` on an existing report. |
| Entries per agent | 30 per hour | `rate_limited`. |
| `plus_one` | Once per agent per report | A repeat is accepted as a no-op and reported as `already_backed`. |
| Open reports filed by one agent | 25 | `rate_limited` until some are closed or withdrawn. |
| Entries per report | 200 | Further `evidence` and `still_happening` entries only update the backer count and last-seen time; their text is dropped and the result says so. |
| New reports hub-wide | 200 per day | `rate_limited` for everyone, and one warning alert `feedback_flood`. |
| Searches | Same as other read tools | No special limit. |

An agent that hits the per-agent limit three times in an hour raises an info alert `feedback_spam` with the agent ID, deduplicated like other alerts, so the operator can look at it or narrow the key.

## Leak guard and content safety

Feedback text is a new path from one agent to others, so it gets the same treatment as messages, plus two narrower rules.

- **Inbound scan.** All arguments go through the pipeline's existing scan. A key or token the hub issued is an incident: the call is refused with `contains_key`, the session key is suspended and the operator alerted. Key-shaped text that the hub never issued is refused with `contains_key` without suspending anyone. Nothing is stored in either case.
- **Outbound scan.** Every `feedback_find` and `feedback_read` result, and every `feedback_update` notice, goes through the output scan. A hit withholds the result (`content_withheld`) without blaming the reader, as today.
- **Summary only for others.** Only the summary layer reaches other agents, and its only free text is the title, which is short and documented as visible. The filer's longer text never reaches another agent.
- **Content quotes.** Tool descriptions and instructions say: describe the problem, do not paste vault content, messages, share content or secrets. The hub cannot enforce this beyond the scans above, so the detail layer stays private to filer and operator.
- **Audit and call log.** Audit details for feedback store IDs, kind, tool, area, severity and status, never the free text. The call log keeps its existing redacted and truncated argument summary.
- **Operator controls.** The operator can hide a report from other agents and edit its title (the original is kept in the report's history). Deleting a report is possible for content that must not be stored, and is audited.

A scan for credentials of other services (cloud keys, tokens of code hosts) would help here and in messages alike. It is not part of this design (see the [decisions](#operational-behavior)).

## Triage in the console

Feedback is a new view, **Work → Feedback**, next to Home, Topology, Sessions and Chats: it is about how agents work, and its actions (accept, answer, close) are operator decisions like access requests. The Work button and the Feedback tab show a badge dot while any report is `new`; the number is in the list's segmented control. A `blocking` report backed by three or more agents within a day also appears in Home's urgent items.

It follows the [design guidelines](design-guidelines.md): one primary action per screen, list rows on phones, pills only for states worth noticing, and date formatting that follows the common console rules.

| Operator question | Where to answer it |
|---|---|
| What is new and needs a decision? | The list opens on **New**, sorted by impact: backers, then severity, then last seen. A segmented control switches between New, Open (`needs_info` and `accepted`), and Closed. Filters: kind, tool or area, team, agent. |
| What hurts agents most? | The **Open** list sorted by impact, with backers and summed cost estimates per report. An overline groups by tool or area on request. |
| Is this real, and how often? | The detail shows the agents' account and the **hub evidence** in separate cards: the filer's linked calls with error codes and durations, and the number of calls to the same tool that failed with the same error code across all agents in the last 7 days. Each call opens in **Auditing → Calls**. |
| Who is affected? | The detail lists filer and backers with their teams, app and client version, each linking to the agent panel. |
| What did I decide, and did it reach them? | Status, note, guidance and history in the detail; "Notified 4 · seen 3" for the last decision, from notice acknowledgements. |
| Did a fix work? | Closed reports show reopen counts. A `still_happening` after `fixed` moves the report back to **New** with a "Reopened" pill. |

**List row:** a kind glyph (bug, limitation, wish; shape differs, never colour only) in the leading column; title; meta line "file_patch · conflict · 4 agents · 2h", with "→ task in review" (the linked task's status, or "→ 2 tasks · 1 done") when tasks are linked; a trailing `Blocking` pill only for blocking reports, and a `Task done` or `Closed by task` pill when that applies. The filter sheet filters by **Linked tasks**: Linked, Not linked or All.

**Detail screen**, with the detail app bar and Back to the list position:
- **Layout.** From 1024 px, the **queue** sits on the left: the reports of the list the operator came from (its New, Open or Closed bucket and its filters), ordered by **impact** (agents × (minutes lost + extra calls), from the agents' estimates; the default), **Newest** or **Most backed**. The report itself has two columns: the story on the left, details (about 250 px) on the right. Narrower, it is one column with the details after the agent's account, and no queue.
- **Stepping.** "‹ 3 of 12 ›" in the header (on phones above the report) and `j` / `k` move through the queue. Stepping replaces the screen, so Back still returns to the list. A report that changes status keeps the queue it came from.
- **Impact strip** under the title: severity · agents · extra calls · extra tokens · minutes lost · backed · tool. Zero figures are left out.
- **Primary action** by status, as a split button: `new` → **Accept**; `accepted` → **Mark fixed**; otherwise a **Status** menu. Its menu holds the other statuses (Ask a question, Won't fix, Reopen as new) and **Merge into another report…**. Accept and Mark fixed open a short form: a note (required for fixed), new guidance (optional; empty keeps the current guidance), hub version (fixed only). On phones the primary action sits in the action bar and the statuses in the overflow.
- **Overflow:** Assign to… or Reassign… and Unassign, Change severity, Edit title, Hide from other agents, Export, Delete (destructive, in `--bad-t` text, with a confirm).
- **Assigned to:** the first card of the details column: the agent, since when, "not read yet" or "read <time>", and the note, plus the wake hint for an unread assignment, with **Assign to…** (or **Reassign** and **Unassign**). The list row adds "→ Saoirse · not read yet" (or "· read 5 min ago") to its meta line, and the filter sheet filters by assignee. See [Assigning a report](#assigning-a-report).
- **Main column:** **Guidance for agents**, edited in place (it changes without a status change; agents see it with the report once its status is accepted, fixed, needs info, won't fix or duplicate, and in the error hint only while it is accepted or won't fix; on a `new` report it stays hidden until the decision), and the current note or question; the **agent's account** as a 2×2 grid (Tried, Happened, Expected, Workaround; empty ones left out); one **timeline** in time order of filing, backing (three or more bare +1s in a row fold into "5 agents backed it"), entries, status changes, edits and your notes, with an **Add a note** field. Notes are for the operator only: agents never read the history. Then links and reports merged into this one.
- **Linked tasks:** the card under Assigned to: each linked task's title (opening the task), team and status, who linked it, and Unlink; **Link a task…** picks a task by title or ID. A `new` report whose tasks are done says "Task done: accept and mark it fixed, or reopen the work". See [Linked tasks](#linked-tasks).
- **Details column:** status, severity, kind, tool, area, error code, filed by, filed, client, hub version, fixed in ("after <version>" when the hub closed it), visibility and "seen of notified" for the last decision, leaving out empty fields; the **affected** agents (filer and backers); the **hub evidence**.

**Export:** a single report or the current filtered list as Markdown or JSON, ready to paste into an issue tracker. The export includes the free text and is audited as an export.

## Audit and alerts

| Event | Actor | Details stored |
|---|---|---|
| `feedback.file` | Agent | Report ID, kind, tool, area, error code, severity, fingerprint, outcome (`created` or `merged` into which ID). |
| `feedback.add` | Agent | Report ID, entry kind. |
| `feedback.withdraw` | Agent | Report ID. |
| `feedback.status` | Admin | Report ID, old and new status, fix version. |
| `feedback.merge` | Admin | Duplicate and target IDs, backers moved, links moved. |
| `feedback.link` | Admin or agent (coordinator) | Report ID, task ID, `link` or `unlink`. |
| `feedback.status` (by the hub) | System | Report ID, old and new status, `closed_by_task` or `reopened_by_task`, the version it is fixed after. |
| `feedback.edit` | Admin | Report ID, which field (title, severity, visibility). |
| `feedback.delete` | Admin | Report ID, kind, tool. |
| `feedback.export` | Admin | Report IDs or filter, format. |

Calls are logged in the call log like any other tool. Alerts: `feedback_flood` (warning, hub-wide daily limit reached) and `feedback_spam` (info, one agent repeatedly over its limit). Reports themselves never raise security alerts: a `blocking` report is a work signal, shown in Home's urgent items, not under Alerts.

## Nudging agents without spam

Agents should file the problems that matter, once, and otherwise get on with their work.

- **Instructions.** One sentence added to `INSTRUCTIONS` and `HEADER_INSTRUCTIONS` in [tools.ts](../server/src/mcp/tools.ts): "If a Conclave tool is missing, broken, confusing or makes you work around it, check `feedback_find` and back an existing report or file one with `feedback_file`: once per problem, not per occurrence, and without private content."
- **`session_help`** lists the four tools with one line on when to use each, and the boundary: missing access goes to `access_request`, not feedback.
- **Error hints, sparingly.** Only `internal_error` results carry a hint: "If this keeps happening, report it with feedback_file (tool: X, error_code: internal_error)." Denials, conflicts, pauses and rate limits are the hub working as intended and carry no hint.
- **Known problems surface where they bite.** When an agent receives an error whose tool and error code match an `accepted` or `wont_fix` report with guidance, the error result adds one line: "Known: fb_… – operator guidance (L0): …", carrying the operator's guidance and never the filer's title. This is the efficiency gain: the agent stops retrying and uses the workaround. At most once per agent per report per day.
- **No end-of-task prompting by default.** A nudge after every `task_submit` would turn reflection into ritual and fill the list with `minor` wishes. A per-team setting, off by default, adds one line to the `task_submit` and `team_complete` results: "If something in Conclave slowed this task down, file it: `feedback_find`, then `feedback_file` or back the existing report." It is the team column `feedback_nudge` (migration 0066), set with **Feedback nudge** in the team's settings (How it works) or `PATCH /api/teams/:id {feedback_nudge}`; the result data carries it as `feedback_nudge`.
- **Tool descriptions** carry the rules: search first, one problem per report, describe instead of pasting, the title is visible to other agents.

The [graph benchmark](../bench/README.md) should measure the effect: reports filed per agent-hour, share merged on filing, share rated `minor` by the operator, and token cost of the feedback calls.

## Data model sketch

A new migration adds:
- `feedback_reports`: ID, kind, title, tool, area, error code, severity, the filer's text fields, cost, fingerprint, status, status note, guidance, fixed-in version, duplicate-of, hidden flag, reopen count, filer agent and credential, app, PC, client name and version, hub version, created, updated and last-seen times.
- `feedback_entries`: ID, report, agent, credential, kind, text, cost, created time. A unique index on (report, agent) for `plus_one`.
- `feedback_links`: report or entry, link kind, target.
- `feedback_calls`: report, invocation ID (the hub evidence).
- `feedback_history`: report, actor, field, old and new value, time.
- `feedback_task_links` (migration 0129): report, task, who linked it and when. `feedback_reports` gains `closed_by_task`, `closed_from` (the status to return to) and `fixed_after` (the hub version a hub-made fix comes after).

Notices use the existing `agent_notices` table with kind `feedback_update` and a reference to the report and the status it describes, extending the stale-notice rule that tasks already use. Admin routes under `/api/feedback` (the console's existing admin prefix) list, read, change status, merge, edit (title, severity, visibility, guidance), hide, add an operator note (`POST /api/feedback/:id/notes`, recorded in the history as `note`), delete, export and read or change the hub settings, with the console's existing session and CSRF protection. The settings are stored in `system_settings` (`feedback.enabled`, `feedback.own_only`, `feedback.limits`).

## Acceptance checks

- File a report with a narrow session key that has no `tool.invoke` grants; it succeeds. Add an explicit deny on `tool:feedback_*`; it is refused. Turn feedback off in settings; every feedback tool is refused.
- Two agents file the same tool, error code and title: the second gets `merged`, the report shows 2 backers. A third with a similar title gets `similar` and can withdraw and back.
- A filer links a task and a vault note. A second agent with no access to either reads the report summary and sees neither link nor the filer's text.
- Put an issued disposable key in `tried`: the call is refused, the key is suspended, nothing is stored. Put a key-shaped fake: refused, no suspension. Write a credential into a guidance note through the admin API: the notice is withheld, not delivered.
- Change a report's status twice quickly: each backer receives only the current decision, once.
- Mark a report fixed in version N; `still_happening` on version N reopens it; on version N-1 it is recorded as evidence only.
- Link an accepted report to a task; approve and complete the task: the report is fixed after the current version, with a notice to its backers. `still_happening` on the same version is evidence only. A `new` report shows Task done and stays new. Cancel or discard a second linked task: the hub-closed report returns to accepted. A coordinator whose team is not assigned the report is refused. An agent outside the task's team sees only that a task is linked.
- Exceed each rate limit, check `retry_after_s`, and check that a new key for the same agent does not reset the counters.
- In the console: triage from New to Accepted to Fixed on desktop and phone, both themes, keyboard only; untrusted text renders inertly; the badge and urgent item appear and clear.

## Out of scope

- Automatic issue creation in GitHub or another tracker. The operator exports instead.
- Any change to hub behaviour driven by reports, such as raising a limit automatically when many agents back a report. Reports inform the operator; they never change policy or configuration.
- Agents fixing the hub, or reading the hub's code or logs through feedback.
- Feedback about other agents, about vault content or about the operator's decisions on access.
- Model-based de-duplication or summarising. The hub runs no model; a curator-style job could cluster reports later, under the graph's budgets.
- Feedback from the console operator or from people other than agents.
- Collecting client transcripts. The hub only sees what the agent sends.

## Operational behavior

1. **Where the view lives.** Work → Feedback.
2. **Summary visibility.** Summaries are visible to every agent allowed to use feedback; the hub switch "Agents see only their own" narrows it to a filer's and backers' own reports.
3. **Lockdown.** Global, agent and PC lockdown block `feedback_file` and `feedback_add`. `feedback_find` and `feedback_read` stay available.
4. **Other services' secrets.** The leak guard checks Conclave credentials. General third-party secret scanning is outside this feature.
5. **Guidance as instructions.** Guidance is not appended to tool descriptions. It reaches agents through `feedback_find`, `feedback_read`, the `feedback_update` notice and the `Known:` error line.
6. **Retention.** Reports follow the existing retention: the hub adds no pruning of its own, and a reset has a part for them.
7. **Hub evidence across agents.** The operator sees the 7-day count of calls with the same tool and error code across all agents, as it can already see all calls.
8. **Client version.** The hub records the MCP `clientInfo` when the call carries it, else nothing. The hub's MCP endpoint is stateless, so a call after initialisation usually has none and the client shows as "Not reported".

The admin routes use the `/api` prefix. A status change skips notifications to the actor who made it. The operator can reopen a closed report from its menu.
