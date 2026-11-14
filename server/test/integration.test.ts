import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';
import type { Config } from '../src/config.js';
import { totp } from '../src/util/crypto.js';
import { testConfig } from './hub.js';

const sys = { kind: 'system' as const, id: null };
let app: App, base: string, appKey: string, appCredId: string;
let n = 0;

const rulesFor = (...paths: string[]) => [
  { effect: 'allow' as const, actions: ['tool.invoke'], resource: 'tool:file_*' },
  ...paths.map((p) => ({ effect: 'allow' as const, actions: ['fs.list', 'fs.read', 'fs.search'], resource: `path:/vault/${p}` })),
];

function newSession(rules: ReturnType<typeof rulesFor>, label = `agent-${++n}`) {
  const agent = app.keys.createAgent(label, null, sys);
  const k = app.keys.createSessionKey({ agentId: agent.id, label }, sys);
  app.keys.setRules(k.credential.policy_id, rules, 'test', sys);
  return { ...k, agent };
}
function newAppKey(name = `app${++n}`) {
  const pc = app.keys.createMachine(`pc${++n}`, null, sys);
  return app.keys.createAppKey({ machineId: pc.id, appName: name }, sys);
}

async function connect(key = appKey) {
  const c = new Client({ name: 'test', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
  const call = async (name: string, args: Record<string, unknown> = {}) => (await c.callTool({ name, arguments: args })) as { isError?: boolean; structuredContent?: any; content: { text: string }[] };
  const login = async (sessionKey: string) => { const r = await call('session_login', { session_key: sessionKey }); return { r, token: r.structuredContent?.session_token as string }; };
  return { c, call, login };
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-'));
  const vaultDir = join(dir, 'vault');
  for (const [p, text] of [['Projects/Alpha/plan.md', 'Alpha plan: launch in May'], ['Projects/Beta/plan.md', 'Beta plan: launch in June'], ['Private/diary.md', 'my private launch thoughts'], ['Public/readme.md', 'Public readme'], ['Public/idea.md', 'See [[readme]] and [[readme|the readme]]'], ['Public/other.md', 'no link [[readme2]]'], ['Public/big.md', 'x'.repeat(100_000)], ['Public/huge.md', 'y'.repeat(1_100_000)], ['.obsidian/app.json', '{"launch":1}']] as const) {
    mkdirSync(join(vaultDir, p, '..'), { recursive: true });
    writeFileSync(join(vaultDir, p), text);
  }
  const config: Config = testConfig(dir, { vaultDir, allowedOrigins: ['http://ok.test'], vaultScanSeconds: undefined, vaultWatch: undefined, maintenanceSeconds: undefined });
  app = await buildApp(config);
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  const a = newAppKey('claude-code'); appKey = a.secret; appCredId = a.credential.id;
});
afterAll(async () => { await app.close(); });

describe('MCP authentication', () => {
  it('rejects a missing or bad app key with 401 and logs it', async () => {
    for (const h of [{}, { Authorization: 'Bearer ah_app_aaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }, { Authorization: 'Bearer nonsense' }]) {
      const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...h }, body: '{}' });
      expect(r.status).toBe(401);
    }
    const n401 = app.db.prepare("SELECT COUNT(*) n FROM authentication_events WHERE subject_kind='app_key' AND outcome!='success'").get() as { n: number };
    expect(n401.n).toBeGreaterThanOrEqual(3);
  });
  it('GET and DELETE are 405', async () => {
    for (const method of ['GET', 'DELETE']) expect((await fetch(`${base}/mcp`, { method, headers: { Authorization: `Bearer ${appKey}` } })).status).toBe(405);
  });
  it('a session key is not accepted as an app key', async () => {
    const s = newSession(rulesFor('**'));
    expect((await fetch(`${base}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${s.secret}`, 'content-type': 'application/json' }, body: '{}' })).status).toBe(401);
  });
  it('with the app key alone only session_login and session_help work', async () => {
    const { c, call } = await connect();
    const tools = (await c.listTools()).tools.map((t) => t.name);
    expect(tools).toEqual(expect.arrayContaining(['session_login', 'session_help', 'file_read', 'access_list']));
    expect(c.getInstructions()).toContain('First call `session_login`');
    expect((await call('session_help')).isError).toBeFalsy();
    for (const [name, args] of [['file_list', { path: '/vault' }], ['file_read', { path: '/vault/Public/readme.md' }], ['session_whoami', {}], ['access_list', {}]] as const) {
      const r = await call(name, args as Record<string, unknown>);
      expect(r.isError).toBe(true); expect(r.structuredContent.error).toBe('login_required');
    }
    expect((await call('file_read', { path: '/vault/Public/readme.md', session_token: 'ah_tok_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })).structuredContent.error).toBe('login_required');
  });
  it('wrong session key is denied, and 10 failures rate-limit the app', async () => {
    const other = newAppKey();
    const { call } = await connect(other.secret);
    for (let i = 0; i < 10; i++) expect((await call('session_login', { session_key: 'ah_ses_aaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' })).structuredContent.error).toBe('denied');
    expect((await call('session_login', { session_key: 'ah_ses_aaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' })).structuredContent.error).toBe('rate_limited');
    const good = newSession(rulesFor('**'));
    expect((await call('session_login', { session_key: good.secret })).structuredContent.error).toBe('rate_limited');
  });
});

describe('permissions are per session key', () => {
  it('two session keys with different rules see and read different folders', async () => {
    const a = newSession(rulesFor('Projects/Alpha/**', 'Public/**')), b = newSession(rulesFor('Projects/Beta/**'));
    const { call, login } = await connect();
    const ta = (await login(a.secret)).token, tb = (await login(b.secret)).token;
    const names = async (t: string, p: string) => (await call('file_list', { session_token: t, path: p })).structuredContent.entries.map((e: any) => e.name).sort();
    expect(await names(ta, '/vault')).toEqual(['Projects', 'Public']);
    expect(await names(tb, '/vault')).toEqual(['Projects']);
    expect(await names(ta, '/vault/Projects')).toEqual(['Alpha']);
    expect(await names(tb, '/vault/Projects')).toEqual(['Beta']);
    expect((await call('file_read', { session_token: ta, path: '/vault/Projects/Alpha/plan.md' })).structuredContent.content).toContain('Alpha plan');
    expect((await call('file_read', { session_token: tb, path: '/vault/Projects/Alpha/plan.md' })).structuredContent.error).toBe('denied');
    expect((await call('file_read', { session_token: ta, path: '/vault/Projects/Beta/plan.md' })).structuredContent.error).toBe('denied');
    // denied and not found look the same
    expect((await call('file_read', { session_token: ta, path: '/vault/Projects/Alpha/nope.md' })).structuredContent.error).toBe('denied');
    expect((await call('file_list', { session_token: tb, path: '/vault/Public' })).structuredContent.error).toBe('denied');
    expect((await call('file_stat', { session_token: ta, path: '/vault/Public/readme.md' })).structuredContent.type).toBe('file');
    const search = async (t: string) => (await call('file_search', { session_token: t, query: 'LAUNCH' })).structuredContent.hits.map((h: any) => h.path).sort();
    expect(await search(ta)).toEqual(['/vault/Projects/Alpha/plan.md']);
    expect(await search(tb)).toEqual(['/vault/Projects/Beta/plan.md']);
  });
  it('file_list and file_search say when permissions hide entries, instead of looking empty', async () => {
    const { call, login } = await connect();
    // fs.list on the folder itself but on nothing in it: not an empty folder.
    const only = (await login(newSession([...rulesFor('Projects/Alpha/**'), { effect: 'allow', actions: ['fs.list'], resource: 'path:/vault/Private' }]).secret)).token;
    const none = (await call('file_list', { session_token: only, path: '/vault/Private' })).structuredContent;
    expect(none.entries).toEqual([]);
    expect(none.hidden_by_permissions).toBe(true);
    expect(none.note).toMatch(/not empty.*access_request/);
    // Partly visible: what may be seen is listed, with a note.
    const partly = await call('file_list', { session_token: only, path: '/vault/Projects' });
    expect(partly.structuredContent.entries.map((e: any) => e.name)).toEqual(['Alpha']);
    expect(partly.structuredContent.note).toMatch(/Some entries.*hidden.*access_request/);
    expect(partly.content[0].text).toContain('access_request');
    // A prefix with nothing readable and searchable is refused, not "No matches".
    const refused = await call('file_search', { session_token: only, query: 'launch', path_prefix: '/vault/Private' });
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent.error).toBe('denied');
    expect(refused.content[0].text).toMatch(/may not search \/vault\/Private.*access_request/);
    // A prefix partly readable: hits plus a note that some files were skipped.
    const part = (await call('file_search', { session_token: only, query: 'launch', path_prefix: '/vault/Projects' })).structuredContent;
    expect(part.hits.map((h: any) => h.path)).toEqual(['/vault/Projects/Alpha/plan.md']);
    expect(part.note).toMatch(/not searched.*access_request/);
    // Full access: no notes.
    const all = (await login(newSession(rulesFor('**')).secret)).token;
    expect((await call('file_list', { session_token: all, path: '/vault/Projects' })).structuredContent.hidden_by_permissions).toBeUndefined();
    expect((await call('file_search', { session_token: all, query: 'launch', path_prefix: '/vault/Projects' })).structuredContent.hidden_by_permissions).toBeUndefined();
  });
  it('hidden folders, traversal and bad paths are refused', async () => {
    const s = newSession(rulesFor('**'));
    const { call, login } = await connect();
    const t = (await login(s.secret)).token;
    expect((await call('file_read', { session_token: t, path: '/vault/.obsidian/app.json' })).structuredContent.error).toBe('denied');
    expect((await call('file_read', { session_token: t, path: '/vault/../secrets' })).structuredContent.error).toBe('invalid_path');
    expect((await call('file_read', { session_token: t, path: 'C:\\Windows\\win.ini' })).structuredContent.error).toBe('invalid_path');
    expect((await call('file_search', { session_token: t, query: 'launch' })).structuredContent.hits.map((h: any) => h.path)).not.toContain('/vault/.obsidian/app.json');
  });
  it('a key without tool.invoke cannot use file tools but can use base tools', async () => {
    const s = newSession([{ effect: 'allow', actions: ['fs.read'], resource: 'path:/vault/**' }]);
    const { call, login } = await connect();
    const t = (await login(s.secret)).token;
    expect((await call('file_read', { session_token: t, path: '/vault/Public/readme.md' })).structuredContent.error).toBe('denied');
    expect((await call('access_list', { session_token: t })).isError).toBeFalsy();
    expect((await call('access_check', { session_token: t, action: 'fs.read', resource: '/vault/Public/readme.md' })).structuredContent.allowed).toBe(true);
    expect((await call('session_whoami', { session_token: t })).structuredContent.key).toMatch(/^ah_ses_[a-z2-7]{12}_…$/);
  });
  it('the app key cap restricts what any session key can do', async () => {
    const capped = newAppKey();
    app.keys.setRules(capped.credential.policy_id, [
      { effect: 'allow', actions: ['tool.invoke'], resource: 'tool:file_read' }, { effect: 'allow', actions: ['fs.read'], resource: 'path:/vault/Public/**' }], 'cap', sys);
    const s = newSession(rulesFor('**'));
    const { call, login } = await connect(capped.secret);
    const t = (await login(s.secret)).token;
    expect((await call('file_read', { session_token: t, path: '/vault/Public/readme.md' })).isError).toBeFalsy();
    expect((await call('file_read', { session_token: t, path: '/vault/Private/diary.md' })).structuredContent.error).toBe('denied');
    expect((await call('file_list', { session_token: t, path: '/vault' })).structuredContent.error).toBe('denied');
    const other = await connect();
    const t2 = (await other.login(s.secret)).token;
    expect((await other.call('file_read', { session_token: t2, path: '/vault/Private/diary.md' })).isError).toBeFalsy();
  });
});

describe('key lifecycle', () => {
  it('suspend makes the next call key_inactive; reactivate needs a new login', async () => {
    const s = newSession(rulesFor('**'));
    const { call, login } = await connect();
    const t = (await login(s.secret)).token;
    app.keys.setStatus(s.credential.id, 'suspended', 'test', sys);
    expect((await call('file_list', { session_token: t, path: '/vault' })).structuredContent.error).toBe('key_inactive');
    expect((await call('session_login', { session_key: s.secret })).structuredContent.error).toBe('key_inactive');
    app.keys.setStatus(s.credential.id, 'active', null, sys);
    expect((await login(s.secret)).token).toBeTruthy();
  });
  it('rotate: old token key_rotated, old key refused, new key logs in with the same rules', async () => {
    const s = newSession(rulesFor('Public/**'));
    const { call, login } = await connect();
    const t = (await login(s.secret)).token;
    const rot = app.keys.rotate(s.credential.id, sys);
    expect((await call('file_list', { session_token: t, path: '/vault/Public' })).structuredContent.error).toBe('key_rotated');
    expect((await call('session_login', { session_key: s.secret })).structuredContent.error).toBe('key_rotated');
    const t2 = (await login(rot.secret)).token;
    expect((await call('file_read', { session_token: t2, path: '/vault/Public/readme.md' })).isError).toBeFalsy();
    expect((await call('file_read', { session_token: t2, path: '/vault/Private/diary.md' })).structuredContent.error).toBe('denied');
  });
  it('end-logins: login_required, then logging in again works', async () => {
    const s = newSession(rulesFor('**'));
    const { call, login } = await connect();
    const t = (await login(s.secret)).token;
    app.keys.endLogins(s.credential.id, sys);
    expect((await call('file_list', { session_token: t, path: '/vault' })).structuredContent.error).toBe('login_required');
    const t2 = (await login(s.secret)).token;
    expect((await call('file_list', { session_token: t2, path: '/vault' })).isError).toBeFalsy();
  });
  it('logout ends the token; expiry makes the key unusable', async () => {
    const s = newSession(rulesFor('**'));
    const { call, login } = await connect();
    const t = (await login(s.secret)).token;
    await call('session_logout', { session_token: t });
    expect((await call('session_whoami', { session_token: t })).structuredContent.error).toBe('login_required');
    app.keys.setExpiry(s.credential.id, Date.now() - 1000, sys);
    expect((await call('session_login', { session_key: s.secret })).structuredContent.error).toBe('key_inactive');
  });
  // The three tests below log in through app keys of their own and close their clients, so the shared appKey's
  // live-session budget (max_live_sessions) is left as it was for the tests after them.
  const closeAll = async (...cs: { c: Client }[]) => { for (const x of cs) await x.c.close().catch(() => undefined); };
  // FR-KEYS-02/AC1 (tokens are app-bound). A token bound to app key A is unknown through app key B: the agent logs in again there.
  it('FR-KEYS-02/AC1: a login cannot be used through another app key', async () => {
    const s = newSession(rulesFor('**'));
    const A = await connect(newAppKey('first-app').secret), B = await connect(newAppKey('second-app').secret);
    try {
      const t = (await A.login(s.secret)).token;
      const via = await B.call('file_list', { session_token: t, path: '/vault' });
      expect(via.isError).toBe(true);
      expect(via.structuredContent.error).toBe('login_required');
      expect(via.content[0]!.text).toMatch(/session_login/);
      // The login through A is untouched, and logging in through B gives a token of its own.
      expect((await A.call('file_list', { session_token: t, path: '/vault' })).isError).toBeFalsy();
      const t2 = (await B.login(s.secret)).token;
      expect(t2).toBeTruthy();
      expect(t2).not.toBe(t);
      expect((await B.call('file_list', { session_token: t2, path: '/vault' })).isError).toBeFalsy();
      expect((await A.call('file_list', { session_token: t2, path: '/vault' })).structuredContent.error).toBe('login_required');
    } finally { await closeAll(A, B); }
  });
  // FR-KEYS-02/AC1 (tokens follow key state). App and session keys are revoked independently.
  it('FR-KEYS-02/AC1: revoking an app key ends every login through it', async () => {
    const one = newSession(rulesFor('**')), two = newSession(rulesFor('**'));
    const shared = newAppKey('shared-app'), other = newAppKey('other-app');
    const S = await connect(shared.secret), O = await connect(other.secret);
    try {
      const t1 = (await S.login(one.secret)).token, t2 = (await S.login(two.secret)).token;
      expect(app.keys.liveLogins({ credentialId: shared.credential.id })).toHaveLength(2);
      app.keys.setStatus(shared.credential.id, 'revoked', 'test', sys);
      // Both logins stop: the hub ended them, and the revoked app key no longer opens a connection.
      expect(app.keys.liveLogins({ credentialId: shared.credential.id })).toHaveLength(0);
      for (const t of [t1, t2]) await expect(S.call('session_whoami', { session_token: t })).rejects.toThrow();
      await expect(connect(shared.secret)).rejects.toThrow();
      const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${shared.secret}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' });
      expect(r.status).toBe(401);
      // Each session key is still active and works through another app key.
      for (const s of [one, two]) {
        expect(app.keys.credential(s.credential.id)!.status).toBe('active');
        const t = (await O.login(s.secret)).token;
        expect(t).toBeTruthy();
        expect((await O.call('file_list', { session_token: t, path: '/vault' })).isError).toBeFalsy();
      }
    } finally { await closeAll(S, O); }
  });
  // NFR-REL-01 (bounded requests). The hub refuses a request body above 2 MB; another agent's calls go on.
  it('NFR-REL-01: an oversized request is refused cleanly', async () => {
    const big = newSession(rulesFor('**')), other = newSession(rulesFor('Public/**'));
    const own = newAppKey('big-request-app');
    const A = await connect(own.secret), B = await connect(own.secret);
    try {
      const t = (await A.login(big.secret)).token, tb = (await B.login(other.secret)).token;
      const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'file_search', arguments: { session_token: t, query: 'x'.repeat(2 * 1024 * 1024 + 10) } } });
      const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${own.secret}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body });
      expect(r.status).toBe(413);
      expect(JSON.stringify(await r.json().catch(() => ({})))).toMatch(/too large|Request body is too large/i);
      expect((await B.call('file_read', { session_token: tb, path: '/vault/Public/readme.md' })).isError).toBeFalsy();
      expect((await A.call('session_whoami', { session_token: t })).isError).toBeFalsy();
    } finally { await closeAll(A, B); }
  });
  it('a second login of the same key raises a concurrent_use alert', async () => {
    const s = newSession(rulesFor('**'));
    const one = await connect(), two = await connect();
    await one.login(s.secret); await two.login(s.secret);
    const row = app.db.prepare("SELECT COUNT(*) n FROM security_alerts WHERE type='concurrent_use' AND subject=?").get(s.credential.id) as { n: number };
    expect(row.n).toBe(1);
  });
});

