/**
 * "In short" (docs/mcp.md, Task summary): a coordinator sets a task's short plain-text summary with task_create or
 * task_update (at most 280 characters, "" clears it); without one, task views carry the hub's cut of the description
 * (short_summary_hub): its first sentences without Markdown, file paths or commit hashes. The operator sets it too (admin API).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';
import { hubShortSummary, normShortSummary, HUB_SUMMARY_MAX, SHORT_SUMMARY_MAX } from '../src/teams/shortSummary.js';

// A made-up brief shaped like a real task: a long first paragraph with a path, a hash and a line number, then a list.
const BRIEF = `Follow-up to Ben's pick 8 (Panel 05 flicker). Layout Team found the cause (develop 1a2b3c4d, notes/handoff/panel-flicker/panel05/): DepthClip.tsx:57 sets near = scene distance / 100, about 1.3 m in the large hall. So panel 05's edge, and any close view in a big hall, is clipped. Render Team already proposed this fix on 13 Nov (CloseView).
Do:
- make the near plane follow the camera;
- no z-fighting in far views;
- tests pass; before/after frames.`;

describe('the hub\'s summary of a description', () => {
  it('keeps the first two sentences of the first paragraph, without paths, hashes or line numbers', () => {
    expect(hubShortSummary(BRIEF)).toBe('Follow-up to Ben\'s pick 8 (Panel 05 flicker). Layout Team found the cause: DepthClip sets near = scene distance / 100, about 1.3 m in the large hall.');
  });
  it('drops Markdown: headings, emphasis, links, inline code and list markers; a list item never joins the paragraph', () => {
    expect(hubShortSummary('## Goal\nThe **ScanCloseUp** view shows the [door tool](docs/door.md) whole.\n\n- check `scene/camera/depthRange.ts`\n- frames')).toBe('The ScanCloseUp view shows the door tool whole.');
    expect(hubShortSummary('Make the console readable on phones and/or tablets\n- one\n- two')).toBe('Make the console readable on phones and/or tablets');
    expect(hubShortSummary('```\nconst x = 1;\n```\nRun the `migrate` step first. Then restart.')).toBe('Run the migrate step first. Then restart.');
  });
  it('removes commit hashes and paths but keeps prose that only looks like them', () => {
    expect(hubShortSummary('Ship it (tree 9ba14692, sha256:6ac2fa1e). The Low/Medium tiers stay as they are.')).toBe('Ship it. The Low/Medium tiers stay as they are.');
    expect(hubShortSummary('The decade of 1234567 records is in C:\\data\\x.csv.')).toBe('The decade of 1234567 records is in.');
    expect(hubShortSummary('See https://example.org/a/b for details, e.g. the table.')).toBe('See for details, e.g. the table.');
  });
  it('adds the second sentence only while both fit, and cuts a long first sentence at a word with an ellipsis', () => {
    const long = `${'word '.repeat(60).trim()}. Second sentence.`;
    const s = hubShortSummary(long)!;
    expect(s.length).toBeLessThanOrEqual(HUB_SUMMARY_MAX);
    expect(s.endsWith('…')).toBe(true);
    expect(s).not.toContain('Second');
    expect(hubShortSummary(`${'a'.repeat(110)}. B${'b'.repeat(110)}.`)).toBe(`${'a'.repeat(110)}.`);
  });
  it('is null without prose', () => {
    for (const d of [null, undefined, '', '   ', '```\ncode only\n```', '- `a/b/c.ts`\n- 4e8fe67e']) expect(hubShortSummary(d)).toBeNull();
  });
  it('stores a coordinator\'s summary as one trimmed line; empty clears it', () => {
    expect(normShortSummary('  Two  lines\nof text. ')).toBe('Two lines of text.');
    expect(normShortSummary('   ')).toBeNull();
    expect(normShortSummary(undefined)).toBeNull();
    expect(normShortSummary('x'.repeat(400))).toHaveLength(SHORT_SUMMARY_MAX);
  });
});

const sys = { kind: 'system' as const, id: null };
type Res = { isError?: boolean; structuredContent?: any; content?: { text: string }[] };
type Call = (name: string, args?: Record<string, unknown>) => Promise<Res>;
type S = { cookie: string; csrf: string };
let app: App, base = '', admin: S, appKey = '';
const text = (r: Res) => (r.content ?? []).map((c) => c.text).join('\n');
const ok = (r: Res) => { if (r.isError) throw new Error(text(r)); return r.structuredContent; };
const call = async (who: S | null, method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', ...(who ? { cookie: who.cookie, 'x-csrf-token': who.csrf } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as any };
};
const api = (method: string, path: string, body?: unknown) => call(admin, method, path, body);
async function session(secret: string): Promise<Call> {
  const c = new Client({ name: 'test', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${appKey}` } } }));
  const token = ((await c.callTool({ name: 'session_login', arguments: { session_key: secret } })) as Res).structuredContent.session_token;
  return async (name, args = {}) => (await c.callTool({ name, arguments: { session_token: token, ...args } })) as Res;
}
let teamId = '', coord: Call, worker: Call;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahshort-'));
  mkdirSync(join(dir, 'vault'));
  app = await buildApp({ dataDir: join(dir, 'data'), dbFile: join(dir, 'data', 't.db'), vaultDir: join(dir, 'vault'), vaultAlias: 'vault', port: 0, host: '127.0.0.1', pepper: 'p',
    publicUrl: 'http://127.0.0.1', production: false, adminUsername: 'admin', adminPassword: 'admin-password-long', publicDir: join(process.cwd(), 'public'), logLevel: 'silent',
    allowedOrigins: [], vaultScanSeconds: 0, vaultWatch: false, maintenanceSeconds: 0 });
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin-password-long' }) });
  admin = { cookie: r.headers.get('set-cookie')!.split(';')[0]!, csrf: ((await r.json()) as { csrf: string }).csrf };
  const pc = (await api('POST', '/pcs', { name: 'pc' })).body.pc.id as string;
  appKey = app.keys.createAppKey({ machineId: pc, appName: 'claude-code', maxLiveSessions: 10 }, sys).secret;
  const agent = (label: string) => {
    const a = app.keys.createAgent(label, null, sys);
    const k = app.keys.createSessionKey({ agentId: a.id, label }, sys);
    app.keys.setRules(k.credential.policy_id, [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:*' }], 'test', sys);
    return { id: a.id, cred: k.credential.id, secret: k.secret };
  };
  const c = agent('short-coord'), w = agent('short-worker');
  teamId = app.teams.create({ name: 'Short', goal: 'g', members: [{ agent_id: c.id, role: 'coordinator', credential_id: c.cred }, { agent_id: w.id, role: 'worker', credential_id: w.cred }] }, sys).id;
  app.teams.start(teamId, sys);
  coord = await session(c.secret);
  worker = await session(w.secret);
});
afterAll(async () => { await app?.close(); });

describe('task_create, task_update and the task view', () => {
  it('stores the coordinator\'s summary; the view then has no hub summary', async () => {
    const t = ok(await coord('task_create', { team_id: teamId, title: 'Near plane', description: BRIEF, short_summary: ' Close views in big halls\nbreak into shards. Fix the near plane. ' })).task;
    expect(t.short_summary).toBe('Close views in big halls break into shards. Fix the near plane.');
    expect(t.short_summary_hub).toBeNull();
    const v = (await api('GET', `/teams/${teamId}/tasks/${t.id}`)).body.task;
    expect([v.short_summary, v.short_summary_hub]).toEqual([t.short_summary, null]);
    const full = ok(await coord('task_list', { task_id: t.id }));
    expect(full.tasks[0].short_summary).toBe(t.short_summary);
  });
  it('without one, the view carries the hub\'s cut of the description', async () => {
    const t = ok(await coord('task_create', { team_id: teamId, title: 'No summary', description: BRIEF })).task;
    expect(t.short_summary).toBeNull();
    expect(t.short_summary_hub).toBe(hubShortSummary(BRIEF));
    const bare = ok(await coord('task_create', { team_id: teamId, title: 'Bare' })).task;
    expect([bare.short_summary, bare.short_summary_hub]).toEqual([null, null]);
  });
  it('task_update sets and clears it ("" clears); other fields stay', async () => {
    let t = ok(await coord('task_create', { team_id: teamId, title: 'Edit me', description: BRIEF })).task;
    t = ok(await coord('task_update', { task_id: t.id, version: t.version, short_summary: 'Short and readable.' })).task;
    expect([t.short_summary, t.short_summary_hub, t.title, t.description]).toEqual(['Short and readable.', null, 'Edit me', BRIEF]);
    t = ok(await coord('task_update', { task_id: t.id, version: t.version, title: 'Renamed' })).task;
    expect(t.short_summary).toBe('Short and readable.');
    t = ok(await coord('task_update', { task_id: t.id, version: t.version, short_summary: '' })).task;
    expect([t.short_summary, t.short_summary_hub]).toEqual([null, hubShortSummary(BRIEF)]);
  });
  it('refuses more than 280 characters, and a worker cannot change it', async () => {
    expect((await coord('task_create', { team_id: teamId, title: 'Too long', short_summary: 'x'.repeat(281) })).isError).toBe(true);
    const t = ok(await coord('task_create', { team_id: teamId, title: 'Mine' })).task;
    expect((await worker('task_update', { task_id: t.id, version: t.version, short_summary: 'Hijacked.' })).isError).toBe(true);
  });
});

describe('the operator (admin API)', () => {
  it('sets and clears it on a task in any status, refuses a stale version, and audits it', async () => {
    const t = ok(await coord('task_create', { team_id: teamId, title: 'Operator edits', description: BRIEF })).task;
    const path = `/teams/${teamId}/tasks/${t.id}/short-summary`;
    expect((await api('PUT', path, { short_summary: 'Stale.', version: t.version + 5 })).status).toBe(409);
    const set = await api('PUT', path, { short_summary: 'Set by the operator.', version: t.version });
    expect(set.status).toBe(200);
    expect([set.body.task.short_summary, set.body.task.short_summary_hub]).toEqual(['Set by the operator.', null]);
    const cleared = await api('PUT', path, { short_summary: null });
    expect([cleared.body.task.short_summary, cleared.body.task.short_summary_hub]).toEqual([null, hubShortSummary(BRIEF)]);
    expect((await api('PUT', path, { short_summary: 'x'.repeat(281) })).status).toBe(400);
    expect((await api('PUT', `/teams/${teamId}/tasks/task_nope/short-summary`, { short_summary: 'x' })).status).toBe(404);
    const audit = app.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='task.short_summary'").get() as { n: number };
    expect(audit.n).toBe(2);
  });
});
