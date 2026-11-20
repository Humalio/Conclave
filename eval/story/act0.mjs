// Act 0: hub setup through the admin API (docs/showcase.md §4).
import { PCS, TEAMS, DIRECTIVES, PLAYBOOKS, agents, rulesFor, messagingFor, PROJECTS } from './cast.mjs';

const s = (id, title, run, opts = {}) => ({ id, title, run, ...opts });

export default [
  s('0.1', 'The operator signs in', async (c) => {
    await c.op.login(c.hub.admin.username, c.hub.admin.password);
    const me = await c.op.get('/api/me');
    c.expect(me.csrf || me.username || me.user, 'GET /api/me returns the session');
  }, { beat: 1200 }),

  s('0.2', 'Reset plan on a fresh hub (read only)', async (c) => {
    const parts = (await c.op.get('/api/reset/parts')).parts.map((p) => p.key);
    await c.op.get(`/api/reset/plan?parts=${encodeURIComponent(parts.join(','))}`);
    const agents = (await c.op.get('/api/agents')).agents;
    c.expect(agents.length === 0, `the hub must be fresh (found ${agents.length} agents); start it fresh (npm run dev:hub -- --reset), or use a throwaway hub (npm run story)`);
  }),

  s('0.3', 'Four PCs, an app key each', async (c) => {
    for (const p of PCS) {
      const pc = (await c.op.post('/api/pcs', { name: p.name, description: p.description })).pc;
      const k = await c.op.post('/api/keys', { kind: 'app_key', machine_id: pc.id, app_name: 'claude-code', label: `claude-code on ${p.name}` });
      c.expect(k.secret, `app key for ${p.name} is revealed once`);
      c.pcs[p.key] = { pc, appKey: k.secret, appKeyId: k.key.id, bound: p.bound };
    }
  }, { beat: 1500 }),

  s('0.4', '29 agents with session keys and grants', async (c) => {
    await c.op.get('/api/templates');
    for (const a of agents()) {
      const r = await c.op.post('/api/keys', { kind: 'session_key', new_agent: { label: a.label, project: a.project }, label: `${a.label} session` });
      c.agents[a.label] = { id: r.key.agent_id, label: a.label, project: a.project };
      c.keys[a.label] = { id: r.key.id, secret: r.secret };
      c.seatPc[a.label] = a.pc;
      await c.op.put(`/api/keys/${r.key.id}/rules`, { rules: rulesFor(a.label), note: 'Echo Case standing access' });
      if (c.pcs[a.pc].bound) await c.op.put(`/api/keys/${r.key.id}/binding`, { machine_id: c.pcs[a.pc].pc.id });
    }
    c.eq(Object.keys(c.agents).length, 29, 'agents at kickoff');
    const ids = Object.fromEntries(Object.entries(c.agents).map(([l, x]) => [l, x.id]));
    for (const l of Object.keys(c.agents)) {
      const msg = messagingFor(l, ids);
      const rules = [...rulesFor(l), ...msg.flatMap((m) => m.resource.map((resource) => ({ ...m, resource })))];
      await c.op.put(`/api/keys/${c.keys[l].id}/rules`, { rules, note: 'Echo Case standing access and messaging' });
    }
  }, { beat: 2500, rows: ['pc-binding'] }),

  s('0.5', 'Eight teams in two projects, playbooks, recruiting', async (c) => {
    for (const t of TEAMS) {
      const r = await c.op.post('/api/teams', {
        name: t.name, goal: t.goal, grant_messaging: true, lease_minutes: 120, max_review_rounds: t.max_review_rounds ?? 3,
        ...(t.checkpoints ? { checkpoints: t.checkpoints } : {}),
        members: t.members.map(([l, role]) => ({ agent_id: c.A(l), role, credential_id: c.keys[l].id })),
      });
      c.teams[t.key] = r.team;
      // The case's coordinators plan their own work: tasks open at once (task intake open). Act 4 puts Relay Engineering
      // back on the default backlog intake, where the operator accepts or discards what agents propose.
      await c.op.patch(`/api/projects/${r.team.project_id}`, { task_intake: 'open' });
      await c.op.patch(`/api/teams/${r.team.id}`, { coordinator_reviews: t.key === 'int', ...(t.recruiting ? { recruiting: t.recruiting, recruit_max: 1, recruit_roles: ['worker'] } : {}) });
      for (const [role, playbook] of Object.entries(PLAYBOOKS)) if (t.members.some(([, r2]) => r2 === role)) await c.op.put(`/api/teams/${r.team.id}/roles/${role}`, { playbook });
    }
    c.eq(Object.keys(c.teams).length, 8, 'teams');
    await c.op.put(`/api/teams/${c.T('pc')}/decision-log`, { path: '/vault/Case Command/Decision log.md' });
  }, { beat: 2000 }),

  s('0.6', 'Directives with categories and tags, a case rule once per team project; feedback on', async (c) => {
    const ref = (sc) => sc.kind === 'team' ? c.T(sc.ref) : sc.kind === 'agent' ? c.A(sc.ref) : sc.kind === 'role' ? `${c.T(sc.ref.split('|')[0])}|${sc.ref.split('|')[1]}` : sc.ref ?? null;
    // Each team has its own Blueprint project, and a project rule reaches the members of that project's live teams
    // (docs/directives.md#project-reach). A rule for a whole case (cast.mjs PROJECTS) is saved once for each of its teams' projects.
    const refs = (sc) => sc.kind === 'project' ? TEAMS.filter((t) => PROJECTS[t.project] === sc.ref).map((t) => c.teams[t.key].project_id) : [ref(sc)];
    for (const d of DIRECTIVES) for (const r of refs(d.scope)) await c.op.post('/api/directives', { title: d.title, body: d.body, scope: { kind: d.scope.kind, ref: r }, ...(d.category ? { category: d.category } : {}), ...(d.tags ? { tags: d.tags } : {}) });
    const cats = await c.op.get('/api/directives/categories');
    c.expect(cats, 'categories listed');
    await c.op.put('/api/feedback/settings', { enabled: true });
    await c.op.put('/api/settings/onboarding', { max_agents: 6 });
    await c.op.post('/api/graph/refresh');
  }, { rows: ['directives-categories'] }),

  s('0.7', 'The simulator agrees: Vesna may not read Classified', async (c) => {
    const r = await c.op.post('/api/simulate', { credential_id: c.keys.Vesna.id, action: 'fs.read', resource: 'path:/vault/Classified/Director/What answers us.md' });
    c.expect(r.decision?.allowed === false, `simulator should deny, got ${JSON.stringify(r).slice(0, 200)}`);
  }, { rows: ['policy'] }),

  s('0.8', 'Seven teams start; Tern-9 Keepers stays draft', async (c) => {
    for (const t of TEAMS) if (t.key !== 'sy') c.teams[t.key] = (await c.op.post(`/api/teams/${c.T(t.key)}/start`)).team ?? c.teams[t.key];
    for (const key of Object.keys(c.pcs)) await c.connectPc(key);
  }, { beat: 1500 }),
];
