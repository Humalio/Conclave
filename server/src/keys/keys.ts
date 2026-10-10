/**
 * Keys & identities (SPECIFICATION F1, ADR-0012).
 *   app key      ah_app_<keyid>_<secret>  one per app per PC, in the app's MCP config
 *   session key  ah_ses_<keyid>_<secret>  one per agent session, pasted in chat
 *   token        ah_tok_<secret>          returned by session_login, passed on every call
 * Only an HMAC of each secret is stored. Key ids are public and used for lookup.
 */
import type { Db } from '../db/db.js';
import { tx } from '../db/db.js';
import { hmacHex, randomToken, safeEqualHex, sha256Hex } from '../util/crypto.js';
import { newId } from '../util/ids.js';
import type { Rule } from '../policy/engine.js';
import { validateRules } from '../policy/engine.js';
import type { Audit, Actor } from '../audit/audit.js';

export type KeyKind = 'app_key' | 'session_key';
export type KeyStatus = 'active' | 'suspended' | 'revoked';

export interface Credential {
  id: string; kind: KeyKind; agent_id: string | null; machine_id: string | null; app_name: string | null;
  label: string; key_id: string; status: KeyStatus; status_reason: string | null; expires_at: number | null;
  replaces_credential_id: string | null; policy_id: string; max_live_sessions: number;
  created_at: number; first_used_at: number | null; last_used_at: number | null; revoked_at: number | null;
}
export interface Agent {
  id: string; label: string; project: string | null; model_label: string | null; role: string | null; role_detail: string | null;
  role_source: 'agent' | 'admin' | null; role_note: string | null; status_text: string | null; status: string; created_at: number; last_seen_at: number | null; archived_at?: number | null;
}
export interface Machine { id: string; name: string; description: string | null; status: string; created_at: number; os?: string | null; setup_status?: string; bridge_version?: string | null; bridge_last_seen_at?: number | null }
export interface Notice { id: string; agent_id: string; seq: number; kind: string; body: string; created_at: number }

const CRED_COLS = 'id,kind,agent_id,machine_id,app_name,label,key_id,status,status_reason,expires_at,replaces_credential_id,policy_id,max_live_sessions,created_at,first_used_at,last_used_at,revoked_at';
export const TOKEN_IDLE_MS = 60 * 60 * 1000;
const KEY_RE = /^ah_(app|ses)_([a-z2-7]{12})_([a-z2-7]{32})$/;
const TOKEN_RE = /^ah_tok_([a-z2-7]{40})$/;

export class KeyError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

export class Keys {
  constructor(private readonly db: Db, private readonly pepper: string, private readonly audit: Audit) {}

  // ───────────── Agents and PCs ─────────────
  createAgent(label: string, project: string | null, actor: Actor): Agent {
    const id = newId.agent();
    this.db.prepare('INSERT INTO agents(id,label,project,created_at) VALUES (?,?,?,?)').run(id, label, project, Date.now());
    this.audit.event(actor, 'agent.create', { kind: 'agent', id }, { label, project });
    return this.agent(id)!;
  }
  agent(id: string): Agent | null { return (this.db.prepare('SELECT * FROM agents WHERE id=?').get(id) as unknown as Agent) ?? null; }
  agents(): Agent[] { return this.db.prepare('SELECT * FROM agents ORDER BY created_at DESC').all() as unknown as Agent[]; }
  updateAgent(id: string, patch: { label?: string; project?: string | null; role?: string | null; role_detail?: string | null }, actor: Actor): Agent {
    const a = this.agent(id); if (!a) throw new KeyError('not_found', 'agent not found');
    const next = { ...a, ...patch };
    const roleChanged = patch.role !== undefined && patch.role !== a.role;
    const adminSetsRole = patch.role !== undefined || patch.role_detail !== undefined;
    this.db.prepare('UPDATE agents SET label=?, project=?, role=?, role_detail=?, role_source=? WHERE id=?')
      .run(next.label, next.project, next.role, next.role_detail, adminSetsRole ? (next.role === null ? null : 'admin') : a.role_source, id);
    this.audit.event(actor, 'agent.update', { kind: 'agent', id }, { before: { label: a.label, role: a.role }, after: patch });
    if (roleChanged) this.notify(id, 'role_changed', `Your role is now "${next.role}"${next.role_detail ? `: ${next.role_detail}` : ''} (set by the administrator).`);
    return this.agent(id)!;
  }
  /** session_describe: the agent states its role; an admin-set role stays in force. Never changes permissions. */
  describeSelf(agentId: string, d: { role?: string; role_detail?: string; status_text?: string; model_label?: string }): Agent {
    const a = this.agent(agentId)!;
    if (d.role !== undefined) {
      if (a.role_source === 'admin') {
        this.db.prepare('UPDATE agents SET role_note=? WHERE id=?').run(`${d.role}${d.role_detail ? `: ${d.role_detail}` : ''}`, agentId);
      } else {
        this.db.prepare("UPDATE agents SET role=?, role_detail=?, role_source='agent' WHERE id=?").run(d.role, d.role_detail ?? null, agentId);
      }
    }
    if (d.status_text !== undefined) this.db.prepare('UPDATE agents SET status_text=? WHERE id=?').run(d.status_text, agentId);
    if (d.model_label !== undefined) this.db.prepare('UPDATE agents SET model_label=? WHERE id=?').run(d.model_label, agentId);
    return this.agent(agentId)!;
  }

