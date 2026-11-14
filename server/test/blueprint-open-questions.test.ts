/**
 * The Open questions view (docs/blueprint.md §6, §7, §9): GET /api/projects/:id/questions groups nothing itself but gives
 * each row what the console groups by (stage, blocks, overdue by the one shared rule), a research project reads newest
 * activity first with no overdue marker, the card and the status report count what blocks work, only blocking items reach
 * For awareness, a question's page lists the decisions made from it, and `purpose` survives the export.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type App } from '../src/app.js';
import type { Op } from '../src/blueprint/blueprint.js';
import { parseMarkdown, parseExport } from '../src/blueprint/restore.js';
import { KINDS } from '../src/blueprint/kinds.js';
import { BP_WRITING } from '../src/mcp/writing.js';
import { testConfig, adminLogin } from './hub.js';

const sys = { kind: 'system' as const, id: null };
const DAY = 86_400_000;
type S = { cookie: string; csrf: string };
let app: App, base = '', adminId = '', P = '', R = '', teamA = '';
let admin: S;

const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any; raw: string }> => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie: admin.cookie, 'x-csrf-token': admin.csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  const raw = await r.text(); let json: any = {}; try { json = JSON.parse(raw); } catch { /* not JSON */ }
  return { status: r.status, body: json, raw };
};
const opr = () => ({ kind: 'operator' as const, id: adminId });
const put = (pid: string, ops: Op[]) => app.blueprint.write(pid, { version: app.blueprint.project(pid)!.version, ops }, opr());
const age = (pid: string, key: string, days: number) => app.db.prepare('UPDATE bp_items SET created_at=?, updated_at=? WHERE project_id=? AND key=?').run(Date.now() - days * DAY, Date.now() - days * DAY, pid, key);
const keys = (L: { key: string }[]) => L.map((i) => i.key);

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ahoq-'));
  mkdirSync(join(dir, 'vault'));
  app = await buildApp(testConfig(dir));
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  admin = await adminLogin(base);
  adminId = (app.db.prepare('SELECT id FROM admin_users LIMIT 1').get() as { id: string }).id;
  const a = app.keys.createAgent('oq-coord', null, sys), k = app.keys.createSessionKey({ agentId: a.id, label: 'oq' }, sys);
  teamA = app.teams.create({ name: 'Bookings core', goal: 'g', members: [{ agent_id: a.id, role: 'coordinator', credential_id: k.credential.id }] }, sys).id;
  app.teams.start(teamA, sys);
  P = app.blueprint.ensureTeamProject(teamA).id;
  const asked = Date.now() - 20 * DAY;
  put(P, [
    { op: 'upsert', kind: 'stakeholder', key: 'SH-1', title: 'Client finance lead' },
    { op: 'upsert', kind: 'stakeholder', key: 'SH-2', title: 'Client product owner' },
    { op: 'upsert', kind: 'module', key: 'BOOK', title: 'Booking', team_id: teamA },
    { op: 'upsert', kind: 'fr', key: 'FR-BOOK-01', parent_key: 'BOOK', title: 'Refund a booking', status: 'agreed' },
    { op: 'upsert', kind: 'fr', key: 'FR-BOOK-02', parent_key: 'BOOK', title: 'Pay online', status: 'agreed' },
    { op: 'upsert', kind: 'fr', key: 'FR-BOOK-03', parent_key: 'BOOK', title: 'Print a receipt', status: 'verified' },
    // Waiting, asked 20 days ago: overdue.
    { op: 'upsert', kind: 'question', key: 'Q-BOOK-01', parent_key: 'BOOK', title: 'Which VAT rate applies to the deposit?', fields: { asked_to: 'SH-1', asked_at: asked, purpose: 'Today 23% on the full price. Exempt: invoices split in two.' } },
    // Waiting with no asked date: aged from creation (set to 20 days ago below), so overdue too.
    { op: 'upsert', kind: 'question', key: 'Q-BOOK-02', parent_key: 'BOOK', title: 'Can one booking cover two venues?', fields: { asked_to: 'SH-2' } },
    // Blocking work: it blocks an agreed requirement.
    { op: 'upsert', kind: 'question', key: 'Q-BOOK-03', parent_key: 'BOOK', title: 'Card refund or credit?', fields: { asked_to: 'SH-1', asked_at: Date.now() - 3 * DAY } },
    { op: 'link', from: 'Q-BOOK-03', to: 'FR-BOOK-01', rel: 'blocks' },
    // Not asked yet, blocking nothing while its module has open requirements: the hint.
    { op: 'upsert', kind: 'question', key: 'Q-BOOK-04', parent_key: 'BOOK', title: 'Is a phone number required?' },
    // Answered.
    { op: 'upsert', kind: 'question', key: 'Q-BOOK-05', parent_key: 'BOOK', title: 'Free a cancelled slot at once?', status: 'answered', fields: { asked_to: 'SH-2', answer: 'At once.' } },
    // Its blocks link points at a verified requirement, which is not open: it blocks nothing.
    { op: 'upsert', kind: 'question', key: 'Q-BOOK-06', parent_key: 'BOOK', title: 'Which receipt layout?' },
    { op: 'link', from: 'Q-BOOK-06', to: 'FR-BOOK-03', rel: 'blocks' },
    // Created long ago, asked two days ago: the asked date counts, so it is not old.
    { op: 'upsert', kind: 'question', key: 'Q-BOOK-07', parent_key: 'BOOK', title: 'Do guests need an account?', fields: { asked_to: 'SH-2', asked_at: Date.now() - 2 * DAY } },
    // An open issue that blocks an open requirement, and one that blocks nothing.
    { op: 'upsert', kind: 'issue', key: 'I4', title: 'Payment sandbox rejects test cards' },
    { op: 'link', from: 'I4', to: 'FR-BOOK-02', rel: 'blocks' },
    { op: 'upsert', kind: 'issue', key: 'I5', title: 'Logo is blurry' },
    // Decisions made from Q-BOOK-05.
    { op: 'upsert', kind: 'decision', key: 'ADR-001', title: 'Free a slot at once', status: 'accepted', fields: { source: 'bp:Q-BOOK-05' } },
    { op: 'upsert', kind: 'decision', key: 'ADR-002', title: 'Card bookings wait for the refund', fields: { source: 'bp:Q-BOOK-05' } },
    { op: 'upsert', kind: 'decision', key: 'ADR-003', title: 'Unrelated', status: 'accepted' },
  ] as Op[]);
  age(P, 'Q-BOOK-02', 20); age(P, 'Q-BOOK-07', 30); age(P, 'I4', 6);

  R = (await call('POST', '/projects', { key: 'RAL', name: 'Reading lab', kind: 'research' })).body.project.id;
  put(R, [
    { op: 'upsert', kind: 'line', key: 'L1', title: 'Retrieval', fields: { mode: 'validate' } },
    { op: 'upsert', kind: 'line', key: 'L2', title: 'Tone', fields: { mode: 'explore' } },
    { op: 'upsert', kind: 'question', key: 'Q-L1-01', parent_key: 'L1', title: 'Does re-ranking help?', fields: { criteria: 'recall@10 of at least 0.80', asked_to: 'SH-9' } },
    { op: 'upsert', kind: 'question', key: 'Q-L2-01', parent_key: 'L2', title: 'Do readers trust quotes?' },
    { op: 'upsert', kind: 'finding', key: 'F-L1-01', parent_key: 'L1', title: 'Re-ranking adds 6 points', fields: { confidence: 'medium' } },
  ] as Op[]);
  age(R, 'Q-L1-01', 40); age(R, 'Q-L2-01', 10);
  put(R, [{ op: 'link', from: 'F-L1-01', to: 'Q-L1-01', rel: 'evidence' }] as Op[]);
});
afterAll(async () => { await app?.close(); });

