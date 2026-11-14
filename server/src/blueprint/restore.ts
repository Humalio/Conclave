/**
 * Restore from an export (docs/blueprint.md §4.2): read a Blueprint export back into items and links. The JSON export
 * (`conclave-blueprint` v1) carries everything; the Markdown export is read as far as it goes, and what it cannot carry
 * is reported in `lost`. Pure: no database. The plan that turns a snapshot into ops is `Blueprint.restorePlan`.
 */
import { KeyError } from '../keys/keys.js';
import { KINDS } from './kinds.js';
import { SECTION_KINDS, type BpActor, type BpActorKind } from './blueprint.js';
// The JSON format is the export's own (views.exportJson, Developer 8's slice): one definition for both directions.
import { EXPORT_FORMAT, EXPORT_VERSION } from './views.js';

const err = (msg: string) => new KeyError('invalid_argument', msg);

/** The longest export text a restore reads (the API's body limit is 2 MB). */
export const MAX_RESTORE_TEXT = 1_900_000;
/** The section titles of the Markdown export (views.exportMarkdown), by number. */
export const SECTION_TITLES = ['', 'Project Foundation', 'Product Requirements', 'Technical Decisions & Architecture', 'Planning & Execution', 'Tracking & Governance', 'Appendix'];

export interface SnapItem {
  key: string; kind: string; parent_key: string | null; title: string; body: string | null; status: string | null;
  fields: Record<string, unknown>;
  /** Undefined when the file does not say (Markdown): the hub's value is kept, or a new item goes last. */
  position?: number;
  /** Undefined when the file does not say (Markdown); null is project level. */
  team_id?: string | null;
  /** The writers the file names: a claim only, kept as attribution and never used as the writer (§4.2). */
  created_by?: BpActor; updated_by?: BpActor;
  archived?: boolean;
  /** The file carries no title (the architecture in Markdown): the hub's is kept. */
  no_title?: boolean;
  /** Fields the file does not carry (Markdown leaves out `auto`): the hub's values are kept. */
  partial_fields?: boolean;
}
export interface SnapLink { from: string; to: string; rel: string }
export interface Snapshot {
  format: 'json' | 'markdown';
  project: { key: string | null; name: string | null; version: number | null };
  items: SnapItem[]; links: SnapLink[];
  /** What the file could not carry, in plain words, at most one line per kind of loss. */
  lost: string[];
}

/** Either export, told apart by its first character. */
export function parseExport(text: string): Snapshot {
  if (typeof text !== 'string' || !text.trim()) throw err('Paste or upload a Blueprint export (Markdown or JSON).');
  if (text.length > MAX_RESTORE_TEXT) throw err(`An export holds at most ${MAX_RESTORE_TEXT} characters here.`);
  return text.trimStart().startsWith('{') ? parseJson(text) : parseMarkdown(text);
}

// ───── JSON ─────
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const ACTOR_KINDS: BpActorKind[] = ['operator', 'agent', 'import', 'system'];
const actorIn = (v: unknown, where: string): BpActor | undefined => {
  if (v === undefined || v === null) return undefined;
  if (!isObj(v) || !ACTOR_KINDS.includes(v['kind'] as BpActorKind) || !(v['id'] === null || v['id'] === undefined || (typeof v['id'] === 'string' && v['id'].length <= 100))) throw err(`${where}: a writer is {kind: operator|agent|import|system, id}.`);
  return { kind: v['kind'] as BpActorKind, id: (v['id'] as string | null | undefined) ?? null };
};