describe('leak guard', () => {
  it('a key in an argument is rejected, suspends the key, alerts, and leaves no secret in the audit log', async () => {
    const s = newSession(rulesFor('**'));
    const victim = newSession(rulesFor('**'));
    const { call, login } = await connect();
    const t = (await login(s.secret)).token;
    const spaced = victim.secret.replace(/_/g, ' _ ');
    const r = await call('file_search', { session_token: t, query: `find ${spaced}` });
    expect(r.structuredContent.error).toBe('contains_key');
    expect(app.keys.credential(s.credential.id)!.status).toBe('suspended');
    expect((await call('file_list', { session_token: t, path: '/vault' })).structuredContent.error).toBe('key_inactive');
    const alert = app.db.prepare("SELECT * FROM security_alerts WHERE type='key_in_payload' AND subject=?").get(s.credential.id) as { severity: string } | undefined;
    expect(alert?.severity).toBe('critical');
    const inv = app.db.prepare("SELECT args_summary, result, error_code FROM tool_invocations WHERE credential_id=? AND result='incident'").get(s.credential.id) as { args_summary: string; result: string };
    expect(inv.args_summary).not.toContain(victim.secret.split('_')[3]);
    const dump = JSON.stringify(app.db.prepare('SELECT * FROM tool_invocations').all()) + JSON.stringify(app.db.prepare('SELECT * FROM audit_events').all());
    for (const secret of [s.secret, victim.secret, t]) expect(dump).not.toContain(secret.split('_').pop());
  });
  it('normal text with key-like documentation does not trip the guard', async () => {
    const s = newSession(rulesFor('**'));
    const { call, login } = await connect();
    const t = (await login(s.secret)).token;
    expect((await call('file_search', { session_token: t, query: 'session keys start with ah_ses_' })).isError).toBeFalsy();
  });
});

