/**
 * Blueprint browse (docs/blueprint.md §6.1): server search and paging with exact totals, named selections whose counts
 * match the lists they open, the item actions a viewer may take, and archive / unarchive of dropped items.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from '../src/app.js';
import { Blueprint, DECIDED_NOTE } from '../src/blueprint/blueprint.js';
import { BlueprintArchive } from '../src/blueprint/archive.js';
import { itemActions } from '../src/blueprint/browse.js';
import { testConfig, adminLogin, ADMIN_PASSWORD } from './hub.js';

const sys = { kind: 'system' as const, id: null };
const PW = 'browse member password 1234';
type S = { cookie: string; csrf: string };
let app: App, base = '', admin: S, member: S, P = '', T = '';
const call = async (who: S, method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie: who.cookie, 'x-csrf-token': who.csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, text, body: (() => { try { return JSON.parse(text); } catch { return null; } })() as any };
};
const get = (p: string, who: S = admin) => call(who, 'GET', p);
const post = (p: string, b: unknown = {}, who: S = admin) => call(who, 'POST', p, b);
const STATUS = ['draft', 'agreed', 'built', 'verified', 'dropped'];
const fr = (i: number) => `FR-ONE-${String(i).padStart(2, '0')}`;
/** Every page of a list, following next_cursor. */
async function all(q: string): Promise<{ keys: string[]; totals: number[] }> {
  const keys: string[] = [], totals: number[] = [];
  let cursor: string | null = null;
  do {
    const r = await get(`/projects/${P}/browse?${q}${cursor ? `&cursor=${cursor}` : ''}`);
    expect(r.status).toBe(200);
    keys.push(...r.body.items.map((i: { key: string }) => i.key));
    totals.push(r.body.total);
    cursor = r.body.next_cursor;
  } while (cursor);
  return { keys, totals };
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahbrowse-'));
  mkdirSync(join(dir, 'vault'), { recursive: true });
  app = await buildApp(testConfig(dir));
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  admin = await adminLogin(base, 'admin', ADMIN_PASSWORD);
  P = (await post('/projects', { key: 'BRW', name: 'Browse case' })).body.project.id;
  const a = app.keys.createAgent('brw-coord', null, sys);
  app.keys.createSessionKey({ agentId: a.id, label: 'brw-coord key' }, sys);
  T = app.teams.create({ name: 'Browse One', goal: 'goal', members: [{ agent_id: a.id, role: 'coordinator' }] }, sys).id;
  app.teams.start(T, sys);
  app.db.prepare('UPDATE teams SET project_id=? WHERE id=?').run(P, T);
  const op = { kind: 'operator' as const, id: null };
  const w = (ops: unknown[]) => app.blueprint.write(P, { version: app.blueprint.project(P)!.version, ops: ops as never }, op);
  w([{ op: 'upsert', kind: 'module', key: 'ONE', title: 'Module one', team_id: T }]);
  // 30 FRs, six of each status: 18 open (draft, agreed, built), 6 verified, 6 dropped; and one draft NFR.
  for (let c = 0; c < 3; c++) w(Array.from({ length: 10 }, (_, j) => { const i = c * 10 + j + 1; return { op: 'upsert', kind: 'fr', key: fr(i), parent_key: 'ONE', title: `Requirement ${i}`, status: STATUS[i % 5] }; }));
  w([{ op: 'upsert', kind: 'nfr', key: 'NFR-SEC-01', parent_key: 'ONE', title: 'Keys stay secret', status: 'draft', fields: { category: 'security' } },
    { op: 'upsert', kind: 'ac', key: 'FR-ONE-04/AC1', parent_key: fr(4), title: 'Waived with its requirement', status: 'waived' },
    { op: 'upsert', kind: 'ac', key: 'FR-ONE-09/AC1', parent_key: fr(9), title: 'Still open', status: 'open' },
    { op: 'upsert', kind: 'risk', key: 'RK-01', title: 'Field drift', status: 'open', team_id: T, fields: { likelihood: 'high', impact: 'medium', owner: 'Saoirse' } },
    { op: 'upsert', kind: 'risk', key: 'RK-02', title: 'Closed risk', status: 'closed' },
    { op: 'upsert', kind: 'milestone', key: 'M1', title: 'First cut', status: 'planned', team_id: T }]);

  const c = await post('/users', { username: 'nadia' });
  const first = await adminLogin(base, 'nadia', c.body.password);
  expect((await call(first, 'POST', '/me/password', { current: c.body.password, new: PW })).status).toBe(200);
  expect((await call(admin, 'PUT', `/users/${c.body.user.id}/grants`, { grants: [{ project_id: P, components: ['blueprint'], vault_folders: [], may_export: false }] })).status).toBe(200);
  member = await adminLogin(base, 'nadia', PW);
});
afterAll(async () => { await app?.close(); });

