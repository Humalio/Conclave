/** Agent feedback (docs/feedback.md): the server-side acceptance checks. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';
import type { Config } from '../src/config.js';
import { HUB_VERSION } from '../src/version.js';
import { testConfig, adminLogin } from './hub.js';

const sys = { kind: 'system' as const, id: null };
let app: App, base = '', cookie = '', csrf = '', appKey = '', pcId = '', capKey = '';
let n = 0;

const api = async (method: string, path: string, body?: unknown, raw = false) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (raw) return { status: r.status, text: await r.text(), headers: r.headers };
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
type Rules = { effect: 'allow' | 'deny'; actions: string[]; resource: string }[];
const ALL_TOOLS: Rules = [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:*' }];
const mk = (label: string, rules: Rules = ALL_TOOLS) => {
  const agent = app.keys.createAgent(`${label}-${++n}`, null, sys);
  const k = app.keys.createSessionKey({ agentId: agent.id, label }, sys);
  app.keys.setRules(k.credential.policy_id, rules, 'test', sys);
  return { agent, secret: k.secret, cred: k.credential };
};
type Res = { isError?: boolean; structuredContent?: any; content: { text: string }[] };
async function connect(key = appKey) {
  const c = new Client({ name: 'test-client', version: '9.9' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
  return c;
}
async function login(secret: string, key = appKey) {
  const c = await connect(key);
  const raw = async (name: string, args: Record<string, unknown> = {}) => (await c.callTool({ name, arguments: args })) as Res;
  const token = (await raw('session_login', { session_key: secret })).structuredContent?.session_token as string;
  const S = (name: string, args: Record<string, unknown> = {}) => raw(name, { session_token: token, ...args });
  return Object.assign(S, { client: c, token });
}
type Sess = Awaited<ReturnType<typeof login>>;
async function agentSession(label: string, rules: Rules = ALL_TOOLS) { const p = mk(label, rules); return { ...p, S: await login(p.secret) }; }

const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa', 'quebec', 'romeo', 'sierra', 'tango'];
let seq = 0;
/** A report that is unique (never merges or matches another): its own two title words. */
const uniq = (over: Record<string, unknown> = {}) => {
  const i = seq++;
  return { kind: 'limitation', title: `${WORDS[i % 20]} ${WORDS[(i * 7 + 3) % 20]} widget${'x'.repeat(i)} limit`, area: 'limits', tried: 'Tried to do a thing', severity: 'minor', ...over };
};
const file = (S: Sess, a: Record<string, unknown>) => S('feedback_file', a);
const noticesOf = (r: Res) => ((r.structuredContent?.notices ?? []) as { seq: number; kind: string; body: string }[]).filter((x) => x.kind === 'feedback_update');
const setSettings = async (p: Record<string, unknown>) => (await api('PUT', '/feedback/settings', p)).body;
const rowOf = (id: string) => app.db.prepare('SELECT * FROM feedback_reports WHERE id=?').get(id) as any;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahfb-'));
  const vaultDir = join(dir, 'vault');
  mkdirSync(join(vaultDir, 'Projects/Alpha'), { recursive: true });
  writeFileSync(join(vaultDir, 'Projects/Alpha/plan.md'), 'Alpha plan');
  const config: Config = testConfig(dir, { vaultDir });
  app = await buildApp(config);
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  ({ cookie, csrf } = await adminLogin(base));
  pcId = (await api('POST', '/pcs', { name: 'pc' })).body.pc.id;
  appKey = app.keys.createAppKey({ machineId: pcId, appName: 'claude-code', maxLiveSessions: 200 }, sys).secret;
  capKey = app.keys.createAppKey({ machineId: pcId, appName: 'capped', maxLiveSessions: 50 }, sys).secret;
});
afterAll(async () => { await app.close(); });

