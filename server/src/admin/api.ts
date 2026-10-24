/** Admin API under /api (JSON). Cookie session + CSRF header; TOTP once enrolled. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { RateLimit } from '../db/rateLimit.js';
import { z } from 'zod';
import type { Db } from '../db/db.js';
import type { Keys, Credential } from '../keys/keys.js';
import { KeyError } from '../keys/keys.js';
import type { Audit, Actor } from '../audit/audit.js';
import type { Vault } from '../vault/vault.js';
import type { Config } from '../config.js';
import { authorize, canReach, validateRules, parseResource, explicitlyDenied } from '../policy/engine.js';
import type { Rule } from '../policy/engine.js';
import { BASE_TOOLS, DEFAULT_TOOLS, GRANTED_TOOLS } from '../policy/catalogue.js';
import { hashPassword, randomToken, safeEqualHex, sha256Hex, verifyPasswordAsync, verifyTotp } from '../util/crypto.js';
import { newId } from '../util/ids.js';
import type { Setup } from '../setup/setup.js';
import type { Links } from '../links/links.js';
import { registerPhase2 } from './phase2.js';
import { registerPhase3 } from './phase3.js';
import type { Messaging } from '../messaging/messaging.js';
import type { Teams } from '../teams/teams.js';
import { registerTeams } from './teams.js';
import { registerVaultApi } from './vaultApi.js';
import { registerResetApi } from './resetApi.js';
import { registerTelemetryApi } from './telemetryApi.js';
import { registerFeedbackApi } from './feedbackApi.js';
import { registerDecisionsApi } from './decisionsApi.js';
import { registerDirectivesApi } from './directivesApi.js';
import type { Directives } from '../directives/directives.js';
import type { Decisions } from '../teams/decisions.js';
import type { Feedback } from '../feedback/feedback.js';
import type { VaultStore } from '../vault/store.js';
import { registerPhase5 } from './phase5.js';
import { registerGraphAdmin } from './graphApi.js';
import type { Graph } from '../graph/graph.js';
import type { Phase5Deps } from './phase5.js';

const COOKIE = 'ah_admin';
const SESSION_MS = 12 * 60 * 60 * 1000;

export interface AdminDeps { db: Db; keys: Keys; audit: Audit; vault: Vault; store: VaultStore; config: Config; loginLimit: RateLimit; setup: Setup; links: Links; messaging: Messaging; teams: Teams; phase5: Omit<Phase5Deps, 'db' | 'keys' | 'audit'>; graph: Graph; feedback: Feedback; decisions: Decisions; directives: Directives }
interface AdminCtx { id: string; username: string; csrf: string; totp: boolean }
declare module 'fastify' { interface FastifyRequest { admin?: AdminCtx } }

const DUMMY_HASH = hashPassword('not-a-real-password');
/** Password checks running at once; more sign-ins wait their turn with a 429 instead of queueing scrypt work. */
const MAX_VERIFYING = 2;
let verifying = 0;

export function bootstrapAdmin(db: Db, audit: Audit, config: Config): void {
  const n = (db.prepare('SELECT COUNT(*) n FROM admin_users').get() as { n: number }).n;
  if (n > 0 || !config.adminUsername || !config.adminPassword) return;
  const id = newId.admin();
  db.prepare('INSERT INTO admin_users(id,username,password_hash,created_at) VALUES (?,?,?,?)').run(id, config.adminUsername, hashPassword(config.adminPassword), Date.now());
  audit.event({ kind: 'system', id: null }, 'admin.bootstrap', { kind: 'admin', id }, { username: config.adminUsername });
}

const ts = z.union([z.number().int(), z.string()]).nullable().optional().transform((v, ctx) => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Date.parse(v);
  if (Number.isNaN(n)) { ctx.addIssue({ code: 'custom', message: 'invalid date' }); return z.NEVER; }
  return n;
});
const ruleSchema = z.object({
  effect: z.enum(['allow', 'deny']), actions: z.array(z.string()).min(1), resource: z.string(),
  from_template: z.string().nullable().optional(), note: z.string().nullable().optional(),
});
const checkRules = (rules: unknown): Omit<Rule, 'id'>[] => {
  try { validateRules(rules); return rules; } catch (e) { throw new KeyError('invalid_argument', (e as Error).message); }
};
const withSlash = (r: string) => (r.startsWith('/') ? `path:${r}` : r);