describe('GET /api/projects/:id/questions, software project', () => {
  it('gives each open question its stage, blocks, overdue and hint, oldest wait first', async () => {
    const r = await call('GET', `/projects/${P}/questions`);
    expect(r.status).toBe(200);
    const q = r.body, by = new Map(q.items.map((i: any) => [i.key, i]));
    expect(q.research).toBe(false);
    expect(q.counts).toEqual({ open: 6, answered: 1, dropped: 0, all: 7 });
    // Oldest wait first: Q-BOOK-01 and Q-BOOK-02 waited 20 days.
    expect(keys(q.items).slice(0, 2).sort()).toEqual(['Q-BOOK-01', 'Q-BOOK-02']);
    expect(by.get('Q-BOOK-01')).toMatchObject({ stage: 'asked', asked_to: 'SH-1', overdue: true, purpose: 'Today 23% on the full price. Exempt: invoices split in two.', blocks: [] });
    // A stakeholder with no asked date counts as asked, aged from creation.
    const q2 = by.get('Q-BOOK-02') as any;
    expect(q2).toMatchObject({ stage: 'asked', asked_at: null, overdue: true });
    expect(q2.since).toBeLessThan(Date.now() - 19 * DAY);
    expect(by.get('Q-BOOK-03')).toMatchObject({ blocks: ['FR-BOOK-01'], overdue: false });
    expect(by.get('Q-BOOK-04')).toMatchObject({ stage: 'not_asked', purpose: null, hint: 'blocks nothing' });
    // A blocks link to an item that is not open blocks nothing.
    expect((by.get('Q-BOOK-06') as any).blocks).toEqual([]);
    // Asked two days ago, created thirty: the asked date decides.
    expect(by.get('Q-BOOK-07')).toMatchObject({ overdue: false });
    // Only the open issue with a blocks link to an open item is listed.
    expect(keys(q.blocking)).toEqual(['I4']);
    expect(q.blocking[0]).toMatchObject({ kind: 'issue', blocks: ['FR-BOOK-02'] });
  });

  it('filters by status and by part, and refuses what it does not know', async () => {
    expect(keys((await call('GET', `/projects/${P}/questions?status=answered`)).body.items)).toEqual(['Q-BOOK-05']);
    expect((await call('GET', `/projects/${P}/questions?status=all`)).body.items).toHaveLength(7);
    expect((await call('GET', `/projects/${P}/questions?team=project`)).body.items).toEqual([]);
    expect((await call('GET', `/projects/${P}/questions?team=${teamA}`)).body.items).toHaveLength(6);
    expect((await call('GET', `/projects/${P}/questions?status=closed`)).status).toBe(400);
    expect((await call('GET', `/projects/${P}/questions?team=team_nope`)).status).toBe(400);
    expect((await call('GET', `/projects/${P}/questions?x=1`)).status).toBe(400);
  });
});

