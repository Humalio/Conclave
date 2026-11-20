/**
 * Key prompts (docs/onboarding.md#key-prompts-a-new-rotated-or-reissued-session-key): a new, rotated or reissued session key
 * for a known PC travels by a single-use pickup code that only an app key of that PC redeems (POST /onboard/key-pickup), and
 * the hub stores no secret until then; a free key with no PC shows its raw key with the chat warning. Make a new prompt is
 * Rotate secret on a key that never logged in: the old secret and code stop, the binding and the variable stay, audited as
 * key.rotate. The prompt names the variable, the PC and the client step from what the hub knows, never session_login with a
 * pickup, and ends with the key's tool groups. Migration 0138 adds the column and the table without touching existing rows.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from '../src/db/db.js';
import { buildApp, type App } from '../src/app.js';
import { sha256Hex } from '../src/util/crypto.js';
import { toolsLine, clientOf } from '../src/keys/keyPrompt.js';
import { testConfig, adminLogin } from './hub.js';

vi.spyOn(console, 'warn').mockImplementation(() => {});
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'db', 'migrations');
const sys = { kind: 'system' as const, id: null };
let app: App, base = '', cookie = '', csrf = '';
const SETUP = 'export const setup = 1;\n';

const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
let ipSeq = 1;
const freshIp = () => `10.7.${Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}`;
const ob = async (method: string, path: string, o: { key?: string; body?: unknown; from?: string } = {}) => {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (o.key) headers.authorization = `Bearer ${o.key}`;
  headers['x-forwarded-for'] = o.from ?? freshIp(); headers['x-forwarded-proto'] = 'https';
  const r = await fetch(`${base}/onboard${path}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const pickup = (key: string, code: string, from?: string) => ob('POST', '/key-pickup', { key, body: { code }, from });
const audits = (action: string, id?: string) => (app.db.prepare(`SELECT actor_kind, target_id, details FROM audit_events WHERE action=?${id ? ' AND target_id=?' : ''} ORDER BY id`).all(...(id ? [action, id] : [action])) as { actor_kind: string; target_id: string; details: string }[]);
const codeOf = (text: string) => /cnv_key_[a-z2-7]{26}/.exec(text)?.[0] ?? '';
/** A PC with an active app key: its id, name and the app key's secret. */
const pcWithKey = async (name: string) => {
  const pc = (await api('POST', '/pcs', { name })).body.pc;
  return { id: pc.id as string, name, app: app.keys.createAppKey({ machineId: pc.id, appName: 'claude-code' }, sys).secret };
};
const newKey = async (label: string, machineId: string | null) => {
  const r = await api('POST', '/keys', { kind: 'session_key', new_agent: { label }, label: `${label} key`, machine_id: machineId });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
};

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'keyprompt-'));
  mkdirSync(join(dir, 'vault', 'Notes'), { recursive: true });
  const client = join(dir, 'client');
  mkdirSync(client);
  writeFileSync(join(client, 'agent-hub-headers.mjs'), 'export const helper = 1;\n');
  writeFileSync(join(client, 'setup.mjs'), SETUP);
  writeFileSync(join(client, 'onboarding-prompt.md'), 'Hub {{HUB_URL}} code {{ENROL_CODE}} pc {{PC_NAME}}\n');
  app = await buildApp(testConfig(dir, { publicUrl: 'https://hub.test', clientDir: client }));
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  ({ cookie, csrf } = await adminLogin(base));
});
afterAll(async () => { await app.close(); });

