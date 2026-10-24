/** Phase 2 admin routes: sessions (F2), links, topology, metrics, PC setup and folders. Registered inside the authenticated /api scope. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/db.js';
import type { Keys } from '../keys/keys.js';
import { KeyError } from '../keys/keys.js';
import type { Actor, Audit } from '../audit/audit.js';
import type { Config } from '../config.js';
import type { Setup } from '../setup/setup.js';
import type { Links } from '../links/links.js';

export interface Phase2Deps { db: Db; keys: Keys; setup: Setup; links: Links; config: Config; audit: Audit }

export function setupMessage(hub: string, setupKey: string, pcName: string): string {
  return [
    `Set up this PC ("${pcName}") for Conclave.`,
    `Using the Conclave MCP server that is already configured in this app (${hub}/mcp), call the tool \`setup_pc\` with:`,
    `- setup_key: ${setupKey}`,
    '- os: windows, macos or linux (the OS you are running on)',
    '- proposed_folders: the absolute paths of the folders on this PC you want to share with the hub (the administrator confirms each one)',
    'Follow the returned steps in order: write the bridge program, verify its SHA-256, pair, register it as a background service. Then call `setup_status` with the same setup key until it reports done.',
    'The setup key works once, only for setup_pc and setup_status, and expires in one hour. Do not paste it anywhere else.',
  ].join('\n');
}

type Login = { token_hash: string; app_credential_id: string; session_credential_id: string; created_at: number; last_used_at: number };

export function registerPhase2(api: FastifyInstance, d: Phase2Deps, actor: (r: FastifyRequest) => Actor): void {
  const { db, keys, setup, links, config, audit } = d;
  const body = <T extends z.ZodType>(s: T, req: FastifyRequest): z.infer<T> => s.parse(req.body ?? {});
  const p = (req: FastifyRequest, k = 'id') => (req.params as Record<string, string>)[k]!;

  // ───── sessions ─────
  const allLogins = (): Login[] => keys.liveLogins() as Login[];
  const loginView = (l: Login) => {
    const app = keys.credential(l.app_credential_id), ses = keys.credential(l.session_credential_id);
    const pc = app?.machine_id ? keys.machine(app.machine_id) : null;
    return { session_key_id: ses?.id ?? null, app_key_id: app?.id ?? null, app: app?.app_name ?? null, pc: pc ? { id: pc.id, name: pc.name } : null, since: l.created_at, last_used_at: l.last_used_at };
  };
  const sessionView = (agentId: string, logins: Login[]) => {
    const a = keys.agent(agentId)!;
    const mine = logins.filter((l) => keys.credential(l.session_credential_id)?.agent_id === agentId);
    const perKey = new Map<string, number>();
    for (const l of mine) perKey.set(l.session_credential_id, (perKey.get(l.session_credential_id) ?? 0) + 1);
    const last = db.prepare('SELECT tool,result,error_code,created_at FROM tool_invocations WHERE agent_id=? ORDER BY created_at DESC LIMIT 1').get(agentId) as { tool: string; result: string; error_code: string | null; created_at: number } | undefined;
    const files = db.prepare("SELECT path,action,decision,created_at FROM resource_access_events WHERE agent_id=? AND action LIKE 'fs.%' ORDER BY created_at DESC LIMIT 5").all(agentId);
    return {
      agent: { id: a.id, label: a.label, project: a.project, role: a.role, role_detail: a.role_detail, role_source: a.role_source, status_text: a.status_text, model_label: a.model_label, status: a.status, last_seen_at: a.last_seen_at },
      logins: mine.map(loginView), live: mine.length > 0,
      concurrent_use: [...perKey.values()].some((n) => n > 1),
      last_tool_call: last ? { tool: last.tool, result: last.result, error_code: last.error_code, at: last.created_at } : null,
      recent_files: files,
    };
  };
  api.get('/api/sessions', async (req) => {
    const all = (req.query as { all?: string }).all === '1';
    const logins = allLogins();
    const liveAgents = new Set(logins.map((l) => keys.credential(l.session_credential_id)?.agent_id).filter(Boolean) as string[]);
    const agents = keys.agents().filter((a) => a.status !== 'archived' && (all || liveAgents.has(a.id)));
    return { sessions: agents.map((a) => sessionView(a.id, logins)) };
  });
  api.get('/api/sessions/:agentId', async (req) => {
    const id = p(req, 'agentId');
    if (!keys.agent(id)) throw new KeyError('not_found', 'agent not found');
    const v = sessionView(id, allLogins());
    const sessionKeys = keys.credentials({ kind: 'session_key', agentId: id }).map((c) => ({ id: c.id, label: c.label, masked_key: `ah_ses_${c.key_id}_…`, status: keys.effectiveStatus(c), last_used_at: c.last_used_at }));
    return {
      ...v, session_keys: sessionKeys, links: links.forAgent(id),
      invocations: db.prepare('SELECT tool,result,error_code,duration_ms,created_at FROM tool_invocations WHERE agent_id=? ORDER BY created_at DESC LIMIT 30').all(id),
      accesses: db.prepare('SELECT path,action,decision,created_at FROM resource_access_events WHERE agent_id=? ORDER BY created_at DESC LIMIT 30').all(id),
      notices: db.prepare('SELECT seq,kind,body,created_at FROM agent_notices WHERE agent_id=? ORDER BY seq DESC LIMIT 50').all(id),
      // Highest notice any of this agent's logins has confirmed with session_ack; each new login is shown pending notices again.
      notices_acked_seq: (db.prepare('SELECT COALESCE(MAX(t.notice_acked_seq),0) s FROM session_tokens t JOIN credentials c ON c.id=t.session_credential_id WHERE c.agent_id=?').get(id) as { s: number }).s,
      role_note: keys.agent(id)!.role_note ?? null,
      // Standing instructions from teams: the playbook of each team role this agent holds (agents read it with team_info).
      playbooks: db.prepare(`SELECT t.id team_id, t.name team_name, t.status team_status, m.role, r.playbook FROM team_members m JOIN teams t ON t.id=m.team_id
        LEFT JOIN team_roles r ON r.team_id=m.team_id AND r.role=m.role WHERE m.agent_id=? ORDER BY t.name`).all(id),
    };
  });
  /** Send the agent a directive or a message. It arrives as a notice with the agent's next hub call; the agent confirms it with session_ack. */
  api.post('/api/agents/:agentId/notices', async (req) => {
    const id = p(req, 'agentId');
    const a = keys.agent(id);
    if (!a || a.status === 'archived') throw new KeyError('not_found', 'agent not found');
    const b = z.object({ kind: z.enum(['directive', 'message']), body: z.string().trim().min(1).max(4000) }).parse(req.body ?? {});
    keys.notify(id, b.kind, b.body);
    const n = db.prepare('SELECT seq,kind,body,created_at FROM agent_notices WHERE agent_id=? ORDER BY seq DESC LIMIT 1').get(id);
    audit.event(actor(req), 'agent.notice', { kind: 'agent', id }, { kind: b.kind, chars: b.body.length, text: b.body.slice(0, 200) });
    return { notice: n };
  });
  api.post('/api/sessions/:agentId/archive', async (req) => {
    const r = keys.archiveAgent(p(req, 'agentId'), actor(req));
    return { archived: true, logins_ended: r.ended, agent: keys.agent(p(req, 'agentId')) };
  });

  // ───── links ─────
  const kindSchema = z.string().trim().min(1).max(40);
  api.get('/api/links', async (req) => ({ links: links.list((req.query as { agent?: string }).agent) }));
  api.post('/api/links', async (req) => {
    const b = body(z.object({ from_agent_id: z.string(), to_agent_id: z.string(), kind: kindSchema, note: z.string().max(300).nullable().optional(), grants_messaging: z.boolean().optional() }), req);
    return { link: links.create({ from: b.from_agent_id, to: b.to_agent_id, kind: b.kind, note: b.note, grantsMessaging: b.grants_messaging }, actor(req)) };
  });
  api.patch('/api/links/:id', async (req) => {
    const b = body(z.object({ kind: kindSchema.optional(), note: z.string().max(300).nullable().optional(), grants_messaging: z.boolean().optional() }), req);
    return { link: links.update(p(req), { kind: b.kind, note: b.note, grantsMessaging: b.grants_messaging }, actor(req)) };
  });
  api.delete('/api/links/:id', async (req) => { links.remove(p(req), actor(req)); return { ok: true }; });

  // ───── PCs: bridge, folders, setup ─────
  const pcView = (id: string) => {
    const m = keys.machine(id)!;
    const appKeys = keys.credentials({ kind: 'app_key', machineId: id });
    return { ...m, bridge: setup.bridgeInfo(id), folders: setup.folders(id), app_keys: appKeys.length };
  };
  api.get('/api/pcs', async () => ({ pcs: keys.machines().map((m) => pcView(m.id)) }));
  api.post('/api/pcs/:id/setup', async (req) => {
    const pc = keys.machine(p(req));
    if (!pc) throw new KeyError('not_found', 'PC not found');
    const r = setup.createSetupKey(pc.id, actor(req));
    return { setup_key: r.secret, expires_at: r.expires_at, setup_message: setupMessage(config.publicUrl, r.secret, pc.name), pc: pcView(pc.id) };
  });
  const decide = (status: 'approved' | 'rejected') => async (req: FastifyRequest) => {
    const id = p(req);
    if (!keys.machine(id)) throw new KeyError('not_found', 'PC not found');
    setup.decideFolder(id, p(req, 'path'), status, actor(req));
    return { pc: pcView(id) };
  };
  for (const s of ['approve', 'reject'] as const) api.post(`/api/pcs/:id/folders/:path/${s}`, decide(s === 'approve' ? 'approved' : 'rejected'));

  // ───── topology ─────
  api.get('/api/topology', async () => {
    const logins = allLogins();
    const edgeRows = db.prepare(`SELECT m.sender_agent_id s, r.id room, r.kind kind, r.direct_key dk, COUNT(*) n FROM messages m JOIN rooms r ON r.id=m.room_id
      WHERE m.created_at>? AND m.sender_agent_id IS NOT NULL GROUP BY m.sender_agent_id, r.id`).all(Date.now() - 3600_000) as { s: string; room: string; kind: string; dk: string | null; n: number }[];
    const message_edges = edgeRows.map((e) => ({ from: e.s, to: e.dk ? e.dk.split('|').find((x) => x !== e.s)! : e.room, room_id: e.room, room_kind: e.kind, count: e.n }));
    // Who talked to whom over the last 7 days, with the latest message time so the console can colour recent edges.
    const commRows = db.prepare(`SELECT m.sender_agent_id s, r.id room, r.kind kind, r.direct_key dk, COUNT(*) n, MAX(m.created_at) last FROM messages m JOIN rooms r ON r.id=m.room_id
      WHERE m.created_at>? AND m.sender_agent_id IS NOT NULL GROUP BY m.sender_agent_id, r.id`).all(Date.now() - 7 * 86400_000) as { s: string; room: string; kind: string; dk: string | null; n: number; last: number }[];
    const comm_edges = commRows.map((e) => ({ from: e.s, to: e.dk ? e.dk.split('|').find((x) => x !== e.s)! : e.room, room_id: e.room, room_kind: e.kind, count: e.n, last_at: e.last }));
    return {
      message_edges,
      comm_edges,
      pcs: keys.machines().map((m) => ({
        id: m.id, name: m.name, status: m.status, bridge: setup.bridgeInfo(m.id), folders: setup.folders(m.id),
        app_keys: keys.credentials({ kind: 'app_key', machineId: m.id }).map((c) => ({
          id: c.id, app: c.app_name, status: keys.effectiveStatus(c),
          sessions: logins.filter((l) => l.app_credential_id === c.id).map((l) => {
            const ses = keys.credential(l.session_credential_id), a = ses?.agent_id ? keys.agent(ses.agent_id) : null;
            return { agent_id: a?.id ?? null, label: a?.label ?? null, role: a?.role ?? null, since: l.created_at, last_used_at: l.last_used_at };
          }),
        })),
      })),
    };
  });

  // ───── metrics ─────
  api.get('/api/metrics', async () => {
    const now = Date.now(), H = 3600_000, end = Math.floor(now / H) * H, start = end - 23 * H;
    const n = (sql: string, ...a: (string | number)[]) => (db.prepare(sql).get(...a) as { n: number }).n;
    const series = (sql: string) => {
      const rows = db.prepare(sql).all(start) as { b: number; n: number }[];
      const m = new Map(rows.map((r) => [r.b, r.n]));
      return Array.from({ length: 24 }, (_, i) => ({ hour: start + i * H, count: m.get(start + i * H) ?? 0 }));
    };
    const bucket = (col: string) => `CAST(${col} / ${H} AS INTEGER) * ${H}`;
    return {
      generated_at: now,
      counts: {
        pcs: n("SELECT COUNT(*) n FROM machines WHERE status<>'retired'"), pcs_online_bridge: n('SELECT COUNT(*) n FROM machines WHERE bridge_last_seen_at>?', now - 90_000),
        agents: n("SELECT COUNT(*) n FROM agents WHERE status<>'archived'"), live_logins: keys.liveLogins().length,
        live_agents: new Set(keys.liveLogins().map((l) => keys.credential(l.session_credential_id)?.agent_id)).size,
        open_alerts: n("SELECT COUNT(*) n FROM security_alerts WHERE status='open'"), pending_folders: n("SELECT COUNT(*) n FROM machine_folders WHERE status='proposed'"),
        messages_24h: n('SELECT COUNT(*) n FROM messages WHERE created_at>=?', start), conversations: n('SELECT COUNT(*) n FROM rooms WHERE archived_at IS NULL'),
        tasks_open: n("SELECT COUNT(*) n FROM tasks WHERE status NOT IN ('done','cancelled')"), tasks_done_24h: n("SELECT COUNT(*) n FROM task_events WHERE to_status='done' AND created_at>=?", start),
        teams_running: n("SELECT COUNT(*) n FROM teams WHERE status='running'"), teams_paused: n("SELECT COUNT(*) n FROM teams WHERE status='paused'"),
        tool_calls_24h: n('SELECT COUNT(*) n FROM tool_invocations WHERE created_at>=?', start), denials_24h: n("SELECT COUNT(*) n FROM tool_invocations WHERE result='denied' AND created_at>=?", start),
      },
      series: {
        logins: series(`SELECT ${bucket('created_at')} b, COUNT(*) n FROM authentication_events WHERE subject_kind='session_key' AND outcome='success' AND created_at>=? GROUP BY b`),
        tool_calls: series(`SELECT ${bucket('created_at')} b, COUNT(*) n FROM tool_invocations WHERE created_at>=? GROUP BY b`),
        messages: series(`SELECT ${bucket('created_at')} b, COUNT(*) n FROM messages WHERE created_at>=? GROUP BY b`),
        denials: series(`SELECT ${bucket('created_at')} b, COUNT(*) n FROM tool_invocations WHERE result='denied' AND created_at>=? GROUP BY b`),
        tasks_done: series(`SELECT ${bucket('created_at')} b, COUNT(*) n FROM task_events WHERE to_status='done' AND created_at>=? GROUP BY b`),
        vault_reads: series(`SELECT ${bucket('created_at')} b, COUNT(*) n FROM resource_access_events WHERE action='fs.read' AND decision='allow' AND created_at>=? GROUP BY b`),
      },
    };
  });
}
