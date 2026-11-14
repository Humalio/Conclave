/**
 * A task's "In short" (docs/mcp.md, Task summary): the coordinator's plain-text summary, or, when it set none, one the
 * hub makes from the description: its first sentence or two, without Markdown, file paths or commit hashes.
 */

/** The longest summary a coordinator may set. */
export const SHORT_SUMMARY_MAX = 280;
/** The hub's summary is cut to about this many characters. */
export const HUB_SUMMARY_MAX = 200;

/** A coordinator's summary as stored: one line of plain text, trimmed; null when empty (clears it). */
export function normShortSummary(s: string | null | undefined): string | null {
  const v = (s ?? '').replace(/\s+/g, ' ').trim();
  return v ? v.slice(0, SHORT_SUMMARY_MAX) : null;
}

const EXT = '(?:tsx?|jsx?|mjs|cjs|json|md|mdx|ya?ml|toml|sql|py|rs|go|java|kt|cs|cpp|cc|c|h|hpp|css|scss|html?|sh|ps1|txt|csv|ipynb|lock|cfg|ini|xml)';
// Path candidates; isPath decides. A file name without a folder keeps its stem ("SceneDepthClip.tsx:57" reads "SceneDepthClip").
const PATH = /(?:^|(?<=[\s(["'`,;:]))(?:(?:[A-Za-z]:|[.~]{1,2})?[\\/](?:[\w.@-]+[\\/]?)+|(?:[\w.@-]+[\\/])+[\w.@-]*[\\/]?)(?::\d+(?::\d+)?)?/g;
const FILE = new RegExp(`\\b([A-Za-z_][\\w-]*)\\.${EXT}(?::\\d+(?::\\d+)?)?\\b`, 'g');
// A commit hash (or sha256:…): 7 to 40 hex characters with at least one digit and one letter ("decade", "1234567" stay).
const HASH = /\b(?:sha\d+:)?(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/gi;
/** Marks removed text, and the end of a block (a sentence never runs across a paragraph, heading or list item). */
const GONE = '\u0000', BREAK = '\u0001';
/** "a/b" alone is prose ("and/or", "Low/Medium"); a path starts with a drive, . or ~, has two separators, ends in one or names a file. */
const isPath = (m: string): boolean => /^(?:[A-Za-z]:|[.~])/.test(m) || (m.match(/[\\/]/g) ?? []).length >= 2 || /[\\/]$/.test(m) || new RegExp(`\\.${EXT}(?::\\d+)*$`).test(m);

/** Markdown to plain prose: no code, links as their text, no emphasis, headings or list markers. */
function plain(md: string): string {
  const lines: string[] = [];
  let fence = false;
  for (const raw of md.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*(```|~~~)/.test(raw)) { fence = !fence; lines.push(BREAK); continue; }
    if (fence) continue;
    let l = raw.trim();
    if (!l || /^#{1,6}\s/.test(l) || /^(?:[-*_]\s*){3,}$/.test(l) || /^\|/.test(l)) { lines.push(BREAK); continue; }
    const item = /^(?:[-*+]|\d+[.)])\s+/.test(l);
    l = l.replace(/^>\s?/, '').replace(/^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, '');
    if (item) lines.push(BREAK);
    lines.push(l);
  }
  return lines.join('\n').replace(/\s*\n\s*/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]|]+\|)?([^\]]+)\]\]/g, '$2')
    .replace(/<\/?[a-z][^>]*>/gi, '')
    // Inline code: words stay, a file name keeps its stem, anything else (paths, ids, image tags) goes.
    .replace(/`([^`]*)`/g, (_, c: string) => { const v = c.trim(); return /^[A-Za-z][A-Za-z ]*$/.test(v) ? v : /^[A-Za-z_][\w-]*\.[a-z0-9]{1,5}(?::\d+)*$/i.test(v) ? v.split('.')[0]! : GONE; })
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,;:!?]|$)/g, '$1$2')
    .replace(/~~(.+?)~~/g, '$1');
}

/** Paths, URLs and hashes out; parentheses left with no more than a word after that go too. */
function stripIds(s: string): string {
  let t = s.replace(/https?:\/\/\S+/g, GONE).replace(PATH, (m) => { const dot = /\.*$/.exec(m)![0], p = m.slice(0, m.length - dot.length); return isPath(p) ? GONE + dot : m; }).replace(FILE, '$1').replace(HASH, GONE);
  t = t.replace(/\(([^()]*)\)/g, (m, inner: string) => {
    if (!inner.includes(GONE)) return m;
    const rest = inner.replace(new RegExp(GONE, 'g'), ' ').replace(/[\s,;:]+/g, ' ').trim();
    return rest.split(' ').filter(Boolean).length > 1 ? `(${rest})` : GONE;
  });
  return t.replace(new RegExp(`[ \\t]*${GONE}([ \\t]*[,;][ \\t]*${GONE})*`, 'g'), '')
    .replace(/[ \t]+([,.;:!?)])/g, '$1').replace(/\([ \t]+/g, '(').replace(/([,;:])(?=[,;:.])/g, '').replace(/[ \t]{2,}/g, ' ');
}

/** The sentences of each block (a paragraph or a list item), split after . ! ? before a capital, a digit or a quote (not after "e.g."). */
function blocks(s: string): string[][] {
  return s.split(BREAK).map((b) => b.trim().split(/(?<=[.!?])\s+(?=["'(\[]?[A-Z0-9])/).map((x) => x.trim()).filter(Boolean)
    .reduce<string[]>((acc, x) => {
      const prev = acc.at(-1);
      if (prev && /\b(?:e\.g|i\.e|etc|vs|cf|approx|no|fig)\.$/i.test(prev)) acc[acc.length - 1] = `${prev} ${x}`;
      else acc.push(x);
      return acc;
    }, []).filter((x) => /[\p{L}\p{N}]/u.test(x))).filter((b) => b.length > 0);
}

/** Cut at a word boundary with an ellipsis. */
function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = s.slice(0, max - 1), sp = head.lastIndexOf(' ');
  return `${(sp > max * 0.6 ? head.slice(0, sp) : head).replace(/[\s,;:(-]+$/, '')}…`;
}

/**
 * The hub's summary of a description: the first sentence, and the next one of its paragraph while both fit, capped at HUB_SUMMARY_MAX.
 * Null when the description has no prose.
 */
export function hubShortSummary(description: string | null | undefined, max = HUB_SUMMARY_MAX): string | null {
  if (!description || !description.trim()) return null;
  const S = blocks(stripIds(plain(description)))[0];
  if (!S) return null;
  const end = (x: string) => x.replace(/[:;,]$/, '.');
  let out = end(S[0]!);
  if (S[1] && out.length < max * 0.6 && out.length + 1 + S[1].length <= max) out = `${out} ${end(S[1])}`;
  return cut(out, max);
}
