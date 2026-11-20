/**
 * Plain writing checks for the Blueprint (docs/blueprint.md §2.7, docs/proposals/blueprint-readability.md §2.1): the
 * summary/Records split, private codes and the glossary that defines them, and acceptance criteria that say nothing to
 * check. Pure functions, no database: blueprint.ts feeds them live rows.
 */
import { KINDS } from './kinds.js';

/** The heading that starts the Records part of a body (§1.1). Only the first match outside a fenced code block counts. */
const RECORDS = /^#{2,3}[ \t]*Records[ \t]*$/i;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Where the Records heading starts and ends, or null. A line inside a fenced code block (``` or ~~~, closed by a fence of
 * the same character at least as long, with nothing after it) is never the heading, so a quoted "## Records" stays in
 * its code block. public/app.js mirrors it (bpRecordsAt).
 */
export function recordsAt(s: string): { start: number; end: number } | null {
  let at = 0, fence: string | null = null;
  for (const line of s.split('\n')) {
    const l = line.replace(/\r$/, ''), f = FENCE.exec(l);
    if (fence) { if (f && f[1]![0] === fence[0] && f[1]!.length >= fence.length && !l.slice(f[0].length).trim()) fence = null; }
    else if (f) fence = f[1]!;
    else if (RECORDS.test(l)) return { start: at, end: at + l.length };
    at += line.length + 1;
  }
  return null;
}

export function splitBody(body: string | null | undefined): { summary: string; records: string | null } {
  const s = body ?? '';
  const m = recordsAt(s);
  if (!m) return { summary: s.trim(), records: null };
  return { summary: s.slice(0, m.start).trim(), records: s.slice(m.end).trim() };
}

