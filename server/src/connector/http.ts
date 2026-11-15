/**
 * The connector's routes (docs/connector.md, "Hub route contract"): check-in, orders, Disconnect's receipt, the messages it
 * reports shown, usage and the approved versions. The PC's app key authenticates them; during the transition the PC's
 * bridge key is accepted for check-in only. The disconnect routes take only that order's receipt credential.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { KeyError } from '../keys/keys.js';
import type { Keys } from '../keys/keys.js';
import type { Setup } from '../setup/setup.js';
import type { Db } from '../db/db.js';
import { Connector, CLIENTS, DESTINATION_RE, PC_REPORTED, VERSION_RE } from './connector.js';

const STATUS: Record<string, number> = { invalid_argument: 400, contains_key: 400, not_found: 404, conflict: 409, invalid_state: 409 };
const version = z.string().max(40).regex(VERSION_RE);
const short = (n: number) => z.string().max(n).nullable().optional();
const CheckInBody = z.object({
  version, platform: short(40), node: short(40), git: short(40),
  clients: z.array(z.object({ client: z.enum(CLIENTS), version: z.string().max(40).nullable() }).strict()).max(10).optional(),
  auto_update: z.boolean().nullable().optional(), remote_cleanup: z.boolean().nullable().optional(),
  remove_connector_with_last_hub: z.boolean().nullable().optional(), usage_opt_in: z.boolean().nullable().optional(),
  agents: z.array(z.object({ agent_id: z.string().max(100), state: z.enum(PC_REPORTED) }).strict()).max(200).optional(),
  // Restore destinations the PC's user approved: an id and a plain label, never a path.
  destinations: z.array(z.object({ id: z.string().regex(DESTINATION_RE), label: z.string().min(1).max(80) }).strict()).max(20)
    .refine((d) => new Set(d.map((x) => x.id)).size === d.length, 'destination ids must be unique').optional(),
}).strict();
const line = z.string().max(200);
const CheckResult = z.object({ checks: z.array(z.object({ name: z.string().max(100), ok: z.boolean(), detail: line.optional() }).strict()).max(40) }).strict();
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export function registerConnector(f: FastifyInstance, db: Db, connector: Connector, keys: Keys, setup: Setup, directives?: { unreadIds(agentId: string): string[] }): void {
  const refuse = (reply: FastifyReply) => reply.code(401).header('www-authenticate', 'Bearer').send({ error: 'unauthorized', message: 'Invalid key, or the PC is suspended.' });
  const bearer = (req: FastifyRequest) => /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ''))?.[1] ?? null;
  /**
   * The PC behind the app key (or bridge key): `{pc}`, or `{refused, disconnected?}`. A key whose secret is right but whose
   * PC was suspended by Disconnect gets that order's receipt credential instead, and nothing else.
   */
  const pcOf = (req: FastifyRequest, bridge: boolean): { pc: string } | { refused: true; receipt?: string } => {
    const k = bearer(req);
    if (!k) return { refused: true };
    try {
      if (k.startsWith('ah_app_')) { const c = keys.verifyKey(k, 'app_key'); return c.machine_id ? { pc: c.machine_id } : { refused: true }; }
      // The bridge key: check-in only, and never handed a receipt.
      if (k.startsWith('ah_brg_')) return bridge ? { pc: setup.verifyBridgeKey(k).machine.id } : { refused: true };
    } catch (e) {
      if (!(e instanceof KeyError)) throw e;
      // Thrown only after the secret matched: the key is genuine, its PC is not active.
      if (e.code === 'suspended' && k.startsWith('ah_app_')) {
        const pc = suspendedPc(k);
        const r = pc ? connector.issueReceipt(pc) : null;
        if (r) return { refused: true, receipt: r };
      }
    }
    return { refused: true };
  };
  const suspendedPc = (k: string): string | null => {
    const app = /^ah_app_([a-z2-7]{12})_/.exec(k);
    return app ? (db.prepare("SELECT machine_id FROM credentials WHERE key_id=? AND kind='app_key'").get(app[1]!) as { machine_id: string | null } | undefined)?.machine_id ?? null : null;
  };
  const run = async (reply: FastifyReply, fn: () => unknown) => {
    try { return await fn(); }
    catch (e) {
      if (e instanceof z.ZodError) return reply.code(400).send({ error: 'invalid_argument', message: e.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
      if (e instanceof KeyError && STATUS[e.code]) return reply.code(STATUS[e.code]!).send({ error: e.code, message: e.message });
      throw e;
    }
  };
  const withPc = (fn: (pc: string, req: FastifyRequest) => unknown, bridge = false) => async (req: FastifyRequest, reply: FastifyReply) => {
    const who = pcOf(req, bridge);
    if ('refused' in who) {
      if (who.receipt) return reply.code(401).send({ error: 'disconnected', message: 'This hub was disconnected from this PC. Fetch the cleanup order with the receipt credential.', receipt: who.receipt, disconnect_url: '/connector/v1/disconnect' });
      return refuse(reply);
    }
    return run(reply, () => fn(who.pc, req));
  };

  f.post('/connector/v1/check-in', withPc((pc, req) => connector.checkIn(pc, CheckInBody.parse(req.body ?? {})), true));
  f.get('/connector/v1/orders', withPc((pc) => ({ orders: connector.fetchOrders(pc) })));
  f.post('/connector/v1/orders/:id/result', withPc((pc, req) => {
    const b = z.object({ state: z.enum(['done', 'failed']), result: z.unknown().optional() }).strict().parse(req.body ?? {});
    const id = (req.params as { id: string }).id;
    const kind = connector.actions(pc).find((a) => a.id === id)?.kind;
    // A check's result is bounded and typed; other kinds report at most a short reason.
    const result = kind === 'check' && b.state === 'done' ? CheckResult.parse(b.result) : z.object({ reason: line.optional() }).strict().optional().parse(b.result);
    return connector.reportOrder(pc, id, b.state, result ?? null);
  }));
  f.get('/connector/v1/versions/approved', withPc(() => ({ versions: connector.approvedVersions() })));
  // The PC's own setup timeline, for the connector's local screen (docs/connector.md, "Pairing").
  f.get('/connector/v1/setup', withPc((pc) => connector.timeline(pc)));
  f.post('/connector/v1/messages/shown', withPc((pc, req) => {
    const b = z.object({ agent_id: z.string().max(100), room_id: z.string().max(100), seq: count }).strict().parse(req.body ?? {});
    return connector.reportShown(pc, b.agent_id, b.room_id, b.seq);
  }));
  // The reminder line's counts for one agent of this PC: numbers and sender labels only, read-only (docs/connector.md, "The one reminder line").
  f.post('/connector/v1/messages/unread', withPc((pc, req) => {
    const b = z.object({ agent_id: z.string().max(100) }).strict().parse(req.body ?? {});
    const m = connector.unreadSummary(pc, b.agent_id);
    let d = 0; try { d = directives?.unreadIds(b.agent_id).length ?? 0; } catch { d = 0; }
    return { ...m, directives: d };
  }));
  f.post('/connector/v1/usage', withPc((pc, req) => {
    const row = z.object({ agent_id: z.string().max(100), client: z.enum(CLIENTS), model: z.string().max(100), input_tokens: count, output_tokens: count,
      cache_read_tokens: count, cache_write_tokens: count, sessions: count, turns: count.optional() }).strict();
    const b = z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), rows: z.array(row).max(500) }).strict().parse(req.body ?? {});
    return connector.reportUsage(pc, b.day, b.rows);
  }));

  // Disconnect: the receipt credential only, which works after the PC's own keys are dead.
  const receipt = (req: FastifyRequest) => {
    const k = bearer(req);
    if (!k) return null;
    try { return connector.verifyReceipt(k); } catch (e) { if (e instanceof KeyError) return null; throw e; }
  };
  f.get('/connector/v1/disconnect', async (req, reply) => {
    const a = receipt(req); if (!a) return refuse(reply);
    return run(reply, () => ({ order: connector.fetchDisconnect(a) }));
  });
  f.post('/connector/v1/disconnect/result', async (req, reply) => {
    const a = receipt(req); if (!a) return refuse(reply);
    return run(reply, () => {
      const b = z.object({ state: z.enum(['removed', 'needs_attention', 'cleanup_off']), left: z.array(line).max(20).optional() }).strict().parse(req.body ?? {});
      return connector.reportDisconnect(a, b.state, b.left ?? []);
    });
  });
}
