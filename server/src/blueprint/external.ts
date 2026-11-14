/**
 * Outside references on Blueprint items (docs/blueprint.md §2.2 "Outside references", §3 "Outside systems"): the
 * `external` field every kind takes, the project's list of outside systems with the operator's URL templates, the
 * `bp_read {external}` filter and the links the console shows. Agents write only {system, id}; a link is built here
 * from the operator's template, never taken from what an agent wrote.
 */
import { KeyError } from '../keys/keys.js';

export interface ExternalRef { system: string; id: string }
export interface ExternalSystem { system: string; url_template: string | null }

export const EXTERNAL_MAX = 20;
export const SYSTEMS_MAX = 20;
export const ID_MAX = 100;
export const TEMPLATE_MAX = 500;
const SYSTEM_RE = /^[a-z][a-z0-9-]{0,23}$/;

const err = (msg: string, extra?: Record<string, unknown>) => new KeyError('invalid_argument', msg, extra);
const SYSTEM_RULE = 'a system is a short lower-case word: a letter, then up to 23 letters, digits or hyphens (tracker, decision-log, pr)';

/**
 * Check and normalise an item's `external` field. `allowed` is the project's list of systems (null or empty: any
 * system); a reference the item already holds (`kept`) passes it, so taking a system off the list never blocks a later
 * edit. Returns null for an empty list, so writing [] removes the field.
 */
export function checkExternal(v: unknown, allowed: readonly string[] | null, kept: readonly ExternalRef[] = []): ExternalRef[] | null {
  const bad = (why: string) => err(`Field external is a list of at most ${EXTERNAL_MAX} {system, id}: ${why}.`);
  if (!Array.isArray(v)) throw bad('it must be a list');
  if (v.length > EXTERNAL_MAX) throw bad(`this one holds ${v.length}`);
  const out: ExternalRef[] = [], seen = new Set<string>();
  for (const x of v) {
    if (!x || typeof x !== 'object' || Array.isArray(x)) throw bad('each entry is an object {system, id}');
    const extra = Object.keys(x).filter((k) => k !== 'system' && k !== 'id');
    if (extra.length) throw bad(`an entry holds only system and id, not ${extra.join(', ')} (links come from the project's outside systems, set by the operator)`);
    const { system, id } = x as { system?: unknown; id?: unknown };
    if (typeof system !== 'string' || !SYSTEM_RE.test(system)) throw bad(SYSTEM_RULE);
    if (typeof id !== 'string' || !id.trim() || id.trim().length > ID_MAX || /[\u0000-\u001f\u007f]/.test(id)) throw bad(`an id is 1 to ${ID_MAX} characters on one line`);
    if (allowed?.length && !allowed.includes(system) && !kept.some((r) => r.system === system && r.id === id.trim())) {
      throw err(`This project takes outside references from ${allowed.join(', ')} only, not ${system}. The operator sets the list in Project settings.`, { systems: [...allowed] });
    }
    const ref = { system, id: id.trim() }, k = `${ref.system}:${ref.id}`;
    if (seen.has(k)) throw bad(`${system} ${ref.id} is named twice`);
    seen.add(k); out.push(ref);
  }
  return out.length ? out : null;
}

/** The project's outside systems as stored (projects.external_systems, JSON), [] when none or unreadable. */
export function parseSystems(raw: string | null | undefined): ExternalSystem[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((s): s is ExternalSystem => !!s && typeof s.system === 'string').map((s) => ({ system: s.system, url_template: typeof s.url_template === 'string' ? s.url_template : null })) : [];
  } catch { return []; }
}

/** Check the operator's list of outside systems; null or [] clears it. Returns the JSON to store, or null. */
export function checkSystems(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (!Array.isArray(v)) throw err('Outside systems are a list of {system, url_template}.');
  if (v.length > SYSTEMS_MAX) throw err(`A project lists at most ${SYSTEMS_MAX} outside systems.`);
  const out: ExternalSystem[] = [], seen = new Set<string>();
  for (const x of v) {
    if (!x || typeof x !== 'object' || Array.isArray(x)) throw err('Each outside system is {system, url_template}.');
    const { system, url_template: t } = x as { system?: unknown; url_template?: unknown };
    if (typeof system !== 'string' || !SYSTEM_RE.test(system)) throw err(`Outside system "${String(system)}": ${SYSTEM_RULE}.`);
    if (seen.has(system)) throw err(`Outside system ${system} is listed twice.`);
    seen.add(system);
    let tpl: string | null = null;
    if (t !== undefined && t !== null && t !== '') {
      if (typeof t !== 'string') throw err(`The URL template of ${system} is text.`);
      tpl = t.trim();
      if (tpl.length > TEMPLATE_MAX || templateOrigin(tpl) === null) {
        throw err(`The URL template of ${system} must start with https:// and a fixed host, contain {id} only in the path or the query, and have at most ${TEMPLATE_MAX} characters, such as https://tracker.example/story/{id}.`);
      }
    }
    out.push({ system, url_template: tpl });
  }
  return out.length ? JSON.stringify(out) : null;
}

/**
 * The fixed origin of a URL template, or null when the template is not one the hub links with (§3): https, a host with
 * no {id}, user name or port trick in it, and {id} only in the path or the query, never in the host or the fragment.
 */
export function templateOrigin(tpl: string): string | null {
  if (!tpl.startsWith('https://') || !tpl.includes('{id}') || /[\s\\]/.test(tpl)) return null;
  const rest = tpl.slice('https://'.length);
  const end = rest.search(/[/?#]/);
  if (end <= 0) return null; // no host, or {id} could only sit in the host
  const authority = rest.slice(0, end);
  if (/[{}@]/.test(authority)) return null;
  const hash = rest.indexOf('#');
  if (hash !== -1 && rest.indexOf('{id}', hash) !== -1) return null; // {id} in the fragment
  try {
    const a = new URL(tpl.split('{id}').join('a')), b = new URL(tpl.split('{id}').join('b'));
    if (a.protocol !== 'https:' || !a.hostname || a.username || a.password || a.origin !== b.origin) return null;
    return a.origin;
  } catch { return null; }
}

/**
 * The link of one reference: the system's template with the id URL-encoded, or null when the system has none.
 * The link must keep the template's origin; any template that fails the check (an older one, say) gives no link.
 */
export function refUrl(ref: ExternalRef, systems: readonly ExternalSystem[]): string | null {
  const t = systems.find((s) => s.system === ref.system)?.url_template;
  const origin = t ? templateOrigin(t) : null;
  if (!t || !origin) return null;
  const url = t.split('{id}').join(encodeURIComponent(ref.id));
  try { return new URL(url).origin === origin ? url : null; } catch { return null; }
}

/** An item's references as stored, [] when none. */
export function refsOf(fields: Record<string, unknown> | null | undefined): ExternalRef[] {
  const v = fields?.['external'];
  return Array.isArray(v) ? v.filter((r): r is ExternalRef => !!r && typeof r.system === 'string' && typeof r.id === 'string') : [];
}

/** `bp_read {external}`: "system:id" or "system:*". */
export function parseExternalFilter(s: string): { system: string; id: string | null } {
  const at = s.indexOf(':');
  const system = at < 0 ? s.trim() : s.slice(0, at).trim(), id = at < 0 ? '' : s.slice(at + 1).trim();
  if (!SYSTEM_RE.test(system) || !id) throw err(`external is "system:id" or "system:*", such as "tracker:90048"; ${SYSTEM_RULE}.`);
  return { system, id: id === '*' ? null : id };
}
