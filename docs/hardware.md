# Hardware

Hardware lets the operator offer a shared compute machine to agents and see who is using it. Requirements:
[SPEC-HARDWARE-01 to 03](specification.md#hardware). Brief: [next release §6](next-release.md#6-hardware).

**The hub coordinates and enforces who may hold a machine; it does not run or stop anything.** It keeps one ordered
waiting list per machine, gives the machine to the next eligible entry only inside its opening hours, within each team's
daily allowance and while the machine is not paused, and records what the agents tell it. It never opens SSH, installs
keys, or starts or stops jobs. Where the machine's user turned measuring on, the connector on the machine sends the whole
machine's CPU, memory and GPU use ([Measuring](#measuring)). When a holder runs past its window, its team's allowance or
a declared limit, the hub warns it and then flags the hold for the operator; it cannot take the machine away from a
running job.

## Machines

A machine is a PC the hub already knows (`machines`, the same identity as on the PCs screen) with a **compute role**
(`hw_machines`, migrations 0125, 0151 and 0152). A machine can offer compute without hosting an agent or a bridge: **Add machine**
opens the registration sheet, where the operator picks a PC or adds one by name; a new name creates the PC record only
(`POST /api/pcs`), with no key and no enrolment.

The compute role records:

| Field | Rule | Shown to agents |
|---|---|---|
| Access | 1–500 characters: an SSH alias from the user's existing `~/.ssh/config`, or plain access instructions. No password, key or token: the leak guard refuses key-like text. | Yes: this is how an agent reaches the machine. |
| Timezone | An IANA name (`Europe/Lisbon`). | Yes. |
| Opening hours | 0–14 windows, each a set of weekdays with a start and end time (`HH:MM`) in the machine's timezone. An end before the start runs past midnight. No windows means **Any time**. Enforced: see [Opening hours](#opening-hours). | Yes, with whether the machine is open now, until when, and when the next window opens. |
| Daily allowance | Per team the machine serves: hours per local day in the machine's timezone (0.25–24), or none for no limit (`hw_machine_teams.daily_hours`). Enforced: see [Daily allowances](#daily-allowances). | Yes, for the agent's own teams: the allowance and the hours left today. |
| Paused | Whether the operator paused the machine, and when (`hw_machines.paused_at`). See [Pausing](#pausing-a-machine). | Yes, as **Paused**. |
| Memory, CPUs, GPU | Optional shared-use limits the operator declares: memory in GB, a CPU count, a GPU description (up to 120 characters). Where the machine is measured, use over the memory or CPU limit for 2 minutes flags the hold ([Measuring](#measuring)); the GPU description is not checked. | Yes, as limits to respect. Never the measured figures. |
| Shared with people | Whether people use the machine too (`hw_machines.shared_with_people`, migration 0152). The console then says the measured figures include their own use. | No. |
| Notes | Optional, up to 1000 characters. | Yes. |
| Teams | The teams whose agents may use the machine. | No. An agent sees only the machines its live teams may use. |

Credentials stay on the machine or in the user's SSH setup. Removing the compute role (**Stop offering compute**)
ends every entry on the machine's list, each with a notice, closes the machine's open flags (the Hardware screen lists
only machines that offer compute, so they would no longer show), and leaves the PC record as it was.

## Who may join

An agent may join a machine's waiting list when all of these hold:

- the machine has a compute role, its PC is active, and it offers compute to the team the agent names through its task;
- the agent is active and a live member of that team, and the team is running or paused;
- the task belongs to that team, is assigned to the agent, and is `assigned`, `in_progress` or `changes_requested`;
- the agent is not already on that machine's list.

The four tools are default tools: no grant is needed, and an explicit deny on `tool:hw_*` on the session or app key
refuses them. The machine's team list is the authority to use it.

## The waiting list

Entries are ordered by when they joined. When nobody holds the machine, the hub makes the first **eligible** entry the
**holder** at once, with no offer or claim step. An entry is eligible when:

- the machine is not paused;
- the machine is open now (inside a window, or it has no windows);
- the entry's team has hours left today on this machine, and, when the entry gave an estimate, the estimate fits in
  what is left. An entry that does not fit **keeps its place**, and the next eligible entry moves up past it.

No other rule reorders the list. One holder per machine is enforced in the database (a unique index on the holder), so
two simultaneous joins give one holder and one waiting entry. Promotion runs on every read and write of the machine and
with the hub's 30 s upkeep, so a window that opens at 08:00 or an allowance that resets at midnight gives the machine
to the next eligible entry within 30 seconds, without anyone calling a tool.

- **Join** (`hw_join`): the machine, the task, and optionally how many minutes the agent expects to need. The answer
  says whether the agent holds the machine or its place in line, and, when it waits with nobody holding the machine,
  why: the machine is paused, it is closed until the next window (with when that opens), or the agent's team has too few
  hours left today for its estimate (with when they reset). A join is accepted outside the opening hours and while the
  machine is paused; it is **refused** only when the team has no hours left today, and the answer then gives the reset
  time.
- **Report** (`hw_report`, holder only): progress (up to 500 characters) and optionally a new estimate in minutes from
  now. The hub stores the text and the time; it checks nothing on the machine.
- **Leave** (`hw_leave`): `done` or `cancelled`, with an optional note. The next entry becomes the holder and gets a
  notice.
- **List** (`hw_list`): the machines the agent may use, their access, timezone, opening hours (open now and until when,
  or the next window), whether the machine is paused, the hours left today for each of the agent's teams the machine
  serves (with the allowance and when it resets), limits and notes, and each list as the agent may see it. It never
  shows figures of the machine's use.

When an entry becomes the holder, its estimate counts from that moment: the estimated finish is the time it started
holding plus the minutes it gave when it joined, until a report replaces it.

**What an agent sees of the list.** The holder and the waiting entries in order. For entries of the agent's own team:
the agent's label, the task title, since when and the estimate. For entries of other teams: only "an agent of another
team" and the times. A waiting entry never grants access to the machine, SSH credentials or other teams' task details.

**What the operator sees.** Everything: every entry's agent, team and task, the holder's estimated finish and last
report.

## Opening hours

A machine with windows is **open** inside one of them and **closed** otherwise, in its own timezone. A join while it is
closed is accepted as waiting; the entry becomes the holder only once a window opens.

A holder keeps the machine when its window ends, because the hub cannot stop a running job:

- **10 minutes before** the window ends, the holder gets a notice (`hardware_window_ending`) with the end time.
- **At the end**, the hold is flagged **past window** for the operator, and the holder gets a notice asking it to
  finish and call `hw_leave`. The hold is not removed.

## Daily allowances

The operator may give each team a **daily allowance** on a machine: hours per local day in the machine's timezone. The
hub counts the time the team's entries **held** the machine (from becoming holder to leaving or removal), split at
local midnight: a hold from 23:00 to 01:00 counts one hour on each day. A team with no allowance has no daily limit.

- **Joining** is refused when the team has no hours left today; the answer says when the allowance resets (local
  midnight, with the timezone).
- **At promotion**, an entry whose team has no hours left, or fewer than its estimate, keeps its place, and the next
  eligible entry holds the machine. When the allowance resets at midnight, the entry becomes eligible again.
- **10 minutes before** the holder's team reaches its allowance, the holder gets a notice
  (`hardware_allowance_ending`).
- **Past the allowance**, the hold is flagged **past allowance**, and the holder gets a notice. The hold is not removed.

## Pausing a machine

**Pause** stops the hub from giving the machine to anyone new: joins are still accepted as waiting, and no entry becomes
the holder. The current holder keeps the machine until it leaves or is removed. **Resume** promotes the first eligible
entry at once. Both are audited (`hardware.pause`, `hardware.resume`), and agents see **Paused** in `hw_list`.

## Flags

One flags table (`hw_flags`) holds every flag, each with a **kind**:

| Kind | Raised when | The hold |
|---|---|---|
| Lost task or access (`lost`) | The holder was removed because it [lost eligibility](#losing-eligibility); the reason says task or access. | Ended by the hub. |
| Past window (`window`) | The holder still holds the machine after its window ended. | Kept. |
| Past allowance (`allowance`) | The holder's team went past its daily allowance while holding. | Kept. |
| Over limit (`limit`) | Where the machine is measured: its memory or CPU use stayed above the declared limit for 2 minutes during the hold (`hw_flags.detail` says which limit). Worded as the machine's use: "the machine used 52 GB during this hold, over the 48 GB limit". The holder gets a notice without the figures. | Kept: nothing is stopped. |

A hold has at most one flag of each kind (a unique index on the hold and kind), so the 30 s upkeep never repeats one.
A flag stays on the Hardware screen until the operator clears it (**Clear**), and clearing does not raise it again for
the same hold.

## What ran

Every hold is kept as a row of history (`hw_holds`, one per entry that became holder): the agent, team and task, when it
joined and when it started holding, when it ended and how (`done`, `cancelled`, `removed` by the operator, lost `task`
or `access`, or `unregistered`), and its last report. This history counts the allowances and feeds **What ran** and the
analysis on the Hardware screen. Stopping compute on a machine ends its open holds and keeps the history.

The **analysis** for a period (the last 24 hours, 7 days or 30 days), per machine and for all machines, is computed by
the hub from that history and the opening hours:

- **hours held per day**, per team, by local day (the machine's timezone; for all machines, the operator's);
- **the share of open time that was held**: held time inside the opening hours, over the open time in the period;
- **the median and longest wait**: from joining to holding, for the holds that started in the period;
- **holds with a flag**, and **the top tasks** by hours held.

A hold that started before the period counts only its part inside it.

## Measuring

Step 2 of the Hardware screen (requirement [SPEC-HARDWARE-02](specification.md#spec-hardware-02)). A compute machine
may run the connector, paired like any PC (**Add machine → Measure this machine**, the last step of the registration
sheet, points to the PC page, whose **Re-enrol PC** gives the prompt). On a machine with a compute role the connector is
**measure-only** ([Connector](connector.md#measure-only-mode)): check-in, samples, Update and Disconnect; the hub refuses
every other PC order for it, and the connector refuses them too.

**Opt-in.** Nothing is measured until the machine's user runs `conclave hardware on` on it (kept in `preferences.json`
as `hardware_opt_in` and sent in the check-in). The hub refuses samples while the latest check-in says off or says
nothing. `conclave hardware off` stops sampling at once; what the hub has is kept under the retention below.

**Samples.** The whole machine only, as numbers: CPU % (with the CPU count), memory used and total in GB, and per GPU
its utilisation % and memory used and total (from `nvidia-smi` when it is there). No process names, command lines,
paths or users. The connector samples every 15 seconds and sends the samples at each check-in, about once a minute
(`POST /connector/v1/hardware`, at most 120 a batch). A sample more than 5 minutes from the hub's clock is dropped, and a
batch of only such samples is refused, so a wrong PC clock cannot place use in another hold.

**Attribution by time.** Each sample belongs to the hold whose holding time covers it (from `held_since` up to, not
including, `ended_at`), or to no hold. A hold's summary (`hw_hold_use`) keeps the count, average and peak of CPU,
memory and GPU; a day's summary per machine (`hw_use_days`, the machine's local day) keeps the same while held and
while nobody held it. Everywhere the console shows them, they are labelled as **the machine's** figures during the hold,
not proof of what the agent ran, and, when **Shared with people** is set, as including people's own use.

**Over limit.** Memory above `memory_gb`, or CPUs in use (CPU % times the CPU count) above `cpus`, in every sample for
2 minutes of one hold raises one **over limit** flag for that hold, per limit. A gap of more than 3 minutes between
samples restarts the count. Nothing is stopped.

**Retention.** Raw samples are kept 7 days; hold and day summaries 400 days. The summaries have no foreign key to the
machine, so they stay when the machine stops offering compute. The hub's upkeep deletes what is older once an hour.
The **PCs and bridges** reset group clears all three tables.

Agents never see the figures: `hw_list` shows the declared limits only.

## Losing eligibility

The hub checks every entry against the rules under [Who may join](#who-may-join) (with the task allowed in any live
state, `in_review`, `approved` and `blocked` included) on every read and write of the machine (an agent's list, a join,
a report, a leave, and the operator's Hardware screen) and on its own every 30 s, with the hub's upkeep, so a holder
that never calls `hw_leave` is still removed and the next agent moves up without anyone reading the list. An entry that
fails is removed:

- **lost its task**: the task was finished, cancelled, discarded, reassigned or moved to another team;
- **lost access**: the agent was archived or left the team, the team stopped or finished, or the machine no longer
  offers compute to the team.

The agent gets a notice saying why. When the removed entry was the **holder**, the hub also raises a **lost** flag for
the operator: the agent may still be running something on the machine, and the hub cannot stop it. The flag shows on
the Hardware screen until the operator clears it. The next eligible entry moves up as usual.

The operator can also remove any entry (**Remove**): the agent gets a notice, no flag is raised, and the next entry
moves up.

## Console

**Security → Hardware** (`#hardware`), beside PCs: the machines with their live use bars (or **Not measured**), their
flags and the analysis, with a machine page per machine (`#hwm/<pc id>`) for its waiting list, use now, week grid,
allowances, Pause and What ran with each hold's average and peak use. See
[Dashboard UX](dashboard-ux.md#security-workspace).

## Admin API

| Route | Does |
|---|---|
| `GET /api/hardware?period=24h|7d|30d&tz=<IANA>` | Every machine with a compute role: its settings, PC status, whether it is paused, its opening hours now (open, until when, when the next window opens), its teams with their daily allowances and today's use, the holder, the waiting entries in order, open flags (an over-limit flag with `detail` and the hold's `mem_peak` and `cpus_peak`), `shared_with_people`, `measure` (`connector`, `opt_in` as last reported, the latest sample as `live` when under 3 minutes old, `last_at`), **What ran** in the period (one row per hold, with its flags and `use`: samples, first and last time, CPU, memory and GPU average and peak, or null), its week grid (minutes held per weekday and hour over the last 7 days) and its analysis, with `use.held` and `use.idle` (Use with no holder) from the day summaries. Also the counts for the header (machines, in use, waiting), the analysis for all machines (local days in `tz`, default UTC), and the PCs without a compute role, for the registration sheet. The period defaults to 7 days. |
| `PUT /api/hardware/:pcId` | Registers or updates the compute role (the fields above; `teams` is a list of team ids, `allowances` maps a team id to its daily hours or `null`, `shared_with_people` is true or false and kept when left out). |
| `POST /connector/v1/hardware` (app key of the machine's PC) | The connector's samples, `{samples: [{at, cpu_pct, cpu_count?, mem_used_gb, mem_total_gb, gpus?: [{util_pct, mem_used_gb, mem_total_gb}]}]}`, 1–120 a batch; answers `{accepted, duplicates, skewed}`. Refused with 409 for a PC without a compute role, 403 while measuring is off or unknown, 400 when every sample is skewed or a field is not a number in range. |
| `DELETE /api/hardware/:pcId` | Stops offering compute: removes the role and every entry, each with a notice, and ends the open holds. |
| `POST /api/hardware/:pcId/pause`, `POST /api/hardware/:pcId/resume` | Pauses or resumes the machine. |
| `POST /api/hardware/preview` | The text `hw_list` would show an eligible agent for a draft of the fields, before saving. |
| `POST /api/hardware/entries/:seq/remove` | Removes one entry (holder or waiting). |
| `POST /api/hardware/flags/:id/clear` | Clears a flag. |

Audit actions: `hardware.register`, `hardware.update`, `hardware.unregister`, `hardware.pause`, `hardware.resume`,
`hardware.join`, `hardware.hold`, `hardware.leave`, `hardware.remove` (with the reason), `hardware.flag` (with the
kind, and `limit` for an over-limit flag), `hardware.flag_clear`. Samples are not audited. Reports and the 10-minute notices are not audited. A report or a leave note that contains a
key or credential is refused, like Access, GPU and notes.

## Deferred

Not in this release, until the operator has used this version: enforced claims and offer expiry, a "confirmation
needed" state and operator clearance, and a machine allowance in the owner's delegation. Measuring is the whole
machine's: per-process or per-agent figures, checking the GPU description, and stopping anything over a limit are not
planned.
