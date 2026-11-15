/**
 * The connector's only way to the hub: pinned HTTPS (docs/connector.md, review-v2 §1 point 7).
 *
 * - The origin must be https. There is no plain-HTTP mode and no fallback.
 * - Only the hub's own CA, from the key file section and checked against its recorded fingerprint, is trusted. The
 *   operating system's certificate store is never consulted (Node's `ca` option replaces it), so nothing is installed in
 *   the OS and nothing needs a restart.
 * - A redirect is never followed: it would send the app key to another address.
 * - A failure is mapped to a fixed reason (tls_refused, hub_unreachable), never to the hub's or the library's text.
 */
import https from 'node:https';
import { Readable } from 'node:stream';
import { caFingerprint, normalizeOrigin } from './keyfile.mjs';

const TLS_CODES = new Set(['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'CERT_UNTRUSTED', 'CERT_REVOKED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'HOSTNAME_MISMATCH', 'ERR_SSL_WRONG_VERSION_NUMBER', 'ERR_SSL_PACKET_LENGTH_TOO_LONG', 'EPROTO']);
/** The reason code for a transport error. */
export const reasonOfError = (e) => (TLS_CODES.has(e?.code) || /certificate|tls|ssl/i.test(String(e?.message ?? '')) ? 'tls_refused' : 'hub_unreachable');

/** A hub connection from a key-file section: `{ok: true, hub}` or `{ok: false, reason}` before any byte is sent. */
export function connect(section) {
  const origin = normalizeOrigin(section?.origin);
  if (!origin) return { ok: false, reason: 'not_https' };
  if (caFingerprint(section.ca_pem) !== section.ca_sha256) return { ok: false, reason: 'ca_changed' };
  return { ok: true, hub: { origin, url: `${origin}/mcp`, agent: new https.Agent({ ca: section.ca_pem, keepAlive: false, minVersion: 'TLSv1.2', rejectUnauthorized: true }) } };
}

/**
 * One POST of a JSON-RPC body. Resolves `{status, messages, sessionId, body}`: `messages` are the JSON-RPC replies (JSON or
 * SSE); for a non-200 answer `body` is the hub's own JSON, kept for the relay to pass on. Rejects with an error whose
 * `reason` is a fixed reason code.
 */
export function post(hub, body, headers, timeoutMs) {
  return new Promise((res, rej) => {
    const fail = (e) => rej(Object.assign(new Error(e?.message ?? String(e)), { reason: e?.reason ?? reasonOfError(e) }));
    const req = https.request(hub.url, { method: 'POST', agent: hub.agent, timeout: timeoutMs, rejectUnauthorized: true,
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'content-length': Buffer.byteLength(body), ...headers } }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400) { r.resume(); return fail({ message: `redirect ${r.statusCode} not followed`, reason: 'hub_unreachable' }); }
      let raw = '';
      r.setEncoding('utf8');
      r.on('data', (c) => { raw += c; });
      r.on('error', fail);
      r.on('end', () => {
        if (r.statusCode !== 200) {
          let b = null;
          try { b = /^\s*[[{]/.test(raw) ? JSON.parse(raw) : null; } catch { b = null; }
          return res({ status: r.statusCode, messages: [], sessionId: null, body: b });
        }
        const messages = [];
        try {
          if (raw.trim() === '') { /* nothing */ } else if (/^\s*[[{]/.test(raw)) { const j = JSON.parse(raw); messages.push(...(Array.isArray(j) ? j : [j])); } else {
            for (const ev of raw.split(/\r?\n\r?\n/)) {
              const data = ev.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
              if (data) messages.push(JSON.parse(data));
            }
          }
        } catch { return fail({ message: 'the hub sent a reply that is not JSON', reason: 'hub_unreachable' }); }
        res({ status: 200, messages, sessionId: r.headers['mcp-session-id'] ?? null, body: null });
      });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error(`no answer within ${Math.round(timeoutMs / 1000)} s`), { code: 'ETIMEDOUT' })));
    req.on('error', fail);
    req.end(body);
  });
}

/** One hub tool call with the structured result: `{status, data}`. */
export async function callTool(hub, name, args, headers, timeoutMs = 10_000) {
  const r = await post(hub, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }), headers, timeoutMs);
  const data = r.messages[0]?.result?.structuredContent;
  return { status: r.status, data: data && typeof data === 'object' ? data : {} };
}

/**
 * One plain request to a `/connector/v1/…` or `/bridge/…` route over the pinned connection: `{status, json}`. A
 * redirect is never followed. Rejects with an error whose `reason` is a fixed reason code.
 */
export function request(hub, method, path, { body, headers = {}, timeoutMs = 15_000 } = {}) {
  return new Promise((res, rej) => {
    const fail = (e) => rej(Object.assign(new Error(e?.message ?? String(e)), { reason: e?.reason ?? reasonOfError(e) }));
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = https.request(`${hub.origin}${path}`, { method, agent: hub.agent, timeout: timeoutMs, rejectUnauthorized: true,
      headers: { accept: 'application/json', ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}), ...headers } }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400) { r.resume(); return fail({ message: `redirect ${r.statusCode} not followed`, reason: 'hub_unreachable' }); }
      let raw = '';
      r.setEncoding('utf8');
      r.on('data', (c) => { raw += c; if (raw.length > 4 * 1024 * 1024) r.destroy(new Error('answer too large')); });
      r.on('error', fail);
      r.on('end', () => { let json = null; try { json = raw ? JSON.parse(raw) : null; } catch { json = null; } res({ status: r.statusCode, json }); });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error(`no answer within ${Math.round(timeoutMs / 1000)} s`), { code: 'ETIMEDOUT' })));
    req.on('error', fail);
    req.end(data ?? undefined);
  });
}

/**
 * A `fetch` for the bridge's transfer loop that goes only to this hub, over the pinned CA. It answers a standard
 * Response, streams both ways, honours the abort signal and never follows a redirect (`redirect: 'error'` behaviour).
 */
export function pinnedFetch(hub) {
  return (url, { method = 'GET', headers = {}, body, signal } = {}) => new Promise((res, rej) => {
    const u = new URL(url);
    if (u.origin !== hub.origin) return rej(new TypeError('the pinned fetch only reaches its own hub'));
    if (signal?.aborted) return rej(signal.reason ?? new Error('aborted'));
    const data = body === undefined || body === null ? null : typeof body === 'string' ? Buffer.from(body) : Buffer.from(body.buffer ?? body, body.byteOffset ?? 0, body.byteLength ?? body.length);
    const req = https.request(u, { method, agent: hub.agent, rejectUnauthorized: true, headers: { ...headers, ...(data ? { 'content-length': data.length } : {}) } }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400) { r.resume(); return rej(new TypeError(`redirect ${r.statusCode} not followed`)); }
      const h = new Headers();
      for (const [k, v] of Object.entries(r.headers)) if (v !== undefined) h.set(k, Array.isArray(v) ? v.join(', ') : String(v));
      const empty = r.statusCode === 204 || r.statusCode === 304 || method === 'HEAD';
      res(new Response(empty ? null : Readable.toWeb(r), { status: r.statusCode, headers: h }));
    });
    const abort = () => req.destroy(signal.reason ?? new Error('aborted'));
    signal?.addEventListener('abort', abort, { once: true });
    req.on('close', () => signal?.removeEventListener('abort', abort));
    req.on('error', rej);
    req.end(data ?? undefined);
  });
}
