/**
 * Key collection (docs/onboarding.md#collect-on-a-pc-the-codex-wake-picks-up-a-routine-rotation): a routine rotation of a
 * key that has logged in is armed for the Codex wake on its PC; the wake polls with the agent's app key, picks the key up
 * with a collect_id and its instance id, and confirms. One test per failure-mode row of the design: a suspected leak and a
 * never-logged-in key refuse Collect; a second instance, one instance from two addresses and a pickup from an unexpected
 * instance void it and alert; a shared app key (from the wake or from login records) hides Collect; a login through any
 * other app key, on the same PC or another, shows Failed and is refused. No secret in a poll answer, audit row or alert.
 * Migration 0141 adds two tables without touching existing rows.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { migrate } from '../src/db/db.js';
import { buildApp, type App } from '../src/app.js';
import { BoundElsewhereError, KeyError } from '../src/keys/keys.js';
import { COLLECT_CONFIRM_MS, WAKE_SEEN_MS } from '../src/keys/keyCollect.js';
import { testConfig, adminLogin } from './hub.js';

vi.spyOn(console, 'warn').mockImplementation(() => {});
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'db', 'migrations');
const sys = { kind: 'system' as const, id: null };
let app: App, base = '', cookie = '', csrf = '';

const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
let ipSeq = 1;
const freshIp = () => `10.9.${Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}`;
const ob = async (path: string, o: { key: string; body?: unknown; from?: string }) => {
  const headers: Record<string, string> = { 'content-type': 'application/json', authorization: `Bearer ${o.key}`, 'x-forwarded-for': o.from ?? freshIp(), 'x-forwarded-proto': 'https' };
  const r = await fetch(`${base}/onboard${path}`, { method: 'POST', headers, body: JSON.stringify(o.body ?? {}) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const mcpLogin = async (appKey: string, secret: string) => {
  const c = new Client({ name: 't', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${appKey}` } } }));
  const r = (await c.callTool({ name: 'session_login', arguments: { session_key: secret } })) as { isError?: boolean };
  await c.close();
  return r;
};
let instSeq = 0;
const newInstance = () => `wake-instance-${String(++instSeq).padStart(6, '0')}`;
const audits = (action: string, id?: string) => app.db.prepare(`SELECT target_id, details FROM audit_events WHERE action=?${id ? ' AND target_id=?' : ''} ORDER BY id`).all(...(id ? [action, id] : [action])) as { target_id: string; details: string }[];
const conflicts = (cred: string) => (app.db.prepare("SELECT details FROM security_alerts WHERE type='key.collect_conflict' AND subject=?").all(cred) as { details: string }[]).map((a) => JSON.parse(a.details));
const collection = (cred: string) => app.db.prepare('SELECT * FROM key_collections WHERE credential_id=? ORDER BY created_at DESC LIMIT 1').get(cred) as any;

interface Setup { pc: { id: string; name: string }; app: string; appId: string; agentId: string; keyId: string; secret: string; sv: string; instance: string; from: string }
/** A PC with an app key, an agent whose key is bound to it and has logged in through it, and a wake that polled for it. */
const setup = async (name: string, o: { login?: boolean; poll?: boolean } = {}): Promise<Setup> => {
  const pc = (await api('POST', '/pcs', { name: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-pc` })).body.pc;
  const ak = app.keys.createAppKey({ machineId: pc.id, appName: 'codex' }, sys);
  const agent = app.keys.createAgent(name, null, sys);
  const k = app.keys.createSessionKey({ agentId: agent.id, label: `${name} key` }, sys);
  app.keys.setBinding(k.credential.id, pc.id, sys);
  if (o.login !== false) app.keys.login(ak.credential, k.secret);
  const sv = app.keys.keyTarget(k.credential.id).session_var!;
  const s = { pc: { id: pc.id, name: pc.name }, app: ak.secret, appId: ak.credential.id, agentId: agent.id, keyId: k.credential.id, secret: k.secret, sv, instance: newInstance(), from: freshIp() };
  if (o.poll !== false) expect((await poll(s)).status).toBe(200);
  return s;
};
const poll = (s: Setup, o: { instance?: string; from?: string; sv?: string; key?: string } = {}) => ob('/key-collect/poll', { key: o.key ?? s.app, body: { instance_id: o.instance ?? s.instance, session_var: o.sv ?? s.sv }, from: o.from ?? s.from });
const collect = (s: Setup) => api('POST', `/keys/${s.keyId}/rotate`, { reason: 'routine', delivery: 'collect' });
/** Arm a collection; the new key's id. */
const arm = async (s: Setup) => {
  const r = await collect(s);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.key.id as string;
};
const pickup = (s: Setup, collectId: string, o: { instance?: string; key?: string; from?: string } = {}) => ob('/key-pickup', { key: o.key ?? s.app, body: { collect_id: collectId, instance_id: o.instance ?? s.instance }, from: o.from ?? s.from });
const confirm = (s: Setup, collectId: string, ok: boolean) => ob('/key-collect/confirm', { key: s.app, body: { collect_id: collectId, instance_id: s.instance, ok }, from: s.from });
/** Arm, poll and pick up: the new key's id, its collect id and its secret. */
const collected = async (s: Setup) => {
  const nid = await arm(s);
  const p = await poll(s);
  const cid = p.body.collect_ids[0] as string;
  const r = await pickup(s, cid);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return { nid, cid, secret: r.body.secret as string };
};

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'keycollect-'));
  mkdirSync(join(dir, 'vault', 'Notes'), { recursive: true });
  const client = join(dir, 'client');
  mkdirSync(client);
  writeFileSync(join(client, 'agent-hub-headers.mjs'), 'export const helper = 1;\n');
  writeFileSync(join(client, 'setup.mjs'), 'export const setup = 1;\n');
  writeFileSync(join(client, 'onboarding-prompt.md'), 'Hub {{HUB_URL}} code {{ENROL_CODE}} pc {{PC_NAME}}\n');
  app = await buildApp(testConfig(dir, { publicUrl: 'https://hub.test', clientDir: client }));
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  ({ cookie, csrf } = await adminLogin(base));
});
afterAll(async () => { await app.close(); });

describe('migration 0141', () => {
  it('adds the collections and the wake heartbeats and keeps every existing key and pickup as it was', () => {
    const before = mkdtempSync(join(tmpdir(), 'kc-0141-'));
    for (const f of readdirSync(MIGRATIONS)) if (/^\d{4}_.+\.sql$/.test(f) && Number(f.slice(0, 4)) < 141) copyFileSync(join(MIGRATIONS, f), join(before, f));
    const db = new DatabaseSync(join(before, 'x.db'));
    db.exec('PRAGMA foreign_keys=ON');
    migrate(db, before);
    const now = Date.now();
    db.prepare("INSERT INTO agents(id,label,created_at) VALUES ('agent-a','A',?)").run(now);
    db.prepare("INSERT INTO machines(id,name,status,created_at) VALUES ('pc-1','pc','active',?)").run(now);
    db.prepare("INSERT INTO permission_policies(id,kind,version,created_at,updated_at) VALUES ('pol_1','credential',1,?,?)").run(now, now);
    db.prepare("INSERT INTO credentials(id,kind,agent_id,label,key_id,verifier,policy_id,session_var,bound_machine_id,created_at) VALUES ('crd_1','session_key','agent-a','k','kid1','v1','pol_1','A_SESSION_KEY','pc-1',?)").run(now);
    db.prepare("INSERT INTO key_pickups(id,credential_id,machine_id,session_var,code_hash,created_at,expires_at) VALUES ('kpk_1','crd_1','pc-1','A_SESSION_KEY','h',?,?)").run(now, now + 1000);
    const rows = () => [db.prepare("SELECT * FROM credentials WHERE id='crd_1'").get(), db.prepare("SELECT * FROM key_pickups WHERE id='kpk_1'").get()];
    const was = rows();
    migrate(db, MIGRATIONS);
    expect(rows()).toEqual(was);
    expect(db.prepare('SELECT COUNT(*) c FROM key_collections').get()).toEqual({ c: 0 });
    expect(db.prepare('SELECT COUNT(*) c FROM key_collect_polls').get()).toEqual({ c: 0 });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    db.close();
  });
});

describe('a routine rotation collected by the Codex wake', () => {
  it('arms without a code or secret, serves the key once to the bound app key and instance, and shows Signed in after the expected login', async () => {
    const s = await setup('Collector');
    const offer = (await api('GET', `/keys/${s.keyId}/collect`)).body.offer;
    expect(offer).toMatchObject({ ok: true, pc: { name: s.pc.name }, session_var: s.sv, app_credential_id: s.appId, instance_id: s.instance });
    const r = await collect(s);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.secret).toBeUndefined();
    expect(r.body.prompt).toBeUndefined();
    expect(r.body.collection).toMatchObject({ status: 'open', pc: s.pc.name, session_var: s.sv });
    const nid = r.body.key.id as string;
    // The old secret stopped, and the new key has no usable secret until pickup.
    expect(() => app.keys.verifyKey(s.secret, 'session_key')).toThrow();
    expect(app.db.prepare('SELECT verifier FROM credentials WHERE id=?').get(nid)).toEqual({ verifier: '' });
    expect(JSON.parse(audits('key.rotate', nid)[0]!.details)).toMatchObject({ replaces: s.keyId, reason: 'routine', delivery: 'collect' });
    expect(JSON.parse(audits('key.collect_armed', nid)[0]!.details)).toMatchObject({ pc: s.pc.id, session_var: s.sv, app: s.appId, instance: s.instance });
    // The poll names the collection, quicker while it is open, and never a secret.
    const p = await poll(s);
    expect(p.body.poll_after_s).toBe(15);
    expect(p.body.collect_ids).toHaveLength(1);
    expect(JSON.stringify(p.body)).not.toMatch(/ah_ses_|secret/);
    const cid = p.body.collect_ids[0] as string;
    const got = await pickup(s, cid);
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({ session_var: s.sv });
    expect(app.keys.verifyKey(got.body.secret, 'session_key').id).toBe(nid);
    expect(JSON.parse(audits('key.pickup', nid).at(-1)!.details)).toMatchObject({ via: 'collect', pc: s.pc.id, session_var: s.sv, instance: s.instance });
    expect((await pickup(s, cid)).status).toBe(409); // single use
    expect((await poll(s)).body).toEqual({ collect_ids: [], poll_after_s: 60 });
    expect((await confirm(s, cid, true)).body).toEqual({ ok: true, status: 'confirmed' });
    expect(audits('key.collect_confirmed', nid)).toHaveLength(1);
    expect((await mcpLogin(s.app, got.body.secret)).isError).toBeFalsy();
    expect(collection(nid)).toMatchObject({ status: 'signed_in' });
    expect((await api('GET', `/keys/${nid}/collect`)).body.collection).toMatchObject({ status: 'signed_in', retry: true });
    // No secret in any audit row, alert or collection row.
    const all = JSON.stringify([app.db.prepare('SELECT * FROM audit_events').all(), app.db.prepare('SELECT * FROM security_alerts').all(), app.db.prepare('SELECT * FROM key_collections').all()]);
    expect(all).not.toContain(got.body.secret);
    expect(all).not.toContain(got.body.secret.split('_').at(-1));
    expect(all).not.toMatch(/ah_ses_[a-z2-7]{12}_[a-z2-7]{32}/);
  });

  it('Make a new prompt and Rotate record the reason and the delivery', async () => {
    const s = await setup('Reasons');
    const r = await api('POST', `/keys/${s.keyId}/rotate`, { reason: 'suspected_leak', delivery: 'prompt' });
    expect(r.status).toBe(200);
    expect(r.body.prompt.mode).toBe('pickup');
    expect(JSON.parse(audits('key.rotate', r.body.key.id)[0]!.details)).toMatchObject({ reason: 'suspected_leak', delivery: 'prompt' });
    const plain = await api('POST', `/keys/${r.body.key.id}/rotate`, {});
    expect(JSON.parse(audits('key.rotate', plain.body.key.id)[0]!.details)).toMatchObject({ reason: null, delivery: 'prompt' });
  });
});

describe('when Collect is offered (failure modes: leak, never signed in, shared app key, no wake)', () => {
  it('a suspected leak refuses Collect and leaves the key as it was', async () => {
    const s = await setup('Leaked');
    const r = await api('POST', `/keys/${s.keyId}/rotate`, { reason: 'suspected_leak', delivery: 'collect' });
    expect(r.status).toBe(409);
    expect(r.body.message).toContain('rotate the PC\'s app key too');
    expect(app.keys.credential(s.keyId)!.status).toBe('active');
    expect((await api('POST', `/keys/${s.keyId}/rotate`, { delivery: 'collect' })).status).toBe(409); // no reason is not routine
  });

  it('a key that never logged in refuses Collect', async () => {
    const s = await setup('Fresh', { login: false });
    const offer = (await api('GET', `/keys/${s.keyId}/collect`)).body.offer;
    expect(offer).toMatchObject({ ok: false, reason: 'never_signed_in' });
    expect(offer.message).toContain('never signed in');
    const r = await collect(s);
    expect(r.status).toBe(409);
    expect(r.body.reason).toBe('never_signed_in');
    expect(app.keys.credential(s.keyId)!.status).toBe('active');
  });

  it('a shared app key hides Collect, when the wake polls for another variable', async () => {
    const s = await setup('Sharer');
    await poll(s, { sv: 'OTHER_AGENT_SESSION_KEY' });
    const offer = (await api('GET', `/keys/${s.keyId}/collect`)).body.offer;
    expect(offer).toMatchObject({ ok: false, reason: 'shared_app_key' });
    expect(offer.message).toMatch(/shares its app key with 1 other agent on/);
    expect((await collect(s)).status).toBe(409);
  });

  it('a shared app key hides Collect, detected only from the hub\'s login records', async () => {
    const s = await setup('Shared Logins');
    const other = app.keys.createSessionKey({ agentId: app.keys.createAgent('Neighbour', null, sys).id, label: 'n' }, sys);
    app.keys.login(app.keys.credential(s.appId)!, other.secret); // another agent's key logged in through the same app key
    expect((await api('GET', `/keys/${s.keyId}/collect`)).body.offer).toMatchObject({ ok: false, reason: 'shared_app_key' });
    expect((await collect(s)).status).toBe(409);
    // Its own rotation chain is not "another agent": after a collected rotation the offer stays open for the next one.
    const t = await setup('Own Chain');
    const { nid, secret } = await collected(t);
    app.keys.login(app.keys.credential(t.appId)!, secret);
    await poll(t);
    expect((await api('GET', `/keys/${nid}/collect`)).body.offer).toMatchObject({ ok: true });
  });

  it('no wake, a stale wake and two wakes each give the reason line', async () => {
    const none = await setup('No Wake', { poll: false });
    expect((await api('GET', `/keys/${none.keyId}/collect`)).body.offer).toMatchObject({ ok: false, reason: 'no_wake', message: `No Codex wake on ${none.pc.name} collects this agent's key.` });
    const stale = await setup('Stale Wake');
    app.db.prepare('UPDATE key_collect_polls SET last_at=? WHERE app_credential_id=?').run(Date.now() - WAKE_SEEN_MS - 2 * 86_400_000, stale.appId);
    expect((await api('GET', `/keys/${stale.keyId}/collect`)).body.offer).toMatchObject({ ok: false, reason: 'wake_stale' });
    expect((await api('GET', `/keys/${stale.keyId}/collect`)).body.offer.message).toMatch(/last seen 9 days ago/);
    const two = await setup('Two Wakes');
    await poll(two, { instance: newInstance() });
    expect((await api('GET', `/keys/${two.keyId}/collect`)).body.offer).toMatchObject({ ok: false, reason: 'two_instances' });
  });

  it('an app key that is not active refuses the poll and Collect', async () => {
    const s = await setup('Suspended App');
    app.keys.setStatus(s.appId, 'suspended', 'admin', sys);
    expect((await poll(s)).status).toBe(401);
    expect((await api('GET', `/keys/${s.keyId}/collect`)).body.offer).toMatchObject({ ok: false, reason: 'app_inactive' });
  });
});