describe('tools, instructions and permissions', () => {
  it('lists the four tools and carries the instruction sentence and the session_help lines', async () => {
    const c = await connect();
    const names = (await c.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['feedback_find', 'feedback_file', 'feedback_read', 'feedback_add']));
    expect(c.getInstructions()).toContain('feedback_find');
    expect(c.getInstructions()).toContain('once per problem, not per occurrence, and without private content');
    const help = (await c.callTool({ name: 'session_help', arguments: {} })) as Res;
    expect(help.content[0]!.text).toContain('feedback_file');
    expect(help.content[0]!.text).toContain('access_request');
    // The header variant (connection already logged in) carries the sentence too.
    const { HEADER_INSTRUCTIONS } = await import('../src/mcp/tools.js');
    expect(HEADER_INSTRUCTIONS).toContain('feedback_find');
  });

  it('a key with no tool grants can file; an explicit deny on tool:feedback_* refuses; so does a deny in the app key cap', async () => {
    const narrow = await agentSession('narrow', []);
    expect((await narrow.S('file_list', { path: '/vault' })).structuredContent.error).toBe('denied');
    const ok = await file(narrow.S, uniq());
    expect(ok.isError).toBeFalsy();
    expect(ok.structuredContent.result).toBe('created');
    expect((await narrow.S('feedback_find', {})).isError).toBeFalsy();

    app.keys.setRules(narrow.cred.policy_id, [{ effect: 'deny', actions: ['tool.invoke'], resource: 'tool:feedback_*' }], 'deny', sys);
    for (const [t, args] of [['feedback_find', {}], ['feedback_file', uniq()], ['feedback_read', { report_id: 'x' }], ['feedback_add', { report_id: 'x', kind: 'plus_one' }]] as const) expect((await narrow.S(t, args as Record<string, unknown>)).structuredContent.error).toBe('denied');

    const capped = mk('capped', []);
    const capCred = app.keys.verifyKey(capKey, 'app_key');
    app.keys.setRules(capCred.policy_id, [{ effect: 'deny', actions: ['tool.invoke'], resource: 'tool:feedback_file' }], 'cap', sys);
    const CS = await login(capped.secret, capKey);
    expect((await file(CS, uniq())).structuredContent.error).toBe('denied');
    expect((await CS('feedback_find', {})).isError).toBeFalsy();
    app.keys.setRules(capCred.policy_id, [], 'cap', sys);
  });

  it('the admin key view lists the feedback tools as on by default, and refused when denied', async () => {
    const p = mk('eff', [{ effect: 'deny', actions: ['tool.invoke'], resource: 'tool:feedback_add' }]);
    const eff = (await api('GET', `/keys/${p.cred.id}/effective`)).body.tools as { tool: string; allowed: boolean }[];
    expect(eff.find((t) => t.tool === 'feedback_file')!.allowed).toBe(true);
    expect(eff.find((t) => t.tool === 'feedback_add')!.allowed).toBe(false);
  });

  it('the hub switch turns every feedback tool off, and "own reports only" hides other agents\' reports', async () => {
    const a = await agentSession('sw-a'), b = await agentSession('sw-b');
    const rep = (await file(a.S, uniq({ tool: 'file_patch', error_code: 'zzswitch', title: 'switch probe report zulu' }))).structuredContent.report_id;
    expect((await b.S('feedback_find', { query: 'zzswitch' })).structuredContent.reports.length).toBe(1);
    await setSettings({ own_only: true });
    expect((await b.S('feedback_find', { query: 'zzswitch' })).structuredContent.reports.length).toBe(0);
    expect((await b.S('feedback_read', { report_id: rep })).structuredContent.error).toBe('denied');
    expect((await a.S('feedback_find', { query: 'zzswitch' })).structuredContent.reports.length).toBe(1);
    await setSettings({ own_only: false });
    await setSettings({ enabled: false });
    for (const [t, args] of [['feedback_find', {}], ['feedback_file', uniq()], ['feedback_read', { report_id: rep }], ['feedback_add', { report_id: rep, kind: 'plus_one' }]] as const) {
      const r = await a.S(t, args as Record<string, unknown>);
      expect(r.isError).toBe(true); expect(r.structuredContent.error).toBe('denied');
    }
    await setSettings({ enabled: true });
    expect((await a.S('feedback_find', {})).isError).toBeFalsy();
  });

  it('lockdown blocks filing and adding but not finding or reading; a team pause does not block feedback', async () => {
    const a = await agentSession('lk-a');
    const rep = (await file(a.S, uniq())).structuredContent.report_id;
    app.lockdown.set('writes', undefined, true, null);
    try {
      expect((await file(a.S, uniq())).structuredContent.error).toBe('lockdown');
      expect((await a.S('feedback_add', { report_id: rep, kind: 'evidence', text: 'more' })).structuredContent.error).toBe('lockdown');
      expect((await a.S('feedback_find', {})).isError).toBeFalsy();
      expect((await a.S('feedback_read', { report_id: rep })).isError).toBeFalsy();
    } finally { app.lockdown.set('writes', undefined, false, null); }
    app.lockdown.set('agent', a.agent.id, true, null);
    try { expect((await file(a.S, uniq())).structuredContent.error).toBe('lockdown'); } finally { app.lockdown.set('agent', a.agent.id, false, null); }

    const team = app.teams.create({ name: 'pause me', goal: 'g', members: [{ agent_id: a.agent.id, role: 'coordinator' }] }, sys);
    app.teams.start(team.id, sys);
    app.teams.pause(team.id, 'testing', sys);
    expect((await file(a.S, uniq())).structuredContent.result).toBe('created');
  });
});

describe('fields, validation and idempotency', () => {
  it('validates fields', async () => {
    const a = await agentSession('val');
    const bad = async (over: Record<string, unknown>) => { const r = await file(a.S, uniq(over)); expect(r.isError).toBe(true); return r; };
    await bad({ title: '' });
    await bad({ title: 'x'.repeat(121) });
    expect((await bad({ title: 'two\nlines' })).structuredContent.error).toBe('invalid_argument');
    expect((await bad({ area: undefined })).structuredContent.error).toBe('invalid_argument'); // no tool, no area
    expect((await bad({ tool: 'no_such_tool' })).structuredContent.error).toBe('invalid_argument');
    expect((await bad({ kind: 'bug' })).structuredContent.error).toBe('invalid_argument'); // a bug needs "happened"
    await bad({ tried: '' });
    await bad({ severity: 'huge' });
    await bad({ cost: { extra_calls: -1 } });
    await bad({ links: Array.from({ length: 11 }, (_, i) => `task:t${i}`) });
    expect((await bad({ tried: 'ctl\u0001char' })).structuredContent.error).toBe('invalid_argument');
    const ok = await file(a.S, uniq({ tool: 'file_patch', area: undefined, kind: 'bug', happened: 'It broke', cost: { extra_calls: 3, extra_tokens: 1200, minutes_lost: 4 } }));
    expect(ok.structuredContent.result).toBe('created');
    const row = rowOf(ok.structuredContent.report_id);
    expect(row.area).toBe('vault'); // derived from the tool
    expect(row.hub_version).toBe(HUB_VERSION);
    expect(row.cost_calls).toBe(3);
    expect(row.client_name).toBe(null); // stateless transport: the client's initialisation is not seen on a later call
    expect(row.filer_app).toBe('claude-code');
    expect(row.filer_agent_id).toBe(a.agent.id);
  });

  it('client_report_id makes a retry return the first outcome', async () => {
    const a = await agentSession('idem');
    const args = uniq({ client_report_id: 'retry-1' });
    const r1 = await file(a.S, args), r2 = await file(a.S, args);
    expect(r2.structuredContent.report_id).toBe(r1.structuredContent.report_id);
    expect(r2.structuredContent.deduplicated).toBe(true);
    expect(app.db.prepare('SELECT COUNT(*) n FROM feedback_reports WHERE filer_agent_id=?').get(a.agent.id)).toEqual({ n: 1 });
  });
});