describe('migration 0138', () => {
  it('adds session_var and key_pickups and keeps every existing key as it was', () => {
    const before = mkdtempSync(join(tmpdir(), 'kp-0138-'));
    for (const f of readdirSync(MIGRATIONS)) if (/^\d{4}_.+\.sql$/.test(f) && Number(f.slice(0, 4)) < 138) copyFileSync(join(MIGRATIONS, f), join(before, f));
    const db = new DatabaseSync(join(before, 'x.db'));
    db.exec('PRAGMA foreign_keys=ON');
    migrate(db, before);
    const now = Date.now();
    db.prepare("INSERT INTO agents(id,label,created_at) VALUES ('agent-a','A',?)").run(now);
    db.prepare("INSERT INTO permission_policies(id,kind,version,created_at,updated_at) VALUES ('pol_1','credential',1,?,?)").run(now, now);
    db.prepare("INSERT INTO credentials(id,kind,agent_id,label,key_id,verifier,policy_id,created_at) VALUES ('crd_1','session_key','agent-a','k','kid1','v1','pol_1',?)").run(now);
    const row = () => db.prepare("SELECT id,kind,agent_id,label,key_id,verifier,policy_id,status FROM credentials WHERE id='crd_1'").get();
    const was = row();
    migrate(db, MIGRATIONS);
    expect(row()).toEqual(was);
    expect(db.prepare("SELECT session_var FROM credentials WHERE id='crd_1'").get()).toEqual({ session_var: null });
    expect(db.prepare('SELECT COUNT(*) c FROM key_pickups').get()).toEqual({ c: 0 });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    db.close();
  });
});

describe('a new key for a known PC travels by pickup', () => {
  it('the prompt names the PC and the variable, holds a code and no key, never mentions session_login, and warns about chats', async () => {
    const pc = await pcWithKey('office-pc');
    const r = await newKey('Rowan', pc.id);
    expect(r.secret).toBeUndefined();
    expect(r.prompt.mode).toBe('pickup');
    expect(r.prompt.pc).toBe('office-pc');
    expect(r.prompt.session_var).toBe('ROWAN_SESSION_KEY');
    const t: string = r.prompt.text;
    expect(t).not.toMatch(/ah_ses_/);
    expect(t).not.toContain('session_login');
    expect(t).toContain('keeps the key in its own key file, for the agent\'s entry ROWAN_SESSION_KEY');
    expect(t).toContain('docs/connector.md');
    expect(t).toContain('conclave check');
    for (const old of ['keys.env', '.agent-hub.json', 'agent-hub-headers', 'headers helper', 'setup.mjs', 'codex-bridge', 'helper.log', 'session_var']) expect(t, old).not.toContain(old);
    expect(t).toContain('into a chat with a person or another agent');
    expect(t).toMatch(/\nThis key may use .+ tools\./);
    expect(codeOf(t)).toMatch(/^cnv_key_/);
    expect(r.handoff).toBe(t);
    // Until pickup the key has no usable secret, and the hub stores only the code's hash.
    const row = app.db.prepare('SELECT verifier, session_var FROM credentials WHERE id=?').get(r.key.id) as { verifier: string; session_var: string };
    expect(row).toEqual({ verifier: '', session_var: 'ROWAN_SESSION_KEY' });
    expect(JSON.stringify(app.db.prepare('SELECT * FROM key_pickups').all())).not.toContain(codeOf(t));
    expect(audits('key.pickup_armed', r.key.id)).toHaveLength(1);
    expect(audits('key.create', r.key.id)).toHaveLength(1);
  });

  it('only an app key of that PC redeems the code, once; the key then works and the audit holds neither code nor key', async () => {
    const pc = await pcWithKey('pickup-pc'), other = await pcWithKey('other-pc');
    const r = await newKey('Pick One', pc.id), code = codeOf(r.prompt.text);
    const wrong = await pickup(other.app, code);
    expect(wrong.status).toBe(404);
    expect(audits('key.pickup_refused').at(-1)!.details).toContain('not_found');
    expect((await pickup(pc.app, 'cnv_key_aaaaaaaaaaaaaaaaaaaaaaaaaa')).status).toBe(404);
    const ok = await pickup(pc.app, code);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ session_var: 'PICK_ONE_SESSION_KEY', label: 'Pick One key', pc: 'pickup-pc' });
    expect(app.keys.verifyKey(ok.body.secret, 'session_key').id).toBe(r.key.id);
    const again = await pickup(pc.app, code);
    expect(again.status).toBe(409);
    expect(again.body.message).toContain('already used');
    const done = audits('key.pickup', r.key.id);
    expect(done).toHaveLength(1);
    const all = JSON.stringify(app.db.prepare('SELECT * FROM audit_events').all());
    expect(all).not.toContain(code);
    expect(all).not.toContain(ok.body.secret.split('_')[3]);
  });

  it('a bad app key, a missing code and an expired code are refused; ten refusals from one address are rate limited', async () => {
    const pc = await pcWithKey('expiry-pc');
    const r = await newKey('Late', pc.id), code = codeOf(r.prompt.text);
    expect((await pickup('ah_app_aaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', code)).status).toBe(401);
    expect((await ob('POST', '/key-pickup', { key: pc.app, body: {} })).status).toBe(400);
    app.db.prepare('UPDATE key_pickups SET expires_at=? WHERE credential_id=?').run(Date.now() - 1, r.key.id);
    const late = await pickup(pc.app, code);
    expect(late.status).toBe(409);
    expect(late.body.message).toContain('expired');
    const from = freshIp();
    for (let i = 0; i < 10; i++) expect((await pickup(pc.app, 'cnv_key_aaaaaaaaaaaaaaaaaaaaaaaaaa', from)).status).toBe(404);
    expect((await pickup(pc.app, code, from)).status).toBe(429);
  });

  it('a PC with no active app key still gets a pickup, with a note on what to fix; a retired PC falls back to the raw key', async () => {
    const pc = (await api('POST', '/pcs', { name: 'no-app-key-pc' })).body.pc;
    const r = await newKey('Keyless', pc.id);
    expect(r.secret).toBeUndefined();
    expect(r.prompt.mode).toBe('pickup');
    expect(r.prompt.note).toContain('no active app key');
    // The operator issues an app key afterwards, and the same code works.
    const appKey = app.keys.createAppKey({ machineId: pc.id, appName: 'claude-code' }, sys).secret;
    expect((await pickup(appKey, codeOf(r.prompt.text))).status).toBe(200);
    app.keys.setMachineStatus(pc.id, 'suspended', sys);
    const s2 = await api('POST', `/keys/${r.key.id}/rotate`);
    expect(s2.body.prompt).toMatchObject({ mode: 'pickup', pc: 'no-app-key-pc' });
    expect(s2.body.prompt.note).toContain('suspended');
    app.db.prepare("UPDATE machines SET status='retired' WHERE id=?").run(pc.id);
    const r3 = await api('POST', `/keys/${s2.body.key.id}/rotate`);
    expect(r3.body.prompt.mode).toBe('secret');
    expect(r3.body.secret).toMatch(/^ah_ses_/);
  });
});

