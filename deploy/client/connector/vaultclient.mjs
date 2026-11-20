/**
 * The client side of the key service's operations (vault.mjs). It holds no key. A key may travel IN (`put_hub`,
 * `put_agent`); no operation sends one back.
 */
import http from 'node:http';

/** One operation: resolves the service's JSON answer, or `{ok: false, reason: 'vault_unavailable'}`; never rejects. */
export function askVault(address, op, payload, { timeoutMs = 20_000 } = {}) {
  return new Promise((res) => {
    const body = Buffer.from(JSON.stringify(payload ?? {}));
    let done = false;
    const end = (v) => { if (!done) { done = true; res(v); } };
    const req = http.request({ socketPath: address, method: 'POST', path: `/ops/${encodeURIComponent(op)}`, timeout: timeoutMs, headers: { 'content-type': 'application/json', 'content-length': body.length } }, (r) => {
      let raw = '';
      r.setEncoding('utf8');
      r.on('data', (c) => { raw += c; if (raw.length > 1024 * 1024) r.destroy(); });
      r.on('end', () => { try { end(JSON.parse(raw)); } catch { end({ ok: false, reason: 'vault_unavailable' }); } });
      r.on('error', () => end({ ok: false, reason: 'vault_unavailable' }));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => end({ ok: false, reason: 'vault_unavailable' }));
    req.end(body);
  });
}
