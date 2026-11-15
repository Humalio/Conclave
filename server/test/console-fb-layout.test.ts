/**
 * Feedback report screen layout (design-guidelines.md, Feedback report): from 1024 px the queue sits beside the report; the report's
 * details column joins it only from 1440 px, and below that the details come after the agent's account. The account shows two cells
 * side by side only when its own width gives each about 260 px (a container query, not a viewport width).
 * The CSS is evaluated here at a given viewport width: the top-level @media blocks that match, in source order.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const css = readFileSync(join(process.cwd(), 'public', 'style.css'), 'utf8').replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');

type Rule = { sel: string[]; decl: Record<string, string>; media: string };
/** A selector list split at its top-level commas (not those inside :not(…) or :has(…)). */
const splitTop = (s: string) => { const out: string[] = []; let d = 0, cur = ''; for (const c of s) { if (c === '(') d++; else if (c === ')') d--; if (c === ',' && d === 0) { out.push(cur.trim()); cur = ''; } else cur += c; } out.push(cur.trim()); return out; };
/** Flat rules with the at-rule they sit in ('' at the top level); one level of nesting, which is all style.css uses. */
function rules(src: string, media = ''): Rule[] {
  const out: Rule[] = []; let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i); if (open < 0) break;
    const head = src.slice(i, open).trim();
    let depth = 1, j = open + 1;
    while (depth && j < src.length) { if (src[j] === '{') depth++; else if (src[j] === '}') depth--; j++; }
    const body = src.slice(open + 1, j - 1);
    if (head.startsWith('@')) { if (/^@(media|container)/.test(head)) out.push(...rules(body, head)); }
    else {
      const decl: Record<string, string> = {};
      for (const d of body.split(';')) { const k = d.indexOf(':'); if (k > 0) decl[d.slice(0, k).trim()] = d.slice(k + 1).trim(); }
      out.push({ sel: splitTop(head), decl, media });
    }
    i = j;
  }
  return out;
}
const ALL = rules(css);
const matches = (media: string, w: number) => {
  if (!media) return true;
  if (!media.startsWith('@media')) return false;
  const min = media.match(/min-width:\s*([\d.]+)px/), max = media.match(/max-width:\s*([\d.]+)px/);
  if (/prefers-|hover|pointer|print/.test(media)) return false;
  return (!min || w >= Number(min[1])) && (!max || w <= Number(max[1]));
};
/** The value a viewport of width w ends up with for prop on exactly this selector (no specificity beyond source order). */
const at = (sel: string, prop: string, w: number) => {
  let v: string | undefined;
  for (const r of ALL) if (r.sel.includes(sel) && prop in r.decl && matches(r.media, w)) v = r.decl[prop];
  return v;
};
const tracks = (v: string) => { let d = 0, n = 1; for (const c of v.trim()) { if (c === '(') d++; else if (c === ')') d--; else if (c === ' ' && d === 0) n++; } return n; };
/** Columns the selector lays out at width w: 1 unless it is a grid. */
const cols = (sel: string, w: number) => (at(sel, 'display', w) === 'grid' ? tracks(at(sel, 'grid-template-columns', w) || 'none') : 1);

describe('feedback report columns', () => {
  it('at 1280 px: the queue beside the report, and the report in one column with the details under the account', () => {
    expect(cols('.fbx', 1280)).toBe(2);
    expect(cols('.fb-cols', 1280)).toBe(1);
    expect(at('.fb-main', 'display', 1280)).toBe('contents');
    expect(at('.fb-side', 'order', 1280)).toBe('1');
  });
  it('at 1600 px: three columns, the queue, the report and the 250 px details', () => {
    expect(cols('.fbx', 1600)).toBe(2);
    expect(cols('.fb-cols', 1600)).toBe(2);
    expect(at('.fb-cols', 'grid-template-columns', 1600)).toBe('minmax(0,1fr) 250px');
    expect(at('.fb-main', 'display', 1600)).toBe('flex');
  });
  it('switches exactly at 1440 px', () => {
    expect(cols('.fb-cols', 1439.98)).toBe(1);
    expect(cols('.fb-cols', 1440)).toBe(2);
  });
  it('keeps the phone and tablet layout: no queue, one column, details after the account', () => {
    for (const w of [375, 800]) {
      expect(cols('.fbx', w)).toBe(1);
      expect(cols('.fb-cols', w)).toBe(1);
      expect(at('.fb-queue', 'display', w)).toBe('none');
      expect(at('.fb-main', 'display', w)).toBe('contents');
    }
  });
});

describe("the agent's account grid", () => {
  it('is one cell per row unless its container fits two cells of about 260 px', () => {
    expect(at('.fb-acct', 'grid-template-columns', 1600)).toBe('minmax(0,1fr)');
    const wide = ALL.filter((r) => r.sel.includes('.fb-acct') && r.media.startsWith('@container'));
    expect(wide).toHaveLength(1);
    expect(wide[0].decl['grid-template-columns']).toBe('repeat(2,minmax(0,1fr))');
    // Two 260 px cells and the 12 px gap.
    expect(wide[0].media).toMatch(/^@container fbacct \(min-width:532px\)$/);
  });
  it('measures the account card itself, which stays a box at every width', () => {
    expect(at('.fb-accts', 'container', 1280)).toBe('fbacct/inline-size');
    const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8');
    expect(js).toContain('<section class="pcard fb-sec fb-accts">');
  });
  it('sets no viewport width on the account grid', () => {
    expect(ALL.filter((r) => r.sel.includes('.fb-acct') && r.media.startsWith('@media'))).toHaveLength(0);
  });
});

describe('an empty side card with one button', () => {
  const card = '.pcard:has(> .fb-asg-none + .fb-asg-acts)';
  it('puts the empty text left and the button right on one row, at every width', () => {
    const r = ALL.filter((x) => x.sel.includes(card) && !x.media);
    expect(r).toHaveLength(1);
    expect(r[0].decl).toMatchObject({ display: 'grid', 'grid-template-columns': 'minmax(0,1fr) auto', 'align-items': 'center' });
    // The card's title (and anything else) keeps its own full row.
    expect(ALL.find((x) => x.sel.includes(`${card} > :not(.fb-asg-none,.fb-asg-acts)`))?.decl['grid-column']).toBe('1/-1');
  });
  it('covers Assigned to with nobody and Linked tasks with none, and leaves an assigned card as it is', () => {
    const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8');
    expect(js).toContain(`'<p class="faint fb-asg-none">Nobody yet</p>'}`);
    expect(js).toContain(`'<p class="faint fb-asg-none">No task yet</p>'}\${tfNote}`);
    // Assigned: the agent row, not .fb-asg-none, comes before the buttons, so the rule does not match.
    const a = js.indexOf('const assignCard'); expect(js.slice(a, js.indexOf('</section>`;', a))).toMatch(/\$\{asg \? row\(/);
  });
});