const PRIMES = /[′’']/g;
const normPrime = (t: string) => t.replace(PRIMES, '′');

/** The G- key a term for this code gets: T′ → t-prime, H_oa → h-oa, CF-28 → cf-28. public/app.js mirrors it. */
export function slugCode(token: string): string {
  return normPrime(String(token)).toLowerCase().replace(/′/g, '-prime').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
}

export interface TermRef { key: string; title: string; definition: string }
export interface Known {
  /** Normalised term title or alias → term. */
  byToken: Map<string, TermRef>;
  /** The same, lower-cased: only all-capital tokens look here. */
  byLower: Map<string, TermRef>;
  /** G- keys → term. */
  slugs: Map<string, TermRef>;
  /** Live item keys and the project key: never codes. */
  keys: Set<string>;
}

const TOKEN = /[\p{L}\p{N}][\p{L}\p{N}_′'’.\-/]*/gu;
const STRIP = [
  /`[^`\n]*`/g, // code spans
  /\]\([^)\s]*\)/g, // Markdown link targets
  /\bhttps?:\/\/\S+/gi, // bare URLs
  /\bagent-[a-z0-9]{5,12}\b/g, // agent ids (E2): the console shows them as names
];
const VERSION = /^v?\d+(\.\d+)+[a-z]?$/i;
const UNIT = /^\d+([.,]\d+)?(st|nd|rd|th|[a-zµ]{1,3})$/i;
const DATE = /^\d{4}-\d{2}(-\d{2})?$/;
const LETTER = /\p{L}/u, DIGIT = /\p{N}/u;

/** A token with trailing punctuation trimmed; a 1–3 letter prime (T') keeps its prime. */
function trimToken(t: string): string {
  let s = t.replace(/[.,;:)]+$/, '');
  if (!/^\p{L}{1,3}['’′]$/u.test(s)) s = s.replace(/[.,;:)'’]+$/, '');
  return s;
}

/** A path ("Projects/EXAMPLE/03", "src/app.ts") is not a code: it names a place the reader can open. */
function isCode(t: string): boolean {
  if (t.includes('/')) return false;
  if (VERSION.test(t) || UNIT.test(t) || DATE.test(t)) return false;
  if (LETTER.test(t) && DIGIT.test(t)) return true;
  if (/\p{L}_\p{L}/u.test(t)) return true;
  return /^\p{L}{1,3}[′'’]$/u.test(t);
}

/** Every token of a text after stripping code spans, link targets, URLs and agent ids, in order. */
function tokens(text: string): string[] {
  let s = String(text ?? '');
  for (const re of STRIP) s = s.replace(re, ' ');
  const out: string[] = [];
  for (const m of s.matchAll(TOKEN)) { const t = trimToken(m[0]); if (t) out.push(t); }
  return out;
}

/** The private codes of a text: unique, in order of first appearance, keys and the project key left out. */
export function findCodes(text: string, known: Pick<Known, 'keys'>): string[] {
  const seen = new Set<string>(), out: string[] = [];
  for (const t of tokens(text)) {
    if (known.keys.has(t) || seen.has(t) || !isCode(t)) continue;
    seen.add(t); out.push(t);
  }
  return out;
}

/** Every word of a text that names a term, even one findCodes would not flag (an all-caps term like RC). */
export function termWords(text: string, known: Known): { token: string; term: TermRef }[] {
  const seen = new Set<string>(), out: { token: string; term: TermRef }[] = [];
  for (const t of tokens(text)) {
    if (seen.has(t) || known.keys.has(t)) continue;
    const term = known.byToken.get(normPrime(t)) ?? (allCaps(t) ? known.byLower.get(normPrime(t).toLowerCase()) : undefined);
    if (term) { seen.add(t); out.push({ token: t, term }); }
  }
  return out;
}

const allCaps = (t: string) => /\p{Lu}/u.test(t) && !/\p{Ll}/u.test(t);

/** The first sentence of a summary, at most 200 characters. */
export function firstSentence(text: string): string {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  const m = /^(.+?[.!?])(\s|$)/.exec(s);
  const one = m ? m[1]! : s;
  return one.length > 200 ? one.slice(0, 199) + '…' : one;
}

export interface TermRow { key: string; title: string; body: string | null; fields: Record<string, unknown> | null }

/** The glossary a project's live terms make, and the keys that are never codes. */
export function glossaryOf(terms: TermRow[], keys: Iterable<string>): Known {
  const byToken = new Map<string, TermRef>(), byLower = new Map<string, TermRef>(), slugs = new Map<string, TermRef>();
  for (const t of terms) {
    const ref: TermRef = { key: t.key, title: t.title, definition: firstSentence(splitBody(t.body).summary) };
    slugs.set(t.key, ref);
    const aliases = Array.isArray(t.fields?.aliases) ? (t.fields!.aliases as unknown[]).filter((a): a is string => typeof a === 'string') : [];
    for (const name of [t.title, ...aliases]) {
      const n = normPrime(name.trim());
      if (!n) continue;
      if (!byToken.has(n)) byToken.set(n, ref);
      if (!byLower.has(n.toLowerCase())) byLower.set(n.toLowerCase(), ref);
    }
  }
  return { byToken, byLower, slugs, keys: new Set(keys) };
}

/** The term that defines a token, or null when it is not defined. */
export function resolve(token: string, known: Known): TermRef | null {
  const n = normPrime(token);
  return known.byToken.get(n)
    ?? (allCaps(token) ? known.byLower.get(n.toLowerCase()) : undefined)
    ?? known.slugs.get(`G-${slugCode(token)}`)
    ?? null;
}

/** An acceptance title that names nothing to check. */
export const EMPTY_AC_TITLE = /^\s*(acceptance( criteri(on|a))?|criteri(on|a)|ac\s*\d*|tbd|todo)\s*$/i;

export interface Merged { title: string; body: string | null; fields: Record<string, unknown> }
const blank = (v: unknown) => typeof v !== 'string' || !v.trim();

/** True when an acceptance criterion gives the operator nothing to check (§2.1). */
export function acceptanceEmpty(m: Merged): boolean {
  const f = m.fields ?? {};
  if (blank(f.given) && blank(f.when) && blank(f.then) && !splitBody(m.body).summary) return true;
  return EMPTY_AC_TITLE.test(m.title ?? '') && blank(f.then);
}

/** The code a title starts with, when it is followed by a colon (E2 code_first): "CF-28: …" → CF-28. */
export function leadingCode(title: string, known: Pick<Known, 'keys'>): string | null {
  const m = /^\s*([^\s:]+)\s*:/.exec(String(title ?? ''));
  if (!m) return null;
  const t = trimToken(m[1]!);
  return t && !known.keys.has(t) && isCode(t) ? t : null;
}

/** Tokens findCodes matches that are noise for evidence hints (E2): hashes, ids, bare C3/AC1 that are not keys. */
const ID_PREFIX = /^(run|job|ses|task|dec|bpi|team|room|agent|shr|fil)[_-]/i;
export function isNoiseCode(t: string, known: Pick<Known, 'keys'>): boolean {
  if (/^[0-9a-f]{7,40}$/.test(t)) return true;
  if (ID_PREFIX.test(t)) return true;
  return /^(A?C)\d+$/.test(t) && !known.keys.has(t);
}

/** Where a cited source lives (E4.2): a vault path, or outside the vault (a commit, URL or absolute drive path). */
export function classifySource(text: string): 'vault' | 'outside' | null {
  const s = String(text ?? '').trim();
  if (!s) return null;
  if (/^[0-9a-f]{7,40}$/.test(s) || /^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^[A-Za-z]:[\\/]/.test(s)) return 'outside';
  if (/\.md$/i.test(s) || s.includes('/')) return 'vault';
  return null;
}

/** Blueprint key forms (kinds.ts) that can stand for an item in cited text; a module's bare capitals and SUM/ARCH would match ordinary words. */
const KEY_FORMS = Object.entries(KINDS).filter(([k, s]) => k !== 'module' && k !== 'ac' && !s.single).map(([, s]) => s.key);
/** An AC is <parent>/ACn; the parent must look like a key (a capital first, a digit last), so Notes/AC1 stays a path. */
const AC_FORM = /^[A-Z][A-Za-z0-9.-]*\d\/AC\d+$/;
/** True when a cited text has the form of a Blueprint key (PAP-1/C8, FR-TEAM-04/AC2, H-L1-02): an item, never a file. */
export function isItemKey(text: string): boolean {
  const t = String(text ?? '').trim();
  return !!t && (AC_FORM.test(t) || KEY_FORMS.some((re) => re.test(t)));
}

const OPEN: Record<string, string> = { '(': ')', '[': ']', '<': '>' };
const CLOSE: Record<string, string> = { ')': '(', ']': '[', '>': '<' };
const count = (s: string, c: string) => s.split(c).length - 1;
/** Quotes and end punctuation off both ends; a bracket only when it has no partner, so "Meeting (2024)" keeps its own. */
export function trimCited(raw: string): string {
  let s = String(raw ?? '').trim(), was = '';
  while (s !== was) {
    was = s;
    s = s.replace(/^["'`]+|["'`.,;:]+$/g, '').trim();
    const a = s[0] ?? '', z = s.at(-1) ?? '';
    if (OPEN[a] && OPEN[a] === z && count(s.slice(1, -1), a) === count(s.slice(1, -1), z)) s = s.slice(1, -1);
    else if (CLOSE[z] && count(s, z) > count(s, CLOSE[z]!)) s = s.slice(0, -1);
    else if (OPEN[a] && count(s, a) > count(s, OPEN[a]!)) s = s.slice(1);
    s = s.trim();
  }
  return s;
}

