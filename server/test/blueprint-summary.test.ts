/**
 * The section 2 summary's two named lists (docs/blueprint.md §6.1, `decide` and `risk`): each count equals the list it
 * opens, the rows say who they wait on and why in fixed words, a blocked item is listed as the item (not the issue),
 * an item is counted once, the late-milestone function, and the lists are refused outside section 2.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from '../src/app.js';
import type { Op } from '../src/blueprint/blueprint.js';
import { milestoneLate } from '../src/blueprint/kinds.js';
import { testConfig, adminLogin } from './hub.js';

const DAY = 86_400_000;
type S = { cookie: string; csrf: string };
let app: App, base = '', admin: S, adminId = '', D = '', R = '';

const call = async (path: string): Promise<{ status: number; body: any }> => {
  const r = await fetch(`${base}/api${path}`, { headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf } });
  const t = await r.text(); let j: any = {}; try { j = JSON.parse(t); } catch { /* not JSON */ }
  return { status: r.status, body: j };
};
const post = async (path: string, body: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: admin.cookie, 'x-csrf-token': admin.csrf }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as any };
};
const opr = () => ({ kind: 'operator' as const, id: adminId });
const put = (pid: string, ops: Op[]) => app.blueprint.write(pid, { version: app.blueprint.project(pid)!.version, ops }, opr());
const list = async (pid: string, sel: string, extra = '') => (await call(`/projects/${pid}/browse?section=2&sel=${sel}&limit=100${extra}`)).body;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahsum-'));
  mkdirSync(join(dir, 'vault'));
  app = await buildApp(testConfig(dir));
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  admin = await adminLogin(base);
  adminId = (app.db.prepare('SELECT id FROM admin_users LIMIT 1').get() as { id: string }).id;
  D = (await post('/projects', { key: 'SUMD', name: 'Delivery case' })).body.project.id;
  R = (await post('/projects', { key: 'SUMR', name: 'Research case', kind: 'research' })).body.project.id;
  const now = Date.now();
  put(D, [
    { op: 'upsert', kind: 'module', key: 'REC', title: 'Session recording' },
    { op: 'upsert', kind: 'fr', key: 'FR-REC-01', parent_key: 'REC', title: 'Authority time', status: 'agreed', fields: { unclear: true } },
    { op: 'upsert', kind: 'fr', key: 'FR-REC-02', parent_key: 'REC', title: 'Full-rate record', status: 'built' },
    { op: 'upsert', kind: 'ac', key: 'FR-REC-02/AC1', parent_key: 'FR-REC-02', title: 'Keeps every event', status: 'failing' },
    { op: 'upsert', kind: 'fr', key: 'FR-REC-03', parent_key: 'REC', title: 'Replay timing', status: 'agreed' },
    { op: 'upsert', kind: 'milestone', key: 'M1', title: 'First cut', status: 'in_progress', fields: { target_at: now - 6 * DAY } },
    { op: 'link', from: 'M1', to: 'FR-REC-03', rel: 'delivers' },
    { op: 'upsert', kind: 'fr', key: 'FR-REC-04', parent_key: 'REC', title: 'Exports', status: 'agreed' },
    { op: 'upsert', kind: 'risk', key: 'RK-01', title: 'Clock drift', status: 'open', fields: { likelihood: 'high', impact: 'low' } },
    { op: 'upsert', kind: 'risk', key: 'RK-02', title: 'Minor', status: 'open', fields: { likelihood: 'medium', impact: 'medium' } },
    { op: 'link', from: 'RK-01', to: 'FR-REC-04', rel: 'threatens' },
    { op: 'link', from: 'RK-02', to: 'FR-REC-03', rel: 'threatens' },
    { op: 'upsert', kind: 'fr', key: 'FR-REC-05', parent_key: 'REC', title: 'Markers', status: 'draft' },
    { op: 'upsert', kind: 'issue', key: 'I4', title: 'Hosts disagree on time', status: 'open' },
    { op: 'link', from: 'I4', to: 'FR-REC-05', rel: 'blocks' },
    { op: 'upsert', kind: 'fr', key: 'FR-REC-06', parent_key: 'REC', title: 'Verified one', status: 'verified', fields: { unclear: false } },
    { op: 'upsert', kind: 'ac', key: 'FR-REC-06/AC1', parent_key: 'FR-REC-06', title: 'Failing on a verified', status: 'failing' },
    { op: 'upsert', kind: 'question', key: 'Q-REC-01', parent_key: 'REC', title: 'Are clocks close?', status: 'open', fields: { asked_to: 'SH-2', asked_at: now - 16 * DAY } },
    { op: 'link', from: 'Q-REC-01', to: 'FR-REC-01', rel: 'blocks' },
    { op: 'upsert', kind: 'question', key: 'Q-REC-02', parent_key: 'REC', title: 'Blocks nothing', status: 'open' },
  ]);
  put(R, [
    { op: 'upsert', kind: 'line', key: 'L1', title: 'Sync', fields: { mode: 'validate' } },
    { op: 'upsert', kind: 'hypothesis', key: 'H-L1-01', parent_key: 'L1', title: 'Lag noticed', status: 'testing' },
    { op: 'upsert', kind: 'finding', key: 'F-L1-01', parent_key: 'L1', title: 'Pilot', fields: { confidence: 'high' } },
    { op: 'link', from: 'F-L1-01', to: 'H-L1-01', rel: 'evidence' },
    { op: 'upsert', kind: 'hypothesis', key: 'H-L1-02', parent_key: 'L1', title: 'Cues help', status: 'inconclusive' },
    { op: 'upsert', kind: 'hypothesis', key: 'H-L1-03', parent_key: 'L1', title: 'Done one', status: 'confirmed' },
    { op: 'upsert', kind: 'question', key: 'Q-L1-01', parent_key: 'L1', title: 'Asked long ago', status: 'open', fields: { asked_to: 'SH-1', asked_at: now - 30 * DAY } },
    { op: 'link', from: 'Q-L1-01', to: 'H-L1-01', rel: 'blocks' },
  ]);
});
afterAll(async () => { await app.fastify.close(); });

