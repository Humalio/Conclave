// node call.mjs <role> <tool> '<json args>'   |   node call.mjs <role> --list
// One MCP call as the role's session. Logs in on first use (token cached in the role file), prints only the result JSON. Never prints keys.
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { WORK, SERVER } from './lib.mjs';

const [role, tool, argsRaw] = process.argv.slice(2);
if (!role || !tool) { console.error("usage: call.mjs <role> <tool> '<json args>' | call.mjs <role> --list"); process.exit(2); }
const file = join(WORK, 'roles', `${role}.json`);
if (!existsSync(file)) { console.error(`unknown role ${role} (hub up?)`); process.exit(2); }
const R = JSON.parse(readFileSync(file, 'utf8'));
const save = () => writeFileSync(file, JSON.stringify(R));
const sdk = (p) => import(pathToFileURL(join(SERVER, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', p)).href);
const { Client } = await sdk('client/index.js');
const { StreamableHTTPClientTransport } = await sdk('client/streamableHttp.js');
const c = new Client({ name: 'eval-call', version: '1' });
await c.connect(new StreamableHTTPClientTransport(new URL(R.url), { requestInit: { headers: { Authorization: `Bearer ${R.app_key}` } } }));
const unwrap = (r) => (r.structuredContent ?? { text: (r.content ?? []).map((x) => x.text ?? '').join('\n') });
const baselineOnly = (n) => /^(file_|session_|access_)/.test(n);
const mask = (s) => s.split(R.session_key).join('[key]').split(R.app_key).join('[key]');

async function login() {
  const r = unwrap(await c.callTool({ name: 'session_login', arguments: { session_key: R.session_key } }));
  if (!r.session_token) throw new Error('login failed');
  R.token = r.session_token; R.described = false; save();
}
async function describe() {
  if (R.described) return;
  await c.callTool({ name: 'session_describe', arguments: { session_token: R.token, role: R.role, model_label: R.model_label } });
  R.described = true; save();
}

if (tool === '--list') {
  const { tools } = await c.listTools();
  for (const t of tools) if (!R.role.startsWith('baseline') || baselineOnly(t.name)) if (t.name !== 'session_login') console.log(`${t.name}(${Object.keys(t.inputSchema?.properties ?? {}).filter((k) => k !== 'session_token').map((k) => ((t.inputSchema?.required ?? []).includes(k) ? k + '*' : k)).join(',')}): ${(t.description ?? '').split(/(?<=\.)\s/)[0].slice(0, 160)}`);
  await c.close();
} else {
if (tool === 'session_login') { console.error('login is automatic'); process.exit(2); }
if (R.role.startsWith('baseline') && !baselineOnly(tool)) { console.log(JSON.stringify({ error: 'tool not available to this role' })); process.exit(0); }
let args = {};
try { args = argsRaw ? JSON.parse(argsRaw) : {}; } catch (e) { console.error('args must be JSON: ' + e.message); process.exit(2); }
if (!R.token) await login();
await describe();
let r = await c.callTool({ name: tool, arguments: { ...args, session_token: R.token } });
let out = unwrap(r);
if (JSON.stringify(out).includes('login_required')) { await login(); await describe(); r = await c.callTool({ name: tool, arguments: { ...args, session_token: R.token } }); out = unwrap(r); }
const text = mask(JSON.stringify(r.isError ? { error: out } : out));
appendFileSync(join(WORK, 'roles', `${role}.usage.jsonl`), JSON.stringify({ tool, bytes: Buffer.byteLength(text), error: !!r.isError, t: Date.now() }) + '\n');
console.log(text);
await c.close();
}
