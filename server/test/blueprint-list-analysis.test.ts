/**
 * Blueprint list analysis (docs/blueprint.md §6.1): facets, gaps and the count table of a browse, on a project of about
 * 1,000 items. Every count must equal the length of the list it opens, across all pages; a member without task access
 * gets no No task gap or task facet and is told why; an item under two milestones counts in both and once in the total;
 * cursors are bound to their filters and viewer; and the six Coverage gaps equal Coverage's own counts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from '../src/app.js';
import { coverageCounts } from '../src/blueprint/coverage.js';
import { testConfig, adminLogin, ADMIN_PASSWORD } from './hub.js';

const sys = { kind: 'system' as const, id: null };
const PW = 'list analysis member password 1234';
const DAY = 86_400_000;
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
const PRI = ['must', 'should', 'could'];
const fr = (m: string, i: number) => `FR-${m}-${String(i).padStart(3, '0')}`;

interface Q { section?: number; f?: string[]; status?: string[]; gap?: string; x?: string; sel?: string }
const qs = (q: Q) => [q.section ? `section=${q.section}` : '', q.f?.length ? `f=${encodeURIComponent(q.f.join(','))}` : '', q.status?.length ? `status=${q.status.join(',')}` : '',
  q.gap ? `gap=${q.gap}` : '', q.x ? `x=${encodeURIComponent(q.x)}` : '', q.sel ? `sel=${q.sel}` : ''].filter(Boolean).join('&');
/** Every page of a list, following next_cursor. */
async function all(q: Q, who: S = admin): Promise<{ keys: string[]; first: any }> {
  const keys: string[] = [];
  let cursor: string | null = null, first: any = null;
  do {
    const r = await get(`/projects/${P}/browse?${qs(q)}&limit=100${cursor ? `&cursor=${cursor}` : ''}`, who);
    expect(r.status, r.text).toBe(200);
    first ??= r.body;
    keys.push(...r.body.items.map((i: { key: string }) => i.key));
    cursor = r.body.next_cursor;
  } while (cursor);
  expect(new Set(keys).size).toBe(keys.length);
  expect(keys.length).toBe(first.total);
  return { keys, first };
}
/** The filters of `q` with dimension `d`'s own replaced by one value (status is its own parameter). */
const only = (q: Q, d: string, v: string): Q => (d === 'status'
  ? { ...q, status: [v], f: (q.f ?? []).filter((x) => !x.startsWith('status:')) }
  : { ...q, f: [...(q.f ?? []).filter((x) => !x.startsWith(`${d}:`)), `${d}:${v}`] });