describe('de-duplication', () => {
  it('exact match merges (2 backers); a close match is similar and can withdraw and back; one agent merges into its own report', async () => {
    const a = await agentSession('dd-a'), b = await agentSession('dd-b'), c = await agentSession('dd-c');
    const base = { kind: 'bug', tool: 'file_patch', error_code: 'conflict', happened: 'conflict even though nobody else wrote', tried: 'patched a note', severity: 'costly' };
    const first = await file(a.S, { ...base, title: 'File patch fails with conflict on large notes' });
    expect(first.structuredContent.result).toBe('created');
    const id = first.structuredContent.report_id;

    const second = await file(b.S, { ...base, title: 'File patch fails with conflict on large notes!' });
    expect(second.structuredContent.result).toBe('merged');
    expect(second.structuredContent.report_id).toBe(id);
    expect(rowOf(id).backers).toBe(2);
    expect(app.db.prepare("SELECT COUNT(*) n FROM feedback_reports WHERE tool='file_patch' AND error_code='conflict'").get()).toEqual({ n: 1 });

    const third = await file(c.S, { ...base, title: 'File patch conflict on large notes always' });
    expect(third.structuredContent.result).toBe('created');
    expect(third.structuredContent.similar.map((s: any) => s.id)).toEqual([id]);
    const mine = third.structuredContent.report_id;
    const w = await c.S('feedback_add', { report_id: mine, kind: 'withdraw' });
    expect(w.structuredContent.report.status).toBe('withdrawn');
    const p = await c.S('feedback_add', { report_id: id, kind: 'plus_one' });
    expect(p.structuredContent.report.backers).toBe(3);
    expect((await c.S('feedback_add', { report_id: id, kind: 'plus_one' })).structuredContent.result).toBe('already_backed');
    expect(rowOf(id).backers).toBe(3);

    // The same agent filing the same problem again joins its own report, even after the operator closed it.
    await api('POST', `/feedback/${id}/status`, { status: 'wont_fix', note: 'by design' });
    const again = await file(a.S, { ...base, title: 'File patch fails with conflict on large notes' });
    expect(again.structuredContent.result).toBe('merged');
    expect(again.structuredContent.report_id).toBe(id);
    expect(rowOf(id).status).toBe('wont_fix');
  });

  it('a hidden report is never named to an agent that cannot see it: the filing is created as new', async () => {
    const a = await agentSession('hid-a'), b = await agentSession('hid-b');
    const base = { kind: 'limitation', tool: 'room_create', error_code: 'denied', tried: 'x', severity: 'minor' };
    const id = (await file(a.S, { ...base, title: 'Room create hidden thing' })).structuredContent.report_id;
    await api('PATCH', `/feedback/${id}`, { hidden: true });
    const r = await file(b.S, { ...base, title: 'Room create hidden thing' });
    expect(r.structuredContent.result).toBe('created');
    expect(r.structuredContent.similar).toEqual([]);
    expect((await b.S('feedback_find', { query: 'hidden thing' })).structuredContent.reports.map((x: any) => x.id)).toEqual([r.structuredContent.report_id]);
    expect((await b.S('feedback_read', { report_id: id })).structuredContent.error).toBe('denied');
    expect((await a.S('feedback_read', { report_id: id })).isError).toBeFalsy(); // the filer still sees it
    // The operator can merge the two.
    const m = await api('POST', `/feedback/${r.structuredContent.report_id}/merge`, { target_id: id });
    expect(m.status).toBe(200);
  });
});

