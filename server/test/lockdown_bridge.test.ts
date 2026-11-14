import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { frameHeader, FRAME_END } from '../src/util/frames.js';
import { buildApp, type App } from '../src/app.js';
import type { Config } from '../src/config.js';
import type { ChannelRow } from '../src/channels/channels.js';
import { NOT_ALLOWED, type Rule } from '../src/policy/engine.js';
import { testConfig } from './hub.js';

const sys = { kind: 'system' as const, id: null };
let app: App, vaultDir = '';
beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahlb-'));
  vaultDir = join(dir, 'vault');
  mkdirSync(vaultDir, { recursive: true });
  const config: Config = testConfig(dir, { vaultDir });
  app = await buildApp(config);
  await app.store.ready;
});
afterAll(async () => { await app.close(); });

describe('lockdown stops bridge transfers into the vault', () => {
  it('agent and PC scopes refuse the commit of a vault-bound transfer; unlocked it goes through', async () => {
    const agent = app.keys.createAgent('xfer', null, sys);
    const k = app.keys.createSessionKey({ agentId: agent.id, label: 'xfer' }, sys);
    // The save re-checks the write grant (FR-AUTHZ-01), so the sender may create files in the folder.
    app.keys.setRules(k.credential.policy_id, [{ effect: 'allow', actions: ['fs.create'], resource: 'path:/vault/Bridge/**' }], 'test', sys);
    const machineId = 'pc-lock-test';
    const row = (n: number) => ({ id: `chn_lock${n}`, from_agent_id: agent.id, from_credential_id: k.credential.id, from_machine_id: machineId, target_kind: 'vault', target: `/vault/Bridge/f${n}.md`, base_revision: null, purpose: 'x', from_app_credential_id: null, opened_with: null });
    const commit = (n: number) => (app.channels as any).commit(row(n), Buffer.from(`hello ${n}`)) as Promise<{ status: string; reason: string | null }>;
    app.db.prepare("INSERT OR IGNORE INTO machines(id,name,status,created_at) VALUES (?,?,'active',?)").run(machineId, 'pc', Date.now());

    app.lockdown.set('agent', agent.id, true, null);
    expect(await commit(1)).toMatchObject({ status: 'failed', reason: 'lockdown' });
    expect(existsSync(join(vaultDir, 'Bridge', 'f1.md'))).toBe(false);
    app.lockdown.set('agent', agent.id, false, null);

    app.lockdown.set('pc', machineId, true, null);
    expect(await commit(2)).toMatchObject({ status: 'failed', reason: 'lockdown' });
    expect(existsSync(join(vaultDir, 'Bridge', 'f2.md'))).toBe(false);
    app.lockdown.set('pc', machineId, false, null);

    expect((await commit(3)).status).toBe('done');
    expect(readFileSync(join(vaultDir, 'Bridge', 'f3.md'), 'utf8')).toBe('hello 3');
  });
});

