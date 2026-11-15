/**
 * The connector's local screen (docs/onboarding.md, "Pairing" and "Starting the team"): pairing, then setup, on this PC
 * only. It listens on 127.0.0.1 on a random port and answers nobody else:
 *
 * - The address it opens carries a one-time token; the first visit trades it for a cookie (HttpOnly, SameSite=Strict)
 *   and the token stops working. Every other request needs that cookie.
 * - The Host header must be this address (a DNS-rebinding page has another), and every POST must come with this
 *   address as its Origin (another site's form cannot post here).
 * - It stops on its own after an hour with no visit, and on `close()`.
 *
 * The pairing code is never shown back, never put in a page, a log or the address. Pages are plain server-rendered
 * HTML with one small inline script for the Copy buttons; nothing is loaded from elsewhere.
 */
import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readKeyFile } from './keyfile.mjs';
import { pair, PAIR_LINES } from './pairing.mjs';
import { advance, agentRows, retryAgent, pending, AGENT_STATES } from './onboard.mjs';
import { installPrivateGit, GIT_OFFER } from './git.mjs';
import { WIN, oneLine } from './paths.mjs';

export const IDLE_MS = 60 * 60_000;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };

const CSS = `:root{--bg:#f7f7f5;--panel:#fff;--text:#1d1d1b;--muted:#6b6b66;--line:#e3e2dd;--accent:#3b5bdb;--ok:#2b8a3e;--warn:#b35c00;--bad:#c92a2a}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--panel:#1f1f1d;--text:#ecebe6;--muted:#a3a29b;--line:#34332f;--accent:#91a7ff;--ok:#69db7c;--warn:#ffa94d;--bad:#ff8787}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:760px;margin:0 auto;padding:24px 16px}h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:24px 0 8px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px;margin:12px 0}.muted{color:var(--muted)}
label{display:block;margin:10px 0 4px;font-weight:600}input[type=text],input[type=url]{width:100%;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--text);font:inherit}
button{font:inherit;padding:7px 14px;border-radius:8px;border:1px solid var(--line);background:var(--panel);color:var(--text);cursor:pointer}button.pri{background:var(--accent);border-color:var(--accent);color:#fff}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.agent{border-top:1px solid var(--line);padding:12px 0}.agent:first-child{border-top:0}
.pill{display:inline-block;font-size:12px;padding:1px 8px;border-radius:99px;border:1px solid currentColor}.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}
code,pre{font:13px/1.4 ui-monospace,Consolas,monospace}pre{white-space:pre-wrap;word-break:break-all;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:8px;margin:6px 0}
.msg{border-left:3px solid var(--accent);padding:6px 10px;margin:12px 0}.msg.bad{border-color:var(--bad);color:var(--text)}`;
const COPY = `document.addEventListener('click',e=>{const b=e.target.closest('[data-copy]');if(!b)return;navigator.clipboard.writeText(document.getElementById(b.dataset.copy).textContent).then(()=>{b.textContent='Copied';setTimeout(()=>b.textContent='Copy',1500)})})`;