/** Checks every facet, gap and cell of a browse against the lists they open. */
async function checkCounts(q: Q, who: S = admin): Promise<any> {
  const { first: r } = await all(q, who);
  for (const f of r.facets) for (const v of f.values) {
    const opened = await all({ ...only(q, f.id, v.value), x: undefined }, who);
    expect(opened.keys.length, `${f.id}:${v.value}`).toBe(v.count);
  }
  for (const g of r.gaps) expect((await all({ ...q, gap: g.id, x: undefined }, who)).keys.length, `gap ${g.id}`).toBe(g.count);
  if (r.cross) {
    const { rows, cols } = r.cross;
    for (const [i, a] of r.cross.row_values.entries()) for (const [j, b] of r.cross.col_values.entries()) {
      const opened = await all({ ...only(only(q, rows, a.value), cols, b.value), x: undefined }, who);
      expect(opened.keys.length, `${rows}:${a.value} × ${cols}:${b.value}`).toBe(r.cross.cells[i][j]);
    }
    // A row's total is the items of that row value that have any column value, each once.
    for (const [i, a] of r.cross.row_values.entries()) {
      const opened = new Set<string>();
      for (const b of r.cross.col_values) for (const k of (await all({ ...only(only(q, rows, a.value), cols, b.value), x: undefined }, who)).keys) opened.add(k);
      expect(opened.size, `${rows}:${a.value} total`).toBe(r.cross.totals[i]);
    }
    // A column's total is the same, by column: the console turns the table with it.
    for (const [j, b] of r.cross.col_values.entries()) {
      const opened = new Set<string>();
      for (const a of r.cross.row_values) for (const k of (await all({ ...only(only(q, rows, a.value), cols, b.value), x: undefined }, who)).keys) opened.add(k);
      expect(opened.size, `${cols}:${b.value} total`).toBe(r.cross.col_totals[j]);
    }
  }
  expect((await all({ ...q, sel: 'open', x: undefined, status: undefined }, who)).keys.length).toBe(r.counts.open);
  expect((await all({ ...q, sel: 'dropped', x: undefined, status: undefined }, who)).keys.length).toBe(r.counts.dropped);
  expect((await all({ ...q, x: undefined, status: undefined }, who)).keys.length).toBe(r.counts.all);
  return r;
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahlist-'));
  mkdirSync(join(dir, 'vault'), { recursive: true });
  app = await buildApp(testConfig(dir));
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  admin = await adminLogin(base, 'admin', ADMIN_PASSWORD);
  P = (await post('/projects', { key: 'LAN', name: 'List analysis' })).body.project.id;
  const a = app.keys.createAgent('lan-coord', null, sys);
  app.keys.createSessionKey({ agentId: a.id, label: 'lan-coord key' }, sys);
  T = app.teams.create({ name: 'Analysis One', goal: 'goal', members: [{ agent_id: a.id, role: 'coordinator' }] }, sys).id;
  app.teams.start(T, sys);
  app.db.prepare('UPDATE teams SET project_id=? WHERE id=?').run(P, T);
  const op = { kind: 'operator' as const, id: null };
  const w = (ops: unknown[]) => { for (let i = 0; i < ops.length; i += 50) app.blueprint.write(P, { version: app.blueprint.project(P)!.version, ops: ops.slice(i, i + 50) as never }, op); };

  w([{ op: 'upsert', kind: 'module', key: 'AAA', title: 'Team module', team_id: T }, { op: 'upsert', kind: 'module', key: 'BBB', title: 'Project module' }]);
  const reqs: unknown[] = [], acs: unknown[] = [], links: unknown[] = [];
  const frs: string[] = [];
  // 200 FRs in the team's module and 500 at project level: statuses, priorities (every ninth has none), a few unclear.
  for (let i = 1; i <= 700; i++) {
    const m = i <= 200 ? 'AAA' : 'BBB', key = fr(m, i);
    frs.push(key);
    reqs.push({ op: 'upsert', kind: 'fr', key, parent_key: m, title: `Requirement ${i}`, status: STATUS[i % 5],
      fields: { ...(i % 9 ? { priority: PRI[(i >> 1) % 3] } : {}), ...(i % 50 === 1 ? { unclear: true } : {}) } });
    if (i % 6 === 0) acs.push({ op: 'upsert', kind: 'ac', key: `${key}/AC1`, parent_key: key, title: `Criterion ${i}`, status: i % 12 === 0 ? 'passing' : 'open', fields: i % 24 === 0 ? { evidence: 'run 12' } : {} });
  }
  const cats = ['performance', 'security', 'reliability', 'usability', 'operations'], pre = ['PERF', 'SEC', 'REL', 'USE', 'OPS'];
  for (let i = 1; i <= 150; i++) reqs.push({ op: 'upsert', kind: 'nfr', key: `NFR-${pre[i % 5]}-${String(i).padStart(3, '0')}`, parent_key: 'BBB', title: `Quality ${i}`, status: STATUS[(i + 1) % 5], fields: { category: cats[i % 5], priority: PRI[i % 3] } });
  w(reqs); w(acs);
  const rest: unknown[] = [
    { op: 'upsert', kind: 'milestone', key: 'M1', title: 'Alpha', status: 'planned', fields: { phase: 'Build', target_at: Date.now() - 3 * DAY } },
    { op: 'upsert', kind: 'milestone', key: 'M2', title: 'Beta', status: 'in_progress', fields: { phase: 'Build' } },
    { op: 'upsert', kind: 'milestone', key: 'M3', title: 'Gone', status: 'dropped' },
  ];
  for (let i = 1; i <= 20; i++) rest.push({ op: 'upsert', kind: 'question', key: `Q-${String(i).padStart(2, '0')}`, title: `Question ${i}`, status: i % 4 ? 'open' : 'answered', fields: { asked_at: Date.now() - (i % 3) * 10 * DAY, ...(i % 4 ? {} : { answer: 'yes' }) } });
  for (let i = 1; i <= 12; i++) rest.push({ op: 'upsert', kind: 'risk', key: `RK-${String(i).padStart(2, '0')}`, title: `Risk ${i}`, status: i % 3 ? 'open' : 'closed', fields: { likelihood: ['low', 'medium', 'high'][i % 3], impact: ['high', 'low'][i % 2], ...(i % 4 === 0 ? { owner: 'SH-1' } : i % 4 === 1 ? { owner: 'Saoirse Byrne' } : {}) } });
  w(rest);
  // M1 delivers every 7th FR, M2 every 11th (so every 77th has two milestones), the dropped M3 every 13th (it never counts).
  frs.forEach((k, n) => {
    const i = n + 1;
    if (i % 7 === 0) links.push({ op: 'link', from: 'M1', to: k, rel: 'delivers' });
    if (i % 11 === 0) links.push({ op: 'link', from: 'M2', to: k, rel: 'delivers' });
    if (i % 13 === 0) links.push({ op: 'link', from: 'M3', to: k, rel: 'delivers' });
  });
  for (let i = 1; i <= 12; i += 2) links.push({ op: 'link', from: `RK-${String(i).padStart(2, '0')}`, to: i % 4 === 1 ? 'M1' : 'M2', rel: 'threatens' });
  w(links);
  // Tasks of the team that name every fourth FR; a cancelled one does not count.
  const task = (id: string, status: string, refs: string[]) => app.db.prepare('INSERT INTO tasks(id,team_id,title,status,claimable,created_at,updated_at,plan_refs) VALUES (?,?,?,?,0,?,?,?)')
    .run(id, T, `Task ${id}`, status, Date.now(), Date.now(), JSON.stringify(refs));
  task('task_la1', 'open', frs.filter((_, n) => (n + 1) % 4 === 0));
  task('task_la2', 'cancelled', frs.filter((_, n) => (n + 1) % 4 === 2));
  // Some items have not changed for two months (the No change in 30 days gap).
  app.db.prepare("UPDATE bp_items SET updated_at=? WHERE project_id=? AND kind='fr' AND CAST(substr(key, -3) AS INTEGER) % 10 = 3").run(Date.now() - 60 * DAY, P);

  const c = await post('/users', { username: 'nadia' });
  const first = await adminLogin(base, 'nadia', c.body.password);
  expect((await call(first, 'POST', '/me/password', { current: c.body.password, new: PW })).status).toBe(200);
  expect((await call(admin, 'PUT', `/users/${c.body.user.id}/grants`, { grants: [{ project_id: P, components: ['blueprint'], vault_folders: [], may_export: false }] })).status).toBe(200);
  member = await adminLogin(base, 'nadia', PW);
}, 120_000);
afterAll(async () => { await app?.close(); });