describe('a free key with no PC', () => {
  it('shows the raw key once with the chat warning, and the key works', async () => {
    const r = await newKey('Free Agent', null);
    expect(r.prompt.mode).toBe('secret');
    expect(r.prompt.pc).toBeNull();
    expect(r.secret).toMatch(/^ah_ses_/);
    expect(r.prompt.text).toContain(`Key: ${r.secret}`);
    expect(r.prompt.text).toContain('into a chat with a person or another agent');
    expect(r.prompt.text).toMatch(/\nThis key may use .+ tools\./);
    expect(app.keys.verifyKey(r.secret, 'session_key').id).toBe(r.key.id);
    expect(audits('key.pickup_armed', r.key.id)).toHaveLength(0);
  });
});

describe('Make a new prompt and Rotate secret', () => {
  it('a never-used key gets a fresh prompt: the old secret and code stop, the binding and variable stay, audited as key.rotate', async () => {
    const pc = await pcWithKey('reissue-pc');
    const first = await newKey('Reissue', pc.id), oldCode = codeOf(first.prompt.text);
    const r = await api('POST', `/keys/${first.key.id}/rotate`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.prompt.mode).toBe('pickup');
    expect(r.body.prompt.text).toContain('Install a fresh Conclave session key');
    expect(r.body.key.bound_machine_id ?? r.body.key.bound_pc?.id).toBe(pc.id);
    expect(app.keys.credential(r.body.key.id)!.session_var).toBe('REISSUE_SESSION_KEY');
    expect(app.keys.credential(first.key.id)!.status).toBe('revoked');
    expect((await pickup(pc.app, oldCode)).status).toBe(409);
    const rot = audits('key.rotate', r.body.key.id);
    expect(rot).toHaveLength(1);
    expect(rot[0]!.actor_kind).toBe('admin');
    expect(JSON.parse(rot[0]!.details)).toEqual({ replaces: first.key.id, reason: null, delivery: 'prompt' });
    const ok = await pickup(pc.app, codeOf(r.body.prompt.text));
    expect(ok.status).toBe(200);
    expect(ok.body.session_var).toBe('REISSUE_SESSION_KEY');
  });

  it('a used free key is refused its old secret at once after rotation', async () => {
    const first = await newKey('Rotated Free', null);
    app.keys.verifyKey(first.secret, 'session_key'); // it logged in once
    const r = await api('POST', `/keys/${first.key.id}/rotate`);
    expect(r.body.prompt.text).toContain('The rotated Conclave session key');
    expect(() => app.keys.verifyKey(first.secret, 'session_key')).toThrow();
    expect(app.keys.verifyKey(r.body.secret, 'session_key').id).toBe(r.body.key.id);
  });

  it('revoking a key voids its open code', async () => {
    const pc = await pcWithKey('revoke-pc');
    const r = await newKey('Revoked', pc.id);
    expect((await api('POST', `/keys/${r.key.id}/revoke`)).status).toBe(200);
    const p = await pickup(pc.app, codeOf(r.prompt.text));
    expect(p.status).toBe(409);
    expect(p.body.message).toContain('replaced');
  });

  it('the variable stays unique on the PC: a second agent with the same name gets a numbered one', async () => {
    const pc = await pcWithKey('twins-pc');
    const a = await newKey('Twin', pc.id), b = await newKey('Twin', pc.id);
    expect([a.prompt.session_var, b.prompt.session_var]).toEqual(['TWIN_SESSION_KEY', 'TWIN_2_SESSION_KEY']);
  });
});

