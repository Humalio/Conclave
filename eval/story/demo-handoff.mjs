// The operator's live handoff after Disclosure. Keep these scenes out of the scripted coverage run.
import { randomBytes } from 'node:crypto';
import { V } from './cast.mjs';
import { Admin } from './lib.mjs';

async function prepareBlueprint(c, team) {
  const { project_id: project } = (await c.op.get(`/api/teams/${team}`)).team;
  const path = `/api/projects/${project}`;
  const { project: { version }, items } = await c.as('Saoirse').ok('bp_read', { team_id: team, kinds: ['paper', 'line'] });
  const paper = items.find((i) => i.kind === 'paper' && i.title === 'An echo model for the dish')?.key;
  c.expect(paper, 'the paper framed in Act 2 exists');
  const line = 'L9', clock = 'H-L9-01', frost = 'H-L9-02';
  const ops = [
    { op: 'upsert', kind: 'summary', key: 'SUM', title: 'The Early Echo',
      fields: { vision: 'Make the first deliberate reply safe and independently verifiable.', objective: 'Close the known receiver risks before CAP-015 block B.', value: 'An incident record the next keeper can reconstruct from first principles.' },
      body: [
        'The relay at Tern-9 put a reply on screen while the send was still on hold. The team kept three independent records: the clock trace, the receiver log and the notes from the cold face. On the night of Echo 47, none of the three told quite the same story.',
        'The operator can now clear a watch plan, decide who reads the sealed evidence and see what is still holding up the work. The Disclosure Board has approved a partial account with three conditions. The receiver can listen. Block B still governs any transmission.',
        '**What changed**\n\nRelay Engineering switched to Q-9 after the air-gapped test. Timekeepers kept the original stamps for comparison, and the board kept frost out of the relay loop.',
        '**What is open**\n\nThe latest station log contains a reply with a future send stamp. The team needs a watch decision and an independent record before it can interpret another reply.',
        '## Records\n\n- [[Case board]]\n- [[Station log]]\n- [[CAP-015 Independent capture]]',
      ].join('\n\n') },
    { op: 'upsert', kind: 'line', key: line, team_id: team, title: 'Separate the clock from the receiver',
      fields: { mode: 'validate', question: 'Can relay timing alone explain the measured lead?' } },
    { op: 'upsert', kind: 'question', key: 'Q-L9-01', parent_key: line, title: 'Will two clocks agree on the next reply?',
      fields: { criteria: 'Each witness records an independent receive stamp and clock reference.' } },
    { op: 'upsert', kind: 'hypothesis', key: clock, parent_key: line, status: 'confirmed', title: 'The clock error is too small to account for the lead',
      fields: { criteria: 'A holdover measurement remains well below 0.71 seconds.', evidence: `${V}/Timekeepers/Holdover test.md` } },
    { op: 'upsert', kind: 'hypothesis', key: frost, parent_key: line, status: 'inconclusive', title: 'The frost predicts a reply in a fresh capture',
      fields: { criteria: 'A blind observer calls the tick before the receive log updates.', evidence: `${V}/Xenobiology/Frost feeding log.md` } },
    { op: 'upsert', kind: 'finding', key: 'F-L9-01', parent_key: line, title: 'Holdover stayed below 0.3 ns',
      fields: { confidence: 'high', evidence: `${V}/Timekeepers/Holdover test.md` } },
    { op: 'upsert', kind: 'decision', key: 'ADR-*', status: 'accepted', title: 'Listen on Q-9 for CAP-015',
      fields: { context: 'CAP-014 logged an early reply with no firmware in the loop.', chosen: 'Switch to Q-9.', consequences: 'Resize the rack and repeat the surge-margin check.' } },
    { op: 'upsert', kind: 'milestone', key: 'M1', status: 'reached', fields: { evidence: 'Signals Lab delivered Echo model v2.' } },
    { op: 'upsert', kind: 'paper', key: paper, status: 'drafting', fields: { manuscript: `${V}/Signals Lab/Echo model v2.md` } },
    { op: 'upsert', kind: 'claim', key: `${paper}/C2`, parent_key: paper, title: 'Clock error alone cannot explain Echo 47', fields: { part: 'results' } },
    { op: 'link', from: 'F-L9-01', to: clock, rel: 'evidence' },
    { op: 'link', from: clock, to: `${paper}/C2`, rel: 'evidence' },
    ...['M1', 'M6'].map((from) => ({ op: 'link', from, to: paper, rel: 'delivers' })),
    ...[clock, frost].map((to) => ({ op: 'link', from: paper, to, rel: 'studies' })),
  ];
  await c.op.post(`${path}/ops`, { version, ops });
  return project;
}

