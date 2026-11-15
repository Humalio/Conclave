// Team plans (docs/showcase.md, "Team plans"): what each coordinator sets in Act 1 and how the plot moves it in Acts 2–5,
// so every team's Objective screen tells the story. Case Command's case plan (R1–R12, M1–M7) is set in step 1.7;
// the other teams' keys carry the team's initials (SL, RE, AN, TK, XB, DB, TN, NC) so they never read as case requirements.
// Grounded in the vault notes each team owns. "Substrate" and the other REVEAL_TERMS (check-vault.mjs) appear only
// from Act 4 on, after the reveal in step 4.3; the eval-story test checks it.

import { TEAMS } from './cast.mjs';

export const day = 86400_000;

const req = (key, title, priority, milestones, criteria) => ({ key, title, priority, status: 'open', milestones, ...(criteria ? { criteria } : {}) });
const ms = (key, title, due) => ({ key, title, status: 'planned', due });

/** Act 1: each team's plan. due is days after the plans are set (the case's 3 June); Case Command uses the same scale. */
export const PLANS = {
  fp: { seat: 'Orla', requirements: [
    req('SL-R1', 'Echo model v2 validated against Tern-9 data over the whole transmit-power range', 'must', ['SL-M1', 'SL-M2'], 'Predicts Tern-9 behaviour within stated tolerance (case R2); supersedes Echo model v1.'),
    req('SL-R2', 'Echo 47 explained before the model is frozen', 'must', ['SL-M2'], 'The echo-47 power overshoot and early reply have a cause on file, not a label.'),
    req('SL-R3', 'Stability margin at operating power written down', 'should', ['SL-M3'], 'Sef’s stability analysis, method after Sato-Oyelaran.'),
    req('SL-R4', 'Echo decay profile delivered to Xenobiology and the Timekeepers', 'should', ['SL-M2']),
    req('SL-R5', 'Every signal result carries a capture ID', 'should', [], 'Case R11.'),
    req('SL-R6', 'Open questions closed or carried into the disclosure case', 'could', ['SL-M3']),
  ], milestones: [ms('SL-M1', 'Echo model v2 issued', 20), ms('SL-M2', 'Echo model frozen (case M1)', 28), ms('SL-M3', 'Stability analysis for the M2 dish review', 43)] },

  pc: { seat: 'Brannoc', requirements: [
    req('RE-R1', 'Dish surge margin at least 15 %', 'must', ['RE-M1'], 'Case R3, shown at 18 K against the receivers in use.'),
    req('RE-R2', 'Surge detected within 12 ms, with a dump path for every feed', 'must', ['RE-M2']),
    req('RE-R3', 'Silence within 200 ms of a shutdown command', 'must', ['RE-M3'], 'Case R9: the surge dump still brings the dish below the dish-house leak limit in time.'),
    req('RE-R4', 'Transmit sequence written: 90 s ramp, hold, send', 'should', ['RE-M3']),
    req('RE-R5', 'Power budget confirmed for the live listen', 'should', ['RE-M3']),
    req('RE-R6', 'Shielding interface agreed with The Annex', 'should', ['RE-M1']),
  ], milestones: [ms('RE-M1', 'Dish design review (case M2)', 43), ms('RE-M2', 'Surge protection tested', 90), ms('RE-M3', 'Live listen on the Tern-9 test stand (case M4)', 120)] },

  mh: { seat: 'Hesper', requirements: [
    req('AN-R1', 'The explanation holds over 600 transmissions at operating power', 'must', ['AN-M2'], 'Case R4, verified by CAP-014 with no firmware in the loop.'),
    req('AN-R2', 'Operating power fixed in writing', 'should', ['AN-M1'], 'R4 revision C left it undefined; CAP-014 sends transmissions 201–800 at power 0.33.'),
    req('AN-R3', 'Timestamp fault model checked against the CAP-014 log', 'should', ['AN-M2']),
    req('AN-R4', 'Dish panel drafts reviewed outside the team', 'must', ['AN-M1']),
    req('AN-R5', 'Dish mount loads at frame 41 during a send', 'should', ['AN-M3']),
    req('AN-R6', 'Pellam build lot B7-L07 patched (B-01)', 'must', ['AN-M2']),
  ], milestones: [ms('AN-M1', 'Firmware 7 explanation released', 20), ms('AN-M2', 'Explanation qualified (case M3)', 59), ms('AN-M3', 'Dish mount design handed to Tern-9', 40)] },

  nt: { seat: 'Calder', requirements: [
    req('TK-R1', 'Relay clocks stamp every send and receive within 4 ns', 'must', ['TK-M2'], 'Case R5; a timing error becomes a lead-time error.'),
    req('TK-R2', 'Lead-time error at most 5 ns', 'must', ['TK-M3'], 'Case R6, inside the pulsar-fix capture window.'),
    req('TK-R3', 'The echo-47 second timestamp explained', 'should', ['TK-M2']),
    req('TK-R4', '72 h holdover repeated with the new receiver coax', 'should', ['TK-M1']),
    req('TK-R5', 'Relay clock supply secured (B-02)', 'should', ['TK-M3']),
  ], milestones: [ms('TK-M1', 'Holdover repeat', 30), ms('TK-M2', 'Clock ready for the live listen (case M4)', 120), ms('TK-M3', 'Pulsar-fix procedure verified for the first deliberate reply', 250)] },

  cm: { seat: 'Ayo', requirements: [
    req('XB-R1', 'Keeper exposure at most 3 EH per live listen', 'must', ['XB-M2'], 'Case R7; Exposure limit, approved by the Disclosure Board 28 April.'),
    req('XB-R2', 'At most 9 EH in any 30 days, with the rest rule enforced', 'should', ['XB-M2']),
    req('XB-R3', 'Bunks meet the bunk shielding requirements in the keepers’ spec', 'should', ['XB-M3']),
    req('XB-R4', 'No uncharacterised biological material in the relay loop', 'must', ['XB-M3'], 'Case R12, verified by inspection at M5.'),
    req('XB-R5', 'Frost specimen F-3 kept sealed at 35 K in SC-1', 'must', [], 'Nobody opens the cell.'),
    req('XB-R6', 'The living-sensor ethics question answered by the Disclosure Board', 'should', []),
    req('XB-R7', 'Every exposure reported in echo-hours (EH)', 'should', []),
  ], milestones: [ms('XB-M1', 'All keepers screened', 60), ms('XB-M2', 'Dose model refitted with the volunteers', 90), ms('XB-M3', 'Bunks installed and inspected (case M5)', 196)] },

  sb: { seat: 'Marguerite', requirements: [
    req('DB-R1', 'Every disclosure-critical item independently reviewed', 'must', ['DB-M2'], 'Case R10; Independent review rules 1.1–2.2.'),
    req('DB-R2', 'No team approves its own work', 'must', ['DB-M2']),
    req('DB-R3', 'Every result in the disclosure case traceable to a capture ID', 'must', ['DB-M1'], 'Case R11.'),
    req('DB-R4', 'Hazard log current before each gate', 'should', ['DB-M1']),
    req('DB-R6', 'The living-sensor ethics question answered', 'could', ['DB-M2']),
  ], milestones: [ms('DB-M1', 'Disclosure case revision C reviewed', 30), ms('DB-M2', 'Disclosure order (case M6)', 243)] },

  sy: { seat: 'Dunmore', requirements: [
    req('TN-R1', 'Refit adds at most 6 % to station mass', 'must', ['TN-M4'], 'Case R8, by weighing, as built.'),
    req('TN-R2', 'The frame 44 mount is not cut before the live listen passes', 'must', ['TN-M2']),
    req('TN-R3', 'Bunks fitted to Xenobiology’s bunk shielding requirements', 'should', ['TN-M3']),
    req('TN-R4', 'Receiver shroud bonded in 24 segments once the explanation is qualified', 'must', ['TN-M3'], 'WP-06, held to case M3.'),
    req('TN-R5', 'A station-log entry for every work package', 'should', ['TN-M4'], 'WP-12.'),
  ], milestones: [ms('TN-M1', 'Mount stubs and doublers in (WP-03)', 68), ms('TN-M2', 'Frame 44 mount cut and insert (WP-03)', 127), ms('TN-M3', 'Shroud and bunks in (WP-06, WP-10)', 145), ms('TN-M4', 'Tern-9 refit complete (case M5)', 196)] },

  // Act 4: the Night Choir gets its plan when it is onboarded (step 4.21); its seat is the lab coordinator.
  lab: { seat: null, requirements: [
    req('NC-R1', '600 transmissions above power 0.32 captured on the Night Choir’s own dish, with no Authority rig', 'must', ['NC-M2'], 'Case R4, independently (CAP-015).'),
    req('NC-R2', 'Log checks at 100, 250, 400 and 600 transmissions', 'should', ['NC-M1', 'NC-M2']),
    req('NC-R3', 'Capture data shared with The Annex', 'should', ['NC-M1']),
    req('NC-R4', 'Every capture result carries CAP-015', 'should', []),
  ], milestones: [ms('NC-M1', 'Block A: 200 transmissions at power 0.25', 30), ms('NC-M2', 'Block B: 600 transmissions at power 0.33', 60)] },
};