describe('GET /api/projects/:id/questions, research project', () => {
  it('reads newest activity first, with no overdue marker, findings counted, criteria only on a validate line', async () => {
    const q = (await call('GET', `/projects/${R}/questions`)).body, by = new Map(q.items.map((i: any) => [i.key, i]));
    expect(q.research).toBe(true);
    // Q-L1-01 is older, but its finding was linked just now.
    expect(keys(q.items)).toEqual(['Q-L1-01', 'Q-L2-01']);
    expect(by.get('Q-L1-01')).toMatchObject({ line: 'L1', mode: 'validate', findings: 1, criteria: 'recall@10 of at least 0.80', overdue: false });
    expect(by.get('Q-L2-01')).toMatchObject({ line: 'L2', mode: 'explore', findings: 0, criteria: null });
  });
});

describe('Blocking work in the card, the status report and For awareness', () => {
  it('the summary counts open questions and what blocks work', async () => {
    const s = (await call('GET', `/projects/${P}/summary`)).body;
    expect(s.questions).toEqual({ open: 6, blocking: 2 });
  });

  it('For awareness has one row for the part, Blueprint Review too, and never Needs you', async () => {
    const ny = (await call('GET', `/needs-you?limit=200&project=${P}`)).body;
    const rows = ny.awareness.items.filter((r: any) => r.kind === 'blocking_work');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: '2 items block work in ' + app.blueprint.project(P)!.name, open: { kind: 'questions', project_id: P, team_id: teamA } });
    // Long titles are cut at 32 characters so the line stays one line.
    expect(rows[0].reason).toBe('I4 Payment sandbox rejects test ca…, Q-BOOK-03 Card refund or credit? · oldest 6 days');
    expect(ny.items.some((r: any) => /block/.test(r.title))).toBe(false);
    const rv = (await call('GET', `/needs-you?limit=200&project=${P}&review=1`)).body;
    expect(rv.awareness.items.map((r: any) => r.kind)).toContain('blocking_work');
    const at = (await call('GET', '/blueprint/attention')).body;
    expect(at.counts.blocking).toBe(1);
    expect(at.items.find((i: any) => i.kind === 'bp_blocking')).toMatchObject({ count: 2, keys: ['I4', 'Q-BOOK-03'] });
  });

  it('leaves when the blockers stop blocking', async () => {
    put(P, [{ op: 'upsert', kind: 'issue', key: 'I4', title: 'Payment sandbox rejects test cards', status: 'resolved' }] as Op[]);
    expect((await call('GET', `/projects/${P}/summary`)).body.questions.blocking).toBe(1);
    put(P, [{ op: 'unlink', from: 'Q-BOOK-03', to: 'FR-BOOK-01', rel: 'blocks' }] as Op[]);
    const ny = (await call('GET', `/needs-you?limit=200&project=${P}`)).body;
    expect(ny.awareness.items.filter((r: any) => r.kind === 'blocking_work')).toEqual([]);
    expect((await call('GET', '/blueprint/attention')).body.counts.blocking).toBe(0);
    // Put back for the tests below.
    put(P, [{ op: 'link', from: 'Q-BOOK-03', to: 'FR-BOOK-01', rel: 'blocks' }] as Op[]);
  });

  it('a status report\'s hub facts count what blocks work in the team\'s part', () => {
    const q = app.blueprint.questionsOf(P, teamA);
    expect(q.items.filter((i) => i.blocks.length).map((i) => i.key)).toEqual(['Q-BOOK-03']);
  });
});