describe('a second collector', () => {
  it('a second instance id voids the open collection and alerts; the expected one then gets nothing', async () => {
    const s = await setup('Second Instance');
    const nid = await arm(s);
    const intruder = newInstance();
    const p = await poll(s, { instance: intruder, from: freshIp() });
    expect(p.body.collect_ids).toEqual([]);
    expect(collection(nid)).toMatchObject({ status: 'void', outcome: 'conflict' });
    expect(conflicts(nid)).toHaveLength(1);
    expect(conflicts(nid)[0]).toMatchObject({ kind: 'second_instance', expected_instance: s.instance });
    expect(conflicts(nid)[0].instances).toEqual(expect.arrayContaining([s.instance, intruder]));
    expect((await poll(s)).body.collect_ids).toEqual([]);
    expect((await api('GET', `/keys/${nid}/collect`)).body.collection).toMatchObject({ status: 'void', retry: false });
  });

  it('one instance from two addresses voids it', async () => {
    const s = await setup('Two Addresses');
    const nid = await arm(s);
    await poll(s, { from: freshIp() });
    expect(collection(nid)).toMatchObject({ status: 'void', outcome: 'conflict' });
    expect(conflicts(nid)[0]).toMatchObject({ kind: 'two_addresses' });
    expect(conflicts(nid)[0].addresses).toHaveLength(2);
  });

  it('a pickup from an unexpected instance is refused, counted as a refused pickup, and voids the collection with an alert', async () => {
    const s = await setup('Unexpected');
    const nid = await arm(s);
    const cid = (await poll(s)).body.collect_ids[0];
    const r = await pickup(s, cid, { instance: newInstance() });
    expect(r.status).toBe(404);
    expect(r.body.secret).toBeUndefined();
    expect(audits('key.pickup_refused').some((a) => JSON.parse(a.details).via === 'collect' && JSON.parse(a.details).source === s.from)).toBe(true);
    expect(collection(nid)).toMatchObject({ status: 'void', outcome: 'conflict' });
    expect(conflicts(nid)[0]).toMatchObject({ kind: 'unexpected_pickup' });
    expect((await pickup(s, cid)).status).toBe(409); // the expected instance is now refused too
  });

  it('a pickup through another app key or another PC answers not found', async () => {
    const s = await setup('Other App');
    await arm(s);
    const cid = (await poll(s)).body.collect_ids[0];
    const sameP = app.keys.createAppKey({ machineId: s.pc.id, appName: 'claude-code' }, sys).secret;
    const otherPc = await setup('Other App Elsewhere');
    expect((await pickup(s, cid, { key: sameP })).status).toBe(404);
    expect((await pickup(s, cid, { key: otherPc.app })).status).toBe(404);
    expect((await pickup(s, cid)).status).toBe(200);
  });
});

