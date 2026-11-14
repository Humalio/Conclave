/**
 * The login limit in the console (docs/dashboard-ux.md, the key Overview): an app key's Overview has a Login limit row with Change limit;
 * the sheet takes a whole number from 1 to 500, refuses anything else inline before any call, and saves with PUT /api/keys/:id/live-limit.
 * The sheet runs from public/app.js in vm with a stub fbSheet that hands back its onGo.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const i0 = js.indexOf('function liveLimitSheet('), src = js.slice(i0, js.indexOf('\n}\n', i0) + 3);
expect(i0).toBeGreaterThan(-1);

type Sheet = { title: string; fields: string; onGo: (sh: unknown) => Promise<unknown> };
function run(limit: number, value: string, api: (p: string, m: string, b: unknown) => Promise<unknown>) {
  const out: { sheet?: Sheet; done: number } = { done: 0 };
  const ctx: Record<string, unknown> = { fbSheet: (s: Sheet) => { out.sheet = s; }, fbVal: () => value, esc: (s: string) => s, api };
  vm.createContext(ctx);
  vm.runInContext(`${src}\nthis.f = liveLimitSheet;`, ctx);
  (ctx.f as (...a: unknown[]) => void)({ max_live_sessions: limit }, '/keys/crd_1', undefined, async () => { out.done++; });
  return out;
}
const err = (status: number, message: string) => Object.assign(new Error(message), { status });

describe('console: the login limit of an app key', () => {
  it('an app key Overview has a Login limit row with Change limit, only while the key is not revoked, and the button opens the sheet', () => {
    expect(js).toContain("${isApp ? kv('Login limit',");
    expect(js).toContain('id=\\"kLim\\"'.replace(/\\"/g, '"'));
    expect(js).toContain("on('#kLim', (e) => liveLimitSheet(k, kp, e.currentTarget,");
    expect(js).toMatch(/kv\('Login limit', `\$\{k\.max_live_sessions\}[^`]*\$\{dead \? '' : /);
  });
  it('the sheet shows the current limit and says what applies when', () => {
    const o = run(100, '150', async () => ({}));
    expect(o.sheet!.title).toBe('Login limit');
    expect(o.sheet!.fields).toContain('value="100"');
    expect(o.sheet!.fields).toContain('min="1" max="500"');
    expect(o.sheet!.fields).toContain('applies at the next login');
  });
  it('a valid number is saved with PUT /keys/:id/live-limit and the Overview reloads', async () => {
    const calls: unknown[][] = [];
    const o = run(100, '250', async (p, m, b) => { calls.push([p, m, b]); return {}; });
    expect(await o.sheet!.onGo({})).toBeNull();
    expect(calls).toEqual([['/keys/crd_1/live-limit', 'PUT', { max_live_sessions: 250 }]]);
    expect(o.done).toBe(1);
  });
  it('an empty, out of range, fractional, unchanged or non-numeric value is refused inline before any call', async () => {
    let calls = 0;
    const api = async () => { calls++; return {}; };
    expect((await run(100, '', api).sheet!.onGo({}) as string[])[1]).toBe('kLimI');
    for (const bad of ['0', '501', '-3', '2.5', 'abc']) expect((await run(100, bad, api).sheet!.onGo({}) as string[])[0], bad).toContain('whole number from 1 to 500');
    expect((await run(100, '100', api).sheet!.onGo({}) as string[])[0]).toContain('new limit');
    expect(calls).toBe(0);
    for (const good of ['1', '500']) expect(await run(100, good, api).sheet!.onGo({})).toBeNull();
  });
  it('a refusal by the hub shows under the field, another failure is not hidden', async () => {
    const o = run(100, '5', async () => { throw err(400, 'The limit is a whole number from 1 to 500.'); });
    expect(await o.sheet!.onGo({})).toEqual(['The limit is a whole number from 1 to 500.', 'kLimI']);
    expect(o.done).toBe(0);
    const p = run(100, '5', async () => { throw err(0, 'Cannot reach the hub'); });
    await expect(p.sheet!.onGo({})).rejects.toThrow('Cannot reach the hub');
  });
});