describe('browse lists (BLUEPRINT-02 to 06)', () => {
  it('"Open 19" pages through the same 19 distinct items, in a deterministic order, with the selection named', async () => {
    const first = await get(`/projects/${P}/browse?section=2&kind=fr,nfr&sel=open&limit=5`);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ total: 19, counts: { all: 31, open: 19, dropped: 6 }, selection: { id: 'open', label: 'Open' },
      filters: { section: 2, kind: ['fr', 'nfr'], status: [], sel: 'open', team: null, q: '', limit: 5 }, prev_cursor: null, project_id: P });
    expect(first.body.selection.rule).toMatch(/still in play/);
    expect(first.body.statuses).toEqual(STATUS);
    expect(first.body.items[0]).toMatchObject({ key: fr(1), kind: 'fr', status: 'agreed', parent: { key: 'ONE', title: 'Module one' }, team: { id: T, name: 'Browse One' } });
    const { keys, totals } = await all('section=2&kind=fr,nfr&sel=open&limit=5');
    expect(keys).toHaveLength(19);
    expect(new Set(keys).size).toBe(19);
    expect(totals.every((t) => t === 19)).toBe(true);
    expect(keys).toEqual((await all('section=2&kind=fr,nfr&sel=open&limit=7')).keys);
    // Previous goes back to the page before.
    const second = await get(`/projects/${P}/browse?section=2&kind=fr,nfr&sel=open&limit=5&cursor=${first.body.next_cursor}`);
    expect(second.body.prev_cursor).toBeTruthy();
    expect((await get(`/projects/${P}/browse?section=2&kind=fr,nfr&sel=open&limit=5&cursor=${second.body.prev_cursor}`)).body.items).toEqual(first.body.items);
  });

  it('filters by team, status and search, all in the server', async () => {
    expect((await get(`/projects/${P}/browse?kind=fr&team=${T}`)).body.total).toBe(30);
    expect((await get(`/projects/${P}/browse?kind=fr&team=project`)).body.total).toBe(0);
    expect((await get(`/projects/${P}/browse?kind=risk&team=project`)).body.items.map((i: { key: string }) => i.key)).toEqual(['RK-02']);
    expect((await get(`/projects/${P}/browse?kind=fr&status=verified`)).body.total).toBe(6);
    const s = await get(`/projects/${P}/browse?q=${encodeURIComponent('fr-one-07')}`);
    expect(s.body.items.map((i: { key: string }) => i.key)).toEqual([fr(7)]);
    expect((await get(`/projects/${P}/browse?q=${encodeURIComponent('Keys secret')}`)).body.items.map((i: { key: string }) => i.key)).toEqual(['NFR-SEC-01']);
    expect((await get(`/projects/${P}/browse?q=nothing-matches-this`)).body).toMatchObject({ total: 0, items: [], next_cursor: null });
  });

  it('refuses filters that cannot match, and a cursor from another list', async () => {
    expect((await get(`/projects/${P}/browse?kind=fr&status=passing`)).status).toBe(400);
    expect((await get(`/projects/${P}/browse?section=1&kind=fr`)).status).toBe(400);
    expect((await get(`/projects/${P}/browse?kind=nope`)).status).toBe(400);
    expect((await get(`/projects/${P}/browse?team=t_nope`)).status).toBe(400);
    expect((await get(`/projects/${P}/browse?sel=all`)).status).toBe(400);
    const other = Buffer.from('items:5').toString('base64url');
    expect((await get(`/projects/${P}/browse?cursor=${other}`)).status).toBe(400);
  });

  it('every count on the card is the total of the list it opens', async () => {
    for (const team of [undefined, T]) {
      const t = team ? `&team=${team}` : '';
      const s = (await get(`/projects/${P}/summary${team ? `?team=${team}` : ''}`)).body;
      expect(s.measures.bars.frs.total).toBe((await get(`/projects/${P}/browse?kind=fr,nfr&sel=live${t}`)).body.total);
      expect(s.measures.bars.frs.total).toBe(25);
      expect(s.measures.bars.acs.total).toBe((await get(`/projects/${P}/browse?kind=ac&sel=live${t}`)).body.total);
      expect(s.measures.bars.milestones.total).toBe((await get(`/projects/${P}/browse?kind=milestone&sel=live${t}`)).body.total);
      expect(s.risks.open).toBe((await get(`/projects/${P}/browse?kind=risk&sel=open${t}`)).body.total);
      expect(s.dropped).toBe((await get(`/projects/${P}/browse?sel=dropped${t}`)).body.total);
    }
  });

  it('a member reads the list of a granted project and is offered no actions', async () => {
    expect((await get(`/projects/${P}/browse?kind=fr&sel=open`, member)).body.total).toBe(18);
    expect((await get(`/projects/${P}/items/${fr(3)}`, member)).body.actions).toEqual([]);
    expect((await post(`/projects/${P}/items/${fr(4)}/archive`, {}, member)).status).toBe(403);
  });
});

