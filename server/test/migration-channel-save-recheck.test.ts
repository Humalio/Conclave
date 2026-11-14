/**
 * Migration 0111 (docs/transfers.md): data_channels records the app key a channel was opened through and the tool that
 * opened it. A channel opened before 0111 has neither, and its save is still authorized again (key state, paused team,
 * rules), only without the app key's cap and the channel.use check. Inline channels fail on a restart (recover()), so the
 * channels that live through the upgrade are bridge uploads, saved by the bridge's last report (commitFile).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, readdirSync, copyFileSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from '../src/db/db.js';
import { buildApp, type App } from '../src/app.js';
import type { ChannelRow } from '../src/channels/channels.js';
import { NOT_ALLOWED, type Rule } from '../src/policy/engine.js';
import { testConfig } from './hub.js';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'db', 'migrations');
const sys = { kind: 'system' as const, id: null };
const sha = (b: Buffer) => `sha256:${createHash('sha256').update(b).digest('hex')}`;

const root = mkdtempSync(join(tmpdir(), 'conclave-0111-'));
/** The migrations up to 0105: the schema a hub had before this change. */
const UPTO_0105 = join(root, 'migrations');
mkdirSync(UPTO_0105);
for (const f of readdirSync(MIGRATIONS)) if (/^\d{4}_.+\.sql$/.test(f) && Number(f.slice(0, 4)) <= 105) copyFileSync(join(MIGRATIONS, f), join(UPTO_0105, f));

const AGENT = 'agent-old', CRED = 'crd_old', POLICY = 'pol_old', PC = 'pc-old';
const CHANNELS = ['allowed', 'nochan', 'suspended', 'paused', 'revoked'] as const;
const target = (name: string) => `/vault/Old/${name}.md`;

let app: App, vaultDir = '';
beforeAll(async () => {
  vaultDir = join(root, 'vault');
  mkdirSync(vaultDir, { recursive: true }); mkdirSync(join(root, 'data'), { recursive: true });
  const config = testConfig(root, { vaultDir });
  // A hub at 0105 with an agent, its session key and bridge uploads into the vault still open.
  const db = new DatabaseSync(config.dbFile);
  migrate(db, UPTO_0105);
  expect((db.prepare('SELECT max(version) AS v FROM schema_migrations').get() as { v: number }).v).toBe(105);
  const now = Date.now();
  db.prepare('INSERT INTO agents(id,label,created_at) VALUES (?,?,?)').run(AGENT, 'old sender', now);
  db.prepare("INSERT INTO permission_policies(id,kind,created_at,updated_at) VALUES (?,'credential',?,?)").run(POLICY, now, now);
  db.prepare("INSERT INTO credentials(id,kind,agent_id,label,key_id,verifier,status,policy_id,created_at) VALUES (?,'session_key',?,?,?,?,'active',?,?)")
    .run(CRED, AGENT, 'old key', 'kid_old', '00', POLICY, now);
  db.prepare("INSERT INTO machines(id,name,status,created_at) VALUES (?,?,'active',?)").run(PC, 'old pc', now);
  const chan = db.prepare(`INSERT INTO data_channels(id,from_agent_id,from_credential_id,from_machine_id,from_local_path,target_kind,target,direction,mode,framing,purpose,status,created_at,expires_at,started_at)
    VALUES (?,?,?,?,?,'vault',?,'send','bridge','raw','x','open',?,?,?)`);
  for (const n of CHANNELS) chan.run(`chn_old_${n}`, AGENT, CRED, PC, `C:/work/${n}.md`, target(n), now, now + 24 * 3600_000, now);
  db.close();
  app = await buildApp(config);
  await app.store.ready;
});
afterAll(async () => { await app?.close(); rmSync(root, { recursive: true, force: true }); });