async function prepareTasks(c, team) {
  const lead = c.as('Saoirse'), worker = c.as('Wynn'), reviewer = c.as('Hollis');
  const make = async (title, description) => (await lead.ok('task_create', { team_id: team, title, description, reviewer: c.A('Hollis') })).task;
  const assign = async (task) => (await lead.ok('task_assign', { task_id: task.id, agent_id: c.A('Wynn'), reviewer: c.A('Hollis') })).task;
  await make('Find the original holdover strip', 'Leave the original strip in the station archive and cite its shelf in the case notes.');
  await assign(await make('Index the receiver timestamps', 'Record the first and second stamps separately. Preserve the original time bases.'));
  const draw = await assign(await make('Draw the receive-only watch handoff', 'Give each witness a separate copy of the recording notes.'));
  await worker.ok('task_start', { task_id: draw.id });
  const hold = await assign(await make('Open the watch roster', 'Assign two observers once Station Operations releases the overnight rota.'));
  await lead.ok('task_block', { task_id: hold.id, reason: 'Station Operations has not released the overnight rota.' });
  for (const [title, summary, decision, comments] of [
    ['Cross-check the receive log', 'The receiver and keeper stamps are indexed against the March recording. I preserved the raw time bases and the missing intercom interval. The second timestamp is copied into the review notes beside the cold-face observation. A later reader can follow each entry back to the original log without sharing the sealed pages.', null],
    ['Review the witness sheet', 'The sheet records time to the nearest millisecond.', 'request_changes', 'Add the clock source and uncertainty beside each observed stamp.'],
    ['Check the watch handoff', 'The written handoff leaves the send queue empty and names who stops the receivers.', 'approve', 'The transmission hold and stop conditions are both clear.'],
  ]) {
    const task = await assign(await make(title, 'Prepare a reviewable record for the next shift at Tern-9.'));
    await worker.ok('task_start', { task_id: task.id });
    const sub = (await worker.ok('task_submit', { task_id: task.id, summary })).task;
    if (decision) await reviewer.ok('task_review', { task_id: task.id, version: sub.version, decision, comments });
  }
}

async function prepareCollaborator(c, project, team) {
  const username = 'echo-guest';
  const { user, password } = await c.op.post('/api/users', { username, display_name: 'Ellis Vale', org: 'Corvel Station' });
  await c.op.put(`/api/users/${user.id}/grants`, { grants: [{ project_id: project, components: ['tasks', 'feed', 'messages', 'topology'] }] });
  await c.op.put(`/api/users/${user.id}/folder-grants`, { grants: ['Case Command', 'Captures'].map((folder) => ({ path: `/${folder}/`, mode: 'read' })) });
  const guest = new Admin(c.hub.base, c.rec);
  await guest.login(username, password);
  try {
    // Complete the first-sign-in gate without publishing a password. The operator can reset it from Users.
    await guest.post('/api/me/password', { current: password, new: randomBytes(24).toString('base64url') });
    c.expect((await guest.get(`/api/teams/${team}`)).team.board.length > 0, 'the collaborator sees the Case Command board');
    c.expect((await guest.get('/api/topology')).teams.some((t) => t.id === team && t.agents.length > 0), 'the collaborator has project topology');
    c.expect((await guest.get(`/api/vault/preview?path=${encodeURIComponent(`${V}/Case Command/Case board.md`)}`)).preview?.content.includes('# Case board'), 'the collaborator reads the granted case board');
  } finally {
    await guest.post('/api/logout', {});
  }
}