describe('the shared overdue rule (Coverage)', () => {
  it('old_questions ages a question from its asked date, else from its creation', async () => {
    const c = (await call('GET', `/projects/${P}/summary`)).body.plain.coverage;
    expect(keys(c.old_questions.items).sort()).toEqual(['Q-BOOK-01', 'Q-BOOK-02']);
    const q1 = c.old_questions.items.find((i: any) => i.key === 'Q-BOOK-01');
    expect(q1.since).toBe(app.blueprint.item(P, 'Q-BOOK-01')!.fields['asked_at']);
  });
});

describe('a question\'s page and its purpose', () => {
  it('lists the decisions made from it, each with its status', async () => {
    const d = (await call('GET', `/projects/${P}/items/Q-BOOK-05`)).body;
    expect(d.decided_in).toEqual([
      { key: 'ADR-001', title: 'Free a slot at once', status: 'accepted', superseded_by: null },
      { key: 'ADR-002', title: 'Card bookings wait for the refund', status: 'proposed', superseded_by: null },
    ]);
    expect((await call('GET', `/projects/${P}/items/FR-BOOK-01`)).body).not.toHaveProperty('decided_in');
  });

  it('purpose is a question field, in the kinds note and the writing guidance', () => {
    expect(KINDS.question.fields).toHaveProperty('purpose', 'str');
    expect(KINDS.question.note).toMatch(/purpose: what the team does today and what each answer would change/);
    expect(BP_WRITING).toContain('A question to someone outside the team says in fields.purpose what the team does today and what each answer would change');
  });

  it('survives the Markdown and JSON exports', async () => {
    const want = 'Today 23% on the full price. Exempt: invoices split in two.';
    const md = parseMarkdown((await call('GET', `/projects/${P}/export.md`)).raw);
    expect(md.items.find((i) => i.key === 'Q-BOOK-01')!.fields['purpose']).toBe(want);
    const js = parseExport((await call('GET', `/projects/${P}/export.json`)).raw);
    expect(js.items.find((i) => i.key === 'Q-BOOK-01')!.fields['purpose']).toBe(want);
  });
});
