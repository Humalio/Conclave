// Large dev seed (npm run dev:seed -- --scale, or SEED_SCALE=1): adds volume on top of the small seed so the console
// can be reviewed at scale: 3 more projects, 30 agents (4 not in any team), 11 teams in every status with tasks in
// varied states, messages between agents, 100+ directives in every scope and read state, and feedback with varied
// impact. Called from dev-seed.mjs with its helpers; talks only to the same local hub. Safe to re-run: entities are
// reused by name and a finished part is not repeated (state.scale in .dev/seed-state.json).

/* Deterministic pseudo-random numbers, so every run (after --reset) gives the same picture. */
const rng = (seed) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

const PROJECTS = ['Harbor Survey', 'Orchard Ledger', 'Night Shift'];
// 30 agents: label, project. The last four are in no team.
const PEOPLE = [
  ['Ada', 0], ['Bram', 0], ['Cleo', 0], ['Dov', 0], ['Esme', 0], ['Finn', 0], ['Gita', 0], ['Hugo', 0], ['Iris', 0], ['Jonas', 0],
  ['Kaia', 1], ['Lev', 1], ['Mina', 1], ['Nils', 1], ['Odile', 1], ['Pax', 1], ['Quill', 1], ['Rhea', 1], ['Soren', 1],
  ['Talia', 2], ['Ugo', 2], ['Vera', 2], ['Wren', 2], ['Xavi', 2], ['Yara', 2], ['Zeno', 2],
  ['Arlo', 0], ['Bea', 1], ['Cyrus', 2], ['Dalia', null],
];
const UNASSIGNED = ['Arlo', 'Bea', 'Cyrus', 'Dalia'];
// Teams: name, status, members [label, role] (first is the coordinator; the reviewer reviews every task).
const TEAMS = [
  { name: 'Harbor Soundings', status: 'running', goal: 'Chart the depth soundings of the north basin and publish a corrected map.', members: [['Ada', 'coordinator'], ['Bram', 'worker'], ['Cleo', 'worker'], ['Dov', 'reviewer']] },
  { name: 'Harbor Tides', status: 'running', goal: 'Reconcile three tide tables and flag every disagreement over ten centimetres.', members: [['Esme', 'coordinator'], ['Finn', 'worker'], ['Gita', 'worker'], ['Dov', 'reviewer']] },
  { name: 'Harbor Archive', status: 'paused', goal: 'Digitise the harbour master logs from 1950 to 1980.', members: [['Hugo', 'coordinator'], ['Iris', 'worker'], ['Jonas', 'reviewer']] },
  { name: 'Harbor Permits', status: 'draft', goal: 'Draft the permit checklist for the new pier.', members: [['Iris', 'coordinator'], ['Bram', 'worker'], ['Jonas', 'reviewer']] },
  { name: 'Orchard Audit', status: 'running', goal: 'Audit the cooperative ledger for the last harvest and explain every adjustment.', members: [['Kaia', 'coordinator'], ['Lev', 'worker'], ['Mina', 'worker'], ['Nils', 'reviewer']] },
  { name: 'Orchard Pricing', status: 'running', goal: 'Propose a fair price per crate for next season with the members\' cost data.', members: [['Odile', 'coordinator'], ['Pax', 'worker'], ['Quill', 'worker'], ['Rhea', 'reviewer'], ['Soren', 'stakeholder']] },
  { name: 'Orchard Grants', status: 'done', goal: 'Apply for the regional orchard renewal grant.', members: [['Kaia', 'coordinator'], ['Quill', 'worker'], ['Nils', 'reviewer']] },
  { name: 'Orchard Bylaws', status: 'paused', goal: 'Revise the cooperative bylaws on voting by proxy.', members: [['Soren', 'coordinator'], ['Mina', 'worker'], ['Rhea', 'reviewer']] },
  { name: 'Night Shift Rota', status: 'running', goal: 'Build a fair night rota for the clinic that respects every rest rule.', members: [['Talia', 'coordinator'], ['Ugo', 'worker'], ['Vera', 'worker'], ['Wren', 'reviewer']] },
  { name: 'Night Shift Handover', status: 'done', goal: 'Write the handover template for the night shift.', members: [['Xavi', 'coordinator'], ['Yara', 'worker'], ['Wren', 'reviewer']] },
  { name: 'Night Shift Incidents', status: 'draft', goal: 'Classify last year\'s night incidents and propose three changes.', members: [['Zeno', 'coordinator'], ['Yara', 'worker'], ['Vera', 'reviewer']] },
];
const TASK_TITLES = ['Collect the source records', 'Check the figures against the originals', 'Write the summary for the operator', 'List the open questions', 'Draft the recommendation',
  'Compare the two previous versions', 'Index the evidence by date', 'Review the glossary', 'Prepare the handover note'];

