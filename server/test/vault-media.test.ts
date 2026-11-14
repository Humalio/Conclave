/**
 * Vault media (docs/vault.md, "Media and attachments"): one authenticated byte path for the operator and members.
 * Inline types checked from the bytes, single bounded ranges (200, 206, 416), HEAD, revision binding, the private cache
 * and sandbox headers, path containment, grants and restricted folders checked on every range, may_export for originals,
 * and the audit rows of an external playback and a member's download.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from '../src/app.js';
import type { Config } from '../src/config.js';
import { totp } from '../src/util/crypto.js';
import { testConfig, adminLogin, ADMIN_PASSWORD } from './hub.js';
import { sniffInline, parseRange, disposition, MAX_RANGE_BYTES } from '../src/vault/media.js';

let app: App, base = '', vaultDir = '';
type S = { cookie: string; csrf: string };
let admin: S, ana: S, bea: S, carl: S, jonas: S;
const ids: Record<string, string> = {};
const PW = 'vault media password 1234';
const get = async (who: S, path: string, o: { method?: string; headers?: Record<string, string>; q?: Record<string, string> } = {}) => {
  const r = await fetch(`${base}/api/vault/media?${new URLSearchParams({ path, ...(o.q ?? {}) })}`, { method: o.method ?? 'GET', headers: { cookie: who.cookie, ...(o.headers ?? {}) } });
  const buf = Buffer.from(await r.arrayBuffer());
  return { status: r.status, h: r.headers, buf, json: (() => { try { return JSON.parse(buf.toString('utf8')); } catch { return null; } })() as any };
};
const call = async (who: S, method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie: who.cookie, 'x-csrf-token': who.csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, body: (() => { try { return JSON.parse(text); } catch { return null; } })() as any };
};
const rows = (action: string) => (app.db.prepare('SELECT * FROM audit_events WHERE action=? ORDER BY id').all(action) as any[]).map((r) => ({ ...r, details: JSON.parse(r.details ?? '{}') }));

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(2000, 7)]);
const MP3 = Buffer.concat([Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00', 'latin1'), Buffer.from(Array.from({ length: 300_000 }, (_, i) => (i * 31) % 251))]);
const WAV = (n: number) => { const b = Buffer.alloc(n, 3); b.write('RIFF', 0, 'latin1'); b.write('WAVE', 8, 'latin1'); return b; };
const put = (rel: string, bytes: Buffer | string) => { const abs = join(vaultDir, ...rel.split('/')); mkdirSync(join(abs, '..'), { recursive: true }); writeFileSync(abs, bytes); };
const V = (rel: string) => `/vault/${rel}`;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahmedia-'));
  vaultDir = join(dir, 'vault');
  mkdirSync(vaultDir, { recursive: true });
  put('Media/photo.png', PNG);
  put('Media/clip.mp3', MP3);
  put('Media/long.wav', WAV(MAX_RANGE_BYTES + 1000));
  put('Media/fake.png', '<html><body><script>alert(1)</script></body></html>');
  put('Media/icon.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  put('Media/empty.mp3', Buffer.alloc(0));
  put('Media/Restricted/secret.png', PNG);
  put('Other/elsewhere.png', PNG);
  put('.obsidian/hidden.png', PNG);
  const config: Config = testConfig(dir);
  app = await buildApp(config);
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  admin = await adminLogin(base, 'admin', ADMIN_PASSWORD);
  ids.p1 = (await call(admin, 'POST', '/projects', { key: 'MED', name: 'Media' })).body.project.id;
  ids.p2 = (await call(admin, 'POST', '/projects', { key: 'SEC', name: 'Secret' })).body.project.id;
  app.db.prepare('UPDATE projects SET vault_roots=? WHERE id IN (?,?)').run(JSON.stringify(['/Media/']), ids.p1, ids.p2);
  app.db.prepare('INSERT INTO vault_folder_flags(path,restricted,set_at) VALUES (?,1,?)').run('/Media/Restricted/', Date.now());
  const media = (mayExport: boolean, project = ids.p1!, folders = ['/Media/']) => ({ project_id: project, components: ['vault'], vault_folders: folders, may_export: mayExport });
  const mkUser = async (username: string, over: Record<string, unknown>, grants: unknown[]): Promise<S> => {
    const c = await call(admin, 'POST', '/users', { username, ...over });
    const first = await adminLogin(base, username, c.body.password);
    let secret: string | undefined;
    if (c.body.user.totp_required) {
      secret = (await call(first, 'POST', '/totp/enroll', {})).body.secret as string;
      expect((await call(first, 'POST', '/totp/confirm', { code: totp(secret, Date.now()) })).status).toBe(200);
    }
    expect((await call(first, 'POST', '/me/password', { current: c.body.password, new: PW })).status).toBe(200);
    expect((await call(admin, 'PUT', `/users/${c.body.user.id}/grants`, { grants })).status).toBe(200);
    ids[username] = c.body.user.id;
    return adminLogin(base, username, PW, secret ? totp(secret, Date.now(), 1) : undefined);
  };
  ana = await mkUser('ana', {}, [media(true)]);
  bea = await mkUser('bea', {}, [media(false)]);
  // Carl: exports on the parent folder, none on the restricted folder his second grant names.
  carl = await mkUser('carl', {}, [media(true), media(false, ids.p2!, ['/Media/Restricted/'])]);
  jonas = await mkUser('jonas', { external: true, org: 'Partner' }, [media(true)]);
});
afterAll(async () => { await app?.close(); });

describe('types from the bytes', () => {
  it('recognizes raster images and supported audio, nothing else', () => {
    expect(sniffInline(PNG)?.mime).toBe('image/png');
    expect(sniffInline(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))?.mime).toBe('image/jpeg');
    expect(sniffInline(Buffer.from('GIF89a......'))?.mime).toBe('image/gif');
    expect(sniffInline(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))?.mime).toBe('image/webp');
    expect(sniffInline(WAV(64))).toEqual({ mime: 'audio/wav', kind: 'audio' });
    expect(sniffInline(Buffer.from('fLaC\0\0\0\x22'))?.mime).toBe('audio/flac');
    expect(sniffInline(MP3)?.mime).toBe('audio/mpeg');
    expect(sniffInline(Buffer.from([0xff, 0xfb, 0x90, 0x64]))?.mime).toBe('audio/mpeg');
    const ogg = (codec: string) => Buffer.concat([Buffer.from('OggS'), Buffer.alloc(24), Buffer.from(codec, 'latin1'), Buffer.alloc(16)]);
    expect(sniffInline(ogg('OpusHead'))?.mime).toBe('audio/ogg');
    expect(sniffInline(ogg('\x01vorbis'))?.mime).toBe('audio/ogg');
    expect(sniffInline(ogg('\x80theora'))).toBeNull();
    const mp4 = (brand: string) => Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftyp' + brand), Buffer.alloc(20)]);
    expect(sniffInline(mp4('M4A '))?.mime).toBe('audio/mp4');
    expect(sniffInline(mp4('isom'))).toBeNull(); // may be video: attachment only
    for (const active of ['<svg xmlns="http://www.w3.org/2000/svg"/>', '<!doctype html><html>', '%PDF-1.7', '']) expect(sniffInline(Buffer.from(active))).toBeNull();
    expect(sniffInline(Buffer.from([0xff, 0xf1, 0x50, 0x80]))).toBeNull(); // AAC ADTS frame, not Layer III
  });

  it('parses one bounded range and refuses what cannot be satisfied', () => {
    expect(parseRange(undefined, 100)).toEqual({ kind: 'none' });
    expect(parseRange('bytes=0-9', 100)).toEqual({ kind: 'range', start: 0, end: 9 });
    expect(parseRange('bytes=90-', 100)).toEqual({ kind: 'range', start: 90, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ kind: 'range', start: 90, end: 99 });
    expect(parseRange('bytes=-500', 100)).toEqual({ kind: 'range', start: 0, end: 99 });
    expect(parseRange('bytes=50-5000', 100)).toEqual({ kind: 'range', start: 50, end: 99 });
    expect(parseRange('bytes=0-', 100, 10)).toEqual({ kind: 'range', start: 0, end: 9 });
    expect(parseRange('bytes=100-', 100)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRange('bytes=-0', 100)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRange('bytes=0-1', 0)).toEqual({ kind: 'unsatisfiable' });
    for (const ignored of ['bytes=0-1,5-9', 'bytes=9-1', 'items=0-1', 'bytes=-', 'bytes=x-1']) expect(parseRange(ignored, 100)).toEqual({ kind: 'none' });
  });

  it('names the file in Content-Disposition without breaking the header', () => {
    expect(disposition('attachment', 'Café "x".png')).toBe(`attachment; filename="Caf_ _x_.png"; filename*=UTF-8''Caf%C3%A9%20%22x%22.png`);
  });
});

describe('the byte path for the operator', () => {
  it('serves a recognized image inline with the private, sandboxed headers', async () => {
    const r = await get(admin, V('Media/photo.png'));
    expect(r.status).toBe(200);
    expect(r.buf.equals(PNG)).toBe(true);
    expect(r.h.get('content-type')).toBe('image/png');
    expect(r.h.get('content-length')).toBe(String(PNG.length));
    expect(r.h.get('cache-control')).toBe('private, no-cache');
    expect(r.h.get('x-content-type-options')).toBe('nosniff');
    expect(r.h.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(r.h.get('content-security-policy')).toBe("sandbox; default-src 'none'");
    expect(r.h.get('accept-ranges')).toBe('bytes');
    expect(r.h.get('content-disposition')).toMatch(/^inline; filename="photo.png"/);
    expect(r.h.get('etag')).toBe(`"${app.store.fileByPath('Media/photo.png')!.current_revision}"`);
  });

  it('answers HEAD with the metadata and no bytes', async () => {
    const r = await get(admin, V('Media/clip.mp3'), { method: 'HEAD' });
    expect(r.status).toBe(200);
    expect(r.h.get('content-type')).toBe('audio/mpeg');
    expect(r.h.get('content-length')).toBe(String(MP3.length));
    expect(r.buf.length).toBe(0);
  });

  it('serves single ranges as 206, caps them, and refuses one past the end with 416', async () => {
    const a = await get(admin, V('Media/clip.mp3'), { headers: { range: 'bytes=1000-1999' } });
    expect(a.status).toBe(206);
    expect(a.h.get('content-range')).toBe(`bytes 1000-1999/${MP3.length}`);
    expect(a.h.get('content-length')).toBe('1000');
    expect(a.buf.equals(MP3.subarray(1000, 2000))).toBe(true);
    const tail = await get(admin, V('Media/clip.mp3'), { headers: { range: 'bytes=-10' } });
    expect(tail.status).toBe(206);
    expect(tail.buf.equals(MP3.subarray(MP3.length - 10))).toBe(true);
    const long = await get(admin, V('Media/long.wav'), { headers: { range: 'bytes=0-' } });
    expect(long.status).toBe(206);
    expect(long.h.get('content-range')).toBe(`bytes 0-${MAX_RANGE_BYTES - 1}/${MAX_RANGE_BYTES + 1000}`);
    expect(long.buf.length).toBe(MAX_RANGE_BYTES);
    const past = await get(admin, V('Media/clip.mp3'), { headers: { range: `bytes=${MP3.length}-` } });
    expect(past.status).toBe(416);
    expect(past.h.get('content-range')).toBe(`bytes */${MP3.length}`);
    expect(past.buf.length).toBe(0);
    const several = await get(admin, V('Media/clip.mp3'), { headers: { range: 'bytes=0-1,5-9' } });
    expect(several.status).toBe(200);
    expect(several.buf.length).toBe(MP3.length);
    const empty = await get(admin, V('Media/empty.mp3'));
    expect(empty.status).toBe(200);
    expect(empty.h.get('content-length')).toBe('0');
  });

  it('serves a disguised active file, SVG and as=attachment only as attachments', async () => {
    for (const p of ['Media/fake.png', 'Media/icon.svg']) {
      const r = await get(admin, V(p));
      expect(r.status).toBe(200);
      expect(r.h.get('content-type')).toBe('application/octet-stream');
      expect(r.h.get('content-disposition')).toMatch(/^attachment;/);
      expect(r.h.get('content-security-policy')).toBe("sandbox; default-src 'none'");
    }
    const r = await get(admin, V('Media/photo.png'), { q: { as: 'attachment' } });
    expect(r.h.get('content-type')).toBe('application/octet-stream');
    expect(r.h.get('content-disposition')).toMatch(/^attachment; filename="photo.png"/);
  });

  it('binds reads to a revision: rev, If-Range and If-None-Match', async () => {
    const etag = (await get(admin, V('Media/clip.mp3'), { method: 'HEAD' })).h.get('etag')!;
    const rev = etag.replace(/"/g, '');
    expect((await get(admin, V('Media/clip.mp3'), { q: { rev }, headers: { range: 'bytes=0-9' } })).status).toBe(206);
    const stale = await get(admin, V('Media/clip.mp3'), { q: { rev: 'sha256:' + '0'.repeat(64) }, headers: { range: 'bytes=0-9' } });
    expect(stale.status).toBe(409);
    expect(stale.json).toMatchObject({ error: 'conflict', reason: 'changed' });
    expect(stale.h.get('content-range')).toBeNull();
    const other = await get(admin, V('Media/clip.mp3'), { headers: { range: 'bytes=0-9', 'if-range': '"sha256:old"' } });
    expect(other.status).toBe(200);
    expect(other.buf.length).toBe(MP3.length);
    const same = await get(admin, V('Media/clip.mp3'), { headers: { range: 'bytes=0-9', 'if-range': etag } });
    expect(same.status).toBe(206);
    const cached = await get(admin, V('Media/clip.mp3'), { headers: { 'if-none-match': etag } });
    expect(cached.status).toBe(304);
    expect(cached.buf.length).toBe(0);
  });

  it('refuses a changed file to an old revision before any byte', async () => {
    put('Media/changing.wav', WAV(4000));
    const rev = (await get(admin, V('Media/changing.wav'), { method: 'HEAD' })).h.get('etag')!.replace(/"/g, '');
    put('Media/changing.wav', WAV(5000));
    const r = await get(admin, V('Media/changing.wav'), { q: { rev }, headers: { range: 'bytes=0-99' } });
    expect(r.status).toBe(409);
    expect(r.json.reason).toBe('changed');
    const now = await get(admin, V('Media/changing.wav'), { method: 'HEAD' });
    expect(now.h.get('content-length')).toBe('5000');
    expect(now.h.get('etag')).not.toBe(`"${rev}"`);
  });

  it('keeps the vault containment: escapes, hidden folders, folders and missing files', async () => {
    expect((await get(admin, '/vault/../secret.png')).status).toBe(400);
    expect((await get(admin, '/elsewhere/photo.png')).status).toBe(400);
    expect((await get(admin, V('.obsidian/hidden.png'))).status).toBe(404);
    expect((await get(admin, V('Media/missing.png'))).status).toBe(404);
    expect((await get(admin, V('Media'))).status).toBe(400);
  });

  it('records nothing for the operator', async () => {
    await get(admin, V('Media/photo.png'), { q: { as: 'attachment' } });
    expect(rows('export.read')).toEqual([]);
    expect(rows('vault.preview')).toEqual([]);
  });
});

describe('the byte path for members', () => {
  it('needs the file itself to be visible: outside the grant and in an unnamed restricted folder answer like missing', async () => {
    for (const p of ['Other/elsewhere.png', 'Media/Restricted/secret.png', 'Media/missing.png']) {
      const r = await get(ana, V(p), { headers: { range: 'bytes=0-9' } });
      expect(r.status, p).toBe(404);
      expect(r.json.error).toBe('not_found');
      expect(r.h.get('content-range')).toBeNull();
    }
    expect((await get(admin, V('Media/Restricted/secret.png'))).status).toBe(200);
  });

  it('needs may_export for inline playback and for attachments, explained in the answer', async () => {
    for (const q of [{}, { as: 'attachment' }]) {
      const r = await get(bea, V('Media/photo.png'), { q });
      expect(r.status).toBe(403);
      expect(r.json).toMatchObject({ error: 'export_denied', message: 'Playing or downloading the original needs export permission on this folder.' });
      expect(r.h.get('content-range')).toBeNull();
      expect(r.buf.includes(PNG.subarray(0, 8))).toBe(false);
    }
    expect((await get(bea, V('Media/photo.png'), { method: 'HEAD' })).status).toBe(403);
    // Text previews keep the preview permission.
    expect((await call(bea, 'GET', `/vault/preview?path=${encodeURIComponent(V('Media/icon.svg'))}`)).status).toBe(200);
    expect((await get(ana, V('Media/photo.png'))).status).toBe(200);
  });

  it('inside a restricted folder only the grant that names it counts for export', async () => {
    expect((await call(carl, 'GET', `/vault/preview?path=${encodeURIComponent(V('Media/Restricted/secret.png'))}`)).status).toBe(200);
    expect((await get(carl, V('Media/Restricted/secret.png'))).json?.error).toBe('export_denied');
    expect((await get(carl, V('Media/photo.png'))).status).toBe(200);
  });

  it('a grant revoked between two ranges denies the next range before any size or byte', async () => {
    const who = await (async () => {
      const c = await call(admin, 'POST', '/users', { username: 'dora' });
      const first = await adminLogin(base, 'dora', c.body.password);
      await call(first, 'POST', '/me/password', { current: c.body.password, new: PW });
      ids.dora = c.body.user.id;
      await call(admin, 'PUT', `/users/${c.body.user.id}/grants`, { grants: [{ project_id: ids.p1, components: ['vault'], vault_folders: ['/Media/'], may_export: true }] });
      return adminLogin(base, 'dora', PW);
    })();
    const first = await get(who, V('Media/clip.mp3'), { headers: { range: 'bytes=0-99' } });
    expect(first.status).toBe(206);
    // Export taken away: the next seek is refused.
    await call(admin, 'PUT', `/users/${ids.dora}/grants`, { grants: [{ project_id: ids.p1, components: ['vault'], vault_folders: ['/Media/'], may_export: false }] });
    const noExport = await get(who, V('Media/clip.mp3'), { headers: { range: 'bytes=100-199' } });
    expect(noExport.status).toBe(403);
    // Folder access taken away: the next range answers like a missing file.
    await call(admin, 'PUT', `/users/${ids.dora}/grants`, { grants: [] });
    for (const method of ['GET', 'HEAD']) {
      const r = await get(who, V('Media/clip.mp3'), { method, headers: { range: 'bytes=200-299' } });
      expect(r.status, method).toBe(404);
      expect(r.h.get('content-range')).toBeNull();
      expect(r.h.get('etag')).toBeNull();
      expect(r.h.get('accept-ranges')).toBeNull();
      expect(r.h.get('content-length')).not.toBe(String(MP3.length));
    }
  });

  it("records an external user's playback once and a member's download as export.read", async () => {
    const before = rows('vault.preview').length;
    expect((await get(jonas, V('Media/clip.mp3'), { headers: { range: 'bytes=0-' } })).status).toBe(206);
    expect((await get(jonas, V('Media/clip.mp3'), { headers: { range: 'bytes=5000-' } })).status).toBe(206);
    const pv = rows('vault.preview').slice(before);
    expect(pv).toHaveLength(1);
    expect(pv[0]).toMatchObject({ actor_id: ids.jonas, target_kind: 'vault_file', target_id: V('Media/clip.mp3') });
    expect(pv[0]!.details).toMatchObject({ path: V('Media/clip.mp3'), bytes: MP3.length, media: true });
    // A non-external member's playback is not audited; her download is.
    await get(ana, V('Media/clip.mp3'));
    expect(rows('vault.preview').slice(before)).toHaveLength(1);
    const dl = await get(ana, V('Media/photo.png'), { q: { as: 'attachment' } });
    expect(dl.status).toBe(200);
    const [e] = rows('export.read').filter((x) => x.actor_id === ids.ana);
    expect(e).toMatchObject({ actor_role: 'member', target_kind: 'vault_file', target_id: V('Media/photo.png') });
    expect(e!.details).toMatchObject({ what: 'vault_file', path: V('Media/photo.png'), bytes: PNG.length });
    // A refused request records nothing.
    const n = rows('export.read').length;
    await get(bea, V('Media/photo.png'), { q: { as: 'attachment' } });
    expect(rows('export.read').length).toBe(n);
  });

  it('records a download that skips byte 0, once per file revision, with the file size', async () => {
    const mine = () => rows('export.read').filter((x) => x.actor_id === ids.ana && x.target_id === V('Media/clip.mp3'));
    expect(mine()).toEqual([]);
    const r = await get(ana, V('Media/clip.mp3'), { q: { as: 'attachment' }, headers: { range: 'bytes=1-' } });
    expect(r.status).toBe(206);
    expect(mine()).toHaveLength(1);
    expect(mine()[0]!.details).toMatchObject({ what: 'vault_file', path: V('Media/clip.mp3'), bytes: MP3.length });
    // The rest of the same download, and a fresh one soon after, add no row.
    await get(ana, V('Media/clip.mp3'), { q: { as: 'attachment' }, headers: { range: 'bytes=5000-' } });
    await get(ana, V('Media/clip.mp3'), { q: { as: 'attachment' } });
    expect(mine()).toHaveLength(1);
    // An external user's playback that starts mid-file is a preview row too.
    const pv = () => rows('vault.preview').filter((x) => x.actor_id === ids.jonas && x.target_id === V('Media/photo.png'));
    expect(pv()).toEqual([]);
    expect((await get(jonas, V('Media/photo.png'), { headers: { range: 'bytes=8-' } })).status).toBe(206);
    expect(pv()).toHaveLength(1);
    expect(pv()[0]!.details).toMatchObject({ bytes: PNG.length, media: true });
  });

  it('records nothing for HEAD, 304 or 416, where no bytes are sent', async () => {
    const all = () => rows('export.read').length + rows('vault.preview').length;
    const n = all();
    // A member's HEAD of an attachment-only file (the player's probe) and an external user's HEAD of an image.
    expect((await get(ana, V('Media/icon.svg'), { method: 'HEAD' })).status).toBe(200);
    const h = await get(jonas, V('Media/fake.png'), { method: 'HEAD' });
    expect(h.status).toBe(200);
    expect((await get(jonas, V('Media/fake.png'), { headers: { 'if-none-match': h.h.get('etag')! } })).status).toBe(304);
    expect((await get(ana, V('Media/icon.svg'), { headers: { range: 'bytes=999999-' } })).status).toBe(416);
    expect(all()).toBe(n);
    // The first request that sends bytes is the one recorded.
    expect((await get(ana, V('Media/icon.svg'))).status).toBe(200);
    expect(rows('export.read').filter((x) => x.actor_id === ids.ana && x.target_id === V('Media/icon.svg'))).toHaveLength(1);
  });
});