function page(title, body, { refresh = 0 } = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${refresh ? `<meta http-equiv="refresh" content="${refresh}">` : ''}<title>${esc(title)}</title><style>${CSS}</style></head><body><main>${body}</main><script>${COPY}</script></body></html>`;
}
let copyId = 0;
const copyBox = (text) => { const id = `c${++copyId}`; return `<pre id="${id}">${esc(text)}</pre><button type="button" data-copy="${id}">Copy</button>`; };
const form = (action, fields, label, cls = '') => `<form method="post" action="${action}" style="display:inline">${Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('')}<button class="${cls}">${esc(label)}</button></form>`;

/** The pairing form. The code field always starts empty: a code is never put back into a page. */
function pairForm(msg, { origin = '', check = '', confirm = false } = {}) {
  return `<h1>Pair this PC with your Conclave hub</h1>
<p class="muted">Enter what the console showed when your administrator added this PC. The connector checks the hub's certificate against the hub check before it sends the code.</p>
${msg ? `<div class="msg ${msg.bad ? 'bad' : ''}">${esc(msg.text)}</div>` : ''}
<form method="post" action="/pair" class="card" autocomplete="off">
<label for="o">Hub address</label><input id="o" type="url" name="origin" required placeholder="https://hub.example:8443" value="${esc(origin)}">
<label for="k">Hub check</label><input id="k" type="text" name="check" required placeholder="ab12 cd34 ef56 7890" value="${esc(check)}">
<label for="c">Pairing code</label><input id="c" type="text" name="code" required placeholder="cnv_enrol_…" spellcheck="false">
${confirm ? '<label><input type="checkbox" name="confirm" value="1"> My administrator told me this hub\'s certificate or address changed.</label>' : ''}
<p class="row"><button class="pri">Pair</button></p></form>`;
}

function agentHtml(hubKey, a) {
  const tone = a.state === 'connected' ? 'ok' : a.state === 'failed' ? 'bad' : 'warn';
  let body = `<div class="row"><b>${esc(a.label)}</b><span class="muted">${esc(a.role ?? '')}</span><span class="pill ${tone}">${esc(a.text ?? AGENT_STATES[a.state] ?? a.state)}</span></div>`;
  if (a.state === 'failed') body += `<p>${esc(a.error ?? 'Setup failed.')}</p><p>${form('/retry', { hub: hubKey, label: a.label }, 'Retry')}</p>`;
  if (a.open && a.state !== 'connected') {
    body += `<p class="muted">${esc(a.open.desktop.line)}</p>${copyBox(a.open.desktop.folder)} ${form('/open', { hub: hubKey, label: a.label }, 'Open agent', 'pri')}`;
    body += `<details><summary>Terminal${a.codex ? ' or Codex' : ''}</summary><p class="muted">In a terminal:</p>${copyBox(a.open.terminal)}${a.codex ? `<p class="muted">With Codex:</p>${copyBox(a.open.codex)}` : ''}</details>`;
  }
  return `<div class="agent">${body}</div>`;
}

async function hubHtml(home, hubKey, section, { win }) {
  let rows;
  try { rows = await agentRows(home, hubKey, { win }); } catch (e) { return `<div class="card"><h2>${esc(section.origin)}</h2><p class="bad">${esc(oneLine(e.message))}</p></div>`; }
  const req = rows.request;
  let h = `<div class="card"><h2>${esc(req?.team_name ?? 'Your team')} <span class="muted">· ${esc(section.origin)}</span></h2>`;
  if (rows.git.state === 'offer') h += `<div class="msg">${esc(GIT_OFFER)} ${form('/git', { hub: hubKey }, 'Install private git', 'pri')}</div>`;
  else if (rows.git.state === 'missing') h += `<div class="msg">${esc(rows.git.line)}</div>`;
  if (rows.git.codex) h += `<div class="msg">${esc(rows.git.codex)}</div>`;
  if (!req) h += '<p>Paired. Ask your coding agent to set up the team with the prompt from the console; it files the request with <code>conclave setup request</code>.</p>';
  else if (req.state === 'submitted') h += '<p>Waiting for your administrator to approve the team request. You can close this window; Continue setup picks up from here.</p>';
  else if (req.state === 'needs_changes') h += '<p>Your administrator asked for changes. Ask your coding agent to amend the request.</p>';
  for (const a of rows.agents) h += agentHtml(hubKey, a);
  if (pending(home, section.hub_id)) h += `<p class="row">${form('/continue', { hub: hubKey }, 'Continue setup', 'pri')}</p>`;
  return h + '</div>';
}

/**
 * Starts the screen. Returns `{url, port, close, closed}`: `url` carries the one-time token (open it once, in the
 * user's browser). `io` = {pair, advance, retry, installGit, reveal, now} for tests.
 */
export function startScreen(home, { port = 0, idleMs = IDLE_MS, claudeJson, win = WIN, io = {} } = {}) {
  const doPair = io.pair ?? pair, doAdvance = io.advance ?? advance, doRetry = io.retry ?? retryAgent, doGit = io.installGit ?? installPrivateGit;
  const reveal = io.reveal ?? ((dir) => { try { spawn(win ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open', [dir], { detached: true, stdio: 'ignore' }).unref(); } catch { /* the folder is on the screen to copy */ } });
  let token = randomBytes(24).toString('base64url');
  const session = randomBytes(24).toString('base64url');
  let flash = null, idle, resolveClosed;
  const closed = new Promise((r) => { resolveClosed = r; });
  const server = http.createServer((req, res) => handle(req, res).catch(() => { if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' }); res.end('Something went wrong on this screen.'); }));
  const touch = () => { clearTimeout(idle); idle = setTimeout(() => close(), idleMs); idle.unref?.(); };
  const close = () => { clearTimeout(idle); server.close(() => resolveClosed()); server.closeAllConnections?.(); };
  const addr = () => server.address().port;
  const hosts = () => [`127.0.0.1:${addr()}`, `localhost:${addr()}`];
  const send = (res, status, html, extra = {}) => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'", ...extra }); res.end(html); };
  const back = (res, msg) => { flash = msg ?? null; res.writeHead(303, { location: '/', 'cache-control': 'no-store' }); res.end(); };
  const body = (req) => new Promise((ok, no) => { let s = ''; req.setEncoding('utf8'); req.on('data', (c) => { s += c; if (s.length > 16_384) { req.destroy(); no(new Error('too large')); } }); req.on('end', () => ok(new URLSearchParams(s))); req.on('error', no); });
  const sections = () => { const kf = readKeyFile(home); return kf.ok ? Object.entries(kf.data.hubs) : []; };
  const opts = { claudeJson, win };

  async function handle(req, res) {
    if (!hosts().includes(String(req.headers.host ?? ''))) return send(res, 421, page('Refused', '<p>This screen answers only on this PC\'s own address.</p>'));
    const u = new URL(req.url, `http://${req.headers.host}`);
    const cookie = /(?:^|;\s*)conclave_screen=([A-Za-z0-9_-]+)/.exec(String(req.headers.cookie ?? ''))?.[1];
    if (req.method === 'GET' && u.pathname === '/' && u.searchParams.has('t')) {
      if (!token || !same(u.searchParams.get('t'), token)) return send(res, 403, page('Refused', '<p>This link was already used. Run <code>conclave setup</code> again for a new one.</p>'));
      token = null; touch();
      res.writeHead(303, { location: '/', 'set-cookie': `conclave_screen=${session}; HttpOnly; SameSite=Strict; Path=/`, 'cache-control': 'no-store' });
      return res.end();
    }
    if (!cookie || !same(cookie, session)) return send(res, 403, page('Refused', '<p>Open this screen from the link <code>conclave setup</code> gives you.</p>'));
    if (req.method === 'POST' && !hosts().map((h) => `http://${h}`).includes(String(req.headers.origin ?? ''))) return send(res, 403, page('Refused', '<p>This form must be sent from this screen.</p>'));
    touch();
    if (req.method === 'GET' && u.pathname === '/') {
      const msg = flash; flash = null;
      const hubs = sections();
      if (!hubs.length || u.searchParams.has('pair') || msg?.pairForm) return send(res, 200, page('Pair with Conclave', pairForm(msg, msg?.keep ?? {})));
      let html = `<h1>Conclave on this PC</h1>${msg ? `<div class="msg ${msg.bad ? 'bad' : ''}">${esc(msg.text)}</div>` : ''}`;
      for (const [k, s] of hubs) html += await hubHtml(home, k, s, opts);
      html += '<p class="muted"><a href="/?pair">Pair with another hub</a></p>';
      return send(res, 200, page('Conclave setup', html), {});
    }
    if (req.method !== 'POST') return send(res, 404, page('Not found', '<p>Nothing here.</p>'));
    const f = await body(req);
    const hubKey = f.get('hub');
    if (u.pathname === '/pair') {
      const r = await doPair(home, { origin: f.get('origin'), check: f.get('check'), code: f.get('code') }, { confirmChange: f.get('confirm') === '1' });
      if (!r.ok) return back(res, { bad: true, text: PAIR_LINES[r.reason] ?? PAIR_LINES.hub_unreachable, pairForm: true, keep: { origin: f.get('origin') ?? '', check: f.get('check') ?? '', confirm: r.reason === 'ca_changed' || r.reason === 'origin_changed' } });
      return back(res, { text: `${PAIR_LINES.paired} This PC is ${r.pc.name || 'paired'}.` });
    }
    if (!hubKey || !sections().some(([k]) => k === hubKey)) return back(res, { bad: true, text: 'That hub is not paired on this PC.' });
    if (u.pathname === '/continue') {
      try {
        const r = await doAdvance(home, hubKey, opts);
        return back(res, { text: r.phase === 'waiting' ? 'Still waiting for approval.' : r.phase === 'set_up' ? (r.failed.length ? `${r.failed.length} agent(s) could not be set up; see Retry.` : 'Every agent is set up.') : r.phase === 'changes' ? `Changes asked: ${r.note ?? ''}` : r.phase === 'closed' ? `The request was ${r.state}.` : 'No team request yet.' });
      } catch (e) { return back(res, { bad: true, text: oneLine(e.message) }); }
    }
    if (u.pathname === '/retry') { const r = doRetry(home, hubKey, f.get('label'), opts); return back(res, r.ok ? { text: `${f.get('label')} is set up.` } : { bad: true, text: r.error }); }
    if (u.pathname === '/open') {
      const rows = await agentRows(home, hubKey, { win }).catch(() => null);
      const a = rows?.agents.find((x) => x.label === f.get('label'));
      if (!a?.open) return back(res, { bad: true, text: 'That agent is not ready to open yet.' });
      reveal(a.open.desktop.folder);
      return back(res, { text: `${a.open.desktop.line} The folder is open in a window.` });
    }
    if (u.pathname === '/git') {
      const r = await doGit(home, { claudeJson });
      return back(res, r.ok ? { text: r.bashVar === 'set' ? 'Private git installed. If Claude Desktop was open, close it and open it again once so it finds git.' : 'Private git installed.' } : { bad: true, text: r.reason === 'hash_mismatch' ? 'The downloaded file is not the pinned MinGit, so it was deleted and nothing was installed.' : 'Git could not be installed; check the network and try again.' });
    }
    return send(res, 404, page('Not found', '<p>Nothing here.</p>'));
  }

  return new Promise((ok, no) => {
    server.on('error', no);
    server.listen(port, '127.0.0.1', () => { touch(); ok({ url: `http://127.0.0.1:${addr()}/?t=${token}`, port: addr(), close, closed, server }); });
  });
}

/** Opens a URL in the user's browser, without a shell. */
export function openBrowser(url, win = WIN) {
  try {
    const [cmd, args] = win ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
    return true;
  } catch { return false; }
}
