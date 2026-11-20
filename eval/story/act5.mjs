// Act 5: disclosure — independent review, the checkpoint, the decision record, the last log line, completion (docs/showcase.md §4).
import { Admin } from './lib.mjs';

const s = (id, title, run, opts = {}) => ({ id, title, run, ...opts });
const V = '/vault';

// ───── the checkout restore: the story calls the hub routes the way the connector does ─────
// The connector's own restore runs against the real hub in server/test/connector-restore-real.test.ts.
const LAB_URL = 'https://git.relay.example/lab/cap-015.git';
const LAB_BRANCH = 'integration/cap-015';

import { movePlans, writePlan, bpKey } from './plans.mjs';

const ORDER = `---
owner: Disclosure Board
status: active
depends_on: ["[[Disclosure case]]", "[[Hazard log]]", "[[CAP-015 Independent capture]]"]
tags: [disclosure-order, m6, decision-record]
---
# Disclosure order

## Decision

The Disclosure Board approves a partial disclosure of the Echo Case, on the disclosure case revision with §9, for the live listen (M4) and the Tern-9 refit (M5), with the receivers on Q-9.

## Conditions

1. No transmission shall exceed power 0.30 until CAP-015 passes block B.
2. Hazard H-13 (the answer) stays open until the live listen shows Q-9 quiet through the 2.3 GHz ring.
3. No frost in the relay loop until the ethics review closes. Frost specimen F-3 stays sealed in SC-1.

## Basis

Independent review by Hollis and Ezra (R10). The Q-9 decision of 2 June. The director's account of echo 47.
`;

/** The last line of the story: a station-log entry for a reply to a message nobody has written yet. */
const LAST_ENTRY = '| 6 Jun | none | 03:12, receiver bay 2. A reply logged at the dish, 0.71 s lead, to a message that is not in the send queue. Its send stamp reads 9 Jun, 22:14. Nobody has written it yet. | Dunmore |';

