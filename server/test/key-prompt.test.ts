/**
 * Key prompts for a key whose PC runs no connector (docs/onboarding.md#key-handover-a-rotated-key-or-a-recruit-reaches-a-connector-pc):
 * the raw key is shown once with the chat warning and the key's tool groups. A key whose PC runs the connector reaches it by
 * key handover instead (key-handover.test.ts); the pickup codes of earlier releases are refused. Make a new prompt is Rotate
 * secret on a key that never logged in: the old secret stops, the binding and the variable stay, audited as key.rotate.
 * Migration 0138 adds the column and the table without touching existing rows.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from '../src/db/db.js';
import { buildApp, type App } from '../src/app.js';
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
const audits = (action: string, id?: string) => (app.db.prepare(`SELECT actor_kind, target_id, details FROM audit_events WHERE action=?${id ? ' AND target_id=?' : ''} ORDER BY id`).all(...(id ? [action, id] : [action])) as { actor_kind: string; target_id: string; details: string }[]);
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
  it('a never-used key gets a fresh prompt: the old secret stops, the binding and variable stay, audited as key.rotate', async () => {
    const pc = await pcWithKey('reissue-pc');
    const first = await newKey('Reissue', pc.id);
    expect(first.prompt.mode).toBe('secret');
    const r = await api('POST', `/keys/${first.key.id}/rotate`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.prompt.mode).toBe('secret');
    expect(r.body.key.bound_machine_id ?? r.body.key.bound_pc?.id).toBe(pc.id);
    expect(app.keys.credential(r.body.key.id)!.session_var).toBe('REISSUE_SESSION_KEY');
    expect(app.keys.credential(first.key.id)!.status).toBe('revoked');
    expect(() => app.keys.verifyKey(first.secret, 'session_key')).toThrow();
    expect(app.keys.verifyKey(r.body.secret, 'session_key').id).toBe(r.body.key.id);
    const rot = audits('key.rotate', r.body.key.id);
    expect(rot).toHaveLength(1);
    expect(rot[0]!.actor_kind).toBe('admin');
    expect(JSON.parse(rot[0]!.details)).toEqual({ replaces: first.key.id, reason: null, delivery: 'shown' });
  });

  it('a used free key is refused its old secret at once after rotation', async () => {
    const first = await newKey('Rotated Free', null);
    app.keys.verifyKey(first.secret, 'session_key'); // it logged in once
    const r = await api('POST', `/keys/${first.key.id}/rotate`);
    expect(r.body.prompt.text).toContain('The rotated Conclave session key');
    expect(() => app.keys.verifyKey(first.secret, 'session_key')).toThrow();
    expect(app.keys.verifyKey(r.body.secret, 'session_key').id).toBe(r.body.key.id);
  });


  it('the variable stays unique on the PC: a second agent with the same name gets a numbered one', async () => {
    const pc = await pcWithKey('twins-pc');
    const a = await newKey('Twin', pc.id), b = await newKey('Twin', pc.id);
    expect([a.prompt.session_var, b.prompt.session_var]).toEqual(['TWIN_SESSION_KEY', 'TWIN_2_SESSION_KEY']);
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

});