export function parseJson(text: string): Snapshot {
  let doc: unknown;
  try { doc = JSON.parse(text); } catch { throw err('The JSON export does not parse.'); }
  if (!isObj(doc) || doc['format'] !== EXPORT_FORMAT) throw err(`Not a Blueprint export: its format must be "${EXPORT_FORMAT}" (the admin's JSON export, GET /api/projects/:id/export.json).`);
  if (doc['version'] !== EXPORT_VERSION) throw err(`This hub reads export version ${EXPORT_VERSION}, not ${String(doc['version'])}.`);
  const items = doc['items'], links = doc['links'] ?? [];
  if (!Array.isArray(items) || !Array.isArray(links)) throw err('A Blueprint export holds items and links lists.');
  if (items.length > 20_000 || links.length > 100_000) throw err('The export holds more items or links than any Blueprint can.');
  const seen = new Set<string>();
  const out: SnapItem[] = items.map((x, i) => {
    const at = `item ${i + 1}`;
    if (!isObj(x)) throw err(`${at} is not an object.`);
    const { key, kind, parent_key, title, body, status, fields, position, team_id, archived } = x as Record<string, unknown>;
    if (typeof key !== 'string' || !key || key.length > 60) throw err(`${at}: key is 1 to 60 characters.`);
    if (seen.has(key)) throw err(`${key} appears twice in the export.`);
    seen.add(key);
    if (typeof kind !== 'string' || !KINDS[kind]) throw err(`${key}: unknown kind ${String(kind)}.`);
    if (!(parent_key === null || parent_key === undefined || typeof parent_key === 'string')) throw err(`${key}: parent_key is a key or null.`);
    if (typeof title !== 'string') throw err(`${key}: title is text.`);
    if (!(body === null || body === undefined || typeof body === 'string')) throw err(`${key}: body is text or null.`);
    if (!(status === null || status === undefined || typeof status === 'string')) throw err(`${key}: status is text or null.`);
    if (!(fields === undefined || isObj(fields))) throw err(`${key}: fields is an object.`);
    if (!(position === undefined || (Number.isInteger(position) && (position as number) >= 0))) throw err(`${key}: position is a whole number from 0.`);
    if (!(team_id === undefined || team_id === null || typeof team_id === 'string')) throw err(`${key}: team_id is a team id or null.`);
    return {
      key, kind, parent_key: (parent_key as string | null | undefined) ?? null, title, body: (body as string | null | undefined) ?? null, status: (status as string | null | undefined) ?? null,
      fields: (fields as Record<string, unknown> | undefined) ?? {}, ...(position === undefined ? {} : { position: position as number }), ...(team_id === undefined ? {} : { team_id: team_id as string | null }),
      ...(actorIn(x['created_by'], key) ? { created_by: actorIn(x['created_by'], key)! } : {}), ...(actorIn(x['updated_by'], key) ? { updated_by: actorIn(x['updated_by'], key)! } : {}),
      ...(archived ? { archived: true } : {}),
    };
  });
  const outLinks: SnapLink[] = links.map((l, i) => {
    if (!isObj(l) || typeof l['from'] !== 'string' || typeof l['to'] !== 'string' || typeof l['rel'] !== 'string') throw err(`link ${i + 1} is {from, to, rel}.`);
    return { from: l['from'], to: l['to'], rel: l['rel'] };
  });
  const pj = isObj(doc['project']) ? doc['project'] : {};
  return {
    format: 'json', items: out, links: outLinks, lost: [],
    project: { key: typeof pj['key'] === 'string' ? pj['key'] : null, name: typeof pj['name'] === 'string' ? pj['name'] : null, version: typeof pj['version'] === 'number' ? pj['version'] : null },
  };
}

// ───── Markdown ─────
const ITEM = /^((?: {2})*)- \*\*([^*\s]+)\*\* ?(.*)$/;
const SECTION = /^## ([1-6])\. (.+)$/;

/** The kind of a key in a section, under a parent of a kind: the first kind of the section whose key format and placement fit. */
export function kindOf(key: string, section: number, parentKind: string | null): string | null {
  const kinds = SECTION_KINDS[section] ?? [];
  const fits = (k: string) => {
    const s = KINDS[k]!;
    if (!s.key.test(key)) return false;
    return parentKind ? !!s.parents?.includes(parentKind) : !s.parentRequired;
  };
  return kinds.find(fits) ?? null;
}

