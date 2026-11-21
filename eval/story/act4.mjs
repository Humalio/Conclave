// Act 4: recovery — the decision, the reveal, redesign, review rounds, a lockdown drill with a restart, recruiting,
// and the outside lab through onboarding, with the deny and needs-changes branches and the PC lifecycle.
import { movePlans, setPlan, bpKey } from './plans.mjs';
import { randomBytes } from 'node:crypto';
import { SKIPPED } from './context.mjs';

const s = (id, title, run, opts = {}) => ({ id, title, run, ...opts });
const V = '/vault';
const nonce = () => `story${randomBytes(12).toString('hex')}`;
const LAB_PROJECT = 'The Echo Case';
const labRequest = (name, extra = {}) => ({
  kind: 'new_team', project: { name: LAB_PROJECT, existing: true },
  team: { name, goal: 'Run the independent capture (CAP-015) on Q-9 receivers for the Echo Case.' },
  roles: [
    { name: 'coordinator', team_role: 'coordinator', count: 1, job: 'Runs the capture and reports to The Annex.', folders: [{ path: `${V}/Captures`, access: 'write' }, { path: `${V}/The Annex`, access: 'read' }] },
    { name: 'tester', team_role: 'worker', count: 1, job: 'Runs the Q-9 receiver and logs every transmission.', folders: [{ path: `${V}/Captures`, access: 'write' }] },
  ],
  prompt: 'A small capture cell for CAP-015: one coordinator and one tester.', client: { app: 'claude-code', os: 'linux' }, ...extra,
});

/** The lab's people: onboarding names agents after the team and role; the operator gives them their names. */
const LAB_NAMES = { coordinator: 'Odile', tester: 'Pell', analyst: 'Maren' };
/** Seats for agents the lab picked up: their keys, on the lab PC, under their own names. Returns the names. */
const seatLab = async (c, picked) => {
  const out = [];
  for (const a of picked.agents) {
    const name = Object.entries(LAB_NAMES).find(([r]) => new RegExp(`\\b${r}\\b`).test(a.label))?.[1] ?? a.label;
    if (name !== a.label) await c.op.patch(`/api/agents/${a.agent_id}`, { label: name });
    c.agents[name] = { id: a.agent_id, label: name, project: LAB_PROJECT };
    c.keys[name] = { id: a.key_id ?? null, secret: a.secret };
    c.seatPc[name] = 'lab';
    out.push(name);
  }
  return out;
};