/** Plan changes per act: [team, { requirements, milestones, remove }]. Items need only the fields that change. A requirement
    with `ask` is marked unclear with that question to the operator; one with `answer` has the operator answer it first. */
export const MOVES = {
  // Act 2, step 2.24: progress; Signals Lab cannot explain echo 47.
  2: [
    ['fp', { milestones: [{ key: 'SL-M1', status: 'reached', evidence: 'Echo model v2 written at power 0.33 (Imani, Teodor).' }],
      requirements: [{ key: 'SL-R2', status: 'unclear', ask: 'Echo 47 still sits off the curve. Can we freeze the echo model with echo 47 logged as unexplained, or must SL-R2 stay open until we find its cause?', evidence: 'Echo 47 is still off the curve; the Timekeepers sent the raw extract.' }] }],
    ['pc', { requirements: [{ key: 'RE-R4', status: 'met', evidence: 'Transmit sequence written and closed after review.' }], milestones: [{ key: 'RE-M1', status: 'in_progress' }] }],
    ['mh', { requirements: [{ key: 'AN-R4', status: 'met', evidence: 'Panel drafts reviewed by Halden and Hollis; version 2 shared.' }], milestones: [{ key: 'AN-M1', status: 'reached', evidence: 'Dish panel drafts approved.' }] }],
    ['nt', { requirements: [{ key: 'TK-R3', status: 'unclear', ask: 'Should the echo-47 second timestamp count as a clock fault on our side, or stay logged as a real second arrival until Signals Lab explains it?', evidence: 'Echo-47 recording sent to Signals Lab; no explanation yet.' }] }],
    ['cm', { requirements: [{ key: 'XB-R7', status: 'met', evidence: 'Petra’s echo-hour rule reviewed by the operator.' }] }],
    ['sy', { milestones: [{ key: 'TN-M1', status: 'in_progress', detail: 'Tower survey done; stubs wait for the forgings.' }] }],
  ],
  // Act 3, step 3.11b: CAP-014 heard the echo with no firmware. Firmware 7 falls, M3 is missed, the live listen is at risk.
  3: [
    ['mh', { requirements: [{ key: 'AN-R1', status: 'unclear', ask: 'CAP-014 heard the echo 0.71 s early with no firmware in the loop. Does AN-R1 still mean the firmware explanation, or any explanation that holds over 600 transmissions?', evidence: 'CAP-014: the echo arrived 0.71 s early on 600 of 600 transmissions with no firmware in the loop.' }, { key: 'AN-R6', status: 'unclear', ask: 'A patch to build 7 cannot fix an echo that arrives without it. Should we still patch lot B7-L07 for B-01, or drop AN-R6?', evidence: 'A patch to build 7 cannot fix an echo that arrives without it (B-01).' }],
      milestones: [{ key: 'AN-M2', status: 'missed', evidence: 'CAP-014 read out at transmission 800: no firmware, still an echo.' }] }],
    ['pc', { requirements: [{ key: 'RE-R2', status: 'unclear', ask: 'Surge protection is blocked by B-01. Should we build the 12 ms surge detection without the firmware patch, or wait for your call on B-01?', evidence: 'Surge protection blocked by B-01.' }],
      milestones: [{ key: 'RE-M3', status: 'missed', evidence: 'Live listen prep cancelled: the explanation is not qualified.' }] }],
    ['int', { requirements: [{ key: 'R4', status: 'unclear', ask: 'CAP-014 heard the echo with the firmware removed. Do we keep the Firmware 7 patch as our explanation, or move R4 to Q-9 and CAP-015 instead?', evidence: 'CAP-014 heard the echo with firmware removed; Firmware 7 patch or Q-9 waits for the operator.' }],
      milestones: [{ key: 'M3', status: 'missed', evidence: 'CAP-014 read out at transmission 800.' }, { key: 'M4', detail: 'At risk: no live listen on an unexplained echo.' }] }],
    ['sy', { milestones: [{ key: 'TN-M2', detail: 'At risk: frame 44 waits for a live listen that is cancelled.' }, { key: 'TN-M3', detail: 'At risk: WP-06 is held to M3, now missed.' }] }],
    ['nt', { milestones: [{ key: 'TK-M2', detail: 'At risk: the live listen it serves is cancelled.' }] }],
  ],
  // Act 4, step 4.9b: the receivers go to Q-9 and the answer is on file.
  4: [
    ['mh', { requirements: [{ key: 'AN-R1', status: 'open', answer: 'Any explanation that holds over 600 transmissions. Keep AN-R1, and verify it on the Q-9 receivers with CAP-015.', criteria: 'Case R4, verified by CAP-015 on Q-9 receivers.', evidence: 'Receivers switched to Q-9 (decision of 2 June).' },
      { key: 'AN-R6', status: 'dropped', answer: 'Drop it. Firmware 7 is withdrawn and the receivers go to Q-9, so there is nothing left to patch.', evidence: 'Firmware 7 withdrawn; no patch.' },
      { key: 'AN-R7', title: 'Q-9 receivers have no front end in the 2.3 GHz ring band', priority: 'must', status: 'met', milestones: ['AN-M2'], evidence: 'Firmware 7 file updated by Vesna.' }],
      milestones: [{ key: 'AN-M2', title: 'Explanation qualified on Q-9 (case M3)', status: 'planned', due: 120, evidence: '' }] }],
    ['pc', { requirements: [{ key: 'RE-R1', status: 'met', evidence: 'Surge margin 16.7 % at 18 K with Q-9 (Ezra approved).' }, { key: 'RE-R2', status: 'open', answer: 'Build the 12 ms detection now, for the Q-9 receivers. It no longer waits on B-01.', evidence: '' }],
      milestones: [{ key: 'RE-M1', status: 'reached', evidence: 'Dish redesign for Q-9 accepted.' }, { key: 'RE-M3', status: 'planned', due: 160, evidence: '', detail: 'Live listen on Q-9 after CAP-015 block A.' }] }],
    ['int', { requirements: [{ key: 'R4', status: 'open', answer: 'Move R4 to Q-9 and CAP-015. The Firmware 7 patch is no longer our explanation.', evidence: 'Q-9 chosen; CAP-015 runs at the Night Choir.' },
      { key: 'R13', title: 'The answer (H-13) held off the receivers before the first deliberate reply', priority: 'must', status: 'open', milestones: ['M4', 'M6'], criteria: 'Disclosure case §9; the live listen shows no 2.3 GHz ring on Q-9.' }],
      milestones: [{ key: 'M3', status: 'planned', due: 120, evidence: '', detail: 'Re-planned on Q-9.' }, { key: 'M4', due: 160, detail: 'After CAP-015 block A.' }] }],
    ['sb', { requirements: [{ key: 'DB-R5', title: 'The answer, hazard H-13, bounded in the disclosure case', priority: 'must', status: 'open', milestones: ['DB-M2'], criteria: 'Disclosure case §9 states cause, controls and the verifying capture.' }] }],
    ['fp', { requirements: [{ key: 'SL-R2', status: 'met', answer: 'Echo 47 has its cause now, in Disclosure case §9. Record it there and close SL-R2.', evidence: 'Explained in Disclosure case §9 (the answer), from the director’s account of echo 47.' }] }],
    ['nt', { requirements: [{ key: 'TK-R3', status: 'met', answer: 'Log it as a real second arrival. Disclosure case §9 explains it: the answer leads the send by 0.71 s.', evidence: 'Explained in Disclosure case §9: the answer leads the send by 0.71 s.' }], milestones: [{ key: 'TK-M2', due: 160, detail: 'Follows the live listen on Q-9.' }] }],
    ['sy', { requirements: [{ key: 'TN-R4', title: 'Q-9 receiver shroud bonded in 24 segments once the explanation is qualified' }], milestones: [{ key: 'TN-M2', due: 167, detail: 'Moved with the live listen.' }, { key: 'TN-M3', due: 185, detail: 'Shroud segments wait for Q-9 qualification.' }] }],
  ],
  // Act 5, step 5.7: disclosure. Conditions recorded where they bind.
  5: [
    ['sb', { requirements: [{ key: 'DB-R1', status: 'met', evidence: 'Independent review by Hollis and Ezra.' }, { key: 'DB-R2', status: 'met', evidence: 'Review by people who did not design or capture it.' },
      { key: 'DB-R3', status: 'met', evidence: 'Every cited result has a capture ID.' }, { key: 'DB-R5', status: 'met', evidence: '§9 accepted; order condition 2 keeps H-13 open until the live listen.' },
      { key: 'DB-R6', status: 'open', evidence: 'Order condition 3 waits on the ethics review.' }],
      milestones: [{ key: 'DB-M1', status: 'reached' }, { key: 'DB-M2', status: 'reached', evidence: 'Disclosure order issued with three conditions.' }] }],
    ['cm', { requirements: [{ key: 'XB-R5', status: 'met', evidence: 'Order condition 3: no frost in the relay loop until the ethics review closes; F-3 sealed in SC-1.' },
      { key: 'XB-R4', evidence: 'Order condition 3 recorded; inspection at M5.' }] }],
    ['mh', { requirements: [{ key: 'AN-R1', evidence: 'Approved on Q-9; power above 0.30 waits for CAP-015 block B (condition 1).' }] }],
    ['pc', { milestones: [{ key: 'RE-M3', status: 'in_progress', detail: 'Approved for the live listen; condition 2 needs Q-9 quiet through the ring.' }] }],
    ['fp', { requirements: [{ key: 'SL-R1', status: 'met', evidence: 'Validated to power 0.33, the range the order allows (condition 1).' }], milestones: [{ key: 'SL-M2', status: 'reached' }] }],
    ['int', { requirements: [{ key: 'R13', evidence: 'Order condition 2: H-13 stays open until the live listen shows Q-9 quiet through the 2.3 GHz ring.' }] }],
    ['lab', { requirements: [{ key: 'NC-R3', status: 'met', evidence: 'Capture data promoted into the vault by Hesper.' }], milestones: [{ key: 'NC-M1', status: 'in_progress', detail: 'Block B gates power above 0.30 (order condition 1).' }] }],
  ],
};

