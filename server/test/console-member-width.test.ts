/**
 * Member pages use the full width (multi-user.md, Width): from 1180 px a grid with one empty column gives the other the full width,
 * and two filled columns keep 7 to 5. The Vault shows no lone "Vault" crumb at its top level (muCrumbs, built from app.js in vm).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const css = readFileSync(join(process.cwd(), 'public', 'style.css'), 'utf8').replace(/\r\n/g, '\n');
const stmt = (start: string, end: string) => { const a = js.indexOf(start), b = js.indexOf(end, a); if (a < 0 || b < 0) throw new Error('missing ' + start); return js.slice(a, b); };

const ctx: Record<string, any> = { crumbsH: (L: any[]) => (L.length ? L.map((c) => (c.cur ? `[${c.label}]` : `${c.label}>${c.attrs['data-mu-go']}`)).join(' / ') : '') };
vm.createContext(ctx);
vm.runInContext(stmt('function muCrumbs(', 'const muVaultBack') + '\nthis.muCrumbs = muCrumbs;', ctx);

describe('member page width', () => {
  it('gives a grid with an empty column the full width from 1180 px', () => {
    expect(css).toContain('@media (min-width:1180px){.mu-body .mu-grid:has(> .kd-col:empty){grid-template-columns:minmax(0,1fr)}}');
    expect(css).toContain('.mu-body .kd-col:empty{display:none}');
  });
  it('keeps 7 to 5 for two filled columns', () => {
    expect(css).toContain('@media (min-width:1180px){.kd-grid{display:grid;grid-template-columns:minmax(0,7fr) minmax(0,5fr);align-items:start}}');
  });
  it('leaves the always one-column pages with an empty second column', () => {
    for (const t of ["muPage('Needs you'", "muPage('Question'", "muPage('Messages'"]) {
      const a = js.indexOf(t); expect(a).toBeGreaterThan(0);
      expect(js.slice(a, js.indexOf('\n  },\n', a))).toContain('<div class="kd-col"></div>');
    }
  });
});

describe('member Vault breadcrumb', () => {
  it('shows none at the top level', () => {
    expect(ctx.muCrumbs('/vault')).toBe('');
    expect(ctx.muCrumbs('/')).toBe('');
    expect(ctx.muCrumbs('')).toBe('');
  });
  it('shows the path inside a folder, the folder last', () => {
    expect(ctx.muCrumbs('/vault/Signals Lab')).toBe('Vault>vault|/vault / [Signals Lab]');
    expect(ctx.muCrumbs('/vault/Signals Lab/Logs')).toBe('Vault>vault|/vault / Signals Lab>vault|/vault/Signals Lab / [Logs]');
  });
  it('shows the folders on a file page, each a link', () => {
    expect(ctx.muCrumbs('/vault/Signals Lab/Echo decay.md', true)).toBe('Vault>vault|/vault / Signals Lab>vault|/vault/Signals Lab');
    expect(ctx.muCrumbs('/vault/Top.md', true)).toBe('Vault>vault|/vault');
  });
});