describe('list analysis counts', () => {
  it('holds about a thousand items', () => {
    const n = (app.db.prepare('SELECT COUNT(*) n FROM bp_items WHERE project_id=? AND deleted_at IS NULL').get(P) as { n: number }).n;
    expect(n).toBeGreaterThanOrEqual(950);
  });

  it('gives facet, gap and cell counts that equal the lists they open, with filters and a count table', async () => {
    const r = await checkCounts({ section: 2, f: ['priority:must', 'priority:should'], x: 'area*milestone' });
    expect(r.filters.f).toEqual(['priority:must', 'priority:should']);
    expect(r.filters.x).toBe('area*milestone');
    expect(r.facets.map((f: { id: string }) => f.id)).toEqual(expect.arrayContaining(['status', 'team', 'kind', 'priority', 'area', 'milestone', 'task']));
    expect(r.gaps.map((g: { id: string }) => g.id)).toEqual(expect.arrayContaining(['no_ac', 'no_milestone', 'no_task', 'unclear', 'no_change', 'old_questions']));
    expect(r.cross.cells.flat().some((n: number) => n > 0)).toBe(true);
    expect(r.hidden).toEqual([]);
  }, 300_000);

  it('keeps every count true under a gap and a status', async () => {
    await checkCounts({ section: 2, gap: 'no_milestone', status: ['agreed', 'built'], x: 'priority*task' });
  }, 300_000);

  it('counts an FR delivered by two milestones in both groups and once in the total', async () => {
    const twice = fr('AAA', 77);
    const r = (await get(`/projects/${P}/browse?section=2&kind=fr&f=milestone:M1,milestone:M2&limit=100`)).body;
    const ms = r.facets.find((f: { id: string }) => f.id === 'milestone');
    expect(ms.multi).toBe(true);
    const m1 = (await all({ section: 2, f: ['milestone:M1'] })).keys, m2 = (await all({ section: 2, f: ['milestone:M2'] })).keys;
    const both = (await all({ section: 2, f: ['milestone:M1', 'milestone:M2'] })).keys;
    expect(m1).toContain(twice); expect(m2).toContain(twice);
    expect(both.filter((k) => k === twice)).toHaveLength(1);
    expect(both.length).toBe(new Set([...m1, ...m2]).size);
    expect(both.length).toBeLessThan(m1.length + m2.length);
    // The dropped milestone delivers nothing it can be grouped by.
    expect(ms.values.map((v: { value: string }) => v.value)).not.toContain('M3');
    expect(ms.values.find((v: { value: string }) => v.value === 'none').label).toBe('No milestone');
  });

  it('gives the six Coverage gaps the same counts as Coverage, over the whole project', async () => {
    const r = (await get(`/projects/${P}/browse?limit=1`)).body;
    const cov = coverageCounts(app.blueprint.coverageOf(P, null, 'all'));
    for (const [id, n] of Object.entries(cov)) expect(r.gaps.find((g: { id: string }) => g.id === id)?.count, id).toBe(n);
  });

  it('reads stored values only: an owner that is a name is just "has owner"', async () => {
    const r = (await get(`/projects/${P}/browse?section=5&kind=risk&limit=1`)).body;
    const owner = r.facets.find((f: { id: string }) => f.id === 'owner');
    expect(owner.values.map((v: { value: string }) => v.value).sort()).toEqual(['SH-1', 'has', 'none']);
    expect(JSON.stringify(r.facets)).not.toContain('Saoirse');
    await checkCounts({ section: 5, x: 'likelihood*impact' });
    await checkCounts({ section: 4, kind: undefined, f: ['phase:build'] } as Q);
  }, 120_000);
});

