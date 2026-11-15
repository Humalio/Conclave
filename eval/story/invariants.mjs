import { REVEAL_TERMS } from './check-vault.mjs';
import { bpKey } from './plans.mjs';

// Invariants checked through the admin API after each act (docs/showcase.md §6): the state the next act builds on.
const teams = async (c) => Object.fromEntries(((await c.op.get('/api/teams')).teams ?? []).map((t) => [t.name, t.status]));
const tasksOf = async (c, key) => ((await c.op.get(`/api/teams/${c.T(key)}`)).team?.board ?? []);
/** Every team's plan and plan history (docs/showcase.md, "Team plans"). */
const plans = async (c) => {
  const out = {};
  for (const t of (await c.op.get('/api/teams')).teams ?? []) { const d = (await c.op.get(`/api/teams/${t.id}`)).team; out[t.name] = { plan: d?.plan, events: d?.plan_events ?? [] }; }
  return out;
};
const item = (p, key) => [...(p?.requirements ?? []), ...(p?.milestones ?? [])].find((i) => i.key === bpKey(key)); // story plan keys (SL-R2) name blueprint keys (FR-SL-02)
/** Before the reveal (step 4.3) no plan may name what Classified holds (check-vault.mjs REVEAL_TERMS). */
const noReveal = (c, all) => {
  for (const [name, { plan }] of Object.entries(all)) {
    const text = JSON.stringify(plan ?? {}).toLowerCase();
    for (const term of REVEAL_TERMS) c.expect(!text.includes(term), `${name}'s plan does not mention "${term}" before Act 4`);
  }
};

export default {
  0: async (c) => {
    const t = await teams(c);
    c.eq(Object.keys(t).length, 8, 'eight teams');
    c.eq(Object.values(t).filter((s) => s === 'running').length, 7, 'seven running');
    c.eq(((await c.op.get('/api/agents')).agents ?? []).length, 29, 'twenty-nine agents');
  },
  1: async (c) => {
    const t = await teams(c);
    c.expect(Object.values(t).every((s) => s === 'running'), 'every team runs after kickoff');
    c.expect((await tasksOf(c, 'pc')).length >= 4, 'Relay Engineering has its four tasks');
    const all = await plans(c);
    for (const [name, { plan }] of Object.entries(all)) {
      c.expect((plan?.requirements ?? []).length >= 4 && (plan?.milestones ?? []).length >= 2, `${name} has a plan with requirements and milestones`);
      c.expect((plan?.requirements ?? []).every((r) => r.priority && (r.links ?? []).every((k) => item(plan, k))), `${name}'s requirements have a priority and link only its own milestones`);
    }
    c.expect((await tasksOf(c, 'pc')).some((k) => (k.refs ?? []).includes(bpKey('RE-R1'))), 'the dish task serves RE-R1 (FR-RE-01)');
    noReveal(c, all);
  },
  2: async (c) => {
    const alloy = (await tasksOf(c, 'mh')).find((k) => k.id === c.S.t.alloy.id);
    c.eq(alloy?.status, 'done', 'the panel task is done');
    const fb = (await c.op.get('/api/feedback')).reports ?? [];
    c.expect(fb.some((r) => r.id === c.S.report && r.status === 'accepted'), 'the patch report is accepted');
    const all = await plans(c);
    c.eq(item(all['Signals Lab'].plan, 'SL-R2')?.status, 'unclear', 'echo 47 leaves SL-R2 unclear');
    c.eq(item(all['The Annex'].plan, 'AN-R4')?.status, 'met', 'the panel review meets AN-R4');
    noReveal(c, all);
  },
  3: async (c) => {
    c.expect(((await c.op.get('/api/requests')).requests ?? []).some((r) => r.id === c.S.accessReq && r.status === 'pending'), 'Vesna\'s request is pending');
    const flags = (await c.op.get('/api/graph/flags')).flags ?? [];
    c.expect(flags.filter((f) => f.status === 'open').length >= 4, 'four open stale flags');
    const board = await tasksOf(c, 'pc');
    c.eq(board.find((k) => k.id === c.S.t.staticPrep.id)?.status, 'cancelled', 'live listen prep is cancelled');
    const all = await plans(c);
    const mh = all['The Annex'];
    c.eq(item(mh.plan, 'AN-R1')?.status, 'unclear', 'CAP-014 leaves AN-R1 unclear');
    c.eq(item(mh.plan, 'AN-M2')?.status, 'missed', 'the explanation qualification is missed');
    c.expect(mh.plan?.requested_at && mh.events.some((e) => e.kind === 'review_request'), 'the operator asked The Annex to re-plan');
    c.eq(item(all['Relay Engineering'].plan, 'RE-M3')?.status, 'missed', 'the live listen milestone is missed');
    noReveal(c, all);
  },
  4: async (c) => {
    c.eq((await c.op.get('/api/lockdown')).writes_disabled, false, 'lockdown is off');
    const t = await teams(c);
    c.eq(t['Night Choir Capture'], 'running', 'the lab team runs');
    c.expect(((await c.op.get('/api/recruits')).requests ?? []).some((r) => r.status === 'pending'), 'the recruit waits');
    const all = await plans(c);
    c.expect((all['Night Choir Capture']?.plan?.requirements ?? []).length >= 4, 'the lab has its plan');
    c.eq(item(all['The Annex'].plan, 'AN-R6')?.status, 'dropped', 'the Firmware 7 patch is dropped for Q-9');
    // Clarify answered the act 2 and 3 questions as each mark was settled: only R2's question still waits, as one unclear row.
    c.eq(Object.keys(c.S.unclearAsks ?? {}).join(), 'FR-CC-02', 'every unclear question but R2 is answered');
    const un = ((await c.op.get('/api/needs-you?limit=200')).items ?? []).filter((r) => r.kind === 'unclear');
    c.eq(un.map((r) => `${r.item?.key}:${r.ask ? 'ask' : 'no ask'}`).join(), 'FR-CC-02:ask', 'Needs you holds one unclear row, R2 with its question');
    c.expect(!all['The Annex'].plan?.requested_at, 'the re-plan answered the operator’s request');
    c.expect(item(all['Case Command'].plan, 'R13') && item(all['Disclosure Board'].plan, 'DB-R5'), 'the answer is a requirement after the reveal');
  },
  5: async (c) => {
    const t = await teams(c);
    c.eq(t['Signals Lab'], 'done', 'Signals Lab is done');
    c.eq(t['Disclosure Board'], 'done', 'the Disclosure Board is done');
    for (const n of ['Relay Engineering', 'The Annex', 'Timekeepers', 'Xenobiology', 'Case Command', 'Tern-9 Keepers', 'Night Choir Capture']) c.eq(t[n], 'running', `${n} still runs`);
    const all = await plans(c);
    for (const [name, { events }] of Object.entries(all)) c.expect(events.filter((e) => e.kind === 'update').length >= 2, `${name}'s plan changed at least once after it was set`);
    c.eq(item(all['Disclosure Board'].plan, 'DB-M2')?.status, 'reached', 'the disclosure order milestone is reached');
    c.expect(/no frost in the relay loop/.test(item(all.Xenobiology.plan, 'XB-R5')?.evidence ?? ''), 'the frost condition is recorded');
  },
};