describe('item actions', () => {
  it('come from the kind table and the item state', async () => {
    expect((await get(`/projects/${P}/items/${fr(3)}`)).body.actions).toEqual([{ id: 'add_as_claim' }]);
    expect((await get(`/projects/${P}/items/${fr(1)}`)).body.actions).toEqual([]);
    expect((await get(`/projects/${P}/items/${fr(4)}`)).body.actions).toEqual([{ id: 'archive' }]);
    const it0 = { kind: 'fr', status: 'agreed', fields: {}, deleted_at: null, archived: 0 };
    const revs = [{ rev: 3, note: DECIDED_NOTE, snapshot: { status: 'agreed' } }, { rev: 2, note: null, snapshot: { status: 'draft' } }];
    expect(itemActions(it0, revs, true)).toEqual([{ id: 'undo', rev: 3, to: 'draft' }]);
    expect(itemActions({ ...it0, status: 'built' }, revs, true)).toEqual([]);
    expect(itemActions(it0, revs, false)).toEqual([]);
    expect(itemActions({ kind: 'paper', status: 'drafting', fields: {}, deleted_at: null, archived: 0 }, [], true)).toEqual([{ id: 'mark_submitted' }]);
    expect(itemActions({ kind: 'claim', status: 'draft', fields: {}, deleted_at: null, archived: 0 }, [], true)).toEqual([{ id: 'add_evidence' }, { id: 'cut_claim' }]);
    expect(itemActions({ kind: 'claim', status: 'cut', fields: {}, deleted_at: null, archived: 0 }, [], true)).toEqual([{ id: 'archive' }]);
  });
});