/** Every row of a list, following next_cursor, with any extra query (g, s). */
async function rowsOf(extra: string): Promise<{ rows: any[]; first: any }> {
  const rows: any[] = [];
  let cursor: string | null = null, first: any = null;
  do {
    const r = await get(`/projects/${P}/browse?${extra}&limit=100${cursor ? `&cursor=${cursor}` : ''}`);
    expect(r.status, r.text).toBe(200);
    first ??= r.body;
    rows.push(...r.body.items);
    cursor = r.body.next_cursor;
  } while (cursor);
  expect(rows.length).toBe(first.rows);
  return { rows, first };
}

describe('sort and group', () => {
  it('groups by a dimension across pages: each group is the list its value opens, and the total counts an item once', async () => {
    const { rows, first } = await rowsOf('section=2&kind=fr&g=milestone');
    expect(first.filters.g).toBe('milestone');
    const facet = first.facets.find((f: { id: string }) => f.id === 'milestone');
    expect(first.groups.map((g: { value: string }) => g.value)).toEqual(facet.values.map((v: { value: string }) => v.value));
    expect(first.groups.at(-1)).toMatchObject({ value: 'none', label: 'No milestone' });
    // Rows come group by group, never back to an earlier group.
    const order = first.groups.map((g: { value: string }) => g.value);
    const at = rows.map((r) => order.indexOf(r.group));
    expect(at.every((x, i) => x >= 0 && (i === 0 || x >= at[i - 1]))).toBe(true);
    for (const g of first.groups) {
      const keys = rows.filter((r) => r.group === g.value).map((r) => r.key);
      expect(keys.length, g.value).toBe(g.count);
      expect(keys.length, g.value).toBe(facet.values.find((v: { value: string }) => v.value === g.value).count);
      expect(new Set(keys)).toEqual(new Set((await all({ section: 2, f: ['kind:fr', `milestone:${g.value}`] })).keys));
    }
    const twice = fr('AAA', 77);
    expect(rows.filter((r) => r.key === twice).map((r) => r.group).sort()).toEqual(['M1', 'M2']);
    expect(first.total).toBe(new Set(rows.map((r) => r.key)).size);
    expect(first.rows).toBeGreaterThan(first.total);
  }, 120_000);

  it('sorts by name, by oldest change and by risk, over every page and with no repeat', async () => {
    const byName = (await rowsOf('section=2&kind=fr&s=name')).rows;
    expect(byName.map((r) => r.title)).toEqual([...byName.map((r) => r.title)].sort((a, b) => a.localeCompare(b)));
    const old = (await rowsOf('section=2&kind=fr&s=old')).rows.map((r) => r.key);
    const upd = new Map((app.db.prepare("SELECT key, updated_at FROM bp_items WHERE project_id=? AND kind='fr'").all(P) as { key: string; updated_at: number }[]).map((r) => [r.key, r.updated_at]));
    expect(old.map((k) => upd.get(k)!)).toEqual(old.map((k) => upd.get(k)!).sort((a, b) => a - b));
    expect(upd.get(old[0]!)).toBeLessThan(Date.now() - 50 * DAY);
    const { rows: risky, first } = await rowsOf('section=2&kind=fr&s=risk&sel=open');
    expect(new Set(risky.map((r) => r.key)).size).toBe(first.total);
    // Waiting on a decision first (the unclear ones wait on you).
    const decide = (await all({ section: 2, f: ['kind:fr'], sel: 'decide' })).keys;
    expect(decide.length).toBeGreaterThan(0);
    expect(new Set(risky.slice(0, decide.length).map((r) => r.key))).toEqual(new Set(decide));
    // Risks: high likelihood and impact first.
    const rk = (await rowsOf('section=5&kind=risk&s=risk')).rows.map((r) => r.fields);
    expect(rk[0]).toMatchObject({ likelihood: 'high', impact: 'high' });
  }, 120_000);

  it('binds the cursor to the sort and the group, says what the selection holds, and refuses an unknown sort', async () => {
    const r = (await get(`/projects/${P}/browse?section=2&kind=fr&s=name&limit=10`)).body;
    expect((await get(`/projects/${P}/browse?section=2&kind=fr&s=old&limit=10&cursor=${r.next_cursor}`)).status).toBe(400);
    expect((await get(`/projects/${P}/browse?section=2&kind=fr&s=name&g=priority&limit=10&cursor=${r.next_cursor}`)).status).toBe(400);
    expect((await get(`/projects/${P}/browse?section=2&s=newest`)).status).toBe(400);
    expect((await get(`/projects/${P}/browse?section=2&g=colour`)).status).toBe(400);
    const out = (await get(`/projects/${P}/browse?section=2&kind=fr&g=likelihood&limit=1`)).body;
    expect(out.ignored).toEqual(['g:likelihood']);
    expect(out.groups).toBeNull();
    // "Showing N of M": M is the selection before the dimension filters and the gap.
    const open = (await get(`/projects/${P}/browse?section=2&sel=open&limit=1`)).body;
    const some = (await get(`/projects/${P}/browse?section=2&sel=open&f=priority:must&gap=no_ac&limit=1`)).body;
    expect(some.of).toBe(open.total);
    expect(some.total).toBeLessThan(some.of);
  });
});

