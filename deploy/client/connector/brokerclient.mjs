/**
 * The client side of the connector's local broker (broker.mjs): where it listens, and one request to it. It holds no key,
 * which is why `conclave mcp` and the folder hook may import it. See docs/connector.md, "Isolation levels".
 */
import net from 'node:net';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { serviceId } from './service.mjs';

/**
 * Where the broker listens for this connector folder: a named pipe on Windows, a socket in the connector's folder elsewhere.
 * A socket path is limited to about 100 bytes: a long connector folder uses the user's own runtime folder
 * (XDG_RUNTIME_DIR, private to the user) and never a shared one such as /tmp. With neither short enough there is no
 * address (null): the broker does not start and says why.
 */
export function brokerAddress(home, platform = process.platform, env = process.env) {
  const id = serviceId(home);
  if (platform === 'win32') return `\\\\.\\pipe\\conclave-broker-${id}`;
  const p = join(home, 'run', 'broker.sock');
  if (Buffer.byteLength(p) < 96) return p;
  const x = env.XDG_RUNTIME_DIR ? join(env.XDG_RUNTIME_DIR, `conclave-${id}.sock`) : null;
  return x && Buffer.byteLength(x) < 96 ? x : null;
}

/**
 * The broker's secret: 32 random bytes in run/broker.secret, readable by this OS user only (0600; on Windows the connector
 * folder's own access list). The broker writes it at each start. Both sides prove they hold it on every request, so a process
 * of another user that takes the address first (while the connector restarts) gets no answer it can use, and a session never
 * trusts an answer from it.
 */
export const brokerSecretPath = (home) => join(home, 'run', 'broker.secret');
export const readBrokerSecret = (home) => { try { const s = readFileSync(brokerSecretPath(home), 'utf8').trim(); return /^[0-9a-f]{64}$/.test(s) ? s : null; } catch { return null; } };
export const brokerProof = (secret, side, nonce) => createHmac('sha256', Buffer.from(secret, 'hex')).update(`conclave-broker ${side} ${nonce}`).digest('hex');
export const proofMatches = (want, got) => typeof got === 'string' && got.length === want.length && timingSafeEqual(Buffer.from(want), Buffer.from(got));

/**
 * One request to the broker: resolves its JSON answer, or `{ok: false, reason: 'connector_not_running'}` when nothing
 * listens (never rejects, never hangs past `timeoutMs`).
 */
export function askBroker(home, req, { timeoutMs = 15_000, address } = {}) {
  return new Promise((res) => {
    let done = false, buf = '';
    const end = (v) => { if (done) return; done = true; clearTimeout(timer); try { sock?.destroy(); } catch { /* gone */ } res(v); };
    const secret = readBrokerSecret(home), at = address ?? brokerAddress(home);
    const timer = setTimeout(() => end({ ok: false, reason: 'connector_not_running' }), timeoutMs);
    let sock = null;
    if (!secret || !at) return end({ ok: false, reason: 'connector_not_running' });
    const nonce = randomBytes(16).toString('hex');
    sock = net.connect(at);
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(JSON.stringify({ ...req, nonce, auth: brokerProof(secret, 'client', nonce) }) + '\n'));
    sock.on('data', (d) => {
      buf += d;
      const i = buf.indexOf('\n');
      if (i < 0) return;
      let a = null;
      try { a = JSON.parse(buf.slice(0, i)); } catch { return end({ ok: false, reason: 'connector_not_running' }); }
      // Only the broker that holds this connector's secret can answer: anything else at the address is not believed.
      if (!a || !proofMatches(brokerProof(secret, 'broker', nonce), a.proof)) return end({ ok: false, reason: 'broker_unverified' });
      const { proof, ...rest } = a;
      end(rest);
    });
    sock.on('error', () => end({ ok: false, reason: 'connector_not_running' }));
    sock.on('close', () => end({ ok: false, reason: 'connector_not_running' }));
  });
}

