/**
 * The console's byte route for a task's attachments (docs/specification.md, Tasks "Attachments"; docs/threat-model.md).
 * The operator only: a member is refused by the route scope, and agents read through the share tools. The hub decides
 * how a file is shown from its bytes, never from its name or a type an author gave: PNG, JPEG, GIF and WebP inline;
 * HTML inline only for `as=mockup`, under a CSP that allows no script, network or form; everything else (SVG
 * included) and HTML without `as=mockup` as a download. Every answer carries nosniff, a same-origin resource policy, a
 * private cache and a CSP `sandbox` (an opaque origin even when the URL is opened alone at top level).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { KeyError } from '../keys/keys.js';
import type { TaskAttachments } from '../shares/taskAttachments.js';
import { IMAGE_TYPES, sniff } from '../shares/taskAttachments.js';
import type { VaultStore } from '../vault/store.js';
import { disposition } from '../vault/media.js';

const NOT_FOUND = () => new KeyError('not_found', 'No such attachment.');
const SANDBOX = "sandbox; default-src 'none'";
/** A mockup is static: inline styles, and images and fonts that are data in the file itself. Never script, network, forms or a base URL. */
const MOCKUP_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; frame-ancestors 'self'";

export function registerAttachmentApi(api: FastifyInstance, d: { attachments: TaskAttachments; store: VaultStore }): void {
  api.get('/api/tasks/:id/attachments/:role/file', async (req: FastifyRequest, reply) => {
    const { id, role } = req.params as { id: string; role: string };
    const query = req.query as Record<string, string | undefined>;
    if (role !== 'brief' && role !== 'submission') throw NOT_FOUND();
    const file = d.attachments.entry(id, role, query.path ?? '', query.v);
    if (!file) throw NOT_FOUND();
    const etag = `"${file.entry.blob_hash}"`;
    const base = (csp: string, kind: 'inline' | 'attachment') => reply.header('Cache-Control', 'private, no-cache').header('X-Content-Type-Options', 'nosniff')
      .header('Cross-Origin-Resource-Policy', 'same-origin').header('Content-Security-Policy', csp).header('ETag', etag)
      .header('Content-Disposition', disposition(kind, file.entry.path.split('/').at(-1) ?? 'file'));
    const inm = req.headers['if-none-match'];
    const bytes = await d.store.getBlob(file.entry.blob_hash);
    if (!bytes) throw NOT_FOUND();
    const type = sniff(bytes);
    const inline = IMAGE_TYPES.includes(type) ? type : type === 'text/html' && query.as === 'mockup' ? 'text/html; charset=utf-8' : null;
    base(inline === 'text/html; charset=utf-8' ? MOCKUP_CSP : SANDBOX, inline ? 'inline' : 'attachment');
    if (inm && inm.split(',').map((s) => s.trim().replace(/^W\//, '')).some((t) => t === etag || t === '*')) return reply.code(304).send();
    return reply.code(200).type(inline ?? 'application/octet-stream').header('Content-Length', String(bytes.length)).send(req.method === 'HEAD' ? '' : bytes);
  });
}