describe('a sign-in with the collected key from anywhere else shows Failed, not Signed in', () => {
  it('through a different app key on the same PC: refused, Failed, alert, and the new key is void', async () => {
    const s = await setup('Same PC');
    const { nid, secret } = await collected(s);
    const other = app.keys.createAppKey({ machineId: s.pc.id, appName: 'claude-code' }, sys);
    expect((await mcpLogin(other.secret, secret)).isError).toBe(true);
    expect(collection(nid)).toMatchObject({ status: 'failed', outcome: 'elsewhere' });
    expect(conflicts(nid).at(-1)).toMatchObject({ kind: 'used_elsewhere', same_pc: true, used_app: other.credential.id, expected_app: s.appId });
    expect(() => app.keys.verifyKey(secret, 'session_key')).toThrow();
    expect((await mcpLogin(s.app, secret)).isError).toBe(true); // nor does the expected app key sign in with it now
    expect(collection(nid).status).toBe('failed');
    expect(app.db.prepare('SELECT COUNT(*) n FROM session_tokens WHERE session_credential_id=?').get(nid)).toEqual({ n: 0 });
    expect((await api('GET', `/keys/${nid}/collect`)).body.collection).toMatchObject({ status: 'failed', outcome: 'elsewhere', retry: false });
  });

  it('through an app key on another PC: refused as bound elsewhere, Failed, both alerts', async () => {
    const s = await setup('Other PC');
    const { nid, secret } = await collected(s);
    const far = await setup('Far Away');
    expect((await mcpLogin(far.app, secret)).isError).toBe(true);
    expect(collection(nid)).toMatchObject({ status: 'failed', outcome: 'elsewhere' });
    expect(conflicts(nid).at(-1)).toMatchObject({ kind: 'used_elsewhere', same_pc: false, used_from_pc: far.pc.id });
    expect(app.db.prepare("SELECT 1 FROM security_alerts WHERE type='bound_key_elsewhere' AND subject=?").get(nid)).toBeTruthy();
  });

  it('the guard refuses before the binding check: another PC as bound elsewhere, the same PC as an invalid key', async () => {
    const a = await setup('Guard A'), b = await setup('Guard B');
    const ka = await collected(a), kb = await collected(b);
    expect(() => app.keys.login(app.keys.credential(b.appId)!, ka.secret)).toThrow(BoundElsewhereError);
    const same = app.keys.createAppKey({ machineId: b.pc.id, appName: 'x' }, sys).credential;
    try { app.keys.login(same, kb.secret); expect.unreachable(); } catch (e) { expect(e).toBeInstanceOf(KeyError); expect(e).not.toBeInstanceOf(BoundElsewhereError); }
  });
});