describe('visibility: summary and detail layers, links', () => {
  it('another agent sees the summary only; links follow the reader\'s current access', async () => {
    const a = await agentSession('vis-a', [...ALL_TOOLS, { effect: 'allow', actions: ['fs.list', 'fs.read'], resource: 'path:/vault/**' }]);
    const b = await agentSession('vis-b');
    const team = app.teams.create({ name: 'vis', goal: 'g', members: [{ agent_id: a.agent.id, role: 'coordinator' }] }, sys);
    app.teams.start(team.id, sys);
    const task = (await a.S('task_create', { team_id: team.id, title: 'a task' })).structuredContent.task.id as string;

    // A link the filer cannot read fails the call: no probing of paths or task IDs.
    expect((await file(b.S, uniq({ links: [`task:${task}`] }))).structuredContent.error).toBe('denied');
    expect((await file(b.S, uniq({ links: ['/vault/Projects/Alpha/plan.md'] }))).structuredContent.error).toBe('denied');
    expect((await file(b.S, uniq({ links: ['task:does_not_exist'] }))).structuredContent.error).toBe('denied');
    expect((await file(b.S, uniq({ links: ['share:nope'] }))).structuredContent.error).toBe('denied');
    expect((await file(b.S, uniq({ links: ['junk'] }))).structuredContent.error).toBe('invalid_argument');

    const filed = await file(a.S, uniq({ title: 'visibility zebra probe', tried: 'PRIVATE-TRIED-TEXT about Projects/Alpha', happened: 'PRIVATE-HAPPENED', links: [`task:${task}`, '/vault/Projects/Alpha/plan.md'] }));
    expect(filed.isError).toBeFalsy();
    const id = filed.structuredContent.report_id;

    const seen = await b.S('feedback_find', { query: 'zebra' });
    expect(seen.structuredContent.reports.length).toBe(1);
    expect(JSON.stringify(seen)).not.toContain('PRIVATE');
    const rb = await b.S('feedback_read', { report_id: id });
    expect(rb.structuredContent.detail).toBe(null);
    expect(JSON.stringify(rb)).not.toContain('PRIVATE');
    expect(JSON.stringify(rb)).not.toContain(task);
    expect(rb.structuredContent.report.backers).toBe(1);
    expect(JSON.stringify(rb)).not.toContain(a.agent.id); // backers are a count, never names

    const ra = await a.S('feedback_read', { report_id: id });
    expect(ra.structuredContent.detail.tried).toContain('PRIVATE-TRIED-TEXT');
    expect(ra.structuredContent.detail.links).toEqual([`task:${task}`, '/vault/Projects/Alpha/plan.md']);

    // The filer loses read access to the note: the link is left out, without saying so.
    app.keys.setRules(a.cred.policy_id, ALL_TOOLS, 'revoke', sys);
    const ra2 = await a.S('feedback_read', { report_id: id });
    expect(ra2.structuredContent.detail.links).toEqual([`task:${task}`]);
  });

  it('a backer sees its own entries only, and the filer does not see a backer\'s text', async () => {
    const a = await agentSession('ent-a'), b = await agentSession('ent-b'), c = await agentSession('ent-c');
    const id = (await file(a.S, uniq({ title: 'entries yak probe' }))).structuredContent.report_id;
    await b.S('feedback_add', { report_id: id, kind: 'evidence', text: 'B-EVIDENCE-TEXT' });
    await c.S('feedback_add', { report_id: id, kind: 'plus_one' });
    const rb = await b.S('feedback_read', { report_id: id });
    expect(rb.structuredContent.detail.entries.map((e: any) => e.text)).toEqual(['B-EVIDENCE-TEXT']);
    expect(rb.structuredContent.detail.tried).toBeUndefined();
    const ra = await a.S('feedback_read', { report_id: id });
    expect(ra.structuredContent.detail.entries.length).toBe(2);
    expect(JSON.stringify(ra)).not.toContain('B-EVIDENCE-TEXT');
    expect(rowOf(id).backers).toBe(3);
  });

  it('L0 guidance reaches agents with the summary; titles are labelled L2', async () => {
    const a = await agentSession('g-a'), b = await agentSession('g-b');
    const id = (await file(a.S, uniq({ title: 'guidance walrus probe', tool: 'file_read', error_code: 'zzguide' }))).structuredContent.report_id;
    await api('POST', `/feedback/${id}/status`, { status: 'accepted', note: 'We agree', guidance: 'Use file_search first' });
    const r = await b.S('feedback_find', { query: 'walrus' });
    expect(r.structuredContent.reports[0].title_trust).toBe('L2');
    expect(r.structuredContent.reports[0].decision).toMatchObject({ trust: 'L0', guidance: 'Use file_search first' });
    expect(r.content[0]!.text).toContain('Operator guidance (L0): Use file_search first');
  });
});

describe('leak guard', () => {
  it('an issued key in a field is refused, suspends the key, and stores nothing; a key-shaped fake is refused without suspension', async () => {
    const a = await agentSession('lg-a'), victim = mk('lg-victim');
    const before = (app.db.prepare('SELECT COUNT(*) n FROM feedback_reports').get() as any).n;
    const r = await file(a.S, uniq({ tried: `I used ${victim.secret} to log in` }));
    expect(r.structuredContent.error).toBe('contains_key');
    expect(app.keys.credential(a.cred.id)!.status).toBe('suspended');
    expect((app.db.prepare('SELECT COUNT(*) n FROM feedback_reports').get() as any).n).toBe(before);
    expect(JSON.stringify(app.db.prepare('SELECT * FROM feedback_reports').all())).not.toContain(victim.secret.split('_').pop()!);

    const b = await agentSession('lg-b');
    const fake = 'ah_ses_aaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    expect((await file(b.S, uniq({ title: 'fake key probe', happened: `key ${fake}` }))).structuredContent.error).toBe('contains_key');
    expect((await b.S('feedback_add', { report_id: 'x', kind: 'evidence', text: fake })).structuredContent.error).toBe('contains_key');
    expect(app.keys.credential(b.cred.id)!.status).toBe('active');
    expect((app.db.prepare('SELECT COUNT(*) n FROM feedback_reports').get() as any).n).toBe(before);
  });

  it('a credential in operator guidance is withheld from the notice and from reads', async () => {
    const a = await agentSession('lg-g'), victim = mk('lg-victim2');
    const id = (await file(a.S, uniq({ title: 'guidance leak probe', tool: 'file_read', error_code: 'zzleak' }))).structuredContent.report_id;
    const st = await api('POST', `/feedback/${id}/status`, { status: 'accepted', guidance: `try ${victim.secret}` });
    expect(st.status).toBe(200);
    const r = await a.S('session_whoami');
    const ns = noticesOf(r);
    expect(ns.length).toBe(1);
    expect(ns[0]!.body).toContain('withheld');
    expect(JSON.stringify(r)).not.toContain(victim.secret.split('_').pop()!);
    const read = await a.S('feedback_read', { report_id: id });
    expect(read.structuredContent.error).toBe('content_withheld');
    expect(JSON.stringify(read)).not.toContain(victim.secret.split('_').pop()!);
  });
});

