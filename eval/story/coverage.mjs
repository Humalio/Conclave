// The coverage gate (docs/showcase.md §5–6): every MCP tool, every scriptable admin-API area and every scriptable
// acceptance row must be exercised by a full run, or the run fails. This file is also the matrix as data.

/** Every MCP tool the hub registers (server/src/mcp/*.ts). The vitest guard keeps this equal to the code. */
export const TOOLS = [
  'session_login', 'session_help', 'session_logout', 'session_whoami', 'session_describe', 'session_ack', 'setup_pc', 'setup_status',
  'access_list', 'access_request', 'access_status', 'access_check', 'file_list', 'file_read', 'file_stat', 'file_search', 'agent_list',
  'message_send', 'message_read', 'message_ack', 'message_history', 'room_list', 'room_create', 'room_join', 'room_leave', 'room_invite',
  'team_info', 'team_recruit', 'team_complete', 'team_pause', 'team_resume', 'agent_reset', 'work_next', 'work_ack',
  'task_create', 'task_update', 'task_list', 'task_assign', 'task_claim', 'task_start', 'task_progress', 'task_submit', 'task_withdraw', 'task_review',
  'task_reopen', 'task_complete', 'task_block', 'task_unblock', 'task_cancel', 'team_ask', 'team_ask_update', 'team_decisions', 'file_create', 'file_update', 'file_patch',
  'file_rename', 'file_delete', 'file_history', 'file_diff', 'file_restore', 'file_conflicts', 'share_create', 'share_upload', 'share_list',
  'share_info', 'share_read', 'share_diff', 'share_comment', 'share_suggest', 'share_feedback', 'share_resolve', 'share_download',
  'share_promote', 'share_close', 'graph_related', 'graph_impact', 'graph_query', 'graph_context', 'graph_summary', 'graph_job_submit',
  'graph_upsert', 'graph_summary_write', 'graph_stale', 'graph_flag', 'graph_resolve', 'graph_invalidate', 'graph_link', 'graph_decide',
  'graph_editor_optin', 'graph_health', 'channel_open', 'channel_list', 'channel_accept', 'channel_send', 'channel_receive', 'channel_status',
  'channel_close', 'file_download', 'directives_list', 'directives_read', 'directives_report', 'feedback_find',
  'feedback_file', 'feedback_read', 'feedback_add', 'bp_read', 'bp_write', 'bp_proposals', 'bp_report',
  'checkout_status', 'checkout_progress', 'checkout_handout', 'checkout_resume',
  'hw_list', 'hw_join', 'hw_report', 'hw_leave',
];

/**
 * Routes a full run may exercise only through a refusal, each with the reason. Every other route must answer below 400 at
 * least once. A refusal counts only when the step expects it (Admin.refused) and the route is listed here.
 */
export const REFUSAL_ROUTES = {};