describe('archive (BLUEPRINT-07 to 09)', () => {
  it('previews what goes with an item, refuses while a child is in play, and archives a dropped subtree as one write', async () => {
    const blocked = await post(`/projects/${P}/items/${fr(9)}/archive`, { check: true });
    expect(blocked.body).toMatchObject({ done: false, keys: [fr(9), 'FR-ONE-09/AC1'], blocking: [{ key: 'FR-ONE-09/AC1', status: 'open' }] });
    expect((await post(`/projects/${P}/items/${fr(9)}/archive`)).status).toBe(409);
    expect((await post(`/projects/${P}/items/${fr(3)}/archive`)).status).toBe(409); // verified, not dropped

    const v0 = app.blueprint.project(P)!.version;
    const check = await post(`/projects/${P}/items/${fr(4)}/archive`, { check: true });
    expect(check.body).toMatchObject({ done: false, keys: [fr(4), 'FR-ONE-04/AC1'], blocking: [], version: v0 });
    expect(app.blueprint.project(P)!.version).toBe(v0);
    const r = await post(`/projects/${P}/items/${fr(4)}/archive`, { note: 'Not needed any more' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ done: true, version: v0 + 1, keys: [fr(4), 'FR-ONE-04/AC1'] });

    // Out of browse, counts and search.
    expect((await get(`/projects/${P}/browse?q=${fr(4)}`)).body.total).toBe(0);
    expect((await get(`/projects/${P}/browse?kind=fr&sel=dropped`)).body.total).toBe(5);
    expect((await get(`/projects/${P}/summary`)).body.dropped).toBe(5);
    // Still whole: it opens by its key, marked, with its child, a revision and the unarchive action.
    const d = (await get(`/projects/${P}/items/${fr(4)}`)).body;
    expect(d.item.archived).toBe(true);
    expect(d.children.map((c: { key: string }) => c.key)).toEqual(['FR-ONE-04/AC1']);
    // Its ACs come with their fields, since no browse read reaches them; a live item's children stay short.
    expect(d.children[0]).toMatchObject({ kind: 'ac', status: 'waived', fields: expect.any(Object) });
    expect((await get(`/projects/${P}/items/${fr(1)}`)).body.children.every((c: object) => !('fields' in c))).toBe(true);
    expect(d.history.revisions[0].note).toBe('archived');
    expect(d.actions).toEqual([{ id: 'unarchive' }]);
    // The export keeps it, marked; bp_read since_version lists it as removed.
    const md = (await get(`/projects/${P}/export.md`)).text;
    expect(md).toMatch(/\*\*FR-ONE-04\*\* Requirement 4 · dropped · archived/);
    expect(md).toMatch(/· 2 archived/);
    expect(app.blueprint.read(P, null, { scope: 'project', since_version: v0 }).removed).toEqual([fr(4), 'FR-ONE-04/AC1']);
    const ev = app.db.prepare('SELECT changed, note FROM bp_events WHERE project_id=? AND version=?').get(P, v0 + 1) as { changed: string; note: string };
    expect(JSON.parse(ev.changed)).toEqual([fr(4), 'FR-ONE-04/AC1']);
    expect(ev.note).toBe('Not needed any more');

    expect((await post(`/projects/${P}/items/${fr(4)}/archive`)).status).toBe(409);
  });

  it('unarchive brings the item and its archived children back, as they were', async () => {
    const r = await post(`/projects/${P}/items/${fr(4)}/unarchive`);
    expect(r.body).toMatchObject({ done: true, keys: [fr(4), 'FR-ONE-04/AC1'] });
    const row = (await get(`/projects/${P}/browse?q=${fr(4)}`)).body;
    expect(row.items.map((i: { key: string; status: string }) => [i.key, i.status])).toEqual([[fr(4), 'dropped'], ['FR-ONE-04/AC1', 'waived']]);
    expect((await post(`/projects/${P}/items/${fr(4)}/unarchive`)).status).toBe(409);
    expect((await post(`/projects/${P}/items/FR-ONE-99/archive`)).status).toBe(404);
  });

  it('archived and retired items count the same toward the limits: neither does, and coming back is checked', () => {
    const op = { kind: 'operator' as const, id: null };
    const bp = new Blueprint(app.db, { itemsPerProject: 3 }), arc = new BlueprintArchive(app.db, bp);
    const p = bp.createProject({ key: 'CAP', name: 'Capacity case' }, op);
    const w = (ops: unknown[]) => bp.write(p.id, { version: bp.project(p.id)!.version, ops: ops as never }, op);
    const r = (n: number, status = 'draft') => ({ op: 'upsert', kind: 'fr', key: `FR-CAP-0${n}`, parent_key: 'CAP', title: `r${n}`, status });
    const refused = (ops: unknown[]) => { try { w(ops); return ''; } catch (e) { return (e as Error).message; } };
    w([{ op: 'upsert', kind: 'module', key: 'CAP', title: 'Capacity' }, r(1), r(2, 'dropped')]);
    w([r(3)]); // the dropped FR-CAP-02 leaves room
    expect(refused([r(4)])).toMatch(/limit items_per_project/);
    arc.apply(p.id, 'FR-CAP-02', 'archive', op);
    // Archiving a retired item frees nothing more: it was not counted already.
    expect(refused([r(4)])).toMatch(/limit items_per_project/);
    // Bringing it back, still dropped, takes no room either; reopening it is refused like a creation.
    expect(arc.apply(p.id, 'FR-CAP-02', 'unarchive', op).done).toBe(true);
    expect(refused([r(2)])).toMatch(/limit items_per_project/);
    expect(bp.item(p.id, 'FR-CAP-02')!.status).toBe('dropped');
  });
});