/** A field value as the export printed it (fieldLine in views.ts), back to its type; undefined when it cannot be read. */
function fieldValue(type: unknown, name: string, raw: string): unknown {
  if (Array.isArray(type)) return (type as readonly string[]).includes(raw) ? raw : undefined;
  if (type === 'str') return raw;
  if (type === 'bool') return raw === 'true' ? true : raw === 'false' ? false : undefined;
  if (type === 'num') {
    if (/_at$/.test(name) && /^\d{4}-\d{2}-\d{2}$/.test(raw)) { const t = Date.parse(`${raw}T00:00:00Z`); return Number.isFinite(t) ? t : undefined; }
    const n = Number(raw);
    return raw !== '' && Number.isFinite(n) ? n : undefined;
  }
  if (type === 'strs') return raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (type === 'objs' || type === 'obj') { try { return JSON.parse(raw); } catch { return undefined; } }
  return undefined;
}

export function parseMarkdown(text: string): Snapshot {
  const lines = text.split(/\r?\n/);
  const headAt = lines.findIndex((l) => /^# .* · Blueprint$/.test(l));
  if (headAt < 0) throw err('Not a Blueprint export: the Markdown export starts with "# <project> (<KEY>) · Blueprint" (a paper outline cannot be restored).');
  const head = /^# (.*) \(([A-Z0-9-]+)\) · Blueprint$/.exec(lines[headAt]!);
  const gen = /generated by the hub at version (\d+)/.exec(lines.slice(0, headAt).join('\n'));
  const items: SnapItem[] = [], links = new Map<string, SnapLink>(), lost = new Set<string>();
  const seen = new Set<string>();
  let section = 0;
  let arch: string[] | null = null;
  let stack: SnapItem[] = [];
  let cur: SnapItem | null = null, curDepth = 0, body: string[] | null = null;
  const close = () => { if (cur && body) cur.body = body.join('\n'); cur = null; body = null; };
  const endArch = () => {
    if (!arch) return;
    while (arch.length && arch[arch.length - 1] === '') arch.pop();
    while (arch.length && arch[0] === '') arch.shift();
    items.push({ key: 'ARCH', kind: 'architecture', parent_key: null, title: '', no_title: true, body: arch.join('\n') || null, status: null, fields: {} });
    seen.add('ARCH');
    lost.add('The architecture\'s title is not in Markdown: the hub keeps its own (or "Architecture").');
    arch = null;
  };
  for (let n = headAt + 1; n < lines.length; n++) {
    const line = lines[n]!;
    const sec = SECTION.exec(line);
    if (sec && SECTION_TITLES[Number(sec[1])] === sec[2]) { close(); endArch(); section = Number(sec[1]); stack = []; continue; }
    if (section === 3 && line === '### Architecture' && !items.some((i) => KINDS[i.kind] && SECTION_KINDS[3]!.includes(i.kind))) { close(); arch = []; continue; }
    const it = ITEM.exec(line);
    if (arch) {
      // The architecture text runs until the section's first item line after a blank line, or the next section.
      if (!(it && it[1] === '' && lines[n - 1] === '')) { arch.push(line); continue; }
      endArch();
    }
    if (it && section) {
      close();
      const depth = it[1]!.length / 2, key = it[2]!;
      stack = stack.slice(0, depth);
      const parent = depth ? stack[depth - 1] ?? null : null;
      if (depth && !parent) throw err(`${key} (line ${n + 1}) is indented under nothing.`);
      const kind = kindOf(key, section, parent?.kind ?? null);
      if (!kind) throw err(`${key} (line ${n + 1}) is not a key of section ${section}${parent ? ` under ${parent.key}` : ''}.`);
      if (seen.has(key)) throw err(`${key} appears twice in the export.`);
      seen.add(key);
      let rest = it[3]!;
      const spec = KINDS[kind]!;
      const archived = / · archived$/.test(rest);
      if (archived) rest = rest.replace(/ · archived$/, '');
      if (kind === 'paper') rest = rest.replace(/ · \d+ of \d+ supported( · ready)?$/, '');
      if (kind === 'claim') rest = rest.replace(/ · [a-z_]+$/, '');
      let status: string | null = null;
      const m = / · ([a-z_]+)$/.exec(rest);
      if (spec.statuses && m && spec.statuses.includes(m[1]!)) { status = m[1]!; rest = rest.slice(0, -m[0].length); }
      else if (spec.statuses) { status = spec.statuses[0]!; lost.add(`An item with no status in the file gets its kind's first status (${key}).`); }
      const item: SnapItem = { key, kind, parent_key: parent?.key ?? null, title: rest.trim(), body: null, status, fields: {}, partial_fields: true, ...(archived ? { archived: true } : {}) };
      items.push(item);
      stack[depth] = item;
      cur = item; curDepth = depth;
      continue;
    }
    if (!cur) continue;
    const pad = '  '.repeat(curDepth) + '  ';
    if (line.startsWith(`${pad}> `) || line === `${pad}>`) { (body ??= []).push(line.slice(pad.length + 2)); continue; }
    if (line.startsWith(`${pad}- Links: `)) {
      const k = (cur as SnapItem).key;
      for (const part of line.slice(pad.length + 9).split('; ')) {
        const inn = /^([a-z_]+) ← (\S+)$/.exec(part), out = /^([a-z_]+) (\S+)$/.exec(part);
        const l = inn ? { from: inn[2]!, to: k, rel: inn[1]! } : out ? { from: k, to: out[2]!, rel: out[1]! } : null;
        if (l) links.set(`${l.from}|${l.to}|${l.rel}`, l);
        else lost.add(`A link the file does not spell as "rel KEY" was left out (${k}).`);
      }
      continue;
    }
    if (line.startsWith(`${pad}- `)) {
      const c = cur as SnapItem, spec = KINDS[c.kind]!;
      const segs = line.slice(pad.length + 2).split(' · '), pairs: [string, string][] = [];
      for (const s of segs) {
        const f = /^([a-z_]+): (.*)$/.exec(s);
        if (f && spec.fields[f[1]!] !== undefined) pairs.push([f[1]!, f[2]!]);
        else if (pairs.length) pairs[pairs.length - 1]![1] += ` · ${s}`;
        else { lost.add(`A fields line the file does not spell as "field: value" was left out (${c.key}).`); break; }
      }
      for (const [name, raw] of pairs) {
        const v = fieldValue(spec.fields[name], name, raw);
        if (v === undefined) { lost.add(`A field value that does not read as its type was left out (${c.key} ${name}).`); continue; }
        c.fields[name] = v;
        if (/_at$/.test(name)) lost.add('Dates in Markdown keep the day only.');
        if (spec.fields[name] === 'str') lost.add('Line breaks inside a field value are not in Markdown.');
        if (spec.fields[name] === 'strs') lost.add('A list value holding a comma is split at the comma in Markdown.');
      }
      continue;
    }
  }
  close(); endArch();
  if (items.some((i) => i.kind !== 'architecture')) {
    lost.add('Markdown does not say who wrote each item: the hub\'s own record is used where it has the same text, otherwise the item reads as L2.');
    lost.add('Markdown does not say which team owns a part: the hub keeps the team it knows for each key; a track it does not know goes to project level.');
    lost.add('Markdown does not carry positions: items the hub knows keep theirs, new ones go last in file order.');
  }
  return {
    format: 'markdown', items, links: [...links.values()], lost: [...lost],
    project: { key: head?.[2] ?? null, name: head?.[1] ?? null, version: gen ? Number(gen[1]) : null },
  };
}

/** JSON with sorted keys, so two field objects compare by content. */
export function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}