/** Admin-API areas and the routes that count for each, as "METHOD /pattern" with ids written as :id. A route counts on an exact match. */
export const ADMIN_AREAS = {
  'Session': ['POST /api/login', 'GET /api/me', 'POST /api/me/password'],
  'Keys, agents, PCs': ['POST /api/keys', 'PUT /api/keys/:id/rules', 'PUT /api/keys/:id/binding', 'POST /api/pcs', 'POST /api/pcs/:id/setup', 'POST /api/pcs/add', 'GET /api/sessions', 'GET /api/agents'],
  'PC lifecycle': ['POST /api/pcs/:id/suspend', 'POST /api/pcs/:id/reactivate', 'POST /api/pcs/:id/re-enrol'],
  'Grants and policy': ['POST /api/simulate', 'GET /api/templates', 'GET /api/grants', 'POST /api/links'],
  'Requests': ['GET /api/requests', 'POST /api/requests/:id/approve'],
  'Work in motion': ['GET /api/work/recent'],
  'Teams': ['POST /api/teams', 'PUT /api/teams/:id/roles/:id', 'POST /api/teams/:id/start', 'POST /api/teams/:id/pause', 'POST /api/teams/:id/resume', 'POST /api/teams/:id/tasks/:id/approve', 'POST /api/teams/:id/tasks/:id/unblock', 'POST /api/teams/:id/tasks/:id/review', 'POST /api/teams/:id/tasks/:id/accept', 'POST /api/teams/:id/tasks/:id/discard', 'POST /api/teams/:id/tasks/:id/demote', 'GET /api/tasks/backlog', 'PUT /api/teams/:id/tasks/:id/tags', 'GET /api/teams/:id/tasks', 'GET /api/recruits', 'PUT /api/teams/pins', 'PUT /api/teams/organize','PUT /api/teams/:id/decision-log', 'POST /api/teams/:id/plan-request'],
  'Directives': ['POST /api/directives', 'GET /api/directives/categories', 'GET /api/directive-reports', 'POST /api/directives/:id/review'],
  'Decisions': ['GET /api/decisions', 'POST /api/decisions/:id/answer', 'POST /api/decisions/:id/confirm', 'POST /api/decisions/:id/overturn'],
  'Feedback': ['PUT /api/feedback/settings', 'GET /api/feedback', 'POST /api/feedback/:id/status', 'POST /api/feedback/:id/assign'],
  'Graph': ['GET /api/graph/health', 'GET /api/graph/flags', 'GET /api/graph/jobs', 'GET /api/graph/entities', 'POST /api/graph/refresh'],
  'Vault': ['GET /api/vault/tree', 'GET /api/vault/activity', 'GET /api/vault/conflicts'],
  'Shares and channels': ['GET /api/shares', 'GET /api/channels'],
  'Messages': ['GET /api/conversations', 'GET /api/messages/search'],
  'Safety': ['POST /api/lockdown', 'GET /api/lockdown', 'GET /api/alerts'],
  'Audit and metrics': ['GET /api/audit', 'GET /api/invocations', 'GET /api/metrics', 'GET /api/telemetry', 'GET /api/topology'],
  'Onboarding': ['POST /api/onboarding/:id/approve', 'POST /api/onboarding/:id/deny', 'POST /api/onboarding/:id/needs-changes', 'PUT /api/settings/onboarding', 'POST /onboard/enrol', 'POST /onboard/requests', 'POST /onboard/pickup'],
  'Reset (read only)': ['GET /api/reset/plan', 'GET /api/reset/parts'],
  'Blueprint': ['GET /api/projects', 'POST /api/projects', 'PATCH /api/projects/:id', 'PUT /api/teams/:id/project', 'GET /api/projects/:id/blueprint', 'GET /api/projects/:id/items/:id',
    'POST /api/projects/:id/ops', 'GET /api/projects/:id/proposals', 'POST /api/proposals/:id/apply', 'POST /api/proposals/:id/reject', 'POST /api/projects/:id/report-request',
    'GET /api/projects/:id/export.md', 'GET /api/projects/:id/summary', 'GET /api/blueprint/attention'],
  'Checkout': ['POST /api/teams/:id/checkout', 'GET /api/checkouts/:id', 'POST /api/checkouts/:id/leftovers/:id/approve', 'POST /api/checkouts/:id/render', 'POST /api/checkouts/:id/scan/:id'],
  'Blueprint settings': ['GET /api/settings/blueprint', 'PUT /api/settings/blueprint'],
  'Keywords': ['GET /api/settings/keywords', 'PUT /api/settings/keywords', 'GET /api/teams/keyword', 'PUT /api/teams/keyword'],
  'Vault copy': ['GET /api/settings/vault', 'PUT /api/settings/vault', 'POST /api/vault/mirror/import'],
  'Deciders': ['GET /api/teams/:id/deciders', 'PUT /api/teams/:id/deciders', 'GET /api/needs-you'],
  'Users': ['GET /api/users', 'POST /api/users', 'PATCH /api/users/:id', 'PUT /api/users/:id/grants', 'POST /api/users/:id/reset-password', 'POST /api/users/:id/disable'],
  'Hardware': ['GET /api/hardware', 'PUT /api/hardware/:id', 'POST /api/hardware/preview'],
  'Blueprint re-plan': ['POST /api/projects/:id/replan', 'GET /api/projects/:id/replans', 'GET /api/replans/:id', 'GET /api/replans/:id/snapshot.md', 'POST /api/replans/:id/submit', 'POST /api/replans/:id/cancel'],
};