describe('statuses, notices and reopening', () => {
  it('a second status change quickly: each backer receives only the current decision, once', async () => {
    const a = await agentSession('nt-a'), b = await agentSession('nt-b');
    const id = (await file(a.S, uniq({ title: 'notice parrot probe' }))).structuredContent.report_id;
    await b.S('feedback_add', { report_id: id, kind: 'plus_one' });
    expect((await api('POST', `/feedback/${id}/status`, { status: 'accepted', note: 'agreed' })).status).toBe(200);
    expect((await api('POST', `/feedback/${id}/status`, { status: 'fixed', note: 'changed it', fixed_in: '0.1.0' })).status).toBe(200);
    for (const S of [a.S, b.S]) {
      const r = await S('session_whoami');
      const ns = noticesOf(r);
      expect(ns.length).toBe(1);
      expect(ns[0]!.body).toContain('is now fixed');
      expect(ns[0]!.body).toContain('changed it');
      expect(ns[0]!.body).toContain('L2 data');
      await S('session_ack', { notice_seq: Math.max(...(r.structuredContent.notices as any[]).map((x) => x.seq)) });
      expect(noticesOf(await S('session_whoami')).length).toBe(0);
    }
    // accepted -> fixed -> accepted: an older "accepted" notice does not come back with the newer one
    const c = await agentSession('nt-c');
    const id2 = (await file(c.S, uniq({ title: 'notice pigeon probe' }))).structuredContent.report_id;
    await api('POST', `/feedback/${id2}/status`, { status: 'accepted', note: 'first' });
    await api('POST', `/feedback/${id2}/status`, { status: 'fixed', note: 'second', fixed_in: '0.1.0' });
    await api('POST', `/feedback/${id2}/status`, { status: 'accepted', note: 'third' });
    const ns = noticesOf(await c.S('session_whoami'));
    expect(ns.length).toBe(1);
    expect(ns[0]!.body).toContain('third');
    const d = (await api('GET', `/feedback/${id2}`)).body;
    expect(d.notices.notified).toBe(1);
    expect(d.notices.seen).toBe(0);
    await c.S('session_ack', { notice_seq: ns[0]!.seq });
    expect((await api('GET', `/feedback/${id2}`)).body.notices.seen).toBe(1);
  });

  it('needs_info is answered by the filer and moves back to new; withdraw tells the backers', async () => {
    const a = await agentSession('ni-a'), b = await agentSession('ni-b');
    const id = (await file(a.S, uniq({ title: 'question marmot probe' }))).structuredContent.report_id;
    await b.S('feedback_add', { report_id: id, kind: 'plus_one' });
    expect((await api('POST', `/feedback/${id}/status`, { status: 'needs_info' })).status).toBe(400); // a question is required
    expect((await api('POST', `/feedback/${id}/status`, { status: 'needs_info', note: 'Which file?' })).status).toBe(200);
    expect((await b.S('feedback_add', { report_id: id, kind: 'answer', text: 'x' })).structuredContent.error).toBe('denied'); // filer only
    const r = await a.S('feedback_add', { report_id: id, kind: 'answer', text: 'The big one' });
    expect(r.structuredContent.report.status).toBe('new');
    expect((await b.S('feedback_add', { report_id: id, kind: 'withdraw' })).structuredContent.error).toBe('denied'); // filer only
    await a.S('feedback_add', { report_id: id, kind: 'withdraw' });
    expect(rowOf(id).status).toBe('withdrawn');
    expect(noticesOf(await b.S('session_whoami')).some((x) => x.body.includes('withdrawn'))).toBe(true);
  });

  it('fixed needs a note; won\'t fix needs a reason; transitions are audited without free text', async () => {
    const a = await agentSession('fx-a');
    const id = (await file(a.S, uniq({ title: 'fixed otter probe', tried: 'SECRET-FREE-TEXT' }))).structuredContent.report_id;
    expect((await api('POST', `/feedback/${id}/status`, { status: 'fixed' })).status).toBe(400);
    expect((await api('POST', `/feedback/${id}/status`, { status: 'wont_fix' })).status).toBe(400);
    expect((await api('POST', `/feedback/${id}/status`, { status: 'duplicate' })).status).toBe(400);
    expect((await api('POST', `/feedback/${id}/status`, { status: 'fixed', note: 'NOTE-TEXT', fixed_in: '0.1.0' })).status).toBe(200);
    const events = app.db.prepare("SELECT action, details FROM audit_events WHERE target_id=? ORDER BY id").all(id) as { action: string; details: string }[];
    expect(events.map((e) => e.action)).toEqual(['feedback.file', 'feedback.status']);
    expect(JSON.stringify(events)).not.toContain('SECRET-FREE-TEXT');
    expect(JSON.stringify(events)).not.toContain('NOTE-TEXT');
    expect(JSON.parse(events[1]!.details)).toMatchObject({ from: 'new', to: 'fixed', fixed_in: '0.1.0' });
  });

  it('still_happening reopens a fixed report on the fix version or later, and is evidence only on an older hub', async () => {
    const a = await agentSession('sh-a'), b = await agentSession('sh-b'), c = await agentSession('sh-c'), d = await agentSession('sh-d');
    const mkFixed = async (fixedIn: string | null) => {
      const id = (await file(a.S, uniq())).structuredContent.report_id;
      await api('POST', `/feedback/${id}/status`, { status: 'fixed', note: 'changed', fixed_in: fixedIn });
      return id as string;
    };
    const same = await mkFixed(HUB_VERSION);
    const r1 = await b.S('feedback_add', { report_id: same, kind: 'still_happening', text: 'again' });
    expect(r1.structuredContent.result).toBe('reopened');
    expect(rowOf(same)).toMatchObject({ status: 'new', reopen_count: 1 });
    expect(noticesOf(await a.S('session_whoami')).some((x) => x.body.includes(same) && x.body.includes('is now new'))).toBe(true);

    const later = await mkFixed('99.0.0');
    const r2 = await c.S('feedback_add', { report_id: later, kind: 'still_happening', text: 'again' });
    expect(r2.structuredContent.result).toBe('added');
    expect(r2.structuredContent.note).toContain('99.0.0');
    expect(rowOf(later)).toMatchObject({ status: 'fixed', reopen_count: 0 });
    expect(rowOf(later).backers).toBe(2);

    const unversioned = await mkFixed(null);
    expect((await d.S('feedback_add', { report_id: unversioned, kind: 'still_happening' })).structuredContent.result).toBe('reopened');

    // won't fix: evidence, no reopen
    const wf = (await file(a.S, uniq())).structuredContent.report_id;
    await api('POST', `/feedback/${wf}/status`, { status: 'wont_fix', note: 'by design' });
    const before = rowOf(wf).last_seen_at;
    await new Promise((r) => setTimeout(r, 5));
    expect((await b.S('feedback_add', { report_id: wf, kind: 'still_happening', text: 'still' })).structuredContent.report.status).toBe('wont_fix');
    expect(rowOf(wf).last_seen_at).toBeGreaterThan(before);

    // The same agent filing a fixed problem again within a day counts as still_happening.
    const own = uniq({ tool: 'file_patch', error_code: 'zzown', title: 'own fixed echo probe' });
    const e = await agentSession('sh-e');
    const oid = (await file(e.S, own)).structuredContent.report_id;
    await api('POST', `/feedback/${oid}/status`, { status: 'fixed', note: 'changed', fixed_in: HUB_VERSION });
    const again = await file(e.S, own);
    expect(again.structuredContent).toMatchObject({ result: 'merged', report_id: oid, reopened: true });
  });
});

