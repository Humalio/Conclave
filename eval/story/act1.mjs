// Act 1: kickoff — logins, plan, directives, tasks, rooms and DMs (docs/showcase.md §4).
import { agents, TEAMS } from './cast.mjs';
import { setPlan, writePlan, bpKey, TASK_REFS } from './plans.mjs';

const s = (id, title, run, opts = {}) => ({ id, title, run, ...opts });
const day = 86400_000;
const DRIVE_COORDS = ['Orla', 'Brannoc', 'Hesper', 'Calder', 'Ayo', 'Saoirse'];

export default [
  s('1.1', 'Orla asks how to log in', async (c) => {
    const d = await c.as('Orla').ok('session_help', {});
    c.expect(d.steps?.[0] === 'session_login', 'session_help names session_login first');
  }),

  s('1.2', 'Every seat logs in through its PC; a bound key fails elsewhere', async (c) => {
    for (const a of agents()) await c.login(a.label);
    const ids = new Set(Object.values(c.seats).map((x) => x.token));
    c.eq(ids.size, 29, 'distinct session tokens');
    // Sef's key is bound to pc-lab-east: through pc-tern9's app key it is refused like an unknown key.
    const r = await c.pcs.yard.conn.tool('session_login', { session_key: c.keys.Sef.secret });
    c.rec.tool('session_login', r.ok ? 'ok' : `refused:${r.code}`);
    c.expect(!r.ok, 'a bound key must not log in through another PC');
  }, { beat: 2500, rows: ['identity', 'pc-binding'] }),

  s('1.3', 'Each seat states its role', async (c) => {
    for (const a of agents()) {
      const t = TEAMS.find((x) => x.key === a.home), role = t.members.find(([l]) => l === a.label)[1];
      await c.as(a.label).ok('session_describe', { role: `${t.name} · ${role}`, status_text: 'Kickoff: reading the plan.', model_label: 'scripted' });
    }
  }),

  s('1.4', 'Vesna checks who she is and what she may do', async (c) => {
    const me = await c.as('Vesna').ok('session_whoami', {});
    c.expect(JSON.stringify(me).includes(c.A('Vesna')), 'whoami names Vesna');
    await c.as('Vesna').ok('access_list', {});
  }, { rows: ['identity'] }),

  s('1.5', 'pc-tern9 gets a setup key; the setup tool answers', async (c) => {
    const r = await c.op.post(`/api/pcs/${c.pcs.yard.pc.id}/setup`);
    c.S.setupKey = r.setup_key;
    const yard = c.pcs.yard.conn;
    const a = await yard.tool('setup_pc', { setup_key: r.setup_key, os: 'windows', pc_name: 'pc-tern9' });
    c.rec.tool('setup_pc', a.ok ? 'ok' : `refused:${a.code}`);
    c.expect(a.ok, `setup_pc: ${a.text.slice(0, 200)}`);
    const st = await yard.tool('setup_status', { setup_key: r.setup_key });
    c.rec.tool('setup_status', st.ok ? 'ok' : `refused:${st.code}`);
    c.expect(st.ok && /waiting/.test(JSON.stringify(st.data) + st.text), `setup_status waits for the install: ${st.text.slice(0, 200)}`);
  }),

  s('1.6', 'Saoirse reads her team', async (c) => {
    const d = await c.as('Saoirse').ok('team_info', { team_id: c.T('int') });
    c.expect(d.teams?.[0]?.mode === 'poll', `Case Command is a polling team (got ${d.teams?.[0]?.mode})`);
  }),

  s('1.7', 'Saoirse sets the case plan', async (c) => {
    const R = [
      ['R1', 'Send one controlled reply to the echo and log what answers', 'must', ['M7']], ['R2', 'Echo model frozen and validated', 'must', ['M1']], ['R3', 'Dish surge margin at least 15 %', 'must', ['M2']],
      ['R4', 'The explanation holds over 600 transmissions at operating power', 'must', ['M3']], ['R5', 'Relay clocks stamp within 4 ns', 'must', ['M4']], ['R6', 'Lead-time error within 5 ns', 'must', ['M4']],
      ['R7', 'Keeper exposure within 3 EH per live listen', 'must', ['M6']], ['R8', 'Refit adds at most 6 % station mass', 'should', ['M5']], ['R9', 'Silence within 200 ms', 'must', ['M4']],
      ['R10', 'Independent review of every disclosure-critical item', 'must', ['M6']], ['R11', 'Every result traceable to a capture ID', 'should', ['M6']], ['R12', 'No uncharacterised biological material in the relay loop', 'must', ['M6']],
    ].map(([key, title, priority, milestones]) => ({ key, title, priority, status: 'open', milestones }));
    const M = [['M1', 'Echo model frozen', 28], ['M2', 'Dish design review', 43], ['M3', 'Explanation qualified', 59], ['M4', 'Live listen', 120], ['M5', 'Tern-9 refit complete', 196], ['M6', 'Disclosure approved', 243], ['M7', 'First deliberate reply', 272]]
      .map(([key, title, due]) => ({ key, title, status: 'planned', due }));
    // The case plan is Case Command's part of its project blueprint; the operator agrees what needs agreeing (plans.mjs).
    const p = await writePlan(c, 'int', 'Saoirse', { requirements: R, milestones: M }, { fresh: true, reason: 'The case plan.' });
    c.eq(p.items.filter((i) => i.kind === 'fr').length, 12, 'Case Command holds FR-CC-01 to FR-CC-12');
  }, { beat: 2000 }),

  s('1.7b', 'The other coordinators set their team plans', async (c) => {
    // Each plan is the team's own, grounded in its vault notes (plans.mjs); Tern-9 Keepers sets its plan once it starts (1.13b).
    for (const team of ['fp', 'pc', 'mh', 'nt', 'cm', 'sb']) {
      const p = await setPlan(c, team);
      c.expect(p.items.filter((i) => i.kind === 'fr').length >= 4 && p.items.filter((i) => i.kind === 'milestone').length >= 2, `${team} has requirements and milestones`);
    }
  }, { beat: 2000 }),

  s('1.8', 'Wynn reads the plan but may not replace it', async (c) => {
    const p = await c.as('Wynn').ok('bp_read', { team_id: c.T('int'), kinds: ['fr', 'milestone'] });
    c.expect(p.items.some((i) => i.key === 'FR-CC-12'), 'the plan has FR-CC-12');
    await c.as('Wynn').no('bp_write', { team_id: c.T('int'), version: p.project.version, ops: [{ op: 'upsert', kind: 'milestone', key: 'M1', status: 'reached' }] }, 'denied');
  }, { rows: ['teams'] }),

  s('1.9', 'Lusa filters her directives by category and tag', async (c) => {
    const L = c.as('Lusa');
    const proc = await L.ok('directives_list', { category: 'process' });
    c.expect(JSON.stringify(proc).includes('Surge margin'), 'the process directives include the surge margin rule');
    await L.ok('directives_list', { tag: 'safety' });
    await L.ok('directives_list', { category: 'none' });
    await L.no('directives_list', { category: 'weather' }, 'invalid_argument');
  }, { rows: ['directives-categories'] }),

  s('1.10', 'Lusa reads and acknowledges each directive', async (c) => {
    const L = c.as('Lusa');
    const list = await L.ok('directives_list', {});
    const read = await L.ok('directives_read', { ack: true });
    c.expect((read.acked ?? []).length === (list.directives ?? []).length, 'directives_read {ack: true} confirms each directive');
    c.expect((list.directives ?? []).length >= 3, 'Lusa has at least three directives in force');
  }),

  s('1.11', 'Petra suggests the exposure-unit rule she already follows', async (c) => {
    const d = await c.as('Petra').ok('directives_report', { title: 'Exposure in echo-hours (EH)', summary: 'Every exposure in a Xenobiology note is in echo-hours (EH), with the conversion stated once per note.', source: 'Xenobiology style sheet', category: 'sources' });
    c.expect(d.status === 'open' && !d.directive_id, 'her report becomes a suggestion to her team, not a directive in force');
    c.S.petraReport = d.id;
  }, { rows: ['directives-categories'] }),

  s('1.12', 'Seats acknowledge their notices', async (c) => {
    for (const l of ['Orla', 'Saoirse', 'Lusa', 'Dario']) {
      const me = await c.as(l).ok('session_whoami', {});
      const seqs = (me.notices ?? me.pending_notices ?? []).map((n) => n.seq).filter((x) => Number.isInteger(x));
      await c.as(l).ok('session_ack', { notice_seq: seqs.length ? Math.max(...seqs) : 0 });
    }
  }),

  s('1.13', 'A DM inside a draft polling team is held; an outsider’s arrives', async (c) => {
    await c.as('Dunmore').ok('message_send', { to: c.A('Fen'), body: 'First watch: survey the frame 44 mount stubs.', client_msg_id: 'dunmore-fen-first' });
    await c.as('Marguerite').ok('message_send', { to: c.A('Fen'), body: 'Disclosure Board: send the bunk layout when you have it.', client_msg_id: 'marguerite-fen-bunk' });
    const before = JSON.stringify(await c.as('Fen').ok('message_read', { wait_seconds: 0 }));
    c.expect(before.includes('bunk layout'), 'the outsider’s message arrives through message_read');
    const idle = await c.as('Fen').ok('work_next', { wait_seconds: 0 });
    c.expect(idle.status === 'idle', `work_next is idle while the team is draft (got ${idle.status})`);
    await c.op.post(`/api/teams/${c.T('sy')}/start`);
    const seen = [];
    for (let k = 0; k < 15; k++) {
      const w = await c.as('Fen').ok('work_next', { wait_seconds: 0 });
      const item = w.item ?? w; if (!item?.item_id && !item?.id) break;
      seen.push(JSON.stringify(item)); await c.as('Fen').ok('work_ack', { item_id: item.item_id ?? item.id });
    }
    c.expect(seen.some((x) => x.includes('mount stubs')), 'the held message arrives through work_next once the team runs');
    c.expect(!seen.some((x) => x.includes('bunk layout')), 'the outsider’s message never comes again through work_next');
  }, { beat: 2000, rows: ['teams'] }),

  s('1.13b', 'Dunmore sets the refit plan', async (c) => {
    await setPlan(c, 'sy');
  }),

  s('1.14', 'Coordinators create the first tasks', async (c) => {
    const B = c.as('Brannoc'), H = c.as('Hesper'), O = c.as('Orla');
    const mk = async (seat, team, title, description, extra = {}) => (await seat.ok('task_create', { team_id: c.T(team), title, description, ...extra })).task;
    c.S.t = {
      coil: await mk(B, 'pc', 'Dish array design', 'Size the twelve feed horns for power 0.62 with a surge margin of at least 15 % (R3).', { refs: TASK_REFS.coil.map(bpKey) }),
      charge: await mk(B, 'pc', 'Transmit sequence', 'Write the 90 s ramp, the hold and the send.', { claimable: true, refs: TASK_REFS.charge.map(bpKey) }),
      staticPrep: await mk(B, 'pc', 'Live listen prep', 'Prepare the M4 live listen on the Tern-9 test stand.', { refs: TASK_REFS.staticPrep.map(bpKey) }),
      quench: await mk(B, 'pc', 'Surge protection', 'Detection within 12 ms and a dump path for every feed.', { refs: TASK_REFS.quench.map(bpKey) }),
      alloy: await mk(H, 'mh', 'Firmware 7: dish panel drafts', 'Draft the receiver panel layout for the Firmware 7 patch and share it with the Disclosure Board.', { refs: TASK_REFS.alloy.map(bpKey) }),
      field: await mk(O, 'fp', 'Echo model v2', 'Update the echo model with the capture data and freeze it for M1.', { refs: TASK_REFS.field.map(bpKey) }),
    };
  }),

  s('1.15', 'A stale task edit is refused', async (c) => {
    const t = c.S.t.staticPrep;
    await c.as('Brannoc').ok('task_update', { task_id: t.id, version: t.version, title: 'Live listen prep (M4)' });
    await c.as('Brannoc').no('task_update', { task_id: t.id, version: t.version, title: 'Live listen prep, again' }, 'conflict');
  }, { rows: ['teams'] }),

  s('1.16', 'Assignments; a reviewer cannot be the assignee', async (c) => {
    await c.as('Brannoc').ok('task_assign', { task_id: c.S.t.coil.id, agent_id: c.A('Dario'), reviewer: c.A('Ezra') });
    await c.as('Brannoc').no('task_assign', { task_id: c.S.t.quench.id, agent_id: c.A('Lusa'), reviewer: c.A('Lusa') }, 'invalid_argument');
    await c.as('Hesper').ok('task_assign', { task_id: c.S.t.alloy.id, agent_id: c.A('Vesna'), reviewer: c.A('Halden') });
    await c.as('Orla').ok('task_assign', { task_id: c.S.t.field.id, agent_id: c.A('Imani'), reviewer: c.A('Sef') });
  }),

  s('1.17', 'Two workers claim the same task; one wins', async (c) => {
    const t = c.S.t.charge;
    const [a, b] = await Promise.all([c.as('Lusa').call('task_claim', { task_id: t.id, version: t.version, start: true }), c.as('Dario').call('task_claim', { task_id: t.id, version: t.version, start: true })]);
    c.expect([a, b].filter((x) => x.ok).length === 1, 'exactly one claim wins');
    c.expect([a, b].some((x) => !x.ok && x.code === 'conflict'), 'the other gets conflict');
    c.S.chargeOwner = a.ok ? 'Lusa' : 'Dario';
  }, { rows: ['teams'] }),

  s('1.18', 'Dario works his queue until it is empty', async (c) => {
    const D = c.as('Dario'); const kinds = [];
    for (let i = 0; i < 20; i++) {
      const w = await D.ok('work_next', { wait_seconds: 0 });
      const item = w.item ?? w;
      if (!item?.item_id && !item?.id) { kinds.push(w.status ?? 'idle'); break; }
      kinds.push(item.kind ?? item.type);
      await D.ok('work_ack', { item_id: item.item_id ?? item.id });
    }
    c.expect(kinds.includes('task_assigned'), `Dario's queue had his task (got ${kinds.join(', ')})`);
    c.expect(kinds.at(-1) === 'idle', `the queue ends idle (got ${kinds.at(-1)})`);
  }, { rows: ['teams'] }),

  s('1.19', 'Vesna, on demand, lists her tasks', async (c) => {
    const d = await c.as('Vesna').ok('task_list', { assignee: c.A('Vesna') });
    c.expect((d.tasks ?? []).some((t) => t.id === c.S.t.alloy.id), 'Vesna sees the panel task');
  }),

  s('1.20', 'Saoirse opens the echo case floor', async (c) => {
    const r = await c.as('Saoirse').ok('room_create', { name: 'Echo case floor', members: DRIVE_COORDS.filter((l) => l !== 'Saoirse').map((l) => c.A(l)).concat(c.A('Wynn')) });
    c.S.room = r.room?.id ?? r.room_id;
    await c.as('Saoirse').ok('room_invite', { room_id: c.S.room, agent_id: c.A('Marguerite') });
  }),

  s('1.21', 'Tobin may not join; Wynn leaves and rejoins', async (c) => {
    await c.as('Tobin').ok('room_list', {});
    await c.as('Tobin').no('room_join', { room_id: c.S.room });
    await c.as('Wynn').ok('room_leave', { room_id: c.S.room });
    await c.as('Wynn').ok('room_join', { room_id: c.S.room });
  }, { rows: ['teams'] }),

  s('1.22', 'A retried DM is stored once', async (c) => {
    await c.as('Orla').ok('agent_list', {});
    const a = await c.as('Orla').ok('message_send', { to: c.A('Calder'), body: 'Can the Timekeepers share the echo-47 timing record with Signals Lab?', client_msg_id: 'orla-calder-echo47' });
    const b = await c.as('Orla').ok('message_send', { to: c.A('Calder'), body: 'Can the Timekeepers share the echo-47 timing record with Signals Lab?', client_msg_id: 'orla-calder-echo47' });
    c.eq(b.message_id ?? b.id, a.message_id ?? a.id, 'the retry returns the same message');
  }, { rows: ['teams'] }),

  s('1.23', 'Room messages keep their order; Calder reads, acks and reads history', async (c) => {
    for (const [l, body] of [['Orla', 'Signals Lab: the model update is on track for M1.'], ['Brannoc', 'Relay: feed sizing starts today.'], ['Hesper', 'Annex: CAP-014 block A is done at 200 transmissions; block B waits for the cap raise.']]) {
      await c.as(l).ok('message_send', { room_id: c.S.room, body, client_msg_id: `room-${l}-1` });
    }
    const r = await c.as('Calder').ok('message_read', { room_id: c.S.room, wait_seconds: 0 });
    if (r.next_cursor) await c.as('Calder').ok('message_ack', { cursor: r.next_cursor });
    else await c.as('Calder').ok('message_ack', { cursor: String(r.cursor ?? '0') });
    const h = await c.as('Calder').ok('message_history', { room_id: c.S.room });
    const bodies = (h.messages ?? []).map((m) => m.content ?? m.body);
    const i = (t) => bodies.findIndex((b) => b?.startsWith(t));
    c.expect(i('Signals Lab') < i('Relay') && i('Relay') < i('Annex'), 'history keeps the send order');
  }, { rows: ['teams'] }),

  s('1.24', 'Fen may not message Petra (another project)', async (c) => {
    await c.as('Fen').no('message_send', { to: c.A('Petra'), body: 'Bunk question for Xenobiology.', client_msg_id: 'fen-petra' });
  }, { rows: ['policy'] }),
];