export function registerAdminApi(f: FastifyInstance, d: AdminDeps): void {
  const { db, keys, audit, vault, config, loginLimit } = d;

  f.register(async (api) => {
    // ───── auth hook ─────
    api.addHook('preHandler', async (req, reply) => {
      if (req.url.startsWith('/api/login')) return;
      const sid = req.cookies[COOKIE];
      const row = sid ? db.prepare(`SELECT s.admin_id, s.csrf_token, s.expires_at, u.username, u.totp_secret, u.status FROM admin_sessions s JOIN admin_users u ON u.id=s.admin_id WHERE s.id_hash=?`)
        .get(Buffer.from(sha256Hex(sid), 'hex')) as { admin_id: string; csrf_token: string; expires_at: number; username: string; totp_secret: string | null; status: string } | undefined : undefined;
      if (!row || row.expires_at < Date.now() || row.status !== 'active') return reply.code(401).send({ error: 'unauthenticated', message: 'Sign in first.' });
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        const h = req.headers['x-csrf-token'];
        if (typeof h !== 'string' || !safeEqualHex(sha256Hex(h), sha256Hex(row.csrf_token))) return reply.code(403).send({ error: 'csrf', message: 'Missing or wrong x-csrf-token header.' });
      }
      db.prepare('UPDATE admin_sessions SET last_seen_at=? WHERE id_hash=?').run(Date.now(), Buffer.from(sha256Hex(sid!), 'hex'));
      req.admin = { id: row.admin_id, username: row.username, csrf: row.csrf_token, totp: row.totp_secret !== null };
    });
    const actor = (req: FastifyRequest): Actor => ({ kind: 'admin', id: req.admin!.id });
    const body = <T extends z.ZodType>(s: T, req: FastifyRequest): z.infer<T> => s.parse(req.body ?? {});
    const idOf = (req: FastifyRequest) => (req.params as { id: string }).id;
    const cred = (id: string): Credential => { const c = keys.credential(id); if (!c) throw new KeyError('not_found', 'key not found'); return c; };

    // ───── login / session ─────
    api.post('/api/login', async (req, reply) => {
      const b = body(z.object({ username: z.string(), password: z.string(), totp: z.string().optional() }), req);
      const now = Date.now();
      // Per username and per client address: a stream of attempts with changing usernames is limited too.
      if (loginLimit.blocked(b.username, 'admin_login_fail', now).blocked || loginLimit.blocked(`ip:${req.ip}`, 'admin_login_fail_ip', now).blocked) {
        audit.auth({ subject: 'admin', outcome: 'rate_limited', source: req.ip });
        return reply.code(429).send({ error: 'rate_limited', message: 'Too many failed sign-ins. Try again later.' });
      }
      const u = db.prepare('SELECT * FROM admin_users WHERE username=?').get(b.username) as { id: string; password_hash: string; totp_secret: string | null; status: string } | undefined;
      if (verifying >= MAX_VERIFYING) return reply.code(429).send({ error: 'rate_limited', message: 'Sign-in is busy. Try again in a moment.' });
      verifying++;
      let okPw = false;
      try { okPw = (await verifyPasswordAsync(b.password, u?.password_hash ?? DUMMY_HASH)) && !!u && u.status === 'active'; } finally { verifying--; }
      if (!okPw) { loginLimit.fail(b.username, 'admin_login_fail', now); loginLimit.fail(`ip:${req.ip}`, 'admin_login_fail_ip', now); audit.auth({ subject: 'admin', adminId: u?.id ?? null, outcome: 'invalid', source: req.ip }); return reply.code(401).send({ error: 'invalid_credentials', message: 'Wrong username or password.' }); }
      if (u!.totp_secret) {
        if (!b.totp) return reply.code(401).send({ error: 'mfa_required', message: 'Enter the 6-digit code from your authenticator.' });
        if (!verifyTotp(u!.totp_secret, b.totp, now)) { loginLimit.fail(b.username, 'admin_login_fail', now); audit.auth({ subject: 'admin', adminId: u!.id, outcome: 'mfa_failed', source: req.ip }); return reply.code(401).send({ error: 'mfa_failed', message: 'Wrong code.' }); }
      }
      const sid = randomToken(24), csrf = randomToken(16);
      db.prepare('INSERT INTO admin_sessions(id_hash,admin_id,csrf_token,created_at,last_seen_at,expires_at) VALUES (?,?,?,?,?,?)').run(Buffer.from(sha256Hex(sid), 'hex'), u!.id, csrf, now, now, now + SESSION_MS);
      db.prepare('UPDATE admin_users SET last_login_at=? WHERE id=?').run(now, u!.id);
      audit.auth({ subject: 'admin', adminId: u!.id, outcome: 'success', source: req.ip });
      reply.setCookie(COOKIE, sid, { httpOnly: true, sameSite: 'strict', secure: config.production, path: '/', maxAge: SESSION_MS / 1000 });
      return { username: b.username, csrf, totp_enrolled: u!.totp_secret !== null };
    });
    api.get('/api/me', async (req) => ({ username: req.admin!.username, csrf: req.admin!.csrf, totp_enrolled: req.admin!.totp, vault_alias: vault.alias, public_url: config.publicUrl }));
    api.post('/api/logout', async (req, reply) => {
      db.prepare('DELETE FROM admin_sessions WHERE id_hash=?').run(Buffer.from(sha256Hex(req.cookies[COOKIE]!), 'hex'));
      reply.clearCookie(COOKIE, { path: '/' });
      return { ok: true };
    });
    api.post('/api/totp/enroll', async (req) => {
      if (req.admin!.totp) throw new KeyError('conflict', 'TOTP is already enrolled');
      const secret = randomToken(20).slice(0, 32);
      db.prepare('INSERT INTO system_settings(key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at')
        .run(`totp_pending:${req.admin!.id}`, JSON.stringify(secret), Date.now());
      const s = secret.toUpperCase();
      return { secret: s, otpauth_uri: `otpauth://totp/Conclave:${encodeURIComponent(req.admin!.username)}?secret=${s}&issuer=Conclave` };
    });
    api.post('/api/totp/confirm', async (req) => {
      const { code } = body(z.object({ code: z.string() }), req);
      const row = db.prepare('SELECT value FROM system_settings WHERE key=?').get(`totp_pending:${req.admin!.id}`) as { value: string } | undefined;
      if (!row) throw new KeyError('invalid_state', 'start enrolment first');
      const secret = JSON.parse(row.value) as string;
      if (!verifyTotp(secret, code, Date.now())) throw new KeyError('invalid_argument', 'wrong code');
      db.prepare('UPDATE admin_users SET totp_secret=? WHERE id=?').run(secret, req.admin!.id);
      db.prepare('DELETE FROM system_settings WHERE key=?').run(`totp_pending:${req.admin!.id}`);
      audit.event(actor(req), 'admin.totp_enrolled', { kind: 'admin', id: req.admin!.id });
      return { ok: true };
    });

    // ───── PCs and agents ─────
    api.post('/api/pcs', async (req) => {
      const b = body(z.object({ name: z.string(), description: z.string().nullable().optional() }), req);
      return { pc: keys.createMachine(b.name, b.description ?? null, actor(req)) };
    });
    api.post('/api/pcs/:id/suspend', async (req) => { keys.setMachineStatus(idOf(req), 'suspended', actor(req)); return { pc: keys.machine(idOf(req)) }; });
    api.post('/api/pcs/:id/reactivate', async (req) => { keys.setMachineStatus(idOf(req), 'active', actor(req)); return { pc: keys.machine(idOf(req)) }; });

    api.get('/api/agents', async () => ({ agents: keys.agents() }));
    api.post('/api/agents', async (req) => {
      const b = body(z.object({ label: z.string().min(1).max(80), project: z.string().nullable().optional() }), req);
      return { agent: keys.createAgent(b.label, b.project ?? null, actor(req)) };
    });
    api.patch('/api/agents/:id', async (req) => {
      const b = body(z.object({ label: z.string().min(1).max(80).optional(), project: z.string().nullable().optional(), role: z.string().max(80).nullable().optional(), role_detail: z.string().max(500).nullable().optional() }), req);
      return { agent: keys.updateAgent(idOf(req), b, actor(req)) };
    });

    // ───── keys ─────
    const view = (c: Credential) => {
      const agent = c.agent_id ? keys.agent(c.agent_id) : null, pc = c.machine_id ? keys.machine(c.machine_id) : null;
      return {
        ...c, effective_status: keys.effectiveStatus(c), masked_key: `ah_${c.kind === 'app_key' ? 'app' : 'ses'}_${c.key_id}_…`,
        agent: agent ? { id: agent.id, label: agent.label, role: agent.role } : null, pc: pc ? { id: pc.id, name: pc.name, status: pc.status } : null,
        live_logins: keys.liveLogins({ credentialId: c.id }).length,
      };
    };
    api.get('/api/keys', async (req) => {
      const q = req.query as { kind?: string; status?: string; pc?: string; agent?: string };
      let list = keys.credentials({ kind: q.kind === 'app_key' || q.kind === 'session_key' ? q.kind : undefined, agentId: q.agent, machineId: q.pc }).map(view);
      if (q.status) list = list.filter((c) => c.effective_status === q.status);
      return { keys: list };
    });
    api.post('/api/keys', async (req) => {
      const b = body(z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('session_key'), agent_id: z.string().optional(), new_agent: z.object({ label: z.string().min(1), project: z.string().nullable().optional() }).optional(),
          label: z.string().min(1).max(120), template_id: z.string().nullable().optional(), expires_at: ts }),
        z.object({ kind: z.literal('app_key'), machine_id: z.string(), app_name: z.string().min(1).max(60), label: z.string().optional() }),
      ]), req);
      if (b.kind === 'app_key') {
        const r = keys.createAppKey({ machineId: b.machine_id, appName: b.app_name, label: b.label }, actor(req));
        const url = `${config.publicUrl}/mcp`;
        return {
          key: view(r.credential), secret: r.secret,
          setup: {
            claude_code: `claude mcp add --transport http agent-hub ${url} --header "Authorization: Bearer ${r.secret}"`,
            codex_env: `AGENT_HUB_APP_KEY=${r.secret}`,
            codex_config_toml: `[mcp_servers.agent_hub]\nurl = "${url}"\nbearer_token_env_var = "AGENT_HUB_APP_KEY"\nstartup_timeout_sec = 20\ntool_timeout_sec = 300`,
          },
        };
      }
      if (!b.agent_id && !b.new_agent) throw new KeyError('invalid_argument', 'agent_id or new_agent is required');
      const agentId = b.agent_id ?? keys.createAgent(b.new_agent!.label, b.new_agent!.project ?? null, actor(req)).id;
      const r = keys.createSessionKey({ agentId, label: b.label, expiresAt: b.expires_at, templateId: b.template_id }, actor(req));
      return {
        key: view(r.credential), secret: r.secret,
        handoff: `Your Conclave key: ${r.secret}\nCall session_login first with this key, then session_describe to state your role. Pass the returned session_token on every other call. Never put this key into anything you send.`,
      };
    });
    api.get('/api/keys/:id', async (req) => {
      const c = cred(idOf(req));
      return { key: view(c), policy_version: keys.policyVersion(c.policy_id), logins: keys.liveLogins({ credentialId: c.id }) };
    });
    for (const [path, fn] of [
      ['suspend', (id: string, a: Actor) => keys.setStatus(id, 'suspended', 'admin', a)],
      ['reactivate', (id: string, a: Actor) => keys.setStatus(id, 'active', null, a)],
      ['revoke', (id: string, a: Actor) => keys.setStatus(id, 'revoked', 'admin', a)],
    ] as const) {
      api.post(`/api/keys/:id/${path}`, async (req) => ({ key: view(fn(idOf(req), actor(req))) }));
    }
    api.post('/api/keys/:id/rotate', async (req) => {
      const r = keys.rotate(idOf(req), actor(req));
      return {
        key: view(r.credential), secret: r.secret,
        handoff: r.credential.kind === 'session_key'
          ? `Your Conclave key was rotated. New key: ${r.secret}\nCall session_login with this key. Your permissions are unchanged. Never put this key into anything you send.` : undefined,
      };
    });
    api.post('/api/keys/:id/end-logins', async (req) => ({ ended: keys.endLogins(idOf(req), actor(req)) }));
    api.patch('/api/keys/:id', async (req) => {
      const b = body(z.object({ expires_at: ts }), req);
      return { key: view(keys.setExpiry(idOf(req), b.expires_at, actor(req))) };
    });
    api.get('/api/keys/:id/rules', async (req) => { const c = cred(idOf(req)); return { rules: keys.rules(c.policy_id), version: keys.policyVersion(c.policy_id) }; });
    api.put('/api/keys/:id/rules', async (req) => {
      const b = body(z.object({ rules: z.array(ruleSchema), note: z.string().nullable().optional() }), req);
      const c = cred(idOf(req));
      const version = keys.setRules(c.policy_id, checkRules(b.rules), b.note ?? null, actor(req));
      return { rules: keys.rules(c.policy_id), version };
    });
    api.get('/api/keys/:id/versions', async (req) => ({ versions: keys.versions(cred(idOf(req)).policy_id) }));
    api.post('/api/keys/:id/rollback', async (req) => {
      const b = body(z.object({ version: z.number().int() }), req);
      const c = cred(idOf(req));
      return { version: keys.rollback(c.policy_id, b.version, actor(req)), rules: keys.rules(c.policy_id) };
    });
    api.post('/api/keys/:id/apply-template', async (req) => {
      const b = body(z.object({ template_id: z.string() }), req);
      const c = cred(idOf(req));
      return { version: keys.applyTemplate(c.id, b.template_id, actor(req)), rules: keys.rules(c.policy_id) };
    });
    api.get('/api/keys/:id/effective', async (req) => {
      const c = cred(idOf(req));
      const q = req.query as { app_key_id?: string };
      const rules = keys.rules(c.policy_id);
      const capCred = q.app_key_id ? cred(q.app_key_id) : null;
      const cap = capCred ? keys.rules(capCred.policy_id) : [];
      const tools = [...BASE_TOOLS, ...DEFAULT_TOOLS, ...GRANTED_TOOLS].map((t) => {
        if ((BASE_TOOLS as readonly string[]).includes(t)) return { tool: t, allowed: true, reason: 'always available when logged in' };
        if ((DEFAULT_TOOLS as readonly string[]).includes(t)) {
          const no = explicitlyDenied(rules, cap, 'tool.invoke', `tool:${t}`);
          return { tool: t, allowed: !no, reason: no ? 'refused by an explicit deny rule' : 'on by default for every logged-in session' };
        }
        const dec = authorize(rules, cap, 'tool.invoke', `tool:${t}`);
        return { tool: t, allowed: dec.allowed, reason: dec.reason, source: dec.source };
      });
      const folders = (await vault.list([])).filter((e) => e.type === 'folder').map((e) => ({
        path: e.path, list: canReach(rules, cap, 'fs.list', e.path), read: canReach(rules, cap, 'fs.read', e.path),
      }));
      const root = `/${vault.alias}`;
      return { rules, app_key_cap: cap, tools, folders, root: { path: root, list: canReach(rules, cap, 'fs.list', root), read: canReach(rules, cap, 'fs.read', root) } };
    });

    api.post('/api/simulate', async (req) => {
      const b = body(z.object({ credential_id: z.string(), app_credential_id: z.string().nullable().optional(), action: z.string(), resource: z.string() }), req);
      const c = cred(b.credential_id), app = b.app_credential_id ? cred(b.app_credential_id) : null;
      const resource = withSlash(b.resource);
      try { parseResource(resource); } catch (e) { throw new KeyError('invalid_argument', (e as Error).message); }
      return { decision: authorize(keys.rules(c.policy_id), app ? keys.rules(app.policy_id) : [], b.action, resource) };
    });

    registerPhase2(api, { db, keys, setup: d.setup, links: d.links, config, audit }, actor);
    registerPhase3(api, { db, keys, messaging: d.messaging }, actor);
    registerTeams(api, { db, keys, teams: d.teams }, actor);
    registerPhase5(api, { db, keys, audit, ...d.phase5 }, actor);
    registerGraphAdmin(api, { db, audit, graph: d.graph }, actor);
    registerVaultApi(api, { db, keys, audit, vault, store: d.store }, actor);
    registerResetApi(api, { db, audit, config, loginLimit, maintenance: d.phase5.maintenance }, actor);
    registerTelemetryApi(api, { db, audit }, actor);
    registerFeedbackApi(api, { feedback: d.feedback }, actor);
    registerDirectivesApi(api, { directives: d.directives }, actor);
    registerDecisionsApi(api, { db, decisions: d.decisions, teams: d.teams, vault }, actor);

    // ───── templates ─────
    api.get('/api/templates', async () => ({ templates: keys.templates() }));
    api.post('/api/templates', async (req) => {
      const b = body(z.object({ name: z.string().min(1).max(60), description: z.string().nullable().optional(), rules: z.array(ruleSchema) }), req);
      return { id: keys.createTemplate(b.name, b.description ?? null, checkRules(b.rules), actor(req)) };
    });

    // ───── audit ─────
    const limit = (req: FastifyRequest, max = 200) => Math.min(max, Math.max(1, Number((req.query as { limit?: string }).limit ?? 200) || 200));
    api.get('/api/audit', async (req) => {
      const t = (req.query as { target?: string }).target;
      const rows = t ? db.prepare('SELECT * FROM audit_events WHERE target_id=? ORDER BY id DESC LIMIT ?').all(t, limit(req)) : db.prepare('SELECT * FROM audit_events ORDER BY id DESC LIMIT ?').all(limit(req));
      return { events: rows };
    });
    /** since (epoch ms) bounds the window, so "calls in the last hour" counts more than the latest 200 rows (up to 2000). */
    /**
     * A denied call stays denied in the record, but the console should not present it as an open problem once the
     * access was granted. For denied calls on a vault path (the hub logged the refused action and path), re-check
     * that action against the key's current rules and app key cap: now_allowed says it would pass today, and
     * access_changed_at is when the key's rules last changed (or a temporary grant was made).
     */
    const nowAllowed = (rows: Record<string, unknown>[]) => {
      const ev = db.prepare("SELECT action, path FROM resource_access_events WHERE credential_id=? AND decision='deny' AND created_at BETWEEN ? AND ? ORDER BY ABS(created_at-?) LIMIT 1");
      const rulesOf = new Map<string, Rule[]>(), changedOf = new Map<string, number | null>();
      const rules = (id: string) => { if (!rulesOf.has(id)) rulesOf.set(id, keys.rulesFor(id)); return rulesOf.get(id)!; };
      const changed = (credId: string) => {
        if (!changedOf.has(credId)) {
          const c = keys.credential(credId);
          const pv = c ? (db.prepare('SELECT MAX(created_at) t FROM policy_versions WHERE policy_id=?').get(c.policy_id) as { t: number | null }).t : null;
          const tg = (db.prepare('SELECT MAX(created_at) t FROM temporary_grants WHERE credential_id=? AND revoked_at IS NULL').get(credId) as { t: number | null }).t;
          changedOf.set(credId, Math.max(pv ?? 0, tg ?? 0) || null);
        }
        return changedOf.get(credId)!;
      };
      let checked = 0;
      return rows.map((r) => {
        if (r.result !== 'denied' || typeof r.credential_id !== 'string' || checked >= 300) return r;
        checked++;
        const at = Number(r.created_at), e = ev.get(r.credential_id, at - 5000, at + 5000, at) as { action: string; path: string } | undefined;
        if (!e) return r;
        const c = keys.credential(r.credential_id);
        if (!c || keys.effectiveStatus(c) !== 'active') return { ...r, now_allowed: false };
        const cap = typeof r.app_credential_id === 'string' ? rules(r.app_credential_id) : [];
        const ok = authorize(rules(r.credential_id), cap, e.action, `path:${e.path}`).allowed;
        return { ...r, now_allowed: ok, denied_action: e.action, denied_path: e.path, ...(ok ? { access_changed_at: changed(r.credential_id) } : {}) };
      });
    };
    api.get('/api/invocations', async (req) => {
      const q = req.query as { credential?: string; since?: string };
      const since = Number(q.since ?? 0) || 0, n = limit(req, 2000);
      const rows = q.credential
        ? db.prepare('SELECT * FROM tool_invocations WHERE credential_id=? AND created_at>=? UNION SELECT * FROM tool_invocations WHERE app_credential_id=? AND created_at>=? ORDER BY created_at DESC LIMIT ?').all(q.credential, since, q.credential, since, n)
        : db.prepare('SELECT * FROM tool_invocations WHERE created_at>=? ORDER BY created_at DESC LIMIT ?').all(since, n);
      return { invocations: nowAllowed(rows as Record<string, unknown>[]) };
    });
    api.get('/api/alerts', async (req) => {
      const { credential: c, status } = req.query as { credential?: string; status?: string };
      const rows = db.prepare('SELECT * FROM security_alerts WHERE (? IS NULL OR subject=?) AND (? IS NULL OR status=?) ORDER BY created_at DESC LIMIT ?').all(c ?? null, c ?? null, status ?? null, status ?? null, limit(req));
      return { alerts: rows };
    });
  });
}