describe('the section 2 summary lists', () => {
  it('lists what waits on a decision, you first, then the team, then others, with fixed-wording reasons', async () => {
    const r = await list(D, 'decide');
    const keys = r.items.map((i: { key: string }) => i.key);
    expect(keys[0]).toBe('FR-REC-01');
    expect(keys.sort()).toEqual(['FR-REC-01', 'FR-REC-05', 'Q-REC-01']);
    const by = Object.fromEntries(r.items.map((i: { key: string }) => [i.key, i]));
    expect(by['FR-REC-01'].why[0]).toMatchObject({ code: 'you', text: 'Waiting on you' });
    // The blocked item is listed (Waiting on I4), never the issue itself.
    expect(by['FR-REC-05'].why.map((w: { text: string }) => w.text)).toEqual(['Waiting on I4']);
    expect(keys).not.toContain('I4');
    // A question: its age, what it blocks and Overdue after 14 days; the writer's asked_to stays in the fields.
    expect(by['Q-REC-01'].why[0]).toMatchObject({ code: 'asked', text: '16 days' });
    expect(by['Q-REC-01'].blocks).toEqual(['FR-REC-01']);
    expect(by['Q-REC-01'].overdue).toBe(true);
    expect(by['Q-REC-01'].fields.asked_to).toBe('SH-2');
    expect(JSON.stringify(by['Q-REC-01'].why)).not.toContain('SH-2');
    expect(keys).not.toContain('Q-REC-02');
  });
  it('lists what is at risk, counted once, high risks only, and ignores verified items', async () => {
    const r = await list(D, 'risk');
    expect(r.items.map((i: { key: string }) => i.key).sort()).toEqual(['FR-REC-02', 'FR-REC-03', 'FR-REC-04']);
    const by = Object.fromEntries(r.items.map((i: { key: string }) => [i.key, i.why.map((w: { text: string }) => w.text)]));
    expect(by['FR-REC-02']).toEqual(['1 criterion failing']);
    expect(by['FR-REC-03']).toEqual(['M1 overdue by 6 days']); // RK-02 is medium: not listed
    expect(by['FR-REC-04']).toEqual(['Threatened by RK-01']);
    const decide = (await list(D, 'decide')).items.map((i: { key: string }) => i.key);
    for (const k of Object.keys(by)) expect(decide).not.toContain(k);
  });
  it('counts equal the lists they open, with the same team and search filters', async () => {
    const first = (await call(`/projects/${D}/browse?section=2&limit=1`)).body;
    const decide = await list(D, 'decide'), risk = await list(D, 'risk');
    expect(first.counts.decide).toBe(decide.total);
    expect(first.counts.risk).toBe(risk.total);
    expect(first.counts.decide).toBe(3);
    expect(first.counts.risk).toBe(3);
    const s = (await call(`/projects/${D}/browse?section=2&q=replay&limit=1`)).body;
    expect(s.counts.decide).toBe((await list(D, 'decide', '&q=replay')).total);
    expect(s.counts.risk).toBe((await list(D, 'risk', '&q=replay')).total);
    expect(s.counts.risk).toBe(1);
    expect(decide.selection).toMatchObject({ id: 'decide', label: 'Waiting on a decision' });
  });
  it('adds decide and risk to the counts of section 2 only, and refuses the lists elsewhere', async () => {
    const other = (await call(`/projects/${D}/browse?section=4&limit=1`)).body;
    expect(other.counts.decide).toBeUndefined();
    expect((await call(`/projects/${D}/browse?section=4&sel=decide`)).status).toBe(400);
    expect((await call(`/projects/${D}/browse?sel=risk`)).status).toBe(400);
    expect((await call(`/projects/${D}/browse?section=2&sel=nonsense`)).status).toBe(400);
  });
  it('reads research: a testing hypothesis with a finding and an inconclusive one wait on the team, no Overdue outside delivery', async () => {
    const r = await list(R, 'decide');
    const by = Object.fromEntries(r.items.map((i: { key: string }) => [i.key, i]));
    expect(Object.keys(by).sort()).toEqual(['H-L1-01', 'H-L1-02', 'Q-L1-01']);
    expect(by['H-L1-01'].why[0]).toMatchObject({ code: 'team', text: '1 finding, no verdict' });
    expect(by['H-L1-02'].why[0]).toMatchObject({ code: 'team', text: 'Inconclusive: retest, reframe or drop' });
    expect(by['Q-L1-01'].overdue).toBe(false);
    expect(r.items.map((i: { key: string }) => i.key).slice(0, 2).sort()).toEqual(['H-L1-01', 'H-L1-02']);
    expect((await list(R, 'risk')).total).toBe(0);
  });
});

describe('the late-milestone function', () => {
  it('is missed, or overdue only while planned or in progress', () => {
    const now = 100 * DAY;
    expect(milestoneLate({ status: 'missed' }, now)).toEqual({ state: 'missed' });
    expect(milestoneLate({ status: 'in_progress', target_at: now - 3 * DAY }, now)).toEqual({ state: 'overdue', days: 3 });
    expect(milestoneLate({ status: 'planned', target_at: now - 1 }, now)).toMatchObject({ state: 'overdue' });
    expect(milestoneLate({ status: 'reached', target_at: now - 3 * DAY }, now)).toBeNull();
    expect(milestoneLate({ status: 'planned', target_at: now + DAY }, now)).toBeNull();
    expect(milestoneLate({ status: 'planned' }, now)).toBeNull();
  });
});
