#!/usr/bin/env node
// Checks the Early Echo vault (eval/vault/) in its start-of-story state against docs/showcase.md §2:
// links and depends_on resolve, the reveal rule holds, no franchise word appears, the mysteries have their answers,
// the graph chains and the mystery trail are wired, and the note counts match the plan.
// Usage: node eval/story/check-vault.mjs [vault dir]   Exit 0 when clean; otherwise prints every problem and exits 1.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const VAULT = resolve(process.argv[2] ?? join(here, '..', 'vault'));

/** Planned notes per folder (docs/showcase.md §2), and how the start state differs. */
export const PLAN = {
  'Case Command': 10, 'Signals Lab': 12, 'Relay Engineering': 10, 'The Annex': 8, 'Timekeepers': 9,
  'Oversight': 11, 'Xenobiology': 10, 'Tern-9': 9, 'Captures': 11, 'Blockers': 3, 'Reviews': 6, 'Classified': 6, 'Theories': 6,
};
/** Written by the story, so absent at the start and never linked from the start state. */
export const WRITTEN_LATER = { 'Echo model v2': 'Signals Lab', 'Disclosure order': 'Oversight' };
/** Present at the start but not in the plan's table: Dario deletes it in step 2.4. */
export const EXTRA_AT_START = { 'scratch': 'Relay Engineering' };

/** Spec §2 "Every mystery has an answer in the vault": where the reader meets it, where it is answered. */
export const MYSTERIES = [
  { q: 'Why was the live-listen campaign paused?', meet: ['Echo 47 (why we stopped)'], answer: ['Do not circulate - echo 47'] },
  { q: 'The second timestamp', meet: ['Second timestamp', 'Whiteboard, 14 March'], answer: ['What answers us'] },
  { q: 'Jitter or not?', meet: ['Lab notebook — Teodor', 'Lab notebook — Imani'], answer: ['Holdover test', 'What answers us'] },
  { q: 'Where did the frost come from?', meet: ['IR-0412 Tern-9 cryo alarm'], answer: ['Dish panel 7 (the one nobody ordered)', 'Frost chain of custody'] },
  { q: 'Does the frost make the echo?', meet: ['Frost is a contaminant', 'The dish is alive'], answer: ['CAP-014b Empty dish'] },
  { q: 'Why does the frost react early?', meet: ['Frost feeding log'], answer: ['What answers us'] },
  { q: 'Is it Firmware 7?', meet: ['CAP-014 Air-gapped capture', 'B-01 Firmware 7 fault', 'Firmware 7'], answer: ['Build 7 test report', 'What answers us'] },
  { q: 'Who changed the story?', meet: ['Intercepted message'], answer: ['What answers us'] },
  { q: 'May we wire the frost into the clocks?', meet: ['Ethics question - a living sensor', 'Frost as an instrument'], answer: ['Disclosure order'] },
];

/** depends_on edges the graph chains need (spec §2, chains 1–5): [note, depends on]. */
export const CHAIN_EDGES = [
  ['Firmware 7', 'CAP-014 Air-gapped capture'], ['Dish array design', 'Firmware 7'], ['Power budget', 'Dish array design'],
  ['Disclosure case', 'Power budget'], ['Milestones', 'Disclosure case'],
  ['Lead-time error', 'Clock drift model'], ['Hazard log', 'Lead-time error'], ['Exposure limit', 'Hazard log'],
  ['Lead time vs transmit power', 'Echo geometry'], ['Dish array design', 'Lead time vs transmit power'], ['Relay clock design', 'Lead time vs transmit power'],
  ['Bunk shielding requirements', 'Echo sleep physiology'], ['Bunk shielding spec', 'Bunk shielding requirements'], ['Refit schedule', 'Bunk shielding spec'], ['Milestones', 'Refit schedule'],
  ['Firmware 7', 'Build 7 test report'], ['Firmware 7', 'What answers us'],
];
/** Chain 7, the mystery trail: each note links the next. */
export const TRAIL = ['Case board', 'Echo 47 (why we stopped)', 'Second timestamp', 'Frost feeding log', 'CAP-014 Air-gapped capture', 'CAP-014b Empty dish', 'What answers us'];

