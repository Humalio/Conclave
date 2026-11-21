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
import { listDestinations, addDestination, removeDestination } from './destinations.mjs';
import { restoreView, approveFolder } from './restore.mjs';
import { waiting, deliveryLine } from './deliveries.mjs';
import { listProfiles, addProfile, setHidden, removeProfile, bindAgent, profileOf, listTeams, bindRegisteredTeam } from './profiles.mjs';
import { foldersOfHub } from './registry.mjs';
import { pendingList, approveFolder as allowFolder, approvePickup } from './approvals.mjs';
import { storeName, STORE_LINES } from './keystore.mjs';
import { wakeSettings, setWake, setAgentMessages } from './wake.mjs';
import { allBindings } from './registry.mjs';
import { isHardened } from './isolation.mjs';

export const IDLE_MS = 60 * 60_000;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** True if a POST came from this screen: its Origin is one of the screen's own addresses, or it is `null` and the browser
 * says the request is same-origin (`Sec-Fetch-Site`, which a page cannot set). Host and the session cookie are checked apart. */
export const sentFromScreen = (headers, hosts) => {
  const origin = String(headers.origin ?? '');
  if (hosts.map((h) => `http://${h}`).includes(origin)) return true;
  return origin === 'null' && String(headers['sec-fetch-site'] ?? '') === 'same-origin';
};
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

/** Restore on this PC: the folders the user approved for a restored team, what a restore waits for, and how to open each restored agent. */
function restoreHtml(home, hubKey, { claudeJson, win }) {
  const v = restoreView(home, hubKey, { claudeJson, win }), dests = listDestinations(home);
  let h = '<div class="card"><h2>Restore a team on this PC</h2>';
  h += dests.length ? '<p class="muted">Folders approved for a restored team (the hub sees the name, never the folder):</p>' : '<p class="muted">No folder is approved yet. A restore from the console goes only into a folder you approve here.</p>';
  for (const d of dests) h += `<div class="row"><b>${esc(d.label)}</b><code>${esc(d.path)}</code>${form('/destination-remove', { hub: hubKey, id: d.id }, 'Remove')}</div>`;
  h += `<form method="post" action="/destination-add" class="row"><input type="hidden" name="hub" value="${esc(hubKey)}"><input type="text" name="path" required placeholder="Folder, e.g. ${esc(WIN ? 'C:\\Users\\you\\Conclave' : '/home/you/conclave')}"><input type="text" name="label" placeholder="Name (optional)"><button>Approve this folder</button></form>`;
  for (const r of v.active) {
    h += `<div class="msg"><b>Restore in progress</b> <span class="muted">${esc(r.checkout_id)}</span><br>${esc(r.note ?? 'Working.')}</div>`;
    for (const f of r.waiting) h += `<div class="row"><span>The folder <b>${esc(f)}</b> has agent settings of its own. Approve it only if you trust what is in it.</span>${form('/restore-approve', { hub: hubKey, checkout: r.checkout_id, folder: f }, 'Approve folder', 'pri')}</div>`;
  }
  for (const r of v.done) h += `<details><summary>Restored: how to open each agent <span class="muted">(${esc(r.checkout_id)})</span></summary>${r.lines.map((l) => copyBox(l)).join('')}</details>`;
  return h + '</div>';
}

const PROFILE_LINES = { invalid_name: 'A profile name is letters, digits, spaces, dash or underscore, up to 40 characters.', email_shaped: 'A profile name cannot look like an email address.', key_shaped: 'A profile name cannot look like a key.', exists: 'A profile with that name already exists.', dir_not_absolute: 'Give the full path of the folder.', dir_unusable: 'That folder cannot be used.', dir_is_connector_folder: 'That is the connector own folder.', invalid_kind: 'Pick Claude or Codex.', too_many: 'That is the most profiles this PC keeps.', no_such_profile: 'No such profile.', wrong_kind: 'That profile is for the other program (Claude or Codex).', not_registered: 'That agent folder is not registered.', identity_changed: 'That agent folder changed; repair it first.', config_changed: 'The agent settings of that folder changed since they were recorded; run conclave repair first.', config_changed_team: 'The agent settings of one folder in this team changed since they were recorded, so nothing was bound. Run conclave repair first.', wrong_kind_team: 'No agent of this team runs that program (Claude or Codex).', no_such_team: 'No folder of that team is registered on this PC.' };