async function prepareKeyHandover(c) {
  const label = 'Watch Console', name = 'pc-watch-console';
  const pc = (await c.op.post('/api/pcs', { name, description: 'Fictional standby console for the Tern-9 watch.' })).pc;
  const app = await c.op.post('/api/keys', { kind: 'app_key', machine_id: pc.id, app_name: 'codex', label: 'Codex on the watch console' });
  const session = await c.op.post('/api/keys', { kind: 'session_key', new_agent: { label }, label: 'Watch console session' });
  await c.op.put(`/api/keys/${session.key.id}/binding`, { machine_id: pc.id });
  c.pcs.watch = { pc, appKey: app.secret };
  c.seatPc[label] = 'watch';
  c.keys[label] = { id: session.key.id, secret: session.secret };
  await c.connectPc('watch');
  await c.login(label);

  // A routine rotation goes to the watch console by key handover: its connector checks in, picks the new key up once the
  // PC user allowed it on the screen, and confirms. The old key works until the confirm.
  await c.ob.ok('POST', '/connector/v1/check-in', app.secret, { version: '0.9.6' });
  const { key, handover } = await c.op.post(`/api/keys/${session.key.id}/rotate`, { reason: 'routine' });
  c.expect(handover?.pc?.id === pc.id, 'the rotation is sent to the watch console');
  const pickup = await c.ob.ok('POST', '/pickup', app.secret, { request_id: handover.id });
  await c.ob.ok('POST', '/pickup/confirm', app.secret, { pickup_id: pickup.pickup_id, written: pickup.agents.map((a) => a.session_var) });
  c.keys[label] = { id: key.id, secret: pickup.agents[0].secret };
  await c.login(label);
  const status = await c.op.get(`/api/keys/${key.id}/handover`);
  c.expect(status.confirmed?.key, 'the watch console confirmed the handover');
}

export async function seedDemoHandoff(c, setAside) {
  const team = c.T('int'), lead = c.as('Saoirse');
  c.rec.begin('demo.blueprint', 'Prepare the watch plan and its evidence');
  const project = await prepareBlueprint(c, team);
  c.signal?.throwIfAborted();
  c.rec.begin('demo.tasks', 'Prepare the watch tasks and review rounds');
  await prepareTasks(c, team);
  c.signal?.throwIfAborted();
  c.rec.begin('demo.collaborator', 'Give Ellis access to the case');
  await prepareCollaborator(c, project, team);
  c.signal?.throwIfAborted();
  c.rec.begin('demo.handover', 'Send the watch console its replacement key');
  await prepareKeyHandover(c);
  c.signal?.throwIfAborted();

  c.rec.begin('demo.handoff', 'Leave the live questions, clearance and pause');
  await lead.ok('team_ask', {
    team_id: team, question: 'Who should be listening at 22:14 on 9 June?',
    context: 'Check the last entry in the Tern-9 station log. A reply arrived on 6 June and the send queue is empty. Keep CAP-015 block B and its transmission hold in place either way.',
    options: [
      { key: 'asplan', label: 'Keep the scheduled watch', effect: 'Follow the current plan and avoid changing the conditions. If another reply comes in unattended, we have only the automatic log.' },
      { key: 'listen', label: 'Staff a receive-only watch', effect: 'Put two witnesses on the quiet receiver at 22:14 and compare their independent timestamps. Keep the send queue empty.' },
    ],
  });
  const { decision_id } = await lead.ok('team_ask', { team_id: team, question: 'Which archive gets the duplicate clock strips?',
    context: 'The strips can wait until the observers have signed the log.',
    options: [{ key: 'station', label: 'Station archive' }, { key: 'case', label: 'Case Command archive' }] });
  const needs = await c.op.get(`/api/needs-you?team=${team}&limit=200`);
  const row = needs.items.find((item) => item.id === `question:${decision_id}`);
  c.expect(row, 'the archive question is ready to move to Later');
  const later = { record: row.id, episode: row.source.version, kind: 'later' };
  if (setAside) await setAside(later);
  else await c.op.post('/api/needs-you/dismiss', later);
  await c.as('Petra').ok('access_request', { actions: ['fs.read'], resource: `path:${V}/Classified/Vendor/**`,
    reason: 'Before the watch, compare the vendor trace with the cold-face log. The receiver comparison is under review.', duration: '30m' });
  await c.as('Ayo').ok('team_pause', { team_id: c.T('cm'), reason: 'Wait for the specimen chest to settle at 35 K.', until: Date.now() + 3 * 60 * 60_000 });
  await c.op.post('/api/lockdown', { scope: 'pc', id: c.pcs.yard.pc.id, on: true });
}
