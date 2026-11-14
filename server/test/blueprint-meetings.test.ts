/**
 * The note an item came from and the Meetings view (docs/blueprint.md §2.7, §9): `source` on requirements, issues and
 * questions resolves through Sources; a missing note warns and never refuses; a note's date is its frontmatter date, else
 * its file name's; a note the viewer can't read is left out with its items.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from '../src/app.js';
import type { Op } from '../src/blueprint/blueprint.js';
import { Sources } from '../src/blueprint/sources.js';
import { Meetings, sourceTexts } from '../src/blueprint/meetings.js';
import { testConfig, adminLogin } from './hub.js';

const sys = { kind: 'system' as const, id: null };
const opr = () => ({ kind: 'operator' as const, id: null });
let app: App, base = '', cookie = '', P = '', team = '';
const put = (ops: Op[]) => app.blueprint.write(P, { version: app.blueprint.project(P)!.version, ops }, opr());
const get = async (path: string) => { const r = await fetch(`${base}/api${path}`, { headers: { cookie } }); return { status: r.status, body: await r.json() as any }; };
const meetings = () => new Meetings(app.db, app.vault, new Sources(app.db, app.vault));

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bp-mtg-'));
  mkdirSync(join(dir, 'vault', 'Meetings'), { recursive: true });
  mkdirSync(join(dir, 'vault', 'HR'), { recursive: true });
  writeFileSync(join(dir, 'vault', 'Meetings', '2026-11-13 Sprint review.md'), '# Sprint review\n');
  writeFileSync(join(dir, 'vault', 'Meetings', 'Client demo.md'), '---\ntitle: "Client demo, round 2"\ndate: 2026-11-06\n---\n# Demo\n');
  writeFileSync(join(dir, 'vault', 'Meetings', 'Kickoff.md'), '# Kickoff, no date anywhere\n');
  writeFileSync(join(dir, 'vault', 'HR', '2026-11-10 Security review.md'), '# Private\n');
  app = await buildApp(testConfig(dir, { pepper: 'p', publicUrl: 'http://127.0.0.1', adminPassword: 'admin-password-long' }));
  await app.store.ready;
  await app.store.scan();
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  ({ cookie } = await adminLogin(base, 'admin', 'admin-password-long'));
  const a = app.keys.createAgent('Ada', null, sys), k = app.keys.createSessionKey({ agentId: a.id, label: 'Ada' }, sys);
  app.keys.setRules(k.credential.policy_id, [{ effect: 'allow', actions: ['fs.read'], resource: 'path:/vault/Meetings/**' }], 'test', sys);
  team = app.teams.create({ name: 'Delivery', goal: 'g', members: [{ agent_id: a.id, role: 'coordinator', credential_id: k.credential.id }] }, sys).id;
  P = app.blueprint.ensureTeamProject(team).id;
  put([
    { op: 'upsert', kind: 'module', key: 'TEAM', title: 'Team', team_id: team },
    { op: 'upsert', kind: 'fr', key: 'FR-TEAM-12', parent_key: 'TEAM', title: 'Export the board', fields: { source: '[[2026-11-13 Sprint review]]' } },
    { op: 'upsert', kind: 'nfr', key: 'NFR-SEC-01', parent_key: 'TEAM', title: 'Sign-in is rate limited', fields: { category: 'security', source: 'HR/2026-11-10 Security review.md' } },
    { op: 'upsert', kind: 'issue', key: 'I4', title: 'The demo board loads slowly', fields: { source: 'Meetings/Client demo.md' }, team_id: team },
    { op: 'upsert', kind: 'risk', key: 'RK-01', title: 'The client changes scope', fields: { source: 'Meetings/2026-11-13 Sprint review.md' }, team_id: team },
    { op: 'upsert', kind: 'decision', key: 'ADR-001', title: 'Board export is CSV', fields: { source: 'coordinator' }, team_id: team },
    { op: 'upsert', kind: 'issue', key: 'I5', title: 'Kickoff follow-up', fields: { source: '[[Kickoff]]' }, team_id: team },
  ]);
});
afterAll(async () => { await app?.close(); });

describe('source on requirements, issues and questions', () => {
  it('is accepted on fr, nfr, issue and question, and a missing note warns without refusing the write', () => {
    const ops: Op[] = [
      { op: 'upsert', kind: 'line', key: 'L1', title: 'Discovery', fields: { mode: 'explore' }, team_id: team },
      { op: 'upsert', kind: 'question', key: 'Q-L1-01', parent_key: 'L1', title: 'Who signs off?', fields: { source: 'Meetings/Not written yet.md' } },
    ];
    put(ops);
    expect(app.blueprint.item(P, 'Q-L1-01')!.fields['source']).toBe('Meetings/Not written yet.md');
  });
});

describe('Meetings', () => {
  it('reads the date from frontmatter, else the file name, and the title the same way', async () => {
    const m = meetings();
    expect(await m.note('/vault/Meetings/2026-11-13 Sprint review.md')).toEqual({ path: '/vault/Meetings/2026-11-13 Sprint review.md', title: 'Sprint review', date: '2026-11-13' });
    expect(await m.note('/vault/Meetings/Client demo.md')).toEqual({ path: '/vault/Meetings/Client demo.md', title: 'Client demo, round 2', date: '2026-11-06' });
    expect((await m.note('/vault/Meetings/Kickoff.md')).date).toBeNull();
  });

  it('lists the cited notes newest first, undated last, each with its items; free-text sources are not notes', async () => {
    const L = await meetings().list(P);
    expect(L.map((n) => [n.title, n.date, n.items.map((i) => i.key)])).toEqual([
      ['Sprint review', '2026-11-13', ['FR-TEAM-12', 'RK-01']],
      ['Security review', '2026-11-10', ['NFR-SEC-01']],
      ['Client demo, round 2', '2026-11-06', ['I4']],
      ['Kickoff', null, ['I5']],
    ]);
  });

  it('leaves out a note the viewer cannot read, and its items', async () => {
    const viewer = { canSee: (rel: string) => rel.startsWith('Meetings/') };
    const L = await meetings().list(P, {}, viewer);
    expect(L.map((n) => n.title)).toEqual(['Sprint review', 'Client demo, round 2', 'Kickoff']);
    expect(L.flatMap((n) => n.items.map((i) => i.key))).not.toContain('NFR-SEC-01');
  });

  it('the route lists them with the item count, and an item read carries its From note', async () => {
    const r = await get(`/projects/${P}/meetings`);
    expect(r.status).toBe(200);
    expect(r.body.notes).toHaveLength(4);
    expect(r.body.items).toBe(5);
    expect((await get(`/projects/${P}/meetings?team=project`)).body.notes).toEqual([]);
    expect((await get(`/projects/${P}/meetings?team=nope`)).status).toBe(400);
    const d = await get(`/projects/${P}/items/FR-TEAM-12`);
    expect(d.body.from).toEqual({ path: '/vault/Meetings/2026-11-13 Sprint review.md', title: 'Sprint review', date: '2026-11-13' });
    expect((await get(`/projects/${P}/items/ADR-001`)).body.from).toBeUndefined();
  });

  it('finds the note from every link form the vault viewer opens', async () => {
    const m = meetings(), src = new Sources(app.db, app.vault);
    const forms: [string, string][] = [
      ['/Meetings/Client demo.md', 'Client demo.md'], ['/vault/Meetings/Client%20demo.md', 'Client demo.md'], ['Meetings/Client%20demo', 'Client demo.md'],
      ['[[Meetings/Kickoff]]', 'Kickoff.md'], ['[[Kickoff#Actions]]', 'Kickoff.md'], ['[[Meetings/Kickoff|the kickoff]]', 'Kickoff.md'], ['meetings/kickoff.md', 'Kickoff.md'],
    ];
    for (const [source, file] of forms) {
      const fields = { source };
      const from = await m.from(fields, await src.resolve(P, team, sourceTexts(fields)));
      expect(from?.path, source).toBe(`/vault/Meetings/${file}`);
    }
  });
});