const WIKI = /\[\[([^\]\n]+?)\]\]/g;
/** A wikilink's target: before its label (|) and heading (#). */
const wikiTarget = (inner: string) => inner.split('|')[0]!.split('#')[0]!.trim();
const hasExt = (s: string) => /\.[A-Za-z0-9]{1,8}$/.test(s.trim());
/**
 * A source field's text in parts: on new lines and ;, then on commas, except that a comma stays inside a name when the
 * text before it has no extension and the text after it, up to .md, has no slash ("Notes/Smith, 2020.md" is one file,
 * "a.md, b.md" two), then before a path that starts with /.
 */
function fieldParts(v: string): string[] {
  const out: string[] = [];
  for (const seg of v.split(/[\n;]+/)) {
    const bits = seg.split(',');
    for (let i = 0; i < bits.length; i++) {
      let cur = bits[i]!;
      while (i + 1 < bits.length && !hasExt(cur) && !/^\s*[0-9a-f]{7,40}\s*$/.test(cur) && /^[^/]*\.md$/i.test(bits[i + 1]!.trim())) cur += `,${bits[++i]}`;
      out.push(...cur.split(/\s+(?=\/)/));
    }
  }
  return out;
}

/**
 * The one parser for what an item cites (E4.1; docs/blueprint.md §2.7 "Reading what is cited"), used by every pass here,
 * by bp_write's warnings and by Meetings: evidence, manuscript and source fields, [[wikilinks]] anywhere in the body, and
 * paths above Records. Wikilinks are taken whole first; then a text in the form of a Blueprint key is an item (`keys`),
 * never a file; then what is left is split; brackets are trimmed only when unbalanced.
 */
