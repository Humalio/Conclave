// The cast (docs/showcase.md §3): PCs, projects, teams, agents, grants and directives, as data.
export const V = '/vault';
export const PROJECTS = { drive: 'The Echo Case', cert: 'Halcyon Oversight' };

export const PCS = [
  { key: 'ops', name: 'pc-ops', description: 'Case office on Corvel Station: Case Command and the Disclosure Board', bound: true },
  { key: 'east', name: 'pc-lab-east', description: 'Corvel lab east: Signals Lab and Relay Engineering', bound: true },
  { key: 'west', name: 'pc-lab-west', description: 'Corvel basement: The Annex, Timekeepers, Xenobiology', bound: false },
  { key: 'yard', name: 'pc-tern9', description: 'Relay Tern-9, eleven light-hours out: Tern-9 Keepers', bound: true },
];

const F = {
  programme: 'Case Command', physics: 'Signals Lab', power: 'Relay Engineering', materials: 'The Annex', nav: 'Timekeepers',
  safety: 'Oversight', medical: 'Xenobiology', yard: 'Tern-9', exp: 'Captures', blockers: 'Blockers', reviews: 'Reviews',
  theories: 'Theories', restricted: 'Classified', assets: 'Assets',
};
export const FOLDERS = F;
const path = (f) => `path:${V}/${f}/**`;
const RO = ['fs.list', 'fs.read', 'fs.search', 'fs.history', 'fs.download'];
const RW = [...RO, 'fs.create', 'fs.update', 'fs.rename', 'fs.delete', 'fs.restore', 'fs.conflicts'];
const PUBLIC = Object.values(F).filter((f) => f !== F.restricted);

/** Standing rules every seat gets: the tools, reading the public vault, the graph, shares, channels. */
const base = (extra = []) => [
  { effect: 'allow', actions: ['tool.invoke'], resource: 'tool:*' },
  { effect: 'allow', actions: ['fs.list'], resource: `path:${V}` },
  ...PUBLIC.map((f) => ({ effect: 'allow', actions: RO, resource: path(f) })),
  { effect: 'allow', actions: ['graph.read'], resource: 'graph:*' },
  { effect: 'allow', actions: ['share.create', 'share.upload', 'share.read', 'share.comment', 'share.suggest'], resource: 'share:*' },
  { effect: 'allow', actions: ['channel.use'], resource: 'channel:any' },
  { effect: 'allow', actions: ['room.create'], resource: 'room:*' },
  ...extra,
];
const write = (...folders) => folders.map((f) => ({ effect: 'allow', actions: RW, resource: path(f) }));

/**
 * Teams: name, project, PC, members [label, role]. The first member is the coordinator. Ezra and Hollis sit in
 * the Disclosure Board and, as reviewers, in the two case teams with disclosure-critical work.
 */
