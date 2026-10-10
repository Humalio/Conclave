/** Markdown parsing for the knowledge graph (design/13 §3, §5): sections with hashes, links, frontmatter, near-duplicate sketches. No LLM. */
import { createHash } from 'node:crypto';

export interface Section { anchor: string; heading: string; hash: string; start: number; end: number; tokens: number; text: string }
export interface Link { kind: 'link' | 'embed'; target: string; anchor: string; fromAnchor: string }
export interface Parsed { sections: Section[]; links: Link[]; fm: Record<string, string[]> }

export const estTokens = (s: string): number => Math.ceil(Buffer.byteLength(s, 'utf8') / 4);
export const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();
const h = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 32);
export const slug = (s: string): string => s.toLowerCase().replace(/[`*_~]/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-') || 'section';

/** Frontmatter: `key: value`, `key: [a, b]` and `key:` followed by `- item` lines. Returns the body offset. */
function frontmatter(src: string): { fm: Record<string, string[]>; body: number } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(src);
  if (!m) return { fm: {}, body: 0 };
  const fm: Record<string, string[]> = {};
  let key: string | null = null;
  const clean = (v: string) => v.trim().replace(/^["']|["']$/g, '').trim();
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (kv) {
      key = kv[1]!.toLowerCase();
      const v = kv[2]!.trim();
      fm[key] = [];
      if (v.startsWith('[') && v.endsWith(']')) fm[key] = v.slice(1, -1).split(',').map(clean).filter(Boolean);
      else if (v) fm[key] = [clean(v)];
    } else if (key && /^\s*-\s+/.test(line)) fm[key]!.push(clean(line.replace(/^\s*-\s+/, '')));
  }
  return { fm, body: m[0].length };
}

export function parse(src: string): Parsed {
  const { fm, body } = frontmatter(src);
  const sections: Section[] = [];
  const used = new Map<string, number>();
  let cur: { anchor: string; heading: string; start: number } | null = { anchor: '_top', heading: '', start: body };
  let fence = false, pos = body;
  const close = (end: number) => {
    if (!cur) return;
    const text = src.slice(cur.start, end);
    if (cur.anchor === '_top' && text.trim() === '') return;
    sections.push({ anchor: cur.anchor, heading: cur.heading, hash: h(norm(text)), start: cur.start, end, tokens: estTokens(text), text });
  };
  for (const line of src.slice(body).split('\n')) {
    const len = line.length + 1;
    if (/^\s{0,3}(```|~~~)/.test(line)) fence = !fence;
    const hm = !fence ? /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line) : null;
    if (hm) {
      close(pos);
      let a = slug(hm[2]!);
      const n = (used.get(a) ?? 0) + 1; used.set(a, n);
      if (n > 1) a = `${a}-${n}`;
      cur = { anchor: a, heading: hm[2]!.trim(), start: pos };
    }
    pos += len;
  }
  close(Math.min(pos, src.length));
  const links: Link[] = [];
  for (const s of sections) {
    for (const m of s.text.matchAll(/(!?)\[\[([^\]|#\n]+)(?:#([^\]|\n]+))?(?:\|[^\]\n]*)?\]\]/g)) {
      links.push({ kind: m[1] ? 'embed' : 'link', target: m[2]!.trim(), anchor: m[3] ? slug(m[3]) : '', fromAnchor: s.anchor });
    }
    for (const m of s.text.matchAll(/\[[^\]\n]*\]\(([^)\s#]+\.md)(?:#([^)\s]*))?\)/gi)) {
      if (/^[a-z]+:\/\//i.test(m[1]!)) continue;
      links.push({ kind: 'link', target: decodeURIComponent(m[1]!), anchor: m[2] ? slug(m[2]) : '', fromAnchor: s.anchor });
    }
  }
  return { sections, links, fm };
}

/** Extract the target of a frontmatter reference: `[[Note]]`, `[[Note#H]]`, or a path. */
export function fmTarget(v: string): { target: string; anchor: string } {
  const m = /^\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|[^\]]*)?\]\]$/.exec(v.trim());
  if (m) return { target: m[1]!.trim(), anchor: m[2] ? slug(m[2]) : '' };
  return { target: v.trim(), anchor: '' };
}

const words = (s: string) => s.toLowerCase().normalize('NFKC').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const K = 32;
/** MinHash over word 3-shingles; null for short sections. */
export function minhash(text: string): number[] | null {
  const w = words(text);
  if (w.length < 15) return null;
  const sig = new Array<number>(K).fill(0xffffffff);
  for (let i = 0; i + 3 <= w.length; i++) {
    const base = createHash('md5').update(w.slice(i, i + 3).join(' ')).digest();
    for (let k = 0; k < K; k++) {
      const v = (base.readUInt32LE((k % 4) * 4) ^ Math.imul(k + 1, 0x9e3779b1)) >>> 0;
      const x = (Math.imul(v ^ (v >>> 15), 0x85ebca6b) >>> 0) ^ (base.readUInt32LE(((k + 1) % 4) * 4));
      const y = x >>> 0;
      if (y < sig[k]!) sig[k] = y;
    }
  }
  return sig;
}
export function jaccard(a: number[], b: number[]): number {
  let same = 0;
  for (let i = 0; i < K; i++) if (a[i] === b[i]) same++;
  return same / K;
}
