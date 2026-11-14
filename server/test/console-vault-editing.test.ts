/**
 * People writing in the vault, in the console (docs/vault.md "People writing in the vault"; design guidelines §5 Text
 * editor). Static checks on the console source, like console-media.test.ts; the routes are covered by
 * vault-editing.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const css = readFileSync(join(process.cwd(), 'public', 'style.css'), 'utf8');
const block = (start: string, end: string) => {
  const i = js.indexOf(start);
  expect(i, start).toBeGreaterThanOrEqual(0);
  const j = js.indexOf(end, i + start.length);
  expect(j, end).toBeGreaterThan(i);
  return js.slice(i, j);
};

describe('vault editing in the console', () => {
  it('offers writing to the operator only, never in 99 Conclave, and not while writes are paused', () => {
    expect(js).toContain("const vedMay = (p) => !!S.me && S.me.role !== 'member' && !vedHub(p);");
    expect(js).toMatch(/const vedHub = \(p\) => \{ const r = vedRel\(p\)\.toLowerCase\(\); return r === '99 conclave' \|\| r\.startsWith\('99 conclave\/'\); \};/);
    expect(js).toContain('const mayWrite = vedMay(state.path) && !paused;');
    expect(js).toContain('<b>Nobody can write here; the hub replaces its pages.</b>');
    expect(js).not.toContain('Agents cannot write here; edits are replaced.');
  });

  it('reads the text to edit through the one byte path, and saves with the revision it read', () => {
    expect(js).toContain("const vedTextUrl = (p) => `/vault/media?${new URLSearchParams({ path: p, as: 'text' })}`;");
    expect(js.match(/\/api\/vault\/media/g)).toHaveLength(1);
    const wire = block('function vedWire(', '\n/* Leaving the editor');
    // It sends the text as it was when Save was pressed, not the field at the reply (see "a save in flight" below).
    expect(wire).toContain("vedReq('/vault/files', { method: 'PUT', body: { path: state.path, text: sent, base_revision: doc.base } })");
  });

  it('shows a clash with the change and Reload, Copy my text and Keep mine; Keep mine saves on the base it was shown', () => {
    const wire = block('function vedWire(', '\n/* Leaving the editor');
    expect(wire).toContain("'Changed since you opened it'");
    expect(wire).toContain('data-vedx="reload"');
    expect(wire).toContain('data-vedx="copy"');
    expect(wire).toContain('data-vedx="keep"');
    expect(wire).toContain('Keep mine: their version stays in History.');
    expect(wire).toContain("else if (x === 'keep') { doc.base = theirs; clash.innerHTML = ''; save(); }");
    // A refused save (read only, gone) keeps the text and offers to copy it.
    expect(wire).toMatch(/e\.status === 403 \|\| e\.status === 404\) showRefused\(e\)/);
  });

  it('asks before leaving with unsaved text, from Cancel, links outside the editor, and closing the page', () => {
    expect(js).toContain("$('#vedC').onclick = (e) => (dirty() ? vedConfirmLeave(e.currentTarget, leave) : leave());");
    expect(js).toContain("addEventListener('beforeunload', (e) => { if (VED_DIRTY && $('#vedRoot'))");
    expect(js).toMatch(/document\.addEventListener\('click', \(e\) => \{\n  if \(!VED_DIRTY\) return;/);
  });

  it('sends a base with rename, remove and restore, and offers another name when a restore target is taken', () => {
    expect(js).toContain("vedReq('/vault/files/rename', { method: 'POST', body: { from: path, to, base_revision: info.revision } })");
    expect(js).toContain("vedReq(`/vault/files?${new URLSearchParams({ path, base_revision: info.revision })}`, { method: 'DELETE' })");
    const restore = block('function vedRestore(', '\n/* The editor');
    expect(restore).toContain("err.body?.reason === 'taken'");
    expect(restore).toContain('Restore as');
    expect(js).toContain('It goes out of the vault and can be restored from History.');
    expect(js).toMatch(/you can read \$\{n === 1 \? 'links' : 'link'\} here\. Links are not changed/);
  });

  it('reaches Rename and Remove from the desktop header, and reads folders fresh after a write', () => {
    expect(js).toContain('id="vaMore" aria-label="More actions for ${esc(title)}"');
    expect(js).toContain("{ label: 'Rename or move', icon: 'edit', fn: () => run(() => vedRename(b, state.path)) }");
    expect(block('async function vedReq(', '\n}')).toContain("if (method !== 'GET') { treeCache.clear(); treeAt = 0; }");
  });

  it('gives a member with Contribute the same editor: New note and Edit, and no second note form', () => {
    expect(js).toContain("$('#muNw').onclick = (e) => vedNewNote(e.currentTarget, lv.path, (p) => muGo('edit', p));");
    expect(js).toContain('const rev = VED_TEXT.test(f.path) && (f.size ?? 0) <= VED_MAX && muCanWrite(f.path);');
    expect(js).toContain("$('#muEd').onclick = () => muGo('edit', f.path);");
    const edit = block('  async edit(path) {', '\n  },');
    expect(edit).toContain('vedReq(vedTextUrl(path))');
    expect(edit).toContain("vedWire({ path }, t, () => muGo('file', path))");
    expect(js).not.toContain('muNoteSheet');
    expect(js).not.toContain('/vault/note');
  });

  it('lays the editor out side by side from 1024 px and with an Edit/Preview switch below', () => {
    expect(css).toContain('.ved{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr)');
    expect(css).toContain('@media (max-width:1023.98px){.ved{grid-template-columns:minmax(0,1fr)}.ved-tabs{display:flex}.ved[data-pane="edit"] .ved-prev,.ved[data-pane="preview"] .ved-src{display:none}}');
    expect(js).toMatch(/data-vedp="edit" class="on" aria-pressed="true"/);
  });
});

/* A save in flight: vedWire runs for real in vm, on a fake editor and a server whose replies the test releases. Both entry
   points share it: the operator's vault screen (default done, which opens the file) and the member's Edit page (its own done). */