export const TEAMS = [
  { key: 'fp', name: 'Signals Lab', project: 'drive', pc: 'east', write: [F.physics, F.exp],
    goal: 'Freeze the echo model the dish is designed against (M1) and explain echo 47.',
    members: [['Orla', 'coordinator'], ['Teodor', 'worker'], ['Imani', 'worker'], ['Sef', 'reviewer']] },
  { key: 'pc', name: 'Relay Engineering', project: 'drive', pc: 'east', write: [F.power, F.exp, F.blockers],
    goal: 'Design the dish array, the transmit sequence and surge protection to R3 (M2).',
    members: [['Brannoc', 'coordinator'], ['Lusa', 'worker'], ['Dario', 'worker'], ['Kemi', 'reviewer'], ['Ezra', 'reviewer']], max_review_rounds: 3 },
  { key: 'mh', name: 'The Annex', project: 'drive', pc: 'west', write: [F.materials, F.exp, F.blockers, F.theories],
    goal: 'Qualify an explanation of the echo to R4 (M3) and keep the theory wall honest.',
    members: [['Hesper', 'coordinator'], ['Vesna', 'worker'], ['Rafi', 'worker'], ['Halden', 'reviewer'], ['Hollis', 'reviewer']] },
  { key: 'nt', name: 'Timekeepers', project: 'drive', pc: 'west', write: [F.nav, F.exp],
    goal: 'Stamp every send and receive within 4 ns (R5) and bound the lead-time error (R6).',
    members: [['Calder', 'coordinator'], ['Mirela', 'worker'], ['Tobin', 'reviewer']] },
  { key: 'cm', name: 'Xenobiology', project: 'drive', pc: 'west', write: [F.medical],
    goal: 'Keep keeper exposure within R7 and settle the frost question with the Disclosure Board.',
    members: [['Ayo', 'coordinator'], ['Petra', 'worker'], ['Linnea', 'reviewer']] },
  { key: 'int', name: 'Case Command', project: 'drive', pc: 'ops', write: [F.programme, F.reviews, F.exp, F.safety], checkpoints: ['done'],
    goal: 'Bring the case together: plan, live listen (M4) and readiness for the first deliberate reply (M7).',
    members: [['Saoirse', 'coordinator'], ['Quentin', 'curator'], ['Wynn', 'worker'], ['Ilse', 'stakeholder']] },
  { key: 'sb', name: 'Disclosure Board', project: 'cert', pc: 'ops', write: [F.safety, F.reviews, F.programme], checkpoints: ['done'], restricted: true,
    goal: 'Independently review every disclosure-critical item (R10) and approve the disclosure case (M6).',
    members: [['Marguerite', 'coordinator'], ['Ezra', 'reviewer'], ['Hollis', 'reviewer']] },
  { key: 'sy', name: 'Tern-9 Keepers', project: 'cert', pc: 'yard', write: [F.yard], narrow: true, recruiting: 'propose',
    goal: 'Refit Tern-9: dish array, receiver shroud, power train and shielded bunks (M5).',
    members: [['Dunmore', 'coordinator'], ['Fen', 'worker'], ['Ottilie', 'worker'], ['Rook', 'reviewer']] },
];

/** Every agent once: its home team decides project, PC and grants. */
export function agents() {
  const out = new Map();
  for (const t of TEAMS) for (const [label] of t.members) if (!out.has(label)) out.set(label, { label, home: t.key, project: PROJECTS[t.project], pc: t.pc });
  for (const l of ['Ezra', 'Hollis']) out.set(l, { ...out.get(l), home: 'sb', project: PROJECTS.cert, pc: 'ops' });
  return [...out.values()];
}

/** Messaging: everyone in the same project, plus the coordinators of both projects with each other. */
export function messagingFor(label, ids) {
  const all = agents(), me = all.find((x) => x.label === label);
  const coords = TEAMS.map((t) => t.members[0][0]);
  const teamsOf = (l) => TEAMS.filter((t) => t.members.some(([m]) => m === l)).map((t) => t.key);
  const mine = teamsOf(label);
  const peers = all.filter((x) => x.label !== label && (x.project === me.project || teamsOf(x.label).some((k) => mine.includes(k)) || (coords.includes(label) && coords.includes(x.label))));
  return peers.length ? [{ effect: 'allow', actions: ['message.send', 'message.receive', 'channel.open', 'channel.accept', 'share.with'], resource: peers.map((p) => `agent:${ids[p.label]}`) }] : [];
}

