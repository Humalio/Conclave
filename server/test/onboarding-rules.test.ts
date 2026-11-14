/**
 * Directives from onboarding (docs/directives.md#from-onboarding, docs/onboarding.md#the-request): the generated CLAUDE.md
 * tells agents to read and report directives, login hints at directives_report when none are in force, a request may
 * propose rules within the hub's bounds, and only the rules the operator keeps at approval become directives.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { buildApp, type App } from '../src/app.js';
import { NO_DIRECTIVES_HINT } from '../src/mcp/tools.js';
import { testConfig, adminLogin } from './hub.js';
// @ts-expect-error: a plain ES module without types
import { validateRequest } from '../../deploy/client/setup.mjs';

let app: App, base = '', cookie = '', csrf = '', dir = '';
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const ob = async (method: string, path: string, o: { key?: string; body?: unknown; from?: string } = {}) => {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-forwarded-proto': 'https', 'x-forwarded-for': o.from ?? '10.8.0.1' };
  if (o.key) headers.authorization = `Bearer ${o.key}`;
  const r = await fetch(`${base}/onboard${path}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
let ip = 1;
const enrol = async (name: string) => {
  const add = await api('POST', '/pcs/add', { name });
  const n = `n${Math.random().toString(36).slice(2)}`.padEnd(22, 'x'), from = `10.8.1.${ip++}`;
  const e = await ob('POST', '/enrol', { body: { code: add.body.code, nonce: n }, from });
  expect(e.status, JSON.stringify(e.body)).toBe(200);
  expect((await ob('POST', '/enrol/confirm', { body: { nonce: n }, from })).status).toBe(200);
  return e.body.app_key as string;
};
let seq = 0;
const RULES = [
  { title: 'Dates in ISO format', source: 'repo AGENTS.md', text: 'Write every date as YYYY-MM-DD.', category: 'process' },
  { title: 'Check each deadline', source: 'user instruction', text: 'Compare each deadline with the funder page.', category: 'sources', role: 'reviewer' },
  { title: 'Never push', source: 'repo CLAUDE.md', text: 'Do not push to GitHub.' },
];
const request = (over: Record<string, unknown> = {}) => ({
  kind: 'new_team', project: { name: `Rules ${++seq}`, existing: false }, team: { name: `Rule team ${seq}`, goal: 'Keep the grant calendar.' },
  roles: [
    { name: 'coordinator', team_role: 'coordinator', count: 1, job: 'Plans and assigns.' },
    { name: 'writer', team_role: 'worker', count: 1, job: 'Writes entries.' },
    { name: 'reviewer', team_role: 'reviewer', count: 1, job: 'Reviews entries.', reviews: ['writer'] },
  ],
  rules: RULES, prompt: 'a grant calendar team', ...over,
});
const file = async (key: string, body: unknown) => { const f = await ob('POST', '/requests', { key, body }); return f; };
// The rules kept from the request; the two standard directives every new team gets are tested in onboarding-team-directives.test.ts.
const directivesOf = (teamId: string) => app.db.prepare("SELECT title, body, scope_kind, scope_ref, source, category, tags, reviewed_at FROM directives WHERE ((scope_kind='team' AND scope_ref=?) OR (scope_kind='role' AND scope_ref LIKE ?)) AND tags NOT LIKE '%\"standard\"%' ORDER BY title").all(teamId, `${teamId}|%`) as { title: string; body: string; scope_kind: string; scope_ref: string; source: string; category: string | null; tags: string; reviewed_at: number | null }[];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ahobrules-'));
  mkdirSync(join(dir, 'vault'));
  app = await buildApp(testConfig(dir, { publicUrl: 'https://hub.test' }));
  await app.store.ready;
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  ({ cookie, csrf } = await adminLogin(base));
});
afterAll(async () => { await app?.close(); });

describe('agents read and report directives', () => {
  it("the CLAUDE.md made at pickup has a Directives section: read at first start, report others' rules, not this file's", async () => {
    const key = await enrol('rules-claude-pc');
    const f = await file(key, request({ rules: undefined }));
    expect(f.status, JSON.stringify(f.body)).toBe(200);
    expect((await api('POST', `/onboarding/${f.body.request_id}/approve`, { version: f.body.version })).status).toBe(200);
    const p = await ob('POST', '/pickup', { key, body: { request_id: f.body.request_id } });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    const md: string = p.body.agents[0].instructions;
    const sec = md.slice(md.indexOf('## Directives'), md.indexOf('## Writing for the operator'));
    expect(md.indexOf('## Playbook')).toBeLessThan(md.indexOf('## Directives'));
    expect(sec).toContain('directives_read {unread: true, ack: true}');
    expect(sec).toContain('directives_report');
    expect(sec).toContain("Don't report rules that are already in this file (playbook, goal, job, connection); report only rules from other files, prompts or chat.");
  });
  it('login and whoami hint at directives_report when no directive is in force', () => {
    expect(NO_DIRECTIVES_HINT).toMatch(/^No directives yet\..*directives_report.*once per rule/);
    const src = readFileSync(join(process.cwd(), 'src', 'mcp', 'tools.ts'), 'utf8');
    expect(src).toMatch(/: `\\n\$\{NO_DIRECTIVES_HINT\}`;/); // dirText's empty branch
  });
});

describe('the rules list in a request', () => {
  it('the hub refuses rules outside the bounds, with field paths', async () => {
    const key = await enrol('rules-bounds-pc');
    const bad = await file(key, request({ rules: [
      { title: '', source: 'x', text: 'y' },
      { title: 'two\nlines', source: 's'.repeat(201), text: 't'.repeat(2001) },
      { title: 't', source: 's', text: 'x', category: 'nope', role: 'stakeholder' },
      { title: 't', source: 's', text: 'x', role: 'boss', extra: 1 },
      'not an object',
    ] }));
    expect(bad.status).toBe(400);
    const fields = bad.body.problems.map((x: { field: string }) => x.field);
    expect(fields).toEqual(expect.arrayContaining(['rules[0].title', 'rules[1].title', 'rules[1].source', 'rules[1].text', 'rules[2].category', 'rules[2].role', 'rules[3].role', 'rules[3].extra', 'rules[4]']));
    expect((await api('PUT', '/settings/onboarding', { max_rules: 2 })).status).toBe(200);
    const many = await file(key, request());
    expect(many.body.problems.map((x: { field: string }) => x.field)).toContain('rules');
    expect((await api('PUT', '/settings/onboarding', { max_rules: 51 })).status).toBe(400);
    expect((await api('PUT', '/settings/onboarding', { max_rules: 20 })).status).toBe(200);
  });
  it('setup.mjs checks the same bounds locally', () => {
    expect(validateRequest(request())).toEqual([]);
    const p = validateRequest(request({ rules: [{ title: 'x', source: '', text: 'y', category: 'nope', role: 'stakeholder', z: 1 }] })).map((x: { field: string }) => x.field);
    expect(p).toEqual(expect.arrayContaining(['rules[0].source', 'rules[0].category', 'rules[0].role', 'rules[0].z']));
    expect(validateRequest(request({ rules: Array.from({ length: 21 }, () => RULES[0]) })).map((x: { field: string }) => x.field)).toContain('rules');
  });
});

describe('approval turns the kept rules into directives', () => {
  it('rules start unticked: approving without ticking any adopts none', async () => {
    const key = await enrol('rules-default-pc');
    const f = await file(key, request());
    expect(f.status, JSON.stringify(f.body)).toBe(200);
    const a = await api('POST', `/onboarding/${f.body.request_id}/approve`, { version: f.body.version });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(directivesOf(a.body.request.team_id)).toHaveLength(0);
    expect(app.db.prepare("SELECT COUNT(*) n FROM directives WHERE tags LIKE '%onboarding%' AND tags NOT LIKE '%standard%'").get()).toMatchObject({ n: 0 });
  });
  it('every ticked rule is created, reviewed, filed under its category, for the team or the role', async () => {
    const key = await enrol('rules-all-pc');
    const f = await file(key, request());
    expect(f.status, JSON.stringify(f.body)).toBe(200);
    expect(app.db.prepare("SELECT COUNT(*) n FROM directives WHERE source='repo AGENTS.md'").get()).toMatchObject({ n: 0 }); // nothing before approval
    const a = await api('POST', `/onboarding/${f.body.request_id}/approve`, { version: f.body.version, edits: { rules: RULES } });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    const team = a.body.request.team_id as string;
    const D = directivesOf(team);
    expect(D).toHaveLength(3);
    const iso = D.find((d) => d.title === 'Dates in ISO format')!;
    expect(iso).toMatchObject({ scope_kind: 'team', scope_ref: team, source: 'repo AGENTS.md', category: 'process', body: 'Write every date as YYYY-MM-DD.' });
    expect(iso.reviewed_at).toBeTypeOf('number');
    expect(JSON.parse(iso.tags)).toEqual(['onboarding']);
    expect(D.find((d) => d.title === 'Check each deadline')).toMatchObject({ scope_kind: 'role', scope_ref: `${team}|reviewer`, category: 'sources' });
    expect(D.find((d) => d.title === 'Never push')).toMatchObject({ category: null });
  });
  it('unticked rules are dropped and edited ones are created as edited', async () => {
    const key = await enrol('rules-pick-pc');
    const f = await file(key, request());
    const kept = [{ ...RULES[0], title: 'ISO dates', text: 'Dates are YYYY-MM-DD.' }];
    const a = await api('POST', `/onboarding/${f.body.request_id}/approve`, { version: f.body.version, edits: { rules: kept } });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    const D = directivesOf(a.body.request.team_id);
    expect(D.map((d) => [d.title, d.body])).toEqual([['ISO dates', 'Dates are YYYY-MM-DD.']]);
    const edits = JSON.parse((app.db.prepare('SELECT edits FROM onboarding_requests WHERE id=?').get(f.body.request_id) as { edits: string }).edits) as { field: string }[];
    expect(edits.map((e) => e.field)).toContain('rules'); // the operator's changes stay on the request's record
  });
  it('an empty kept list creates none, and an edited rule is checked like a filed one', async () => {
    const key = await enrol('rules-none-pc');
    const f = await file(key, request());
    const bad = await api('POST', `/onboarding/${f.body.request_id}/approve`, { version: f.body.version, edits: { rules: [{ title: '', source: 's', text: 't' }] } });
    expect(bad.status).toBe(400);
    const a = await api('POST', `/onboarding/${f.body.request_id}/approve`, { version: f.body.version, edits: { rules: [] } });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(directivesOf(a.body.request.team_id)).toHaveLength(0);
  });
});

describe('the console shows the rules as inert text', () => {
  const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
  const block = js.slice(js.indexOf('  // ── rules the agent proposes'), js.indexOf('  const drawRules'));
  const esc = js.match(/^const esc = .*$/m)![0];
  it('every proposed rule starts unticked, its fields disabled until the operator ticks it', () => {
    expect(js).toContain('const KEEP = E.rules.map(() => false);');
    const ctx: Record<string, unknown> = { KEEP: [false], obTr: (r: string) => r, DIR_CAT_LABEL: {} };
    vm.runInNewContext(`${esc}\n${block}\nthis.ruleRow = ruleRow;`, ctx);
    const html = (ctx.ruleRow as (x: object, i: number) => string)({ title: 't', source: 's', text: 'x' }, 0);
    expect(html).toContain('class="ob-rule off"');
    expect(html).not.toMatch(/data-rui checked/);
    expect(html).toMatch(/data-ruk="title"[^>]* disabled>/);
  });
  it('a rule with markup renders escaped, in inputs, under an L2 label', () => {
    const ctx: Record<string, unknown> = { KEEP: [true], obTr: (r: string) => r[0]!.toUpperCase() + r.slice(1), DIR_CAT_LABEL: { process: 'Process & workflow' } };
    vm.runInNewContext(`${esc}\n${block}\nthis.ruleRow = ruleRow;`, ctx);
    const html = (ctx.ruleRow as (x: object, i: number) => string)({ title: '"><img src=x onerror=alert(1)>', source: '<b>AGENTS.md</b>', text: '</textarea><script>alert(1)</script>', category: 'process', role: 'reviewer' }, 0);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>');
    expect(html).toContain('value="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"');
    expect(html).toContain('&lt;/textarea&gt;&lt;script&gt;');
    expect(html).toContain('for reviewers of the team');
    expect(js).toMatch(/Written by the agent on \$\{esc\(pcName\)\}<\/span><\/div>\s*<div id="obRu">/);
  });
});