  createMachine(name: string, description: string | null, actor: Actor): Machine {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) throw new KeyError('invalid_argument', 'PC name: lowercase letters, digits and dashes');
    if (this.db.prepare('SELECT 1 FROM machines WHERE name=?').get(name)) throw new KeyError('conflict', `a PC named "${name}" exists`);
    const id = newId.pc();
    this.db.prepare('INSERT INTO machines(id,name,description,created_at) VALUES (?,?,?,?)').run(id, name, description, Date.now());
    this.audit.event(actor, 'pc.create', { kind: 'pc', id }, { name });
    return this.machine(id)!;
  }
  machine(id: string): Machine | null { return (this.db.prepare('SELECT * FROM machines WHERE id=?').get(id) as unknown as Machine) ?? null; }
  machines(): Machine[] { return this.db.prepare('SELECT * FROM machines ORDER BY name').all() as unknown as Machine[]; }
  setMachineStatus(id: string, status: 'active' | 'suspended', actor: Actor): void {
    if (!this.machine(id)) throw new KeyError('not_found', 'PC not found');
    tx(this.db, () => {
      this.db.prepare('UPDATE machines SET status=? WHERE id=?').run(status, id);
      if (status === 'suspended') {
        for (const c of this.credentialsWhere('machine_id=?', id)) this.revokeTokensFor(c.id, 'pc_suspended');
      }
    });
    this.audit.event(actor, status === 'suspended' ? 'pc.suspend' : 'pc.reactivate', { kind: 'pc', id });
  }

  // ───────────── Credentials ─────────────
  private newSecret(kind: KeyKind): { keyId: string; secret: string; full: string } {
    const keyId = randomToken(8).slice(0, 12), secret = randomToken(20).slice(0, 32);
    return { keyId, secret, full: `ah_${kind === 'app_key' ? 'app' : 'ses'}_${keyId}_${secret}` };
  }
  private verifier(secret: string): string { return hmacHex(this.pepper, secret); }

  private insertPolicy(kind: 'credential' | 'template', name: string | null, description: string | null): string {
    const id = newId.policy(), now = Date.now();
    this.db.prepare('INSERT INTO permission_policies(id,kind,name,version,description,created_at,updated_at) VALUES (?,?,?,1,?,?,?)').run(id, kind, name, description, now, now);
    this.db.prepare('INSERT INTO policy_versions(policy_id,version,rules,changed_by,change_note,created_at) VALUES (?,1,?,NULL,?,?)').run(id, '[]', 'created', now);
    return id;
  }

  createSessionKey(o: { agentId: string; label: string; expiresAt?: number | null; templateId?: string | null }, actor: Actor): { credential: Credential; secret: string } {
    if (!this.agent(o.agentId)) throw new KeyError('not_found', 'agent not found');
    return tx(this.db, () => {
      const s = this.newSecret('session_key');
      const policyId = this.insertPolicy('credential', null, null);
      const id = newId.credential();
      this.db.prepare(`INSERT INTO credentials(id,kind,agent_id,label,key_id,verifier,status,expires_at,policy_id,created_at,created_by_admin)
        VALUES (?,?,?,?,?,?,'active',?,?,?,?)`).run(id, 'session_key', o.agentId, o.label, s.keyId, this.verifier(s.secret), o.expiresAt ?? null, policyId, Date.now(), actor.kind === 'admin' ? actor.id : null);
      if (o.templateId) this.applyTemplate(id, o.templateId, actor, 'template applied at creation');
      this.audit.event(actor, 'key.create', { kind: 'credential', id }, { kind: 'session_key', agent: o.agentId, label: o.label });
      return { credential: this.credential(id)!, secret: s.full };
    });
  }

  createAppKey(o: { machineId: string; appName: string; label?: string; maxLiveSessions?: number }, actor: Actor): { credential: Credential; secret: string } {
    const m = this.machine(o.machineId); if (!m) throw new KeyError('not_found', 'PC not found');
    return tx(this.db, () => {
      const s = this.newSecret('app_key');
      const policyId = this.insertPolicy('credential', null, null);
      const id = newId.credential();
      this.db.prepare(`INSERT INTO credentials(id,kind,machine_id,app_name,label,key_id,verifier,status,policy_id,max_live_sessions,created_at,created_by_admin)
        VALUES (?,?,?,?,?,?,?,'active',?,?,?,?)`).run(id, 'app_key', o.machineId, o.appName, o.label ?? `${o.appName} on ${m.name}`, s.keyId, this.verifier(s.secret), policyId, o.maxLiveSessions ?? 20, Date.now(), actor.kind === 'admin' ? actor.id : null);
      this.audit.event(actor, 'key.create', { kind: 'credential', id }, { kind: 'app_key', pc: m.name, app: o.appName });
      return { credential: this.credential(id)!, secret: s.full };
    });
  }

  credential(id: string): Credential | null { return (this.db.prepare(`SELECT ${CRED_COLS} FROM credentials WHERE id=?`).get(id) as unknown as Credential) ?? null; }
  private credentialsWhere(where: string, ...args: (string | number | null)[]): Credential[] {
    return this.db.prepare(`SELECT ${CRED_COLS} FROM credentials WHERE ${where} ORDER BY created_at DESC`).all(...args) as unknown as Credential[];
  }
  credentials(filter: { kind?: KeyKind; agentId?: string; machineId?: string } = {}): Credential[] {
    const w: string[] = ['1=1'], a: string[] = [];
    if (filter.kind) { w.push('kind=?'); a.push(filter.kind); }
    if (filter.agentId) { w.push('agent_id=?'); a.push(filter.agentId); }
    if (filter.machineId) { w.push('machine_id=?'); a.push(filter.machineId); }
    return this.credentialsWhere(w.join(' AND '), ...a);
  }
  allKeyIds(): string[] { return (this.db.prepare('SELECT key_id FROM credentials').all() as { key_id: string }[]).map((r) => r.key_id); }

  /** Effective status: revoked > suspended > expired > active. */
  effectiveStatus(c: Credential, now = Date.now()): 'active' | 'suspended' | 'revoked' | 'expired' {
    if (c.status !== 'active') return c.status;
    if (c.expires_at !== null && now >= c.expires_at) return 'expired';
    return 'active';
  }

  /** Check a presented key. Returns the credential or throws KeyError with an auth outcome code. */
  verifyKey(presented: string, expect: KeyKind): Credential {
    const m = KEY_RE.exec(presented.trim());
    if (!m) throw new KeyError('invalid', 'malformed key');
    const kind: KeyKind = m[1] === 'app' ? 'app_key' : 'session_key';
    const c = this.db.prepare('SELECT * FROM credentials WHERE key_id=?').get(m[2]!) as unknown as (Credential & { verifier: string }) | undefined;
    if (!c || c.kind !== kind || kind !== expect || !safeEqualHex(c.verifier, this.verifier(m[3]!))) throw new KeyError('unknown', 'unknown key');
    const st = this.effectiveStatus(c);
    if (st !== 'active') throw new KeyError(st, `key is ${st}`);
    if (c.machine_id) {
      const pc = this.machine(c.machine_id);
      if (pc && pc.status !== 'active') throw new KeyError('suspended', 'this PC is suspended');
    }
    const now = Date.now();
    this.db.prepare('UPDATE credentials SET last_used_at=?, first_used_at=COALESCE(first_used_at, ?) WHERE id=?').run(now, now, c.id);
    const { verifier: _v, ...rest } = c;
    return rest;
  }

  setStatus(id: string, status: 'active' | 'suspended' | 'revoked', reason: string | null, actor: Actor): Credential {
    const c = this.credential(id); if (!c) throw new KeyError('not_found', 'key not found');
    if (c.status === 'revoked') throw new KeyError('invalid_state', 'a revoked key cannot change');
    tx(this.db, () => {
      this.db.prepare('UPDATE credentials SET status=?, status_reason=?, revoked_at=? WHERE id=?').run(status, reason, status === 'revoked' ? Date.now() : null, id);
      if (status !== 'active') this.revokeTokensFor(id, status);
    });
    this.audit.event(actor, `key.${status === 'active' ? 'reactivate' : status === 'suspended' ? 'suspend' : 'revoke'}`, { kind: 'credential', id }, { reason });
    return this.credential(id)!;
  }

  setExpiry(id: string, expiresAt: number | null, actor: Actor): Credential {
    if (!this.credential(id)) throw new KeyError('not_found', 'key not found');
    this.db.prepare('UPDATE credentials SET expires_at=? WHERE id=?').run(expiresAt, id);
    this.audit.event(actor, 'key.expiry', { kind: 'credential', id }, { expires_at: expiresAt });
    return this.credential(id)!;
  }

  /**
   * Rotate: the new key takes over the policy (and thus grants); the old key is revoked,
   * every token of it ends, and the agent gets a key_rotated notice.
   */
  rotate(id: string, actor: Actor): { credential: Credential; secret: string } {
    const old = this.credential(id); if (!old) throw new KeyError('not_found', 'key not found');
    if (old.status === 'revoked') throw new KeyError('invalid_state', 'a revoked key cannot be rotated');
    return tx(this.db, () => {
      const s = this.newSecret(old.kind);
      const spare = this.insertPolicy('credential', null, 'released by rotation');
      this.db.prepare("UPDATE credentials SET policy_id=?, status='revoked', status_reason='rotated', revoked_at=? WHERE id=?").run(spare, Date.now(), id);
      this.revokeTokensFor(id, 'rotated');
      const nid = newId.credential();
      this.db.prepare(`INSERT INTO credentials(id,kind,agent_id,machine_id,app_name,label,key_id,verifier,status,expires_at,replaces_credential_id,policy_id,max_live_sessions,created_at,created_by_admin)
        VALUES (?,?,?,?,?,?,?,?,'active',?,?,?,?,?,?)`).run(nid, old.kind, old.agent_id, old.machine_id, old.app_name, old.label, s.keyId, this.verifier(s.secret), old.expires_at, id, old.policy_id, old.max_live_sessions, Date.now(), actor.kind === 'admin' ? actor.id : null);
      this.db.prepare('UPDATE temporary_grants SET credential_id=? WHERE credential_id=?').run(nid, id);
      this.db.prepare("UPDATE access_requests SET credential_id=? WHERE credential_id=? AND status='pending'").run(nid, id);
      if (old.agent_id) this.notify(old.agent_id, 'key_rotated', 'Your session key was rotated. Wait for the new key from the administrator, then call session_login with it.');
      this.audit.event(actor, 'key.rotate', { kind: 'credential', id: nid }, { replaces: id });
      return { credential: this.credential(nid)!, secret: s.full };
    });
  }

  /** "End logins": revokes tokens; the session can log in again. */
  endLogins(id: string, actor: Actor): number {
    const c = this.credential(id); if (!c) throw new KeyError('not_found', 'key not found');
    const n = this.revokeTokensFor(id, 'end_logins');
    if (c.agent_id) this.notify(c.agent_id, 'logins_ended', 'The administrator ended your logins. Call session_login again if you still have work.');
    this.audit.event(actor, 'key.end_logins', { kind: 'credential', id }, { tokens: n });
    return n;
  }

  /** Archive an agent: end every login, revoke its session keys, keep all history. */
  archiveAgent(id: string, actor: Actor): { ended: number } {
    const a = this.agent(id); if (!a) throw new KeyError('not_found', 'agent not found');
    if (a.status === 'archived') throw new KeyError('invalid_state', 'already archived');
    const ended = tx(this.db, () => {
      let n = 0;
      for (const c of this.credentialsWhere('agent_id=?', id)) {
        n += this.revokeTokensFor(c.id, 'archived');
        if (c.status !== 'revoked') this.db.prepare("UPDATE credentials SET status='revoked', status_reason='archived', revoked_at=? WHERE id=?").run(Date.now(), c.id);
      }
      this.db.prepare("UPDATE agents SET status='archived', archived_at=? WHERE id=?").run(Date.now(), id);
      return n;
    });
    this.audit.event(actor, 'agent.archive', { kind: 'agent', id }, { tokens: ended });
    return { ended };
  }

  private revokeTokensFor(credentialId: string, reason: string): number {
    const r = this.db.prepare('UPDATE session_tokens SET revoked_at=?, revoked_reason=? WHERE (session_credential_id=? OR app_credential_id=?) AND revoked_at IS NULL')
      .run(Date.now(), reason, credentialId, credentialId);
    return Number(r.changes);
  }

  // ───────────── Policies ─────────────
  rules(policyId: string, includeTeam = true): Rule[] {
    return (this.db.prepare(`SELECT id,effect,actions,resource,from_template,note,team_id FROM permission_rules WHERE policy_id=? ${includeTeam ? '' : 'AND team_id IS NULL'} ORDER BY position`).all(policyId) as { id: string; effect: 'allow' | 'deny'; actions: string; resource: string; from_template: string | null; note: string | null; team_id: string | null }[])
      .map(({ team_id, ...r }) => ({ ...r, actions: JSON.parse(r.actions) as string[], ...(team_id ? { team_id } : {}) }));
  }
  /** Policy rules plus the credential's temporary grants (each carries its window; the engine checks it per decision). */
  rulesFor(credentialId: string): Rule[] {
    const c = this.credential(credentialId);
    return c ? [...this.rules(c.policy_id), ...this.activeGrants(credentialId).map((g): Rule => ({ id: `tmp:${g.id}`, effect: 'allow', actions: g.actions, resource: g.resource, note: 'temporary grant', not_before: g.not_before, not_after: g.not_after }))] : [];
  }
  /** Grants not revoked and not yet expired (future ones included). */
  activeGrants(credentialId: string): { id: string; actions: string[]; resource: string; not_before: number; not_after: number; access_request_id: string | null }[] {
    return (this.db.prepare('SELECT id,actions,resource,not_before,not_after,access_request_id FROM temporary_grants WHERE credential_id=? AND revoked_at IS NULL AND not_after>? ORDER BY created_at').all(credentialId, Date.now()) as { id: string; actions: string; resource: string; not_before: number; not_after: number; access_request_id: string | null }[])
      .map((g) => ({ ...g, actions: JSON.parse(g.actions) as string[] }));
  }
  policyVersion(policyId: string): number { return (this.db.prepare('SELECT version FROM permission_policies WHERE id=?').get(policyId) as { version: number }).version; }

  /** Replace a policy's rules; records a new immutable version. */
  setRules(policyId: string, rules: Omit<Rule, 'id'>[], note: string | null, actor: Actor): number {
    rules = rules.filter((r) => !r.team_id); // team-generated rules are managed by the team only
    validateRules(rules);
    return tx(this.db, () => {
      this.db.prepare('DELETE FROM permission_rules WHERE policy_id=? AND team_id IS NULL').run(policyId);
      const now = Date.now();
      const stored: Rule[] = rules.map((r, i) => {
        const id = newId.rule();
        this.db.prepare('INSERT INTO permission_rules(id,policy_id,position,effect,actions,resource,from_template,note,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
          .run(id, policyId, i, r.effect, JSON.stringify(r.actions), r.resource, r.from_template ?? null, r.note ?? null, now);
        return { id, effect: r.effect, actions: r.actions, resource: r.resource, from_template: r.from_template ?? null, note: r.note ?? null };
      });
      const v = this.policyVersion(policyId) + 1;
      this.db.prepare('UPDATE permission_policies SET version=?, updated_at=? WHERE id=?').run(v, now, policyId);
      this.db.prepare('INSERT INTO policy_versions(policy_id,version,rules,changed_by,change_note,created_at) VALUES (?,?,?,?,?,?)')
        .run(policyId, v, JSON.stringify(stored), actor.kind === 'admin' ? actor.id : null, note, now);
      this.audit.event(actor, 'policy.update', { kind: 'policy', id: policyId }, { version: v, rules: rules.length, note });
      const cred = this.db.prepare('SELECT agent_id FROM credentials WHERE policy_id=?').get(policyId) as { agent_id: string | null } | undefined;
      if (cred?.agent_id) this.notify(cred.agent_id, 'permissions_changed', 'Your permissions changed. Call access_list to see them.');
      return v;
    });
  }

  versions(policyId: string): { version: number; rules: Rule[]; changed_by: string | null; change_note: string | null; created_at: number }[] {
    return (this.db.prepare('SELECT version,rules,changed_by,change_note,created_at FROM policy_versions WHERE policy_id=? ORDER BY version DESC').all(policyId) as { version: number; rules: string; changed_by: string | null; change_note: string | null; created_at: number }[])
      .map((v) => ({ ...v, rules: JSON.parse(v.rules) as Rule[] }));
  }

  rollback(policyId: string, version: number, actor: Actor): number {
    const v = this.versions(policyId).find((x) => x.version === version);
    if (!v) throw new KeyError('not_found', 'version not found');
    return this.setRules(policyId, v.rules.map(({ id: _i, ...r }) => r), `rollback to version ${version}`, actor);
  }

  // ───────────── Templates ─────────────
  templates(): { id: string; name: string; description: string | null; version: number; rules: Rule[] }[] {
    return (this.db.prepare("SELECT id,name,description,version FROM permission_policies WHERE kind='template' ORDER BY name").all() as { id: string; name: string; description: string | null; version: number }[])
      .map((t) => ({ ...t, rules: this.rules(t.id) }));
  }
  createTemplate(name: string, description: string | null, rules: Omit<Rule, 'id'>[], actor: Actor): string {
    if (this.db.prepare("SELECT 1 FROM permission_policies WHERE kind='template' AND name=?").get(name)) throw new KeyError('conflict', `template "${name}" exists`);
    return tx(this.db, () => { const id = this.insertPolicy('template', name, description); this.setRules(id, rules, 'created', actor); return id; });
  }
  /** Copy a template's rules into a key (appended; provenance kept; no inheritance). */
  applyTemplate(credentialId: string, templateId: string, actor: Actor, note = 'template applied'): number {
    const c = this.credential(credentialId); if (!c) throw new KeyError('not_found', 'key not found');
    const t = this.templates().find((x) => x.id === templateId); if (!t) throw new KeyError('not_found', 'template not found');
    const merged = [...this.rules(c.policy_id, false).map(({ id: _i, ...r }) => r), ...t.rules.map(({ id: _i, ...r }) => ({ ...r, from_template: `${t.name}@${t.version}` }))];
    return this.setRules(c.policy_id, merged, `${note}: ${t.name}`, actor);
  }

  // ───────────── Login tokens ─────────────
  login(app: Credential, sessionKey: string): { token: string; credential: Credential; concurrent: boolean } {
    const ses = this.verifyKey(sessionKey, 'session_key');
    const now = Date.now();
    const live = (this.db.prepare('SELECT COUNT(*) n FROM session_tokens WHERE app_credential_id=? AND revoked_at IS NULL AND expires_at>?').get(app.id, now) as { n: number }).n;
    if (live >= app.max_live_sessions) throw new KeyError('rate_limited', `this app already has ${live} live sessions (limit ${app.max_live_sessions})`);
    const others = (this.db.prepare('SELECT COUNT(*) n FROM session_tokens WHERE session_credential_id=? AND revoked_at IS NULL AND expires_at>?').get(ses.id, now) as { n: number }).n;
    const token = `ah_tok_${randomToken(25).slice(0, 40)}`;
    const maxSeq = (this.db.prepare('SELECT COALESCE(MAX(seq),0) s FROM agent_notices WHERE agent_id=?').get(ses.agent_id!) as { s: number }).s;
    this.db.prepare('INSERT INTO session_tokens(token_hash,app_credential_id,session_credential_id,notice_acked_seq,created_at,last_used_at,expires_at) VALUES (?,?,?,?,?,?,?)')
      .run(sha256Hex(token), app.id, ses.id, maxSeq, now, now, now + TOKEN_IDLE_MS);
    this.db.prepare('UPDATE agents SET last_seen_at=? WHERE id=?').run(now, ses.agent_id!);
    return { token, credential: ses, concurrent: others > 0 };
  }

  /** Resolve a token presented with an app key. Slides the idle expiry. */
  resolveToken(app: Credential, token: string): { tokenHash: string; credential: Credential; agent: Agent } {
    if (!TOKEN_RE.test(token)) throw new KeyError('login_required', 'missing or malformed session_token; call session_login');
    const h = sha256Hex(token), now = Date.now();
    const t = this.db.prepare('SELECT * FROM session_tokens WHERE token_hash=?').get(h) as { app_credential_id: string; session_credential_id: string; expires_at: number; revoked_at: number | null; revoked_reason: string | null } | undefined;
    if (!t || t.app_credential_id !== app.id) throw new KeyError('login_required', 'unknown session_token; call session_login');
    if (t.revoked_at !== null) {
      if (t.revoked_reason === 'rotated') throw new KeyError('key_rotated', 'your key was rotated; wait for the new key');
      if (t.revoked_reason === 'suspended' || t.revoked_reason === 'revoked' || t.revoked_reason === 'pc_suspended' || t.revoked_reason === 'leak_guard' || t.revoked_reason === 'archived') throw new KeyError('key_inactive', 'your session key is not active');
      throw new KeyError('login_required', 'this login ended; call session_login again');
    }
    if (t.expires_at <= now) throw new KeyError('login_required', 'session_token expired; call session_login again');
    const c = this.credential(t.session_credential_id)!;
    if (this.effectiveStatus(c) !== 'active') throw new KeyError('key_inactive', `your session key is ${this.effectiveStatus(c)}`);
    this.db.prepare('UPDATE session_tokens SET last_used_at=?, expires_at=? WHERE token_hash=?').run(now, now + TOKEN_IDLE_MS, h);
    this.db.prepare('UPDATE credentials SET last_used_at=? WHERE id=?').run(now, c.id);
    this.db.prepare('UPDATE agents SET last_seen_at=? WHERE id=?').run(now, c.agent_id!);
    return { tokenHash: h, credential: c, agent: this.agent(c.agent_id!)! };
  }

  logout(tokenHash: string): void {
    this.db.prepare("UPDATE session_tokens SET revoked_at=?, revoked_reason='logout' WHERE token_hash=? AND revoked_at IS NULL").run(Date.now(), tokenHash);
  }

  liveLogins(filter: { credentialId?: string } = {}): { token_hash: string; app_credential_id: string; session_credential_id: string; created_at: number; last_used_at: number; expires_at: number }[] {
    const now = Date.now();
    const sql = `SELECT token_hash,app_credential_id,session_credential_id,created_at,last_used_at,expires_at FROM session_tokens
      WHERE revoked_at IS NULL AND expires_at>? ${filter.credentialId ? 'AND (session_credential_id=? OR app_credential_id=?)' : ''} ORDER BY last_used_at DESC`;
    return (filter.credentialId ? this.db.prepare(sql).all(now, filter.credentialId, filter.credentialId) : this.db.prepare(sql).all(now)) as never;
  }

  // ───────────── Notices ─────────────
  notify(agentId: string, kind: string, body: string): void {
    tx(this.db, () => {
      const seq = (this.db.prepare('SELECT COALESCE(MAX(seq),0)+1 s FROM agent_notices WHERE agent_id=?').get(agentId) as { s: number }).s;
      this.db.prepare('INSERT INTO agent_notices(id,agent_id,seq,kind,body,created_at) VALUES (?,?,?,?,?,?)').run(newId.notice(), agentId, seq, kind, body, Date.now());
    });
  }
  pendingNotices(tokenHash: string, agentId: string): Notice[] {
    const acked = (this.db.prepare('SELECT notice_acked_seq s FROM session_tokens WHERE token_hash=?').get(tokenHash) as { s: number } | undefined)?.s ?? 0;
    return this.db.prepare('SELECT * FROM agent_notices WHERE agent_id=? AND seq>? ORDER BY seq').all(agentId, acked) as unknown as Notice[];
  }
  ackNotices(tokenHash: string, upTo: number): void {
    this.db.prepare('UPDATE session_tokens SET notice_acked_seq=MAX(notice_acked_seq, ?) WHERE token_hash=?').run(upTo, tokenHash);
  }
}