const DIRECTIVE_TOPICS = [
  ['Cite the revision you read', 'When you quote a vault note, name the revision you read so a reviewer can find the same text.'],
  ['One message per finding batch', 'Send findings in one message per review round, not one message per finding.'],
  ['Ask before reading sealed material', 'Never read sealed folders without an approved access request.'],
  ['Report token-heavy loops', 'If a loop costs more than 20 calls, stop and file feedback before going on.'],
  ['Keep task summaries short', 'A task summary is at most ten lines: what changed, what was checked, what is open.'],
  ['Name your sources', 'Every claim in a brief names its source note and line.'],
  ['No speculation in status reports', 'Status reports say what is done and what is blocked; no forecasts.'],
  ['Check in before the lease runs out', 'Call task_progress with an until before your check-in time passes.'],
  ['Escalate disagreements to the coordinator', 'When two agents disagree on a fact, the coordinator decides; do not argue in the room.'],
  ['Prefer file_patch for small edits', 'Use file_patch for edits under twenty lines, so history stays readable.'],
  ['Quote at most two sentences', 'Quote at most two sentences of any source; summarise the rest.'],
  ['Mark assumptions', 'Prefix every assumption with "Assumption:" so the reviewer can test it.'],
  ['Use the team room for decisions', 'Decisions that affect more than one task go in the team room, not in direct messages.'],
  ['Retire stale drafts', 'Delete drafts older than a week once the final version is in the vault.'],
  ['Read directives at start', 'At the start of each session, list your directives and acknowledge new versions.'],
  ['Use plain dates', 'Write dates as 11 Nov 2026, never as numbers only.'],
  ['Keep keys out of messages', 'Never paste a key, token or password into a message, file or share.'],
  ['Reviewers do not edit', 'Reviewers comment and request changes; they never edit the work under review.'],
  ['State the unit', 'Every number in a report carries its unit.'],
  ['Close what you open', 'Leave rooms and close channels you opened once the task is done.'],
];
const REPORTED = [
  ['Answer in English', 'From the project prompt: write every message and file in English.'],
  ['Spreadsheet exports as CSV', 'From the orchard rules file: export tables as CSV with a header row.'],
  ['Two-reviewer rule for prices', 'From chat with the operator: any price proposal needs two reviewers.'],
  ['Night rota rest rule', 'From the clinic handbook: eleven hours of rest between shifts.'],
  ['Round depths to the decimetre', 'From the survey manual: round soundings to 0.1 m.'],
  ['Log every manual correction', 'From the audit checklist: each manual ledger correction gets a line in the log.'],
  ['Use the venue time zone', 'From the project prompt: all times in the venue\'s local time.'],
  ['No weekend deadlines', 'From chat with the operator: never set a deadline on a Saturday or Sunday.'],
  ['Cite the tide table edition', 'From the tide rules: name the edition of every tide table used.'],
  ['Keep incident reports anonymous', 'From the clinic handbook: no patient or staff names in incident summaries.'],
  ['Short commit-style notes', 'From the rules file: progress notes start with a verb, under 80 characters.'],
  ['Flag duplicate members', 'From the bylaws prompt: flag any member listed twice in the register.'],
];