/** The task refs the story gives (task key in c.S.t → plan keys). */
export const TASK_REFS = {
  coil: ['RE-R1', 'RE-M1'], charge: ['RE-R4'], staticPrep: ['RE-M3'], quench: ['RE-R2', 'RE-M2'], alloy: ['AN-R4', 'AN-M1'], field: ['SL-R1', 'SL-M2'],
};

const SEATS = Object.fromEntries(Object.entries(PLANS).map(([k, p]) => [k, p.seat]));

/**
 * The story writes its plans in the project blueprint (docs/blueprint.md §2.2, §5). Plan keys keep their story names
 * here and map to blueprint keys: a requirement SL-R3 is FR-SL-03 (Case Command's R3 is FR-CC-03) under the team's
 * module (SL, CC), a milestone SL-M2 is M2 in the team's own project.
 */
export const bpKey = (key) => {
  let m = /^(?:([A-Z]{2,6})-)?R(\d+)$/.exec(key);
  if (m) return `FR-${m[1] ?? 'CC'}-${m[2].padStart(2, '0')}`;
  m = /^(?:[A-Z]{2,6}-)?M(\d+)$/.exec(key);
  return m ? `M${m[1]}` : key;
};
/** The team's module: Case Command's is CC, every other team's carries the initials of its plan keys. */
const moduleOf = (team) => (team === 'int' ? 'CC' : PLANS[team].requirements[0].key.split('-')[0]);
const FR_STATUS = { open: 'draft', unclear: 'draft', met: 'verified', dropped: 'dropped' };
const opt = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const nul = (v) => (v === '' ? null : v);

