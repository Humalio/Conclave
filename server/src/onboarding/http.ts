/**
 * Onboarding HTTP endpoints (docs/onboarding.md#endpoints): plain HTTPS outside /mcp and /api. Off loopback, plain HTTP
 * is refused with 426, except the public downloads (their hashes, not the transport, make them safe).
 */
import { existsSync, readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { KeyError } from '../keys/keys.js';
import { sha256Hex } from '../util/crypto.js';
import { OnboardError, MAX_WAIT_S, type Onboarding } from './onboarding.js';

/** The files the hub serves to a new PC. */
export const CLIENT_FILES = ['setup.mjs', 'agent-hub-headers.mjs', 'onboarding-prompt.md', 'restore-prompt.md'] as const;

export function findClientDir(explicit?: string): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [explicit, join(here, '../client'), join(here, '../../../deploy/client'), join(process.cwd(), '../deploy/client')].filter(Boolean) as string[];
  return candidates.find((c) => existsSync(join(c, 'agent-hub-headers.mjs'))) ?? null;
}

/** Client files and the hub's CA certificate, read from disk on each call (small; an upgrade needs no restart). Line ends are LF. */
export class ClientFiles {
  constructor(private readonly dir: string | null, private readonly caFile?: string) {}
  file(name: string): { text: string; sha256: string } | null {
    if (!this.dir || !(CLIENT_FILES as readonly string[]).includes(name)) return null;
    const p = join(this.dir, name);
    if (!existsSync(p)) return null;
    const text = readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
    return { text, sha256: sha256Hex(text) };
  }
  manifest(): Record<string, { sha256: string; bytes: number } | null> {
    const out: Record<string, { sha256: string; bytes: number } | null> = {};
    for (const n of CLIENT_FILES) { const f = this.file(n); out[n] = f ? { sha256: f.sha256, bytes: Buffer.byteLength(f.text) } : null; }
    return out;
  }
  /** The CA certificate (PEM) and its SHA-256 fingerprint: lowercase hex of the DER, as X509Certificate.fingerprint256. */
  ca(): { pem: string; sha256: string } | null {
    if (!this.caFile || !existsSync(this.caFile)) return null;
    const pem = readFileSync(this.caFile, 'utf8');
    try { return { pem, sha256: new X509Certificate(pem).fingerprint256.replace(/:/g, '').toLowerCase() }; } catch { return null; }
  }
}

const FALLBACK_PROMPT = `Set up this PC for the Conclave hub, then the team I describe at the end.

Hub: {{HUB_URL}}{{LAN_LINE}}
Hub CA certificate SHA-256: {{CA_SHA256}}
setup.mjs SHA-256: {{SETUP_SHA256}}
agent-hub-headers.mjs SHA-256: {{HELPER_SHA256}}
Enrolment code (single use): {{ENROL_CODE}}

Steps: check Node.js 24+, git and {{HUB_URL}}/health; download {{HUB_URL}}/onboard/client/setup.mjs and /onboard/client/agent-hub-headers.mjs into ~/.config/conclave/ and check both hashes; write the code to ~/.config/conclave/onboarding/enrol-code and run node setup.mjs enrol --hub {{HUB_URL}} --ca-sha256 {{CA_SHA256}}; draft the request, show me the summary, and file it with node setup.mjs request --file <path>; ask me how Claude Code should reach the hub; run node setup.mjs wait; then start the coordinator.

What I want:
`;

/** The prompt for Add PC and Re-enrol PC: the template with the hub URL, hashes, CA fingerprint and the code filled in. */
export function renderPrompt(files: ClientFiles, o: { hubUrl: string; lanUrl?: string; code: string; pc: string }): { text: string; template_sha256: string | null; hashes: Record<string, string | null> } {
  const tpl = files.file('onboarding-prompt.md');
  const setup = files.file('setup.mjs'), helper = files.file('agent-hub-headers.mjs'), ca = files.ca();
  const vals: Record<string, string> = {
    HUB_URL: o.hubUrl, LAN_URL: o.lanUrl ?? '', LAN_LINE: o.lanUrl ? `\nLAN plain-HTTP URL: ${o.lanUrl}` : '', PC_NAME: o.pc,
    CA_SHA256: ca?.sha256 ?? '(no CA certificate configured on the hub)', SETUP_SHA256: setup?.sha256 ?? '(setup.mjs not installed on the hub)',
    HELPER_SHA256: helper?.sha256 ?? '(helper not installed on the hub)', ENROL_CODE: o.code,
  };
  const text = (tpl?.text ?? FALLBACK_PROMPT).replace(/\{\{([A-Z0-9_]+)\}\}/g, (m, k: string) => vals[k] ?? m);
  return { text, template_sha256: tpl?.sha256 ?? null, hashes: { 'setup.mjs': setup?.sha256 ?? null, 'agent-hub-headers.mjs': helper?.sha256 ?? null, ca: ca?.sha256 ?? null } };
}

const STATUS: Record<string, number> = {
  invalid_argument: 400, contains_key: 400, unauthorized: 401, capability_off: 403, suspended: 403, not_found: 404, denied: 404,
  conflict: 409, invalid_state: 409, checkout_open: 409, handout_changed: 409, scan_pending: 409, lockdown: 423, upgrade_required: 426, rate_limited: 429,
};

const isLoopback = (ip: string) => ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip.startsWith('127.');