describe('notices', () => {
  it('a permission change shows up once and session_ack clears it', async () => {
    const s = newSession(rulesFor('Public/**'));
    const { call, login } = await connect();
    const t = (await login(s.secret)).token;
    expect((await call('access_list', { session_token: t })).structuredContent.notices).toBeUndefined();
    app.keys.setRules(s.credential.policy_id, rulesFor('Public/**', 'Private/**'), 'widen', sys);
    const r = await call('access_list', { session_token: t });
    expect(r.structuredContent.notices).toHaveLength(1);
    expect(r.structuredContent.notices[0].kind).toBe('permissions_changed');
    expect(r.structuredContent.grants.map((g: any) => g.resource)).toContain('path:/vault/Private/**');
    const again = await call('access_list', { session_token: t });
    // Shown once: the next answer only counts it until session_ack.
    expect(again.structuredContent.notices).toBeUndefined();
    expect(again.structuredContent.notices_pending).toBe(1);
    const ack = await call('session_ack', { session_token: t, notice_seq: r.structuredContent.notices[0].seq });
    expect(ack.structuredContent.notices).toBeUndefined();
    expect((await call('access_list', { session_token: t })).structuredContent.notices).toBeUndefined();
  });
  it('an admin-set role stays in force; the agent note is kept', async () => {
    const s = newSession(rulesFor('**'));
    app.keys.updateAgent(s.agent.id, { role: 'Reviewer' }, sys);
    const { call, login } = await connect();
    const t = (await login(s.secret)).token;
    const r = await call('session_describe', { session_token: t, role: 'Coder', status_text: 'working' });
    expect(r.structuredContent.role).toBe('Reviewer');
    expect(r.structuredContent.role_note).toBe('Coder');
  });
});

