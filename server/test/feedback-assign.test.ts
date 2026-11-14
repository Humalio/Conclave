/** Assigning a feedback report to an agent (docs/feedback.md#assigning-a-report). */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';
import type { Config } from '../src/config.js';
import { testConfig, adminLogin } from './hub.js';

const sys = { kind: 'system' as const, id: null };
let app: App, base = '', cookie = '', csrf = '', appKey = '';
let n = 0;
const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = { cookie, 'x-csrf-token': csrf }) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
type Res = { isError?: boolean; structuredContent?: any; content: { text: string }[] };
async function agent(label: string) {
  const a = app.keys.createAgent(`${label}-${++n}`, null, sys);
  const k = app.keys.createSessionKey({ agentId: a.id, label }, sys);
  app.keys.setRules(k.credential.policy_id, [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:*' }], 'test', sys);
  const c = new Client({ name: 'test', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${appKey}` } } }));
  const raw = async (name: string, args: Record<string, unknown> = {}) => (await c.callTool({ name, arguments: args })) as Res;
  const token = (await raw('session_login', { session_key: k.secret })).structuredContent.session_token as string;
  const S = (name: string, args: Record<string, unknown> = {}) => raw(name, { session_token: token, ...args });
  return { id: a.id, S };
}
type Agent = Awaited<ReturnType<typeof agent>>;
const notices = async (x: Agent, kind: string) => ((await x.S('session_whoami')).structuredContent?.notices ?? []).filter((m: any) => m.kind === kind) as { seq: number; body: string }[];
const ack = async (x: Agent) => { const all = (await x.S('session_whoami')).structuredContent?.notices ?? []; if (all.length) await x.S('session_ack', { notice_seq: Math.max(...all.map((m: any) => m.seq)) }); };

let filer: Agent, coord: Agent, other: Agent, reportId = '';
beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahfba-'));
  mkdirSync(join(dir, 'vault'));
  const config: Config = testConfig(dir);
  app = await buildApp(config);
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  ({ cookie, csrf } = await adminLogin(base));
  const pc = (await api('POST', '/pcs', { name: 'pc' })).body.pc.id;
  appKey = app.keys.createAppKey({ machineId: pc, appName: 'claude-code', maxLiveSessions: 50 }, sys).secret;
  [filer, coord, other] = [await agent('filer'), await agent('coordinator'), await agent('other')];
  const f = await filer.S('feedback_file', { kind: 'bug', tool: 'file_patch', error_code: 'patch_failed', title: 'file_patch fails on a table row', severity: 'costly',
    tried: 'PRIVATE-CANARY: patched a table row in my private notes', happened: 'patch_failed' });
  reportId = f.structuredContent.report_id;
  await api('POST', `/feedback/${reportId}/status`, { status: 'accepted', note: 'Reproduced.', guidance: 'Patch one line at a time.' });
  for (const a of [filer, coord, other]) await ack(a);
});
afterAll(async () => { await app?.close(); });

describe('assigning a report', () => {
  it('needs the operator and the CSRF token', async () => {
    expect((await api('POST', `/feedback/${reportId}/assign`, { agent_id: coord.id }, {})).status).toBe(401);
    expect((await api('POST', `/feedback/${reportId}/assign`, { agent_id: coord.id }, { cookie })).status).toBe(403);
    expect((await api('POST', `/feedback/${reportId}/assign`, { agent_id: 'agent-nope' })).status).toBe(400);
    expect((await api('POST', `/feedback/${reportId}/assign`, { agent_id: coord.id, extra: 1 })).status).toBe(400);
    expect(app.db.prepare('SELECT assigned_agent_id a FROM feedback_reports WHERE id=?').get(reportId)).toEqual({ a: null });
  });

  it('assigns: the agent gets one feedback_assigned notice with the note, the decision and the guidance; it is audited', async () => {
    const r = await api('POST', `/feedback/${reportId}/assign`, { agent_id: coord.id, note: 'Please look at this before Friday.' });
    expect(r.status).toBe(200);
    expect(r.body.assignee).toMatchObject({ agent_id: coord.id, note: 'Please look at this before Friday.' });
    const got = await notices(coord, 'feedback_assigned');
    expect(got).toHaveLength(1);
    expect(got[0]!.body).toContain(reportId);
    expect(got[0]!.body).toContain('Operator note on the assignment (L0): Please look at this before Friday.');
    expect(got[0]!.body).toContain('Operator guidance (L0): Patch one line at a time.');
    expect(got[0]!.body).toContain('Operator decision note (L0): Reproduced.');
    expect(got[0]!.body).toContain('L2 data');
    expect(await notices(other, 'feedback_assigned')).toHaveLength(0);
    const ev = app.db.prepare("SELECT details FROM audit_events WHERE action='feedback.assign' AND target_id=?").all(reportId) as { details: string }[];
    expect(ev.map((e) => JSON.parse(e.details))).toEqual([{ from: null, to: coord.id }]);
    // The same assignment again is a no-op: no second notice.
    await api('POST', `/feedback/${reportId}/assign`, { agent_id: coord.id, note: 'Please look at this before Friday.' });
    expect(await notices(coord, 'feedback_assigned')).toHaveLength(1);
  });

  it('acknowledging the notice, even in bulk, does not count as read', async () => {
    await ack(coord);
    expect((await api('GET', `/feedback/${reportId}`)).body.assignee).toMatchObject({ agent_id: coord.id, read_at: null, on_demand: false });
    expect((await api('GET', `/feedback?assignee=${coord.id}`)).body.reports[0].assignee.read_at).toBeNull();
    const who = await coord.S('session_whoami');
    expect(who.structuredContent.unread_assigned_feedback).toBe(1);
    expect(who.content[0]!.text).toContain('Unread assigned feedback: 1');
  });

  it('the assignee finds it with assigned "me" and reads "assigned to you", but never the filer\'s private account', async () => {
    const f = await coord.S('feedback_find', { assigned: 'me' });
    expect(f.structuredContent.reports.map((x: any) => x.id)).toEqual([reportId]);
    expect(f.content[0]!.text).toContain('Assigned to you by the operator (not read yet: feedback_read it)');
    expect(f.structuredContent.reports[0].assignment.read).toBe(false);
    // Somebody else reading it does not mark it read.
    await other.S('feedback_read', { report_id: reportId });
    expect((await api('GET', `/feedback/${reportId}`)).body.assignee.read_at).toBeNull();
    const before = Date.now();
    expect((await other.S('feedback_find', { assigned: 'me' })).structuredContent.reports).toEqual([]);
    const rd = await coord.S('feedback_read', { report_id: reportId });
    expect(rd.structuredContent.report).toMatchObject({ assigned_to_you: true, assignment: { trust: 'L0', note: 'Please look at this before Friday.' }, decision: { guidance: 'Patch one line at a time.' } });
    expect(rd.structuredContent.detail).toBeNull();
    expect(JSON.stringify(rd)).not.toContain('PRIVATE-CANARY');
    const o = await other.S('feedback_read', { report_id: reportId });
    expect(o.structuredContent.report.assigned_to_you).toBeUndefined();
    // Reading it as the assignee is what counts: the console shows when, and whoami stops counting it.
    const at = (await api('GET', `/feedback/${reportId}`)).body.assignee.read_at;
    expect(at).toBeGreaterThanOrEqual(before);
    expect((await api('GET', `/feedback?assignee=${coord.id}`)).body.reports[0].assignee.read_at).toBe(at);
    expect((await coord.S('session_whoami')).structuredContent.unread_assigned_feedback).toBe(0);
    expect((await coord.S('feedback_find', { assigned: 'me' })).content[0]!.text).not.toContain('not read yet');
    // A second read keeps the first time.
    await coord.S('feedback_read', { report_id: reportId });
    expect((await api('GET', `/feedback/${reportId}`)).body.assignee.read_at).toBe(at);
  });

  it('a new assignment starts unread again; an agent in an on-demand team is flagged for the wake hint', async () => {
    const t = app.teams.create({ name: 'Wake Me', goal: 'g', members: [{ agent_id: other.id, role: 'coordinator' }] }, sys);
    app.db.prepare("UPDATE teams SET delivery_mode='on_demand' WHERE id=?").run(t.id);
    await api('POST', `/feedback/${reportId}/assign`, { agent_id: other.id });
    expect((await api('GET', `/feedback/${reportId}`)).body.assignee).toMatchObject({ agent_id: other.id, read_at: null, on_demand: true });
    await api('POST', `/feedback/${reportId}/assign`, { agent_id: coord.id });
    expect((await api('GET', `/feedback/${reportId}`)).body.assignee).toMatchObject({ agent_id: coord.id, read_at: null, on_demand: false });
    await ack(coord); await ack(other);
  });

  it('a hidden report stays readable for its assignee, and for nobody else', async () => {
    await api('PATCH', `/feedback/${reportId}`, { hidden: true });
    expect((await coord.S('feedback_read', { report_id: reportId })).isError).toBeFalsy();
    expect((await coord.S('feedback_find', { assigned: 'me' })).structuredContent.reports).toHaveLength(1);
    expect((await other.S('feedback_read', { report_id: reportId })).structuredContent.error).toBe('denied');
    await api('PATCH', `/feedback/${reportId}`, { hidden: false });
  });

  it('reassigning tells the previous agent once; unassigning tells the last one', async () => {
    await ack(coord);
    await api('POST', `/feedback/${reportId}/assign`, { agent_id: other.id });
    expect(await notices(other, 'feedback_assigned')).toHaveLength(1);
    const gone = await notices(coord, 'feedback_unassigned');
    expect(gone).toHaveLength(1);
    expect(gone[0]!.body).toContain('no longer assigned to you: the operator reassigned it');
    expect(gone[0]!.body).not.toContain('other-'); // never who has it now: that agent may be in another project
    expect((await coord.S('feedback_find', { assigned: 'me' })).structuredContent.reports).toEqual([]);
    await ack(other);
    const un = await api('POST', `/feedback/${reportId}/assign`, { agent_id: null });
    expect(un.body.assignee).toBeNull();
    expect(await notices(other, 'feedback_unassigned')).toHaveLength(1);
    expect(await notices(coord, 'feedback_unassigned')).toHaveLength(1); // nothing new for the earlier assignee
    const hist = (await api('GET', `/feedback/${reportId}`)).body.history.filter((h: any) => h.field === 'assignee').map((h: any) => [h.old_value, h.new_value]);
    expect(hist).toEqual([[null, coord.id], [coord.id, other.id], [other.id, coord.id], [coord.id, other.id], [other.id, null]]);
  });

  it('the operator still marks it fixed; the assignee can add what it did as evidence', async () => {
    await api('POST', `/feedback/${reportId}/assign`, { agent_id: coord.id });
    const backers = (await api('GET', `/feedback/${reportId}`)).body.report.backers;
    const add = await coord.S('feedback_add', { report_id: reportId, kind: 'evidence', text: 'Split the patch per line in the helper.' });
    expect(add.isError).toBeFalsy();
    const d = (await api('GET', `/feedback/${reportId}`)).body;
    expect(d.report.backers).toBe(backers); // the assignee's account of its work is not a +1
    expect(d.backers.map((b: any) => b.agent_id)).not.toContain(coord.id);
    const fixed = await api('POST', `/feedback/${reportId}/status`, { status: 'fixed', note: 'Patches now work per line.', fixed_in: '0.2.0' });
    expect(fixed.body.report.status).toBe('fixed');
    expect(fixed.body.assignee.agent_id).toBe(coord.id);
  });

  it('the list filters by assignee and shows it', async () => {
    const l = (await api('GET', `/feedback?assignee=${coord.id}`)).body.reports;
    expect(l.map((x: any) => x.id)).toEqual([reportId]);
    expect(l[0].assignee).toMatchObject({ agent_id: coord.id });
    expect((await api('GET', `/feedback?assignee=${other.id}`)).body.reports).toEqual([]);
  });

  it('feedback off refuses the filter; a lockdown does not', async () => {
    await api('PUT', '/feedback/settings', { enabled: false });
    expect((await coord.S('feedback_find', { assigned: 'me' })).structuredContent.error).toBe('denied');
    await api('PUT', '/feedback/settings', { enabled: true });
    await api('POST', '/lockdown', { scope: 'writes', on: true });
    expect((await coord.S('feedback_find', { assigned: 'me' })).structuredContent.reports).toHaveLength(1);
    expect((await coord.S('feedback_add', { report_id: reportId, kind: 'evidence', text: 'more' })).structuredContent.error).toBe('lockdown');
    await api('POST', '/lockdown', { scope: 'writes', on: false });
  });

  it('on merge the assignment moves to the surviving report, or the assignee is told', async () => {
    const mkr = async (title: string) => (await filer.S('feedback_file', { kind: 'limitation', title, area: 'limits', tried: 'x', severity: 'minor' })).structuredContent.report_id as string;
    const a = await mkr('uniform victor whiskey one limit'), b = await mkr('xray yankee zulu two limit'), c2 = await mkr('kilo lima mike three limit');
    await api('POST', `/feedback/${a}/assign`, { agent_id: other.id, note: 'Look at this one.' });
    await ack(other);
    await api('POST', `/feedback/${a}/merge`, { target_id: b });
    expect((await api('GET', `/feedback/${b}`)).body.assignee).toMatchObject({ agent_id: other.id, note: 'Look at this one.' });
    expect((await api('GET', `/feedback/${a}`)).body.assignee).toBeNull();
    const moved = await notices(other, 'feedback_assigned');
    expect(moved.at(-1)!.body).toContain(`merged into ${b}`);
    expect((await other.S('feedback_find', { assigned: 'me' })).structuredContent.reports.map((r: any) => r.id)).toContain(b);
    // The target already has someone: the duplicate's assignee is told it lost the report, without the other name.
    await api('POST', `/feedback/${c2}/assign`, { agent_id: filer.id });
    await api('POST', `/feedback/${b}/merge`, { target_id: c2 });
    const lost = (await notices(other, 'feedback_unassigned')).at(-1)!;
    expect(lost.body).toContain(b);
    expect(lost.body).toContain('merged it into another report');
    expect(lost.body).not.toContain('filer-');
    expect((await api('GET', `/feedback/${c2}`)).body.assignee.agent_id).toBe(filer.id);
  });

  it('a duplicate or withdrawn report cannot be assigned', async () => {
    const f = await filer.S('feedback_file', { kind: 'wish', title: 'a wish nobody else has about yankee zulu', area: 'other', tried: 'x', severity: 'minor' });
    const id = f.structuredContent.report_id;
    await filer.S('feedback_add', { report_id: id, kind: 'withdraw' });
    const r = await api('POST', `/feedback/${id}/assign`, { agent_id: coord.id });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('invalid_state');
  });
});

describe('the console states (docs/dashboard-ux.md, Feedback)', () => {
  it('the list and detail say "not read yet" or "read <time>", and the on-demand hint has a copyable wake line', async () => {
    const { readFileSync } = await import('node:fs');
    const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8');
    expect(js).toContain("'not read yet'");
    expect(js).toMatch(/`read \$\{short \? ago\(at\) \+ ' ago' : dt\(at\)\}`/);
    expect(js).toContain('This agent only sees it when woken. Tell its session:');
    expect(js).toContain('codeBox(`read feedback ${r.id}`)');
  });
});
