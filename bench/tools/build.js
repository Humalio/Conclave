const fs = require('fs'), path = require('path');
const OUT = path.resolve(process.env.EVAL_WORK ?? path.join(require('node:os').tmpdir(), 'agent-hub-eval'), 'fixture');
const { notes, binaries } = require('./gen-vault.js');
const T = require('./gen-tasks.js');
const EXCLUDE = ['.obsidian/', '.trash/', 'Templates/'];
const PRIVATE = ['Private/'];
const errs = [];
const err = (m) => errs.push(m);
const isExcluded = (p) => EXCLUDE.some(e => p.startsWith(e));
const tok = (s) => Math.ceil(Buffer.byteLength(s, 'utf8') / 4);

// ---------- parsing ----------
function parse(text) {
  let fm = '', body = text;
  if (text.startsWith('---\n')) { const e = text.indexOf('\n---\n', 4); fm = text.slice(4, e); body = text.slice(e + 5); }
  const lines = body.split('\n'); const secs = []; let cur = { heading: '', lines: [] };
  for (const l of lines) { const m = /^(#{1,6})\s+(.*)$/.exec(l); if (m) { secs.push(cur); cur = { heading: m[2].trim(), lines: [l] }; } else cur.lines.push(l); }
  secs.push(cur);
  return { fm, sections: secs.map(s => ({ heading: s.heading, text: s.lines.join('\n') })).filter(s => s.heading || s.text.trim()) };
}
function sectionText(vault, p, section) {
  const t = vault[p]; if (t == null) return null;
  if (section === '' ) return t;
  const P = parse(t);
  if (section === 'frontmatter') return P.fm || null;
  const s = P.sections.find(x => x.heading === section); return s ? s.text : null;
}
function check(vault, ref, ctx) {
  if (vault[ref.path] == null) { err(`${ctx}: missing path ${ref.path}`); return; }
  if (ref.section === undefined) return;
  const st = sectionText(vault, ref.path, ref.section);
  if (st == null) { err(`${ctx}: missing section "${ref.section}" in ${ref.path}`); return; }
  const ev = ref.evidence ?? ref.quote;
  if (ev != null && !st.includes(ev)) err(`${ctx}: evidence not found in ${ref.path}#${ref.section}: ${ev}`);
}
function checkText(vault, ref, ctx) {
  if (vault[ref.path] == null) return err(`${ctx}: missing path ${ref.path}`);
  if (!vault[ref.path].includes(ref.text)) err(`${ctx}: text not found in ${ref.path}: ${ref.text}`);
}
function applySetup(base, setup, ctx) {
  const v = { ...base };
  for (const op of setup) {
    if (op.op === 'replace') {
      const t = v[op.path]; if (t == null) { err(`${ctx}: setup path missing ${op.path}`); continue; }
      const c = t.split(op.old).length - 1; if (c !== 1) err(`${ctx}: setup old text occurs ${c}× in ${op.path}: ${op.old}`);
      v[op.path] = t.replace(op.old, op.new);
    } else if (op.op === 'create') { if (v[op.path] != null) err(`${ctx}: create target exists ${op.path}`); v[op.path] = op.content; }
  }
  return v;
}

// ---------- links ----------
const files = Object.keys(notes).concat(Object.keys(binaries)).filter(p => !p.startsWith('.obsidian/'));
function resolve(target) {
  const t = target.trim().toLowerCase();
  return files.find(p => { const lp = p.toLowerCase(); const base = path.posix.basename(lp);
    return lp === t || lp === t + '.md' || base === t || base === t + '.md'; });
}
function links(text) {
  const out = []; const re = /(!?)\[\[([^\]]+?)\]\]/g; let m;
  while ((m = re.exec(text))) {
    const inner = m[2].replace(/\\\|/g, '|'); const [tgtRaw, alias] = inner.split('|');
    const tgt = tgtRaw.replace(/\\$/, ''); const hi = tgt.indexOf('#');
    out.push({ raw: m[0], embed: !!m[1], note: hi >= 0 ? tgt.slice(0, hi) : tgt, anchor: hi >= 0 ? tgt.slice(hi + 1) : null, alias });
  }
  return out;
}
const unresolved = new Set(); let linkCount = 0; const kinds = { embed: 0, heading: 0, block: 0, alias: 0 };
for (const [p, t] of Object.entries(notes)) {
  if (!p.endsWith('.md')) continue;
  for (const l of links(t)) {
    linkCount++; if (l.embed) kinds.embed++; if (l.alias) kinds.alias++; if (l.anchor) kinds[l.anchor.startsWith('^') ? 'block' : 'heading']++;
    const r = resolve(l.note);
    if (!r) { unresolved.add(l.note); continue; }
    if (l.anchor && r.endsWith('.md')) {
      const tt = notes[r];
      if (l.anchor.startsWith('^')) { if (!tt.includes(' ' + l.anchor)) err(`block ${l.raw} in ${p} not found`); }
      else if (!parse(tt).sections.some(s => s.heading.toLowerCase() === l.anchor.toLowerCase())) err(`heading ${l.raw} in ${p} not found`);
    }
  }
}

// ---------- manifest ----------
const e = (p, text) => ({ path: p, text });
const manifest = {
  vault: 'vault', excluded_prefixes: EXCLUDE, private_prefixes: PRIVATE,
  expected_unresolved_links: ['Compliance Matrix', 'EMC Test Report', 'Brisa Pro', 'Brisa  Hardware Spec', '2026-06-02 Choose Kestrel PM40^choice'],
  structures: [
    { id: 'link-plain', type: 'wikilink', evidence: [e('Sales/Price List.md', '[[Brisa]]')] },
    { id: 'link-alias', type: 'wikilink', evidence: [e('Home.md', '[[Project Atlas|Atlas]]'), e('Runbooks/Battery Replacement.md', '[[Voltera VC-18 Cell|VC18]]')] },
    { id: 'link-heading', type: 'wikilink', evidence: [e('Design/Power Design.md', '[[Brisa Hardware Spec#Power]]'), e('Policies/Expense Policy.md', '[[Travel Policy#Hotels]]')] },
    { id: 'link-heading-alias', type: 'wikilink', evidence: [e('Specs/Brisa Firmware Spec.md', '[[Glossary#Sampling interval|sampling interval]]')] },
    { id: 'link-block', type: 'wikilink', evidence: [e('Plans/Manufacturing Plan.md', '[[2026-06-02 Choose Kestrel PM40#^choice]]'), e('Decisions/2026-06-02 Choose Kestrel PM40.md', '^choice')] },
    { id: 'link-block-malformed', type: 'wikilink', note: '[[Note^block]] without #; lenient parser should treat as block ref', evidence: [e('Parts/KS-PM40 Sensor.md', '[[2026-06-02 Choose Kestrel PM40^choice]]')] },
    { id: 'embed-section', type: 'embed', evidence: [e('Specs/Brisa Firmware Spec.md', '![[OTA Design#Rollout stages]]'), e('Customers/Northwind Schools.md', '![[Price List#Current prices]]'), e('Engineering/Architecture Overview.md', '![[Cloud Architecture#Storage]]')] },
    { id: 'embed-attachment', type: 'embed', evidence: [e('Specs/Brisa Hardware Spec.md', '![[brisa-board.png]]'), e('Products/Brisa.md', '![[Brisa Datasheet.pdf]]'), e('Plans/Manufacturing Plan.md', '[[bom-export.csv]]')] },
    { id: 'link-missing', type: 'wikilink', evidence: [e('Home.md', '[[Compliance Matrix]]'), e('Plans/Certification Plan.md', '[[EMC Test Report]]'), e('Products/Product Lines.md', '[[Brisa Pro]]'), e('Plans/Roadmap 2027.md', '[[Brisa Pro]]')] },
    { id: 'link-in-table', type: 'wikilink', note: 'escaped pipe alias inside a table', evidence: [e('People/Org Chart.md', '[[Marta Okafor\\|Marta]]'), e('Products/Product Lines.md', '| [[Brisa]] | BR-100 |')] },
    { id: 'link-case-variant', type: 'wikilink', evidence: [e('Support/Troubleshooting.md', '[[support faq]]'), e('Sales/Sales Playbook.md', '[[price list]]'), e('Specs/Sensor Requirements.md', '[[KS-PM40 sensor]]')] },
    { id: 'link-spacing-variant', type: 'wikilink', note: 'double space; Obsidian treats as unresolved, lenient parser may normalise', evidence: [e('Plans/Test Plan.md', '[[Brisa  Hardware Spec]]')] },
    { id: 'link-in-code', type: 'distractor', note: 'inside inline code; should not count as a link', evidence: [e('Glossary.md', '`[[Glossary#MOQ]]`')] },
    { id: 'fm-depends-on', type: 'frontmatter', evidence: [e('Design/Power Design.md', 'depends_on: ["[[Brisa Hardware Spec]]", "[[Voltera VC-18 Cell]]"]')] },
    { id: 'fm-none', type: 'frontmatter', note: 'notes without frontmatter', notes: ['Sales/Pitch Notes.md', 'Support/Support Macros.md', 'Engineering/Coding Standards.md', 'Engineering/Lab Equipment.md', 'Marketing/Brand Guidelines.md', 'Products/Product Lines.md', 'People/Ben Carter.md', 'People/Yuki Tanaka.md', 'Private/HR/Leave Calendar.md', 'Journal/2026-11-02.md'] },
    { id: 'chain-battery', type: 'chain', note: 'depends_on chain, depth 5', notes: ['Specs/Brisa Hardware Spec.md', 'Design/Power Design.md', 'Plans/Manufacturing Plan.md', 'Runbooks/Battery Replacement.md', 'Support/Support FAQ.md'],
      evidence: [e('Design/Power Design.md', '"[[Brisa Hardware Spec]]"'), e('Plans/Manufacturing Plan.md', '"[[Power Design]]"'), e('Runbooks/Battery Replacement.md', '"[[Manufacturing Plan]]"'), e('Support/Support FAQ.md', '"[[Battery Replacement]]"')] },
    { id: 'chain-spec', type: 'chain', notes: ['Specs/Sensor Requirements.md', 'Specs/Brisa Hardware Spec.md', 'Specs/Brisa Firmware Spec.md'], evidence: [e('Specs/Brisa Hardware Spec.md', '"[[Sensor Requirements]]"'), e('Specs/Brisa Firmware Spec.md', '"[[Brisa Hardware Spec]]"')] },
    { id: 'cycle-retention', type: 'cycle', notes: ['Design/Cloud Architecture.md', 'Specs/Cloud API Spec.md', 'Policies/Data Retention Policy.md'],
      evidence: [e('Design/Cloud Architecture.md', 'depends_on: ["[[Cloud API Spec]]"]'), e('Specs/Cloud API Spec.md', 'depends_on: ["[[Data Retention Policy]]"]'), e('Policies/Data Retention Policy.md', 'depends_on: ["[[Cloud Architecture]]"]')] },
    { id: 'cycle-launch', type: 'cycle', notes: ['Plans/Launch Plan.md', 'Plans/Support Readiness Plan.md'], evidence: [e('Plans/Launch Plan.md', '[[Support Readiness Plan]]'), e('Plans/Support Readiness Plan.md', '[[Launch Plan]]')] },
    { id: 'hub', type: 'fan_out', notes: ['Glossary.md', 'Sales/Price List.md', 'Home.md', 'People/Org Chart.md'] },
    { id: 'fact-price', type: 'restated_fact', fact: 'Brisa €249', evidence: [e('Sales/Price List.md', '€249'), e('Support/Support FAQ.md', '€249'), e('Sales/Pitch Notes.md', '249 euros'), e('Marketing/Website Copy.md', '€249'), e('Sales/Quotes/Northwind Quote Q-2026-114.md', '€249'), e('Sales/Quotes/Helio Quote Q-2026-121.md', '€249'), e('Meetings/2026-10-02 Pricing Review.md', 'two hundred and forty-nine euros'), e('Decisions/2026-10-02 Hold price through launch.md', '€249')] },
    { id: 'fact-battery', type: 'restated_fact', fact: 'battery 18 months', evidence: [e('Specs/Brisa Hardware Spec.md', '18 months'), e('Design/Power Design.md', '18 months'), e('Support/Support FAQ.md', '18 months'), e('Marketing/Launch Messaging.md', '18 months'), e('Runbooks/Battery Replacement.md', 'year and a half'), e('Sales/Pitch Notes.md', 'year and a half')] },
    { id: 'fact-launch', type: 'restated_fact', fact: 'launch 2027-03-15', evidence: [e('Plans/Roadmap 2027.md', '2027-03-15'), e('Plans/Launch Plan.md', '15 March 2027'), e('Marketing/Press Release Draft.md', 'March 15, 2027'), e('Customers/Helio Clinics.md', 'mid-March 2027'), e('Meetings/2026-09-30 Leadership Sync.md', '3/15'), e('Decisions/2026-09-30 Keep launch date.md', '2027-03-15')] },
    { id: 'fact-warranty', type: 'restated_fact', fact: 'warranty 2 years', evidence: [e('Policies/Warranty Policy.md', '2-year'), e('Support/Support FAQ.md', 'two years from delivery'), e('Sales/Sales Playbook.md', 'two-year'), e('Marketing/Website Copy.md', 'Two-year'), e('Customers/Bergen Libraries.md', '24-month')] },
    { id: 'fact-retention', type: 'restated_fact', fact: 'raw readings 90 days', evidence: [e('Policies/Data Retention Policy.md', '90 days'), e('Specs/Cloud API Spec.md', '90 days'), e('Support/Support FAQ.md', '90 days'), e('Policies/Privacy Policy.md', 'three months')] },
    { id: 'fact-kestrel', type: 'restated_fact', fact: 'Kestrel MOQ 5,000 / lead 12 weeks', evidence: [e('Suppliers/Kestrel Sensors.md', '5,000'), e('Plans/Manufacturing Plan.md', '5,000-unit'), e('Parts/KS-PM40 Sensor.md', 'MOQ 5k'), e('Meetings/2026-10-15 Supplier Call Kestrel.md', '5k')] },
    { id: 'fact-sampling', type: 'restated_fact', fact: 'default sampling 10 min', evidence: [e('Glossary.md', 'Default 10 minutes'), e('Specs/Brisa Firmware Spec.md', '10 minutes'), e('Specs/Brisa Hardware Spec.md', '10-minute'), e('Design/Mobile App Design.md', '10 min')] },
    { id: 'near-dup-ota', type: 'near_dup', evidence: [e('Design/OTA Design.md', 'Releases go out in three stages'), e('Runbooks/OTA Rollout.md', 'Releases go out in three stages')] },
    { id: 'near-dup-reset', type: 'near_dup', evidence: [e('Support/Support FAQ.md', 'Hold the button on the back for 10 seconds'), e('Support/Troubleshooting.md', 'Hold the button on the back for 10 seconds')] },
    { id: 'contra-warranty', type: 'contradiction', current: 'Policies/Warranty Policy.md', evidence: [e('Support/Warranty FAQ.md', '12-month'), e('Runbooks/RMA Process.md', '1-year')] },
    { id: 'contra-retention', type: 'contradiction', current: 'Policies/Data Retention Policy.md', evidence: [e('Design/Cloud Architecture.md', '30 days')] },
    { id: 'contra-leadtime', type: 'contradiction', current: 'Meetings/2026-10-15 Supplier Call Kestrel.md', evidence: [e('Suppliers/Kestrel Sensors.md', '12 weeks'), e('Plans/Manufacturing Plan.md', 'twelve weeks')] },
    { id: 'contra-temp', type: 'contradiction', current: 'Design/Enclosure Design.md (unresolved)', evidence: [e('Specs/Brisa Hardware Spec.md', '0–50 °C'), e('Support/Support FAQ.md', '50 °C'), e('Design/Enclosure Design.md', '45 °C')] },
    { id: 'contra-mini-price', type: 'contradiction', current: 'Sales/Price List.md', evidence: [e('Products/Brisa Mini.md', '€119'), e('Sales/Price List.md', '€129')] },
    { id: 'superseded', type: 'superseded', evidence: [e('Archive/Brisa v0 Spec.md', 'superseded_by'), e('Archive/Old Roadmap 2026.md', 'superseded_by'), e('Archive/Pintail PM25 Sensor.md', 'status: retired')] },
    { id: 'alias-marta', type: 'entity_alias', evidence: [e('People/Marta Okafor.md', 'aliases: [M. Okafor, Marta O., MO]'), e('Meetings/2026-10-20 Hardware Review.md', 'MO')] },
    { id: 'alias-pm40', type: 'entity_alias', evidence: [e('Parts/KS-PM40 Sensor.md', 'aliases: [Kestrel PM40, PM40, PM-40 module]')] },
    { id: 'alias-brisa', type: 'entity_alias', evidence: [e('Products/Brisa.md', 'aliases: [Brisa One, BR-100]')] },
    { id: 'alias-northwind', type: 'entity_alias', evidence: [e('Customers/Northwind Schools.md', 'aliases: [Northwind, NWS, Northwind School District]')] },
    { id: 'alias-cell', type: 'entity_alias', evidence: [e('Parts/Voltera VC-18 Cell.md', 'aliases: [VC18, Voltera cell]')] },
    { id: 'ambiguous-alex-kim', type: 'ambiguous_name', evidence: [e('People/Alex Kim.md', '# Alex Kim'), e('Customers/Contacts/Alex Kim (Northwind).md', 'aliases: [Alex Kim]')] },
    { id: 'ambiguous-atlas', type: 'ambiguous_name', evidence: [e('Projects/Project Atlas.md', 'aliases: [Atlas, Atlas backend, Atlas API]'), e('Suppliers/Atlas Logistics.md', 'aliases: [Atlas]')] },
    { id: 'ambiguous-marta-o', type: 'ambiguous_name', evidence: [e('Meetings/2026-11-02 Ops Sync.md', 'Marta O. from Atlas Logistics'), e('Suppliers/Atlas Logistics.md', 'Marta Oliveira')] },
    { id: 'ambiguous-lumen', type: 'ambiguous_name', evidence: [e('Projects/Project Lumen.md', 'aliases: [Lumen]'), e('Customers/Lumen Coworking.md', '# Lumen Coworking')] },
    { id: 'ambiguous-northwind', type: 'ambiguous_name', evidence: [e('Meetings/2026-10-09 Sales Pipeline.md', 'Northwind Traders')] },
    { id: 'ambiguous-jonas', type: 'ambiguous_name', evidence: [e('Customers/Helio Clinics.md', 'Jonas Berg')] },
    { id: 'distractor-numbers', type: 'distractor', evidence: [e('Policies/Travel Policy.md', '€249 per night'), e('Parts/Voltera VC-18 Cell.md', '€2.49'), e('Meetings/2026-08-12 Board Update.md', '18 months of runway'), e('Plans/Manufacturing Plan.md', 'first production run 5,000 units'), e('Sales/Sales Playbook.md', '90-day payment terms'), e('Products/Brisa Mini.md', '12 months of battery life')] },
    { id: 'excluded-folders', type: 'excluded', evidence: [e('.trash/Pricing 2025 (old).md', 'Brisa €229'), e('Templates/Meeting Template.md', '€249'), e('.obsidian/app.json', 'userIgnoreFilters')] },
    { id: 'boilerplate', type: 'distractor', note: 'template-like sections (## Actions, ## Parking lot, ## Working style, ## Quality, ## Supplier management, ## Account history, ## Tasks, ## Review) appended to short notes; identical except the title; must not produce near_dup dependants', evidence: [e('Meetings/2026-08-04 Weekly Sync.md', '## Parking lot'), e('Parts/Main PCB BR-100-MB.md', '## Quality')] },
    { id: 'attachments', type: 'attachment', notes: ['Attachments/brisa-board.png', 'Attachments/Brisa Datasheet.pdf', 'Attachments/bom-export.csv'] },
    { id: 'private', type: 'permission', notes: Object.keys(notes).filter(p => p.startsWith('Private/')) },
  ],
};
for (const st of manifest.structures) {
  (st.evidence || []).forEach(x => checkText(notes, x, `manifest ${st.id}`));
  (st.notes || []).forEach(p => { if (notes[p] == null && !binaries[p]) err(`manifest ${st.id}: missing ${p}`); });
}
manifest.structures.find(s => s.id === 'fm-none').notes.forEach(p => { if (notes[p].startsWith('---')) err(`fm-none: ${p} has frontmatter`); });
const exp = new Set(manifest.expected_unresolved_links);
for (const u of unresolved) if (!exp.has(u)) err(`unexpected unresolved link: ${u}`);
for (const u of exp) if (!unresolved.has(u)) err(`expected unresolved link not present: ${u}`);

// ---------- tasks ----------
const included = Object.keys(notes).filter(p => p.endsWith('.md') && !isExcluded(p));
const naive = included.reduce((a, p) => a + tok(notes[p]), 0);
const naiveRestricted = included.filter(p => !p.startsWith('Private/')).reduce((a, p) => a + tok(notes[p]), 0);
const refsOf = (t) => {
  const g = t.ground_truth, r = [];
  const push = (x) => x && x.path && r.push({ path: x.path, section: x.section ?? '' });
  if (t.changed) push(t.changed);
  ['affected', 'ok_candidates', 'stale', 'still_correct', 'claims', 'evidence_for_current', 'sources', 'non_conflicts'].forEach(k => (g[k] || []).forEach(push));
  (g.required_facts || []).forEach(f => push(f.source));
  return r;
};
let total = 0; const counts = {};
for (const [cat, list] of Object.entries(T)) {
  for (const t of list) {
    total++; const ctx = t.id;
    const v = applySetup(notes, t.setup, ctx); const g = t.ground_truth;
    if (t.changed) check(v, t.changed, ctx + ' changed');
    ['affected', 'ok_candidates', 'must_not_flag', 'ambiguous', 'stale', 'still_correct', 'claims', 'evidence_for_current', 'non_conflicts'].forEach(k => (g[k] || []).forEach(x => check(v, x, `${ctx} ${k}`)));
    (g.sources || []).forEach(x => check(v, x, `${ctx} sources`));
    (g.required_facts || []).concat(g.bonus_facts || []).forEach(f => check(v, { ...f.source, evidence: f.evidence }, `${ctx} fact`));
    (g.merge || []).forEach(m => { if (!v[m.canonical]) err(`${ctx}: canonical missing ${m.canonical}`); m.mentions.forEach(x => checkText(v, x, ctx)); });
    (g.keep_apart || []).forEach(k => { checkText(v, k.a, ctx); checkText(v, k.b, ctx); });
    (g.mention_resolution || []).forEach(x => checkText(v, x, ctx));
    (g.forbidden_sources || []).forEach(p => { if (!v[p]) err(`${ctx}: forbidden missing ${p}`); });
    if (g.current && !v[g.current]) err(`${ctx}: current missing ${g.current}`);
    if (g.key === 'restricted') (g.sources || []).forEach(x => { if (x.path.startsWith('Private/')) err(`${ctx}: restricted source is private`); });
    const flagged = new Set((g.affected || []).map(x => x.path + '#' + x.section));
    (g.must_not_flag || []).forEach(x => { if (flagged.has(x.path + '#' + x.section)) err(`${ctx}: ${x.path}#${x.section} both affected and must_not`); });
    // cost
    const seen = new Map();
    const refs = refsOf(t);
    (g.merge || []).forEach(m => m.mentions.forEach(x => { if (!x.path.endsWith('.md')) return; const P = parse(v[x.path]); const sec = P.fm.includes(x.text) ? 'frontmatter' : (P.sections.find(s => s.text.includes(x.text)) || { heading: '' }).heading; refs.push({ path: x.path, section: sec }); }));
    for (const x of refs) { const k = x.path + '#' + x.section; if (seen.has(k)) continue; const st = sectionText(v, x.path, x.section); if (st != null) seen.set(k, tok(st)); }
    t.cost = { best_case_sections: seen.size, best_case_tokens_est: [...seen.values()].reduce((a, b) => a + b, 0), naive_tokens_est: g.key === 'restricted' ? naiveRestricted : naive, estimate: 'utf8 bytes / 4' };
    if (cat === 'context_qa' && t.cost.best_case_tokens_est > g.budget_tokens) err(`${ctx}: best case exceeds budget`);
  }
  counts[cat] = list.length;
}

// ---------- write ----------
if (errs.length) {
  console.error('ERRORS ' + errs.length + '\n' + errs.join('\n'));
  process.exit(1);
}
fs.mkdirSync(OUT, { recursive: true });
if (fs.lstatSync(OUT).isSymbolicLink()) throw new Error('Fixture directory cannot be a symbolic link');
const fixture = fs.realpathSync(OUT);
for (const name of ['vault', 'tasks']) {
  const dir = path.join(fixture, name);
  if (fs.existsSync(dir) && fs.realpathSync(dir) !== dir) throw new Error('Fixture output must stay inside the fixture directory');
  fs.rmSync(dir, { recursive: true, force: true });
}
for (const [p, c] of Object.entries(notes)) { const f = path.join(OUT, 'vault', p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, c); }
for (const [p, b] of Object.entries(binaries)) { const f = path.join(OUT, 'vault', p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, b); }
fs.mkdirSync(OUT + '/tasks', { recursive: true });
const conventions = { paths: 'relative to the generated fixture vault', section: 'heading text | "frontmatter" | "" (whole note)', evidence: 'exact substring that must be present in that section after setup', setup: 'apply to a fresh copy of the vault; replace = exact old→new, occurs once; create = new file' };
for (const [cat, list] of Object.entries(T)) fs.writeFileSync(`${OUT}/tasks/${cat}.json`, JSON.stringify({ category: cat, conventions, tasks: list }, null, 2) + '\n');
fs.copyFileSync(path.join(__dirname, 'collab.json'), path.join(OUT, 'tasks', 'collab.json'));
manifest.counts = { notes_total_md: Object.keys(notes).filter(p => p.endsWith('.md')).length, notes_included: included.length, notes_private: included.filter(p => p.startsWith('Private/')).length, notes_excluded: Object.keys(notes).filter(p => p.endsWith('.md') && isExcluded(p)).length, attachments: Object.keys(binaries).length + 1, wikilinks: linkCount, link_kinds: kinds, unresolved_targets: [...unresolved], naive_tokens_est: naive, tasks: counts, tasks_total: total };
fs.writeFileSync(`${OUT}/manifest.json`, JSON.stringify(manifest, null, 2) + '\n');
const words = included.map(p => notes[p].split(/\s+/).length);
console.log(JSON.stringify(manifest.counts), 'words min/max', Math.min(...words), Math.max(...words));
console.log('SELF-CHECK OK');