export function registerOnboarding(f: FastifyInstance, ob: Onboarding, files: ClientFiles): void {
  const send = (reply: FastifyReply, e: unknown) => {
    if (e instanceof KeyError) {
      const extra = e.extra ?? {};
      if (typeof extra.retry_after_s === 'number') reply.header('retry-after', String(extra.retry_after_s));
      if (e.code === 'unauthorized') reply.header('www-authenticate', 'Bearer');
      return reply.code(STATUS[e.code] ?? 400).send({ error: e.code, message: e.message, ...extra });
    }
    throw e;
  };
  /** Enrolment, requests and pickup carry secrets or authority: HTTPS only, off loopback. */
  const httpsOnly = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (req.protocol === 'https' || isLoopback(req.ip)) return true;
    void reply.code(426).header('upgrade', 'TLS/1.2, HTTP/1.1').header('connection', 'Upgrade').send({ error: 'upgrade_required', message: 'Use the hub\'s HTTPS URL; plain HTTP is refused for onboarding.' });
    return false;
  };
  const bearer = (req: FastifyRequest) => { const m = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? '')); return m ? m[1]! : null; };
  const obj = (b: unknown) => (b && typeof b === 'object' && !Array.isArray(b) ? b as Record<string, unknown> : {});
  const route = (method: 'get' | 'post' | 'put', path: string, fn: (req: FastifyRequest) => unknown) => {
    f[method](path, async (req, reply) => {
      if (!httpsOnly(req, reply)) return reply;
      try { return await fn(req); } catch (e) { return send(reply, e); }
    });
  };

  // ── public downloads (also on the LAN plain-HTTP port) ──
  f.get('/onboard/client/manifest', async () => ({ files: files.manifest(), ca_sha256: files.ca()?.sha256 ?? null }));
  f.get('/onboard/client/:name', async (req, reply) => {
    const name = (req.params as { name: string }).name, file = files.file(name);
    if (!file) return reply.code(404).send({ error: 'not_found', message: 'No such client file on this hub.' });
    const type = name.endsWith('.md') ? 'text/markdown; charset=utf-8' : 'text/javascript; charset=utf-8';
    return reply.type(type).header('x-content-sha256', file.sha256).send(file.text);
  });
  f.get('/onboard/ca.crt', async (_req, reply) => {
    const ca = files.ca();
    if (!ca) return reply.code(404).send({ error: 'not_found', message: 'No CA certificate is configured on this hub (CA_CERT_FILE).' });
    return reply.type('application/x-pem-file').header('x-ca-sha256', ca.sha256).send(ca.pem);
  });

  // ── enrolment (the code) ──
  // The code may come in the x-conclave-enrol-code header (setup.mjs restore), never in a URL.
  route('post', '/onboard/enrol', (req) => { const b = obj(req.body), h = req.headers['x-conclave-enrol-code']; return ob.enrol((b.code ?? (typeof h === 'string' ? h : undefined)) as string, b.nonce as string, req.ip); });
  route('post', '/onboard/enrol/confirm', (req) => ob.enrolConfirm(obj(req.body).nonce as string, req.ip));

  // ── requests (the PC key) ──
  route('post', '/onboard/requests', (req) => ob.file(ob.authApp(bearer(req), req.ip), req.body));
  route('get', '/onboard/requests', (req) => ({ requests: ob.pending(ob.authApp(bearer(req), req.ip)) }));
  route('get', '/onboard/requests/:id', async (req) => {
    const app = ob.authApp(bearer(req), req.ip);
    const q = obj(req.query);
    const w = q.wait_s === undefined ? 0 : Number(q.wait_s), v = q.version === undefined ? undefined : Number(q.version);
    if (!Number.isFinite(w) || w < 0 || w > MAX_WAIT_S) throw new OnboardError('invalid_argument', `wait_s: 0 to ${MAX_WAIT_S}`);
    return ob.status(app, (req.params as { id: string }).id, w, Number.isInteger(v) ? v : undefined);
  });
  route('put', '/onboard/requests/:id', (req) => {
    const app = ob.authApp(bearer(req), req.ip);
    const { version, ...rest } = obj(req.body);
    return ob.amend(app, (req.params as { id: string }).id, version, rest);
  });
  // The restore's config scan of each folder, before pickup (docs/checkout.md §6 step 4).
  route('post', '/onboard/requests/:id/scan', (req) => ob.reportScan(ob.authApp(bearer(req), req.ip), (req.params as { id: string }).id, req.body));
  route('post', '/onboard/requests/:id/withdraw', (req) => ob.withdraw(ob.authApp(bearer(req), req.ip), (req.params as { id: string }).id));

  // ── pickup ──
  route('post', '/onboard/pickup', (req) => ob.pickup(ob.authApp(bearer(req), req.ip), obj(req.body).request_id as string, req.ip));
  // One key from a key prompt (docs/onboarding.md#key-prompts-a-new-rotated-or-reissued-session-key), for an app key of the code's PC.
  // A collection names collect_id and the wake's instance_id instead of a code.
  route('post', '/onboard/key-pickup', (req) => { const b = obj(req.body); return ob.keyPickup(ob.authApp(bearer(req), req.ip), b.code, req.ip, { collect_id: b.collect_id, instance_id: b.instance_id }); });
  // Key collection by the Codex wake (docs/onboarding.md#collect-on-a-pc-the-codex-wake-picks-up-a-routine-rotation): the poll returns no secret.
  route('post', '/onboard/key-collect/poll', (req) => ob.keyCollectPoll(ob.authApp(bearer(req), req.ip), req.body, req.ip));
  route('post', '/onboard/key-collect/confirm', (req) => ob.keyCollectConfirm(ob.authApp(bearer(req), req.ip), req.body));
  route('post', '/onboard/pickup/confirm', (req) => { const b = obj(req.body); return ob.confirm(ob.authApp(bearer(req), req.ip), b.pickup_id as string, b.written, b.transport, req.ip); });
}