describe('a save in flight keeps text typed meanwhile', () => {
  type Reply = { resolve: (v: unknown) => void; reject: (e: unknown) => void };
  function editor(done?: () => void) {
    const el = (x: Record<string, unknown> = {}) => ({ innerHTML: '', textContent: '', dataset: {}, disabled: false, focus() {}, select() {}, scrollIntoView() {}, ...x });
    const E: Record<string, any> = { '#vedT': el({ value: 'X' }), '#vedS': el(), '#vedP': el(), '#ved': el(), '#vedClash': el(), '#vedOk': el(), '#vedC': el() };
    const puts: { body: any; reply: Reply }[] = [], toasts: string[] = [], opened: unknown[] = [];
    const ctx: Record<string, unknown> = {
      $: (s: string) => E[s] ?? el(), $$: () => [], toast: (m: string) => toasts.push(m), mdDoc: () => '', mdText: String, markEdited: () => {}, esc: String, ic: () => '', dfCls: () => '',
      vedName: (p: string) => String(p).split('/').pop(), vedConfirmLeave: () => {}, openD: (...a: unknown[]) => opened.push(a), navigator: {}, document: {}, URLSearchParams,
      api: async () => ({ diff: '' }), setTimeout, clearTimeout,
      vedReq: (_p: string, o: any) => new Promise((resolve, reject) => puts.push({ body: o.body, reply: { resolve, reject } })),
    };
    vm.createContext(ctx);
    const src = [js.slice(js.indexOf('const run = '), js.indexOf('\n', js.indexOf('const run = '))), 'let VED_DIRTY = null;',
      block('function vedWire(', '\n/* Leaving the editor'), 'this.vedWire = vedWire; this.dirtyPath = () => VED_DIRTY;'].join('\n');
    vm.runInContext(src, ctx);
    (ctx.vedWire as Function)({ path: 'Notes/a.md' }, { text: 'X', revision: 'r1' }, ...(done ? [done] : []));
    const flush = () => new Promise((r) => setTimeout(r, 0));
    const type = (v: string) => { E['#vedT'].value = v; E['#vedT'].oninput(); };
    const ctrlS = () => E['#vedT'].onkeydown({ ctrlKey: true, key: 's', preventDefault() {} });
    return { E, puts, toasts, opened, flush, type, ctrlS, dirtyPath: ctx.dirtyPath as () => string | null };
  }

  const entries: [string, (spy: () => void) => () => void][] = [
    ['the operator editor', () => () => {}],
    ['the member editor', (spy) => spy],
  ];
  for (const [name, mk] of entries) {
    it(`${name}: draft A is saved, B typed during the request stays unsaved, and a second save writes B on the new revision`, async () => {
      let closed = 0; const spy = () => { closed++; };
      const ed = editor(name === 'the member editor' ? mk(spy) : undefined);
      const isClosed = () => (name === 'the member editor' ? closed : ed.opened.length);
      ed.type('A'); ed.E['#vedOk'].onclick();
      expect(ed.puts).toHaveLength(1);
      expect(ed.puts[0].body).toEqual({ path: 'Notes/a.md', text: 'A', base_revision: 'r1' });
      ed.type('AB');
      ed.puts[0].reply.resolve({ revision: 'r2' }); await ed.flush();
      expect(isClosed()).toBe(0);
      expect(ed.E['#vedT'].value).toBe('AB');
      expect(ed.E['#vedS'].textContent).toBe('Unsaved changes');
      expect(ed.dirtyPath()).toBe('Notes/a.md');
      expect(ed.toasts.at(-1)).toMatch(/newer changes are not saved yet/);
      ed.E['#vedOk'].onclick();
      expect(ed.puts[1].body).toEqual({ path: 'Notes/a.md', text: 'AB', base_revision: 'r2' });
      ed.puts[1].reply.resolve({ revision: 'r3' }); await ed.flush();
      expect(isClosed()).toBe(1);
      expect(ed.dirtyPath()).toBeNull();
    });
  }

  it('a repeated Save shortcut during the request sends nothing twice, then saves the newer text on the new revision', async () => {
    const ed = editor();
    ed.type('A'); ed.ctrlS();
    ed.type('AB'); ed.ctrlS(); ed.ctrlS();
    expect(ed.puts).toHaveLength(1);
    ed.puts[0].reply.resolve({ revision: 'r2' }); await ed.flush();
    expect(ed.puts).toHaveLength(2);
    expect(ed.puts[1].body).toEqual({ path: 'Notes/a.md', text: 'AB', base_revision: 'r2' });
    ed.puts[1].reply.resolve({ revision: 'r3' }); await ed.flush();
    expect(ed.opened).toHaveLength(1);
    expect(ed.dirtyPath()).toBeNull();
  });

  it('a repeated shortcut with nothing new typed saves once and closes', async () => {
    const ed = editor();
    ed.type('A'); ed.ctrlS(); ed.ctrlS();
    ed.puts[0].reply.resolve({ revision: 'r2' }); await ed.flush();
    expect(ed.puts).toHaveLength(1);
    expect(ed.opened).toHaveLength(1);
  });

  it('an outside edit in between still offers Reload, Copy my text and Keep mine, and keeps the text', async () => {
    const ed = editor();
    ed.type('A'); ed.E['#vedOk'].onclick();
    ed.type('AB');
    ed.puts[0].reply.resolve({ revision: 'r2' }); await ed.flush();
    ed.E['#vedOk'].onclick();
    ed.puts[1].reply.reject(Object.assign(new Error('changed'), { status: 409, body: { current_revision: 'r9', file_id: 'f1' } })); await ed.flush();
    const banner = ed.E['#vedClash'].innerHTML;
    expect(banner).toContain('Changed since you opened it');
    for (const x of ['reload', 'copy', 'keep']) expect(banner).toContain(`data-vedx="${x}"`);
    expect(ed.E['#vedT'].value).toBe('AB');
    expect(ed.opened).toHaveLength(0);
    expect(ed.dirtyPath()).toBe('Notes/a.md');
    // Keep mine saves over the version it was shown.
    ed.E['#vedClash'].onclick({ target: { closest: () => ({ dataset: { vedx: 'keep' } }) } });
    expect(ed.puts[2].body).toEqual({ path: 'Notes/a.md', text: 'AB', base_revision: 'r9' });
  });

  it('both entry points use this one editor', () => {
    expect(js).toContain("vedWire({ path }, t, () => muGo('file', path))");
    expect(js).toContain("if (state.tab === 'edit' && etext) vedWire(state, etext);");
  });
});
