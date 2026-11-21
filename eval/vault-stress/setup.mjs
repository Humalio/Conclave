// Creates the test agents on a demo or test hub and writes their session keys to STRESS_SECRETS (mode 600).
// Needs: STRESS_CONSOLE_URL, STRESS_ADMIN_USER, STRESS_ADMIN_PASSWORD, STRESS_APP_KEY_ID and STRESS_APP_KEY
// (an app key of a PC on that hub; the cases send their MCP calls with it).
// Agents: vs-w1..vs-w8 read/write /vault/Stress/**, vs-ro read only, vs-none no vault rights,
// vs-lim read/write in Stress/Open/** but denied Stress/Open/Secret/**.
import fs from 'node:fs';
import { api as A, cfg } from './lib.mjs';

const appId = process.env.STRESS_APP_KEY_ID, appSecret = process.env.STRESS_APP_KEY;
if (!appId || !appSecret) throw new Error('Set STRESS_APP_KEY_ID and STRESS_APP_KEY');
const api = async (m, p, b) => { const r = await A(m, p, b); return { s: String(r.s), j: r.j }; };
const FS = ['fs.list', 'fs.read', 'fs.search', 'fs.history', 'fs.create', 'fs.update', 'fs.delete', 'fs.rename', 'fs.restore', 'fs.conflicts', 'fs.download'];
const RO = ['fs.list', 'fs.read', 'fs.search', 'fs.history'];
const tool = (n) => ({ effect: 'allow', actions: ['tool.invoke'], resource: `tool:${n}` });
const toolRules = [tool('file_*'), tool('session_*')];
let r = await api('PUT', `/api/keys/${appId}/rules`, { rules: [{ effect: 'allow', actions: [...FS, 'tool.invoke'], resource: 'path:/vault/**' }, { effect: 'allow', actions: ['tool.invoke'], resource: 'tool:*' }] });
console.log('app key rules', r.s);
const out = { app: appSecret, agents: {} };
const mk = async (label, rules) => {
  const c = await api('POST', '/api/keys', { kind: 'session_key', new_agent: { label }, label: label + ' key' });
  if (c.s !== '200') throw new Error(label + ' ' + JSON.stringify(c.j));
  const id = c.j.key.id; const pr = await api('PUT', `/api/keys/${id}/rules`, { rules });
  out.agents[label] = { cred: id, agent: c.j.key.agent_id, secret: c.j.secret, rules: pr.s };
};
for (let n = 1; n <= 8; n++) await mk('vs-w' + n, [...toolRules, { effect: 'allow', actions: FS, resource: 'path:/vault/Stress/**' }]);
await mk('vs-ro', [...toolRules, { effect: 'allow', actions: RO, resource: 'path:/vault/Stress/**' }]);
await mk('vs-none', [...toolRules]);
await mk('vs-lim', [...toolRules, { effect: 'allow', actions: FS, resource: 'path:/vault/Stress/Open/**' }, { effect: 'deny', actions: FS, resource: 'path:/vault/Stress/Open/Secret/**' }]);
for (let n = 9; n <= 20; n++) await mk('vs-p' + n, [...toolRules, { effect: 'allow', actions: FS, resource: 'path:/vault/Stress/Open/**' }, { effect: 'deny', actions: FS, resource: 'path:/vault/Stress/Open/Secret/**' }]);
await mk('vs-rev', [...toolRules, { effect: 'allow', actions: FS, resource: 'path:/vault/Stress/**' }]);
fs.writeFileSync(cfg.secrets, JSON.stringify(out), { mode: 0o600 });
console.log(Object.entries(out.agents).map(([k, v]) => k + ':' + v.rules + (v.secret ? '' : ' NOSECRET')).join(' '));
