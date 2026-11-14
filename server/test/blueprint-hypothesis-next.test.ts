/**
 * A hypothesis's next step (docs/blueprint.md §2.7): the hub works it out from the status and the findings linked as
 * evidence, never from agent text, and gives it in bp_read full (`next`) and in the item read the console's hypothesis
 * screen uses.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from '../src/app.js';
import type { Op } from '../src/blueprint/blueprint.js';
import { testConfig, adminLogin } from './hub.js';

const sys = { kind: 'system' as const, id: null };
const opr = () => ({ kind: 'operator' as const, id: null });
let app: App, base = '', P = '', team = '', admin: { cookie: string; csrf: string };
const put = (ops: Op[]) => app.blueprint.write(P, { version: app.blueprint.project(P)!.version, ops }, opr());
const next = (key: string) => app.blueprint.nextStep(P, key);

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahnext-'));
  mkdirSync(join(dir, 'vault'));
  app = await buildApp(testConfig(dir));
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  admin = await adminLogin(base);
  const a = app.keys.createAgent('coord', null, sys);
  const k = app.keys.createSessionKey({ agentId: a.id, label: 'coord' }, sys);
  team = app.teams.create({ name: 'Grip Lab', goal: 'g', members: [{ agent_id: a.id, role: 'coordinator', credential_id: k.credential.id }] }, sys).id;
  P = app.blueprint.ensureTeamProject(team).id;
  put([
    { op: 'upsert', kind: 'line', key: 'L1', title: 'Pad grip', fields: { mode: 'validate' }, team_id: team },
    { op: 'upsert', kind: 'hypothesis', key: 'H-L1-01', parent_key: 'L1', title: 'No finding yet' },
    { op: 'upsert', kind: 'hypothesis', key: 'H-L1-02', parent_key: 'L1', title: 'Only weak findings' },
    { op: 'upsert', kind: 'hypothesis', key: 'H-L1-03', parent_key: 'L1', title: 'Some decided' },
    { op: 'upsert', kind: 'hypothesis', key: 'H-L1-04', parent_key: 'L1', title: 'One decided finding' },
    { op: 'upsert', kind: 'hypothesis', key: 'H-L1-05', parent_key: 'L1', title: 'Confirmed, not cited' },
    { op: 'upsert', kind: 'hypothesis', key: 'H-L1-06', parent_key: 'L1', title: 'Confirmed and cited' },
    { op: 'upsert', kind: 'finding', key: 'F-L1-01', parent_key: 'L1', title: 'Low', fields: { confidence: 'low' } },
    { op: 'upsert', kind: 'finding', key: 'F-L1-02', parent_key: 'L1', title: 'Medium', fields: { confidence: 'medium' } },
    { op: 'upsert', kind: 'finding', key: 'F-L1-03', parent_key: 'L1', title: 'High', fields: { confidence: 'high' } },
    { op: 'upsert', kind: 'paper', key: 'PAP-1', title: 'Grip', team_id: team, status: 'planned' },
    { op: 'upsert', kind: 'claim', key: 'PAP-1/C1', parent_key: 'PAP-1', title: 'Pads grip' },
    { op: 'link', from: 'F-L1-01', to: 'H-L1-02', rel: 'evidence' },
    { op: 'link', from: 'F-L1-01', to: 'H-L1-03', rel: 'evidence' },
    { op: 'link', from: 'F-L1-02', to: 'H-L1-03', rel: 'evidence' },
    { op: 'link', from: 'F-L1-03', to: 'H-L1-03', rel: 'evidence' },
    { op: 'link', from: 'F-L1-03', to: 'H-L1-04', rel: 'evidence' },
    { op: 'link', from: 'F-L1-02', to: 'H-L1-05', rel: 'evidence' },
    { op: 'link', from: 'F-L1-03', to: 'H-L1-05', rel: 'evidence' },
    { op: 'link', from: 'F-L1-03', to: 'H-L1-06', rel: 'evidence' },
    { op: 'link', from: 'H-L1-06', to: 'PAP-1/C1', rel: 'evidence' },
  ]);
  put([{ op: 'upsert', kind: 'hypothesis', key: 'H-L1-02', status: 'testing' }, { op: 'upsert', kind: 'hypothesis', key: 'H-L1-05', status: 'confirmed' }, { op: 'upsert', kind: 'hypothesis', key: 'H-L1-06', status: 'confirmed' }]);
});
afterAll(async () => { await app?.close(); });

describe('a hypothesis next step (§2.7)', () => {
  it('follows the status and the findings linked as evidence', () => {
    expect(next('H-L1-01')).toBe('Link a finding as evidence.');
    expect(next('H-L1-02')).toBe('Add a finding with medium or high confidence.');
    expect(next('H-L1-03')).toBe('Decide its status: 2 of 3 findings have medium or high confidence.');
    expect(next('H-L1-04')).toBe('Decide its status: its one finding has medium or high confidence.');
    expect(next('H-L1-05')).toBe('Cite it as evidence in a paper claim.');
    expect(next('H-L1-06')).toBeNull();
    // With no finding the step is the same whatever the status.
    put([{ op: 'upsert', kind: 'hypothesis', key: 'H-L1-07', parent_key: 'L1', title: 'Confirmed without findings' }]);
    put([{ op: 'upsert', kind: 'hypothesis', key: 'H-L1-07', status: 'confirmed' }]);
    expect(next('H-L1-07')).toBe('Link a finding as evidence.');
    // Only hypotheses have one.
    expect(next('L1')).toBeNull();
    expect(next('PAP-1/C1')).toBeNull();
    expect(next('H-L1-99')).toBeNull();
  });

  it('counts all findings when every one is decided, and drops to none once refuted and cited', () => {
    put([{ op: 'unlink', from: 'F-L1-01', to: 'H-L1-03', rel: 'evidence' }]);
    expect(next('H-L1-03')).toBe('Decide its status: both findings have medium or high confidence.');
    put([{ op: 'upsert', kind: 'hypothesis', key: 'H-L1-03', status: 'refuted' }]);
    expect(next('H-L1-03')).toBe('Cite it as evidence in a paper claim.');
    put([{ op: 'link', from: 'H-L1-03', to: 'PAP-1/C1', rel: 'evidence' }]);
    expect(next('H-L1-03')).toBeNull();
  });

  it('comes in bp_read full and the item read, never in the short read', async () => {
    expect(app.blueprint.read(P, team, { keys: ['H-L1-01'], detail: 'full' }).items[0]!.next).toBe('Link a finding as evidence.');
    expect(app.blueprint.read(P, team, { keys: ['H-L1-01'] }).items[0]!.next).toBeUndefined();
    expect(app.blueprint.read(P, team, { keys: ['H-L1-06'], detail: 'full' }).items[0]!.next).toBeUndefined();
    const get = async (key: string) => (await (await fetch(`${base}/api/projects/${P}/items/${key}`, { headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf } })).json()) as { next?: string; standing?: string };
    const d = await get('H-L1-05');
    expect(d.next).toBe('Cite it as evidence in a paper claim.');
    expect(d.standing).toBe('Confirmed. From 2 findings; backs no claim yet.');
    expect((await get('H-L1-06')).next).toBeUndefined();
  });
});