// Categories and tags for the seeded directives (docs/directives.md#categories-and-tags): by keyword, some left without
// one so the "No category" chip has rows; agents propose a category for most rules they report.
const CAT_RULES = [[/key|password|token into|lockdown|access/i, 'access'], [/token|loop|short|quote/i, 'tokens'], [/status|report|summary|unit|dates/i, 'reporting'],
  [/source|cite|claim|assumption|speculation/i, 'sources'], [/room|message|disagree|english/i, 'communication'], [/file_patch|csv|export|tool/i, 'tooling'], [/lease|review|draft|close|directives|deadline/i, 'process']];
const catOf = (t, i) => (i % 6 === 5 ? null : CAT_RULES.find(([re]) => re.test(t))?.[1] ?? null);
const tagsOf = (t) => [/vault|source|cite/i.test(t) && 'vault', /task|lease/i.test(t) && 'tasks', /review/i.test(t) && 'review', /token|loop/i.test(t) && 'budget'].filter(Boolean);

export async function seedScale(ctx) {
  const { get, post, put, patch, mcpClient, state, save, step, log, sleep } = ctx;
  state.scale ??= {}; const S = state.scale;
  const rand = rng(20261111);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  log('Scale seed: adding projects, agents, teams, directives and feedback.');

  // ── agents and session keys ──
  const agents = {}, keyIds = {};
  const all = (await get('/api/agents')).agents.filter((x) => x.status !== 'archived');
  for (const [label, p] of PEOPLE) {
    let a = all.find((x) => x.label === label);
    if (!a) a = (await post('/api/agents', { label, project: p === null ? null : PROJECTS[p] })).agent;
    agents[label] = a;
  }
  const keys = (await get('/api/keys?kind=session_key')).keys;
  for (const [label] of PEOPLE) {
    const kl = `${label} session`;
    let k = keys.find((x) => x.label === kl);
    if (k && !state.sessions[kl]) throw new Error(`key "${kl}" exists but its secret is unknown: restart with --reset`);
    if (!k) { const r = await post('/api/keys', { kind: 'session_key', agent_id: agents[label].id, label: kl, expires_at: null }); state.sessions[kl] = r.secret; save(); k = r.key; }
    keyIds[label] = k.id;
  }
  const A = (l) => agents[l].id;
  log(`Scale: ${PEOPLE.length} agents with session keys.`);

  // ── one PC and app key per project (an app key holds at most 20 live sessions) ──
  S.appKeys ??= {};
  const pcs = (await get('/api/pcs')).pcs;
  for (const p of PROJECTS) {
    if (S.appKeys[p]) continue;
    const name = `${p.toLowerCase().replace(/\s+/g, '-')}-desk`;
    const pc = pcs.find((x) => x.name === name) ?? (await post('/api/pcs', { name, description: `Shared desk for ${p}` })).pc;
    if ((await get(`/api/keys?kind=app_key&pc=${pc.id}`)).keys.length) throw new Error(`An app key on ${name} exists but its secret is not in .dev/seed-state.json: restart with --reset.`);
    S.appKeys[p] = (await post('/api/keys', { kind: 'app_key', machine_id: pc.id, app_name: 'Claude Code', label: `Claude Code on ${name}` })).secret;
    save();
  }
  const clients = {};
  for (const p of PROJECTS) clients[p] = await mcpClient(S.appKeys[p]);
  const projectOf = Object.fromEntries(PEOPLE.map(([l, p]) => [l, PROJECTS[p ?? 2]]));

  // ── logins ──
  const tokens = {};
  const call = async (who, name, args = {}, { allowError = false } = {}) => {
    const mcp = clients[who ? projectOf[who] : PROJECTS[0]];
    const r = await mcp.callTool({ name, arguments: { ...(who ? { session_token: tokens[who] } : {}), ...args } });
    if (r.isError && !allowError) throw new Error(`${who ?? 'anon'} ${name}: ${r.structuredContent?.error ?? ''} ${r.content?.[0]?.text ?? ''}`.slice(0, 300));
    return r;
  };
  const data = (r) => r.structuredContent ?? {};
  for (const [label] of PEOPLE) {
    await step(`scale login ${label}`, async () => {
      const r = await clients[projectOf[label]].callTool({ name: 'session_login', arguments: { session_key: state.sessions[`${label} session`] } });
      if (r.isError) throw new Error(r.content?.[0]?.text ?? 'session_login failed');
      tokens[label] = data(r).session_token;
      await call(label, 'session_describe', { role: 'Demo agent', status_text: pick(['Working through the task list.', 'Waiting for review.', 'Reading the source records.', 'Idle.']), model_label: 'demo-model' });
    });
  }

  // ── teams, tasks and messages ──
  const teamIds = {};
  const existingTeams = (await get('/api/teams')).teams;
  for (const def of TEAMS) {
    await step(`scale team ${def.name}`, async () => {
      let t = existingTeams.find((x) => x.name === def.name);
      if (t) { teamIds[def.name] = t.id; return; }
      t = (await post('/api/teams', { name: def.name, goal: def.goal, grant_messaging: true, lease_minutes: 30,
        members: def.members.map(([l, role]) => ({ agent_id: A(l), role, credential_id: keyIds[l] })) })).team;
      teamIds[def.name] = t.id;
      await patch(`/api/teams/${t.id}`, { delivery_mode: 'on_demand' });
      if (def.status === 'draft') return;
      await post(`/api/teams/${t.id}/start`);
      await teamWork(def, t.id);
      if (def.status === 'paused') await post(`/api/teams/${t.id}/pause`);
      if (def.status === 'done') await call(def.members[0][0], 'team_complete', { team_id: t.id, summary: 'All tasks done and reviewed; handed over to the operator.' });
    });
  }

  async function teamWork(def, TID) {
    const coord = def.members[0][0], reviewer = def.members.find((m) => m[1] === 'reviewer')?.[0];
    const workers = def.members.filter((m) => m[1] === 'worker').map((m) => m[0]);
    const n = def.status === 'done' ? 4 : 6 + Math.floor(rand() * 3);
    const tasks = [];
    for (let i = 0; i < n; i++) {
      const title = `${TASK_TITLES[i % TASK_TITLES.length]} (${def.name})`;
      tasks.push(data(await call(coord, 'task_create', { team_id: TID, title, description: `${title}. Part of: ${def.goal}`, reviewer: A(reviewer) })).task);
    }
    const W = (i) => workers[i % workers.length];
    const done = async (k, i) => {
      await call(coord, 'task_assign', { task_id: k.id, agent_id: A(W(i)) });
      await call(W(i), 'task_start', { task_id: k.id });
      await call(W(i), 'task_submit', { task_id: k.id, summary: 'Done; checked against the source records.' });
      await call(reviewer, 'task_review', { task_id: k.id, decision: 'approve', comments: 'Checked. Supported.' });
      await call(coord, 'task_complete', { task_id: k.id, summary: 'Accepted.' });
    };
    if (def.status === 'done') { for (let i = 0; i < tasks.length; i++) await done(tasks[i], i); }
    else {
      // States, in order: done, done, in review, in progress (with check-in), stalled (check-in passes), blocked,
      // waiting on the operator, and an open one if there are more.
      const plan = ['done', 'done', 'in_review', 'in_progress', 'stalled', 'blocked', 'ask', 'open'];
      for (let i = 0; i < tasks.length; i++) {
        const k = tasks[i], s = plan[i] ?? 'open';
        await step(`scale task ${def.name} ${s}`, async () => {
          if (s === 'done') return done(k, i);
          if (s === 'blocked') return call(coord, 'task_block', { task_id: k.id, reason: 'Waiting for the source records from the archive.' });
          if (s === 'ask') return call(coord, 'team_ask', { team_id: TID, task_id: k.id, question: `Which edition should "${k.title}" use?`, context: 'Two editions disagree; the task cannot go on without one.',
            options: [{ key: 'a', label: 'The latest edition' }, { key: 'b', label: 'The edition in the contract' }], recommended: 'b' });
          if (s === 'open') return;
          await call(coord, 'task_assign', { task_id: k.id, agent_id: A(W(i)) });
          await call(W(i), 'task_start', { task_id: k.id });
          if (s === 'in_review') return call(W(i), 'task_submit', { task_id: k.id, summary: 'First pass done; two figures still need a second look.' });
          // A check-in a few seconds ahead: the hub marks the task overdue (the member stalled) once it passes.
          await call(W(i), 'task_progress', { task_id: k.id, note: 'Halfway through.', until: Date.now() + (s === 'stalled' ? 3000 : 6 * 3600_000) });
        });
      }
    }
    // Messages: the room and direct messages, varied counts so topology edges differ in weight.
    await step(`scale messages ${def.name}`, async () => {
      const room = (await get(`/api/teams/${TID}`)).team.room_id;
      let c = 0;
      const send = (who, body, to) => call(who, 'message_send', { body, client_msg_id: `scale-${TID}-${c++}`, ...(to ? { to: A(to) } : { room_id: room }) });
      await send(coord, `Kick-off: ${def.goal}`);
      for (const w of workers) await send(w, 'Picked up my first task; will post findings here.');
      // Direct messages only where the team grants them: coordinator-worker, coordinator-stakeholder, worker-reviewer.
      const stakeholders = def.members.filter((m) => m[1] === 'stakeholder').map((m) => m[0]);
      const pairs = [...workers.map((w) => [coord, w]), ...stakeholders.map((s) => [coord, s]), ...(reviewer ? workers.map((w) => [w, reviewer]) : [])];
      for (let i = 0; i < 4 + Math.floor(rand() * 8); i++) {
        const [x, y] = pick(pairs), [a, b] = rand() < 0.5 ? [x, y] : [y, x];
        await send(a, pick(['Can you check the second table?', 'Done with my part; over to you.', 'Found a mismatch in row 12.', 'Agreed.', 'Which source did you use?', 'Posting the summary now.']), b);
      }
      for (const m of def.members) await call(m[0], 'message_read', {}, { allowError: true });
    });
  }
  log(`Scale: ${TEAMS.length} teams.`);

  // Unassigned agents talk to each other through a messaging link, so they have edges too.
  await step('scale links', async () => {
    const have = (await get('/api/links')).links;
    const ensure = async (from, to, kind, note) => { if (!have.some((l) => l.from_agent_id === A(from) && l.to_agent_id === A(to) && l.kind === kind)) await post('/api/links', { from_agent_id: A(from), to_agent_id: A(to), kind, note, grants_messaging: true }); };
    await ensure('Arlo', 'Ada', 'advises', 'Survey method advice');
    await ensure('Bea', 'Kaia', 'supports', 'Bookkeeping support');
    await ensure('Cyrus', 'Talia', 'advises', 'Labour rules');
    await ensure('Dalia', 'Arlo', 'supports', 'Shared tooling');
  });
  await step('scale link messages', async () => {
    if (S.linkMessages) return;
    let c = 0;
    for (const [a, b] of [['Arlo', 'Ada'], ['Ada', 'Arlo'], ['Bea', 'Kaia'], ['Cyrus', 'Talia'], ['Dalia', 'Arlo'], ['Arlo', 'Dalia']])
      await call(a, 'message_send', { to: A(b), body: 'A quick question on the method before I write it up.', client_msg_id: `scale-link-${c++}` }, { allowError: true });
    S.linkMessages = true; save();
  });

  // ── directives: 100+ in every scope and read state ──
  await step('scale directives', async () => {
    if (S.directives) return;
    const made = [];
    const mk = async (title, body, scope) => made.push((await post('/api/directives', { title, body, scope, source: 'dev-seed scale', category: catOf(title, made.length), tags: tagsOf(title) })).directive);
    for (const [t, b] of DIRECTIVE_TOPICS.slice(0, 8)) await mk(t, b, { kind: 'hub' });
    for (const p of PROJECTS) for (const [t, b] of DIRECTIVE_TOPICS.slice(8, 18)) await mk(`${t} (${p})`, b, { kind: 'project', ref: p });
    for (const def of TEAMS) for (const [t, b] of DIRECTIVE_TOPICS.slice(10 + (def.name.length % 5), 15 + (def.name.length % 5))) await mk(`${t} (${def.name})`, b, { kind: 'team', ref: teamIds[def.name] });
    for (const def of TEAMS.slice(0, 6)) for (const role of ['worker', 'reviewer']) await mk(`${role === 'worker' ? 'Workers' : 'Reviewers'} of ${def.name}: ${DIRECTIVE_TOPICS[role === 'worker' ? 7 : 17][0].toLowerCase()}`, DIRECTIVE_TOPICS[role === 'worker' ? 7 : 17][1], { kind: 'role', ref: `${teamIds[def.name]}|${role}` });
    for (const l of ['Ada', 'Kaia', 'Talia', 'Bram', 'Lev', 'Ugo', 'Arlo', 'Dalia', 'Odile', 'Hugo']) await mk(`${l}: ${DIRECTIVE_TOPICS[(l.length * 3) % 20][0].toLowerCase()}`, DIRECTIVE_TOPICS[(l.length * 3) % 20][1], { kind: 'agent', ref: A(l) });
    // Read states: each agent acknowledges most of its directives (some agents fall behind, a few read nothing).
    const lazy = new Set(['Gita', 'Pax', 'Zeno']), slow = new Set(['Finn', 'Lev', 'Vera', 'Cyrus', 'Iris']);
    for (const [label] of PEOPLE) {
      if (lazy.has(label) || !tokens[label]) continue;
      const list = data(await call(label, 'directives_list')).directives ?? [];
      for (const d of list) if (rand() < (slow.has(label) ? 0.4 : 0.9)) await call(label, 'directive_ack', { id: d.id, version: d.version }, { allowError: true });
    }
    // Old version: edit some after they were read, so their readers hold an outdated version (two edits for a few).
    for (const [i, d] of made.entries()) {
      if (i % 7 !== 3) continue;
      await patch(`/api/directives/${d.id}`, { body: `${d.body} Updated: applies to drafts too.`, note: 'Clarified the scope.' });
      if (i % 21 === 3) await patch(`/api/directives/${d.id}`, { body: `${d.body} Updated: applies to drafts and shares.`, note: 'Covers shares.' });
    }
    // Retired ones, for the history.
    for (const d of made.filter((_, i) => i % 25 === 24)) await post(`/api/directives/${d.id}/retire`, { note: 'Superseded by the project rule.' });
    // Not reviewed: rules agents report following (registered at once, awaiting the operator).
    for (const [i, [t, sum]] of REPORTED.entries()) {
      const who = PEOPLE[(i * 5) % 26][0];
      const category = i % 4 === 3 ? undefined : catOf(`${t} ${sum}`, 0) ?? 'process';
      await call(who, 'directives_report', { title: t, summary: sum, source: sum.split(':')[0].replace(/^From /, ''), ...(category ? { category } : {}) });
    }
    // The same rule reported by two agents, so the review step shows a duplicate.
    await call('Bram', 'directives_report', { title: REPORTED[4][0], summary: REPORTED[4][1], source: 'survey manual', category: 'sources' });
    S.directives = true; save();
    log(`Scale: ${made.length} directives by the operator, ${REPORTED.length + 1} reported by agents.`);
  });

  // ── feedback with varied impact ──
  await step('scale feedback', async () => {
    if (S.feedback) return;
    const file = async (who, a) => data(await call(who, 'feedback_file', a)).report_id;
    const plus = async (id, whos) => { for (const w of whos) await call(w, 'feedback_add', { report_id: id, kind: 'plus_one' }, { allowError: true }); };
    const a = await file('Bram', { kind: 'bug', tool: 'task_progress', title: 'task_progress until is ignored after a pause and resume', severity: 'blocking', tried: 'Set until two hours ahead, then the team was paused and resumed.', happened: 'The task went overdue ten minutes after the resume.', expected: 'The check-in time moves with the pause.', workaround: 'Called task_progress again after every resume.', cost: { extra_calls: 40, extra_tokens: 52000, minutes_lost: 90 } });
    await plus(a, ['Cleo', 'Finn', 'Gita', 'Lev', 'Mina', 'Ugo', 'Vera']);
    const b = await file('Lev', { kind: 'limitation', tool: 'message_read', title: 'message_read cannot filter by room', severity: 'costly', tried: 'Read only the team room during an audit round.', happened: 'Every room came back; most of the answer was unrelated.', cost: { extra_calls: 12, extra_tokens: 18000, minutes_lost: 15 } });
    await plus(b, ['Pax', 'Quill', 'Kaia']);
    const c = await file('Ugo', { kind: 'bug', tool: 'directive_ack', error_code: 'invalid_argument', title: 'directive_ack refuses a version that directives_list just returned', severity: 'costly', tried: 'Acknowledged right after the list.', happened: 'invalid_argument: the directive had changed in between.', cost: { extra_calls: 3, minutes_lost: 4 } });
    await post(`/api/feedback/${c}/status`, { status: 'accepted', note: 'Race between edit and ack.', guidance: 'List again and acknowledge the version it shows.' });
    await file('Arlo', { kind: 'wish', tool: 'agent_list', title: 'agent_list could show which team an agent is in', severity: 'minor', tried: 'Looked for the right person to ask about the survey method.', cost: { extra_calls: 2, minutes_lost: 1 } });
    const e = await file('Talia', { kind: 'bug', tool: 'task_assign', title: 'task_assign accepts an agent who left the team', severity: 'costly', tried: 'Assigned the rota check to the agent who had been on the team last week.', happened: 'The task sat assigned to someone who could not see it.', cost: { extra_calls: 6, extra_tokens: 7000, minutes_lost: 30 } });
    await plus(e, ['Xavi', 'Zeno']);
    await post(`/api/feedback/${e}/status`, { status: 'fixed', note: 'Refused now.', fixed_in: '0.1.0' });
    await file('Dalia', { kind: 'wish', area: 'other', title: 'A way to see directives for agents in no team', severity: 'minor', tried: 'Checked which rules applied to me outside any team.' });
    const g = await file('Odile', { kind: 'limitation', tool: 'team_ask', title: 'team_ask cannot attach a table', severity: 'costly', tried: 'Asked the operator to choose between three price models.', happened: 'The options lost their numbers.', cost: { extra_calls: 5, extra_tokens: 9000, minutes_lost: 20 } });
    await post(`/api/feedback/${g}/status`, { status: 'needs_info', note: 'Would a link to a share do?' });
    const h = await file('Hugo', { kind: 'bug', tool: 'file_search', title: 'file_search misses notes with accents in the title', severity: 'blocking', tried: 'Searched for "Décret" in the archive.', happened: 'No hits, although the note exists.', cost: { extra_calls: 25, extra_tokens: 30000, minutes_lost: 60 } });
    await plus(h, ['Iris', 'Jonas']);
    S.feedback = true; save();
    log('Scale: 8 feedback reports with varied impact.');
  });

  await sleep(3500); // let the short check-ins pass, so the hub marks those tasks overdue (stalled members)
  // Log out, so a re-run stays under the 20 live sessions an app key may hold.
  for (const label of Object.keys(tokens)) await call(label, 'session_logout', {}, { allowError: true });
  for (const c of Object.values(clients)) await c.close();
}