describe('rate limits', () => {
  it('new reports: 5 per hour per agent with retry_after_s; a new key for the same agent does not reset it; spam alert after three hits', async () => {
    const a = await agentSession('rl-a');
    for (let i = 0; i < 5; i++) expect((await file(a.S, uniq())).structuredContent.result).toBe('created');
    const r = await file(a.S, uniq());
    expect(r.structuredContent.error).toBe('rate_limited');
    expect(r.structuredContent.retry_after_s).toBeGreaterThan(0);
    expect(r.structuredContent.message).toContain('feedback_add');
    // A second session key for the same agent shares the counters.
    const k2 = app.keys.createSessionKey({ agentId: a.agent.id, label: 'second' }, sys);
    app.keys.setRules(k2.credential.policy_id, ALL_TOOLS, 'test', sys);
    const S2 = await login(k2.secret);
    expect((await file(S2, uniq())).structuredContent.error).toBe('rate_limited');
    expect((await file(S2, uniq())).structuredContent.error).toBe('rate_limited'); // the third hit in an hour
    expect((app.db.prepare("SELECT COUNT(*) n FROM security_alerts WHERE type='feedback_spam' AND subject=?").get(a.agent.id) as any).n).toBe(1);
    expect((app.db.prepare("SELECT severity FROM security_alerts WHERE type='feedback_spam' AND subject=?").get(a.agent.id) as any).severity).toBe('info');
  });

  it('entries per hour, entries per report, open reports per agent, and the daily per-agent limit', async () => {
    await setSettings({ limits: { entriesPerHour: 3, entriesPerReport: 3, openPerAgent: 2, reportsPerDay: 3 } });
    try {
      const f = await agentSession('rl-f'), a = await agentSession('rl-b');
      const id = (await file(f.S, uniq())).structuredContent.report_id;
      for (let i = 0; i < 3; i++) expect((await a.S('feedback_add', { report_id: id, kind: i === 0 ? 'plus_one' : 'evidence', text: `e${i}` })).isError).toBeFalsy();
      const r = await a.S('feedback_add', { report_id: id, kind: 'evidence', text: 'one too many' });
      expect(r.structuredContent.error).toBe('rate_limited');
      expect(r.structuredContent.retry_after_s).toBeGreaterThan(0);

      // Past the per-report cap, a new backer is counted but its text is dropped.
      const x = await agentSession('rl-x'), y = await agentSession('rl-y');
      const id2 = (await file(f.S, uniq())).structuredContent.report_id;
      for (let i = 0; i < 3; i++) await x.S('feedback_add', { report_id: id2, kind: 'evidence', text: `e${i}` });
      const dropped = await y.S('feedback_add', { report_id: id2, kind: 'evidence', text: 'DROPPED-TEXT' });
      expect(dropped.structuredContent.text_dropped).toBe(true);
      expect(rowOf(id2).backers).toBe(3); // filer, x and y
      expect(JSON.stringify(app.db.prepare('SELECT * FROM feedback_entries').all())).not.toContain('DROPPED-TEXT');

      // Two open reports is the limit for f; a third is refused (without a retry time).
      const g = await agentSession('rl-g');
      await file(g.S, uniq()); await file(g.S, uniq());
      const third = await file(g.S, uniq());
      expect(third.structuredContent.error).toBe('rate_limited');
      expect(third.structuredContent.retry_after_s).toBeUndefined();
    } finally { await setSettings({ limits: { entriesPerHour: 30, entriesPerReport: 200, openPerAgent: 25, reportsPerDay: 20 } }); }
    const h = await agentSession('rl-h');
    await setSettings({ limits: { reportsPerDay: 2 } });
    try {
      await file(h.S, uniq()); await file(h.S, uniq());
      expect((await file(h.S, uniq())).structuredContent.error).toBe('rate_limited');
    } finally { await setSettings({ limits: { reportsPerDay: 20 } }); }
  });

  it('the hub-wide daily limit refuses everyone and raises one feedback_flood warning', async () => {
    const used = (app.db.prepare("SELECT COALESCE(SUM(count),0) n FROM usage_counters WHERE metric='fb_new_hub_d'").get() as any).n as number;
    await setSettings({ limits: { hubReportsPerDay: used + 1 } });
    try {
      const a = await agentSession('fl-a'), b = await agentSession('fl-b');
      expect((await file(a.S, uniq())).structuredContent.result).toBe('created');
      const r = await file(b.S, uniq());
      expect(r.structuredContent.error).toBe('rate_limited');
      expect(r.structuredContent.retry_after_s).toBeGreaterThan(0);
      expect((await file(a.S, uniq())).structuredContent.error).toBe('rate_limited');
      const alerts = app.db.prepare("SELECT severity FROM security_alerts WHERE type='feedback_flood'").all() as { severity: string }[];
      expect(alerts.length).toBe(1);
      expect(alerts[0]!.severity).toBe('warning');
      // Adding to an existing report is not limited by it.
      expect((await b.S('feedback_find', {})).isError).toBeFalsy();
    } finally { await setSettings({ limits: { hubReportsPerDay: 200 } }); }
  });
});

