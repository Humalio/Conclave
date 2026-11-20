/**
 * The real `api` of the mirror engine (syncengine.mjs): the vault-sync routes of one hub over the pinned connection (or the
 * key service's relay at the hardened level, where `authorization` holds a placeholder). No redirect is followed; a
 * transport failure rejects with a fixed reason. A key never appears in a log or an error.
 */
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { send, reasonOfError } from './hubclient.mjs';

const LIMIT = 64 * 1024 * 1024; // the vault file size limit: a longer answer is cut off, not waited for
const relayReason = (hub, r) => (hub.relay && r.statusCode === 502 && /^(tls_refused|hub_unreachable)$/.test(String(r.headers['x-conclave-relay'] ?? '')) ? r.headers['x-conclave-relay'] : null);
const failWith = (rej) => (e) => rej(Object.assign(new Error(e?.message ?? String(e)), { reason: e?.reason ?? reasonOfError(e) }));

/** `authorization` is the whole header value (`Bearer <key>` or its placeholder), or null for the unauthenticated pairing routes. */
export function makeApi(hub, authorization, { timeoutMs = 30_000, signal } = {}) {
  const headers = (extra = {}) => ({ accept: 'application/json', ...(authorization ? { authorization } : {}), ...extra });
  return {
    json(method, path, body) {
      return new Promise((res, rej) => {
        const fail = failWith(rej);
        const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
        const req = send(hub, `${hub.origin}${path}`, { method, timeout: timeoutMs, headers: headers(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}) }, (r) => {
          const rr = relayReason(hub, r); if (rr) { r.resume(); return fail({ message: 'the key service could not reach the hub', reason: rr }); }
          if (r.statusCode >= 300 && r.statusCode < 400) { r.resume(); return fail({ message: `redirect ${r.statusCode} not followed`, reason: 'hub_unreachable' }); }
          let raw = '';
          r.setEncoding('utf8');
          r.on('data', (c) => { raw += c; if (raw.length > 8 * 1024 * 1024) r.destroy(new Error('answer too large')); });
          r.on('error', fail);
          r.on('end', () => { let json = null; try { json = raw ? JSON.parse(raw) : null; } catch { json = null; } res({ status: r.statusCode, json }); });
        });
        req.on('timeout', () => req.destroy(Object.assign(new Error('no answer in time'), { code: 'ETIMEDOUT' })));
        const stop = () => req.destroy(new Error('stopped'));
        signal?.addEventListener('abort', stop, { once: true });
        req.on('close', () => signal?.removeEventListener('abort', stop));
        req.on('error', fail);
        req.end(data ?? undefined);
      });
    },
    /** Streams a file's bytes into `dest`, hashing as it goes. Nothing is left at `dest` unless the answer is 200 and whole. */
    download(path, dest) {
      return new Promise((res, rej) => {
        const fail = failWith(rej);
        const req = send(hub, `${hub.origin}${path}`, { method: 'GET', timeout: timeoutMs, headers: headers({ accept: 'application/octet-stream' }) }, (r) => {
          const rr = relayReason(hub, r); if (rr) { r.resume(); return fail({ message: 'the key service could not reach the hub', reason: rr }); }
          if (r.statusCode !== 200) { r.resume(); return r.on('end', () => res({ status: r.statusCode })); }
          const h = createHash('sha256'), out = createWriteStream(dest, { mode: 0o600 });
          let bytes = 0, bad = false;
          r.on('data', (c) => { h.update(c); bytes += c.length; if (bytes > LIMIT && !bad) { bad = true; r.destroy(); out.destroy(); res({ status: 413, bytes }); } });
          r.on('error', (e) => { if (bad) return; bad = true; out.destroy(); fail(e); });
          r.on('aborted', () => { if (bad) return; bad = true; out.destroy(); fail({ message: 'the transfer was cut', reason: 'hub_unreachable' }); });
          out.on('error', (e) => { bad = true; r.destroy(); rej(e); });
          out.on('finish', () => { if (!bad) res({ status: 200, revision: String(r.headers['x-conclave-revision'] ?? ''), sha256: h.digest('hex'), bytes }); });
          r.pipe(out);
        });
        req.on('timeout', () => req.destroy(Object.assign(new Error('no answer in time'), { code: 'ETIMEDOUT' })));
        const stop = () => req.destroy(new Error('stopped'));
        signal?.addEventListener('abort', stop, { once: true });
        req.on('close', () => signal?.removeEventListener('abort', stop));
        req.on('error', fail);
        req.end();
      });
    },
  };
}
