// Act 3: blocker — the air-gapped capture still hears the echo, impact and staleness, blocked and cancelled work, Classified, conflicts.
import { movePlans, bpKey } from './plans.mjs';

const s = (id, title, run, opts = {}) => ({ id, title, run, ...opts });
const V = '/vault';
const EXP = 'Captures/CAP-014 Air-gapped capture.md';
const FAKE_KEY = `ah_ses_${'a'.repeat(12)}_${'b'.repeat(32)}`;

export default [
  s('3.1', 'CAP-014 hears the echo, written on the test-stand PC outside the hub', async (c) => {
    const h0 = await c.as('Hesper').ok('file_history', { path: `${V}/${EXP}` });
    c.S.exp14Before = (h0.revisions ?? [])[0]?.revision;
    const text = c.disk.read(EXP).replace(/## Result\n[\s\S]*?(?=\n## )/, '## Result\n\nECHO. The reply arrived 0.71 s early on 600 of 600 transmissions above 0.32 (block B, transmissions 201–800), with Firmware 7 removed and ORRIN disconnected. The hand-clocked tape agrees with the stand recorder to 1 ms. Nine ring nodes on the face, all at the frost positions on the map. Campaign stopped at transmission 800.\n');
    c.expect(text.includes('ECHO. The reply arrived'), 'the result section was rewritten');
    c.disk.write(EXP, text);
    const csv = c.disk.read('Assets/data/cap-014-echoes.csv');
    c.disk.write('Assets/data/cap-014-echoes.csv', csv + [400, 600, 800].map((n, i) => `${n},0.33,${(0.710 + i * 0.001).toFixed(3)},${(4.1 + i * 3.2).toFixed(2)},${[3, 6, 9][i]},${n === 800 ? 'stopped: read-out' : ''}`).join('\n') + '\n');
    await c.until(async () => {
      const h = await c.as('Hesper').ok('file_history', { path: `${V}/${EXP}` });
      return (h.revisions ?? [])[0]?.origin === 'external_observed' ? h : null;
    }, { timeout: 20000, every: 500, what: 'the watcher to record the external edit' });
  }, { beat: 4000, rows: ['vault-recovery'] }),

  s('3.2', 'Hesper sees who changed it and what', async (c) => {
    const h = await c.as('Hesper').ok('file_history', { path: `${V}/${EXP}` });
    const [now, before] = h.revisions;
    c.eq(now.origin, 'external_observed', 'the new revision came from outside the hub');
    const d = await c.as('Hesper').ok('file_diff', { path: `${V}/${EXP}`, from_revision: before.revision, to_revision: now.revision });
    c.expect(JSON.stringify(d).includes('ECHO. The reply arrived'), 'the diff shows the result line');
  }),

  s('3.3', 'Hesper asks what depends on CAP-014', async (c) => {
    const r = await c.as('Hesper').ok('graph_impact', { path: `${V}/${EXP}` });
    const j = JSON.stringify(r);
    for (const n of ['Firmware 7', 'B-01 Firmware 7 fault']) c.expect(j.includes(n), `impact candidates include ${n}`);
    c.expect(!j.includes('/Classified/'), 'no Classified note among the candidates');
  }, { beat: 3000, rows: ['knowledge', 'trust-boundaries'] }),

  s('3.4', 'Quentin flags the dependants stale and disputes the qualification claim', async (c) => {
    const Q = c.as('Quentin');
    c.S.flags = {};
    for (const [key, p] of [['alloy', 'Theories/Firmware 7.md'], ['coil', 'Relay Engineering/Dish array design.md'], ['budget', 'Relay Engineering/Power budget.md'], ['safety', 'Oversight/Disclosure case.md']]) {
      const r = await Q.ok('graph_flag', { path: `${V}/${p}`, cause_path: `${V}/${EXP}`, kind: 'stale', reason: 'CAP-014 heard the echo 0.71 s early with no firmware in the loop; this note assumes Firmware 7 explains it.' });
      c.S.flags[key] = r.flag_id ?? r.flag?.id;
    }
    const q = await Q.ok('graph_query', { entity: 'Firmware 7' });
    const claim = (q.claims ?? []).find((x) => x.predicate === 'qualified_for');
    c.expect(claim, 'the qualification claim exists');
    c.S.disputed = claim.id;
    const r = await Q.ok('graph_invalidate', { claim_id: claim.id, reason: 'CAP-014: the echo arrives without Firmware 7.' });
    c.expect(/disputed|review/.test(JSON.stringify(r)), `an accepted claim goes to a reviewer (${JSON.stringify(r).slice(0, 160)})`);
  }, { rows: ['knowledge'] }),

  s('3.5', 'Owners see their stale flags; Vesna sees no Classified cause', async (c) => {
    const d = await c.as('Dario').ok('graph_stale', { path_prefix: `${V}/Relay Engineering` });
    c.expect((d.flags ?? []).length >= 2, 'Relay Engineering has the dish and budget flags');
    await c.as('Lusa').ok('graph_stale', { mine: true });
    const j = await c.as('Vesna').ok('graph_stale', { path_prefix: `${V}/Theories` });
    c.expect((j.flags ?? []).length >= 1, 'Theories has the Firmware 7 flag');
    c.expect(!JSON.stringify(j).includes('/Classified/'), 'the private cause stays hidden');
  }, { rows: ['knowledge', 'trust-boundaries'] }),

  s('3.6', 'Brannoc blocks surge protection and cancels the live listen prep', async (c) => {
    await c.as('Brannoc').ok('task_block', { task_id: c.S.t.quench.id, reason: 'Waiting on the explanation: the dump path depends on which receivers we fit.' });
    await c.as('Brannoc').ok('task_cancel', { task_id: c.S.t.staticPrep.id, reason: 'M4 live listen cannot be prepared on an unexplained echo.' });
    const alerts = (await c.op.get('/api/alerts?limit=200')).alerts ?? [];
    c.expect(alerts.some((a) => /block/.test(a.type)), 'the operator is alerted to the blocked task');
  }, { rows: ['teams'] }),

  s('3.7', 'Dario may not block his own task', async (c) => {
    const r = await c.as('Dario').no('task_block', { task_id: c.S.t.coil.id, reason: 'Firmware 7 failed.' });
    c.expect(/coordinator/i.test(r.text) && /task_progress|message/i.test(r.text), `the refusal names the coordinator and the alternative: ${r.text.slice(0, 200)}`);
  }, { rows: ['teams'] }),

  s('3.8', 'The trail stops at a door Vesna cannot open', async (c) => {
    const J = c.as('Vesna');
    const rel = await J.ok('graph_related', { path: `${V}/Captures/CAP-014b Empty dish.md` });
    c.expect(!JSON.stringify(rel).includes('/Classified/'), 'graph_related shows no Classified path');
    const chk = await J.ok('access_check', { action: 'fs.read', resource: `path:${V}/Classified/**` });
    c.expect(chk.allowed === false || /not allowed|deny/i.test(JSON.stringify(chk)), 'access_check says no');
    await J.no('file_read', { path: `${V}/Classified/Director/What answers us.md` });
    const sr = await J.ok('file_search', { query: 'substrate' });
    c.eq((sr.results ?? sr.hits ?? []).length, 0, 'search finds nothing outside Classified');
  }, { beat: 3000, rows: ['policy', 'trust-boundaries'] }),

  s('3.9', 'Vesna asks to read Classified', async (c) => {
    const r = await c.as('Vesna').ok('access_request', { actions: ['fs.read'], resource: `path:${V}/Classified/**`, reason: 'CAP-014 heard the echo with no firmware in the loop. The director has a theory; I need to read it.', duration: '2h' });
    c.S.accessReq = r.request_id;
    const st = await c.as('Vesna').ok('access_status', { request_id: r.request_id });
    c.expect(/pending/.test(JSON.stringify(st)), 'the request is pending');
  }, { rows: ['policy'] }),

  s('3.10', 'Brannoc asks the operator: patch Firmware 7 or switch to Q-9?', async (c) => {
    const r = await c.as('Brannoc').ok('team_ask', { team_id: c.T('pc'), task_id: c.S.t.coil.id, question: 'Keep patching Firmware 7, or listen on the Q-9 quiet receiver?',
      context: 'CAP-014 heard the echo 0.71 s early on 600 of 600 transmissions with no firmware in the loop. Q-9 is 11 % heavier and has no relay firmware at all.',
      options: [{ key: 'a', label: 'Patch Firmware 7', effect: 'Another build, another 600 transmissions; M3 slips eight weeks.' }, { key: 'b', label: 'Switch to Q-9', effect: 'Dish and budget redesign; mass +1.6 kg; M3 slips four weeks.' }], recommended: 'b' });
    c.S.decision = r.decision_id;
    const t = (await c.as('Dario').ok('task_list', { team_id: c.T('pc') })).tasks.find((x) => x.id === c.S.t.coil.id);
    c.eq(t.status, 'blocked', 'the dish task waits for the answer');
  }, { beat: 2500 }),

  s('3.11', 'Brannoc adds the workshop lead time', async (c) => {
    await c.as('Brannoc').ok('team_ask_update', { decision_id: c.S.decision, context: 'The Annex workshop quotes six weeks for a set of Q-9 racks.' });
  }),

  s('3.11b', 'The blocker reaches the plans; the operator asks The Annex to re-plan', async (c) => {
    await movePlans(c, 3);
    const r = await c.op.post(`/api/teams/${c.T('mh')}/plan-request`, { note: 'CAP-014 heard the echo with no firmware. Re-plan the explanation once the Firmware 7 or Q-9 decision is in.' });
    c.expect(r.team?.plan?.requested_at, 'the review request is on the plan');
  }, { beat: 2000 }),

  s('3.11c', 'The operator sees the blocker in Work in motion', async (c) => {
    const r = await c.op.get('/api/work/recent?limit=20');
    const ev = r.events ?? [];
    c.expect(ev.some((e) => e.kind === 'plan' && e.plan.moves.some((m) => m.key === 'M2' && m.status === 'missed' && e.team?.id === c.T('mh'))), 'the feed says The Annex M2 missed');
    c.expect(ev.some((e) => e.kind === 'task' && e.to === 'blocked'), 'the feed shows the blocked task');
    c.expect(ev.some((e) => e.kind === 'plan' && e.plan.event === 'review_request'), 'the feed shows the operator’s re-plan request');
    c.expect(ev.every((e, i) => i === 0 || ev[i - 1].at >= e.at), 'newest first');
  }),

  s('3.12', 'Two writers on one base: the second write is refused', async (c) => {
    const p = `${V}/Theories/Firmware 7.md`;
    const a = await c.as('Vesna').ok('file_read', { path: p }), b = await c.as('Rafi').ok('file_read', { path: p });
    c.eq(a.revision, b.revision, 'both read the same revision');
    c.S.alloyRev = (await c.as('Vesna').ok('file_update', { path: p, base_revision: a.revision, content: a.content.replace('## Qualification status', '## Qualification status\n\n**CAP-014 heard the echo with no firmware in the loop (600 of 600).** Qualification suspended.\n') })).revision;
    await c.as('Rafi').no('file_update', { path: p, base_revision: b.revision, content: b.content + '\nRafi: lot traceability notes.\n' }, 'conflict');
  }, { rows: ['vault-recovery'] }),

  s('3.13', 'A sync tool leaves a conflicted copy; Hesper lists the conflicts', async (c) => {
    c.disk.write('Relay Engineering/Dish array design (conflicted copy).md', c.disk.read('Relay Engineering/Dish array design.md') + '\nEdited offline on the Tern-9 laptop.\n');
    const mh = await c.as('Hesper').ok('file_conflicts', { path_prefix: `${V}/Theories` });
    c.expect(/platform_cas/.test(JSON.stringify(mh)), 'the stale write is recorded as platform_cas');
    await c.until(async () => /sync_tool/.test(JSON.stringify(await c.as('Brannoc').ok('file_conflicts', { path_prefix: `${V}/Relay Engineering` }))), { timeout: 20000, every: 500, what: 'the sync conflict copy to be recognised' });
  }, { beat: 3000, rows: ['vault-recovery'] }),

  s('3.14', 'Mirela checks in on a short lease and goes quiet', async (c) => {
    const t = (await c.as('Calder').ok('task_create', { team_id: c.T('nt'), title: 'Clock holdover after the coax swap', description: 'Repeat the 72 h holdover with the new receiver coax.', refs: ['TK-R4', 'TK-M1'].map(bpKey) })).task;
    await c.as('Calder').ok('task_assign', { task_id: t.id, agent_id: c.A('Mirela'), reviewer: c.A('Tobin') });
    await c.as('Mirela').ok('task_start', { task_id: t.id });
    await c.as('Mirela').ok('task_progress', { task_id: t.id, note: 'Starting the run; will check in shortly.', until: Date.now() + 3000 });
    c.S.t.holdover = t;
  }),

  s('3.15', 'A key-shaped string in a message is refused; Wynn\'s key stays active', async (c) => {
    await c.as('Wynn').no('message_send', { room_id: c.S.room, body: `Found this in an old note: ${FAKE_KEY}`, client_msg_id: 'wynn-fake' }, 'contains_key');
    await c.as('Wynn').ok('session_whoami', {});
  }, { rows: ['trust-boundaries'] }),
];