/** Blueprint ops for plan items in the story's shape (only the fields given change). */
function toOps(team, teamId, { requirements = [], milestones = [] }, t0, fresh, asks = {}) {
  const items = [], links = [], mod = moduleOf(team);
  if (fresh) items.push({ op: 'upsert', kind: 'module', key: mod, title: TEAMS.find((t) => t.key === team)?.name ?? 'Night Choir Capture', team_id: teamId });
  for (const i of milestones) {
    items.push(opt({ op: 'upsert', kind: 'milestone', key: bpKey(i.key), title: i.title, body: i.detail, status: i.status, team_id: teamId,
      fields: opt({ target_at: i.due !== undefined ? t0 + i.due * day : undefined, exit: i.criteria, evidence: nul(i.evidence) }) }));
  }
  for (const i of requirements) {
    const k = bpKey(i.key);
    const fields = opt({ priority: i.priority, evidence: nul(i.evidence), unclear: i.status === undefined ? undefined : i.status === 'unclear' ? (asks[k] ? true : undefined) : null, unclear_ask: asks[k] });
    items.push(opt({ op: 'upsert', kind: 'fr', key: k, parent_key: fresh || i.title ? mod : undefined, title: i.title, body: i.detail, status: i.status && FR_STATUS[i.status], fields }));
    if (i.criteria) items.push({ op: 'upsert', kind: 'ac', key: `${k}/AC1`, parent_key: k, title: 'Acceptance', fields: { then: i.criteria } });
    for (const m of i.milestones ?? []) links.push({ op: 'link', from: bpKey(m), to: k, rel: 'delivers' });
  }
  return [...items, ...links];
}

