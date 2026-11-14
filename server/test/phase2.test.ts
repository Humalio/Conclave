import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';
import type { Config } from '../src/config.js';
import { testConfig, adminLogin } from './hub.js';

const sys = { kind: 'system' as const, id: null };
let app: App, base: string, cookie = '', csrf = '';

const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
async function connect(key: string) {
  const c = new Client({ name: 't', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
  const call = async (name: string, args: Record<string, unknown> = {}) => (await c.callTool({ name, arguments: args })) as { isError?: boolean; structuredContent?: any; content: { text: string }[] };
  return { c, call };
}
const bridgePost = (path: string, body: unknown, key?: string) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(body) });

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah2-'));
  const vaultDir = join(dir, 'vault');
  mkdirSync(join(vaultDir, 'Public'), { recursive: true });
  writeFileSync(join(vaultDir, 'Public', 'a.md'), 'hello');
  const config: Config = testConfig(dir, { vaultDir, vaultScanSeconds: undefined, vaultWatch: undefined, maintenanceSeconds: undefined });
  app = await buildApp(config);
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  ({ cookie, csrf } = await adminLogin(base));
});
afterAll(async () => { await app.close(); });

describe('PC setup and bridge', () => {
  let pcId: string, appKey: string, setupKey: string, pairing: string, bridgeKey: string;
  it('setup flow end to end: setup key, setup_pc parts, pairing, heartbeat, folders, suspend', async () => {
    pcId = (await api('POST', '/pcs', { name: 'laptop' })).body.pc.id;
    appKey = app.keys.createAppKey({ machineId: pcId, appName: 'claude-code' }, sys).secret;
    const s = await api('POST', `/pcs/${pcId}/setup`);
    expect(s.status).toBe(200);
    setupKey = s.body.setup_key;
    expect(setupKey).toMatch(/^ah_set_/);
    expect(s.body.setup_message).toContain('setup_pc');
    expect(s.body.setup_message).toContain(setupKey);
    expect((await api('GET', '/pcs')).body.pcs[0].setup_status).toBe('waiting_install');

    const { c, call } = await connect(appKey);
    const tools = (await c.listTools()).tools.map((t) => t.name);
    expect(tools).toEqual(expect.arrayContaining(['setup_pc', 'setup_status']));
    // a bad key and a key of another PC fail
    expect((await call('setup_pc', { setup_key: 'ah_set_aaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', os: 'windows' })).structuredContent.error).toBe('setup_key_invalid');
    const otherPc = app.keys.createMachine('other', null, sys);
    const otherKey = app.keys.createAppKey({ machineId: otherPc.id, appName: 'x' }, sys).secret;
    expect((await (await connect(otherKey)).call('setup_pc', { setup_key: setupKey, os: 'linux' })).structuredContent.error).toBe('setup_key_invalid');
    // setup key is not accepted for other tools
    expect((await call('file_list', { path: '/vault', session_token: setupKey })).isError).toBe(true);

    const first = await call('setup_pc', { setup_key: setupKey, os: 'windows', proposed_folders: ['C:\\Users\\b\\Notes', 'C:\\Users\\b\\Docs'] });
    expect(first.isError).toBeFalsy();
    const d = first.structuredContent;
    const text = readFileSync(join(process.cwd(), '..', 'bridge', 'agent-hub-bridge.mjs'), 'utf8').replace(/\r\n/g, '\n');
    const parts: string[] = [];
    for (let i = 0; i < d.parts; i++) {
      const r = i === 0 ? first : await call('setup_pc', { setup_key: setupKey, os: 'windows', part: i });
      expect(r.content[0]!.text.length).toBeLessThan(90_000);
      const m = /-----BEGIN BRIDGE PART-----\n([\s\S]*)\n-----END BRIDGE PART-----/.exec(r.content[0]!.text)!;
      expect(m[1]!.length).toBeLessThanOrEqual(60_000);
      parts.push(m[1]!);
    }
    expect(createHash('sha256').update(parts.join('')).digest('hex')).toBe(d.sha256_whole);
    expect(parts.join('')).toBe(text);
    expect(d.steps.map((x: any) => x.title).join('|')).toContain('Task Scheduler');
    pairing = d.pairing_code;
    expect(pairing).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/);
    for (const os of ['macos', 'linux']) {
      const r = await call('setup_pc', { setup_key: setupKey, os, part: 1 > d.parts - 1 ? 0 : 1 });
      expect(r.content[0]!.text).toContain(os === 'macos' ? 'launchd' : 'systemd');
      pairing = r.structuredContent.pairing_code ?? pairing;
    }
    expect((await call('setup_status', { setup_key: setupKey })).structuredContent.status).toBe('waiting_pairing');

    // pairing: wrong code 401, right code once
    expect((await bridgePost('/bridge/pair', { pairing_code: 'AAAA-AAAA-AAAA' })).status).toBe(401);
    const p = await bridgePost('/bridge/pair', { pairing_code: pairing, os: 'win32', version: '0.2.0' });
    expect(p.status).toBe(200);
    bridgeKey = ((await p.json()) as { bridge_key: string }).bridge_key;
    expect(bridgeKey).toMatch(/^ah_brg_/);
    expect((await bridgePost('/bridge/pair', { pairing_code: pairing })).status).toBe(401);
    expect(JSON.stringify(app.db.prepare('SELECT * FROM bridge_keys').all())).not.toContain(bridgeKey.split('_')[3]!);
    expect((await call('setup_status', { setup_key: setupKey })).structuredContent.status).toBe('waiting_folder_approval');

    // heartbeat
    app.db.prepare('UPDATE machines SET bridge_last_seen_at=1 WHERE id=?').run(pcId);
    const poll = await bridgePost('/bridge/poll', { wait_s: 0, version: '0.2.1' }, bridgeKey);
    expect(poll.status).toBe(200);
    const pb = (await poll.json()) as any;
    expect(pb.jobs).toEqual([]);
    expect(pb.allowed_folders).toEqual([]);
    const pc = (await api('GET', '/pcs')).body.pcs.find((x: any) => x.id === pcId);
    expect(pc.bridge.last_seen_at).toBeGreaterThan(Date.now() - 5000);
    expect(pc.bridge.online).toBe(true);
    expect(pc.bridge.version).toBe('0.2.1');
    expect(pc.folders.map((f: any) => f.status)).toEqual(['proposed', 'proposed']);

    // folder approve / reject (encoded path in the URL)
    const approve = await api('POST', `/pcs/${pcId}/folders/${encodeURIComponent('C:\\Users\\b\\Notes')}/approve`);
    expect(approve.status).toBe(200);
    expect((await api('POST', `/pcs/${pcId}/folders/${encodeURIComponent('C:\\Users\\b\\Docs')}/reject`)).status).toBe(200);
    expect((await api('POST', `/pcs/${pcId}/folders/${encodeURIComponent('C:\\nope')}/approve`)).status).toBe(404);
    const pb2 = (await (await bridgePost('/bridge/poll', { wait_s: 0 }, bridgeKey)).json()) as any;
    expect(pb2.allowed_folders).toEqual(['C:\\Users\\b\\Notes']);
    const done = await call('setup_status', { setup_key: setupKey });
    expect(done.structuredContent.status).toBe('done');
    expect((await call('setup_status', { setup_key: setupKey })).structuredContent.error).toBe('setup_key_invalid');

    // missing / bad bridge key and suspended PC
    expect((await bridgePost('/bridge/poll', { wait_s: 0 })).status).toBe(401);
    expect((await bridgePost('/bridge/poll', { wait_s: 0 }, 'ah_brg_aaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')).status).toBe(401);
    expect((await api('POST', `/pcs/${pcId}/suspend`)).status).toBe(200);
    expect((await bridgePost('/bridge/poll', { wait_s: 0 }, bridgeKey)).status).toBe(401);
    expect((await api('POST', `/pcs/${pcId}/reactivate`)).status).toBe(200);
    expect((await bridgePost('/bridge/poll', { wait_s: 0 }, bridgeKey)).status).toBe(200);
  });

  it('a setup key expires after one hour and a new one replaces the old', async () => {
    const pc = (await api('POST', '/pcs', { name: 'desk' })).body.pc.id;
    const key = app.keys.createAppKey({ machineId: pc, appName: 'codex' }, sys).secret;
    const k1 = (await api('POST', `/pcs/${pc}/setup`)).body.setup_key as string;
    const { call } = await connect(key);
    app.db.prepare('UPDATE setup_keys SET expires_at=? WHERE machine_id=?').run(Date.now() - 1, pc);
    expect((await call('setup_pc', { setup_key: k1, os: 'linux' })).structuredContent.error).toBe('setup_key_invalid');
    const k2 = (await api('POST', `/pcs/${pc}/setup`)).body.setup_key as string;
    expect((await call('setup_status', { setup_key: k2 })).structuredContent.status).toBe('waiting_install');
    const k3 = (await api('POST', `/pcs/${pc}/setup`)).body.setup_key as string;
    expect((await call('setup_status', { setup_key: k2 })).structuredContent.error).toBe('setup_key_invalid');
    expect((await call('setup_status', { setup_key: k3 })).isError).toBeFalsy();
  });

  it('long poll returns within its wait and shutdown does not hang', async () => {
    const t0 = Date.now();
    const r = await bridgePost('/bridge/poll', { wait_s: 1 }, bridgeKey);
    expect(r.status).toBe(200);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
  });
});