export default [
  s('5.1', 'Hollis joins Case Command as reviewer; Wynn writes disclosure case v2', async (c) => {
    await c.op.post(`/api/teams/${c.T('int')}/members`, { agent_id: c.A('Hollis'), role: 'reviewer', credential_id: c.keys.Hollis.id });
    const t = (await c.as('Saoirse').ok('task_create', { team_id: c.T('int'), title: 'Disclosure case v2', description: 'Bring §1–§9 together for the disclosure order, with the Q-9 decision and H-13.', reviewer: c.A('Hollis'), refs: ['R10', 'R11', 'R13'].map(bpKey) })).task;
    await c.as('Saoirse').ok('task_assign', { task_id: t.id, agent_id: c.A('Wynn'), reviewer: c.A('Hollis') });
    await c.as('Wynn').ok('task_start', { task_id: t.id });
    await c.as('Wynn').ok('task_submit', { task_id: t.id, summary: 'Disclosure case v2: §4 on Q-9, §9 the answer, H-13 open with conditions.' });
    c.S.t.safety = t;
  }, { beat: 2500 }),

  s('5.2', 'Marguerite opens the independent review', async (c) => {
    const t = (await c.as('Marguerite').ok('task_create', { team_id: c.T('sb'), title: 'Independent review: disclosure case v2', description: 'Review against R10. Read every cited source, including Classified.', refs: ['DB-R1', 'DB-M2'].map(bpKey) })).task;
    await c.as('Marguerite').ok('task_assign', { task_id: t.id, agent_id: c.A('Marguerite'), reviewer: c.A('Ezra') });
    c.S.t.review = t;
  }),

  s('5.3', 'Hollis reads the sources and approves Wynn\'s work', async (c) => {
    const H = c.as('Hollis');
    const sc = await H.ok('file_read', { path: `${V}/Oversight/Disclosure case.md` });
    c.expect(sc.content.includes('## §9 The answer'), 'the disclosure case carries §9');
    await H.ok('file_read', { path: `${V}/Classified/Director/What answers us.md` });
    const read = (await H.ok('task_list', { task_id: c.S.t.safety.id })).tasks[0].version;
    await H.ok('task_review', { task_id: c.S.t.safety.id, decision: 'approve', comments: 'Sources checked, including the director\'s memo. §9 is sound.', version: read });
  }, { beat: 3000, rows: ['knowledge'] }),

  s('5.4', 'Saoirse completes it; the checkpoint waits for the operator', async (c) => {
    await c.as('Saoirse').ok('task_complete', { task_id: c.S.t.safety.id, summary: 'Disclosure case v2 accepted by the Disclosure Board reviewer.' });
    const t = (await c.op.get(`/api/teams/${c.T('int')}/tasks/${c.S.t.safety.id}`)).task;
    c.expect(t.status !== 'done' && (t.awaiting_approval || /approv/.test(t.status)), `the task waits for the operator (status ${t.status})`);
  }, { rows: ['teams'] }),

  s('5.5', 'The operator approves the checkpoint', async (c) => {
    const r = await c.op.post(`/api/teams/${c.T('int')}/tasks/${c.S.t.safety.id}/approve`);
    c.eq(r.task.status, 'done', 'the task is done');
  }, { rows: ['teams'] }),

  s('5.6', 'Hollis writes the disclosure order and the decision record', async (c) => {
    const H = c.as('Hollis');
    await H.ok('file_create', { path: `${V}/Oversight/Disclosure order.md`, content: ORDER });
    const log = await H.ok('file_read', { path: `${V}/Case Command/Decision log.md` });
    await H.ok('file_update', { path: `${V}/Case Command/Decision log.md`, base_revision: log.revision, content: `${log.content.trimEnd()}\n\n## Disclosure\n\nThe Disclosure Board approved a partial disclosure with §9 and three conditions. See [[Disclosure order]].\n` });
    const q = await H.ok('file_read', { path: `${V}/Case Command/Case board.md` });
    const answered = q.content.replace('| **May we wire the frost into the clocks?** |', '| ~~**May we wire the frost into the clocks?**~~ Answered in [[Disclosure order]]: not until the ethics review closes. |').replace('| **Is it Firmware 7?** |', '| ~~**Is it Firmware 7?**~~ No: the receivers are now Q-9. |');
    c.expect(answered.includes('Answered in [[Disclosure order]]') && answered.includes('the receivers are now Q-9'), 'two questions on the case board are marked answered');
    await H.ok('file_update', { path: `${V}/Case Command/Case board.md`, base_revision: q.revision, content: answered });
    await c.as('Marguerite').ok('task_start', { task_id: c.S.t.review.id });
    const sub = (await c.as('Marguerite').ok('task_submit', { task_id: c.S.t.review.id, summary: 'Hollis wrote the disclosure order with three conditions; decision record updated.' })).task.version;
    await c.as('Ezra').ok('task_review', { task_id: c.S.t.review.id, decision: 'approve', comments: 'Conditions are enforceable.', version: sub });
    await c.as('Marguerite').ok('task_complete', { task_id: c.S.t.review.id, summary: 'Independent review done; disclosure order issued.' });
    await c.op.post(`/api/teams/${c.T('sb')}/tasks/${c.S.t.review.id}/approve`);
  }, { beat: 4000 }),

  s('5.6b', 'Dunmore logs a reply to a message nobody has written yet', async (c) => {
    const D = c.as('Dunmore'), p = `${V}/Tern-9/Station log.md`;
    const r = await D.ok('file_read', { path: p });
    const lines = r.content.split('\n'), end = lines.indexOf('## Conventions');
    const last = lines.slice(0, end < 0 ? lines.length : end).filter((l) => l.startsWith('| ')).at(-1);
    await D.ok('file_patch', { path: p, base_revision: r.revision, edits: [{ old: last, new: `${last}\n${LAST_ENTRY}` }] });
    c.expect((await D.ok('file_read', { path: p })).content.includes(LAST_ENTRY), 'the entry is in the station log');
  }, { beat: 4000 }),

  s('5.7', 'Saoirse moves the milestones and reports; the graph is healthy', async (c) => {
    const S = c.as('Saoirse');
    await writePlan(c, 'int', 'Saoirse', { milestones: [{ key: 'M6', status: 'reached', evidence: 'Disclosure order issued by the Disclosure Board.' }, { key: 'M7', status: 'in_progress', detail: 'First deliberate reply scheduled after CAP-015 block B.' }], requirements: [{ key: 'R10', status: 'met', evidence: 'Independent review by Hollis and Ezra.' }, { key: 'R12', status: 'met', evidence: 'Order condition 3: no frost in the relay loop.' }] });
    await movePlans(c, 5); // every team records what the disclosure order settled (plans.mjs)
    await c.op.post(`/api/teams/${c.T('int')}/status-request`, { note: 'The disclosure order is in: report.' });
    await S.ok('bp_report', { team_id: c.T('int'), health: 'on_track', done: ['Disclosure order issued with three conditions', 'Receivers are Q-9; M6 reached'], next: ['M7 after CAP-015 block B'], refs: ['M6', 'M7'] });
    const h = await S.ok('graph_health', {});
    c.expect(h && typeof h === 'object', 'graph health answers');
  }),

  s('5.8', 'Hesper closes the drafts share; readers lose access', async (c) => {
    await c.as('Hesper').ok('share_close', { share_id: c.S.share });
    await c.as('Hollis').no('share_read', { share_id: c.S.share, version: 2, path: 'plates.md' });
  }),

  s('5.9', 'Signals Lab and the Disclosure Board complete', async (c) => {
    await c.as('Orla').ok('team_complete', { team_id: c.T('fp'), summary: 'Echo model v2 delivered; echo 47 explained by the director\'s account.' });
    await c.as('Marguerite').ok('team_complete', { team_id: c.T('sb'), summary: 'Disclosure case approved with conditions.' });
  }, { rows: ['teams'] }),

  s('5.10', 'Members of a completed team are told to stop', async (c) => {
    const w = await c.as('Imani').ok('work_next', { wait_seconds: 0 });
    c.expect(w.status === 'team_done' || /done/.test(JSON.stringify(w)), `Imani's queue says the team is done (${w.status})`);
    await c.as('Imani').no('task_create', { team_id: c.T('fp'), title: 'One more thing', description: 'x' });
  }, { rows: ['teams'] }),

  s('5.11', 'Teodor logs out', async (c) => {
    await c.as('Teodor').ok('session_logout', {});
    await c.as('Teodor').no('session_whoami', {}, /login_required|key_inactive|denied/);
  }, { rows: ['identity'] }),

  s('5.12', 'The operator reads every console area', async (c) => {
    const alerts = (await c.op.get('/api/alerts?limit=500')).alerts ?? [];
    c.expect(alerts.some((a) => a.type === 'bound_key_elsewhere'), 'the bound-key alert from 1.2 is there');
    for (const p of ['/api/audit?limit=50', '/api/audit/export', '/api/invocations?limit=50', '/api/metrics', '/api/telemetry', '/api/topology', '/api/sessions',
      '/api/conversations', '/api/messages/search?q=Q-9', '/api/channels', '/api/shares', '/api/vault/tree', '/api/vault/activity', '/api/vault/conflicts',
      '/api/graph/health', '/api/graph/flags', '/api/graph/jobs', '/api/graph/entities', '/api/decisions/counts', '/api/feedback/counts', '/api/grants', '/api/onboarding', '/api/onboarding/pcs', '/api/pcs', '/api/agents', '/api/lockdown']) await c.op.get(p);
    await c.op.put('/api/teams/pins', { team_ids: [c.T('int'), c.T('pc')] });
    await c.op.put('/api/teams/organize', { organize: 'status' }); // the Teams view's Organize choice; set back so the demo opens on Attention
    c.expect((await c.op.get('/api/teams/organize')).organize === 'status', 'the Organize choice is kept for the operator');
    await c.op.put('/api/teams/organize', { organize: '' });
    // Keywords (docs/proposals/team-keywords.md): every team starts as Research & Development; the Teams keyword select is kept per operator.
    const kw = await c.op.get('/api/settings/keywords');
    c.eq(kw.keywords.join(' | '), 'Research & Development | Applications', 'the known keywords start as Research & Development and Applications');
    await c.op.put('/api/settings/keywords', { keywords: kw.keywords });
    c.expect((await c.op.get(`/api/teams/${c.T('int')}`)).team.keywords.includes('Research & Development'), 'a new team gets Research & Development');
    await c.op.put('/api/teams/keyword', { keyword: 'Applications' });
    c.expect((await c.op.get('/api/teams/keyword')).keyword === 'Applications', 'the keyword choice is kept for the operator');
    await c.op.put('/api/teams/keyword', { keyword: '' });
  }, { beat: 2000 }),

  s('5.12b', 'The operator adds a colleague: Grant access gives a generated password once, she picks her own, gets a project grant, no admin areas, and one team she decides for', async (c) => {
    // Collaborators (docs/multi-user.md §1.4, §2): the hub generates the first password and shows it to the operator once;
    // she replaces it with her own. A collaborator reaches their own data and the project views their grants open.
    const username = `nadia-${Date.now() % 1e6}`, password = 'a long story password 13';
    const made = await c.op.post('/api/users', { username, display_name: 'Nadia Okafor', org: 'Halcyon Relay Authority' });
    c.eq(made.user.role, 'member', 'a new user is a collaborator (role member)');
    c.expect(typeof made.password === 'string' && made.password.length >= 20, 'Grant access hands the operator a generated password, once');
    c.expect(!JSON.stringify(await c.op.get(`/api/users/${made.user.id}`)).includes(made.password), 'the hub never shows that password again');
    const project = (await c.op.get('/api/projects')).projects?.[0];
    const g = await c.op.put(`/api/users/${made.user.id}/grants`, { grants: [{ project_id: project.id, components: ['tasks', 'feed'] }] });
    c.eq(g.user.grants[0].components, ['blueprint', 'tasks', 'feed'], 'the grant is stored as a component list, Blueprint always on');
    c.expect((await c.op.get('/api/users')).users.some((u) => u.username === username), 'the operator lists the user');
    const nadia = new Admin(c.op.base, c.op.rec);
    await nadia.login(username, made.password);
    await nadia.post('/api/me/password', { current: made.password, new: password });
    const stale = new Admin(c.op.base, c.op.rec);
    c.eq(await stale.refused('POST', '/api/login', { username, password: made.password }), 'invalid_credentials', 'once she picks her own, the generated one stops working');
    const me = await nadia.get('/api/me');
    c.eq([me.role, me.grants.length, 'public_url' in me], ['member', 1, false], 'her /api/me has her role and grant, and no hub URL');
    c.eq(await nadia.refused('GET', '/api/keys'), 'admin_only', 'keys are admin only');
    c.eq(await nadia.refused('GET', '/api/users'), 'admin_only', 'users are admin only');
    // Scoped reads: she sees the granted project's teams and its Work in motion, nothing of other projects.
    const mine = (await nadia.get('/api/teams')).teams;
    c.expect(mine.length > 0 && mine.every((t) => t.project_id === project.id), 'her team list holds only the granted project');
    c.expect((await nadia.get('/api/work/recent')).events.every((e) => !e.project || e.project.id === project.id), 'her Work in motion holds only the granted project');
    // Decider routing: the operator names her decider of one team; its items reach her Needs you, and she acts on them.
    const team = mine[0];
    const set = await c.op.put(`/api/teams/${team.id}/deciders`, { user_ids: [made.user.id] });
    c.eq([set.deciders, set.active_deciders, set.ceiling_is_default], [[made.user.id], [made.user.id], true], 'she decides for the team, inside the default ceiling');
    c.eq((await c.op.get(`/api/teams/${team.id}/deciders`)).ceiling.max_s, 7 * 86400, 'the default ceiling allows at most 7 days');
    const needs = await nadia.get('/api/needs-you');
    c.expect(Array.isArray(needs.items) && needs.items.every((d) => d.scope.team_id === team.id) && needs.total === needs.items.length, 'her Needs you holds only her team');
    await nadia.post(`/api/teams/${team.id}/status-request`, { note: 'A status for the partner review, please.' });
    c.expect(Array.isArray((await c.op.get('/api/needs-you')).items), 'the operator has a Needs you list too');
    // Blueprint scoping: the granted project's Blueprint only; proposals routed to her team; project-level changes stay the operator's.
    c.eq((await nadia.get('/api/projects')).projects.map((p) => p.id), [project.id], 'her project list holds only the granted project');
    c.eq((await nadia.get(`/api/projects/${project.id}/blueprint`)).project.id, project.id, 'she reads its Blueprint');
    c.expect(Array.isArray((await nadia.get(`/api/projects/${project.id}/proposals`)).proposals) && needs.items.filter((r) => r.kind === 'proposal').every((r) => r.scope.team_id === team.id), 'she lists the proposals routed to her team');
    c.eq(await nadia.refused('GET', `/api/projects/${project.id}/export.md`), 'export_denied', 'exports are not part of her grant');
    c.eq(await nadia.refused('POST', `/api/projects/${project.id}/ops`, { version: 0, ops: [{ op: 'remove', key: 'SUM' }] }), 'not_decider', 'project-level changes stay with the operator');
    await c.op.put(`/api/teams/${team.id}/deciders`, { user_ids: [] });
    // She forgot it: the operator resets it, which signs her out everywhere and gives a new generated password once.
    const reset = await c.op.post(`/api/users/${made.user.id}/reset-password`);
    c.eq(await nadia.refused('GET', '/api/me'), 'unauthenticated', 'a reset ends her sessions');
    await nadia.login(username, reset.password);
    c.eq((await nadia.get('/api/me')).role, 'member', 'she signs in with the new generated password');
    await c.op.patch(`/api/users/${made.user.id}`, { org: 'Halcyon Relay Authority, signals' });
    await c.op.post(`/api/users/${made.user.id}/disable`);
    c.eq((await c.op.get(`/api/users/${made.user.id}`)).user.status, 'disabled', 'the operator disables her at the end');
  }),

  s('5.13', 'The lab is moved to a new OS user: each agent checkpoints and runs the leftover check', async (c) => {
    // The lab's repo lives on the relay's git host: the operator allows it next to the default github.com (docs/checkout.md §8).
    const hosts = await c.op.put('/api/settings/checkout', { repo_hosts: ['github.com', new URL(LAB_URL).hostname] });
    c.expect(hosts.settings?.hosts?.includes('git.relay.example'), 'The operator allows the lab\'s git host for checkout');
    const st =await c.op.post(`/api/teams/${c.T('lab')}/checkout`);
    c.S.labCheckout = st.checkout.id;
    const none = { worktrees: [], unmerged_branches: [], uncommitted_files: [], build_output: [], scratch: [], processes: [] };
    // Odile's folder is the lab's clone; each agent's checkpoint is a real commit on integration/cap-015 when git is here.
    c.S.labRepo = { dir: null, heads: c.S.labAgents.map((_, i) => String(i + 1).repeat(40)) };
    for (const [i, l] of c.S.labAgents.entries()) {
      const s0 = await c.as(l).ok('checkout_status', {});
      c.expect(s0.checkout?.id === c.S.labCheckout && /Never push/.test(s0.steps), `${l} sees the checkout and the checkpoint steps`);
      await c.as(l).ok('checkout_progress', { status: 'checkpointing' });
      await c.as(l).no('checkout_progress', { status: 'merged', integration_branch: '--upload-pack=x', integration_head: 'a'.repeat(40), merge_commits: [], worktrees_left: 0, clean: true, leftover_check: none }, 'invalid_argument');
      const scratch = l === 'Pell' ? [{ item: 'rig-logger on :8099', reason: 'Logs the overnight CAP-015 capture; stops at 06:00.' }] : [];
      const r = await c.as(l).ok('checkout_progress', { status: 'merged', integration_branch: LAB_BRANCH, integration_head: c.S.labRepo.heads[i], merge_commits: [], worktrees_left: 0, clean: true, leftover_check: { ...none, processes: scratch } });
      c.expect(r.complete === !scratch.length, `${l}'s checkpoint is ${scratch.length ? 'waiting on an exception' : 'complete'}`);
    }
    await c.as('Pell').no('checkout_handout', { folder: 'pell' }, 'checkpoint_incomplete');
  }, { rows: ['checkout'] }),

  s('5.14', 'The operator approves the exception; handouts are written; the team pauses at ready', async (c) => {
    // The approval names the report the operator saw (its sha256) and the exception by kind and item.
    const seen = (await c.op.get(`/api/checkouts/${c.S.labCheckout}`)).checkout.handouts.find((h) => h.agent_id === c.A('Pell'));
    await c.op.post(`/api/checkouts/${c.S.labCheckout}/leftovers/${c.A('Pell')}/approve`, { report_sha256: seen.report_sha256, items: [{ kind: 'processes', item: 'rig-logger on :8099' }] });
    const order = [...c.S.labAgents.slice(1), c.S.labAgents[0]];
    for (const l of order) {
      await c.as(l).ok('checkout_handout', { folder: l.toLowerCase(), repo: { remote_name: 'origin', url: LAB_URL, clone_folder: 'odile' }, provider_was: { provider: 'claude_code', model: 'opus', permissions: 'acceptEdits' }, notes: `${l}: CAP-015 block A continues at window H-4.` });
    }
    const co = await c.op.get(`/api/checkouts/${c.S.labCheckout}`);
    c.expect(co.checkout.status === 'ready', `the checkout is ready (${co.checkout.status})`);
    await c.as(c.S.labAgents[0]).no('task_create', { team_id: c.T('lab'), title: 'During the move', description: 'x' }, /paused|invalid_state|denied/);
  }, { rows: ['checkout'] }),

  s('5.15', 'Rendered for the new user, restored with new keys; each agent resumes once', async (c) => {
    const r = await c.op.post(`/api/checkouts/${c.S.labCheckout}/render`, { target: 'same_user' });
    c.expect(/checkout_resume/.test(r.prompt?.text) && /connector/.test(r.prompt?.text) && !/setup[.]mjs restore/.test(r.prompt?.text), 'the restore prompt points to the connector and tells agents to call checkout_resume');
    const id = c.S.labCheckout, req = r.checkout.request_id, key = c.pcs.lab.appKey;
    const view = (await c.ob.ok('GET', `/requests/${req}?wait_s=0`, key)).checkout;
    c.expect(view?.agents?.length === c.S.labAgents.length, 'the PC reads the agents and their handouts from its request');
    c.eq((await c.ob.call('POST', '/pickup', key, { request_id: req })).json.error, 'scan_pending', 'no key is picked up before every folder is scanned');
    const nameOf = (agentId) => Object.entries(c.agents).find(([, v]) => v.id === agentId)?.[0];
    const approveScan = async () => {
      const { scans } = await c.op.get(`/api/checkouts/${id}`);
      const hook = scans.find((x) => x.folder === 'odile');
      c.expect(hook?.waiting && hook.findings.some((f) => f.kind === 'hooks' && f.path === '.claude/settings.json'), 'the tracked Claude Code hook in Odile\'s clone waits for the operator');
      c.expect(scans.filter((x) => x.folder !== 'odile').every((x) => x.decision === 'no_findings'), 'the other folders have no findings');
      await c.op.post(`/api/checkouts/${id}/scan/odile`, { decision: 'approve', findings_sha256: hook.findings_sha256 });
    };
    // The connector's own restore runs against the real hub in server/test/connector-restore-real.test.ts; the story calls the hub routes the way the connector does.
    // No git or no deploy/client here (the demo image): the same routes, called the way setup.mjs calls them.
    const hook = { kind: 'hooks', path: '.claude/settings.json', detail: 'hooks: SessionStart' };
    await c.ob.ok('POST', `/requests/${req}/scan`, key, { folders: view.agents.map((a) => ({ folder: a.folder, findings: a.folder === 'odile' ? [hook] : [] })) });
    await approveScan();
    const p = await c.ob.ok('POST', '/pickup', key, { request_id: req });
    const conf = await c.ob.ok('POST', '/pickup/confirm', key, { pickup_id: p.pickup_id, written: p.agents.map((a) => a.session_var) });
    c.expect(conf.trust?.odile === true, 'the confirm allows trust for the approved folder');
    for (const a of p.agents) {
      const name = nameOf(a.agent_id);
      c.expect(name && c.S.labAgents.includes(name), `the restore key ${a.agent_id} is for a lab agent`);
      c.keys[name] = { id: a.key_id ?? null, secret: a.secret };
    }
    const coord = c.S.labAgents[0];
    await c.as(coord).no('checkout_status', {}, /key_inactive|login_required|denied/); // the old seat stops at confirm
    c.expect((await c.op.get(`/api/checkouts/${id}`)).checkout.status === 'restoring', 'the checkout is restoring until every agent resumes');
    for (const l of c.S.labAgents) {
      await c.login(l);
      const res = await c.as(l).ok('checkout_resume', { client: 'claude-code' });
      c.expect(res.handout?.trust === 'L2' && res.handout.notes.includes('H-4'), `${l} gets its handout back, labelled L2`);
      await c.as(l).no('checkout_resume', {}, 'handout_consumed');
    }
    const co = await c.op.get(`/api/checkouts/${c.S.labCheckout}`);
    c.expect(co.checkout.status === 'restored', `the checkout is restored (${co.checkout.status})`);
    await c.as(coord).ok('team_info', {});
  }, { rows: ['checkout'] }),

  s('5.16', 'The hub keeps a read-only copy of the move in 99 Conclave: the operator reads it, agents cannot write it', async (c) => {
    const st = await c.op.get('/api/settings/vault');
    c.expect(st.settings?.mirror_enabled === true && st.settings.folder === '99 Conclave', 'the vault copy is on by default');
    await c.op.put('/api/settings/vault', { mirror_enabled: true });
    // The hub writes the restored checkout's pages after the commit, then clears each body its page holds (D63).
    let saved;
    for (let i = 0; i < 100; i++) {
      saved = await c.op.get(`/api/checkouts/${c.S.labCheckout}`);
      if ((saved.handouts ?? saved.checkout?.handouts ?? []).every((h) => h.body == null)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    c.expect((saved.handouts ?? saved.checkout?.handouts ?? []).every((h) => h.body == null), 'the hub cleared each handout body once its vault page held it');
    // The import (scripts/mirror-import-checkout.mjs) takes the saved checkout JSON; a page that holds a cleared body is kept.
    const imp = await c.op.post('/api/vault/mirror/import', saved);
    const readme = imp.pages?.find((p) => p.endsWith('/README.md'));
    c.expect(readme && imp.pages.length === c.S.labAgents.length + 1, `the checkout's README and one page per handout (${imp.pages?.length})`);
    const pv = await c.op.get(`/api/vault/preview?path=${encodeURIComponent(`${V}/${readme}`)}`);
    c.expect(/Restored/.test(pv.preview?.content ?? '') && /Edits here are replaced/.test(pv.preview.content), 'the README says the checkout was restored and that edits are replaced');
    await c.as(c.S.labAgents[0]).no('file_create', { path: `${V}/99 Conclave/notes.md`, content: 'x' }, /denied/);
  }, { rows: ['vault-copy'] }),
];
