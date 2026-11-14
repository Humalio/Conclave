/**
 * Task attachments, part 2 (task-attachments design §6, §9 item 2): the console serves a task's attachment bytes
 * safely. The type comes from the bytes, never the name; HTML shows only with as=mockup and a CSP that allows no script,
 * and a headless browser opening a mockup at top level runs none; SVG and renamed files download; a removed set, a wrong
 * path or version and an unknown role answer not_found; only the operator gets bytes (a member is refused).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/app.js';
import { intakeOpen } from './intake.js';
import { testConfig, adminLogin } from './hub.js';

const sys = { kind: 'system' as const, id: null };
let app: App, base: string, appKey: string, admin: { cookie: string; csrf: string }, ana: { cookie: string; csrf: string };
const clients: Client[] = [];
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const MOCK = '<!doctype html><html><head><style>p{color:red}</style></head><body><p>Mockup</p><script>document.documentElement.setAttribute("data-ran","yes")</script></body></html>';
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
const FILES = [
  { path: 'shot.png', content: PNG, encoding: 'base64' },
  { path: 'mock.html', content: MOCK },
  { path: 'icon.svg', content: SVG },
  { path: 'renamed.png', content: '<!doctype html><script>alert(1)</script>' },
  { path: 'notes.md', content: '# notes' },
  { path: 'blob.bin', content: Buffer.from([0, 1, 2, 3, 255, 254]).toString('base64'), encoding: 'base64' },
  { path: 'sub dir/ünï.png', content: PNG, encoding: 'base64' },
];
const CSP_PLAIN = "sandbox; default-src 'none'";
const CSP_MOCKUP = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; frame-ancestors 'self'";

async function agent(label: string) {
  const a = app.keys.createAgent(label, null, sys);
  const key = app.keys.createSessionKey({ agentId: a.id, label }, sys);
  const client = new Client({ name: label, version: '1' });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${appKey}` } } }));
  const login = await client.callTool({ name: 'session_login', arguments: { session_key: key.secret } });
  const token = login.structuredContent!.session_token;
  return {
    id: a.id,
    call: async (name: string, args: Record<string, unknown> = {}) => {
      const r = await client.callTool({ name, arguments: { session_token: token, ...args } });
      return { error: !!r.isError, data: r.structuredContent as Record<string, any> };
    },
  };
}
const get = async (who: { cookie: string } | null, taskId: string, role: string, path: string, q: Record<string, string> = {}, h: Record<string, string> = {}) => {
  const r = await fetch(`${base}/api/tasks/${taskId}/attachments/${role}/file?${new URLSearchParams({ path, ...q })}`, { headers: { ...(who ? { cookie: who.cookie } : {}), ...h } });
  return { status: r.status, h: r.headers, buf: Buffer.from(await r.arrayBuffer()) };
};
const errOf = (r: { buf: Buffer }) => (JSON.parse(r.buf.toString('utf8')) as { error: string }).error;
let taskId = '';

async function taskWith(label: string, attachments: unknown[]): Promise<string> {
  const coord = await agent(`${label} coordinator`);
  const t = app.teams.create({ name: label, goal: 'Attachment bytes', grant_messaging: true, members: [{ agent_id: coord.id, role: 'coordinator' }] }, sys);
  app.teams.start(t.id, sys);
  const c = await coord.call('task_create', { team_id: t.id, title: `${label} task`, attachments });
  expect(c.error, JSON.stringify(c.data)).toBe(false);
  return c.data.task.id as string;
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-attbytes-'));
  const vaultDir = join(dir, 'vault'); mkdirSync(vaultDir);
  app = await buildApp(testConfig(dir, { dbFile: join(dir, 'data', 'test.db'), vaultDir, pepper: 'test', publicUrl: 'http://fixture.test', adminPassword: 'fixture password' }));
  intakeOpen(app);
  await app.store.ready;
  await app.fastify.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  appKey = app.keys.createAppKey({ machineId: app.keys.createMachine('fixture', null, sys).id, appName: 'test', maxLiveSessions: 50 }, sys).secret;
  admin = await adminLogin(base, undefined, 'fixture password');
  taskId = await taskWith('Bytes', FILES);
  // A member: a user the operator made, who must still get no bytes.
  const mk = await fetch(`${base}/api/users`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: admin.cookie, 'x-csrf-token': admin.csrf }, body: JSON.stringify({ username: 'ana' }) });
  const u = (await mk.json()) as { password: string };
  ana = await adminLogin(base, 'ana', u.password);
});
afterAll(async () => { await Promise.all(clients.map((c) => c.close())); await app.close(); });

describe('the operator opens a task\'s files', () => {
  it('shows the four image types inline, from the bytes, under a sandbox', async () => {
    const r = await get(admin, taskId, 'brief', 'shot.png');
    expect(r.status).toBe(200);
    expect(r.h.get('content-type')).toBe('image/png');
    expect(r.h.get('content-disposition')).toMatch(/^inline;/);
    expect(r.h.get('content-security-policy')).toBe(CSP_PLAIN);
    expect(r.h.get('x-content-type-options')).toBe('nosniff');
    expect(r.h.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(r.h.get('cache-control')).toBe('private, no-cache');
    expect(r.h.get('etag')).toMatch(/^"[^"]+"$/);
    expect(r.buf.equals(Buffer.from(PNG, 'base64'))).toBe(true);
    // A name with a space and non-ASCII letters is quoted and encoded in the disposition.
    const u = await get(admin, taskId, 'brief', 'sub dir/ünï.png');
    expect(u.status).toBe(200);
    expect(u.h.get('content-disposition')).toContain("filename*=UTF-8''%C3%BCn%C3%AF.png");
  });
  it('answers a conditional request with 304 and the same headers', async () => {
    const first = await get(admin, taskId, 'brief', 'shot.png');
    const again = await get(admin, taskId, 'brief', 'shot.png', {}, { 'if-none-match': first.h.get('etag')! });
    expect(again.status).toBe(304);
    expect(again.h.get('x-content-type-options')).toBe('nosniff');
  });
  it('never serves HTML inline without as=mockup', async () => {
    const r = await get(admin, taskId, 'brief', 'mock.html');
    expect(r.status).toBe(200);
    expect(r.h.get('content-type')).toBe('application/octet-stream');
    expect(r.h.get('content-disposition')).toMatch(/^attachment;/);
    expect(r.h.get('content-security-policy')).toBe(CSP_PLAIN);
    expect(r.h.get('x-content-type-options')).toBe('nosniff');
  });
  it('shows a mockup with as=mockup, under a CSP that allows no script, network or form', async () => {
    const r = await get(admin, taskId, 'brief', 'mock.html', { as: 'mockup' });
    expect(r.status).toBe(200);
    expect(r.h.get('content-type')).toBe('text/html; charset=utf-8');
    expect(r.h.get('content-disposition')).toMatch(/^inline;/);
    const csp = r.h.get('content-security-policy')!;
    expect(csp).toBe(CSP_MOCKUP);
    expect(csp).not.toMatch(/script-src|allow-scripts|allow-same-origin|connect-src|form-action/);
    expect(r.h.get('x-content-type-options')).toBe('nosniff');
    expect(r.buf.toString('utf8')).toBe(MOCK);
  });
  it('downloads SVG, text and binary files, whatever as says', async () => {
    for (const p of ['icon.svg', 'notes.md', 'blob.bin']) for (const q of [{}, { as: 'mockup' }]) {
      const r = await get(admin, taskId, 'brief', p, q);
      expect(r.status, p).toBe(200);
      expect(r.h.get('content-type'), p).toBe('application/octet-stream');
      expect(r.h.get('content-disposition'), p).toMatch(/^attachment;/);
      expect(r.h.get('content-security-policy'), p).toBe(CSP_PLAIN);
    }
  });
  it('judges a file by its bytes, not its name: HTML named .png is a download, an image never needs its extension', async () => {
    const r = await get(admin, taskId, 'brief', 'renamed.png');
    expect(r.h.get('content-type')).toBe('application/octet-stream');
    expect(r.h.get('content-disposition')).toMatch(/^attachment;/);
    // With as=mockup the sniffed type is HTML, so it is a mockup under the no-script CSP, never an image.
    const m = await get(admin, taskId, 'brief', 'renamed.png', { as: 'mockup' });
    expect(m.h.get('content-type')).toBe('text/html; charset=utf-8');
    expect(m.h.get('content-security-policy')).toBe(CSP_MOCKUP);
  });
});

describe('what the route refuses', () => {
  it('answers one not_found for a wrong role, path, version, task and for traversal', async () => {
    const miss = [
      await get(admin, taskId, 'submission', 'shot.png'), await get(admin, taskId, 'other', 'shot.png'), await get(admin, taskId, 'brief', 'nope.png'),
      await get(admin, taskId, 'brief', 'shot.png', { v: '9' }), await get(admin, taskId, 'brief', 'shot.png', { v: 'x' }), await get(admin, taskId, 'brief', 'shot.png', { v: '0' }),
      await get(admin, 'tsk_nope', 'brief', 'shot.png'), await get(admin, taskId, 'brief', '../shot.png'), await get(admin, taskId, 'brief', ''),
    ];
    for (const r of miss) { expect(r.status).toBe(404); expect(errOf(r)).toBe('not_found'); }
    expect((await get(admin, taskId, 'brief', 'shot.png', { v: '1' })).status).toBe(200);
  });
  it('serves a version of ten or more (v is read as a whole number)', async () => {
    const id = await taskWith('Many versions', [{ path: 'a.png', content: PNG, encoding: 'base64' }]);
    const sh = app.taskAttachments.setOf(id, 'brief')!;
    const v1 = app.shares.version(sh.id, 1)!;
    for (let n = 2; n <= 12; n++) app.db.prepare("INSERT INTO share_versions(share_id,version,note,manifest,total_bytes,upload_kind,status,created_at,added_by,copied_from) VALUES (?,?,?,?,?,'inline','published',?,?,NULL)").run(sh.id, n, null, v1.manifest, v1.total_bytes, Date.now(), 'admin');
    for (const v of ['2', '10', '11', '12']) expect((await get(admin, id, 'brief', 'a.png', { v })).status, 'v=' + v).toBe(200);
    expect((await get(admin, id, 'brief', 'a.png', { v: '13' })).status).toBe(404);
    expect((await get(admin, id, 'brief', 'a.png')).status).toBe(200);
  });
  it('refuses a member and a caller with no session; neither gets a byte', async () => {
    const m = await get(ana, taskId, 'brief', 'shot.png');
    expect(m.status).toBe(403);
    expect(m.buf.includes(Buffer.from(PNG, 'base64'))).toBe(false);
    expect((await get(null, taskId, 'brief', 'shot.png')).status).toBe(401);
  });
  it('answers not_found once the operator removed the set', async () => {
    const id = await taskWith('Removed', [{ path: 'a.png', content: PNG, encoding: 'base64' }]);
    expect((await get(admin, id, 'brief', 'a.png')).status).toBe(200);
    app.shares.close(app.taskAttachments.setOf(id, 'brief')!.id, 'revoked');
    for (const q of [{}, { as: 'mockup' }, { v: '1' }]) {
      const r = await get(admin, id, 'brief', 'a.png', q);
      expect(r.status).toBe(404);
      expect(errOf(r)).toBe('not_found');
    }
  });
});

// The proof that matters: a browser opening the mockup URL by itself, at top level, runs none of its script. A small
// proxy adds the operator's cookie (a page opened by hand has it); one path leaves the hub's CSP off, so the same
// marker script does run there, which shows the check can fail.
const CHROME = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => p && existsSync(p));
describe('a mockup opened at top level in a headless browser', () => {
  let proxy: http.Server, port = 0, mockTask = '';
  beforeAll(async () => {
    mockTask = await taskWith('Browser', [{ path: 'mock.html', content: MOCK }]);
    proxy = http.createServer((req, res) => {
      void (async () => {
        const bare = req.url!.startsWith('/bare');
        const r = await fetch(base + (bare ? req.url!.slice(5) : req.url!), { headers: { cookie: admin.cookie } });
        const body = Buffer.from(await r.arrayBuffer());
        r.headers.forEach((v, k) => { if (!['content-encoding', 'transfer-encoding', 'content-length'].includes(k) && !(bare && k === 'content-security-policy')) res.setHeader(k, v); });
        res.statusCode = r.status; res.end(body);
      })();
    });
    await new Promise<void>((ok) => proxy.listen(0, '127.0.0.1', ok));
    port = (proxy.address() as { port: number }).port;
  });
  afterAll(() => { proxy?.close(); });
  const dump = (url: string) => new Promise<string>((ok, bad) => {
    const prof = mkdtempSync(join(tmpdir(), 'ah-chrome-'));
    execFile(CHROME!, ['--headless=new', '--disable-gpu', '--no-sandbox', '--disable-extensions', `--user-data-dir=${prof}`, '--virtual-time-budget=4000', '--dump-dom', url], { timeout: 60_000, maxBuffer: 4_000_000 }, (e, out) => (e ? bad(e) : ok(out)));
  });
  it.skipIf(!CHROME)('runs no script, while the same page without the hub\'s CSP does', async () => {
    const path = `/api/tasks/${mockTask}/attachments/brief/file?path=mock.html&as=mockup`;
    const guarded = await dump(`http://127.0.0.1:${port}${path}`);
    expect(guarded).toContain('Mockup');
    expect(guarded).not.toMatch(/<html[^>]*data-ran/);
    const bare = await dump(`http://127.0.0.1:${port}/bare${path}`);
    expect(bare).toMatch(/<html[^>]*data-ran="yes"/);
  }, 120_000);
});