/**
 * The coordinator writes the plan with bp_write; what needs the operator (a new module, new milestones, agreeing a
 * requirement) comes back as a proposal, which the operator applies at once.
 */
export async function writePlan(c, team, seat, plan, { fresh = false, reason } = {}) {
  const teamId = c.T(team), A = c.as(seat);
  c.S.planT0 ??= Date.now();
  // An unclear mark is one question to the operator that names the requirement, so the requirement is written first, then asked about, then marked.
  const unclear = (plan.requirements ?? []).filter((r) => r.status === 'unclear');
  // A mark the plan now settles is cleared the way the operator does it: Clarify answers the team's question, and the hub clears the mark.
  for (const r of (plan.requirements ?? []).filter((x) => x.answer)) {
    const id = c.S.unclearAsks?.[bpKey(r.key)];
    if (!id) throw new Error(`${bpKey(r.key)} has no question to answer`);
    await c.op.post(`/api/decisions/${id}/answer`, { text: r.answer });
    delete c.S.unclearAsks[bpKey(r.key)];
  }
  const ops = toOps(team, teamId, plan, c.S.planT0, fresh);
  let version = (await A.ok('bp_read', { team_id: teamId, kinds: ['module'] })).project.version;
  for (let i = 0; i < ops.length; i += 40) {
    const w = await A.ok('bp_write', { team_id: teamId, version, ops: ops.slice(i, i + 40), ...(reason ? { reason } : {}) });
    version = w.status === 'proposed' ? (await c.op.post(`/api/proposals/${w.proposal_id}/apply`, {})).version : w.version;
  }
  if (unclear.length) {
    const asks = {};
    for (const r of unclear) asks[bpKey(r.key)] = (await A.ok('team_ask', { team_id: teamId, question: r.ask ?? `What is unclear in ${bpKey(r.key)}?`, ...(r.evidence ? { context: r.evidence } : {}), refs: [bpKey(r.key)] })).decision_id;
    c.S.unclearAsks = { ...c.S.unclearAsks, ...asks };
    const marks = toOps(team, teamId, { requirements: unclear.map((r) => ({ key: r.key, status: 'unclear' })) }, c.S.planT0, false, asks);
    version = (await A.ok('bp_read', { team_id: teamId, kinds: ['module'] })).project.version;
    await A.ok('bp_write', { team_id: teamId, version, ops: marks });
  }
  return A.ok('bp_read', { team_id: teamId, kinds: ['fr', 'milestone'] });
}

/** Set a team's Act 1 plan (seat: the coordinator; the lab passes its own). */
export async function setPlan(c, team, seat = SEATS[team]) {
  const p = PLANS[team];
  return writePlan(c, team, seat, p, { fresh: true, reason: 'The team plan.' });
}

/** Apply one act's plan changes, each by its team's coordinator. */
export async function movePlans(c, act) {
  for (const [team, m] of MOVES[act]) {
    const seat = team === 'int' ? 'Saoirse' : team === 'lab' ? c.S.labAgents[0] : SEATS[team];
    await writePlan(c, team, seat, m, { reason: `Act ${act}.` });
  }
}