/** Only under Classified/ until step 4.5b adds Disclosure case §9. */
export const REVEAL_TERMS = ['substrate', 'fold test'];
/** The old story must be gone from the vault (matched case-insensitively). */
export const OLD_STORY = ['lantern wake', 'kestrel', 'brightwater', 'aldermoor', 'cassen', 'halloran', 'threadglass', 'hc-7', 'hc-9', 'lattice coil', 'null shell', 'return pulse', 'fold lag'];
/** No franchise vocabulary anywhere (matched inside words too). */
export const BANNED = ['warp', 'nacelle', 'dilithium', 'deflector', 'subspace', 'impulse', 'transporter', 'starbase', 'starfleet', 'federation', 'vulcan',
  'klingon', 'romulan', 'borg', 'tricorder', 'phaser', 'holodeck', 'replicator', 'tardigrade', 'spore', 'mycel', 'fungal', 'fungus', 'hyphae',
  'enterprise', 'voyager', 'tribble', 'horta', 'tholian', 'jedi', 'sith', 'wookiee', 'tardis', 'dalek', 'cylon', 'macross',
  'x-file', 'mulder', 'scully', 'truth is out there', 'trust no one', 'i want to believe', 'smoking man', 'lone gunmen', 'area 51'];
/** "borg" and "sith" hide inside ordinary words; these are the ordinary words that may contain a banned string. */
const BANNED_OK = [/cyborg/i, /\bsith(?=e)/i];