/** Acceptance rows (docs/acceptance.md): scriptable ones must be exercised; the others say why not. */
export const ACCEPTANCE = {
  'identity': { title: 'Identity: distinct IDs on shared app keys, logout', scriptable: true },
  'pc-binding': { title: 'PC binding: bound key through another PC is refused and alerts', scriptable: true },
  'policy': { title: 'Policy: denial despite discovery, simulator, temporary grant and its survival across restart', scriptable: true },
  'console-lockdown': { title: 'Operator console: lockdown and its survival across a restart', scriptable: true },
  'vault-recovery': { title: 'Vault: stale write, external edit, sync conflict copy, restore', scriptable: true },
  'knowledge': { title: 'Knowledge: stale evidence flags, independent review, private cause', scriptable: true },
  'transfers': { title: 'Transfers: inline channel, backpressure, close, per-file promote conflict', scriptable: true },
  'teams': { title: 'Teams: dedup, claim race, changes requested, checkpoint, worker denials, DMs through message_read, completion', scriptable: true },
  'task-backlog': { title: 'Task backlog: proposals wait, agents refused, tags filed and filtered, operator accepts, discards and demotes, relayed request opens', scriptable: true },
  'feedback': { title: 'Feedback: merge and backers, triage, lockdown refuses filing but not find', scriptable: true },
  'blueprint': { title: 'Blueprint: read the part, write in it, member proposal and withdrawal, member refusal, report and its cadence', scriptable: true },
  'blueprint-admin': { title: 'Blueprint admin: summary, item and history, proposals on Home applied and rejected, operator write, paper outline, report request and escalation, limits', scriptable: true },
  'onboarding': { title: 'Onboarding hub side: enrol, request, pending refusal, approve with edit, deny, needs changes, pickup, confirm, add_agents, PC suspend/re-enrol', scriptable: true },
  'checkout': { title: 'Checkout: checkpoint and leftover check, operator-approved exception, handouts, pause at ready, render, restore with new keys, resume once', scriptable: true },
  'vault-copy': { title: 'Vault copy: the hub writes 99 Conclave from its records, the operator reads and imports, agents cannot write it', scriptable: true },
  'directives-categories': { title: 'Directives: category filters, unknown category, a reported rule as a team suggestion, adopt', scriptable: true },
  'hardware': { title: 'Hardware: register with a preview, two agents join, hold, report and release, a waiting report refused', scriptable: true },
  'trust-boundaries': { title: 'Trust boundaries: Classified-only search marker, key-shaped fake, private cause', scriptable: true },
  'deployment': { title: 'Deployment: VM, restore, migration rollback, low storage, LAN proxy', scriptable: false, why: 'needs the target VM, real storage faults and the LAN proxy' },
  'real-clients': { title: 'Real desktop clients and their work loop', scriptable: false, why: 'needs Claude Desktop/Code processes and live models' },
  'onboarding-pcs': { title: 'Onboarding on clean Windows/Linux PCs, certutil/setx, OS trust, installing Node or git', scriptable: false, why: 'needs real PCs, OS services and a user\'s yes' },
  'bridge': { title: 'Bridge relay interruption and disk commit', scriptable: false, why: 'needs a paired bridge process killed mid-transfer (bridge suites cover it)' },
  'rate-limits': { title: 'Feedback and onboarding rate limits', scriptable: false, why: 'hour-scale windows; covered by the server suites' },
};

const area = (rec) => {
  const hits = new Set(rec.routes.filter((r) => r.status < 400).map((r) => `${r.method} ${r.pattern}`));
  const refusals = new Set(rec.routes.filter((r) => r.refusal && r.status < 500).map((r) => `${r.method} ${r.pattern}`));
  const out = {};
  for (const [name, pats] of Object.entries(ADMIN_AREAS)) out[name] = pats.map((p) => ({ route: p, hit: hits.has(p) || (p in REFUSAL_ROUTES && refusals.has(p)) }));
  return out;
};

