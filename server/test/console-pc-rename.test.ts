/**
 * Rename a PC in the console (docs/dashboard-ux.md, the PC page): Rename sits beside the PC's name and in ⋯, opens a sheet under
 * the Add PC rules, shows a taken name as an inline error under the field (nothing changes), and saves with PATCH /api/pcs/:id.
 * The sheet runs from public/app.js in vm with a stub fbSheet that hands back its onGo.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const i0 = js.indexOf('function pcRenameSheet('), src = js.slice(i0, js.indexOf('\n}\n', i0) + 3);
expect(i0).toBeGreaterThan(-1);

type Sheet = { title: string; fields: string; onGo: (sh: unknown) => Promise<unknown> };
function run(name: string, value: string, api: (p: string, m: string, b: unknown) => Promise<unknown>) {
  const out: { sheet?: Sheet; toasts: string[]; done: number } = { toasts: [], done: 0 };
  const ctx: Record<string, unknown> = {
    fbSheet: (s: Sheet) => { out.sheet = s; }, fbVal: () => value, esc: (s: string) => s, api, toast: (m: string) => out.toasts.push(m),
  };
  vm.createContext(ctx);
  vm.runInContext(`${src}\nthis.f = pcRenameSheet;`, ctx);
  (ctx.f as (...a: unknown[]) => void)({ id: 'pc_1', name }, undefined, async () => { out.done++; });
  return out;
}
const err = (status: number, message: string) => Object.assign(new Error(message), { status });

describe('console: Rename PC', () => {
  it('the PC page has Rename beside the name and Rename PC in ⋯, both opening the same sheet', () => {
    expect(js).toContain("${tmgBtn('pcRename', 'Rename', 'Rename this PC', 'ghost')}");
    expect(js).toContain("{ label: 'Rename PC', icon: 'edit', fn: () => doRename() }");
    expect(js).toContain('$(\'#pcRename\').onclick = (e) => doRename(e.currentTarget);');
    expect(js).toContain('const doRename = (anchor) => pcRenameSheet(p, anchor, re);');
  });
  it('the sheet says what stays the same and what keeps the old name', () => {
    const o = run('old-pc', 'new-pc', async () => ({}));
    expect(o.sheet!.title).toBe('Rename PC');
    expect(o.sheet!.fields).toContain('value="old-pc"');
    expect(o.sheet!.fields).toContain('Its keys, agents and bridge are not affected');
    expect(o.sheet!.fields).toContain('Files on the PC itself keep the old name');
  });
  it('a free name is saved with PATCH /api/pcs/:id, toasted, and the page reloads', async () => {
    const calls: unknown[][] = [];
    const o = run('old-pc', 'new-pc', async (p, m, b) => { calls.push([p, m, b]); return {}; });
    expect(await o.sheet!.onGo({})).toBeNull();
    expect(calls).toEqual([['/pcs/pc_1', 'PATCH', { name: 'new-pc' }]]);
    expect(o.toasts).toEqual(['Renamed to new-pc']);
    expect(o.done).toBe(1);
  });
  it('a taken name is an inline error under the name field and nothing reloads', async () => {
    const o = run('old-pc', 'taken-pc', async () => { throw err(409, 'a PC named "taken-pc" exists'); });
    expect(await o.sheet!.onGo({})).toEqual(['a PC named "taken-pc" exists', 'pcRnI']);
    expect(o.toasts).toEqual([]);
    expect(o.done).toBe(0);
  });
  it('an empty, unchanged or invalid name is refused before any call', async () => {
    let calls = 0;
    const api = async () => { calls++; return {}; };
    expect(await run('a', '', api).sheet!.onGo({})).toEqual(['Type a name.', 'pcRnI']);
    expect(await run('a', 'a', api).sheet!.onGo({})).toEqual(['Type a new name, or cancel.', 'pcRnI']);
    expect((await run('a', 'Has Space', api).sheet!.onGo({}) as string[])[0]).toContain('lowercase letters, digits and dashes');
    expect(calls).toBe(0);
  });
  it('another failure is not hidden as a field error', async () => {
    const o = run('old-pc', 'new-pc', async () => { throw err(0, 'Cannot reach the hub'); });
    await expect(o.sheet!.onGo({})).rejects.toThrow('Cannot reach the hub');
  });
});
