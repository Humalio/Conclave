/**
 * Hover cards (docs/design-guidelines.md, Hover cards): one positioner for every .info-tip (info buttons, key chips such as
 * H-L1-02, glossary codes, Check pills). tipSpot places the card where it fits in the window: below the host when there is
 * room, else above, kept inside the window sideways, and no taller than the room so a long card scrolls inside itself.
 * The block between the hover-tip markers in public/app.js is loaded in vm; the CSS opens a card only through .tip-open.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const pub = (f: string) => readFileSync(join(process.cwd(), 'public', f), 'utf8').replace(/\r\n/g, '\n');
const js = pub('app.js'), css = pub('style.css');
const block = js.slice(js.indexOf('/* hover-tip:start'), js.indexOf('/* hover-tip:end */'));
const ctx: { tipSpot?: (r: object, w: number, h: number, vw: number, vh: number) => { x: number; y: number; maxH: number; side: string } } = {};
vm.runInNewContext(`${block}\nthis.tipSpot = tipSpot;`, ctx);
const spot = ctx.tipSpot!;
const rect = (left: number, top: number, w = 60, h = 20) => ({ left, top, right: left + w, bottom: top + h });

describe('hover card placement', () => {
  it('opens below the chip when the card fits there', () => {
    expect(spot(rect(100, 200), 300, 120, 1440, 900)).toEqual({ x: 100, y: 226, maxH: 666, side: 'below' });
  });

  it('opens above a chip near the bottom of the window, the case reported on a task', () => {
    const s = spot(rect(100, 840), 300, 120, 1440, 900);
    expect(s.side).toBe('above');
    expect(s.y).toBe(840 - 6 - 120);
    expect(s.y + 120).toBeLessThanOrEqual(840);
  });

  it('stays inside the window sideways, on a 390 px phone and at the right edge of a wide screen', () => {
    expect(spot(rect(330, 200), 300, 80, 390, 844).x).toBe(390 - 300 - 8);
    expect(spot(rect(1400, 200), 320, 80, 1440, 900).x).toBe(1440 - 320 - 8);
    expect(spot(rect(-20, 200), 200, 80, 390, 844).x).toBe(8);
  });

  it('a card taller than the room gets the larger side and scrolls inside itself', () => {
    const s = spot(rect(100, 300), 300, 2000, 1440, 900);
    expect(s.side).toBe('below');
    expect(s.maxH).toBe(900 - 320 - 6 - 8);
    const up = spot(rect(100, 700), 300, 2000, 1440, 900);
    expect(up).toMatchObject({ side: 'above', maxH: 700 - 6 - 8, y: 8 });
  });
});

describe('hover card CSS', () => {
  it('opens a card only through .tip-open, so the positioner decides where and Esc can close it', () => {
    expect(css).toMatch(/\.tip-open>\.info-tip\{display:block/);
    expect(css).not.toMatch(/:hover \.info-tip|:focus-visible \.info-tip/);
  });
  it('every host the console renders is one the positioner knows', () => {
    expect(js).toContain("const TIP_HOST = '.info,.ref,.bp-chk,.bp-stm';");
    for (const host of ['class="info"', 'class="ref"', 'bp-chk', 'class="bp-stm"']) expect(js).toContain(host);
  });
});