describe('voiding and timing', () => {
  it('a binding change voids the open collection', async () => {
    const s = await setup('Moved');
    const nid = await arm(s);
    const cid = (await poll(s)).body.collect_ids[0];
    const other = (await api('POST', '/pcs', { name: 'moved-to-pc' })).body.pc.id;
    expect((await api('PUT', `/keys/${nid}/binding`, { machine_id: other })).status).toBe(200);
    expect(collection(nid)).toMatchObject({ status: 'void', outcome: 'binding_changed' });
    expect((await pickup(s, cid)).status).toBe(409);
  });

  it('Cancel voids it and leaves the key without a usable secret', async () => {
    const s = await setup('Cancelled');
    const nid = await arm(s);
    const r = await api('POST', `/keys/${nid}/collect/cancel`);
    expect(r.status).toBe(200);
    expect(r.body.collection).toMatchObject({ status: 'void', outcome: 'cancelled' });
    expect(audits('key.collect_cancelled', nid)).toHaveLength(1);
    expect(app.db.prepare('SELECT verifier FROM credentials WHERE id=?').get(nid)).toEqual({ verifier: '' });
    expect((await poll(s)).body.collect_ids).toEqual([]);
    expect((await api('POST', `/keys/${nid}/collect/cancel`)).status).toBe(409);
  });

  it('Show a key prompt instead voids it and gives today\'s pickup prompt for the same key', async () => {
    const s = await setup('Prompt Instead');
    const nid = await arm(s);
    const r = await api('POST', `/keys/${nid}/collect/prompt`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.prompt.mode).toBe('pickup');
    expect(r.body.key.id).toBe(nid);
    expect(r.body.secret).toBeUndefined();
    expect(collection(nid)).toMatchObject({ status: 'void', outcome: 'prompt_instead' });
  });

  it('an open collection expires after 24 hours: nothing was created, audited', async () => {
    const s = await setup('Expired');
    const nid = await arm(s);
    app.db.prepare('UPDATE key_collections SET expires_at=? WHERE credential_id=?').run(Date.now() - 1, nid);
    app.keyCollections.sweep();
    expect(collection(nid)).toMatchObject({ status: 'expired' });
    expect(audits('key.collect_expired', nid)).toHaveLength(1);
    expect((await poll(s)).body.collect_ids).toEqual([]);
  });

  it('no confirmation within 10 minutes voids the new secret', async () => {
    const s = await setup('Unconfirmed');
    const { nid, cid, secret } = await collected(s);
    app.db.prepare('UPDATE key_collections SET picked_at=? WHERE credential_id=?').run(Date.now() - COLLECT_CONFIRM_MS - 1000, nid);
    app.keyCollections.sweep();
    expect(collection(nid)).toMatchObject({ status: 'failed', outcome: 'unconfirmed' });
    expect(() => app.keys.verifyKey(secret, 'session_key')).toThrow();
    expect(JSON.parse(audits('key.collect_unconfirmed', nid)[0]!.details)).toMatchObject({ reason: 'unconfirmed' });
    expect((await confirm(s, cid, true)).status).toBe(409);
  });

  it('a keys file that cannot be written (ok: false) voids the new secret at once', async () => {
    const s = await setup('Not Written');
    const { nid, cid, secret } = await collected(s);
    expect((await confirm(s, cid, false)).body).toEqual({ ok: true, status: 'failed' });
    expect(collection(nid)).toMatchObject({ status: 'failed', outcome: 'write_failed' });
    expect(() => app.keys.verifyKey(secret, 'session_key')).toThrow();
    expect(JSON.parse(audits('key.collect_unconfirmed', nid)[0]!.details)).toMatchObject({ reason: 'write_failed' });
  });

  it('ok: false after the key already signed in is ignored with an audit line, and the key keeps working', async () => {
    const s = await setup('Late Not Written');
    const { nid, cid, secret } = await collected(s);
    expect((await confirm(s, cid, true)).status).toBe(200);
    expect((await mcpLogin(s.app, secret)).isError).toBeFalsy();
    expect(collection(nid).status).toBe('signed_in');
    expect((await confirm(s, cid, false)).body).toEqual({ ok: true, status: 'signed_in' });
    expect(collection(nid)).toMatchObject({ status: 'signed_in', outcome: null });
    expect(app.keys.verifyKey(secret, 'session_key').id).toBe(nid);
    expect(audits('key.collect_unconfirmed', nid)).toHaveLength(0);
    expect(JSON.parse(audits('key.collect_confirm_ignored', nid)[0]!.details)).toMatchObject({ pc: s.pc.id, session_var: s.sv, instance: s.instance, reason: 'already_signed_in' });
    expect((await mcpLogin(s.app, secret)).isError).toBeFalsy();
  });

  it('Show a key prompt instead after a pickup ends the collection, so the confirmation timer cannot blank the prompt\'s key', async () => {
    const s = await setup('Prompt After Pickup');
    const { nid, cid, secret } = await collected(s);
    const r = await api('POST', `/keys/${nid}/collect/prompt`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.prompt.mode).toBe('pickup');
    expect(collection(nid)).toMatchObject({ status: 'void', outcome: 'prompt_instead' });
    expect(JSON.parse(audits('key.collect_cancelled', nid)[0]!.details)).toMatchObject({ outcome: 'prompt_instead' });
    const verifier = () => (app.db.prepare('SELECT verifier FROM credentials WHERE id=?').get(nid) as { verifier: string }).verifier;
    expect(verifier()).toBe('');
    expect(() => app.keys.verifyKey(secret, 'session_key')).toThrow(); // the collected secret stopped
    // Simulate the prompt's pickup having set a secret, then let the confirmation window pass: nothing blanks it.
    app.db.prepare("UPDATE credentials SET verifier='prompt-made' WHERE id=?").run(nid);
    app.db.prepare('UPDATE key_collections SET picked_at=? WHERE credential_id=?').run(Date.now() - COLLECT_CONFIRM_MS - 1000, nid);
    app.keyCollections.sweep();
    expect(collection(nid)).toMatchObject({ status: 'void', outcome: 'prompt_instead' });
    expect(verifier()).toBe('prompt-made');
    expect((await confirm(s, cid, false)).status).toBe(409);
    expect(verifier()).toBe('prompt-made');
  });

  it('Show a key prompt instead after the key signed in ends the collection, so a later login elsewhere is not treated as the collected key', async () => {
    const s = await setup('Prompt After Sign In');
    const { nid, cid, secret } = await collected(s);
    expect((await confirm(s, cid, true)).status).toBe(200);
    expect((await mcpLogin(s.app, secret)).isError).toBeFalsy();
    expect((await api('POST', `/keys/${nid}/collect/prompt`)).status).toBe(200);
    expect(collection(nid)).toMatchObject({ status: 'void', outcome: 'prompt_instead' });
    expect(app.keyCollections.latest(nid)?.status).toBe('void');
  });

  describe('Show a key prompt instead still works after the collection ended', () => {
    const closeBy: Record<string, (s: Setup, nid: string) => Promise<void>> = {
      expired: async (_s, nid) => {
        app.db.prepare('UPDATE key_collections SET expires_at=? WHERE credential_id=?').run(Date.now() - 1, nid);
        app.keyCollections.sweep();
      },
      failed: async (s) => {
        const cid = (await poll(s)).body.collect_ids[0];
        expect((await pickup(s, cid)).status).toBe(200);
        expect((await confirm(s, cid, false)).status).toBe(200);
      },
      unconfirmed: async (s, nid) => {
        const cid = (await poll(s)).body.collect_ids[0];
        expect((await pickup(s, cid)).status).toBe(200);
        app.db.prepare('UPDATE key_collections SET picked_at=? WHERE credential_id=?').run(Date.now() - COLLECT_CONFIRM_MS - 1000, nid);
        app.keyCollections.sweep();
      },
      conflict: async (s) => {
        await poll(s, { instance: newInstance(), from: freshIp() });
      },
    };
    const ended: Record<string, object> = {
      expired: { status: 'expired' },
      failed: { status: 'failed', outcome: 'write_failed' },
      unconfirmed: { status: 'failed', outcome: 'unconfirmed' },
      conflict: { status: 'void', outcome: 'conflict' },
    };
    for (const state of Object.keys(closeBy)) {
      it(`after ${state}: the pickup prompt is made and the ended collection stays as it was`, async () => {
        const s = await setup(`Prompt After ${state}`);
        const nid = await arm(s);
        await closeBy[state]!(s, nid);
        expect(collection(nid)).toMatchObject(ended[state]!);
        const r = await api('POST', `/keys/${nid}/collect/prompt`);
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        expect(r.body.prompt.mode).toBe('pickup');
        expect(r.body.key.id).toBe(nid);
        expect(r.body.secret).toBeUndefined();
        expect(collection(nid)).toMatchObject(ended[state]!);
        expect(audits('key.collect_cancelled', nid)).toHaveLength(0);
      });
    }
  });

  it('a lockdown refuses the pickup and leaves the collection open', async () => {
    const s = await setup('Locked Collect');
    const nid = await arm(s);
    const cid = (await poll(s)).body.collect_ids[0];
    for (const [kind, id] of [['writes', undefined], ['pc', s.pc.id], ['agent', s.agentId]] as const) {
      app.lockdown.set(kind, id, true, null);
      expect((await pickup(s, cid)).status, kind).toBe(423);
      app.lockdown.set(kind, id, false, null);
    }
    expect(collection(nid).status).toBe('open');
    expect((await pickup(s, cid)).status).toBe(200);
  });

  it('a revoked key voids its open collection', async () => {
    const s = await setup('Revoked Collect');
    const nid = await arm(s);
    app.keys.setStatus(nid, 'revoked', 'admin', sys);
    expect(collection(nid)).toMatchObject({ status: 'void', outcome: 'revoked' });
  });

  it('the poll checks its input and needs an app key', async () => {
    const s = await setup('Bad Poll');
    expect((await ob('/key-collect/poll', { key: s.app, body: { instance_id: 'short', session_var: s.sv } })).status).toBe(400);
    expect((await ob('/key-collect/poll', { key: s.app, body: { instance_id: s.instance, session_var: 'lower' } })).status).toBe(400);
    expect((await ob('/key-collect/poll', { key: 'ah_app_aaaaaaaaaaaa_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', body: {} })).status).toBe(401);
  });
});

