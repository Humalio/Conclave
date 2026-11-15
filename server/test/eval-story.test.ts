/**
 * The Early Echo story (eval/run.mjs, docs/showcase.md §6) is the feature test suite: the whole story runs here against a
 * throwaway hub on 127.0.0.1 and its coverage gate must pass. Pacing must not change an outcome, the runner must be
 * usable in-process with progress events and an abort signal, and the gate's tool list must match the code.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = resolve(process.cwd(), '..');
const load = async (rel: string) => import(pathToFileURL(join(repo, rel)).href) as Promise<any>;

describe('Early Echo story', () => {
  it('lists exactly the MCP tools the hub registers', async () => {
    const dir = join(repo, 'server', 'src', 'mcp');
    const regs = new Set<string>();
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts'))) for (const m of readFileSync(join(dir, f), 'utf8').matchAll(/reg\('([a-z_]+)'/g)) regs.add(m[1]!);
    const { TOOLS } = await load('eval/story/coverage.mjs');
    expect([...TOOLS].sort()).toEqual([...regs].sort());
  });

  it('gives every team a plan whose links, task refs and moves stay inside it, and keeps the reveal out until Act 4', async () => {
    const { PLANS, MOVES, TASK_REFS } = await load('eval/story/plans.mjs');
    const { TEAMS } = await load('eval/story/cast.mjs');
    const { REVEAL_TERMS } = await load('eval/story/check-vault.mjs');
    // Case Command's case plan is set in step 1.7; every other team, the outside lab included, has one here.
    expect(Object.keys(PLANS).sort()).toEqual([...TEAMS.map((t: any) => t.key).filter((k: string) => k !== 'int'), 'lab'].sort());
    const keys = (team: string) => new Set([...PLANS[team].requirements, ...PLANS[team].milestones].map((i: any) => i.key));
    for (const [team, p] of Object.entries<any>(PLANS)) {
      expect(p.requirements.length).toBeGreaterThanOrEqual(4);
      expect(p.milestones.length).toBeGreaterThanOrEqual(2);
      const mine = keys(team);
      for (const r of p.requirements) for (const m of r.milestones) expect(mine.has(m), `${team} ${r.key} → ${m}`).toBe(true);
    }
    // Moves change existing items (set in Act 1 or added by an earlier act) or add new ones with a title; acts 2 and 3
    // never name a reveal term.
    const added = new Set<string>();
    for (const [act, list] of Object.entries<any>(MOVES)) {
      for (const [team, m] of list) {
        if (team === 'int') continue;
        for (const i of [...(m.requirements ?? []), ...(m.milestones ?? [])]) {
          expect(keys(team).has(i.key) || added.has(`${team}:${i.key}`) || !!i.title, `act ${act} ${team} ${i.key}`).toBe(true);
          added.add(`${team}:${i.key}`);
        }
      }
      if (Number(act) < 4) for (const term of REVEAL_TERMS) expect(JSON.stringify(list).toLowerCase()).not.toContain(term);
    }
    for (const term of REVEAL_TERMS) expect(JSON.stringify(PLANS).toLowerCase()).not.toContain(term);
    const all = new Set(Object.keys(PLANS).flatMap((t) => [...keys(t)]));
    for (const refs of Object.values<string[]>(TASK_REFS)) for (const r of refs) expect(all.has(r), r).toBe(true);
  });

  it('talks to 127.0.0.1 only', async () => {
    const { assertLocal } = await load('eval/story/lib.mjs');
    expect(assertLocal('http://127.0.0.1:8099/x')).toBe('http://127.0.0.1:8099');
    for (const u of ['http://localhost:8099', 'http://192.0.2.5:8080', 'https://hub.example.org', 'http://[::1]:8099']) expect(() => assertLocal(u)).toThrow(/127.0.0.1 only/);
  });

  it('runs the whole story and passes the coverage gate', async () => {
    const { runStory } = await load('eval/run.mjs');
    const r = await runStory({ outDir: false });
    if (!r.ok) console.error(r.failure ?? r.coverage.missing);
    expect(r.failure).toBeNull();
    expect(r.coverage.full).toBe(true);
    expect(r.coverage.missing).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.steps).toBe(r.total);
  }, 300_000);

  it('a paced replay of an act has the same outcomes as the instant run', async () => {
    const { runStory } = await load('eval/run.mjs');
    const instant = await runStory({ until: 1, outDir: false });
    const paced = await runStory({ from: 1, until: 1, pace: 50, actPause: 0.2, outDir: false });
    expect(instant.ok && paced.ok).toBe(true);
    expect(paced.pace).toBe(50);
    expect(paced.outcomeLog).toEqual(instant.outcomeLog);
  }, 180_000);

  it('the gate matches routes exactly and counts only answers below 400, or refusals the step expected and the list names', async () => {
    const { gate, ADMIN_AREAS } = await load('eval/story/coverage.mjs');
    const { Recorder } = await load('eval/story/lib.mjs');
    const hits = (rec: any) => Object.values<any[]>(gate({ rec, tools: [], full: false }).areas).flat().filter((r: any) => r.hit).map((r: any) => r.route);
    const rec = new Recorder();
    rec.begin('x', 'x');
    rec.admin('POST', '/api/teams/team_abcdefghij/start', 404);                 // a refusal does not count
    rec.admin('POST', '/api/teams/team_abcdefghij/pause', 200);
    rec.admin('GET', '/api/projects/proj_abcdefghi/items/RK-01/history', 200); // a longer route does not count for a shorter one
    expect(hits(rec)).toEqual(['POST /api/teams/:id/pause']);
    expect(Object.values<string[]>(ADMIN_AREAS).flat()).toContain('POST /api/teams');
    expect(hits(rec)).not.toContain('POST /api/teams');
    const refusedOnly = new Recorder();
    refusedOnly.begin('y', 'y');
    refusedOnly.admin('POST', '/api/teams/team_abcdefghij/start', 409, true);   // expected, but the route is not in the refusal list
    expect(hits(refusedOnly)).toEqual([]);
  });

  it('records rows only after a step passes, and not when it is skipped', async () => {
    const { runStory } = await load('eval/run.mjs');
    const { SKIPPED } = await load('eval/story/context.mjs');
    expect(SKIPPED).toBeDefined();
    const { Recorder } = await load('eval/story/lib.mjs');
    const rec = new Recorder();
    rec.begin('s', 's');
    rec.skip();
    expect(rec.skipped).toEqual(['s']);
    expect(rec.rows.size).toBe(0);
    expect(typeof runStory).toBe('function');
  });

  it('refuses a hub that does not say it is the local dev hub, and spawns hubs with a clean environment', async () => {
    const { assertLocalHub, cleanEnv } = await load('eval/story/lib.mjs');
    process.env.DEMO_MODE = '1'; process.env.ALLOWED_ORIGINS = 'https://real.example';
    try { expect(Object.keys(cleanEnv())).not.toEqual(expect.arrayContaining(['DEMO_MODE'])); expect(cleanEnv().ALLOWED_ORIGINS).toBeUndefined(); }
    finally { delete process.env.DEMO_MODE; delete process.env.ALLOWED_ORIGINS; }
    const { createServer } = await import('node:http');
    const srv = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/login') res.setHeader('set-cookie', 'sid=1; Path=/').end(JSON.stringify({ csrf: 'c' }));
      else res.end(JSON.stringify({ public_url: 'https://hub.real.example' })); // a tunnel to a real hub
    });
    await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
    try {
      const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
      await expect(assertLocalHub({ base, admin: { username: 'admin', password: 'x' } })).rejects.toThrow(/not a local dev or story hub/);
    } finally { srv.close(); }
  });

  it('runs in-process with progress events and stops on abort', async () => {
    const { runStory } = await load('eval/run.mjs');
    const ac = new AbortController();
    const events: any[] = [];
    const r = await runStory({ until: 1, outDir: false, signal: ac.signal, onProgress: (e: any) => { events.push(e); if (e.type === 'step' && e.index === 5) ac.abort(new Error('aborted by test')); } });
    expect(r.ok).toBe(false);
    expect(r.failure.message).toMatch(/aborted/);
    expect(events[0]).toMatchObject({ type: 'act', act: 0 });
    expect(events.filter((e) => e.type === 'step').every((e) => e.total > 0 && e.index <= e.total)).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'done', ok: false });
  }, 120_000);
});