export function citedRefs(item: { body: string | null; fields: Record<string, unknown> | null }): { sources: string[]; keys: string[] } {
  const sources: string[] = [], keys: string[] = [], seen = new Set<string>();
  const add = (raw: string, wiki = false) => {
    const s = wiki ? raw.trim() : trimCited(raw);
    if (!s || seen.has(s) || s.length > 400) return;
    if (/^bp:|^share:|^task:/.test(s)) return; // references to other Conclave things, not files
    seen.add(s);
    if (!wiki && isItemKey(s)) keys.push(s); else sources.push(s);
  };
  const f = item.fields ?? {};
  for (const k of ['evidence', 'manuscript', 'source']) {
    const v = f[k];
    if (typeof v !== 'string' || !v.trim()) continue;
    for (const m of v.matchAll(WIKI)) add(wikiTarget(m[1]!), true);
    for (const part of fieldParts(v.replace(WIKI, ' '))) {
      const p = trimCited(part);
      if (isItemKey(p) || classifySource(p)) add(p);
    }
  }
  // [[Wikilinks]] are vault links wherever they stand. Other paths count only above Records: Records hold repository
  // paths, hashes and ids for the record (§1.1), so a path there is not a vault source and is never reported missing.
  const whole = String(item.body ?? '').replace(/```[\s\S]*?```/g, ' ');
  for (const m of whole.matchAll(WIKI)) add(wikiTarget(m[1]!), true);
  const body = splitBody(String(item.body ?? '')).summary.replace(/```[\s\S]*?```/g, ' ').replace(WIKI, ' ');
  for (const m of body.matchAll(/`([^`\n]+)`/g)) { const p = m[1]!.trim(); if (isItemKey(p) || /\.md$/i.test(p) || (/^[^\s]+\/[^\s]+$/.test(p) && !/^https?:/i.test(p))) add(p); }
  const prose = body.replace(/`[^`\n]*`/g, ' ').replace(/\]\([^)]*\)/g, ' ');
  for (const m of prose.matchAll(/(?:^|\s)((?:\/)?(?:[\p{L}\p{N}_ .()-]|(?<!\.\w{1,8}),(?=[^/,\n]*\.md))+(?:\/(?:[\p{L}\p{N}_ .()-]|(?<!\.\w{1,8}),(?=[^/,\n]*\.md))+)+\.md)\b/gu)) add(m[1]!);
  return { sources, keys };
}

/** The sources an item cites (E4.1): evidence, manuscript, source fields, [[wikilinks]] and paths in the body; keys left out. */
export function citedSources(item: { body: string | null; fields: Record<string, unknown> | null }): string[] {
  return citedRefs(item).sources;
}

// ───── warnings (proposal §4 and addendum E2, E4.6): never refusals ─────
export type WarningKind = 'undefined_code' | 'empty_ac' | 'code_first' | 'final_unsupported' | 'unlinked_evidence' | 'source_missing' | 'key_missing';
export interface Warning {
  key: string; kind: WarningKind; tokens?: string[]; title: string; message: string;
  /** unlinked_evidence: the item that mentions the shared code; final_unsupported: the verdict; source_missing and key_missing: the cited text. */
  other?: string; verdict?: string; source?: string;
}
export interface PlainCheck { warnings: Warning[]; pending: { key: string; tokens: string[] }[] }