describe('outbound credential protection', () => {
  it('withholds external keys, encoded keys and partial reads without suspending the reader', async () => {
    const writer = newSession(rulesFor('**'), 'credential-owner');
    const reader = newSession(rulesFor('Public/**'), 'innocent-reader');
    const { c, call, login } = await connect();
    try {
      const token = (await login(reader.secret)).token;
      const external = join(app.config.vaultDir, 'Public', 'external-key.md');
      for (const content of [writer.secret, Buffer.from(writer.secret).toString('base64')]) {
        writeFileSync(external, `external marker ${content}`);
        for (const args of [{}, { offset: 30, length: 5 }]) {
          const result = await call('file_read', { session_token: token, path: '/vault/Public/external-key.md', ...args });
          expect(result.structuredContent.error).toBe('content_withheld');
          expect(JSON.stringify(result)).not.toContain(writer.secret);
        }
        const search = await call('file_search', { session_token: token, query: 'external marker' });
        expect(search.structuredContent.hits).toEqual([]);
      }
      expect(app.keys.credential(reader.credential.id)!.status).toBe('active');
      expect((await call('file_read', { session_token: token, path: '/vault/Public/readme.md' })).isError).toBeFalsy();
      expect((await call('session_whoami', { session_token: token })).structuredContent.key).toContain('…');
      const alerts = app.db.prepare("SELECT details FROM security_alerts WHERE type='key_in_result'").all();
      expect(alerts.length).toBeGreaterThan(0);
      expect(JSON.stringify(alerts)).not.toContain(writer.secret);
      // Keep the shared fixture harmless for later search tests.
      writeFileSync(external, 'external marker: no credential');
    } finally { await c.close(); }
  });

  it('scans notices and login metadata even when the intentional login token is exempt', async () => {
    const owner = newSession(rulesFor('**'), 'other-owner');
    const reader = newSession(rulesFor('Public/**'), 'notice-reader');
    const { c, call, login } = await connect();
    try {
      const token = (await login(reader.secret)).token;
      app.keys.notify(reader.agent.id, 'external_fixture', `Unexpected credential ${owner.secret.split('').join('\n')}`);
      // The notice is redacted on its own; the call itself still answers, so one bad notice cannot lock the agent out.
      const result = await call('session_whoami', { session_token: token });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent.notices.find((n: any) => n.kind === 'external_fixture').body).toMatch(/^\[withheld/);
      expect(JSON.stringify(result)).not.toContain(owner.secret);
      expect(JSON.stringify(result)).not.toContain(owner.secret.split('_').pop()!.split('').join('\\n'));
      app.keys.updateAgent(reader.agent.id, { role: `External metadata ${owner.secret}` }, sys);
      const live = () => (app.db.prepare('SELECT COUNT(*) n FROM session_tokens WHERE session_credential_id=? AND revoked_at IS NULL').get(reader.credential.id) as { n: number }).n;
      const before = live();
      const again = await login(reader.secret);
      expect(again.r.structuredContent.error).toBe('content_withheld');
      expect(JSON.stringify(again.r)).not.toContain(owner.secret);
      expect(live()).toBe(before); // the token minted for the withheld login was ended, not left using up a login slot
      expect(app.keys.credential(reader.credential.id)!.status).toBe('active');
    } finally { await c.close(); }
  });
});