describe('browse follow-ups (review notes on slice 3a)', () => {
  const op = { kind: 'operator' as const, id: null };
  const setup = (key: string) => {
    const bp = new Blueprint(app.db, {}), arc = new BlueprintArchive(app.db, bp);
    const p = bp.createProject({ key, name: `Case ${key}` }, op);
    const w = (ops: unknown[]) => bp.write(p.id, { version: bp.project(p.id)!.version, ops: ops as never }, op);
    const M = key.slice(0, 4);
    w([{ op: 'upsert', kind: 'module', key: M, title: 'Module' }, { op: 'upsert', kind: 'fr', key: `FR-${M}-01`, parent_key: M, title: 'Parent', status: 'dropped' },
      { op: 'upsert', kind: 'ac', key: `FR-${M}-01/AC1`, parent_key: `FR-${M}-01`, title: 'First', status: 'waived' },
      { op: 'upsert', kind: 'ac', key: `FR-${M}-01/AC2`, parent_key: `FR-${M}-01`, title: 'Second', status: 'waived' }]);
    return { bp, arc, p, w, fr: `FR-${M}-01` };
  };
  const refusal = (f: () => unknown) => { try { f(); return ''; } catch (e) { return (e as Error).message; } };

  it('a child of a kind with no retired status goes with its parent, and only a droppable child in play blocks', () => {
    const { arc, p, fr: k } = setup('KINDA');
    // No kind can be written under a retirable item without a retired status of its own today, so the case is built directly.
    app.db.prepare(`INSERT INTO bp_items(id,project_id,key,kind,parent_key,title,status,fields,position,rev,created_by_kind,created_at,updated_by_kind,updated_at)
      SELECT 'bpi_kinda_f', project_id, 'F-KINDA-01', 'finding', key, 'A finding under it', NULL, '{}', 0, 1, 'operator', created_at, 'operator', updated_at FROM bp_items WHERE project_id=? AND key=?`).run(p.id, k);
    expect(arc.plan(p.id, k, 'archive')).toEqual({ keys: [k, 'F-KINDA-01', `${k}/AC1`, `${k}/AC2`], blocking: [] });
    expect(arc.apply(p.id, k, 'archive', op).done).toBe(true);
    // A droppable child still in play blocks, and the refusal says to drop or move it.
    const b = setup('KINDB');
    b.w([{ op: 'upsert', kind: 'ac', key: `${b.fr}/AC3`, parent_key: b.fr, title: 'Open', status: 'open' }]);
    expect(refusal(() => b.arc.apply(b.p.id, b.fr, 'archive', op))).toMatch(/AC3 \(open\)\. Drop or move them first\./);
  });

  it('unarchive brings back only what went with it, and never a child under an archived parent', () => {
    const { bp, arc, p, fr: k } = setup('UNAR');
    // AC1 is archived on its own first; the parent's archive later takes AC2 only.
    arc.apply(p.id, `${k}/AC1`, 'archive', op);
    expect(arc.apply(p.id, k, 'archive', op).keys).toEqual([k, `${k}/AC2`]);
    expect(refusal(() => arc.apply(p.id, `${k}/AC2`, 'unarchive', op))).toMatch(`sits under ${k}, which is archived. Unarchive ${k} first`);
    expect(refusal(() => arc.apply(p.id, `${k}/AC1`, 'unarchive', op))).toMatch(/which is archived/);
    expect(arc.plan(p.id, k, 'unarchive').keys).toEqual([k, `${k}/AC2`]);
    expect(arc.apply(p.id, k, 'unarchive', op).keys).toEqual([k, `${k}/AC2`]);
    expect(bp.item(p.id, `${k}/AC1`)!.archived).toBe(1);
    expect(bp.item(p.id, `${k}/AC2`)!.archived).toBe(0);
    // With its parent back, the child comes back on its own.
    expect(arc.apply(p.id, `${k}/AC1`, 'unarchive', op).keys).toEqual([`${k}/AC1`]);
    const rows = app.db.prepare('SELECT archived_with FROM bp_items WHERE project_id=?').all(p.id) as { archived_with: string | null }[];
    expect(rows.every((r) => r.archived_with === null)).toBe(true);
  });

  it('a write may not touch an archived item, but may remove a link to it', () => {
    const { bp, arc, p, w, fr: k } = setup('WRIT');
    w([{ op: 'upsert', kind: 'risk', key: 'RK-01', title: 'A risk', status: 'open' }, { op: 'link', from: 'RK-01', to: k, rel: 'threatens' }]);
    arc.apply(p.id, k, 'archive', op);
    const v = bp.project(p.id)!.version;
    for (const ops of [[{ op: 'upsert', kind: 'fr', key: k, title: 'Edited' }], [{ op: 'remove', key: `${k}/AC1` }], [{ op: 'move', key: k, parent_key: 'WRIT' }],
      [{ op: 'upsert', kind: 'ac', key: `${k}/AC9`, parent_key: k, title: 'New child', status: 'open' }], [{ op: 'link', from: 'RK-01', to: `${k}/AC1`, rel: 'threatens' }]]) {
      expect(refusal(() => w(ops))).toMatch(/is archived and kept as it is/);
    }
    // Moving its status back into play is an edit too, so an archived item cannot come back to count that way.
    expect(refusal(() => w([{ op: 'upsert', kind: 'fr', key: k, status: 'draft' }]))).toMatch(/is archived and kept as it is/);
    expect(bp.project(p.id)!.version).toBe(v);
    // Unarchiving is the way back, and over the limit (the operator lowered it to 1) it is refused as a whole.
    const tight = new BlueprintArchive(app.db, new Blueprint(app.db, { itemsPerProject: 1 }));
    expect(refusal(() => tight.apply(p.id, k, 'unarchive', op))).toMatch(/limit items_per_project/);
    expect([k, `${k}/AC1`, `${k}/AC2`].map((x) => bp.item(p.id, x)!.archived)).toEqual([1, 1, 1]);
    expect(bp.project(p.id)!.version).toBe(v);
    expect(refusal(() => w([{ op: 'unlink', from: 'RK-01', to: k, rel: 'threatens' }]))).toBe('');
  });

  it('Archive on the Dropped screen is offered to the admin only', async () => {
    expect((await get(`/projects/${P}/browse?sel=dropped`)).body.may_archive).toBe(true);
    expect((await get(`/projects/${P}/browse?sel=dropped`, member)).body.may_archive).toBe(false);
  });

  it('a section read carries its list counts, so the filter row needs no request of its own', async () => {
    const r = (await get(`/projects/${P}/blueprint?section=2&detail=full`)).body;
    const b = (await get(`/projects/${P}/browse?section=2&limit=1`)).body;
    expect(r.browse).toEqual({ counts: b.counts, statuses: b.statuses });
    const t = (await get(`/projects/${P}/blueprint?section=2&team=${T}`)).body;
    expect(t.browse.counts).toEqual((await get(`/projects/${P}/browse?section=2&team=${T}&limit=1`)).body.counts);
    expect((await get(`/projects/${P}/blueprint`)).body.browse).toBeUndefined();
  });

  it('the Requirements bar counts what its label says: live FRs and NFRs, as the list it opens', async () => {
    const s = (await get(`/projects/${P}/summary`)).body;
    const live = (await get(`/projects/${P}/browse?kind=fr,nfr&sel=live`)).body;
    expect(s.measures.bars.frs.total).toBe(live.total);
    expect(live.filters.kind).toEqual(['fr', 'nfr']);
    expect(s.measures.bars.frs.done).toBe((await get(`/projects/${P}/browse?kind=fr,nfr&status=verified`)).body.total);
  });
});