const one = (n: number, a: string, b: string) => (n === 1 ? a : b);
export const warn = {
  undefined_code: (key: string, title: string, tokens: string[]): Warning => ({ key, kind: 'undefined_code', tokens, title,
    message: `${key} title uses ${tokens.join(', ')}, which the operator cannot look up. Say what ${one(tokens.length, 'it is', 'they are')} in words, or keep ${one(tokens.length, 'it', 'them')} and propose a term each: {op: upsert, kind: term, key: G-${slugCode(tokens[0]!)}, title: "${tokens[0]}", body: "<one plain sentence>", fields: {aliases: ["${tokens[0]}"]}}.` }),
  empty_ac: (key: string, title: string): Warning => ({ key, kind: 'empty_ac', title,
    message: `${key} says nothing to check${EMPTY_AC_TITLE.test(title) ? ` (titled "${title}")` : ''}. Give it given, when and then a person can check, and a title that says what is checked.` }),
  code_first: (key: string, title: string, token: string): Warning => ({ key, kind: 'code_first', tokens: [token], title,
    message: `${key} title starts with ${token}. Start with what it says; put ${token} under Records.` }),
  final_unsupported: (key: string, title: string, verdict: string): Warning => ({ key, kind: 'final_unsupported', title, verdict,
    message: `${key} is final but ${verdict === 'contradicted' ? 'its evidence contradicts it' : 'no decided evidence backs it'}. Link the hypothesis or finding that backs it, or set it back to draft.` }),
  unlinked_evidence: (key: string, title: string, other: string, token: string): Warning => ({ key, kind: 'unlinked_evidence', tokens: [token], title, other,
    message: `${key} has no evidence, but ${other} mentions ${token}. Link it if it backs the claim: {op: link, from: ${other}, to: ${key}, rel: evidence}.` }),
  source_missing: (key: string, title: string, text: string): Warning => ({ key, kind: 'source_missing', title, source: text,
    message: `${key} cites ${text}, which is not in the vault, so the operator cannot open it. Put the file in your team's vault folder, or ask your coordinator to, and cite it as [[name]].` }),
  key_missing: (key: string, title: string, text: string): Warning => ({ key, kind: 'key_missing', title, source: text,
    message: `${key} cites ${text}, which is no item in this Blueprint. Fix the key, or link the item it means.` }),
};

/** The short form bp_read {plain: "issues"} and the console list show (§2.2 plain_issues). */
export function issueText(w: Warning): string {
  switch (w.kind) {
    case 'undefined_code': return `title codes: ${(w.tokens ?? []).join(', ')}`;
    case 'empty_ac': return 'acceptance says nothing to check';
    case 'code_first': return `title starts with ${w.tokens?.[0]}`;
    case 'final_unsupported': return w.verdict === 'contradicted' ? 'final, but its evidence contradicts it' : 'final, but no decided evidence backs it';
    case 'unlinked_evidence': return `no evidence, but ${w.other} mentions ${w.tokens?.[0]}`;
    case 'source_missing': return `cites ${w.source}, which is not in the vault`;
    case 'key_missing': return `cites ${w.source}, which is no item in this Blueprint`;
  }
}

/** The paragraph bp_write appends after its unchanged first sentence (§4): at most 8 warning lines, then the pending terms. */
export function warningText(c: PlainCheck): string {
  if (!c.warnings.length && !c.pending.length) return '';
  const lines: string[] = [];
  if (c.warnings.length) {
    lines.push('For the operator (the write went through; fix these in your next write):');
    for (const w of c.warnings.slice(0, 8)) lines.push(`- ${w.message}`);
    if (c.warnings.length > 8) lines.push(`- and ${c.warnings.length - 8} more: bp_read {plain: "issues"}`);
  }
  if (c.pending.length) {
    const toks = [...new Set(c.pending.flatMap((p) => p.tokens))];
    lines.push(`Terms waiting for the operator: ${c.pending.map((p) => p.key).join(', ')}.${toks.length ? ` Until the operator applies them, ${toks.join(', ')} ${one(toks.length, 'shows', 'show')} as not defined.` : ''}`);
  }
  return lines.join('\n');
}
