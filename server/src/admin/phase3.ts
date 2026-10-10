/** Phase 3 admin routes: conversation monitor (F3). Registered inside the authenticated /api scope; read-only. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Db } from '../db/db.js';
import type { Keys } from '../keys/keys.js';
import { KeyError } from '../keys/keys.js';
import type { Actor } from '../audit/audit.js';
import type { Messaging } from '../messaging/messaging.js';

export interface Phase3Deps { db: Db; keys: Keys; messaging: Messaging }

type Msg = { id: string; room_id: string; seq: number; sender_agent_id: string | null; kind: string; body: string; reply_to: string | null; size_bytes: number; created_at: number; redacted_at: number | null; client_msg_id: string | null };
const msgView = (m: Msg) => ({ id: m.id, room_id: m.room_id, seq: m.seq, from: m.sender_agent_id ?? 'hub', kind: m.kind, content: m.redacted_at ? '' : m.body, reply_to: m.reply_to, size_bytes: m.size_bytes, created_at: m.created_at, redacted: !!m.redacted_at });

export function registerPhase3(api: FastifyInstance, d: Phase3Deps, actor: (r: FastifyRequest) => Actor): void {
  const { db, keys, messaging } = d;
  void actor;
  const label = (id: string | null) => (id ? keys.agent(id)?.label ?? null : null);
  const roomView = (r: { id: string; kind: string; name: string | null; direct_key: string | null; last_seq: number; created_at: number; archived_at: number | null }) => {
    const members = messaging.members(r.id).map((m) => ({ agent_id: m.agent_id, label: label(m.agent_id), role: m.role }));
    const last = db.prepare('SELECT * FROM messages WHERE room_id=? ORDER BY seq DESC LIMIT 1').get(r.id) as unknown as Msg | undefined;
    const c = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(size_bytes),0) b FROM messages WHERE room_id=?').get(r.id) as { n: number; b: number };
    const names = r.direct_key ? r.direct_key.split('|').map((a) => label(a) ?? a).join(' / ') : null;
    return { id: r.id, kind: r.kind, name: r.name ?? names, participants: r.direct_key ? r.direct_key.split('|') : null, members, message_count: c.n, bytes: c.b, last_message: last ? msgView(last) : null, created_at: r.created_at, archived: !!r.archived_at };
  };
  const roomOr404 = (id: string) => { const r = messaging.room(id); if (!r) throw new KeyError('not_found', 'conversation not found'); return r; };
  const q = (req: FastifyRequest) => req.query as Record<string, string | undefined>;
  const int = (v: string | undefined, def: number, min: number, max: number) => { const n = Number(v); return Number.isInteger(n) ? Math.max(min, Math.min(max, n)) : def; };

  api.get('/api/conversations', async () => {
    const rooms = db.prepare(`SELECT r.* FROM rooms r LEFT JOIN (SELECT room_id, MAX(created_at) t FROM messages GROUP BY room_id) m ON m.room_id=r.id ORDER BY COALESCE(m.t, r.created_at) DESC`).all() as never[];
    return { conversations: rooms.map(roomView) };
  });

  api.get('/api/conversations/:roomId/messages', async (req) => {
    const r = roomOr404((req.params as { roomId: string }).roomId);
    const before = q(req).before ? int(q(req).before, 0, 1, Number.MAX_SAFE_INTEGER) : undefined, limit = int(q(req).limit, 50, 1, 200);
    const rows = messaging.history(r.id, before, limit + 1) as unknown as Msg[];
    const more = rows.length > limit;
    const items = more ? rows.slice(1) : rows;
    return { room: roomView(r), messages: items.map(msgView), more, next_before: more ? items[0]!.seq : null };
  });

  api.get('/api/messages/search', async (req) => {
    const text = (q(req).q ?? '').trim();
    if (!text) throw new KeyError('invalid_argument', 'q is required');
    const like = `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const rows = db.prepare("SELECT * FROM messages WHERE redacted_at IS NULL AND body LIKE ? ESCAPE '\\' ORDER BY created_at DESC, rowid DESC LIMIT 200").all(like) as unknown as Msg[];
    return { query: text, messages: rows.map(msgView) };
  });

  api.get('/api/conversations/:roomId/export', async (req, reply) => {
    const r = roomOr404((req.params as { roomId: string }).roomId);
    const rows = db.prepare('SELECT * FROM messages WHERE room_id=? ORDER BY seq').all(r.id) as unknown as Msg[];
    reply.header('content-disposition', `attachment; filename="${r.id}.json"`);
    return { exported_at: Date.now(), room: roomView(r), messages: rows.map(msgView) };
  });
}