describe('console: Dropped rows and section counts', () => {
  const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
  const dropped = js.slice(js.indexOf("} else if (tab === 'dropped') {"), js.indexOf('// One row of filters'));
  it('puts Archive beside the row, never inside it, and only when the hub allows it', () => {
    expect(dropped).toContain('<div class="bp-drow">${row({');
    expect(dropped).not.toContain('role="button"');
    // The row opens the item (its data-bp sits in bpTM's attrs) and closes before the Archive button starts.
    expect(dropped).toContain("{ 'data-bp': bpItemArg(pid, it.key) }),");
    expect(dropped).toContain('trail: bpSt(it.status) })}${may ? `<button');
    expect(dropped).toContain('${may ? `<button type="button" class="btn sm" data-bp-arch=');
  });
  it('counts ACs without the waived ones, and says so when every AC is waived', () => {
    const src = js.slice(js.indexOf('const bpAcCount = '), js.indexOf('};', js.indexOf('const bpAcCount = ')) + 2);
    const plural = js.slice(js.indexOf('const plural = '), js.indexOf('\n', js.indexOf('const plural = ')));
    const count = new Function(`${plural}\n${src} return bpAcCount;`)() as (a: { status: string }[], w?: string | null) => string;
    const ac = (...st: string[]) => st.map((status) => ({ status }));
    expect(count(ac('passing', 'open', 'waived'))).toBe('1 of 2 ACs passing');
    expect(count(ac('waived', 'waived'))).toBe('2 ACs waived');
    expect(count(ac('waived'))).toBe('1 AC waived');
    expect(count(ac('open'))).toBe('0 of 1 AC passing');
    expect(count(ac('waived', 'waived'), null)).toBe('2 waived');
    expect(count(ac('passing', 'waived'), null)).toBe('1 of 1 passing');
    expect(count([])).toBe('');
    expect(js).toContain("bpAcCount(acs) || 'No ACs'");
    expect(js).toContain('back to the lists, as they were.');
    expect(js).not.toContain('still dropped');
    expect(js).toContain('const acFull = it.archived ? acs : ');
  });
  it('asks the hub for a page of the browse list only when a filter is set', () => {
    expect(js).toContain("filtered ? bpBrowse(pid, { ...fq, x: la && f.x !== '-' ? f.x || bpLaX(tab, f.kind) : '', limit: 25, cursor: f.at }) : null");
    expect(js).toContain('counts: r.browse?.counts');
  });
});