type NewRule = Omit<Rule, 'id'>;
const tools: NewRule = { effect: 'allow', actions: ['tool.invoke'], resource: 'tool:*' };
const chan: NewRule = { effect: 'allow', actions: ['channel.use'], resource: 'channel:*' };
const sha = (b: Buffer) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
type SaveResult = { status: string; reason: string | null; result: { revision?: string; message?: string } | null };
/** An agent whose session key holds `rules` (plus tool.invoke and, unless dropped, channel.use), with an app key of its own. */
const sender = (label: string, rules: NewRule[]) => {
  const agent = app.keys.createAgent(label, null, sys);
  const k = app.keys.createSessionKey({ agentId: agent.id, label }, sys);
  const pc = app.keys.createMachine(`${label}-pc`, null, sys);
  const ak = app.keys.createAppKey({ machineId: pc.id, appName: 'claude-code' }, sys);
  const setRules = (r: NewRule[], withChan = true) => app.keys.setRules(k.credential.policy_id, [tools, ...(withChan ? [chan] : []), ...r], 'test', sys);
  setRules(rules);
  return { agent, k, ak, pc, setRules };
};
type Sender = ReturnType<typeof sender>;
/** What the final channel_send (inline) or the bridge's last report runs once the bytes are complete. */
const save = (c: ChannelRow, bytes: Buffer) => (app.channels as any).commit(c, bytes) as Promise<SaveResult>;
const denials = (credId: string) => app.db.prepare("SELECT action, path FROM resource_access_events WHERE credential_id=? AND decision='deny' ORDER BY created_at, rowid").all(credId);
const setFlag = (key: string, v: boolean) => app.db.prepare('INSERT INTO system_settings(key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(v), Date.now());

describe('FR-AUTHZ-01, FR-AUTHZ-04/AC1: permissions are checked again when a transfer is saved into the vault', () => {
  /** A real inline channel into the vault, opened as channel_open opens it. */
  const openVault = (s: Sender, target: string, bytes: Buffer, base?: string) => app.channels.open({
    from: { agentId: s.agent.id, credId: s.k.credential.id, machineId: null, appId: s.ak.credential.id }, openedWith: 'channel_open',
    targetKind: 'vault', target, direction: 'send', mode: 'inline', framing: 'raw', size: bytes.length, sha256: sha(bytes), baseRevision: base ?? 'absent', purpose: 'x',
  });
  const grant = (actions: string[]): NewRule[] => [{ effect: 'allow', actions, resource: 'path:/vault/Grant/**' }];
  /** Open a channel, change something while it is in flight, then save it. */
  const send = async (s: Sender, name: string, change: () => void, base?: string, text = name) => {
    const b = Buffer.from(text), c = openVault(s, `/vault/Grant/${name}`, b, base);
    change();
    return { c, res: await save(c, b) };
  };
  const file = (name: string) => join(vaultDir, 'Grant', name);

  /** FR-AUTHZ-04/AC1 (delayed delivery or commit follows the current decision), the commit half (delivery after a revoke is in revoke-and-held-dm.test.ts). */
  it('FR-AUTHZ-04/AC1: a grant revoked before a transfer is saved stops the save', async () => {
    const s = sender('xfer-grant', grant(['fs.list', 'fs.read', 'fs.create', 'fs.update']));
    // Opened while the agent could write the folder; the operator revokes the write grant before the transfer is saved.
    const { c, res } = await send(s, 'g1.md', () => s.setRules(grant(['fs.list', 'fs.read'])));
    // Refused with the reason, nothing in the vault, and logged like any other denied access.
    expect(res).toMatchObject({ status: 'failed', reason: 'denied', result: { message: NOT_ALLOWED } });
    expect(app.channels.get(c.id)).toMatchObject({ status: 'failed', failure_reason: 'denied' });
    expect(existsSync(file('g1.md'))).toBe(false);
    expect(denials(s.k.credential.id)).toEqual([{ action: 'fs.create', path: '/vault/Grant/g1.md' }]);
  });

  it('FR-AUTHZ-04/AC1: a transfer whose sender still may write is saved; an update needs fs.update at save time', async () => {
    const s = sender('xfer-update', grant(['fs.create', 'fs.update']));
    const first = (await send(s, 'u1.md', () => undefined, undefined, 'first')).res;
    expect(first.status).toBe('done');
    // fs.update revoked before the update is saved.
    expect((await send(s, 'u1.md', () => s.setRules(grant(['fs.create'])), first.result!.revision, 'second')).res).toMatchObject({ status: 'failed', reason: 'denied' });
    expect(readFileSync(file('u1.md'), 'utf8')).toBe('first');
    expect(denials(s.k.credential.id)).toEqual([{ action: 'fs.update', path: '/vault/Grant/u1.md' }]);
    expect((await send(s, 'u1.md', () => s.setRules(grant(['fs.create', 'fs.update'])), first.result!.revision, 'third')).res.status).toBe('done');
    expect(readFileSync(file('u1.md'), 'utf8')).toBe('third');
  });

  it('FR-AUTHZ-04/AC1: a save is refused, and logged, once the sender\'s key is suspended', async () => {
    const s = sender('xfer-suspend', grant(['fs.create']));
    const { c, res } = await send(s, 's1.md', () => app.keys.setStatus(s.k.credential.id, 'suspended', 'test', sys));
    expect(res).toMatchObject({ status: 'failed', reason: 'denied', result: { message: NOT_ALLOWED } });
    expect(app.channels.get(c.id)).toMatchObject({ status: 'failed', failure_reason: 'denied' });
    expect(existsSync(file('s1.md'))).toBe(false);
    expect(denials(s.k.credential.id)).toEqual([{ action: 'fs.create', path: '/vault/Grant/s1.md' }]);
  });

  it('FR-AUTHZ-03: the app key\'s cap and state, and channel.use, are checked again at save time', async () => {
    const s = sender('xfer-cap', grant(['fs.create']));
    const cap = (actions: string[]) => app.keys.setRules(s.ak.credential.policy_id, [tools, chan, ...grant(actions)], 'cap', sys);
    cap(['fs.create']);
    // The operator narrows the app key's cap while the transfer is in flight.
    expect((await send(s, 'c1.md', () => cap(['fs.read']))).res).toMatchObject({ status: 'failed', reason: 'denied' });
    cap(['fs.create']);
    // The app key is suspended while the transfer is in flight.
    expect((await send(s, 'c2.md', () => app.keys.setStatus(s.ak.credential.id, 'suspended', 'test', sys))).res).toMatchObject({ status: 'failed', reason: 'denied' });
    app.keys.setStatus(s.ak.credential.id, 'active', 'test', sys);
    // channel.use is taken away while the transfer is in flight.
    expect((await send(s, 'c3.md', () => s.setRules(grant(['fs.create']), false))).res).toMatchObject({ status: 'failed', reason: 'denied' });
    s.setRules(grant(['fs.create']));
    for (const n of ['c1.md', 'c2.md', 'c3.md']) expect(existsSync(file(n))).toBe(false);
    expect(denials(s.k.credential.id)).toEqual([
      { action: 'fs.create', path: '/vault/Grant/c1.md' }, { action: 'fs.create', path: '/vault/Grant/c2.md' }, { action: 'channel.use', path: 'channel:any' },
    ]);
    // Nothing narrowed: saved.
    expect((await send(s, 'c4.md', () => undefined)).res.status).toBe('done');
  });

  it('FR-AUTHZ-01/AC2: a save is refused while the sender\'s team is paused or switched off', async () => {
    const s = sender('xfer-pause', grant(['fs.create']));
    const team = app.teams.create({ name: 'Pause on save', goal: 'g', members: [{ agent_id: s.agent.id, role: 'coordinator', credential_id: s.k.credential.id }] }, sys);
    app.teams.start(team.id, sys);
    // Paused between open and save.
    const paused = await send(s, 'p1.md', () => app.teams.pause(team.id, 'operator', sys));
    expect(paused.res).toMatchObject({ status: 'failed', reason: 'paused' });
    expect(app.channels.get(paused.c.id)).toMatchObject({ status: 'failed', failure_reason: 'paused' });
    app.teams.resume(team.id, sys);
    // Switched off by the emergency switch between open and save.
    const flag = `emergency.team_disabled.${team.id}`;
    expect((await send(s, 'p2.md', () => setFlag(flag, true))).res).toMatchObject({ status: 'failed', reason: 'paused' });
    setFlag(flag, false);
    for (const n of ['p1.md', 'p2.md']) expect(existsSync(file(n))).toBe(false);
    expect((await send(s, 'p3.md', () => undefined)).res.status).toBe('done');
  });
});

describe('FR-AUTHZ-01, FR-AUTHZ-04/AC1: permissions are checked again when a transfer is saved into a share', () => {
  /** A sender with a share of its own; `upload(true)` grants share.upload on it, `upload(false)` takes it away. */
  const shareSender = (label: string) => {
    const s = sender(label, []);
    const sh = app.shares.create({ agentId: s.agent.id, credId: s.k.credential.id }, `${label} notes`, null, []);
    const upload = (on: boolean, resource = `share:${sh.id}`) => s.setRules(on ? [{ effect: 'allow', actions: ['share.upload'], resource }] : []);
    upload(true);
    return { ...s, sh, upload };
  };
  type ShareSender = ReturnType<typeof shareSender>;
  const versions = (s: ShareSender) => app.shares.versions(s.sh.id, true).length;
  const shareDenials = (s: ShareSender, n: number) => Array.from({ length: n }, () => ({ action: 'share.upload', path: `share:${s.sh.id}` }));
  /** Inline: a channel_open into the share, something changes in flight, then the save. */
  const sendInline = async (s: ShareSender, change: () => void, text = 'notes') => {
    const b = Buffer.from(text);
    const c = app.channels.open({
      from: { agentId: s.agent.id, credId: s.k.credential.id, machineId: s.pc.id, appId: s.ak.credential.id }, openedWith: 'channel_open',
      targetKind: 'share', target: s.sh.id, direction: 'send', mode: 'inline', framing: 'tar', sharePath: 'notes.md', size: b.length, sha256: sha(b), purpose: 'x',
    });
    change();
    return { c, res: await save(c, b) };
  };
  /**
   * Bridge: a share_upload through the PC's bridge. The framed stream of files is staged as the hub stages it, then saved as
   * the bridge's last report saves it (commitFile). `before` runs before the save, `during` while the files are read.
   */
  const sendBridge = async (s: ShareSender, before: () => void, during: () => void = () => undefined) => {
    const c = app.channels.open({
      from: { agentId: s.agent.id, credId: s.k.credential.id, machineId: s.pc.id, appId: s.ak.credential.id }, openedWith: 'share_upload',
      targetKind: 'share', target: s.sh.id, direction: 'send', mode: 'bridge', fromLocalPath: 'C:/work/notes', framing: 'tar', purpose: 'bridge upload',
    });
    const files = [['a.md', 'first file'], ['b.md', 'second file']] as const;
    const stream = Buffer.concat([...files.flatMap(([p, t]) => [frameHeader(p, Buffer.byteLength(t)), Buffer.from(t)]), FRAME_END]);
    const part = (app.channels as any).part(c.id) as string;
    mkdirSync(dirname(part), { recursive: true });
    writeFileSync(part, stream);
    before();
    const store = app.store as unknown as { putBlob: (...a: unknown[]) => Promise<unknown> };
    const putBlob = store.putBlob;
    let calls = 0;
    store.putBlob = async (...a: unknown[]) => { if (calls++ === 0) during(); return putBlob.apply(app.store, a); };
    try { await (app.channels as any).commitFile(app.channels.get(c.id), sha(stream)); } finally { store.putBlob = putBlob; }
    return app.channels.get(c.id)!;
  };

  it('FR-AUTHZ-04/AC1: an inline transfer is saved only while the sender may still upload to the share (revoked, then missing)', async () => {
    const s = shareSender('xfer-share');
    // Allowed: the transfer becomes the share's next version.
    expect((await sendInline(s, () => undefined)).res.status).toBe('done');
    expect(versions(s)).toBe(1);
    // Revoked before the save: refused with the reason, nothing published, logged as a denied access.
    const revoked = await sendInline(s, () => s.upload(false));
    expect(revoked.res).toMatchObject({ status: 'failed', reason: 'denied', result: { message: NOT_ALLOWED } });
    expect(app.channels.get(revoked.c.id)).toMatchObject({ status: 'failed', failure_reason: 'denied' });
    // Missing: the key may upload only to another share.
    expect((await sendInline(s, () => s.upload(true, 'share:shr_other'))).res).toMatchObject({ status: 'failed', reason: 'denied' });
    expect(versions(s)).toBe(1);
    expect(denials(s.k.credential.id)).toEqual(shareDenials(s, 2));
  });

  it('FR-AUTHZ-04/AC1: a share save is refused, and logged, once the sender\'s key is suspended', async () => {
    const s = shareSender('xfer-share-suspend');
    const r = await sendInline(s, () => app.keys.setStatus(s.k.credential.id, 'suspended', 'test', sys));
    expect(r.res).toMatchObject({ status: 'failed', reason: 'denied', result: { message: NOT_ALLOWED } });
    expect(versions(s)).toBe(0);
    expect(denials(s.k.credential.id)).toEqual(shareDenials(s, 1));
  });

  it('NFR-SEC-03: agent and PC lockdowns stop a share save as they stop share_upload; unlocked it goes through', async () => {
    const s = shareSender('xfer-share-lock');
    for (const [scope, id] of [['agent', s.agent.id], ['pc', s.pc.id]] as const) {
      const r = await sendInline(s, () => app.lockdown.set(scope, id, true, null));
      app.lockdown.set(scope, id, false, null);
      expect(r.res).toMatchObject({ status: 'failed', reason: 'lockdown' });
      expect(app.channels.get(r.c.id)).toMatchObject({ status: 'failed', failure_reason: 'lockdown' });
    }
    expect(versions(s)).toBe(0);
    expect((await sendInline(s, () => undefined)).res.status).toBe('done');
    expect(versions(s)).toBe(1);
  });

  it('FR-AUTHZ-01/AC2: a share save is refused while the sender\'s team is paused', async () => {
    const s = shareSender('xfer-share-pause');
    const team = app.teams.create({ name: 'Share pause on save', goal: 'g', members: [{ agent_id: s.agent.id, role: 'coordinator', credential_id: s.k.credential.id }] }, sys);
    app.teams.start(team.id, sys);
    expect((await sendInline(s, () => app.teams.pause(team.id, 'operator', sys))).res).toMatchObject({ status: 'failed', reason: 'paused' });
    expect(versions(s)).toBe(0);
    app.teams.resume(team.id, sys);
    expect((await sendInline(s, () => undefined)).res.status).toBe('done');
  });

  it('FR-AUTHZ-04/AC1: a bridge upload into a share is checked before its files are read and again before it is published', async () => {
    const s = shareSender('xfer-share-bridge');
    // (a) share.upload revoked before the save: nothing published, one denied access logged.
    const before = await sendBridge(s, () => s.upload(false));
    expect(before).toMatchObject({ status: 'failed', failure_reason: 'denied' });
    expect(JSON.parse(before.result!)).toEqual({ message: NOT_ALLOWED });
    expect(versions(s)).toBe(0);
    expect(denials(s.k.credential.id)).toEqual(shareDenials(s, 1));
    s.upload(true);
    // (b) revoked while the files are read: still nothing published.
    const during = await sendBridge(s, () => undefined, () => s.upload(false));
    expect(during).toMatchObject({ status: 'failed', failure_reason: 'denied' });
    expect(JSON.parse(during.result!)).toEqual({ message: NOT_ALLOWED });
    expect(versions(s)).toBe(0);
    expect(denials(s.k.credential.id)).toEqual(shareDenials(s, 2));
    s.upload(true);
    // A lockdown while the files are read stops it too.
    const locked = await sendBridge(s, () => undefined, () => app.lockdown.set('agent', s.agent.id, true, null));
    app.lockdown.set('agent', s.agent.id, false, null);
    expect(locked).toMatchObject({ status: 'failed', failure_reason: 'lockdown' });
    expect(versions(s)).toBe(0);
    // (c) still allowed: published as the share's next version.
    const ok = await sendBridge(s, () => undefined);
    expect(ok).toMatchObject({ status: 'done', failure_reason: null });
    expect(JSON.parse(ok.result!)).toMatchObject({ share_id: s.sh.id, version: 1, files: 2 });
    expect(versions(s)).toBe(1);
  });
});