/** The gate. full = the run went through all of Acts 0–5 without a failure. */
export function gate({ rec, tools, full }) {
  const byTool = {};
  for (const name of new Set([...TOOLS, ...tools])) byTool[name] = { ok: 0, refused: 0, steps: [] };
  for (const c of rec.calls) {
    const t = (byTool[c.tool] ??= { ok: 0, refused: 0, steps: [] });
    if (c.outcome === 'ok') t.ok++; else t.refused++;
    if (c.step && !t.steps.includes(c.step)) t.steps.push(c.step);
  }
  const missing = [];
  for (const [name, t] of Object.entries(byTool)) {
    if (t.ok + t.refused === 0) missing.push(`tool ${name} was never called`);
    else if (t.ok === 0) missing.push(`tool ${name} was only ever refused`);
  }
  for (const name of tools) if (!TOOLS.includes(name)) missing.push(`tool ${name} is not in eval/story/coverage.mjs TOOLS`);
  const areas = area(rec);
  for (const [name, routes] of Object.entries(areas)) for (const r of routes) if (!r.hit) missing.push(`admin area ${name}: ${r.route} not exercised`);
  const rows = {};
  for (const [id, row] of Object.entries(ACCEPTANCE)) {
    rows[id] = { ...row, steps: [...(rec.rows.get(id) ?? [])] };
    if (row.scriptable && !rows[id].steps.length) missing.push(`acceptance row ${id} not exercised`);
  }
  const called = Object.values(byTool).filter((t) => t.ok + t.refused > 0).length;
  const areaHit = Object.values(areas).filter((rs) => rs.every((r) => r.hit)).length;
  const rowHit = Object.values(rows).filter((r) => r.scriptable && r.steps.length).length;
  const scriptable = Object.values(ACCEPTANCE).filter((r) => r.scriptable).length;
  const summary = `${called}/${Object.keys(byTool).length} tools, ${areaHit}/${Object.keys(areas).length} admin areas, ${rowHit}/${scriptable} acceptance rows${full ? (missing.length ? `; ${missing.length} gap(s)` : '; gate passed') : ' (partial run: gate not enforced)'}`;
  return { ok: !full || missing.length === 0, full, missing: full ? missing : [], summary, tools: byTool, areas, rows, calls: rec.calls.length, routes: rec.routes.length };
}

export function renderMarkdown(r) {
  const c = r.coverage, L = [];
  L.push('# Early Echo story: coverage report', '');
  L.push(`- Result: **${r.ok ? 'passed' : 'failed'}**${r.failure ? ` at step ${r.failure.step}: ${r.failure.message}` : ''}`);
  L.push(`- Acts ${r.from}–${r.until}, ${r.steps}/${r.total} steps, ${r.seconds} s${r.pace ? `, paced at ${r.pace}x` : ', instant'}`);
  L.push(`- Coverage: ${c.summary}`, `- ${c.calls} tool calls, ${c.routes} admin and onboarding calls`, '');
  if (c.missing.length) { L.push('## Gaps', '', ...c.missing.map((m) => `- ${m}`), ''); }
  if (c.notes?.length) { L.push('## Notes', '', ...c.notes.map((m) => `- ${m}`), ''); }
  L.push('## MCP tools', '', '| Tool | OK | Refused | Steps |', '|---|---|---|---|');
  for (const [n, t] of Object.entries(c.tools).sort()) L.push(`| ${n} | ${t.ok} | ${t.refused} | ${t.steps.join(', ')} |`);
  L.push('', '## Admin-API areas', '', '| Area | Routes |', '|---|---|');
  for (const [n, rs] of Object.entries(c.areas)) L.push(`| ${n} | ${rs.map((x) => `${x.hit ? '✓' : '✗'} \`${x.route}\``).join('<br>')} |`);
  L.push('', '## Acceptance rows', '', '| Row | Scripted | Steps or reason |', '|---|---|---|');
  for (const [id, row] of Object.entries(c.rows)) L.push(`| ${row.title} | ${row.scriptable ? 'yes' : 'no'} | ${row.scriptable ? row.steps.join(', ') : row.why} |`);
  return L.join('\n') + '\n';
}