describe('hub evidence and error hints', () => {
  it('stores the filer\'s recent calls to the named tool (no arguments), and the operator sees same-error counts', async () => {
    const a = await agentSession('ev-a');
    for (let i = 0; i < 3; i++) await a.S('file_read', { path: `/vault/Nope/${i}.md` });
    const id = (await file(a.S, uniq({ tool: 'file_read', error_code: 'denied', title: 'evidence ibis probe', area: undefined }))).structuredContent.report_id;
    const d = (await api('GET', `/feedback/${id}`)).body;
    expect(d.hub_evidence.calls.length).toBe(3);
    expect(d.hub_evidence.calls[0]).toMatchObject({ tool: 'file_read', result: 'denied', error_code: 'denied' });
    expect(JSON.stringify(d.hub_evidence)).not.toContain('Nope');
    expect(d.hub_evidence.same_error_7d.calls).toBeGreaterThanOrEqual(3);
    expect(d.filer).toMatchObject({ agent_id: a.agent.id, app: 'claude-code' });
  });

  it('an error that matches an accepted report with guidance carries "Known: fb_..." once per agent per day', async () => {
    const a = await agentSession('kn-a'), b = await agentSession('kn-b');
    const id = (await file(a.S, uniq({ tool: 'file_stat', error_code: 'denied', title: 'known hint lemur probe', area: undefined }))).structuredContent.report_id;
    // no guidance yet: no hint
    expect((await b.S('file_stat', { path: '/vault/x' })).content[0]!.text).not.toContain('Known:');
    await api('POST', `/feedback/${id}/status`, { status: 'accepted', guidance: 'Ask for fs.list first' });
    const first = await b.S('file_stat', { path: '/vault/x' });
    expect(first.content[0]!.text).toContain(`Known: ${id}`);
    expect(first.structuredContent.known.report_id).toBe(id);
    expect((await b.S('file_stat', { path: '/vault/x' })).content[0]!.text).not.toContain('Known:');
    // other errors carry no hint
    expect((await b.S('file_read', { path: '/vault/x' })).content[0]!.text).not.toContain('Known:');
    // a different agent still gets it once
    expect((await a.S('file_stat', { path: '/vault/x' })).content[0]!.text).toContain('Known:');
  });
});

describe('internal_error hint', () => {
  it('only an internal_error points at feedback_file; a denial or conflict carries no hint', async () => {
    const a = await agentSession('ie-a');
    const real = app.feedback.find.bind(app.feedback);
    app.feedback.find = () => { throw new Error('boom'); };
    let r: Res;
    try { r = await a.S('feedback_find', {}); } finally { app.feedback.find = real; }
    expect(r.structuredContent.error).toBe('internal_error');
    expect(r.content[0]!.text).toContain('feedback_file (tool: feedback_find, error_code: internal_error)');
    const denied = await a.S('file_read', { path: '/vault/Nope.md' });
    expect(denied.structuredContent.error).toBe('denied');
    expect(denied.content[0]!.text).not.toContain('feedback_file');
  });
});