describe('the client step, from the onboarding request that made the key', () => {
  /** An enrolled PC, a filed and approved one-agent request with this client, and the picked-up key. */
  const onboarded = async (name: string, clientApp: string | undefined) => {
    const add = await api('POST', '/pcs/add', { name });
    const n = `n${Math.random().toString(36).slice(2)}xxxxxxxxxxxxxxxx`.slice(0, 22), from = freshIp();
    const e = await ob('POST', '/enrol', { body: { code: add.body.code, nonce: n }, from });
    expect(e.status, JSON.stringify(e.body)).toBe(200);
    await ob('POST', '/enrol/confirm', { body: { nonce: n }, from });
    const key = e.body.app_key as string;
    const f = await ob('POST', '/requests', { key, body: {
      kind: 'new_team', project: { name: `P ${name}`, existing: false }, team: { name: `T ${name}`, goal: 'Keep notes.' },
      roles: [{ name: 'coordinator', team_role: 'coordinator', count: 1, job: 'Plans.' }], prompt: 'a note team', ...(clientApp ? { client: { app: clientApp } } : {}) } });
    expect(f.status, JSON.stringify(f.body)).toBe(200);
    expect((await api('POST', `/onboarding/${f.body.request_id}/approve`, { version: f.body.version })).status).toBe(200);
    const p = await ob('POST', '/pickup', { key, body: { request_id: f.body.request_id } });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    const agent = p.body.agents[0];
    return { pc: add.body.pc.name as string, app: key, agent, cred: app.keys.verifyKey(agent.secret, 'session_key') };
  };

  it('a Codex agent is told to restart its bridge on the PC, with the slot variable and folder, and no session_login', async () => {
    const o = await onboarded('codex-pc', 'codex');
    const r = await api('POST', `/keys/${o.cred.id}/rotate`);
    expect(r.body.prompt.mode).toBe('pickup');
    expect(r.body.prompt.client).toBe('codex');
    expect(r.body.prompt.session_var).toBe(o.agent.session_var);
    const t: string = r.body.prompt.text;
    expect(t).toContain(`for the agent's entry ${o.agent.session_var}`);
    expect(t).toContain(`(${o.agent.folder})`);
    expect(t).toContain('restart the agent\'s client on codex-pc');
    for (const old of ['keys.env', '.agent-hub.json', 'agent-hub-headers', 'headers helper', 'setup.mjs', 'codex-bridge', 'helper.log', 'session_var']) expect(t, old).not.toContain(old);
    expect(t).not.toContain('session_login');
    expect(t).toContain('the rotated Conclave session key');
    const ok = await pickup(o.app, codeOf(t));
    expect(ok.body.session_var).toBe(o.agent.session_var);
  });

  it('a Claude Code agent is told its helper reads the key at the next login, and no bridge line', async () => {
    const o = await onboarded('claude-pc', 'claude-code');
    const t: string = (await api('POST', `/keys/${o.cred.id}/rotate`)).body.prompt.text;
    expect(t).toContain("restart the agent's client on claude-pc");
    expect(t).not.toMatch(/helper|bridge|agent-hub/);
    expect(t).not.toContain('session_login');
  });

  it('an unknown client gets both lines, and the hub keeps the variable through rotation', async () => {
    const o = await onboarded('unknown-pc', undefined);
    const r = await api('POST', `/keys/${o.cred.id}/rotate`);
    const t: string = r.body.prompt.text;
    expect(r.body.prompt.client).toBe('unknown');
    expect(t).toContain("restart the agent's client on unknown-pc");
    expect(t).not.toContain('session_login');
    expect(app.keys.credential(r.body.key.id)!.session_var).toBe(o.agent.session_var);
  });
});