describe('admin API', () => {
  let cookie = '', csrf = '';
  const req = (method: string, path: string, body?: unknown, opts: { csrf?: boolean; cookie?: boolean } = {}) =>
    fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', ...(opts.cookie === false ? {} : { cookie }), ...(opts.csrf === false ? {} : { 'x-csrf-token': csrf }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = async (method: string, path: string, body?: unknown) => { const r = await req(method, path, body); return { status: r.status, body: (await r.json()) as any }; };

  it('requires sign-in, rejects wrong passwords', async () => {
    expect((await req('GET', '/keys', undefined, { cookie: false })).status).toBe(401);
    expect((await req('POST', '/login', { username: 'admin', password: 'wrong' }, { cookie: false, csrf: false })).status).toBe(401);
    const r = await req('POST', '/login', { username: 'admin', password: 'correct horse battery' }, { cookie: false, csrf: false });
    expect(r.status).toBe(200);
    const set = r.headers.get('set-cookie')!;
    expect(set).toMatch(/HttpOnly/i);
    cookie = set.split(';')[0]!;
    csrf = ((await r.json()) as { csrf: string }).csrf;
    expect((await json('GET', '/me')).body.username).toBe('admin');
  });
  it('mutating calls need the CSRF header', async () => {
    const r = await req('POST', '/pcs', { name: 'nocsrf' }, { csrf: false });
    expect(r.status).toBe(403);
    expect((await json('POST', '/pcs', { name: 'csrf-ok' })).status).toBe(200);
  });
  let sessionKeyId = '', secret = '', appId = '';
  it('creates keys, shows the secret once, masks it afterwards', async () => {
    const pc = (await json('POST', '/pcs', { name: 'laptop-1' })).body.pc;
    const ak = (await json('POST', '/keys', { kind: 'app_key', machine_id: pc.id, app_name: 'claude-code' })).body;
    expect(ak.setup.claude_code).toContain('claude mcp add --transport http agent-hub http://hub.test/mcp --header "Authorization: Bearer ah_app_');
    expect(ak.setup.codex_config_toml).toContain('bearer_token_env_var = "AGENT_HUB_APP_KEY"');
    appId = ak.key.id;
    const tpl = (await json('GET', '/templates')).body.templates.find((t: any) => t.name === 'Reader');
    expect(tpl).toBeTruthy();
    const sk = (await json('POST', '/keys', { kind: 'session_key', new_agent: { label: 'Writer-1', project: 'Alpha' }, label: 'ses', template_id: tpl.id })).body;
    secret = sk.secret; sessionKeyId = sk.key.id;
    expect(sk.handoff).toContain(`Key: ${sk.secret}`);
    expect(sk.prompt.mode).toBe('secret');
    expect(secret).toMatch(/^ah_ses_/);
    const got = JSON.stringify((await json('GET', `/keys/${sessionKeyId}`)).body) + JSON.stringify((await json('GET', '/keys')).body);
    expect(got).not.toContain(secret.split('_')[3]);
    expect(got).not.toContain('verifier');
    expect((await json('GET', '/keys')).body.keys.find((k: any) => k.id === sessionKeyId).masked_key).toBe(`ah_ses_${sk.key.key_id}_…`);
    expect((await json('POST', '/keys', { kind: 'session_key', label: 'x' })).status).toBe(400);
    (globalThis as any).__appSecret = ak.secret;
  });
  it('rules edit with versions, rollback, and the simulator agrees with a real call', async () => {
    const v1 = (await json('GET', `/keys/${sessionKeyId}/rules`)).body;
    expect(v1.rules.length).toBeGreaterThan(0);
    const put = await json('PUT', `/keys/${sessionKeyId}/rules`, { rules: [...v1.rules, { effect: 'deny', actions: ['fs.read'], resource: 'path:/vault/Private/**', note: 'no diary' }], note: 'deny private' });
    expect(put.status).toBe(200);
    expect((await json('PUT', `/keys/${sessionKeyId}/rules`, { rules: [{ effect: 'allow', actions: ['x y'], resource: 'bad' }] })).status).toBe(400);
    const { call, login } = await connect((globalThis as any).__appSecret);
    const t = (await login(secret)).token;
    for (const path of ['/vault/Private/diary.md', '/vault/Public/readme.md', '/vault/Projects/Alpha/plan.md']) {
      const sim = (await json('POST', '/simulate', { credential_id: sessionKeyId, app_credential_id: appId, action: 'fs.read', resource: path })).body.decision;
      const real = await call('file_read', { session_token: t, path });
      expect(!real.isError).toBe(sim.allowed);
    }
    const eff = (await json('GET', `/keys/${sessionKeyId}/effective?app_key_id=${appId}`)).body;
    expect(eff.tools.find((x: any) => x.tool === 'file_read').allowed).toBe(true);
    expect(eff.folders.find((f: any) => f.path === '/vault/Public').read).toBe(true);
    expect(eff.folders.find((f: any) => f.path === '/vault/Private').read).toBe(false);
    const vers = (await json('GET', `/keys/${sessionKeyId}/versions`)).body.versions;
    const rb = await json('POST', `/keys/${sessionKeyId}/rollback`, { version: vers[vers.length - 1].version });
    expect(rb.status).toBe(200);
    const notice = await call('access_list', { session_token: t });
    expect(notice.structuredContent.notices.length).toBeGreaterThan(0);
  });
  it('suspend/reactivate/rotate through the API; agent role change; audit lists', async () => {
    const sp = await json('POST', `/keys/${sessionKeyId}/suspend`);
    expect(sp.body.key.effective_status).toBe('suspended');
    expect((await json('POST', `/keys/${sessionKeyId}/reactivate`)).body.key.effective_status).toBe('active');
    const rot = (await json('POST', `/keys/${sessionKeyId}/rotate`)).body;
    expect(rot.secret).not.toBe(secret);
    const agent = (await json('GET', '/agents')).body.agents.find((a: any) => a.label === 'Writer-1');
    expect((await json('PATCH', `/agents/${agent.id}`, { role: 'Reviewer' })).body.agent.role).toBe('Reviewer');
    expect((await json('GET', '/audit')).body.events.length).toBeGreaterThan(5);
    expect((await json('GET', '/invocations')).body.invocations.length).toBeGreaterThan(0);
    expect(Array.isArray((await json('GET', '/alerts')).body.alerts)).toBe(true);
  });
  it('TOTP: enrol, then sign-in needs the code', async () => {
    const en = (await json('POST', '/totp/enroll')).body;
    expect(en.otpauth_uri).toContain('otpauth://totp/');
    expect((await json('POST', '/totp/confirm', { code: '000000' })).status).toBe(400);
    const at = Date.now();
    expect((await json('POST', '/totp/confirm', { code: totp(en.secret, at) })).status).toBe(200);
    const r1 = await req('POST', '/login', { username: 'admin', password: 'correct horse battery' }, { cookie: false, csrf: false });
    expect(r1.status).toBe(401); expect(((await r1.json()) as any).error).toBe('mfa_required');
    // The code that confirmed enrolment is spent; the next one signs in.
    const spent = await req('POST', '/login', { username: 'admin', password: 'correct horse battery', totp: totp(en.secret, at) }, { cookie: false, csrf: false });
    expect(((await spent.json()) as any).error).toBe('mfa_failed');
    const r2 = await req('POST', '/login', { username: 'admin', password: 'correct horse battery', totp: totp(en.secret, at, 1) }, { cookie: false, csrf: false });
    expect(r2.status).toBe(200);
  });
});

