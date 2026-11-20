/**
 * Vault links in rendered Markdown (docs/vault.md, Links in notes): POST /api/vault/links answers, for the operator and a
 * console member alike, which link targets the viewer may open. A missing, hidden or refused target gets the same answer,
 * and a wiki name lists visible matches only, nearest to the note first.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { buildApp, type App } from '../src/app.js';
import { testConfig, adminLogin } from './hub.js';

let app: App, base = '';
type S = { cookie: string; csrf: string };
let admin: S, ana: S;
const PW = 'vault links password 1234';
const call = async (who: S, body: unknown, method = 'POST', path = '/api/vault/links') => {
  const r = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', cookie: who.cookie, 'x-csrf-token': who.csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() as any };
};
const FROM = '/vault/Projects/X/Notes/today.md';
const FILES = ['Projects/X/Notes/today.md', 'Projects/X/Notes/Plan.md', 'Projects/X/Plan.md', 'Projects/X/Records/log.md',
  'Projects/X/Restricted/secret.md', 'Other/Plan.md', 'Other/hidden.md', '.obsidian/workspace.md',
  'Home.md', 'Projects/X/Notes/My Note.md', 'Shared/Brief.md', 'Projects/X/Notes/Shared/Brief.md',
  // A papers README that links its subfolders' notes and the paper folders themselves (like a papers folder's README.md).
  'Papers/README.md', 'Papers/01 Writing/README.md', 'Papers/01 Writing/Paper A/draft.md', 'Papers/03 Published/Paper B.pdf',
  'Papers/03 Published/Paper C/slides.pdf', 'Papers/Twin.md', 'Papers/Twin/notes.md', 'Shared/01 Writing/README.md'];

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahlinks-'));
  for (const f of FILES) { const p = join(dir, 'vault', ...f.split('/')); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, `# ${f}\n`); }
  app = await buildApp(testConfig(dir));
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  admin = await adminLogin(base);
  const project = (await call(admin, { key: 'LNK', name: 'X' }, 'POST', '/api/projects')).json.project.id as string;
  // A restricted folder inside Ana's grant that the grant does not name: hidden from her.
  app.db.prepare('INSERT INTO vault_folder_flags(path,restricted,set_at) VALUES (?,1,?)').run('/Projects/X/Restricted/', Date.now());
  const c = await call(admin, { username: 'ana' }, 'POST', '/api/users');
  const first = await adminLogin(base, 'ana', c.json.password);
  expect((await call(first, { current: c.json.password, new: PW }, 'POST', '/api/me/password')).status).toBe(200);
  expect((await call(admin, { grants: [{ project_id: project, components: ['vault'], vault_folders: ['/Projects/X/'], may_export: false }] }, 'PUT', `/api/users/${c.json.user.id}/grants`)).status).toBe(200);
  ana = await adminLogin(base, 'ana', PW);
});
afterAll(async () => { await app?.close(); });

describe('POST /api/vault/links', () => {
  it('resolves a note\'s relative and root links for the operator, with or without .md', async () => {
    const r = await call(admin, { from: FROM, paths: ['/vault/Projects/X/Records/log.md', '/vault/Projects/X/Plan', '/vault/Other/hidden.md', '/vault/Projects/X/none.md'], names: [] });
    expect(r.status).toBe(200);
    expect(r.json.paths).toEqual({
      '/vault/Projects/X/Records/log.md': '/vault/Projects/X/Records/log.md',
      '/vault/Projects/X/Plan': '/vault/Projects/X/Plan.md',
      '/vault/Other/hidden.md': '/vault/Other/hidden.md',
      '/vault/Projects/X/none.md': null,
    });
  });

  it('resolves wiki names against the whole vault for the operator, nearest to the note first', async () => {
    const r = await call(admin, { from: FROM, names: ['Plan', 'X/Plan', 'log', 'nothing'] });
    expect(r.json.names).toEqual({
      Plan: ['/vault/Projects/X/Notes/Plan.md', '/vault/Projects/X/Plan.md', '/vault/Other/Plan.md'],
      'X/Plan': ['/vault/Projects/X/Plan.md'],
      log: ['/vault/Projects/X/Records/log.md'],
      nothing: [],
    });
  });

  it('gives a member only the matches it may see', async () => {
    const r = await call(ana, { from: FROM, names: ['Plan'] });
    expect(r.status).toBe(200);
    expect(r.json.names.Plan).toEqual(['/vault/Projects/X/Notes/Plan.md', '/vault/Projects/X/Plan.md']);
    expect((await call(ana, { paths: ['/vault/Projects/X/Records/log.md'] })).json.paths['/vault/Projects/X/Records/log.md']).toBe('/vault/Projects/X/Records/log.md');
  });

  it('answers a member the same for a hidden file as for a missing one', async () => {
    const hidden = ['/vault/Projects/X/Restricted/secret.md', '/vault/Other/hidden.md', '/vault/.obsidian/workspace.md'];
    const missing = ['/vault/Projects/X/Restricted/none.md', '/vault/Other/none.md', '/vault/.obsidian/none.md'];
    const h = await call(ana, { from: FROM, paths: hidden, names: ['secret', 'hidden', 'workspace'] });
    const m = await call(ana, { from: FROM, paths: missing, names: ['none1', 'none2', 'none3'] });
    expect(h.status).toBe(m.status);
    expect(Object.values(h.json.paths)).toEqual([null, null, null]);
    expect(Object.values(h.json.paths)).toEqual(Object.values(m.json.paths));
    expect(Object.values(h.json.names)).toEqual([[], [], []]);
    expect(Object.values(h.json.names)).toEqual(Object.values(m.json.names));
    // Nothing in the answer but the viewer's own question.
    for (const s of ['secret', 'hidden', 'workspace']) expect(h.text.replace(new RegExp(`"[^"]*${s}[^"]*":`, 'g'), '')).not.toContain(s);
  });

  // The one resolver (server/src/vault/links.ts): every link form Obsidian writes opens the right note.
  const links = async (who: S, from: string, L: string[]) => (await call(who, { from, links: L })).json.links as Record<string, string[]>;
  it('resolves every link form from a note in a subfolder', async () => {
    const r = await links(admin, FROM, ['/Projects/X/Plan.md', '/vault/Projects/X/Plan.md', 'Projects/X/Plan.md', 'Projects/X/Plan', '../Plan.md', './Plan.md',
      'Plan', 'Records/log', 'log', 'My Note', 'Notes/My Note.md', 'Shared/Brief.md', 'projects/x/plan.md', 'Projects/X/none.md', '../../../../x.md', '/../x.md']);
    expect(r).toEqual({
      // From the vault root, with or without the leading / and the alias, with or without .md: the root-relative links of Home.md.
      '/Projects/X/Plan.md': ['/vault/Projects/X/Plan.md'],
      '/vault/Projects/X/Plan.md': ['/vault/Projects/X/Plan.md'],
      'Projects/X/Plan.md': ['/vault/Projects/X/Plan.md'],
      'Projects/X/Plan': ['/vault/Projects/X/Plan.md'],
      // Relative to the note's folder.
      '../Plan.md': ['/vault/Projects/X/Plan.md'],
      './Plan.md': ['/vault/Projects/X/Notes/Plan.md'],
      // A bare name beside the note opens it; elsewhere the name, or the end of a path, matches anywhere (shortest path).
      Plan: ['/vault/Projects/X/Notes/Plan.md'],
      'Records/log': ['/vault/Projects/X/Records/log.md'],
      log: ['/vault/Projects/X/Records/log.md'],
      'My Note': ['/vault/Projects/X/Notes/My Note.md'],
      'Notes/My Note.md': ['/vault/Projects/X/Notes/My Note.md'],
      // The note's folder comes before the vault root, as in Obsidian.
      'Shared/Brief.md': ['/vault/Projects/X/Notes/Shared/Brief.md'],
      // Case is ignored when no file has the exact path.
      'projects/x/plan.md': ['/vault/Projects/X/Plan.md'],
      'Projects/X/none.md': [],
      '../../../../x.md': [],
      '/../x.md': [],
    });
  });

  it('resolves a papers README: paths next to the note first, then from the root, and links to folders', async () => {
    const R = '/vault/Papers/README.md';
    expect(await links(admin, R, ['01 Writing/README.md', '01 Writing/Paper A', '03 Published/Paper B.pdf', '03 Published/Paper C',
      'Papers/01 Writing/Paper A', '/Papers/03 Published/Paper C', '../Papers/01 Writing/Paper A', 'Shared/01 Writing/README.md', 'Twin', '01 Writing/Gone', '../Gone']))
      .toEqual({
        // Next to the note, with or without .md, a file or a folder (a paper's folder opens as that folder).
        '01 Writing/README.md': ['/vault/Papers/01 Writing/README.md'],
        '01 Writing/Paper A': ['/vault/Papers/01 Writing/Paper A/'],
        '03 Published/Paper B.pdf': ['/vault/Papers/03 Published/Paper B.pdf'],
        '03 Published/Paper C': ['/vault/Papers/03 Published/Paper C/'],
        // Not next to the note: from the vault root, or written from the root or relative.
        'Papers/01 Writing/Paper A': ['/vault/Papers/01 Writing/Paper A/'],
        '/Papers/03 Published/Paper C': ['/vault/Papers/03 Published/Paper C/'],
        '../Papers/01 Writing/Paper A': ['/vault/Papers/01 Writing/Paper A/'],
        'Shared/01 Writing/README.md': ['/vault/Shared/01 Writing/README.md'],
        // A note wins over a folder of the same name.
        Twin: ['/vault/Papers/Twin.md'],
        '01 Writing/Gone': [],
        '../Gone': [],
      });
    // From the root note, the same folder resolves from the root.
    expect(await links(admin, '/vault/Home.md', ['Papers/01 Writing/Paper A'])).toEqual({ 'Papers/01 Writing/Paper A': ['/vault/Papers/01 Writing/Paper A/'] });
  });

  it('opens a folder for a member only when the grant shows it, the same answer as a missing one otherwise', async () => {
    const r = await links(ana, FROM, ['../Records', '../Restricted', '../../../Papers/01 Writing/Paper A', '../Nothing']);
    expect(r).toEqual({ '../Records': ['/vault/Projects/X/Records/'], '../Restricted': [], '../../../Papers/01 Writing/Paper A': [], '../Nothing': [] });
  });

  it('resolves root-relative links from a note at the vault root', async () => {
    expect(await links(admin, '/vault/Home.md', ['Projects/X/Plan.md', '/Projects/X/Records/log.md', 'Projects/X/Notes/My Note.md', 'Shared/Brief', '../x.md']))
      .toEqual({ 'Projects/X/Plan.md': ['/vault/Projects/X/Plan.md'], '/Projects/X/Records/log.md': ['/vault/Projects/X/Records/log.md'],
        'Projects/X/Notes/My Note.md': ['/vault/Projects/X/Notes/My Note.md'], 'Shared/Brief': ['/vault/Shared/Brief.md'], '../x.md': [] });
    // Outside a note (Blueprint bodies, task text) a relative link has nowhere to start; the others resolve.
    const r = (await call(admin, { links: ['./Plan.md', 'Projects/X/Plan', 'My Note'] })).json.links;
    expect(r).toEqual({ './Plan.md': [], 'Projects/X/Plan': ['/vault/Projects/X/Plan.md'], 'My Note': ['/vault/Projects/X/Notes/My Note.md'] });
  });

  it('lists several matches nearest to the note first, and gives a member only what it may see', async () => {
    expect((await links(admin, '/vault/Home.md', ['Plan'])).Plan).toEqual(['/vault/Other/Plan.md', '/vault/Projects/X/Plan.md', '/vault/Projects/X/Notes/Plan.md']);
    const m = await links(ana, FROM, ['Plan', '/Other/Plan.md', 'Home', 'Shared/Brief.md', 'Restricted/secret', '/Projects/X/Records/log.md']);
    expect(m).toEqual({ Plan: ['/vault/Projects/X/Notes/Plan.md'], '/Other/Plan.md': [], Home: [],
      // The root Shared/Brief.md is outside Ana's grant, so the one beside the note opens, as if the other did not exist.
      'Shared/Brief.md': ['/vault/Projects/X/Notes/Shared/Brief.md'], 'Restricted/secret': [], '/Projects/X/Records/log.md': ['/vault/Projects/X/Records/log.md'] });
  });

  it('refuses unsafe paths as unavailable, and bounds the request', async () => {
    expect(Object.values((await call(admin, { links: ['/vault/../etc/passwd', 'C:/x', '.obsidian/workspace', '/.obsidian/workspace.md'] })).json.links)).toEqual([[], [], [], []]);
    expect((await call(admin, { links: Array.from({ length: 201 }, (_, i) => `${i}.md`) })).status).toBe(400);
    const r = await call(admin, { paths: ['/vault/../etc/passwd', '/vault/Projects/X/..', 'C:/x', '/elsewhere/x.md', '/vault'] });
    expect(Object.values(r.json.paths)).toEqual([null, null, null, null, null]);
    expect((await call(admin, { paths: Array.from({ length: 201 }, (_, i) => `/vault/${i}.md`) })).status).toBe(400);
  });

  it('needs the CSRF header like every other write-method route', async () => {
    const r = await fetch(`${base}/api/vault/links`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: ana.cookie }, body: '{}' });
    expect(r.status).toBe(403);
  });
});
