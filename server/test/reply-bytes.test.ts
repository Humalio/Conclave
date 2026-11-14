/**
 * Reply sizes (docs/mcp.md, "Replies and notices"): an idle work_next, a task_list and a review delivery, measured as the
 * whole reply (wire) and as its text blocks (what a client that shows text gives its model). It prints the numbers the
 * reply-once change is judged by, for a plain session and for a compact one.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';
import { intakeOpen } from './intake.js';
import { testConfig, adminLogin } from './hub.js';

const sys = { kind: 'system' as const, id: null };
type Res = { isError?: boolean; structuredContent?: any; content?: { type: string; text: string }[] };
type Call = (name: string, args?: Record<string, unknown>) => Promise<Res>;
let app: App, base = '', cookie = '', csrf = '', appKey = '';
const text = (r: Res) => (r.content ?? []).map((c) => c.text).join('\n');
const ok = (r: Res) => { if (r.isError) throw new Error(text(r)); return r.structuredContent; };
const size = (r: Res) => ({ wire: Buffer.byteLength(JSON.stringify({ content: r.content, structuredContent: r.structuredContent })), text: Buffer.byteLength(text(r)) });
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie, ...(method === 'GET' ? {} : { 'x-csrf-token': csrf }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as any };
};
async function session(secret: string, compact = false): Promise<Call> {
  const c = new Client({ name: 'test', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${appKey}` } } }));
  const token = ((await c.callTool({ name: 'session_login', arguments: { session_key: secret, ...(compact ? { compact: true } : {}) } })) as Res).structuredContent.session_token;
  return async (name, args = {}) => (await c.callTool({ name, arguments: { session_token: token, ...args } })) as Res;
}
const BRIEF = 'Build the thing the operator asked for. '.repeat(40);
const NOTE = 'Your permissions in team Reply Bytes changed: added message.receive, message.send on agent:agent-abc. Call access_list for the full list.';
let n = 0;
async function team() {
  const name = `RB${++n}`;
  const agent = (label: string) => {
    const a = app.keys.createAgent(`${name}-${label}`, null, sys);
    const k = app.keys.createSessionKey({ agentId: a.id, label }, sys);
    app.keys.setRules(k.credential.policy_id, [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:*' }], 'test', sys);
    return { id: a.id, cred: k.credential.id, secret: k.secret };
  };
  const c = agent('coord'), w = agent('worker'), r = agent('rev');
  const id = app.teams.create({ name, goal: 'g', members: [{ agent_id: c.id, role: 'coordinator', credential_id: c.cred }, { agent_id: w.id, role: 'worker', credential_id: w.cred }, { agent_id: r.id, role: 'reviewer', credential_id: r.cred }] }, sys).id;
  app.teams.start(id, sys);
  app.blueprint.ensureTeamProject(id);
  return { id, c, w, r };
}

/** work_next until an item of this kind, confirming the others (team notices come first). */
async function next(call: Call, kind: string): Promise<Res> {
  for (let i = 0; i < 20; i++) { const r = await call('work_next', { wait_seconds: 0 }); const it = ok(r).item; if (!it) throw new Error(`no ${kind}: ${text(r)}`); if (it.kind === kind) return r; ok(await call('work_ack', { item_id: it.item_id })); }
  throw new Error(`no ${kind}`);
}

/** One run of the three measured replies; compact asks for compact replies at login. */
async function measure(compact: boolean) {
  const X = await team();
  const coord = await session(X.c.secret), rev = await session(X.r.secret);
  const w = await session(X.w.secret, compact);
  // Drain what team setup sent, so only the five notices below are pending.
  const drain = ok(await w('session_whoami'));
  const last = Math.max(0, ...(drain.notices ?? []).map((x: { seq: number }) => x.seq));
  if (last) ok(await w('session_ack', { notice_seq: last }));
  for (let i = 0; i < 5; i++) app.keys.notify(X.w.id, 'permissions_changed', NOTE);
  const idle1 = size(await w('work_next', { wait_seconds: 0 })), idle2 = size(await w('work_next', { wait_seconds: 0 }));
  const t = ok(await coord('task_create', { team_id: X.id, title: 'Measured task', description: BRIEF, reviewer: X.r.id, operator_request: { source: 'test' } })).task;
  for (let i = 0; i < 2; i++) ok(await coord('task_create', { team_id: X.id, title: `Other task ${i}`, description: BRIEF, operator_request: { source: 'test' } }));
  ok(await coord('task_assign', { task_id: t.id, agent_id: X.w.id }));
  const assigned = await next(w, 'task_assigned');
  ok(await w('work_ack', { item_id: ok(assigned).item.item_id }));
  ok(await w('task_start', { task_id: t.id }));
  ok(await w('task_submit', { task_id: t.id, summary: 'Done: the thing is built and checked. '.repeat(10) }));
  const ri = ok(await next(rev, 'review_requested')).item;
  ok(await rev('work_ack', { item_id: ri.item_id }));
  ok(await rev('task_review', { task_id: t.id, version: app.teams.task(t.id)!.version, decision: 'request_changes', comments: 'Please fix the edge case in the second step. '.repeat(6) }));
  const review = await next(w, 'changes_requested');
  expect(ok(review).item.kind).toBe('changes_requested');
  const list = size(await w('task_list')), listFull = size(await w('task_list', { detail: 'full' }));
  return { idle_first: idle1, idle_again: idle2, task_assigned: size(assigned), review_delivery: size(review), task_list: list, task_list_full: listFull };
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahrb-'));
  mkdirSync(join(dir, 'vault'));
  app = await buildApp(testConfig(dir, { pepper: 'p', publicUrl: 'http://127.0.0.1', adminPassword: 'admin-password-long' }));
  intakeOpen(app);
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  ({ cookie, csrf } = await adminLogin(base, 'admin', 'admin-password-long'));
  const pc = (await api('POST', '/pcs', { name: 'pc' })).body.pc.id as string;
  appKey = app.keys.createAppKey({ machineId: pc, appName: 'claude-code', maxLiveSessions: 40 }, sys).secret;
});
afterAll(async () => { await app?.close(); });

describe('reply sizes', () => {
  it('measures a plain and a compact session', async () => {
    const plain = await measure(false), compact = await measure(true);
    if (process.env.REPLY_BYTES_OUT) writeFileSync(process.env.REPLY_BYTES_OUT, JSON.stringify({ plain, compact }, null, 1));
    expect(plain.idle_first.wire).toBeGreaterThan(0);
  });
});