describe('the tools line', () => {
  it('names the groups the key may use and the ones it may not', () => {
    expect(toolsLine([{ tool: 'file_read', allowed: true }, { tool: 'feedback_find', allowed: true }, { tool: 'task_list', allowed: false }, { tool: 'message_read', allowed: false }, { tool: 'team_info', allowed: false }]))
      .toBe('This key may use Files and Other tools. It may not use Messages, or Teams and tasks.');
    expect(toolsLine([{ tool: 'file_read', allowed: false }])).toBe('This key may use no tools. It may not use Files.');
  });
  it('a key without task tools says so in its prompt', async () => {
    const r = await newKey('No Tasks', null);
    const line = r.prompt.text.split('\n').at(-1);
    expect(line).toMatch(/^This key may use /);
    expect(line).toContain('It may not use');
    expect(line).toContain('Teams and tasks');
  });
  it('reads the client from the request text, and anything else is unknown', () => {
    expect([clientOf('codex'), clientOf('Codex CLI'), clientOf('claude-code'), clientOf('Claude Code'), clientOf('cursor'), clientOf(null)])
      .toEqual(['codex', 'codex', 'claude_code', 'claude_code', 'unknown', 'unknown']);
  });
});

describe('review fixes: where the key goes, the binding, long names, the tools line and lockdown', () => {
  it("a free key goes to the PC of its last login, with that login's client", async () => {
    const pc = await pcWithKey('last-login-pc');
    const cx = app.keys.createAppKey({ machineId: pc.id, appName: 'codex' }, sys).secret;
    const r = await api('POST', '/keys', { kind: 'session_key', new_agent: { label: 'Roamer' }, label: 'Roamer key', machine_id: null });
    expect(r.body.prompt.mode).toBe('secret');
    app.keys.login(app.keys.verifyKey(cx, 'app_key'), r.body.secret);
    const n = await api('POST', `/keys/${r.body.key.id}/rotate`);
    expect(n.body.prompt).toMatchObject({ mode: 'pickup', pc: 'last-login-pc', client: 'codex', session_var: 'ROAMER_SESSION_KEY' });
    expect(n.body.prompt.text).toContain("restart the agent's client on last-login-pc");
  });

  it("changing the binding voids an open code, and a bound key's code is refused once the key is bound elsewhere", async () => {
    const a = await pcWithKey('bind-a'), b = await pcWithKey('bind-b');
    const r = await newKey('Mover', a.id), code = codeOf(r.prompt.text);
    expect((await api('PUT', `/keys/${r.key.id}/binding`, { machine_id: b.id })).status).toBeLessThan(300);
    const voided = await pickup(a.app, code);
    expect(voided.status).toBe(409);
    expect(voided.body.message).toContain('replaced');
    // A code left open while the binding moved some other way is still refused at pickup.
    const r2 = await api('POST', `/keys/${r.key.id}/rotate`), code2 = codeOf(r2.body.prompt.text);
    expect(r2.body.prompt.pc).toBe('bind-b');
    app.db.prepare('UPDATE credentials SET bound_machine_id=? WHERE id=?').run(a.id, r2.body.key.id);
    const moved = await pickup(b.app, code2);
    expect(moved.status).toBe(409);
    expect(moved.body.message).toContain('bound to another PC');
  });

  it('a long agent name gets a variable setup.mjs accepts, and an invalid variable is never armed', async () => {
    const pc = await pcWithKey('long-name-pc');
    const r = await newKey('An Agent With A Very Long Name That Goes On And On Past Sixty Four Characters', pc.id);
    const v: string = r.prompt.session_var;
    expect(v).toMatch(/^[A-Z][A-Z0-9_]{0,63}$/);
    expect(v.endsWith('_SESSION_KEY')).toBe(true);
    const ok = await pickup(pc.app, codeOf(r.prompt.text));
    expect(ok.body.session_var).toBe(v);
    expect(() => app.keys.armPickup(r.key.id, pc.id, 'x'.repeat(70), sys)).toThrow(/session variable must be/);
  });

  it("the tools line follows the target PC's app key cap and deny rules, not team membership", async () => {
    const pc = (await api('POST', '/pcs', { name: 'capped-pc' })).body.pc;
    const capped = app.keys.createAppKey({ machineId: pc.id, appName: 'claude-code' }, sys);
    app.keys.setRules(capped.credential.policy_id, [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:file_*' }], 'test', sys);
    const r = await newKey('Capped', pc.id);
    const k = app.keys.credential(r.key.id)!;
    app.keys.setRules(k.policy_id, [{ effect: 'allow', actions: ['tool.invoke'], resource: 'tool:*' }, { effect: 'deny', actions: ['tool.invoke'], resource: 'tool:task_list' }], 'test', sys);
    const lead = app.keys.createAgent('Capped lead', null, sys);
    app.keys.createSessionKey({ agentId: lead.id, label: 'Capped lead' }, sys);
    app.teams.create({ name: 'Capped team', goal: 'g', members: [{ agent_id: lead.id, role: 'coordinator' }, { agent_id: k.agent_id!, role: 'worker', credential_id: k.id }] }, sys);
    const n = await api('POST', `/keys/${r.key.id}/rotate`);
    const line: string = n.body.prompt.text.split('\n').at(-1);
    expect(line).toMatch(/^This key may use Files/);
    expect(line).toContain('Messages');
    expect(line).toContain('Teams and tasks');
    expect(line.indexOf('Messages')).toBeGreaterThan(line.indexOf('may not'));
  });

  it('a lockdown of all writes, the PC or the agent refuses the pickup and leaves the code open', async () => {
    const pc = await pcWithKey('locked-pc');
    const r = await newKey('Locked', pc.id), code = codeOf(r.prompt.text);
    const agentId = app.keys.credential(r.key.id)!.agent_id!;
    for (const [kind, id] of [['writes', undefined], ['pc', pc.id], ['agent', agentId]] as const) {
      app.lockdown.set(kind, id, true, null);
      const res = await pickup(pc.app, code);
      expect(res.status, kind).toBe(423);
      app.lockdown.set(kind, id, false, null);
    }
    expect(audits('key.pickup_refused').some((a) => a.details.includes('lockdown'))).toBe(false);
    expect((await pickup(pc.app, code)).status).toBe(200);
  });
});