const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const linkRe = /!?\[\[([^\]|#\n]+)(?:#[^\]|\n]+)?(?:\|[^\]\n]*)?\]\]/g;

export function checkVault(vault = VAULT) {
  const errors = [];
  const files = walk(vault);
  const rel = (p) => relative(vault, p).split(sep).join('/');
  const notes = new Map(), assets = new Set();
  for (const p of files) {
    if (extname(p) === '.md') {
      const name = basename(p, '.md');
      if (notes.has(name)) errors.push(`duplicate note name "${name}": ${rel(notes.get(name).path)} and ${rel(p)}`);
      notes.set(name, { path: p, folder: rel(p).split('/')[0], text: readFileSync(p, 'utf8').replace(/\r\n/g, '\n') });
    } else assets.add(basename(p));
  }
  const exists = (t) => notes.has(t) || assets.has(t);

  // Counts.
  const byFolder = {};
  for (const n of notes.values()) byFolder[n.folder] = (byFolder[n.folder] ?? 0) + 1;
  for (const [folder, planned] of Object.entries(PLAN)) {
    const later = Object.values(WRITTEN_LATER).filter((f) => f === folder).length, extra = Object.values(EXTRA_AT_START).filter((f) => f === folder).length;
    const want = planned - later + extra;
    if ((byFolder[folder] ?? 0) !== want) errors.push(`${folder}/: ${byFolder[folder] ?? 0} notes at the start, expected ${want} (plan ${planned}, ${later} written later, ${extra} extra)`);
  }
  for (const f of Object.keys(byFolder)) if (!(f in PLAN)) errors.push(`unexpected top-level note folder "${f}"`);
  const plannedTotal = Object.values(PLAN).reduce((a, b) => a + b, 0);
  if (plannedTotal !== 111) errors.push(`the plan should total 111 notes (docs/showcase.md), this checker says ${plannedTotal}`);
  for (const [n, folder] of Object.entries(WRITTEN_LATER)) if (notes.has(n)) errors.push(`"${n}" is written in the story and must not exist at the start (${folder}/)`);
  for (const [n, folder] of Object.entries(EXTRA_AT_START)) if (notes.get(n)?.folder !== folder) errors.push(`"${n}" must exist in ${folder}/ at the start`);
  for (const sub of ['diagrams', 'sketches', 'data', 'recordings']) if (!files.some((p) => rel(p).startsWith(`Assets/${sub}/`))) errors.push(`Assets/${sub}/ is empty`);

  // Per note: frontmatter, headings, links.
  for (const [name, n] of notes) {
    const where = rel(n.path);
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(n.text);
    if (!fm) { errors.push(`${where}: no frontmatter`); continue; }
    const keys = fm[1].split('\n').map((l) => /^([a-z_]+):/.exec(l)?.[1]).filter(Boolean);
    if (keys.slice(0, 3).join(',') !== 'owner,status,depends_on') errors.push(`${where}: frontmatter must start with owner, status, depends_on (got ${keys.join(', ')})`);
    const dep = /^depends_on:\s*(.*)$/m.exec(fm[1])?.[1] ?? '';
    n.deps = [...dep.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]*)?\]\]/g)].map((m) => m[1].trim());
    if (!/^\[.*\]$/.test(dep.trim())) errors.push(`${where}: depends_on must be a list`);
    for (const d of n.deps) if (!notes.has(d)) errors.push(`${where}: depends_on [[${d}]] does not exist`);
    const body = n.text.slice(fm[0].length);
    const h1 = /^# (.+)$/m.exec(body)?.[1]?.trim();
    if (h1 !== name) errors.push(`${where}: H1 should be "${name}", found "${h1 ?? ''}"`);
    if ((body.match(/^## /gm) ?? []).length < 2) errors.push(`${where}: needs at least two H2 sections`);
    n.links = new Set([...body.matchAll(linkRe)].map((m) => m[1].trim()));
    for (const t of n.links) {
      if (t in WRITTEN_LATER) errors.push(`${where}: links [[${t}]], which is only written later in the story`);
      else if (!exists(t)) errors.push(`${where}: link [[${t}]] does not resolve`);
    }
  }

  // Text rules over every text file (notes, SVG, CSV, JSON).
  for (const p of files) {
    if (extname(p) === '.bin') continue;
    const text = readFileSync(p, 'utf8'), lower = text.toLowerCase(), where = rel(p);
    if (!where.startsWith('Classified/')) for (const t of REVEAL_TERMS) if (lower.includes(t)) errors.push(`${where}: "${t}" may appear only under Classified/ until Act 4`);
    for (const t of OLD_STORY) if (lower.includes(t)) errors.push(`${where}: old-story term "${t}"`);
    let scrub = text; for (const ok of BANNED_OK) scrub = scrub.replace(new RegExp(ok.source, 'gi'), '');
    for (const w of BANNED) if (scrub.toLowerCase().includes(w)) errors.push(`${where}: banned word "${w}"`);
  }

  // Mysteries, chains, trail.
  for (const m of MYSTERIES) {
    for (const n of m.meet) if (!notes.has(n)) errors.push(`mystery "${m.q}": the note where the reader meets it, "${n}", is missing`);
    for (const n of m.answer) if (!notes.has(n) && !(n in WRITTEN_LATER)) errors.push(`mystery "${m.q}": its answer "${n}" is missing`);
  }
  for (const [a, b] of CHAIN_EDGES) if (notes.has(a) && !notes.get(a).deps?.includes(b)) errors.push(`chain: "${a}" must list [[${b}]] in depends_on`);
  for (let i = 0; i + 1 < TRAIL.length; i++) if (notes.has(TRAIL[i]) && !notes.get(TRAIL[i]).links?.has(TRAIL[i + 1])) errors.push(`mystery trail: "${TRAIL[i]}" must link [[${TRAIL[i + 1]}]]`);
  const feed = notes.get('Frost feeding log')?.text.trim() ?? '';
  if (!feed.endsWith('Mass up 4 % after echo 52. Tern-9 never sent message 52. See [[Second timestamp]].')) errors.push('Frost feeding log must end on its echo-52 cliffhanger');
  for (const s of ['## §1', '## §8']) if (!notes.get('Disclosure case')?.text.includes(s)) errors.push(`Disclosure case must have "${s}"`);
  if (notes.get('Disclosure case')?.text.includes('## §9')) errors.push('Disclosure case must not have §9 at the start (step 4.5b adds it)');

  return { errors, notes: notes.size, assets: assets.size };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { errors, notes, assets } = checkVault();
  if (errors.length) { for (const e of errors) console.error(`✗ ${e}`); console.error(`${errors.length} problem(s) in ${VAULT}`); process.exit(1); }
  console.log(`✓ vault ok: ${notes} notes, ${assets} assets`);
}