describe('links, whoami, sessions, topology, metrics, archive', () => {
  let appKey: string, appId: string, pcId: string;
  const mk = (label: string) => {
    const a = app.keys.createAgent(label, null, sys);
    const k = app.keys.createSessionKey({ agentId: a.id, label }, sys);
    app.keys.setRules(k.credential.policy_id, [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:file_*' }, { effect: 'allow', actions: ['fs.list', 'fs.read'], resource: 'path:/vault/Public/**' }], 'test', sys);
    return { agent: a, ...k };
  };
  let A: ReturnType<typeof mk>, B: ReturnType<typeof mk>, tokA = '', linkId = '';
  it('links CRUD and whoami shows links, PC and app; role change leaves a notice', async () => {
    pcId = (await api('POST', '/pcs', { name: 'work' })).body.pc.id;
    const k = app.keys.createAppKey({ machineId: pcId, appName: 'claude-code' }, sys);
    appKey = k.secret; appId = k.credential.id;
    A = mk('writer'); B = mk('reviewer');
    const { call } = await connect(appKey);
    tokA = (await call('session_login', { session_key: A.secret })).structuredContent.session_token;

    const bad = await api('POST', '/links', { from_agent_id: A.agent.id, to_agent_id: A.agent.id, kind: 'works_with' });
    expect(bad.status).toBe(400);
    const l = await api('POST', '/links', { from_agent_id: A.agent.id, to_agent_id: B.agent.id, kind: 'reviews', note: 'B reviews A', grants_messaging: true });
    expect(l.status).toBe(200);
    linkId = l.body.link.id;
    expect(l.body.link.grants_messaging).toBe(true);
    expect((await api('POST', '/links', { from_agent_id: A.agent.id, to_agent_id: B.agent.id, kind: 'reviews' })).status).toBe(409);
    expect((await api('POST', '/links', { from_agent_id: B.agent.id, to_agent_id: A.agent.id, kind: 'buddy system' })).status).toBe(200);
    expect((await api('GET', `/links?agent=${A.agent.id}`)).body.links).toHaveLength(2);

    const who = await call('session_whoami', { session_token: tokA });
    expect(who.structuredContent.pc).toBe('work');
    expect(who.structuredContent.app).toBe('claude-code');
    expect(who.structuredContent.links.map((x: any) => `${x.direction}:${x.kind}:${x.label}`).sort()).toEqual(['incoming:buddy system:reviewer', 'outgoing:reviews:reviewer']);
    expect(who.content[0]!.text).toContain('Links:');
    expect((await api('PATCH', `/links/${linkId}`, { kind: 'works_with', grants_messaging: false })).body.link.kind).toBe('works_with');

    await api('PATCH', `/agents/${A.agent.id}`, { role: 'Lead writer' });
    const n = (await call('session_whoami', { session_token: tokA })).structuredContent.notices as { kind: string; body: string }[];
    expect(n.map((x) => x.kind)).toEqual(expect.arrayContaining(['link_added', 'role_changed']));

    expect((await api('DELETE', `/links/${linkId}`)).status).toBe(200);
    expect((await api('GET', '/links')).body.links.some((x: any) => x.id === linkId)).toBe(false);
    expect((await api('DELETE', `/links/${linkId}`)).status).toBe(404);
  });

  it('sessions, inspector, topology and metrics have the documented shape', async () => {
    const { call } = await connect(appKey);
    const tokB = (await call('session_login', { session_key: B.secret })).structuredContent.session_token;
    await call('file_read', { session_token: tokA, path: '/vault/Public/a.md' });
    await call('file_read', { session_token: tokA, path: '/vault/Private/x.md' });
    await call('session_login', { session_key: A.secret }); // a second live login of the same key

    const s = (await api('GET', '/sessions')).body.sessions as any[];
    const sa = s.find((x) => x.agent.id === A.agent.id)!;
    expect(sa.live).toBe(true);
    expect(sa.logins[0]).toMatchObject({ app: 'claude-code', pc: { id: pcId, name: 'work' }, app_key_id: appId });
    expect(sa.concurrent_use).toBe(true);
    expect(sa.last_tool_call.tool).toBe('file_read');
    expect(sa.recent_files.length).toBeGreaterThan(0);
    expect(s.find((x) => x.agent.id === B.agent.id)!.concurrent_use).toBe(false);
    expect(s.every((x) => x.live)).toBe(true);

    // The PCs list names the agents that called through the PC's app keys (newest first) and when the PC was last seen.
    const pc = ((await api('GET', '/pcs')).body.pcs as any[]).find((x) => x.id === pcId)!;
    expect(pc.agents.map((x: any) => x.id)).toContain(A.agent.id);
    expect(pc.agents.find((x: any) => x.id === A.agent.id)).toMatchObject({ label: 'writer', last_at: expect.any(Number) });
    expect(pc.agents.map((x: any) => x.last_at)).toEqual([...pc.agents.map((x: any) => x.last_at)].sort((a: number, b: number) => b - a));
    expect(pc.last_seen_at).toEqual(expect.any(Number));
    const other = ((await api('GET', '/pcs')).body.pcs as any[]).find((x) => x.id !== pcId && x.app_keys === 0);
    if (other) expect(other.agents).toEqual([]);

    const insp = (await api('GET', `/sessions/${A.agent.id}`)).body;
    expect(insp.session_keys).toHaveLength(1);
    expect(JSON.stringify(insp)).not.toContain(A.secret.split('_')[3]!);
    expect(insp.invocations.length).toBeGreaterThan(0);
    expect(insp.accesses.length).toBeGreaterThan(0);
    expect((await api('GET', '/sessions/agent-nope')).status).toBe(404);

    // The administrator sends a directive and a message: both reach the agent as notices; acknowledging is visible.
    expect((await api('POST', `/agents/${A.agent.id}/notices`, { kind: 'directive', body: '' })).status).toBe(400);
    expect((await api('POST', `/agents/${A.agent.id}/notices`, { kind: 'order', body: 'x' })).status).toBe(400);
    const dir = (await api('POST', `/agents/${A.agent.id}/notices`, { kind: 'directive', body: 'Cite the source file for every claim.' })).body.notice;
    expect(dir).toMatchObject({ kind: 'directive' });
    await api('POST', `/agents/${A.agent.id}/notices`, { kind: 'message', body: 'Ping me when the draft is ready.' });
    const got = (await call('session_whoami', { session_token: tokA })).structuredContent.notices as { seq: number; kind: string; body: string }[];
    expect(got.filter((x) => ['directive', 'message'].includes(x.kind)).map((x) => x.body)).toEqual(['Cite the source file for every claim.', 'Ping me when the draft is ready.']);
    await call('session_ack', { session_token: tokA, notice_seq: dir.seq });
    const insp2 = (await api('GET', `/sessions/${A.agent.id}`)).body;
    expect(insp2.notices_acked_seq).toBe(dir.seq);
    expect(insp2.notices[0].kind).toBe('message');
    expect(insp2).toHaveProperty('playbooks');
    // The agent page's Inbox (SPEC-AGENT-01): each notice says whether it is still current. Opening the page, however
    // often, confirms nothing: the pending message stays pending and still reaches the agent.
    expect(insp2.notices[0]).toMatchObject({ kind: 'message', body: 'Ping me when the draft is ready.', current: 1, created_at: expect.any(Number) });
    // Who sent it: the send's audit entry records the notice's seq, so the Inbox names the admin who sent it (You when
    // that is the viewer). A notice sent by another admin names them; one with no recorded sender has sent_by null (Operator).
    expect(insp2.viewer_id).toEqual(expect.stringMatching(/^adm_/));
    expect(insp2.notices[0].sent_by).toMatchObject({ id: insp2.viewer_id, name: expect.any(String) });
    expect(insp2.notices.find((x: any) => x.seq === dir.seq).sent_by.id).toBe(insp2.viewer_id);
    app.db.prepare("INSERT INTO admin_users(id,username,password_hash,created_at) VALUES ('adm_other','alice','x',?)").run(Date.now());
    app.keys.notify(A.agent.id, 'message', 'From Alice.');
    const aliceSeq = (app.db.prepare('SELECT MAX(seq) s FROM agent_notices WHERE agent_id=?').get(A.agent.id) as { s: number }).s;
    app.db.prepare("INSERT INTO audit_events(actor_kind,actor_id,actor_role,action,target_kind,target_id,details,created_at) VALUES ('admin','adm_other','admin','agent.notice','agent',?,?,?)")
      .run(A.agent.id, JSON.stringify({ kind: 'message', seq: aliceSeq }), Date.now());
    app.keys.notify(A.agent.id, 'message', 'Sent before senders were recorded.');
    const named = (await api('GET', `/sessions/${A.agent.id}`)).body.notices as any[];
    expect(named.find((x) => x.body === 'From Alice.').sent_by).toEqual({ id: 'adm_other', name: 'alice' });
    expect(named.find((x) => x.body === 'Sent before senders were recorded.').sent_by).toBeNull();
    // Hub notices carry no sender.
    expect(named.filter((x) => !['directive', 'message'].includes(x.kind)).every((x) => x.sent_by === null)).toBe(true);
    for (let i = 0; i < 3; i++) expect((await api('GET', `/sessions/${A.agent.id}`)).body.notices_acked_seq).toBe(dir.seq);
    const still = (await call('session_whoami', { session_token: tokA })).structuredContent.notices as { body: string }[];
    expect(still.map((x) => x.body)).toContain('Ping me when the draft is ready.');
    // A notice the hub settled before delivery (its task is gone) is listed as not current, so the Inbox does not call it Pending.
    app.keys.notify(A.agent.id, 'review_requested', 'Review the draft.', { kind: 'task', id: 'task_gone', state: 'in_review' });
    const settled = (await api('GET', `/sessions/${A.agent.id}`)).body.notices[0];
    expect(settled).toMatchObject({ kind: 'review_requested', current: 0 });
    expect(settled.seq).toBeGreaterThan(dir.seq);
    expect(app.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='agent.notice' AND target_id=?").get(A.agent.id)).toMatchObject({ n: 3 });
    expect(app.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='agent.notice' AND target_id=? AND json_extract(details,'$.seq')=?").get(A.agent.id, dir.seq)).toMatchObject({ n: 1 });

    const topo = (await api('GET', '/topology')).body;
    const pcT = topo.pcs.find((x: any) => x.id === pcId);
    expect(pcT.app_keys[0].app).toBe('claude-code');
    expect(pcT.app_keys[0].sessions.map((x: any) => x.agent_id).sort()).toEqual([A.agent.id, A.agent.id, B.agent.id].sort());
    expect(pcT.bridge).toHaveProperty('online');

    const m = (await api('GET', '/metrics')).body;
    expect(m.counts.live_logins).toBeGreaterThanOrEqual(3);
    expect(m.counts.denials_24h).toBeGreaterThanOrEqual(1);
    for (const k of ['logins', 'tool_calls', 'denials', 'vault_reads']) {
      expect(m.series[k]).toHaveLength(24);
      expect(m.series[k][23].hour).toBeGreaterThan(m.series[k][0].hour);
    }
    expect(m.series.vault_reads.reduce((a: number, x: any) => a + x.count, 0)).toBeGreaterThanOrEqual(1);
    expect(m.series.logins.reduce((a: number, x: any) => a + x.count, 0)).toBeGreaterThanOrEqual(3);
    void tokB;
  });

  it('archive ends tokens, revokes keys, keeps history', async () => {
    const { call } = await connect(appKey);
    const r = await api('POST', `/sessions/${A.agent.id}/archive`);
    expect(r.status).toBe(200);
    expect(r.body.logins_ended).toBe(2);
    expect((await call('file_list', { session_token: tokA, path: '/vault' })).structuredContent.error).toBe('key_inactive');
    expect((await call('session_login', { session_key: A.secret })).structuredContent.error).toBe('key_inactive');
    expect((await api('GET', '/sessions')).body.sessions.some((x: any) => x.agent.id === A.agent.id)).toBe(false);
    expect((await api('GET', `/sessions/${A.agent.id}`)).body.invocations.length).toBeGreaterThan(0);
    expect(app.keys.agent(A.agent.id)!.status).toBe('archived');
    expect((await api('POST', `/sessions/${A.agent.id}/archive`)).status).toBe(409);
  });
});