type NewRule = Omit<Rule, 'id'>;
const tools: NewRule = { effect: 'allow', actions: ['tool.invoke'], resource: 'tool:*' };
const create: NewRule = { effect: 'allow', actions: ['fs.create'], resource: 'path:/vault/Old/**' };
const setRules = (r: NewRule[]) => app.keys.setRules(POLICY, r, 'test', sys);
const row = (n: string) => app.channels.get(`chn_old_${n}`)!;
/** The bridge's last report: the bytes are staged as the hub stages them, then saved. Returns the channel afterwards. */
const save = async (n: string): Promise<ChannelRow> => {
  const b = Buffer.from(n), part = (app.channels as any).part(`chn_old_${n}`) as string;
  mkdirSync(dirname(part), { recursive: true });
  writeFileSync(part, b);
  await (app.channels as any).commitFile(row(n), sha(b));
  return row(n);
};
const file = (n: string) => join(vaultDir, 'Old', `${n}.md`);
const denials = () => app.db.prepare("SELECT action, path FROM resource_access_events WHERE credential_id=? AND decision='deny' ORDER BY created_at, rowid").all(CRED);
const refusedWith = (c: ChannelRow, reason: string) => {
  expect(c).toMatchObject({ status: 'failed', failure_reason: reason });
  if (reason === 'denied') expect(JSON.parse(c.result!)).toMatchObject({ message: NOT_ALLOWED });
};

describe('migration 0111', () => {
  it('adds from_app_credential_id and opened_with, NULL on a channel opened before', () => {
    const v = (app.db.prepare('SELECT version FROM schema_migrations WHERE version > 105 ORDER BY version').all() as { version: number }[]).map((r) => r.version);
    expect(v).toContain(111);
    const cols = app.db.prepare('PRAGMA table_info(data_channels)').all() as { name: string; notnull: number }[];
    expect(cols.find((c) => c.name === 'from_app_credential_id')).toMatchObject({ notnull: 0 });
    expect(cols.find((c) => c.name === 'opened_with')).toMatchObject({ notnull: 0 });
    for (const n of CHANNELS) {
      expect(row(n)).toMatchObject({ status: 'open', from_credential_id: CRED, from_app_credential_id: null, opened_with: null });
    }
  });

  it('FR-AUTHZ-04/AC1: such a channel is saved while the sender may still write, without channel.use or an app-key cap', async () => {
    setRules([tools, create]);
    expect(await save('allowed')).toMatchObject({ status: 'done', failure_reason: null });
    expect(readFileSync(file('allowed'), 'utf8')).toBe('allowed');
    // Not known to be opened with channel_open, so channel.use is not asked for again.
    expect(await save('nochan')).toMatchObject({ status: 'done', failure_reason: null });
    expect(denials()).toEqual([]);
  });

  it('FR-AUTHZ-04/AC1: its save is refused, and logged, once the sender\'s key is suspended', async () => {
    setRules([tools, create]);
    app.keys.setStatus(CRED, 'suspended', 'test', sys);
    try {
      refusedWith(await save('suspended'), 'denied');
      expect(existsSync(file('suspended'))).toBe(false);
      expect(denials()).toEqual([{ action: 'fs.create', path: target('suspended') }]);
    } finally { app.keys.setStatus(CRED, 'active', 'test', sys); }
  });

  it('FR-AUTHZ-01/AC2: its save is refused while the sender\'s team is paused', async () => {
    setRules([tools, create]);
    const team = app.teams.create({ name: 'Old channel pause', goal: 'g', members: [{ agent_id: AGENT, role: 'coordinator', credential_id: CRED }] }, sys);
    app.teams.start(team.id, sys);
    app.teams.pause(team.id, 'operator', sys);
    try {
      refusedWith(await save('paused'), 'paused');
      expect(existsSync(file('paused'))).toBe(false);
    } finally { app.teams.resume(team.id, sys); }
  });

  it('FR-AUTHZ-04/AC1: its save is refused once the write grant is revoked', async () => {
    setRules([tools, { effect: 'allow', actions: ['fs.read'], resource: 'path:/vault/Old/**' }]);
    refusedWith(await save('revoked'), 'denied');
    expect(existsSync(file('revoked'))).toBe(false);
    expect(denials()).toContainEqual({ action: 'fs.create', path: target('revoked') });
  });
});