/** Rules for an agent's session key. */
export function rulesFor(label) {
  const a = agents().find((x) => x.label === label);
  const team = TEAMS.find((t) => t.key === a.home);
  if (team.narrow) {
    return [
      { effect: 'allow', actions: ['tool.invoke'], resource: 'tool:*' },
      { effect: 'allow', actions: ['fs.list'], resource: `path:${V}` },
      ...[F.programme, F.yard].map((f) => ({ effect: 'allow', actions: RO, resource: path(f) })),
      { effect: 'allow', actions: RO, resource: `path:${V}/${F.medical}/Bunk shielding requirements.md` },
      { effect: 'allow', actions: RO, resource: `path:${V}/${F.power}/Shielding interface.md` },
      ...write(F.yard),
    ];
  }
  const extra = [...write(...team.write)];
  if (team.restricted) extra.push({ effect: 'allow', actions: RO, resource: path(F.restricted) }, { effect: 'allow', actions: ['graph.read', 'graph.review'], resource: 'graph:*' });
  if (team.members[0][0] === label) extra.push({ effect: 'allow', actions: ['room.invite', 'room.join', 'room.post', 'room.read_history'], resource: 'room:*' });
  else if (team.key === 'int') extra.push({ effect: 'allow', actions: ['room.join', 'room.post', 'room.read_history'], resource: 'room:*' });
  if (label === 'Quentin') extra.push({ effect: 'allow', actions: ['graph.read', 'graph.write'], resource: 'graph:*' });
  if (['Ezra', 'Hollis', 'Kemi', 'Halden'].includes(label)) extra.push({ effect: 'allow', actions: ['graph.review'], resource: 'graph:*' });
  if (['Dario', 'Lusa', 'Vesna'].includes(label)) extra.push({ effect: 'allow', actions: ['graph.write'], resource: 'graph:*' });
  if (['Hesper', 'Vesna'].includes(label)) extra.push({ effect: 'allow', actions: ['share.promote'], resource: 'share:*' });
  return base(extra);
}

/**
 * Directives (spec §3), with and without a category; Xenobiology's exposure rule arrives through directives_report.
 * A project rule names a case: Act 0 saves it once for the project of each team in that case.
 */
export const DIRECTIVES = [
  { title: 'Never paste a key', body: 'Never put a Conclave key into a message, file, share or report. If you see one, report it to the operator.', scope: { kind: 'hub' }, category: 'access', tags: ['security'] },
  { title: 'Cite the capture ID for every timing', body: 'Every timing or figure in a note or report names the capture it came from (CAP-…), or says it is an estimate.', scope: { kind: 'project', ref: PROJECTS.drive }, category: 'sources', tags: ['evidence', 'captures'] },
  { title: 'Disclosure-critical means reviewed by the Disclosure Board', body: 'A task that touches shielding, surge, timing or keeper exposure is reviewed by a Disclosure Board reviewer, never by its own team alone.', scope: { kind: 'project', ref: PROJECTS.cert }, category: 'process', tags: ['safety', 'review'] },
  { title: 'Surge margin is at least 15 %', body: 'No dish design goes to review with a surge margin under 15 % at the operating temperature (R3).', scope: { kind: 'team', ref: 'pc' }, category: 'process', tags: ['safety', 'dish'] },
  { title: 'Times in relay time, UTC offset stated', body: 'Write every timestamp in relay time with the offset to UTC, to the precision the instrument has.', scope: { kind: 'team', ref: 'nt' }, category: 'communication', tags: ['timing'] },
  { title: 'Read the cited source before approving', body: 'A reviewer opens every source a submission cites before approving it.', scope: { kind: 'role', ref: 'sb|reviewer' }, category: 'sources', tags: ['review'] },
  { title: 'One claim per quote', body: 'Each graph claim cites one exact quote from one section.', scope: { kind: 'role', ref: 'int|curator' }, category: 'tooling', tags: ['graph'] },
  { title: 'Weekly status by Friday', body: 'Post the weekly status in the Case Command room by Friday noon.', scope: { kind: 'agent', ref: 'Wynn' }, category: 'reporting' },
  { title: 'Keep the station log current', body: 'Every installed part goes into the Tern-9 station log the same watch.', scope: { kind: 'team', ref: 'sy' }, tags: ['station'] },
];

export const PLAYBOOKS = {
  coordinator: 'Turn the plan into tasks, assign them with a reviewer from another seat, close each only after review, and report to the team room when the plan changes.',
  reviewer: 'Review against the cited sources. Request changes with one concrete fix per comment. Never review your own work.',
  curator: 'Index the notes you are offered; one claim per quote; flag notes that a change makes stale.',
};