describe('the collection line says why it waits or ended (PC changed, app key suspended, lockdown)', () => {
  const line = async (id: string) => (await api('GET', `/keys/${id}/collect`)).body.collection;
  it('an open collection names nothing that holds it', async () => {
    const s = await setup('Hold None');
    const nid = await arm(s);
    expect(await line(nid)).toMatchObject({ status: 'open', hold: null, app_key_status: null });
  });

  it('a binding change ends it with outcome binding_changed', async () => {
    const s = await setup('Hold Moved');
    const nid = await arm(s);
    const other = (await api('POST', '/pcs', { name: 'hold-moved-to-pc' })).body.pc.id;
    await api('PUT', `/keys/${nid}/binding`, { machine_id: other });
    expect(await line(nid)).toMatchObject({ status: 'void', outcome: 'binding_changed', hold: null, retry: true });
  });

  it('a suspended app key holds it as app_key_inactive, and it waits', async () => {
    const s = await setup('Hold App');
    const nid = await arm(s);
    app.keys.setStatus(s.appId, 'suspended', 'admin', sys);
    expect(await line(nid)).toMatchObject({ status: 'open', hold: 'app_key_inactive', app_key_status: 'suspended' });
    app.keys.setStatus(s.appId, 'active', null, sys);
    expect(await line(nid)).toMatchObject({ status: 'open', hold: null });
  });

  it('a lockdown of all writes, the PC or the agent holds it as lockdown, and it stays open', async () => {
    const s = await setup('Hold Lock');
    const nid = await arm(s);
    for (const [kind, id] of [['writes', undefined], ['pc', s.pc.id], ['agent', s.agentId]] as const) {
      app.lockdown.set(kind, id, true, null);
      expect(await line(nid), kind).toMatchObject({ status: 'open', hold: 'lockdown' });
      app.lockdown.set(kind, id, false, null);
    }
    expect(await line(nid)).toMatchObject({ status: 'open', hold: null });
  });

  it('a suspended PC holds it as pc_inactive', async () => {
    const s = await setup('Hold Pc');
    const nid = await arm(s);
    app.keys.setMachineStatus(s.pc.id, 'suspended', sys);
    expect(await line(nid)).toMatchObject({ status: 'open', hold: 'pc_inactive' });
    app.keys.setMachineStatus(s.pc.id, 'active', sys);
    expect(await line(nid)).toMatchObject({ status: 'open', hold: null });
  });
});
