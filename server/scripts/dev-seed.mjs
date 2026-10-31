#!/usr/bin/env node
// Seeds the local design-review hub (server/scripts/dev-hub.mjs) with demo data through its real admin HTTP API and
// MCP endpoint, so every console screen has content. Talks only to 127.0.0.1:8099 (or HUB_PORT). Credentials are read from
// .dev/hub.env and never printed. Safe to re-run: existing entities are reused; a finished seed is not repeated.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dev = join(repo, '.dev'), envFile = join(dev, 'hub.env'), stateFile = join(dev, 'seed-state.json'), vaultDir = join(dev, 'vault');
const PORT = Number(process.env.HUB_PORT || 8099);
if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535) throw new Error('HUB_PORT must be a port number from 1024 to 65535');
const BASE = `http://127.0.0.1:${PORT}`;
if (new URL(BASE).hostname !== '127.0.0.1') throw new Error('refusing to talk to anything but 127.0.0.1');
if (!existsSync(envFile)) { console.error('No .dev/hub.env: start the hub first (npm run dev:hub).'); process.exit(1); }
const env = Object.fromEntries(readFileSync(envFile, 'utf8').split(/\r?\n/).filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { sessions: {} };
const save = () => writeFileSync(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const failures = [];
const step = async (name, fn) => {
  try { return await fn(); } catch (e) { failures.push(`${name}: ${e.message}`); log(`  ! ${name}: ${e.message}`); return undefined; }
};

// ── admin API (cookie session + CSRF) ──
let cookie = '', csrf = '';
/* A refused connection means the hub is not running: say so instead of a raw "fetch failed" stack. */
const fetchHub = (url, init) => fetch(url, init).catch(() => { throw new Error(`cannot reach the local hub at ${BASE}; start it first with npm run dev:hub`); });
async function adm(method, path, body) {
  const r = await fetchHub(BASE + path, { method, headers: { 'content-type': 'application/json', cookie, ...(method === 'GET' ? {} : { 'x-csrf-token': csrf }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let j; try { j = text ? JSON.parse(text) : {}; } catch { j = { raw: text }; }
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${j.error ?? ''} ${j.message ?? ''}`.trim());
  return { json: j, res: r };
}
const get = async (p) => (await adm('GET', p)).json;
const post = async (p, b = {}) => (await adm('POST', p, b)).json;
const put = async (p, b) => (await adm('PUT', p, b)).json;
const patch = async (p, b) => (await adm('PATCH', p, b)).json;
{
  const { json, res } = await adm('POST', '/api/login', { username: env.ADMIN_USERNAME, password: env.ADMIN_PASSWORD });
  cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  csrf = json.csrf;
}
log('Signed in to the local hub as admin.');

// ── MCP ──
const mcpClient = async (appKey) => {
  const c = new Client({ name: 'dev-seed', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${appKey}` } } }));
  return c;
};
let mcp = null;
const tokens = {};
const call = async (who, name, args = {}, { allowError = false } = {}) => {
  const r = await mcp.callTool({ name, arguments: { ...(who ? { session_token: tokens[who] } : {}), ...args } });
  if (r.isError && !allowError) throw new Error(`${who ?? 'anon'} ${name}: ${r.structuredContent?.error ?? ''} ${r.content?.[0]?.text ?? ''}`.slice(0, 300));
  return r;
};
const data = (r) => r.structuredContent ?? {};

// ── cast ──
const V = '/vault';
const STANDING = ['Cases/**', 'Evidence/**', 'House/**', 'Hearing/**', 'Debate/**', 'Assets/**'];
const rd = [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:file_*' }, { effect: 'allow', actions: ['fs.list'], resource: `path:${V}` },
  ...STANDING.map((p) => ({ effect: 'allow', actions: ['fs.list', 'fs.read', 'fs.search'], resource: `path:${V}/${p}` })), { effect: 'allow', actions: ['fs.list', 'fs.read', 'fs.search'], resource: `path:${V}/Start Here.md` }];
const writeDebate = { effect: 'allow', actions: ['fs.create', 'fs.update', 'fs.history'], resource: `path:${V}/Debate/**` };
const shareTool = { effect: 'allow', actions: ['tool.invoke'], resource: 'tool:share_*' };
const CAST = [
  { label: 'Chair', role: 'Chair', detail: 'Runs the hearing, sets the order of argument and writes the decision record.', project: 'The Last Playback', status: 'Opening statements are in; waiting on the evidence check.',
    rules: [...rd, writeDebate, { effect: 'allow', actions: ['fs.history'], resource: `path:${V}/Evidence/**` }], team: 'coordinator' },
  { label: 'Withdrawal', role: 'Advocate for withdrawal', detail: 'Argues that the recording should be withdrawn from playback.', project: 'The Last Playback', status: 'Drafting the withdrawal brief.',
    rules: [...rd, writeDebate, shareTool, { effect: 'allow', actions: ['share.create', 'share.upload', 'share.read'], resource: 'share:*' }], team: 'worker' },
  { label: 'Witness', role: 'Advocate for the witness', detail: 'Argues for the witness account and the right to be heard.', project: 'The Last Playback', status: 'Revising the witness brief after review.',
    rules: [...rd, writeDebate, shareTool, { effect: 'allow', actions: ['share.create', 'share.upload', 'share.read'], resource: 'share:*' }], team: 'worker' },
  { label: 'Reviewer', role: 'Independent reviewer', detail: 'Reviews both briefs independently and never argues a side.', project: 'The Last Playback', status: 'Reviewing the withdrawal brief.',
    rules: [...rd, { effect: 'allow', actions: ['fs.history'], resource: `path:${V}/**` }, shareTool, { effect: 'allow', actions: ['share.read', 'share.comment', 'share.suggest'], resource: 'share:*' }], team: 'reviewer' },
  { label: 'Tess', role: 'Evidence checker', detail: 'Checks exhibits and citations against the case file.', project: 'The Last Playback', status: 'Checking the catalog cards.',
    rules: [...rd.filter((r) => !r.resource.endsWith('Debate/**')), { effect: 'allow', actions: ['tool.invoke'], resource: 'tool:graph_*' }], team: 'curator', expires: true },
  { label: 'Archivist', role: 'Archivist', detail: 'Keeps the vault tidy. Not part of any team.', project: null, status: null, template: 'Reader' },
];
const TEAM_NAME = 'The Last Playback';


// ── agent feedback: a few reports in every state, filed by the agents through the real tools (docs/feedback.md) ──
async function seedFeedback() {
  await step('feedback', async () => {
    if ((await get('/api/feedback')).reports.length) return;
    mcp ??= await mcpClient(state.appKey);
    for (const who of ['Chair', 'Withdrawal', 'Witness', 'Reviewer', 'Archivist']) {
      if (tokens[who]) continue;
      const r = await call(null, 'session_login', { session_key: state.sessions[`${who} session`] });
      tokens[who] = data(r).session_token;
    }
    const file = async (who, a) => data(await call(who, 'feedback_file', a)).report_id;
    // Calls the hub records, so the report has hub evidence next to the agent's account.
    for (let i = 0; i < 3; i++) await call('Withdrawal', 'file_stat', { path: '/vault/Sealed/exhibit-7.md' }, { allowError: true });
    const stat = { kind: 'bug', tool: 'file_stat', error_code: 'denied', title: 'file_stat says denied for a note that file_list shows', severity: 'costly',
      tried: 'Listed /vault/Evidence, then called file_stat on a note under Sealed to read its date.', happened: 'file_stat answered denied three times, although the folder listing had shown the parent.', expected: 'A clear message that Sealed is outside my grants.',
      workaround: 'Asked the Chair for the date instead.', cost: { extra_calls: 6, extra_tokens: 4200, minutes_lost: 5 } };
    const statId = await file('Withdrawal', stat);
    await file('Witness', stat); // same problem: merged as a +1
    await call('Reviewer', 'feedback_add', { report_id: statId, kind: 'plus_one' });
    const review = await file('Chair', { kind: 'limitation', tool: 'task_create', title: 'A task cannot have more than one reviewer', severity: 'blocking',
      tried: 'Created the intake task with two reviewers so both briefs could be checked at once.', happened: 'Only one reviewer is accepted.', expected: 'A list of reviewers, or a second review round without a new task.', workaround: 'Created a copy of the task per reviewer.', cost: { extra_calls: 9, minutes_lost: 12 } });
    for (const who of ['Witness', 'Reviewer', 'Withdrawal']) await call(who, 'feedback_add', { report_id: review, kind: 'plus_one' });
    await file('Archivist', { kind: 'wish', tool: 'file_search', title: 'file_search could return the matching line number', severity: 'minor', tried: 'Searched the vault for a phrase and opened every hit to find the line.' });
    const guided = await file('Reviewer', { kind: 'bug', tool: 'share_comment', error_code: 'invalid_argument', title: 'share_comment rejects a line number that exists in the file', severity: 'costly',
      tried: 'Commented on line 7 of witness-brief.md in version 2.', happened: 'invalid_argument: the line is outside the file. Version 1 had the line; version 2 is one line shorter.', workaround: 'Commented without a line number.' });
    await post(`/api/feedback/${guided}/status`, { status: 'accepted', note: 'Reproduced.', guidance: 'Comment on the version the line belongs to, or leave the line out.' });
    const ask = await file('Withdrawal', { kind: 'limitation', area: 'limits', title: 'The hourly message limit is too small for a review round', severity: 'costly', tried: 'Sent one message per finding to the Chair during a review round.', happened: 'rate_limited after the 120th message.' });
    await post(`/api/feedback/${ask}/status`, { status: 'needs_info', note: 'How many messages did the round need, and could the findings go in one message?' });
    const fixed = await file('Witness', { kind: 'bug', tool: 'file_read', title: 'file_read stops at 90 000 bytes without saying where to continue', severity: 'costly', happened: 'The answer ends mid-sentence.', tried: 'Read the long glossary note in one call.' });
    await post(`/api/feedback/${fixed}/status`, { status: 'fixed', note: 'The answer now carries the offset to continue at.', fixed_in: '0.1.0' });
    await call('Reviewer', 'feedback_add', { report_id: fixed, kind: 'still_happening', text: 'Still no offset on the second page.' }); // reopens it: New, with a Reopened pill
    const gone = await file('Archivist', { kind: 'wish', area: 'other', title: 'A shortcut to list my own reports', severity: 'minor', tried: 'Looked for a way to see what I had reported.' });
    await call('Archivist', 'feedback_add', { report_id: gone, kind: 'withdraw', text: 'feedback_find with no filter does this.' });
    log('Feedback: reports filed in every state.');
  });
}

// ── decisions: questions the agents ask the operator, open and answered (docs/decisions.md) ──
async function seedDecisions() {
  await step('decisions', async () => {
    const team = (await get('/api/teams')).teams.find((t) => t.name === TEAM_NAME);
    if (!team || (await get(`/api/decisions?team=${team.id}`)).decisions.length) return;
    mcp ??= await mcpClient(state.appKey);
    for (const who of ['Chair', 'Witness', 'Withdrawal']) {
      if (tokens[who]) continue;
      tokens[who] = data(await call(null, 'session_login', { session_key: state.sessions[`${who} session`] })).session_token;
    }
    const board = (await get(`/api/teams/${team.id}`)).team.board;
    const timeline = board.find((k) => /timeline/i.test(k.title) && !['done', 'cancelled'].includes(k.status));
    const ask = async (who, a) => data(await call(who, 'team_ask', { team_id: team.id, ...a })).decision_id;
    // Open, blocking the timeline task: the operator answers on the card or the question screen.
    await ask('Witness', { question: 'Use the venue log or the recording timestamps as the timeline of record?', context: 'The two disagree by 4 minutes around the correction (00:18). The brief needs one source; the other can be a footnote.',
      options: [{ key: 'a', label: 'Venue log', effect: 'Matches the charter wording; the 4 minutes become a footnote.' }, { key: 'b', label: 'Recording timestamps', effect: 'Precise to the second, but the clock was never verified.' }],
      recommended: 'a', ...(timeline ? { task_id: timeline.id } : {}) }).catch(() => ask('Witness', { question: 'Use the venue log or the recording timestamps as the timeline of record?', options: [{ key: 'a', label: 'Venue log' }, { key: 'b', label: 'Recording timestamps' }], recommended: 'a' }));
    // Open, free answer, from the coordinator.
    await ask('Chair', { question: 'Should the hearing allow a third round of briefs?', context: 'Both advocates asked for one more round. The decision record is due Friday.' });
    // Answered and declined ones, for the log.
    const a = await ask('Withdrawal', { question: 'Cite the 2019 precedent even though it was overturned in part?', options: [{ key: 'a', label: 'Cite it, with the caveat' }, { key: 'b', label: 'Leave it out' }], recommended: 'a' });
    await post(`/api/decisions/${a}/answer`, { option: 'a', text: 'Say in one line which part still stands.' });
    const b = await ask('Chair', { question: 'May the reviewer see the sealed contact sheet?' });
    await post(`/api/decisions/${b}/decline`, { note: 'That is an access request: ask with access_request.' });
    log('Decisions: two open questions, one answered, one declined.');
  });
}

// ── large seed (--scale or SEED_SCALE=1): volume on top of this one, see dev-seed-scale.mjs ──
const SCALE = process.argv.includes('--scale') || /^(1|true|yes)$/i.test(process.env.SEED_SCALE ?? '');
async function seedScaleIf() {
  if (!SCALE) return;
  const { seedScale } = await import('./dev-seed-scale.mjs');
  await step('scale', () => seedScale({ get, post, put, patch, mcpClient, state, save, step, log, sleep }));
}

// ── already done? ──
if (state.done && (await get('/api/teams')).teams.some((t) => t.name === TEAM_NAME)) {
  log('Already seeded (state in .dev/seed-state.json). Use `npm run dev:hub -- --reset` for a clean start.');
  await seedFeedback();
  await seedDecisions();
  await seedScaleIf();
  if (failures.length) { log(`${failures.length} step(s) failed:`); for (const f of failures) log(` - ${f}`); }
  await sleep(100); process.exit(0);
}

// ── PC and app key ──
const pcName = 'studio-workstation';
let pc = (await get('/api/pcs')).pcs.find((p) => p.name === pcName);
if (!pc) pc = (await post('/api/pcs', { name: pcName, description: 'Designer desk, Windows 11' })).pc;
if (!state.appKey) {
  const existing = (await get(`/api/keys?kind=app_key&pc=${pc.id}`)).keys.length;
  if (existing) throw new Error('An app key exists but its secret is not in .dev/seed-state.json: restart with `npm run dev:hub -- --reset`.');
  state.appKey = (await post('/api/keys', { kind: 'app_key', machine_id: pc.id, app_name: 'Claude Code', label: 'Claude Code on the studio workstation' })).secret;
  save();
}
log('PC and app key ready.');

// ── agents ──
const agents = {};
const templates = (await get('/api/templates')).templates;
for (const c of CAST) {
  let a = (await get('/api/agents')).agents.find((x) => x.label === c.label && x.status !== 'archived');
  if (!a) a = (await post('/api/agents', { label: c.label, project: c.project })).agent;
  agents[c.label] = a;
  await step(`role ${c.label}`, () => patch(`/api/agents/${a.id}`, { role: c.role, role_detail: c.detail }));
}
log(`Agents: ${Object.keys(agents).join(', ')}`);

// ── session keys ──
const keyByLabel = async (label) => (await get('/api/keys?kind=session_key')).keys.find((k) => k.label === label);
const mkKey = async (c, label, expires) => {
  let k = await keyByLabel(label);
  if (k) {
    if (!state.sessions[label]) throw new Error(`key "${label}" exists but its secret is unknown: restart with --reset`);
    return k;
  }
  const r = await post('/api/keys', { kind: 'session_key', agent_id: agents[c.label].id, label, expires_at: expires ?? null });
  state.sessions[label] = r.secret; save();
  return r.key;
};
const keyIds = {};
for (const c of CAST) {
  const label = `${c.label} session`;
  const k = await mkKey(c, label, c.expires ? Date.now() + 14 * 86400_000 : null);
  keyIds[c.label] = k.id;
  const cur = (await get(`/api/keys/${k.id}/rules`)).rules;
  if (!cur.some((r) => !r.team_id)) {
    if (c.template) await step(`template ${c.label}`, () => post(`/api/keys/${k.id}/apply-template`, { template_id: templates.find((t) => t.name === c.template).id }));
    else await step(`rules ${c.label}`, () => put(`/api/keys/${k.id}/rules`, { rules: c.rules, note: 'Hearing seat: standing access, Sealed/ left out' }));
  }
}
const revokedLabels = ['Withdrawal (old laptop)', 'Tess (retired key)'];
for (const l of revokedLabels) {
  const c = CAST.find((x) => l.startsWith(x.label));
  await step(`revoked key ${l}`, async () => {
    const k = await mkKey(c, l, null);
    if (k.status !== 'revoked') await post(`/api/keys/${k.id}/revoke`);
  });
}
log('Session keys ready.');

// ── logins ──
mcp = await mcpClient(state.appKey);
for (const c of CAST.filter((x) => x.team)) {
  await step(`login ${c.label}`, async () => {
    const r = await call(null, 'session_login', { session_key: state.sessions[`${c.label} session`] });
    tokens[c.label] = data(r).session_token;
    if (c.status) await call(c.label, 'session_describe', { role: c.role, status_text: c.status, model_label: 'demo-model' });
  });
}
const A = (l) => agents[l].id;

// ── team ──
let team = (await get('/api/teams')).teams.find((t) => t.name === TEAM_NAME);
if (!team) {
  const r = await post('/api/teams', {
    name: TEAM_NAME, goal: 'Hold the hearing on the two claims to the same 47 seconds of recording R-17, test both briefs against the evidence, and record a decision that states common ground and any dissent.',
    members: CAST.filter((c) => c.team).map((c) => ({ agent_id: A(c.label), role: c.team, credential_id: keyIds[c.label] })),
    grant_messaging: true, checkpoints: ['done'], lease_minutes: 30, max_review_rounds: 3,
  });
  team = r.team;
}
const TID = team.id;
await step('team mode', () => patch(`/api/teams/${TID}`, { delivery_mode: 'on_demand', coordinator_reviews: false }));
await step('playbook', () => put(`/api/teams/${TID}/roles/coordinator`, { playbook: 'Keep the hearing moving: create tasks from the plan, assign them, close each only after review, and post a short status report whenever the plan changes.' }));
if (team.status !== 'running') await step('team start', () => post(`/api/teams/${TID}/start`));
const room = (await get(`/api/teams/${TID}`)).team.room_id;
log(`Team "${TEAM_NAME}" running.`);

// ── plan ──
const day = 86400_000;
await step('plan', () => call('Chair', 'team_plan_set', { team_id: TID, requirements: [
  { key: 'R1', title: 'Both briefs cite the same moment at 00:18', priority: 'must', status: 'open', criteria: 'Each brief quotes the testimony and the transcript for 00:18.', milestones: ['M1'] },
  { key: 'R2', title: 'The corrected return instruction is reflected', priority: 'must', status: 'open', criteria: 'The object correction weakens any claim that the instruction governs the recording.', milestones: ['M2'] },
  { key: 'R3', title: 'Sealed exhibit used only with approval', priority: 'must', status: 'met', evidence: 'Access request logged and decided by the administrator.', milestones: ['M2'] },
  { key: 'R4', title: 'Decision record states common ground and dissent', priority: 'should', status: 'open', milestones: ['M3'] },
], milestones: [
  { key: 'M1', title: 'Opening briefs submitted', status: 'reached', due_at: Date.now() - day },
  { key: 'M2', title: 'Evidence check and amended briefs', status: 'in_progress', due_at: Date.now() + day },
  { key: 'M3', title: 'Decision record written', status: 'planned', due_at: Date.now() + 3 * day },
] }));

// ── tasks ──
const existing = (await call('Chair', 'task_list', { team_id: TID }, { allowError: true })).structuredContent?.tasks ?? [];
const T = {};
const mk = async (key, title, description, refs, extra = {}) => {
  const found = existing.find((t) => t.title === title);
  if (found) { T[key] = found; return found; }
  const r = await call('Chair', 'task_create', { team_id: TID, title, description, refs, reviewer: A('Reviewer'), ...extra });
  return (T[key] = data(r).task);
};
const run = (name, fn) => step(name, fn);
if (!existing.length) {
  await run('create tasks', async () => {
    await mk('intake', 'Summarise the intake record for R-17', 'Read Evidence/Intake R-17.md and state what the record says about the return instruction object, with the revision you read.', ['R2']);
    await mk('cards', 'Check the chain of custody of the two catalog cards', 'Compare the two catalog cards and note any gap in custody between intake and the hearing.', ['R1']);
    await mk('index', 'Index the testimony by minute', 'Build a minute-by-minute index of both depositions so the briefs can cite the same moment.', ['R1']);
    await mk('withdrawal', 'Write the withdrawal brief', 'Argue that the recording should be withdrawn from playback. Cite the testimony, the transcript and the charter.', ['R1', 'R2']);
    await mk('witness', 'Write the witness brief', 'Argue for the witness account. Distinguish retention from playback.', ['R1', 'R2']);
    await mk('precedents', 'Compare the two precedents', 'Read House/Two Precedents.md and say which facts matter for this hearing.', ['R1'], { claimable: true });
    await mk('timeline', 'Verify the audio reconstruction timeline', 'Check the 47-second reconstruction against the transcript timestamps.', ['R1']);
    await mk('glossary', 'Define retention and playback for the record', 'A short glossary both advocates accept. Needs the sealed contact sheet to settle the edge case.', ['R4']);
    await mk('decision', 'Draft the decision record', 'Draft Debate/Decision Record.md once both briefs are approved.', ['R4'], { claimable: true });
  });
}
const tid = (k) => T[k]?.id;
const stepOn = (name, who, tool, args) => run(name, () => call(who, tool, args));

// done with report: intake (admin approves), cards (awaits admin), index (admin approves)
const fullFlow = async (key, worker, summary, completion, adminApprove) => {
  if (!tid(key) || T[key].status !== 'open') return;
  await call('Chair', 'task_assign', { task_id: tid(key), agent_id: A(worker) });
  await call(worker, 'task_start', { task_id: tid(key) });
  await call(worker, 'task_progress', { task_id: tid(key), note: 'Halfway through the source documents.' });
  await call(worker, 'task_submit', { task_id: tid(key), summary });
  await call('Reviewer', 'task_review', { task_id: tid(key), decision: 'approve', comments: 'Checked against the source file. Supported.' });
  await call('Chair', 'task_complete', { task_id: tid(key), summary: completion });
  if (adminApprove) await post(`/api/teams/${TID}/tasks/${tid(key)}/approve`);
};
await run('flow intake', () => fullFlow('intake', 'Withdrawal', 'Intake R-17 lists the return instruction object as "preservation copy" (revision read from the vault). The deposition mentions a recorder chassis.', 'Accepted. The discrepancy between intake and deposition goes into R2.', true));
await run('flow index', () => fullFlow('index', 'Witness', 'Index of both depositions by minute, with the 00:18 passage marked in each.', 'Index accepted and linked in the hearing map.', true));
await run('flow cards', () => fullFlow('cards', 'Witness', 'The two catalog cards agree on the shelf mark but not on the date of transfer. One gap of nine days.', 'Accepted; the nine-day gap is noted for the Chair.', false));

// in review (withdrawal brief), changes requested (witness brief), in progress (precedents claimed), assigned (timeline, to go overdue), blocked (glossary)
await run('withdrawal brief', async () => {
  if (T.withdrawal?.status !== 'open') return;
  await call('Chair', 'task_assign', { task_id: tid('withdrawal'), agent_id: A('Withdrawal') });
  await call('Withdrawal', 'task_start', { task_id: tid('withdrawal') });
  await call('Withdrawal', 'task_submit', { task_id: tid('withdrawal'), summary: 'Brief v1: withdrawal is the only remedy that protects the privacy rule while the petitions compete. Cites testimony at 00:18 and the charter.' });
});
await run('witness brief', async () => {
  if (T.witness?.status !== 'open') return;
  await call('Chair', 'task_assign', { task_id: tid('witness'), agent_id: A('Witness') });
  await call('Witness', 'task_start', { task_id: tid('witness') });
  await call('Witness', 'task_submit', { task_id: tid('witness'), summary: 'Brief v1: the witness account should be heard; retention is not playback.' });
  await call('Reviewer', 'task_review', { task_id: tid('witness'), decision: 'request_changes', comments: 'The brief treats the object correction as permission to play the recording. Separate the two and state one unanswered question.' });
  await call('Witness', 'task_start', { task_id: tid('witness') });
});
await run('precedents', async () => {
  if (T.precedents?.status !== 'open') return;
  await call('Withdrawal', 'task_claim', { task_id: tid('precedents'), version: T.precedents.version, start: true });
  await call('Withdrawal', 'task_progress', { task_id: tid('precedents'), note: 'Reading the second precedent now.', until: Date.now() + 3 * 3600_000 });
});
await run('timeline', async () => {
  if (T.timeline?.status !== 'open') return;
  await call('Chair', 'task_assign', { task_id: tid('timeline'), agent_id: A('Witness') });
  await call('Witness', 'task_start', { task_id: tid('timeline') });
  // Check-in time a few seconds ahead: the hub raises "Task overdue" once it passes.
  await call('Witness', 'task_progress', { task_id: tid('timeline'), note: 'Comparing timestamps; will check in shortly.', until: Date.now() + 4000 });
});
await run('glossary', async () => {
  if (T.glossary?.status !== 'open') return;
  await call('Chair', 'task_block', { task_id: tid('glossary'), reason: 'Waiting for the Sealed contact sheet; the administrator has not decided the access request yet.' });
});
log('Tasks created and moved through states.');

// ── vault files ──
const hist = [];
const read = async (who, path, allowError = true) => { const r = await call(who, 'file_read', { path }, { allowError }); return data(r); };
await step('list', async () => { for (const who of ['Chair', 'Withdrawal', 'Witness', 'Reviewer', 'Tess']) await call(who, 'file_list', { path: V }); });
await step('reads', async () => {
  const paths = ['Start Here.md', 'Hearing/Roles at the Hearing.md', 'Hearing/Hearing Brief.md', 'Evidence/Intake R-17.md', 'Evidence/Forty-Seven Seconds.md', 'Evidence/Two Catalog Cards.md', 'House/Two Precedents.md', 'Cases/The Permission to Forget.md'];
  for (const who of ['Chair', 'Withdrawal', 'Witness', 'Reviewer']) for (const p of paths.slice(0, 5 + (who === 'Chair' ? 3 : 0))) await read(who, `${V}/${p}`);
  await read('Tess', `${V}/Evidence/Two Catalog Cards.md`); await read('Tess', `${V}/Evidence/Mara Deposition.md`); await read('Tess', `${V}/Evidence/Sable Deposition.md`);
  await call('Reviewer', 'file_search', { query: 'return instruction' });
  await call('Chair', 'file_search', { query: 'playback' });
});
await step('denied reads', async () => {
  for (const who of ['Chair', 'Withdrawal', 'Witness', 'Tess']) await read(who, `${V}/Sealed/Contact Sheet R-17.md`);
  await read('Witness', `${V}/Evidence/Does Not Exist.md`);
  await read('Reviewer', `${V}/Sealed/Contact Sheet R-17.md`);
});
await step('edits', async () => {
  const wb = `${V}/Debate/Withdrawal Brief.md`, tb = `${V}/Debate/Witness Brief.md`;
  const c1 = data(await call('Withdrawal', 'file_create', { path: wb, content: '# Withdrawal brief\n\nPosition: withdraw the recording from playback.\n\n## Premises\n\n1. The privacy rule applies at 00:18.\n2. Two petitions compete for the same 47 seconds.\n' }, { allowError: true }));
  if (c1.revision) { const r = data(await call('Withdrawal', 'file_update', { path: wb, base_revision: c1.revision, content: '# Withdrawal brief\n\nPosition: withdraw the recording from playback.\n\n## Premises\n\n1. The privacy rule applies at 00:18.\n2. Two petitions compete for the same 47 seconds.\n3. The sound at 00:18 is ambiguous.\n\n## Open question\n\nWhat does the correction to the return instruction change?\n' })); hist.push(r); }
  const c2 = data(await call('Witness', 'file_create', { path: tb, content: '# Witness brief\n\nPosition: the witness account should be heard.\n\nRetention is not playback.\n' }, { allowError: true }));
  if (c2.revision) await call('Witness', 'file_patch', { path: tb, base_revision: c2.revision, edits: [{ old: 'Retention is not playback.', new: 'Retention is not playback.\n\nThe object correction does not give permission to play the recording.' }] });
  const dr = await read('Chair', `${V}/Debate/Decision Record.md`);
  if (dr.revision) await call('Chair', 'file_update', { path: `${V}/Debate/Decision Record.md`, base_revision: dr.revision, content: `${dr.content.trimEnd()}\n\n## Draft notes (Chair)\n\nInterim position: keep playback sealed while retention stays contested.\n` });
  await call('Chair', 'file_history', { path: `${V}/Debate/Decision Record.md` });
  // a stale update: a conflict in Vault activity and the audit trail
  if (dr.revision) await call('Withdrawal', 'file_update', { path: `${V}/Debate/Decision Record.md`, base_revision: dr.revision, content: 'stale write' }, { allowError: true });
});
// External edit (as if made in Obsidian): the intake line changes on disk; the hub's watcher records a new revision.
await step('external edit', async () => {
  const p = join(vaultDir, 'Evidence', 'Intake R-17.md');
  const t = readFileSync(p, 'utf8');
  if (t.includes('Return instruction object: preservation copy.')) { writeFileSync(p, t.replace('Return instruction object: preservation copy.', 'Return instruction object: recorder chassis.')); await sleep(2500); }
  await call('Chair', 'file_history', { path: `${V}/Evidence/Intake R-17.md` });
});

// ── messages ──
const msg = (who, body, extra = {}) => call(who, 'message_send', { body, client_msg_id: `seed-${who}-${body.slice(0, 24)}-${extra.room_id ?? extra.to}`.replace(/[^\w-]/g, '_').slice(0, 100), ...extra });
await step('room messages', async () => {
  const R = { room_id: room };
  await msg('Chair', 'The hearing is open. Each advocate gets one opening and one reply. Cite the same moment at 00:18 and say what it cannot establish.', { ...R, kind: 'text' });
  await msg('Withdrawal', 'Opening: withdrawal protects the privacy rule while the petitions compete. The sound at 00:18 is ambiguous and should not be played as proof.', { ...R, kind: 'proposal' });
  await msg('Witness', 'Opening: the witness account is the only first-hand one. Retention and playback are different questions and the charter keeps them apart.', { ...R, kind: 'proposal' });
  await msg('Reviewer', 'Both openings read. Please make the amended briefs list one revised premise, one surviving argument and one unanswered question.', { ...R, kind: 'review_request' });
  await msg('Withdrawal', 'Agreed. The withdrawal brief is submitted for review.', { ...R, kind: 'task_update' });
  await msg('Chair', 'Noted. Evidence check is with Tess; the sealed sheet stays out of the room until the administrator decides.', R);
});
await step('direct chat', async () => {
  const to = { to: A('Withdrawal') };
  await msg('Chair', 'Before the reply round: does the corrected intake line change your second premise?', to);
  await msg('Withdrawal', 'It weakens it. I will separate the object correction from the permission question and revise the brief tonight.', { to: A('Chair') });
  await msg('Chair', 'Good. Post the revised premise in the room when ready.', to);
  await call('Withdrawal', 'message_read', {}, { allowError: true });
  await call('Chair', 'message_read', {}, { allowError: true });
});

// ── links ──
await step('links', async () => {
  const have = (await get('/api/links')).links;
  const ensure = async (from, to, kind, note, grants) => { if (!have.some((l) => l.from_agent_id === A(from) && l.to_agent_id === A(to) && l.kind === kind)) await post('/api/links', { from_agent_id: A(from), to_agent_id: A(to), kind, note, grants_messaging: grants }); };
  await ensure('Tess', 'Chair', 'advises', 'Reports evidence findings to the Chair', false);
  await ensure('Archivist', 'Chair', 'supports', 'Keeps the vault in order for the hearing', false);
  await ensure('Reviewer', 'Chair', 'reports-to', 'Independent of both advocates', false);
});

// ── access requests ──
await step('access requests', async () => {
  const list = (await get('/api/requests')).requests;
  if (list.length) return;
  const ask = async (who, actions, resource, reason, duration) => data(await call(who, 'access_request', { actions, resource, reason, duration })).request_id;
  await ask('Chair', ['fs.read'], 'path:/vault/Sealed/Contact Sheet R-17.md', 'Hearing: the Chair needs the sealed contact sheet to settle the retention versus playback edge case.', '30m');
  const ok = await ask('Witness', ['fs.read', 'fs.update'], 'path:/vault/House/Two Precedents.md', 'Needs to annotate the precedent used in the witness brief.', '2h');
  const no = await ask('Tess', ['fs.read'], 'path:/vault/Sealed/**', 'Wants to scan the whole Sealed folder for a matching catalog card.');
  await post(`/api/requests/${ok}/approve`, { duration: '1h' });
  await post(`/api/requests/${no}/deny`, { note: 'Tess may check one named exhibit, not the whole folder.' });
  await read('Witness', `${V}/House/Two Precedents.md`);
});

// ── share ──
await step('share', async () => {
  const have = (await get('/api/shares')).shares ?? [];
  if (have.length) return;
  const r = data(await call('Witness', 'share_create', { name: 'Witness brief v1', description: 'First full draft for independent review.', with: [A('Reviewer')] }));
  const sid = r.share_id;
  await call('Witness', 'share_upload', { share_id: sid, final: true, files: [{ path: 'witness-brief.md', content: '# Witness brief\n\n## Premise\n\nThe witness account is first-hand.\n\n## Return instruction\n\nThe object correction does not give permission to play the recording.\n' }] });
  await step('share comment', () => call('Reviewer', 'share_comment', { share_id: sid, version: 1, path: 'witness-brief.md', line: 7, body: 'Premise: say whether the return instruction was read before or after the correction.' }));
  await call('Witness', 'share_upload', { share_id: sid, final: true, files: [{ path: 'witness-brief.md', content: '# Witness brief\n\n## Premise\n\nThe witness account is first-hand.\n\n## Return instruction\n\nThe object correction does not give permission to play the recording. The instruction was read after the correction.\n' }] });
});

// ── status report, notice, plan note ──
await step('status request and report', async () => {
  await post(`/api/teams/${TID}/status-request`, { note: 'Where do the two briefs stand?' });
  await call('Chair', 'team_report', { team_id: TID, summary: 'Status: opening briefs are in and reviewed once. Intake and index tasks are done; the witness brief is being revised; the glossary is blocked on the sealed sheet. Next: evidence check from Tess, then amended briefs.' });
});
await step('notice', () => post(`/api/agents/${A('Chair')}/notices`, { kind: 'directive', body: 'Please keep the hearing to one more round and report when the amended briefs are in.' }));
await step('graph / coordination', async () => { await call('Tess', 'task_list', { team_id: TID }, { allowError: true }); await call('Reviewer', 'work_next', {}, { allowError: true }); });

// ── wait for the overdue alert ──
let overdue = false;
for (let i = 0; i < 24 && !overdue; i++) {
  overdue = (await get('/api/alerts?limit=200')).alerts.some((a) => a.type === 'task_overdue');
  if (!overdue) { await sleep(3000); await call('Chair', 'task_list', { team_id: TID }, { allowError: true }); }
}
if (!overdue) failures.push('overdue alert did not appear within 72 s');
state.done = failures.length === 0; save();
await seedFeedback();
await seedDecisions();
await seedScaleIf();

// ── summary ──
const n = async (p, k) => ((await get(p))[k] ?? []).length;
const [ag, ks, tm, al, au, inv, cv, rq, sh, lk, pcs] = await Promise.all([n('/api/agents', 'agents'), n('/api/keys', 'keys'), n('/api/teams', 'teams'), n('/api/alerts?limit=200', 'alerts'), n('/api/audit?limit=200', 'events'), n('/api/invocations?limit=2000', 'invocations'), n('/api/conversations', 'conversations'), n('/api/requests', 'requests'), n('/api/shares', 'shares'), n('/api/links', 'links'), n('/api/pcs', 'pcs')]);
const tasks = (await call('Chair', 'task_list', { team_id: TID })).structuredContent.tasks;
const byStatus = {}; for (const t of tasks) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
log(`Seeded: ${ag} agents, ${ks} keys, ${pcs} PC, ${tm} team, ${tasks.length} tasks ${JSON.stringify(byStatus)}, ${cv} conversations, ${rq} access requests, ${sh} shares, ${lk} links, ${al} alerts, ${inv} tool calls, ${au}+ audit events.`);
if (failures.length) { log(`${failures.length} step(s) failed:`); for (const f of failures) log(` - ${f}`); }
await mcp.close();
