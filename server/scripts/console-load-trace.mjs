#!/usr/bin/env node
/* Console load trace (docs/next-release.md §4 "Console load", docs/dashboard-ux.md "Loading and polling").
   Opens the operator console in a headless Chrome or Edge on the seeded local design-review hub, signs in as its admin and
   counts the /api/ requests and their bytes: the sign-in (the first 8 s after Sign in), then a steady state per screen (Home,
   a team, a Blueprint section, Topology): the screen opens, settles 3 s, then is counted for --seconds.
   Run it the same way before and after a change, on a freshly seeded hub, so the traces compare like for like:
     HUB_PORT=8131 npm run dev:hub -- --reset     (then, in another shell)   HUB_PORT=8131 npm run dev:seed
     node scripts/console-load-trace.mjs --port 8131 [--seconds 30] [--json out.json]
   127.0.0.1 only. It reads the admin sign-in from the dev hub's .dev/hub.env and never prints it. Nothing is installed: it
   drives the browser already on the machine over its DevTools protocol (CHROME=path to choose one). */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const port = +(arg('port', process.env.HUB_PORT || 8131)), secs = +arg('seconds', 30), out = arg('json');
const hub = `http://127.0.0.1:${port}`;
const env = Object.fromEntries(readFileSync(resolve(process.cwd(), '..', '.dev', 'hub.env'), 'utf8').split(/\r?\n/).filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const browsers = [process.env.CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean);
const exe = browsers.find((p) => existsSync(p)); if (!exe) throw new Error('No Chrome or Edge found: set CHROME');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const dir = mkdtempSync(join(tmpdir(), 'cnv-trace-'));
const br = spawn(exe, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check', '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });
let devPort; for (let i = 0; i < 100 && !devPort; i++) { await wait(100); try { devPort = readFileSync(join(dir, 'DevToolsActivePort'), 'utf8').split('\n')[0]; } catch { /* starting */ } }
const target = (await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json()).find((t) => t.type === 'page');
const ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let seq = 0; const pending = new Map(), handlers = [];
ws.addEventListener('message', (m) => { const x = JSON.parse(m.data); if (x.id && pending.has(x.id)) { pending.get(x.id)(x); pending.delete(x.id); } else handlers.forEach((h) => h(x)); });
const cdp = (method, params = {}) => new Promise((r, j) => { const id = ++seq; pending.set(id, (x) => (x.error ? j(new Error(method + ': ' + x.error.message)) : r(x.result))); ws.send(JSON.stringify({ id, method, params })); });
const js = async (expr) => (await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result.value;

// Every /api/ request, with its decoded body bytes.
let reqs = new Map();
handlers.push((x) => {
  if (x.method === 'Network.requestWillBeSent' && x.params.request.url.includes('/api/')) reqs.set(x.params.requestId, { url: x.params.request.url, method: x.params.request.method, bytes: 0 });
  if (x.method === 'Network.dataReceived' && reqs.has(x.params.requestId)) reqs.get(x.params.requestId).bytes += x.params.dataLength;
});
const sum = (s) => {
  const L = [...reqs.values()], by = new Map();
  for (const r of L) {
    const p = `${r.method === 'GET' ? '' : r.method + ' '}${new URL(r.url).pathname.replace(/\/[a-z]+_[a-z0-9]{8,}/g, '/:id')}`;
    const v = by.get(p) || { n: 0, bytes: 0 }; v.n++; v.bytes += r.bytes; by.set(p, v);
  }
  const bytes = L.reduce((a, r) => a + r.bytes, 0);
  return { requests: L.length, kB: Math.round(bytes / 102.4) / 10, ...(s ? { perMinute: Math.round((L.length * 60) / s), kBPerMinute: Math.round((bytes * 60) / s / 102.4) / 10 } : {}),
    paths: Object.fromEntries([...by].sort((a, b) => b[1].n - a[1].n).map(([p, v]) => [p, `${v.n}× ${Math.round(v.bytes / 102.4) / 10} kB`])) };
};

const res = {};
try {
  await cdp('Network.enable'); await cdp('Page.enable'); await cdp('Runtime.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: hub + '/' }); await wait(2500);
  // Sign-in: from Sign in to 8 s later (the identity read, the first refresh, Home's own cards).
  reqs = new Map();
  await js(`(() => { const s = (q, v) => { const e = document.querySelector(q); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); };
    s('#lu', ${JSON.stringify(env.ADMIN_USERNAME)}); s('#lp', ${JSON.stringify(env.ADMIN_PASSWORD)}); document.querySelector('#lf').requestSubmit(); })()`);
  await wait(8000); res['Sign-in (8 s)'] = sum();
  if (!(await js(`!document.querySelector('#app').hidden`))) throw new Error('Sign-in failed');
  const team = await js(`fetch('/api/teams').then((r) => r.json()).then((x) => { const t = x.teams.find((y) => y.project_id); return { id: t.id, project: t.project_id }; })`);
  const routes = { Home: '#home', Team: `#team/${team.id}`, Blueprint: `#blueprint/${team.project}|2`, Topology: '#topology' };
  for (const [name, hash] of Object.entries(routes)) {
    await js(`location.hash = ${JSON.stringify(hash)}`); await wait(3000);
    reqs = new Map(); await wait(secs * 1000); res[name] = sum(secs);
  }
} finally { try { ws.close(); } catch { /* closed */ } br.kill(); await wait(500); try { rmSync(dir, { recursive: true, force: true }); } catch { /* the browser may still hold a file */ } }

console.log(`Console load trace · ${hub} · steady state ${secs} s per screen\n`);
for (const [k, v] of Object.entries(res)) {
  console.log(`${k}: ${v.requests} requests, ${v.kB} kB${v.perMinute !== undefined ? ` (${v.perMinute}/min, ${v.kBPerMinute} kB/min)` : ''}`);
  for (const [p, s] of Object.entries(v.paths)) console.log(`    ${s.padEnd(16)} ${p}`);
}
if (out) writeFileSync(out, JSON.stringify(res, null, 2));
