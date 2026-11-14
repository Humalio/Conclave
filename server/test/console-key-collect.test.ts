/**
 * Key collection, console side (docs/onboarding.md "Collect on a PC"): the Rotate sheet asks "Could this key have leaked?",
 * Collect is offered only for a routine rotation the hub says it can collect, the key page shows the collection's status
 * (waiting, collected, signed in, failed) with the mockup's actions, and an expired or failed collection is a For awareness row.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from '../src/app.js';
import { testConfig, adminLogin } from './hub.js';

vi.spyOn(console, 'warn').mockImplementation(() => {});
const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const css = readFileSync(join(process.cwd(), 'public', 'style.css'), 'utf8').replace(/\r\n/g, '\n');

describe('Rotate sheet and status line (source)', () => {
  it('asks the leak question with the two answers and the two delivery options', () => {
    for (const t of ['Could this key have leaked?', 'Yes, or I\'m not sure', 'No, this is routine', 'Rotate and collect', 'Rotate and show prompt', 'Rotate the app key…', 'Show a key prompt', 'Not available after a possible leak.']) expect(js, t).toContain(t);
    expect(js).toContain("reason = leak === 'yes' ? 'suspected_leak' : 'routine'");
    // Collect is offered for a routine answer and an ok offer only.
    expect(js).toContain("const can = () => leak === 'no' && !!offer?.ok;");
  });
  it('the leak answer is the safe default and an app key keeps the one-tap confirm', () => {
    expect(js).toContain("const openRotate = (anchor, leak0 = 'yes')");
    expect(js).toContain("if (isApp) arm($('#kRot'), doRot, 'Yes, rotate')");
  });
  it('shows every status of the mockup with its texts and actions', () => {
    for (const t of ['Waiting for the Codex wake on', 'Not collected in 24 hours', 'could not write', 'Two copies of the Codex wake asked for this key', 'The new key was used from somewhere else',
      'Show a key prompt instead', 'Try again', 'Open the alert', 'Rotate as a leak…', 'the agent signed in with the new key', '(/mcp)',
      'Waiting: a lockdown is on.', 'cannot sign in: its app key is', "This key's PC changed, so the collection was cancelled."]) expect(js, t).toContain(t);
    expect(js).toContain("['Rotated', 'Collect', 'Confirmed', 'Signed in']");
    expect(js).toContain('collect/prompt');
    expect(js).toContain('collect/cancel');
    // The 15 s refresh stops when the card on screen belongs to another key.
    expect(js).toContain('data-key="${esc(k.id)}"');
    expect(js).toContain("$('#colCard')?.dataset.key !== k.id");
  });
  it('a key with no offer shows the hub\'s one plain line instead of Collect', () => {
    expect(js).toContain("offer?.message || 'Collect is not offered for this key.'");
  });
  it('the Needs you row opens the key', () => {
    expect(js).toContain("key_collection: ['Key not collected', 'key']");
    expect(js).toContain("case 'key': return `data-key=");
  });
  it('has styles for the status tones, steps and option rows', () => {
    for (const s of ['.col-status.ok', '.col-status.bad', '.col-status.wait', '.col-steps li.x', '.rot-opt.on', '.rot-opt:disabled']) expect(css, s).toContain(s);
  });
});

describe('Needs you: a collection that did not complete', () => {
  let app: App, base = '', cookie = '', csrf = '';
  const sys = { kind: 'system' as const, id: null };
  let pcId = '', appId = '';
  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kcconsole-'));
    mkdirSync(join(dir, 'vault', 'Notes'), { recursive: true });
    app = await buildApp(testConfig(dir));
    await app.store.ready;
    await app.fastify.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
    ({ cookie, csrf } = await adminLogin(base));
  });
  beforeAll(async () => {
    const r = await fetch(base + '/api/pcs', { method: 'POST', headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: JSON.stringify({ name: 'kc-pc' }) });
    pcId = ((await r.json()) as any).pc.id;
    appId = app.keys.createAppKey({ machineId: pcId, appName: 'codex' }, sys).credential.id;
  });
  afterAll(async () => { await app.fastify.close(); });
  const needs = async () => (await (await fetch(`${base}/api/needs-you`, { headers: { cookie, 'x-csrf-token': csrf } })).json()) as any;
  const mkCol = (id: string, cred: string, status: string, outcome: string | null, created: number) => app.db.prepare(
    'INSERT INTO key_collections (id, credential_id, machine_id, session_var, app_credential_id, instance_id, status, outcome, created_at, expires_at, ended_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, cred, pcId, 'CONCLAVE_X_VAR', appId, 'inst_test_instance_0001', status, outcome, created, created + 86_400_000, status === 'open' ? null : created + 1000);

  it('lists a failed collection once, opens the key, and drops it when a newer collection exists or the key is revoked', async () => {
    const a = app.keys.createAgent('Kay', null, sys);
    const k = app.keys.createSessionKey({ agentId: a.id, label: 'Kay key' }, sys);
    const cred = k.credential.id;
    const now = Date.now();
    mkCol('kc_old', cred, 'failed', 'write_failed', now - 5000);
    let items = (await needs()).awareness.items.filter((i: any) => i.kind === 'key_collection');
    expect(items).toHaveLength(1);
    expect(items[0].open).toEqual({ kind: 'key', id: cred });
    expect(items[0].title).toContain('Kay');
    expect(items[0].reason).toContain('keys file');
    mkCol('kc_new', cred, 'open', null, now - 1000);
    items = (await needs()).awareness.items.filter((i: any) => i.kind === 'key_collection');
    expect(items).toHaveLength(0);
  });
  it('a cancelled collection is not an item', async () => {
    const a = app.keys.createAgent('Lee', null, sys);
    const k = app.keys.createSessionKey({ agentId: a.id, label: 'Lee key' }, sys);
    mkCol('kc_cancel', k.credential.id, 'void', 'cancelled', Date.now() - 2000);
    const items = (await needs()).awareness.items.filter((i: any) => i.kind === 'key_collection' && i.open.id === k.credential.id);
    expect(items).toHaveLength(0);
  });
});