describe('scope', () => {
  it('gives a member without task access no No task gap or task facet, and says why', async () => {
    const r = await checkCounts({ section: 2, f: ['priority:must'] }, member);
    expect(r.gaps.map((g: { id: string }) => g.id)).not.toContain('no_task');
    expect(r.facets.map((f: { id: string }) => f.id)).not.toContain('task');
    expect(r.hidden).toEqual([{ id: 'no_task', reason: 'No task needs task access' }, { id: 'task', reason: 'No task needs task access' }]);
    // Asking for them anyway changes nothing and is listed as left out, never refused (a refusal would say tasks exist).
    const asked = (await get(`/projects/${P}/browse?section=2&gap=no_task&f=task:has&limit=1`, member)).body;
    expect(asked.ignored).toEqual(['task:has', 'gap:no_task']);
    expect(asked.total).toBe((await get(`/projects/${P}/browse?section=2&limit=1`, member)).body.total);
  }, 300_000);

  it('binds a cursor to its filters and its viewer', async () => {
    const r = (await get(`/projects/${P}/browse?section=2&f=priority:must&limit=10`)).body;
    expect(r.next_cursor).toBeTruthy();
    expect((await get(`/projects/${P}/browse?section=2&f=priority:must&limit=10&cursor=${r.next_cursor}`)).status).toBe(200);
    // The count table is not a filter: asking for one keeps the cursor good.
    expect((await get(`/projects/${P}/browse?section=2&f=priority:must&x=priority*area&limit=10&cursor=${r.next_cursor}`)).status).toBe(200);
    const other = await get(`/projects/${P}/browse?section=2&f=priority:could&limit=10&cursor=${r.next_cursor}`);
    expect(other.status).toBe(400);
    expect(other.text).toContain('other filters or another viewer');
    expect((await get(`/projects/${P}/browse?section=2&f=priority:must&limit=10&cursor=${r.next_cursor}`, member)).status).toBe(400);
  });

  it('leaves out values that no longer apply and refuses unknown dimensions and gaps', async () => {
    const r = (await get(`/projects/${P}/browse?section=2&f=milestone:M99,priority:must&limit=1`)).body;
    expect(r.ignored).toEqual(['milestone:M99']);
    expect(r.filters.f).toEqual(['priority:must']);
    expect((await get(`/projects/${P}/browse?section=2&f=colour:red`)).status).toBe(400);
    expect((await get(`/projects/${P}/browse?section=2&gap=nothing`)).status).toBe(400);
    expect((await get(`/projects/${P}/browse?section=2&x=priority*priority`)).status).toBe(400);
    expect((await get(`/projects/${P}/browse?section=2&f=status:missed`)).status).toBe(400);
  });

  it('sees a change at once: the cached values follow the project', async () => {
    const before = (await get(`/projects/${P}/browse?section=2&kind=fr&f=milestone:M2&limit=1`)).body.total;
    app.blueprint.write(P, { version: app.blueprint.project(P)!.version, ops: [{ op: 'link', from: 'M2', to: fr('AAA', 1), rel: 'delivers' }] as never }, { kind: 'operator', id: null });
    expect((await get(`/projects/${P}/browse?section=2&kind=fr&f=milestone:M2&limit=1`)).body.total).toBe(before + 1);
    // A task change alone (no Blueprint write) moves the task counts too.
    const has = (await get(`/projects/${P}/browse?section=2&kind=fr&f=task:has&limit=1`)).body.total;
    app.db.prepare("UPDATE tasks SET status='cancelled', updated_at=? WHERE id='task_la1'").run(Date.now() + 1);
    expect(has).toBeGreaterThan(0);
    expect((await get(`/projects/${P}/browse?section=2&kind=fr&f=task:has&limit=1`)).body.total).toBe(0);
  });
});
