/**
 * Vault links in the console (docs/vault.md, Links in notes, Folders): the hub answers a link to a folder with its path and
 * a trailing slash, and the console opens it as that folder (#vault for the operator, #m/vault for a member), while a file
 * keeps its file address. The helpers are loaded from public/app.js in vm.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const from = js.indexOf('\nconst vlDir ='), to = js.indexOf('\nasync function vlDraw()');
const routeOf = (type: string, arg: unknown) => '#' + type + '/' + encodeURIComponent(JSON.stringify(arg));
const run = (mu: boolean) => {
  const ctx: Record<string, unknown> = { MU: { on: mu }, routeOf, esc: (s: string) => s };
  vm.runInNewContext(`${js.slice(from, to)}\nthis.vlHref = vlHref; this.vlDir = vlDir;`, ctx);
  return ctx as { vlHref: (p: string, a?: string) => string; vlDir: (p: string) => string };
};

describe('a resolved vault link\'s address', () => {
  it('opens a folder as that folder for the operator, and a file as the file', () => {
    const { vlHref, vlDir } = run(false);
    expect(vlDir('/vault/Papers/01 Writing/Paper A/')).toBe('/vault/Papers/01 Writing/Paper A');
    expect(vlDir('/vault/Papers/README.md')).toBe('');
    expect(vlHref('/vault/Papers/01 Writing/Paper A/')).toBe(routeOf('vault', { tab: 'contents', path: '/vault/Papers/01 Writing/Paper A' }));
    expect(vlHref('/vault/Papers/README.md', 'Index')).toBe(routeOf('vault', { tab: 'contents', path: '/vault/Papers/README.md', file: true, anchor: 'Index' }));
  });
  it('opens a folder in a member\'s vault view, and a file in their file view', () => {
    const { vlHref } = run(true);
    expect(vlHref('/vault/Papers/Paper A/')).toBe('#m/vault/' + encodeURIComponent('/vault/Papers/Paper A'));
    expect(vlHref('/vault/Papers/README.md')).toBe('#m/file/' + encodeURIComponent('/vault/Papers/README.md'));
  });
  it('never embeds a folder', () => {
    expect(js).toContain("e.outerHTML = found.length === 1 && !vlDir(found[0]) ?");
  });
});