export default [
  s('4.1', 'The operator answers: switch to Q-9', async (c) => {
    const open = (await c.op.get('/api/decisions')).decisions ?? [];
    c.expect(open.some((d) => d.id === c.S.decision), 'the question is waiting');
    await c.op.post(`/api/decisions/${c.S.decision}/answer`, { option: 'b', text: 'Switch to Q-9. Say why in the Firmware 7 file: the ring band, not the stamp.' });
    const t = (await c.as('Dario').ok('task_list', { team_id: c.T('pc') })).tasks.find((x) => x.id === c.S.t.coil.id);
    c.expect(t.status !== 'blocked', `the dish task returns to Dario (status ${t.status})`);
  }, { beat: 2500 }),

  s('4.2', 'Brannoc reads the decision log', async (c) => {
    const d = await c.as('Brannoc').ok('team_decisions', { team_id: c.T('pc'), status: 'all' });
    c.expect(JSON.stringify(d).includes('Q-9'), 'the answer is in the log');
  }),

  s('4.2b', 'Brannoc lifts the surge block now that Q-9 is decided; the operator lifts a later hold', async (c) => {
    // task_unblock returns a task to the status it was blocked from (F-34); only a coordinator lifts a coordinator's block.
    const B = c.as('Brannoc'), id = c.S.t.quench.id;
    const before = (await B.ok('task_list', { team_id: c.T('pc') })).tasks.find((x) => x.id === id);
    c.eq(before.status, 'blocked', 'surge protection is still blocked from Act 3');
    await c.as('Dario').no('task_unblock', { task_id: id }, 'denied');
    const u = await B.ok('task_unblock', { task_id: id, note: 'Q-9 is decided: the dump path can be designed.' });
    c.expect(u.task.status !== 'blocked' && u.task.blocked_from === null, `the task is back where it was (${u.task.status})`);
    // Brannoc holds it again for the Disclosure Board sign-off; the operator lifts the hold from the console.
    await B.ok('task_block', { task_id: id, reason: 'Hold for the Disclosure Board sign-off of Q-9.' });
    const o = await c.op.post(`/api/teams/${c.T('pc')}/tasks/${id}/unblock`, { note: 'Signed off.' });
    c.eq(o.task.status, u.task.status, 'the operator unblock restores the same status');
  }, { rows: ['teams'] }),

  s('4.2c', 'The operator lets Relay Engineering decide review per task; a wiring check closes without review', async (c) => {
    // Review policy (docs/mcp.md "Review policy"): per project, per task; never self-approval.
    const B = c.as('Brannoc'), D = c.as('Dario'), team = c.T('pc');
    const P = (await c.op.get(`/api/teams/${team}`)).team.project_id;
    await B.no('task_create', { team_id: team, title: 'Label the dump-resistor leads', review: 'none' }, 'invalid_argument');
    c.eq((await c.op.patch(`/api/projects/${P}`, { review_policy: 'per_task' })).project.review_policy, 'per_task', 'the project lets the coordinator decide per task');
    const t = (await B.ok('task_create', { team_id: team, title: 'Label the dump-resistor leads', review: 'none' })).task;
    await B.ok('task_assign', { task_id: t.id, agent_id: c.A('Dario') });
    await D.ok('task_start', { task_id: t.id });
    const done = (await D.ok('task_submit', { task_id: t.id, summary: 'Leads labelled DR-1 to DR-4; photo in the dish log.' })).task;
    c.expect(done.status === 'done' && done.reviewer === null, `no review: done on submit (${done.status})`);
    // The operator takes review off a second task, with a reason, from the console.
    const u = (await B.ok('task_create', { team_id: team, title: 'Re-torque the bus clamps' })).task;
    await B.ok('task_assign', { task_id: u.id, agent_id: c.A('Dario') });
    await D.ok('task_start', { task_id: u.id });
    const r = await c.op.post(`/api/teams/${team}/tasks/${u.id}/review`, { review: 'none', reason: 'Torque values are logged by the wrench.' });
    c.eq(r.task.review, 'none', 'the operator set review none');
    c.eq((await D.ok('task_submit', { task_id: u.id, summary: 'All 12 clamps at 25 N·m.' })).task.status, 'done', 'it closes on submit');
    await c.op.patch(`/api/projects/${P}`, { review_policy: 'required' });
  }, { rows: ['teams'] }),

  s('4.2c', 'The operator answered Dario in chat: Brannoc relays it; the operator confirms one and overturns another', async (c) => {
    // Relayed answers (docs/decisions.md#relayed-answers): L1 until the operator confirms or overturns them.
    const D = c.as('Dario'), B = c.as('Brannoc'), team = c.T('pc');
    const q1 = await D.ok('team_ask', { team_id: team, question: 'Dish clamp bolts: M8 or M10?', options: [{ key: 'a', label: 'M8 at 25 N·m' }, { key: 'b', label: 'M10 at 45 N·m' }], recommended: 'b' });
    await D.no('team_ask_update', { decision_id: q1.decision_id, relayed_answer: 'M10', source: 'chat' }, 'denied');
    const r1 = await B.ok('team_ask_update', { decision_id: q1.decision_id, relayed_answer: 'M10, torqued to 45 N·m.', chosen: 'b', source: 'chat with operator' });
    c.eq(r1.trust, 'L1', 'a relayed answer is L1');
    c.eq(r1.relay?.state, 'pending', 'it waits for the operator');
    c.eq((await c.op.post(`/api/decisions/${q1.decision_id}/confirm`, {})).decision.trust, 'L0', 'confirmed, it is the operator\'s word');
    const q2 = await D.ok('team_ask', { team_id: team, question: 'Thread locker on the clamp bolts?', options: [{ key: 'y', label: 'Yes' }, { key: 'n', label: 'No' }] });
    await B.ok('team_ask_update', { decision_id: q2.decision_id, relayed_answer: 'No locker.', chosen: 'n', source: 'chat with operator' });
    const o = (await c.op.post(`/api/decisions/${q2.decision_id}/overturn`, { option: 'y', text: 'Use a medium-strength locker after all.' })).decision;
    c.eq([o.relay_state, o.answer_option, o.relayed_option], ['overturned', 'y', 'n'], 'the operator overturned it; the relayed answer stays on record');
    // A third relayed answer stays for the end state: the console shows it under "Needs attention" to confirm.
    const q3 = await D.ok('team_ask', { team_id: team, question: 'Order a spare clamp set now?', options: [{ key: 'y', label: 'Order now' }, { key: 'n', label: 'Wait for the review' }] });
    await B.ok('team_ask_update', { decision_id: q3.decision_id, relayed_answer: 'Order now; lead time is six weeks.', chosen: 'y', source: 'chat with operator' });
    // task_list is an overview: one line per task, paged.
    const page = await D.ok('task_list', { team_id: team, limit: 2 });
    c.expect(page.tasks.length <= 2 && page.tasks.every((t) => !('description' in t)), 'task_list gives one line per task');
    c.expect(page.total <= 2 || page.next_cursor, 'task_list pages with a cursor');
    c.expect((await D.ok('task_list', { task_id: c.S.t.coil.id })).tasks[0]?.description !== undefined, 'task_id returns the task in full');
  }, { rows: ['teams'] }),

  s('4.2d', 'Relay Engineering goes back to the backlog intake: the operator filters it by tag, accepts one proposal, discards another and demotes a relayed one', async (c) => {
    // Task backlog (task_rccuivx4jxcup75r): agents' new tasks wait for the operator; only the operator moves them.
    const B = c.as('Brannoc'), D = c.as('Dario'), team = c.T('pc');
    const P = (await c.op.get(`/api/teams/${team}`)).team.project_id;
    c.eq((await c.op.patch(`/api/projects/${P}`, { task_intake: 'backlog' })).project.task_intake, 'backlog', 'new Relay Engineering tasks wait for the operator');
    const a0 = (await B.ok('task_create', { team_id: team, title: 'Spare clamp set: receiving inspection', claimable: true, tags: ['Inspection', 'clamps'] })).task;
    c.eq([a0.status, a0.tags], ['backlog', ['inspection', 'clamps']], 'a coordinator\'s proposal lands in the backlog, filed under the tags it chose');
    // The creator refiles it while it waits; the tag filter finds it for agents and for the operator.
    const a = (await B.ok('task_update', { task_id: a0.id, version: a0.version, tags: ['clamps', 'receiving'] })).task;
    c.expect((await D.ok('task_list', { team_id: team, tag: 'receiving' })).tasks.map((t) => t.id).join() === a.id, 'task_list filters by tag');
    await B.no('task_assign', { task_id: a.id, agent_id: c.A('Dario') }, 'invalid_state');
    await D.no('task_claim', { task_id: a.id, version: a.version }, 'invalid_state');
    c.expect((await D.ok('task_list', { team_id: team, status: 'backlog' })).tasks.some((t) => t.id === a.id), 'agents read the backlog');
    const bl = await c.op.get('/api/tasks/backlog');
    c.expect(bl.tasks.some((t) => t.id === a.id && t.team_name), 'Home lists the proposal across teams, with its team');
    c.expect(bl.tags.some((g) => g.tag === 'clamps'), 'the backlog counts its tags for the filter chips');
    const blf = await c.op.get('/api/tasks/backlog?tag=clamps');
    c.expect(blf.tasks.length >= 1 && blf.tasks.every((t) => t.tags.includes('clamps')), 'the operator filters the backlog by a tag');
    c.expect((await c.op.get(`/api/teams/${team}/tasks?tag=clamps&status=backlog`)).tasks.some((t) => t.id === a.id), 'and the team\'s task list too');
    const a2 = (await B.ok('task_update', { task_id: a.id, version: a.version, description: 'Check the six-week order on arrival: count, torque marks, certificates.' })).task;
    c.eq(a2.status, 'backlog', 'editing a backlog task keeps it in the backlog');
    c.eq((await c.op.post(`/api/teams/${team}/tasks/${a.id}/accept`, { note: 'Yes, before the clamps go in.' })).task.status, 'open', 'the operator accepts it');
    await B.no('task_update', { task_id: a.id, version: a2.version + 1, tags: ['other'] }, 'invalid_state');
    // Accepted, its tags are the operator's to change.
    const a3 = (await c.op.put(`/api/teams/${team}/tasks/${a.id}/tags`, { tags: ['clamps', 'm4'], version: a2.version + 1 })).task;
    c.eq(a3.tags, ['clamps', 'm4'], 'the operator refiles an accepted task');
    await D.ok('task_claim', { task_id: a.id, version: a3.version });
    const x = (await B.ok('task_create', { team_id: team, title: 'Repaint the dish frames' })).task;
    c.eq((await c.op.post(`/api/teams/${team}/tasks/${x.id}/discard`, { note: 'Not this quarter.' })).task.status, 'discarded', 'the operator discards one; it stays in the history');
    c.expect(!(await B.ok('task_list', { team_id: team })).tasks.some((t) => t.id === x.id), 'a discarded task is left out of task_list by default');
    c.expect((await B.ok('task_list', { team_id: team, status: 'discarded' })).tasks.some((t) => t.id === x.id), 'and listed when asked for');
    const r = (await B.ok('task_create', { team_id: team, title: 'Photograph the dump-resistor bay', operator_request: { source: 'chat with operator' } })).task;
    c.eq([r.status, r.operator_request?.trust], ['open', 'L1'], 'a relayed operator request opens at once and stays L1');
    c.eq((await c.op.post(`/api/teams/${team}/tasks/${r.id}/demote`, {})).task.status, 'backlog', 'the operator moves it back to the backlog');
    // One proposal stays for the end state: the console shows it in the backlog to accept or discard.
    await B.ok('task_create', { team_id: team, title: 'Thermal camera survey of the bus bars', description: 'One pass at full charge, before M4.', tags: ['inspection', 'thermal'] });
  }, { rows: ['teams', 'task-backlog'] }),

  s('4.2e', 'The operator offers pc-lab-west for compute: Dario holds it, Lusa waits, reports and release hand it on', async (c) => {
    // Hardware (docs/hardware.md): one holder per machine, an ordered waiting list, the holder's report.
    const B = c.as('Brannoc'), D = c.as('Dario'), L = c.as('Lusa'), team = c.T('pc'), pc = c.pcs.west.pc.id;
    const compute = { access: 'ssh lab-west (the alias is in your ~/.ssh/config)', timezone: 'Europe/Lisbon', windows: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], from: '20:00', to: '07:00' }], memory_gb: 128, cpus: 32, gpu: 'two 48 GB cards', notes: 'Clear /scratch when you finish.', teams: [team] };
    const pv = await c.op.post('/api/hardware/preview', { ...compute, pc_id: pc });
    c.expect(pv.text.includes('Mon–Fri 20:00–07:00'), 'the preview shows the windows in words');
    // The hub enforces opening hours, so a replay outside Mon–Fri 20:00–07:00 Lisbon time could not hold the machine.
    // The operator registers it open at any time; the night window above is only previewed.
    const reg = await c.op.put(`/api/hardware/${pc}`, { ...compute, windows: [] });
    c.expect(reg.machines.some((m) => m.id === pc), 'pc-lab-west is offered for compute');
    const [t1, t2] = [(await B.ok('task_create', { team_id: team, title: 'Simulate the dish surge at 3 MV' })).task, (await B.ok('task_create', { team_id: team, title: 'Fit the power budget model' })).task];
    // Relay Engineering takes proposals into its backlog since 4.2d: the operator accepts both first.
    for (const t of [t1, t2]) await c.op.post(`/api/teams/${team}/tasks/${t.id}/accept`, { note: 'Needed for the surge study.' });
    await B.ok('task_assign', { task_id: t1.id, agent_id: c.A('Dario') });
    await B.ok('task_assign', { task_id: t2.id, agent_id: c.A('Lusa') });
    const list = await D.ok('hw_list', {});
    c.expect((list.machines ?? []).some((m) => m.name === 'pc-lab-west'), 'Dario sees pc-lab-west in hw_list');
    c.expect((await D.ok('hw_join', { machine: 'pc-lab-west', task_id: t1.id, estimate_minutes: 120 })).holder === true, 'Dario holds it at once');
    c.expect((await L.ok('hw_join', { machine: 'pc-lab-west', task_id: t2.id, estimate_minutes: 45 })).holder === false, 'Lusa waits behind him');
    await L.no('hw_report', { machine: 'pc-lab-west', progress: 'Waiting.' }, 'invalid_state');
    await D.ok('hw_report', { machine: 'pc-lab-west', progress: 'Surge run 2 of 5; peak 2.7 MV so far.', estimate_minutes: 90 });
    c.expect((await D.ok('hw_leave', { machine: 'pc-lab-west', outcome: 'done', note: 'Results in the dish log.' })).moved_up === true, 'releasing moves Lusa up');
    const now = (await c.op.get('/api/hardware')).machines.find((m) => m.id === pc);
    c.eq(now.holder?.agent_id, c.A('Lusa'), 'Lusa holds pc-lab-west');
    await L.ok('hw_report', { machine: 'pc-lab-west', progress: 'Budget model fitted for three of five loads.' });
  }, { rows: ['hardware'] }),

  s('4.3', 'Vesna is granted two hours of Classified — and reads the truth', async (c) => {
    const reqs = (await c.op.get('/api/requests')).requests ?? [];
    c.expect(reqs.some((r) => r.id === c.S.accessReq), 'Vesna\'s request is listed');
    await c.op.post(`/api/requests/${c.S.accessReq}/approve`, { duration: '2h' });
    const st = await c.as('Vesna').ok('access_status', { request_id: c.S.accessReq });
    c.expect(/approved/.test(JSON.stringify(st)), 'approved');
    const memo = await c.as('Vesna').ok('file_read', { path: `${V}/Classified/Director/What answers us.md` });
    c.expect(memo.content.includes('substrate'), 'the director\'s memo names the substrate');
    await c.as('Vesna').ok('file_read', { path: `${V}/Classified/Vendor/Build 7 test report.md` });
    await c.as('Vesna').ok('file_read', { path: `${V}/Classified/Vendor/Intercepted message.md` });
    const rel = await c.as('Vesna').ok('graph_related', { path: `${V}/Captures/CAP-014b Empty dish.md` });
    c.expect(JSON.stringify(rel).includes('What answers us'), 'the trail now reaches the memo');
  }, { beat: 5000, rows: ['policy', 'trust-boundaries'] }),

  s('4.4', 'Dario restores his scratch note and redesigns the dish for Q-9', async (c) => {
    const D = c.as('Dario');
    await D.ok('file_restore', { path: `${V}/Relay Engineering/scratch.md`, revision: c.S.scratchRev, base_revision: 'absent' });
    const p = `${V}/Relay Engineering/Dish array design.md`;
    const r = await D.ok('file_read', { path: p });
    const first = r.content.split('\n').find((l) => /^[A-Z]/.test(l) && l.length > 30);
    await D.ok('file_patch', { path: p, base_revision: r.revision, edits: [{ old: first, new: `${first}\n\n**Redesign for Q-9 (decision of 2 June):** receiver rack mass +1.6 kg; feed supports re-sized; surge margin re-checked at 16.7 %.` }] });
  }, { rows: ['vault-recovery'] }),

  s('4.5', 'Vesna and Lusa update the Firmware 7 file and the power budget', async (c) => {
    const a = await c.as('Vesna').ok('file_read', { path: `${V}/Theories/Firmware 7.md` });
    await c.as('Vesna').ok('file_update', { path: `${V}/Theories/Firmware 7.md`, base_revision: a.revision, content: a.content.replace('## Front-end response', '## Decision: Q-9\n\nWithdrawn as the explanation: CAP-014 heard the echo with no firmware in the loop. The receivers switch to the Q-9 quiet receiver, which has no front end in the 2.3 GHz ring band, where the standard front end rings for most of a second. Requirement: no receiver on Tern-9 may respond in that band. Q-9 is not more accurate; it is deaf where the standard one rings.\n\n## Front-end response') });
    const b = await c.as('Lusa').ok('file_read', { path: `${V}/Relay Engineering/Power budget.md` });
    await c.as('Lusa').ok('file_update', { path: `${V}/Relay Engineering/Power budget.md`, base_revision: b.revision, content: b.content + '\n## Q-9 change\n\nReceiver rack mass +1.6 kg adds 0.4 % to cryo load; bank energy unchanged.\n' });
  }),

  s('4.5b', 'Hollis adds the answer to the disclosure case as §9', async (c) => {
    const r = await c.as('Hollis').ok('file_read', { path: `${V}/Oversight/Disclosure case.md` });
    c.expect(!r.content.includes('## §9'), 'no §9 yet');
    await c.as('Hollis').ok('file_update', { path: `${V}/Oversight/Disclosure case.md`, base_revision: r.revision, content: r.content.trimEnd() + '\n\n## §9 The answer\n\nAbove transmit power 0.32 the dish touches a structured medium, the substrate, and the substrate answers: a reply that leads the send by 0.71 s and rings the standard receiver front end in the 2.3 GHz band, seen as the 1.92 kHz line in strain. Hazard H-13. The receivers shall be Q-9; no transmission shall exceed P 0.30 until CAP-015 passes.\n' });
  }, { rows: ['knowledge'] }),

  s('4.6', 'The owners close their stale flags as fixed', async (c) => {
    await c.as('Dario').ok('graph_resolve', { flag_id: c.S.flags.coil, status: 'fixed' });
    await c.as('Lusa').ok('graph_resolve', { flag_id: c.S.flags.budget, status: 'fixed' });
    await c.as('Vesna').ok('graph_resolve', { flag_id: c.S.flags.alloy, status: 'fixed' });
  }, { rows: ['knowledge'] }),

  s('4.7', 'Ezra dismisses one flag and invalidates the disputed claim', async (c) => {
    await c.as('Ezra').ok('graph_resolve', { flag_id: c.S.flags.safety, status: 'dismissed' });
    const r = await c.as('Ezra').ok('graph_decide', { id: c.S.disputed, decision: 'invalidate' });
    c.expect(/invalid/.test(JSON.stringify(r)), 'the claim is invalidated');
  }, { rows: ['knowledge'] }),

  s('4.8', 'A second decision on the same claim is refused', async (c) => {
    await c.as('Kemi').no('graph_decide', { id: c.S.disputed, decision: 'uphold' }, /invalid_state|conflict|not_found|denied/);
  }, { rows: ['knowledge'] }),

  s('4.9', 'Dario replaces his submission in review; Ezra\'s stale verdict is refused; surge margin; approved', async (c) => {
    const D = c.as('Dario'), E = c.as('Ezra'), id = c.S.t.coil.id;
    await D.ok('task_start', { task_id: id }).catch(async () => {});
    const v1 = (await D.ok('task_submit', { task_id: id, summary: 'Dish redesigned for Q-9; supports re-sized.' })).task.version;
    // Dario finds the support drawings missing and replaces the pending submission: same reviewer, a new version.
    const r2 = (await D.ok('task_submit', { task_id: id, summary: 'Dish redesigned for Q-9; supports re-sized (supports in Relay Engineering/Dish array design.md).' })).task;
    c.expect(r2.status === 'in_review' && r2.version > v1 && r2.review_rounds === 0, 'the replacement stays in review with a new version and no extra round');
    // Ezra read the first version: that verdict is refused, and he reviews the current one.
    await E.no('task_review', { task_id: id, decision: 'approve', comments: 'Looks right.', version: v1 }, /conflict/);
    await E.ok('task_review', { task_id: id, decision: 'request_changes', comments: 'Show the surge margin at 18 K with the Q-9 receivers, against R3.', version: r2.version });
    await D.ok('task_start', { task_id: id });
    await D.ok('task_submit', { task_id: id, summary: 'Surge margin 16 % at 18 K with Q-9.' });
    // A typo in the margin: Dario takes the submission back and submits the corrected one.
    c.expect((await D.ok('task_withdraw', { task_id: id, note: 'Margin typo: 16.7 %, not 16 %.' })).task.status === 'in_progress', 'the withdrawn task is back in progress');
    const v4 = (await D.ok('task_submit', { task_id: id, summary: 'Surge margin 16.7 % at 18 K with Q-9 (R3 met).' })).task.version;
    await E.ok('task_review', { task_id: id, decision: 'approve', comments: 'R3 met with margin.', version: v4 });
    await c.as('Brannoc').ok('task_complete', { task_id: id, summary: 'Dish redesign for Q-9 accepted by the Disclosure Board reviewer.' });
  }, { beat: 3000, rows: ['teams'] }),

  s('4.9b', 'Plans follow the Q-9 redesign; Case Command adds the answer', async (c) => {
    await movePlans(c, 4);
  }, { beat: 2000 }),

  s('4.10', 'The operator pauses Signals Lab', async (c) => {
    for (let i = 0; i < 20; i++) { const w = await c.as('Teodor').ok('work_next', { wait_seconds: 0 }); if (!w.item) break; await c.as('Teodor').ok('work_ack', { item_id: w.item.item_id }); }
    await c.op.post(`/api/teams/${c.T('fp')}/pause`);
  }),

  s('4.11', 'A message to a member of a paused team arrives through message_read; work_next says paused', async (c) => {
    await c.as('Orla').ok('message_send', { to: c.A('Teodor'), body: 'When we resume: rerun the power fit with the Q-9 receivers.', client_msg_id: 'orla-teodor-resume' });
    let w;
    for (let i = 0; i < 10; i++) {
      w = await c.as('Teodor').ok('work_next', { wait_seconds: 0 });
      if (!w.item) break;
      c.expect(!JSON.stringify(w.item).includes('rerun the power fit'), 'no message is queued as a work item');
      await c.as('Teodor').ok('work_ack', { item_id: w.item.item_id });
    }
    c.eq(w.status, 'paused', 'work_next says paused');
    const read = await c.as('Teodor').ok('message_read', { wait_seconds: 0 });
    c.expect(JSON.stringify(read).includes('rerun the power fit'), 'the message arrives through message_read while paused');
    if (read.next_cursor) await c.as('Teodor').ok('message_ack', { cursor: read.next_cursor });
  }, { rows: ['teams'] }),

  s('4.12', 'Lockdown drill: writes off', async (c) => {
    await c.op.post('/api/lockdown', { scope: 'writes', on: true });
  }, { beat: 2000, rows: ['console-lockdown'] }),

  s('4.13', 'Writes and filing are refused; finding still works', async (c) => {
    const b = await c.as('Lusa').ok('file_read', { path: `${V}/Relay Engineering/Power budget.md` });
    await c.as('Lusa').no('file_update', { path: `${V}/Relay Engineering/Power budget.md`, base_revision: b.revision, content: b.content + '\nDuring the drill.\n' }, 'lockdown');
    await c.as('Rafi').no('feedback_file', { kind: 'wish', title: 'A way to queue writes during a lockdown', tried: 'Saved during the drill.', severity: 'minor' }, 'lockdown');
    await c.as('Rafi').ok('feedback_find', { query: 'file_patch' });
  }, { rows: ['console-lockdown', 'feedback'] }),

  s('4.13b', 'The hub restarts on the same data', async (c) => {
    if (!c.hub.restart) { c.S.restarted = false; return SKIPPED; }
    await c.hub.restart();
    for (const key of Object.keys(c.pcs)) if (c.pcs[key].conn) await c.connectPc(key);
    c.S.restarted = true;
  }, { beat: 3000 }),

  s('4.13c', 'What survives the restart', async (c) => {
    if (!c.S.restarted) return SKIPPED;
    await c.op.login(c.hub.admin.username, c.hub.admin.password);
    const lk = await c.op.get('/api/lockdown');
    c.expect(lk.writes_disabled === true, `lockdown is still on (${JSON.stringify(lk).slice(0, 160)})`);
    const fp = (await c.op.get(`/api/teams/${c.T('fp')}`)).team;
    c.eq(fp.status, 'paused', 'Signals Lab is still paused');
    const st = await c.as('Vesna').ok('access_status', { request_id: c.S.accessReq });
    c.expect(/approved/.test(JSON.stringify(st)), 'Vesna\'s grant survives');
    await c.as('Vesna').ok('file_read', { path: `${V}/Classified/Director/What answers us.md` });
    await c.as('Lusa').ok('session_whoami', {});
    c.eq((await c.as('Teodor').ok('work_next', { wait_seconds: 0 })).status, 'paused', 'work_next still says paused');
  }, { rows: ['policy', 'console-lockdown'] }),

  s('4.14', 'Lockdown off, Signals Lab resumes; the message read while paused does not come again', async (c) => {
    await c.op.post('/api/lockdown', { scope: 'writes', on: false });
    await c.op.post(`/api/teams/${c.T('fp')}/resume`);
    const seen = [];
    for (let i = 0; i < 10; i++) { const w = await c.as('Teodor').ok('work_next', { wait_seconds: 0 }); if (!w.item) break; seen.push(JSON.stringify(w.item)); await c.as('Teodor').ok('work_ack', { item_id: w.item.item_id }); }
    c.eq(seen.filter((x) => x.includes('rerun the power fit')).length, 0, 'the message is not delivered a second time');
  }, { rows: ['teams'] }),

  s('4.15', 'Dunmore proposes a recruit; it waits for the operator', async (c) => {
    await c.as('Dunmore').ok('team_recruit', { team_id: c.T('sy'), label: 'Tamsin', role: 'worker', purpose: 'Rigger for the frame 44 mount doublers.' });
    const r = (await c.op.get('/api/recruits')).requests ?? [];
    c.expect(r.some((x) => /Tamsin/.test(JSON.stringify(x)) && /pending/.test(JSON.stringify(x))), 'Tamsin is pending');
  }),

  s('4.16', 'The operator adds pc-night-choir', async (c) => {
    const r = await c.op.post('/api/pcs/add', { name: 'pc-night-choir', description: 'The Night Choir, amateur listeners: the Q-9 capture dish' });
    c.expect(r.code && !('prompt' in r) && !String(r.connector_prompt ?? '').includes(r.code) && !JSON.stringify(r).includes('ah_app'), 'the code comes back once; no legacy prompt, and no app key anywhere');
    c.pcs.lab = { pc: r.pc, appKey: null, bound: true };
    c.S.labCode = r.code;
  }, { rows: ['onboarding'] }),

  s('4.17', 'The lab enrols with the code', async (c) => {
    c.S.labNonce = nonce();
    const e = await c.ob.ok('POST', '/enrol', null, { code: c.S.labCode, nonce: c.S.labNonce });
    await c.ob.ok('POST', '/enrol/confirm', null, { nonce: c.S.labNonce });
    c.pcs.lab.appKey = e.app_key;
    const again = await c.ob.call('POST', '/enrol', null, { code: c.S.labCode, nonce: nonce() });
    c.expect(again.status >= 400, 'the code cannot be used again after confirm');
  }, { rows: ['onboarding'] }),

  s('4.18', 'The lab files a request; a second one is refused while it waits', async (c) => {
    const r = await c.ob.ok('POST', '/requests', c.pcs.lab.appKey, labRequest('Night Choir Capture'));
    c.S.labReq = r;
    const second = await c.ob.call('POST', '/requests', c.pcs.lab.appKey, labRequest('Night Choir Capture 2'));
    c.eq(second.json.error, 'invalid_state', 'the second request is refused');
    c.expect(String(second.json.message).includes(r.request_id), 'the refusal names the pending request');
  }, { rows: ['onboarding'] }),

  s('4.18b', 'The operator asks for changes; the lab amends', async (c) => {
    await c.op.post(`/api/onboarding/${c.S.labReq.request_id}/needs-changes`, { note: 'Name the capture in the team goal (CAP-015) and keep the tester read-only on The Annex.' });
    const st = await c.ob.ok('GET', `/requests/${c.S.labReq.request_id}?wait_s=0`, c.pcs.lab.appKey);
    c.expect(/changes/.test(st.state), `the request needs changes (${st.state})`);
    const a = await c.ob.ok('PUT', `/requests/${c.S.labReq.request_id}`, c.pcs.lab.appKey, { version: st.version, ...labRequest('Night Choir Capture', { prompt: 'The Night Choir capture cell for CAP-015.' }) });
    c.S.labReq = { ...c.S.labReq, version: a.version };
  }, { rows: ['onboarding'] }),

  s('4.18c', 'The operator denies it; nothing is created; the lab files again', async (c) => {
    await c.op.post(`/api/onboarding/${c.S.labReq.request_id}/deny`, { note: 'Refile with the team name the case uses: Night Choir Capture.' });
    const teams = (await c.op.get('/api/teams')).teams;
    c.expect(!teams.some((t) => t.name === 'Night Choir Capture'), 'deny leaves no team');
    c.S.labReq = await c.ob.ok('POST', '/requests', c.pcs.lab.appKey, labRequest('Night Choir Capture'));
  }, { rows: ['onboarding'] }),

  s('4.19', 'One approval, with an edit: the tester\'s key is free', async (c) => {
    const d = await c.op.get(`/api/onboarding/${c.S.labReq.request_id}`);
    const slots = d.slots ?? d.request?.slots ?? d.agents ?? [];
    const tester = slots.find((x) => /tester/.test(x.slot ?? x.role ?? x.name)) ?? slots[1];
    await c.op.post(`/api/onboarding/${c.S.labReq.request_id}/approve`, { version: d.version ?? d.request?.version ?? c.S.labReq.version, start_when_set_up: true, ...(tester?.slot ? { agents: [{ slot: tester.slot, bound: false }] } : {}) });
    const t = (await c.op.get('/api/teams')).teams.find((x) => x.name === 'Night Choir Capture');
    c.expect(t && t.status === 'draft', 'the team exists as draft');
    c.teams.lab = t;
  }, { rows: ['onboarding'] }),

  s('4.20', 'The lab picks up its keys and confirms', async (c) => {
    const p = await c.ob.ok('POST', '/pickup', c.pcs.lab.appKey, { request_id: c.S.labReq.request_id });
    await c.ob.ok('POST', '/pickup/confirm', c.pcs.lab.appKey, { pickup_id: p.pickup_id, written: p.agents.map((a) => a.session_var), transport: 'http' });
    c.S.labAgents = await seatLab(c, p);
    await c.connectPc('lab');
  }, { rows: ['onboarding'] }),

  s('4.21', 'The lab coordinator logs in and starts CAP-015', async (c) => {
    const coord = c.S.labAgents[0];
    for (const l of c.S.labAgents) await c.login(l);
    const info = await c.as(coord).ok('team_info', {});
    c.expect(/running/.test(JSON.stringify(info)), 'the team runs with no Start step');
    // A usage limit is near: the coordinator pauses the team until a set time, then ends the pause early (docs/mcp.md, Pausing the team).
    const until = Date.now() + 60 * 60_000;
    await c.as(coord).ok('team_pause', { team_id: c.T('lab'), reason: 'usage limit', until });
    const held = JSON.stringify(await c.as(coord).ok('team_info', { team_id: c.T('lab') }));
    c.expect(held.includes('"paused_until":' + until) && held.includes('usage limit'), 'team_info shows the end time and the reason');
    await c.as(coord).ok('team_resume', { team_id: c.T('lab') });
    // Reset (connector design 3c): the coordinator resets a member of its own team; the order waits for that PC (with no PC, the person's steps).
    const reset = JSON.stringify(await c.as(coord).ok('agent_reset', { team_id: c.T('lab'), agent_id: c.A(c.S.labAgents[1]) }));
    c.expect(/"order":"pca_|"by_hand":true/.test(reset), "a coordinator resets its own team's agent");
    await setPlan(c, 'lab', coord);
    await c.as(coord).ok('task_create', { team_id: c.T('lab'), title: 'CAP-015 block A', description: 'Q-9 receiver Q-1, 200 transmissions at power 0.25, log checks at 100 and 200.', refs: ['NC-R1', 'NC-M1'].map(bpKey) });
  }, { rows: ['onboarding'] }),

  s('4.22', 'The lab adds a data analyst with add_agents', async (c) => {
    const r = await c.ob.ok('POST', '/requests', c.pcs.lab.appKey, { kind: 'add_agents', project: { name: LAB_PROJECT, existing: true }, team: { id: c.T('lab') }, roles: [{ name: 'analyst', team_role: 'worker', count: 1, job: 'Reduces the strain data and the 1.92 kHz line.', folders: [{ path: `${V}/Captures`, access: 'read' }] }], prompt: 'one data analyst' });
    const d = await c.op.get(`/api/onboarding/${r.request_id}`);
    await c.op.post(`/api/onboarding/${r.request_id}/approve`, { version: d.version ?? d.request?.version ?? r.version });
    const p = await c.ob.ok('POST', '/pickup', c.pcs.lab.appKey, { request_id: r.request_id });
    await c.ob.ok('POST', '/pickup/confirm', c.pcs.lab.appKey, { pickup_id: p.pickup_id, written: p.agents.map((a) => a.session_var) });
    c.S.labAgents.push(...(await seatLab(c, p)));
    await c.login(c.S.labAgents.at(-1));
  }, { rows: ['onboarding'] }),

  s('4.23', 'The lab shares its capture data; Hesper promotes it, one file conflicts', async (c) => {
    const coord = c.S.labAgents[0];
    await c.op.post('/api/links', { from_agent_id: c.A(coord), to_agent_id: c.A('Hesper'), kind: 'reports-to', note: 'The Night Choir reports CAP-015 to The Annex', grants_messaging: true });
    const key = ((await c.op.get('/api/keys?kind=session_key')).keys ?? []).find((k) => k.agent_id === c.A(coord) && k.status === 'active');
    const cur = (await c.op.get(`/api/keys/${key.id}/rules`)).rules.filter((r) => !r.team_id).map(({ effect, actions, resource }) => ({ effect, actions, resource }));
    await c.op.put(`/api/keys/${key.id}/rules`, { rules: [...cur, { effect: 'allow', actions: ['tool.invoke'], resource: 'tool:share_*' }, { effect: 'allow', actions: ['share.create', 'share.upload', 'share.read'], resource: 'share:*' }, { effect: 'allow', actions: ['share.with', 'message.send', 'message.receive'], resource: `agent:${c.A('Hesper')}` }], note: 'The Night Choir shares CAP-015 results with The Annex' });
    await c.op.get('/api/grants');
    const sh = await c.as(coord).ok('share_create', { name: 'CAP-015 captures', description: 'Receiver map and the plan update.', with: [c.A('Hesper')] });
    const sid = sh.share_id ?? sh.share?.id;
    await c.as(coord).ok('share_upload', { share_id: sid, final: true, files: [
      { path: 'CAP-015 Independent capture.md', content: '# CAP-015 Independent capture\n\n## Status\n\nThe Night Choir has the receiver.\n' },
      { path: 'CAP-015 receiver map.md', content: '# CAP-015 receiver map\n\n## Map\n\nQ-1 on a titanium backing plate (heat 44-118), twelve probe sites.\n' },
      { path: 'CAP-015 rig sheet.md', content: '# CAP-015 rig sheet\n\n## Rig\n\nSubscale dish, 1:20, at the Night Choir.\n' },
    ] });
    const st = await c.as('Hesper').ok('file_stat', { path: `${V}/Captures/CAP-015 Independent capture.md` });
    const r = await c.as('Hesper').ok('share_promote', { share_id: sid, version: 1, to: `${V}/Captures`, base_revisions: { 'CAP-015 Independent capture.md': `${st.revision.slice(0, -4)}0000` } });
    const j = JSON.stringify(r);
    const res = r.results ?? [];
    c.expect(res.filter((x) => x.result === 'created').length === 2 && res.filter((x) => x.result === 'conflict').length === 1, `two created, one conflict (${j.slice(0, 240)})`);
  }, { beat: 3000, rows: ['transfers'] }),

  s('4.24', 'PC lifecycle: suspend, reactivate, re-enrol pc-night-choir', async (c) => {
    const pc = c.pcs.lab.pc.id;
    await c.op.post(`/api/pcs/${pc}/suspend`);
    const blocked = await c.ob.call('POST', '/requests', c.pcs.lab.appKey, labRequest('Night Choir Spare'));
    c.expect(blocked.status >= 400, 'a suspended PC cannot file');
    // A suspended PC refuses everything, status included (docs/onboarding.md): its key is cut off.
    const status = await c.ob.call('GET', `/requests/${c.S.labReq.request_id}?wait_s=0`, c.pcs.lab.appKey);
    c.eq(status.status, 401, 'a suspended PC cannot read status either');
    await c.op.post(`/api/pcs/${pc}/reactivate`);
    const re = await c.op.post(`/api/pcs/${pc}/re-enrol`);
    const old = await c.ob.call('GET', `/requests/${c.S.labReq.request_id}?wait_s=0`, c.pcs.lab.appKey);
    c.expect(old.status >= 400, 'the old app key stops at once');
    const n = nonce();
    const e = await c.ob.ok('POST', '/enrol', null, { code: re.code, nonce: n });
    await c.ob.ok('POST', '/enrol/confirm', null, { nonce: n });
    c.pcs.lab.appKey = e.app_key;
    for (const reqId of (re.reopened ?? []).map((x) => x.id ?? x.request_id ?? x)) {
      const p = await c.ob.ok('POST', '/pickup', c.pcs.lab.appKey, { request_id: reqId });
      await c.ob.ok('POST', '/pickup/confirm', c.pcs.lab.appKey, { pickup_id: p.pickup_id, written: p.agents.map((a) => a.session_var) });
      await seatLab(c, p);
    }
    await c.connectPc('lab');
    for (const l of c.S.labAgents) await c.login(l);
  }, { beat: 3000, rows: ['onboarding'] }),
];