/** Account profiles: local names for Claude config folders and Codex homes. The hub sees only a name, and not at all while it is hidden. */
function profilesHtml(home, hubs) {
  const ps = listProfiles(home);
  let h = '<div class="card"><h2>Account profiles</h2><p class="muted">Each profile is a separate Claude config folder or Codex home that you log in to yourself. Profiles are not used by any run yet: that waits until separate logins are proven with two accounts. The hub sees only the profile name, never a login, an email or a folder.</p>';
  for (const p of ps) h += `<div class="row"><b>${esc(p.name)}</b><span class="muted">${p.kind === 'codex' ? 'Codex' : 'Claude'}</span><code>${esc(p.dir)}</code>${p.hidden ? '<span class="pill warn">Profile hidden</span>' : ''}${form('/profile-hide', { name: p.name, hidden: p.hidden ? '0' : '1' }, p.hidden ? 'Share name' : 'Hide name')}${form('/profile-remove', { name: p.name }, 'Remove')}</div>`;
  h += `<form method="post" action="/profile-add" class="row"><input type="text" name="name" required placeholder="Name, e.g. work" maxlength="40"><select name="kind"><option value="claude">Claude</option><option value="codex">Codex</option></select><input type="text" name="dir" required placeholder="Folder, e.g. ${esc(WIN ? 'C:\\Users\\you\\.claude-work' : '/home/you/.claude-work')}"><button>Add profile</button></form>`;
  if (ps.length) {
    const all = [];
    for (const [, s] of hubs) for (const b of foldersOfHub(home, s.hub_id, s.ca_sha256)) if (!all.some((x) => x.path === b.path)) all.push(b);
    // Bind team: one row per team of the registered folders; it binds the team's folders that run the profile's program.
    for (const t of listTeams(home, all)) {
      const n = t.folders.length;
      h += `<form method="post" action="/profile-bind-team" class="row"><input type="hidden" name="team" value="${esc(t.id)}"><b>${esc(t.name ?? t.id)}</b><span class="muted">Team, ${n} agent${n === 1 ? '' : 's'}</span><select name="profile"><option value="">Default account</option>${ps.map((p) => `<option value="${esc(p.name)}"${p.name === t.profile ? ' selected' : ''}>${esc(p.name)} (${p.kind === 'codex' ? 'Codex' : 'Claude'})</option>`).join('')}</select><button>Bind team</button><span class="muted">Binds the team's agents that run that program and trusts their folders in it. An agent bound on its own keeps its profile.</span></form>`;
    }
    for (const b of all) {
      const cur = b.profile ?? '';
      h += `<form method="post" action="/profile-bind" class="row"><input type="hidden" name="folder" value="${esc(b.path)}"><b>${esc(b.agent)}</b><select name="profile"><option value="">Default account</option>${ps.filter((p) => p.kind === (b.provider === 'codex' ? 'codex' : 'claude')).map((p) => `<option value="${esc(p.name)}"${p.name === cur ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select><button>Bind</button><span class="muted">Binding also trusts this folder in that profile.</span></form>`;
    }
  }
  return h + '</div>';
}

/** Items the hub delivered to this PC for its agents (until the wake ships on this platform): fixed words and counts, never an id or any text of the item. */
function deliveredHtml(home, hubKey) {
  const w = waiting(home, hubKey), rows = Object.values(w).map((items) => deliveryLine(items)).filter(Boolean);
  return rows.length ? '<div class="msg"><b>Waiting for an agent on this PC.</b> Open its session to pick it up; the next prompt shows it.<br>' + rows.map((r) => esc(r.replace(/^Conclave: /, ''))).join('<br>') + '</div>' : '';
}

/** Standard isolation: what it protects, where the key file's secret lives, and what waits for the PC user's click. */
function isolationHtml(home) {
  const st = storeName(home), p = pendingList(home), hard = isHardened(home);
  let h = `<div class="card"><h2>${hard ? 'Hardened' : 'Standard'} isolation</h2>`;
  if (hard) h += '<p>Agents on this PC get a short-lived token for each turn. Every long-lived key is held by the Conclave key service under its own account, so nothing you run can read one. It does not separate two live agents of your own user, and the service still lets a process of yours use a key for the hub calls the connector makes. An administrator can switch this off with <b>conclave uninstall-service</b>; the keys come back to your own encrypted key file, none is lost.</p>';
  else
  h += '<p>Agents on this PC get a short-lived token for each turn and never open a long-lived key. The key file is encrypted. This protects against a key leaking into a transcript, a log, a backup or a paste. It does not stop a determined agent running as you: any process of your own user can ask the same key store. An administrator can add the hardened level for that.</p>';
  if (!hard) h += '<p class="muted">Hardened isolation is optional and needs an administrator once: <b>conclave install-service</b>. Standard stays the default.</p>';
  if (st && !hard) h += `<p class="muted">${esc(STORE_LINES[st])}</p>`;
  for (const f of p.folders) h += `<div class="row"><span>A chat opened in <b>${esc(f.folder)}</b> asks to work as <b>${esc(f.agent)}</b>. Allow it only if you opened that chat.</span>${form('/allow-folder', { key: f.key }, 'Allow', 'pri')}</div>`;
  for (const k of p.pickups) h += `<div class="row"><span>Pick up ${esc(k.what ?? 'keys')} from the hub.</span>${form('/allow-pickup', { key: k.key }, 'Allow', 'pri')}</div>`;
  h += wakeHtml(home);
  return h + '</div>';
}

/** The wake, turned on per agent with its isolation level beside it. Agent messages never wake by default (an agent's text is not trusted). */
function wakeHtml(home) {
  let labels = [];
  try { labels = [...new Set(allBindings(home).map((b) => b.agent))]; } catch { /* no registry yet */ }
  const s = wakeSettings(home);
  let h = '<h3>Wake</h3><p class="muted">When the hub has work for an agent, the connector can start a turn for it in its folder, one fresh session for each task. A woken turn has the permissions of its own folder: a tool that needs your approval ends the turn, and the console says so. It never holds a long-lived key.</p>';
  if (!labels.length) return h + '<p class="muted">No agent folder is registered on this PC yet.</p>';
  for (const l of labels) h += `<div class="row"><span><b>${esc(l)}</b> <span class="muted">· Standard isolation · wake ${s.agents[l] ? 'on' : 'off'}</span></span>${form('/wake-set', { label: l, on: s.agents[l] ? '0' : '1' }, s.agents[l] ? 'Turn off' : 'Turn on', s.agents[l] ? '' : 'pri')}</div>`;
  return h + `<div class="row"><span>Wake an agent when another agent writes to it <span class="muted">· ${s.agent_messages ? 'on' : 'off (default)'}</span>. An agent's message is not trusted text, so this stays off unless you want it.</span>${form('/wake-messages', { on: s.agent_messages ? '0' : '1' }, s.agent_messages ? 'Turn off' : 'Turn on')}</div>`;
}

async function hubHtml(home, hubKey, section, { win, claudeJson }) {
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
  h += deliveredHtml(home, hubKey);
  if (pending(home, section.hub_id)) h += `<p class="row">${form('/continue', { hub: hubKey }, 'Continue setup', 'pri')}</p>`;
  return h + '</div>' + restoreHtml(home, hubKey, { claudeJson, win });
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
  const send = (res, status, html, extra = {}) => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'same-origin',
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
    // A form is taken only from this screen: its own Origin, or (a page still open under the old no-referrer policy sends
    // `Origin: null`) a null Origin that the browser itself marks as same-origin. A missing Origin is refused.
    if (req.method === 'POST' && !sentFromScreen(req.headers, hosts())) return send(res, 403, page('Refused', '<p>This form must be sent from this screen.</p>'));
    touch();
    if (req.method === 'GET' && u.pathname === '/') {
      const msg = flash; flash = null;
      const hubs = sections();
      if (!hubs.length || u.searchParams.has('pair') || msg?.pairForm) return send(res, 200, page('Pair with Conclave', pairForm(msg, msg?.keep ?? {})));
      let html = `<h1>Conclave on this PC</h1>${msg ? `<div class="msg ${msg.bad ? 'bad' : ''}">${esc(msg.text)}</div>` : ''}`;
      html += isolationHtml(home);
      for (const [k, s] of hubs) html += await hubHtml(home, k, s, opts);
      html += profilesHtml(home, hubs);
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
    if (u.pathname === '/profile-add') { const r = addProfile(home, f.get('name'), { kind: f.get('kind'), dir: String(f.get('dir') ?? '').trim() }); return back(res, r.ok ? { text: `${r.profile.name} added. Log in to it once yourself, then bind an agent to it.` } : { bad: true, text: PROFILE_LINES[r.reason] ?? 'That profile cannot be added.' }); }
    if (u.pathname === '/profile-hide') return back(res, setHidden(home, String(f.get('name')), f.get('hidden') === '1') ? { text: f.get('hidden') === '1' ? 'The hub is no longer told the name of this profile.' : 'The hub may see the name of this profile.' } : { bad: true, text: PROFILE_LINES.no_such_profile });
    if (u.pathname === '/profile-remove') return back(res, removeProfile(home, String(f.get('name'))) ? { text: 'Profile removed. Its folder was left as it is.' } : { bad: true, text: PROFILE_LINES.no_such_profile });
    if (u.pathname === '/profile-bind-team') {
      const r = bindRegisteredTeam(home, String(f.get('team') ?? ''), f.get('profile') ? String(f.get('profile')) : null, { win });
      if (!r.ok) return back(res, { bad: true, text: PROFILE_LINES[`${r.reason}_team`] ?? PROFILE_LINES[r.reason] ?? 'Could not bind the team.' });
      if (!r.profile) return back(res, { text: `${r.team} is back on the default account, except agents bound on their own.` });
      return back(res, { text: `${r.team}: ${r.folders} agent${r.folders === 1 ? '' : 's'} bound to ${r.profile}.${r.skipped ? ` ${r.skipped} run the other program and keep their account.` : ''}` });
    }
    if (u.pathname === '/profile-bind') { const r = bindAgent(home, String(f.get('folder')), f.get('profile') ? String(f.get('profile')) : null, { win }); return back(res, r.ok ? { text: r.profile ? `Bound to ${r.profile}.` : 'Back to the default account.' } : { bad: true, text: PROFILE_LINES[r.reason] ?? 'Could not bind.' }); }
    if (u.pathname === '/allow-folder') return back(res, allowFolder(home, String(f.get('key'))) ? { text: 'Allowed. That chat can now work as its agent.' } : { bad: true, text: 'That folder is not waiting any more.' });
    if (u.pathname === '/wake-set') {
      const l = String(f.get('label') ?? '');
      let known = false; try { known = allBindings(home).some((b) => b.agent === l); } catch { /* none */ }
      if (!known) return back(res, { bad: true, text: 'That agent is not registered on this PC.' });
      setWake(home, l, f.get('on') === '1');
      return back(res, { text: f.get('on') === '1' ? `Wake is on for ${l}.` : `Wake is off for ${l}.` });
    }
    if (u.pathname === '/wake-messages') { setAgentMessages(home, f.get('on') === '1'); return back(res, { text: f.get('on') === '1' ? 'Agent messages can now wake an agent.' : 'Agent messages no longer wake an agent.' }); }
    if (u.pathname === '/allow-pickup') return back(res, approvePickup(home, String(f.get('key'))) ? { text: 'Allowed. The key pickup carries on.' } : { bad: true, text: 'That pickup is not waiting any more.' });
    if (!hubKey || !sections().some(([k]) => k === hubKey)) return back(res, { bad: true, text: 'That hub is not paired on this PC.' });
    if (u.pathname === '/continue') {
      try {
        const r = await doAdvance(home, hubKey, opts);
        return back(res, { text: r.phase === 'waiting' ? (r.pickup_click ? 'Waiting for you to allow the key pickup above.' : 'Still waiting for approval.') : r.phase === 'set_up' ? (r.failed.length ? `${r.failed.length} agent(s) could not be set up; see Retry.` : 'Every agent is set up.') : r.phase === 'changes' ? `Changes asked: ${r.note ?? ''}` : r.phase === 'closed' ? `The request was ${r.state}.` : 'No team request yet.' });
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
    if (u.pathname === '/destination-add') { const r = addDestination(home, String(f.get('path') ?? '').trim(), f.get('label') ?? undefined); return back(res, r.ok ? { text: `${r.destination.label} is approved for a restored team.` } : { bad: true, text: `That folder cannot be used: ${r.reason}.` }); }
    if (u.pathname === '/destination-remove') return back(res, removeDestination(home, String(f.get('id'))) ? { text: 'Removed. A restore to it is refused from now on.' } : { bad: true, text: 'No such folder.' });
    if (u.pathname === '/restore-approve') { const r = await approveFolder(home, hubKey, String(f.get('checkout')), String(f.get('folder')), opts); return back(res, r.ok ? { text: 'Approved. The restore carries on at the next check-in.' } : { bad: true, text: 'That folder is not waiting for approval.' }); }
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