describe('operator routes', () => {
  it('list, buckets, read, edit, hide, merge, export and delete; CSRF is required', async () => {
    const a = await agentSession('op-a'), b = await agentSession('op-b'), c = await agentSession('op-c');
    const id1 = (await file(a.S, uniq({ title: 'operator panda probe', severity: 'blocking' }))).structuredContent.report_id;
    const id2 = (await file(b.S, uniq({ title: 'operator koala probe' }))).structuredContent.report_id;
    await c.S('feedback_add', { report_id: id1, kind: 'plus_one' });
    const list = (await api('GET', '/feedback?bucket=new&q=operator')).body;
    expect(list.reports.map((r: any) => r.id)).toEqual([id1, id2]); // impact: backers first
    expect(list.counts.new).toBeGreaterThan(0);

    const noCsrf = await fetch(`${base}/api/feedback/${id1}/status`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ status: 'accepted' }) });
    expect(noCsrf.status).toBe(403);
    const anon = await fetch(`${base}/api/feedback`);
    expect(anon.status).toBe(401);

    expect((await api('PATCH', `/feedback/${id1}`, { title: 'Edited title', severity: 'minor' })).body.report.original_title).toBe('operator panda probe');
    expect((await api('GET', `/feedback/${id1}`)).body.history.map((h: any) => h.field)).toEqual(expect.arrayContaining(['title', 'severity']));
    expect((await api('PATCH', `/feedback/${id1}`, { title: 'two\nlines' })).status).toBe(400);

    const m = await api('POST', `/feedback/${id2}/merge`, { target_id: id1 });
    expect(m.status).toBe(200);
    expect(rowOf(id2)).toMatchObject({ status: 'duplicate', duplicate_of: id1 });
    expect(rowOf(id1).backers).toBe(3); // filer a, backer c, and b moved over; counted once per agent
    expect(noticesOf(await b.S('session_whoami')).some((x) => x.body.includes(id1))).toBe(true);
    expect((await api('POST', `/feedback/${id2}/merge`, { target_id: id1 })).status).toBe(409);
    expect((await api('POST', `/feedback/${id1}/merge`, { target_id: id2 })).status).toBe(400); // target is a duplicate
    expect((await b.S('feedback_add', { report_id: id2, kind: 'evidence', text: 'x' })).structuredContent.error).toBe('invalid_state');
    expect((await b.S('feedback_read', { report_id: id2 })).isError).toBeFalsy(); // entries stay readable from both

    const md = await api('GET', `/feedback/export?ids=${id1},${id2}&format=md`, undefined, true);
    expect(md.status).toBe(200);
    expect(md.text).toContain(id1);
    expect(md.text).toContain('Tried to do a thing');
    const json = await api('GET', `/feedback/export?ids=${id1}&format=json`, undefined, true);
    expect(JSON.parse(json.text)[0].id).toBe(id1);
    expect((app.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='feedback.export'").get() as any).n).toBe(2);

    expect((await api('DELETE', `/feedback/${id1}`)).status).toBe(200);
    expect((await api('GET', `/feedback/${id1}`)).status).toBe(404);
    expect((app.db.prepare("SELECT COUNT(*) n FROM feedback_entries WHERE report_id=? OR origin_report_id=?").get(id1, id1) as any).n).toBe(0);
    const del = app.db.prepare("SELECT details FROM audit_events WHERE action='feedback.delete' AND target_id=?").get(id1) as { details: string };
    expect(JSON.parse(del.details)).toMatchObject({ kind: 'limitation' });
  });

  it('counts the new reports for the badge and lists blocking reports backed by three agents within a day as urgent; both clear when triaged', async () => {
    const a = await agentSession('ur-a'), b = await agentSession('ur-b'), c = await agentSession('ur-c');
    const id = (await file(a.S, uniq({ title: 'urgent raven probe', severity: 'blocking' }))).structuredContent.report_id;
    expect((await api('GET', '/feedback/counts')).body.urgent.map((u: any) => u.id)).not.toContain(id);
    await b.S('feedback_add', { report_id: id, kind: 'plus_one' });
    await c.S('feedback_add', { report_id: id, kind: 'evidence', text: 'me too' });
    const before = (await api('GET', '/feedback/counts')).body;
    expect(before.urgent.map((u: any) => u.id)).toContain(id);
    expect(before.new).toBeGreaterThan(0);
    await api('POST', `/feedback/${id}/status`, { status: 'accepted' });
    const after = (await api('GET', '/feedback/counts')).body;
    expect(after.urgent.map((u: any) => u.id)).not.toContain(id);
    expect(after.new).toBe(before.new - 1);
  });

  it('guidance can be edited without a status change, and operator notes stay in the console', async () => {
    const a = await agentSession('gd-a');
    const id = (await file(a.S, uniq({ title: 'guidance heron probe' }))).structuredContent.report_id;
    await api('POST', `/feedback/${id}/status`, { status: 'accepted' });
    const g = await api('PATCH', `/feedback/${id}`, { guidance: '  Use the offset argument.  ' });
    expect(g.status).toBe(200);
    expect(g.body.report).toMatchObject({ status: 'accepted', guidance: 'Use the offset argument.' });
    expect(g.body.history.filter((h: any) => h.field === 'status')).toHaveLength(2); // filed, accepted: no new status row
    expect(g.body.history.find((h: any) => h.field === 'guidance')).toMatchObject({ old_value: null, new_value: 'Use the offset argument.', actor_kind: 'admin' });
    expect((await a.S('feedback_find', { query: 'heron' })).structuredContent.reports[0].decision).toMatchObject({ trust: 'L0', guidance: 'Use the offset argument.' });
    expect((await api('PATCH', `/feedback/${id}`, { guidance: 'x'.repeat(2001) })).status).toBe(400);
    expect((await api('PATCH', `/feedback/${id}`, { guidance: null })).body.report.guidance).toBeNull();

    const n = await api('POST', `/feedback/${id}/notes`, { text: 'Asked the vault team about it.' });
    expect(n.status).toBe(200);
    expect(n.body.history.at(-1)).toMatchObject({ field: 'note', note: 'Asked the vault team about it.', actor_kind: 'admin' });
    expect((await api('POST', `/feedback/${id}/notes`, { text: '' })).status).toBe(400);
    expect((await api('POST', '/feedback/fb_missing/notes', { text: 'x' })).status).toBe(404);
    expect(JSON.stringify((await a.S('feedback_read', { report_id: id })).structuredContent)).not.toContain('vault team');
    expect((app.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='feedback.note' AND target_id=?").get(id) as any).n).toBe(1);
  });

  it('settings round-trip and are audited', async () => {
    const s = (await api('GET', '/feedback/settings')).body;
    expect(s).toMatchObject({ enabled: true, own_only: false });
    expect(s.limits.reportsPerHour).toBe(5);
    expect((await api('PUT', '/feedback/settings', { limits: { reportsPerHour: 0 } })).status).toBe(400);
    expect((app.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='feedback.settings'").get() as any).n).toBeGreaterThan(0);
  });
});