describe('basics', () => {
  it('serves /health and the console', async () => {
    expect(((await (await fetch(`${base}/health`)).json()) as any).ok).toBe(true);
    const r = await fetch(`${base}/`);
    expect(r.status).toBe(200); expect(await r.text()).toContain('Conclave');
  });
  it('seeds the built-in templates once', () => {
    expect(app.keys.templates().map((t) => t.name)).toEqual(expect.arrayContaining(['Reader', 'Writer', 'Reviewer', 'Coordinator']));
    expect(void appCredId).toBeUndefined();
  });
});

describe('phase 1 additions', () => {
  const H = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  it('MCP rejects browser Origins not in ALLOWED_ORIGINS with 403; no Origin is fine', async () => {
    const auth = { Authorization: `Bearer ${appKey}` };
    expect((await fetch(`${base}/mcp`, { method: 'POST', headers: { ...H, ...auth, Origin: 'http://evil.test' }, body: '{}' })).status).toBe(403);
    expect((await fetch(`${base}/mcp`, { method: 'POST', headers: { ...H, Origin: 'http://evil.test' }, body: '{}' })).status).toBe(403);
    expect((await fetch(`${base}/mcp`, { method: 'POST', headers: { ...H, ...auth, Origin: 'http://ok.test' }, body: '{}' })).status).not.toBe(403);
    expect((await fetch(`${base}/mcp`, { method: 'POST', headers: { ...H, ...auth }, body: '{}' })).status).not.toBe(403);
  });
  it('file_list returns revision (<=1 MB) and file_stat returns linked_from', async () => {
    const s = newSession(rulesFor('Public/**')), { call, login } = await connect();
    const t = (await login(s.secret)).token;
    const e = (await call('file_list', { session_token: t, path: '/vault/Public' })).structuredContent.entries as any[];
    expect(e.find((x) => x.name === 'readme.md').revision).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(e.find((x) => x.name === 'huge.md').revision).toBeNull();
    const st = (await call('file_stat', { session_token: t, path: '/vault/Public/readme.md' })).structuredContent;
    expect(st.linked_from).toEqual(['/vault/Public/idea.md']);
    const none = newSession(rulesFor('Projects/Alpha/**'));
    const t2 = (await login(none.secret)).token;
    expect((await call('file_stat', { session_token: t2, path: '/vault/Projects/Alpha/plan.md' })).structuredContent.linked_from).toEqual([]);
  });
  it('file_read returns at most 90 000 bytes per call and pages with offset', async () => {
    const s = newSession(rulesFor('Public/**')), { call, login } = await connect();
    const t = (await login(s.secret)).token;
    const big = (await call('file_read', { session_token: t, path: '/vault/Public/huge.md', length: 500_000 })).structuredContent;
    expect(big.content.length).toBe(90_000);
    expect(big.truncated).toBe(true);
    const p2 = (await call('file_read', { session_token: t, path: '/vault/Public/huge.md', offset: 90_000, length: 500_000 })).structuredContent;
    expect(p2.content.length).toBe(90_000);
  });
});
