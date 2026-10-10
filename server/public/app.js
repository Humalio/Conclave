/* Agent Hub dashboard — vanilla ES module, no build. */
const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
const NS = 'http://www.w3.org/2000/svg';
const RM = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const ic = (n, c = '') => `<svg class="i ${c}"><use href="#i-${n}"/></svg>`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => (n >= 1e4 ? (n / 1e3).toFixed(0) + 'k' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n)));
const ago = (t) => { if (!t) return '—'; const d = Math.max(0, (Date.now() - t) / 1000); return d < 60 ? Math.floor(d) + 's' : d < 3600 ? Math.floor(d / 60) + 'm' : d < 86400 ? Math.floor(d / 3600) + 'h' : Math.floor(d / 86400) + 'd'; };
const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const day = (t) => new Date(t).toISOString().slice(0, 10);

/* ---------- api ---------- */
let csrf = '';
async function api(path, method = 'GET', body) {
  const h = {};
  if (body !== undefined) h['content-type'] = 'application/json';
  if (method !== 'GET') h['x-csrf-token'] = csrf;
  const r = await fetch('/api' + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 401 && path !== '/login') showLogin();
    throw Object.assign(new Error(j.message || j.error || String(r.status)), { code: j.error, status: r.status });
  }
  return j;
}
const post = (p, b) => api(p, 'POST', b);

/* ---------- state ---------- */
const S = { me: null, keys: [], pcs: [], agents: [], alerts: [], inv: [], tpl: [], top: null, met: null, ses: [], teams: [], convs: [], links: [], reqs: [], lock: null, tree: null, conf: [], f: { kind: '', status: '', pc: '', agent: '' } };
const K = (id) => S.keys.find((k) => k.id === id);
const PC = (id) => S.pcs.find((p) => p.id === id);
const keyName = (k) => (k.kind === 'app_key' ? k.app_name || k.label : k.label);
const keySub = (k) => (k.kind === 'app_key' ? k.pc?.name || '' : k.agent?.label || '');
const stOf = (k) => {
  const e = k.effective_status;
  if (e !== 'active') return [e, e[0].toUpperCase() + e.slice(1), 'susp', 'var(--bad)'];
  if (k.live_logins > 0) return ['live', 'Live', 'live', 'var(--ok)'];
  if (!k.first_used_at) return ['new', 'New', 'new', 'var(--info)'];
  return ['idle', 'Idle', 'idle', 'var(--idle)'];
};
const pill = (k) => { const s = stOf(k); return `<span class="pill p-${s[2]}">${s[1]}</span>`; };
const kindTag = (k) => `<span class="tag ${k.kind === 'app_key' ? 'k-app' : 'k-ses'}">${k.kind === 'app_key' ? 'APP' : 'SES'}</span>`;

/* ---------- misc ui ---------- */
let tT;
function toast(m, bad) {
  const t = $('#toast');
  t.querySelector('svg').outerHTML = ic(bad ? 'x' : 'check', bad ? 'bad' : '');
  t.querySelector('svg').style.color = bad ? 'var(--bad-t)' : '';
  t.querySelector('span').textContent = m;
  t.classList.add('on'); clearTimeout(tT); tT = setTimeout(() => t.classList.remove('on'), bad ? 3500 : 1800);
}
const run = async (fn) => { try { return await fn(); } catch (e) { if (e.status !== 401) toast(e.message, true); } };
function copy(text) {
  const done = () => toast('Copied');
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, () => fb());
  else fb();
  function fb() { const t = document.createElement('textarea'); t.value = text; document.body.append(t); t.select(); try { document.execCommand('copy'); done(); } catch { toast('Copy failed', true); } t.remove(); }
}
const codeBox = (text, big) => `<div class="code mono" data-v="${esc(text)}">${esc(text)}<button class="btn ${big ? 'pri' : 'ic'} sm cp" data-copy aria-label="Copy" style="${big ? 'width:auto' : ''}">${ic('copy')}</button></div>`;
const sec = (h, b, extra = '') => `<section class="sec"><h4>${h}${extra}</h4>${b}</section>`;
const none = (icon, label, ok) => `<div class="empty${ok ? ' ok' : ''}">${ic(icon)}<span>${label}</span></div>`;
const vtools = (html) => `<div class="vtools">${html}</div>`;
const subTabs = (attr, tabs, cur) => `<div class="seg" role="group">${tabs.map(([k, l, n = '']) => `<button ${attr}="${k}" class="${k === cur ? 'on' : ''}">${l}${n}</button>`).join('')}</div>`;
/* Icon-only controls get their aria-label as a hover tooltip. */
function tipIcons(root = document) {
  $$('button[aria-label],a[aria-label]', root).forEach((b) => { if (!b.title && !b.textContent.trim()) b.title = b.getAttribute('aria-label'); });
}
function arm(btn, fn) {
  btn.onclick = () => {
    if (btn.classList.contains('armed')) { clearTimeout(btn._t); return fn(); }
    const o = btn.innerHTML; btn.classList.add('armed'); btn.innerHTML = ic('check') + 'Confirm';
    btn._t = setTimeout(() => { btn.classList.remove('armed'); btn.innerHTML = o; }, 3000);
  };
}
function spark(arr, w, h, col, area = true) {
  const mx = Math.max(...arr, 1), mn = Math.min(...arr, 0), r = mx - mn || 1, sx = w / Math.max(1, arr.length - 1);
  const pts = arr.map((v, i) => [i * sx, h - 3 - ((v - mn) / r) * (h - 8)]);
  const l = 'M' + pts.map((p) => p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('L');
  const id = 'g' + (spark.n = (spark.n || 0) + 1);
  return `<svg class="spk" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">${area ? `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:${col};stop-opacity:.32"/><stop offset="1" style="stop-color:${col};stop-opacity:0"/></linearGradient></defs><path d="${l}L${w} ${h}L0 ${h}Z" fill="url(#${id})"/>` : ''}<path d="${l}" fill="none" style="stroke:${col}" stroke-width="1.7" vector-effect="non-scaling-stroke" stroke-linejoin="round"/></svg>`;
}

/* ---------- derived data ---------- */
function buckets(filter) {
  const now = Date.now(), B = Array.from({ length: 60 }, () => ({ v: 0, t: 0, d: 0 }));
  for (const i of S.inv) {
    if (filter && !filter(i)) continue;
    const x = 59 - Math.floor((now - i.created_at) / 6e4);
    if (x < 0 || x > 59) continue;
    if (i.result === 'denied') B[x].d++; else if (i.tool.startsWith('file_')) B[x].v++; else B[x].t++;
  }
  return B;
}
const openAlerts = () => S.alerts.filter((a) => a.status === 'open');
const SEV = { critical: 'crit', warning: 'warn', info: 'info' };
const RANK = { crit: 0, warn: 1, info: 2 };
const AT = { key_in_payload: ['Leak', 'shield'], auth_bruteforce: ['Brute', 'lock'], login_burst: ['Logins', 'lock'], concurrent_use: ['Shared', 'key'], quota_trip: ['Quota', 'ban'], task_blocked: ['Blocked', 'warn'], checkpoint: ['Approve', 'check'], stalled_member: ['Stalled', 'clock'] };
const ACK = true;
const atype = (a) => AT[a.type] || [a.type.replace(/_/g, ' '), 'ban'];
const det = (a) => { try { return JSON.parse(a.details || '{}') || {}; } catch { return {}; } };

/* ---------- KPIs ---------- */
const H = {};
function kpiDefs() {
  const m = S.met, c = m?.counts || {}, sr = (k) => (m?.series?.[k] || []).map((x) => x.count), last = (k) => sr(k).slice(-1)[0] || 0;
  return [
    { id: 'ses', l: 'Sessions', i: 'ses', c: 'var(--ok)', go: 'sessions', v: c.live_agents || 0, of: c.agents || 0, series: sr('logins') },
    { id: 'pcs', l: 'PCs', i: 'pc', c: 'var(--accent-2)', go: 'pcs', v: S.top ? S.top.pcs.filter((p) => p.bridge?.online || p.app_keys.some((k) => k.sessions.length)).length : c.pcs_online_bridge || 0, of: c.pcs || 0 },
    { id: 'msgs', l: 'Msgs/h', i: 'chat', c: 'var(--s-msg)', go: 'chats', v: last('messages'), series: sr('messages') },
    { id: 'calls', l: 'Calls/h', i: 'bolt', c: 'var(--s-tool)', v: last('tool_calls'), series: sr('tool_calls') },
    { id: 'deny', l: 'Denials/h', i: 'ban', c: 'var(--s-deny)', bad: 1, v: last('denials'), series: sr('denials') },
    { id: 'req', l: 'Requests', i: 'shield', c: 'var(--warn)', go: 'req', v: S.reqs.length },
    { id: 'tasks', l: 'Tasks', i: 'team', c: 'var(--accent)', go: 'teams', v: c.tasks_open || 0, series: sr('tasks_done') },
  ];
}
function renderKpis() {
  const el = $('#kpis'), defs = kpiDefs();
  if (!el.children.length) el.innerHTML = defs.map((k) => `<div class="card kpi" data-k="${k.id}" ${k.go ? `data-go="${k.go}" tabindex="0" role="button"` : ''} aria-label="${k.l}"><div class="l">${ic(k.i)}${k.l}</div><div class="v"><b data-v="0">0</b><small></small><span class="grow"></span><span class="dl fl"></span></div><div class="sp"></div></div>`).join('');
  for (const k of defs) {
    const c = el.querySelector(`[data-k=${k.id}]`);
    let ser = k.series;
    if (!ser) { const h = (H[k.id] = H[k.id] || []); h.push(k.v); if (h.length > 30) h.shift(); ser = h.length > 1 ? h : [k.v, k.v]; }
    tween(c.querySelector('b'), k.v); c.querySelector('small').textContent = k.of != null ? '/' + k.of : '';
    const m = Math.floor(ser.length / 2), a = ser.slice(0, m).reduce((x, y) => x + y, 0), b = ser.slice(m).reduce((x, y) => x + y, 0), dl = c.querySelector('.dl');
    const p = ser.length >= 4 && a > 0 ? Math.round(((b - a) / a) * 100) : 0;
    dl.textContent = p ? (p > 0 ? '▲ ' : '▼ ') + Math.abs(p) + '%' : '';
    dl.style.display = p ? '' : 'none';
    dl.className = 'dl ' + (p === 0 ? 'fl' : (p > 0) !== !!k.bad ? 'up' : 'dn');
    c.querySelector('.sp').innerHTML = spark(ser, 200, 40, k.c);
  }
}
function tween(el, to) {
  const from = +el.dataset.v || 0; el.dataset.v = to;
  if (RM() || from === to) { el.textContent = fmt(to); return; }
  const t0 = performance.now();
  const st = (t) => { const p = Math.min(1, (t - t0) / 500), e = 1 - Math.pow(1 - p, 3); el.textContent = fmt(from + (to - from) * e); if (p < 1) requestAnimationFrame(st); };
  requestAnimationFrame(st);
}

/* ---------- topology ---------- */
function renderTopo() {
  const box = $('#topo'), W = box.clientWidth; if (!W) return;
  const T = S.top;
  if (!T || !T.pcs.length) { box.innerHTML = `<div class="ec">${ic('hub')}</div>`; $('#topoLg').innerHTML = ''; return; }
  const rows = [];
  T.pcs.forEach((p) => {
    const as = p.app_keys.filter((a) => a.status !== 'revoked');
    if (!as.length) { rows.push({ p }); return; }
    as.forEach((a) => { if (a.sessions.length) a.sessions.forEach((s) => rows.push({ p, a, s })); else rows.push({ p, a }); });
  });
  const nar = W < 600, step = nar ? 30 : Math.max(28, Math.min(36, 320 / rows.length)), top = 20, Ht = top * 2 + step * (rows.length - 1);
  const pcW = nar ? 108 : 136, appW = nar ? 0 : 132;
  const X = nar ? { pc: 0, app: pcW + 34, s: pcW + 78 } : { hub: 30, pc: Math.max(88, W * 0.16), app: W * 0.43, s: W * 0.71 };
  const yA = {}, yP = {};
  rows.forEach((r, i) => { r.y = top + i * step; if (r.a) (yA[r.a.id] = yA[r.a.id] || []).push(r.y); (yP[r.p.id] = yP[r.p.id] || []).push(r.y); });
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  for (const k in yA) yA[k] = mean(yA[k]); for (const k in yP) yP[k] = mean(yP[k]);
  const hubY = Ht / 2, cv = (x1, y1, x2, y2) => { const m = (x1 + x2) / 2; return `M${x1.toFixed(1)} ${y1.toFixed(1)}C${m.toFixed(1)} ${y1.toFixed(1)} ${m.toFixed(1)} ${y2.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`; };
  const on = (p) => p.status === 'active', now = Date.now();
  const pcCol = (p) => (!on(p) ? 'var(--bad)' : p.bridge?.paired && !p.bridge.online ? 'var(--warn)' : 'var(--ok)');
  let e = '', n = '';
  T.pcs.forEach((p) => {
    if (!yP[p.id]) return;
    const pend = (p.folders || []).filter((f) => f.status === 'proposed').length;
    if (!nar) e += `<path class="e${on(p) ? '' : ' off'}" d="${cv(X.hub + 20, hubY, X.pc, yP[p.id])}"/>`;
    n += `<g class="n-pc${on(p) ? '' : ' off'}" data-pc="${p.id}" tabindex="0" role="button" aria-label="${esc(p.name)}"><rect class="nb" x="${X.pc}" y="${yP[p.id] - 14}" width="${pcW}" height="28" rx="8"/><circle cx="${X.pc + 13}" cy="${yP[p.id]}" r="4" style="fill:${pcCol(p)}"/><text class="nt" x="${X.pc + 24}" y="${yP[p.id] + 4}">${esc(trunc(p.name, pend ? (nar ? 7 : 11) : nar ? 10 : 14))}</text>${pend ? `<circle cx="${X.pc + pcW - 14}" cy="${yP[p.id]}" r="8" style="fill:var(--warn)"/><text x="${X.pc + pcW - 14}" y="${yP[p.id] + 3.5}" text-anchor="middle" font-size="10" font-weight="700" style="fill:#2a1a00">${pend}</text>` : ''}</g>`;
  });
  const seenA = new Set();
  rows.forEach((r) => {
    if (!r.a || seenA.has(r.a.id)) return; seenA.add(r.a.id);
    const a = r.a, y = yA[a.id], ax = nar ? X.app - 12 : X.app, ini = (a.app || '?').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
    e += `<path class="e${on(r.p) ? '' : ' off'}" d="${cv(X.pc + pcW, yP[r.p.id], ax, y)}"/>`;
    n += nar ? `<g class="n-app" data-key="${a.id}" tabindex="0" role="button" aria-label="${esc(a.app)}"><circle class="nb" cx="${X.app}" cy="${y}" r="12"/><text class="nt m" x="${X.app}" y="${y + 3.5}" text-anchor="middle" font-size="9.5" font-weight="700">${esc(ini)}</text></g>`
      : `<g class="n-app" data-key="${a.id}" tabindex="0" role="button" aria-label="${esc(a.app)}"><rect class="nb" x="${X.app}" y="${y - 12}" width="${appW}" height="24" rx="12"/><rect x="${X.app + 5}" y="${y - 8}" width="22" height="16" rx="5" style="fill:var(--panel-3)"/><text class="nt m" x="${X.app + 16}" y="${y + 3.5}" text-anchor="middle" font-size="9" font-weight="700">${esc(ini)}</text><text class="nt m" x="${X.app + 33}" y="${y + 4}">${esc(trunc(a.app || '', 14))}</text></g>`;
  });
  const pos = {};
  rows.forEach((r, i) => {
    if (!r.s) return;
    const s = r.s, ax = nar ? X.app + 12 : X.app + appW, hot = s.last_used_at && now - s.last_used_at < 15000;
    if (s.agent_id && !pos[s.agent_id]) pos[s.agent_id] = r.y;
    e += `<path class="e${hot ? ' hot' : ''}${on(r.p) ? '' : ' off'}" data-e="${i}" d="${cv(ax, yA[r.a.id], X.s - 7, r.y)}"/>`;
    n += `<g class="n-s" ${s.agent_id ? `data-ses="${s.agent_id}" ` : ''}data-row="${i}" tabindex="0" role="button" aria-label="${esc(s.label || '')}"><circle class="ring" cx="${X.s}" cy="${r.y}" r="6" style="stroke:var(--ok)"/><circle class="core" cx="${X.s}" cy="${r.y}" r="6" style="fill:var(--ok)"/><text class="nt" x="${X.s + 13}" y="${r.y + 4}">${esc(trunc(s.label || '—', nar ? 12 : 22))}</text></g>`;
  });
  let me = 0;
  (T.message_edges || []).forEach((m) => {
    const y1 = pos[m.from], y2 = pos[m.to]; if (y1 == null || y2 == null || y1 === y2) return; me++;
    const bw = 12 + Math.abs(y2 - y1) * 0.12, x = X.s - 6;
    e += `<path class="e me" style="stroke-width:${(1.4 + Math.min(2.2, Math.log2(m.count + 1) * 0.5)).toFixed(1)}" d="M${x} ${y1}C${x - bw} ${y1} ${x - bw} ${y2} ${x} ${y2}"/>`;
  });
  const hub = nar ? '' : `<g><circle cx="${X.hub}" cy="${hubY}" r="30" style="fill:var(--accent-soft)"/><circle cx="${X.hub}" cy="${hubY}" r="20" fill="url(#hubg)"/><svg x="${X.hub - 10}" y="${hubY - 10}" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"><use href="#i-hub"/></svg></g>`;
  box.innerHTML = `<svg viewBox="0 0 ${W} ${Ht}" height="${Ht}" role="img" aria-label="Topology"><defs><linearGradient id="hubg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" style="stop-color:var(--accent)"/><stop offset="1" style="stop-color:var(--accent-2)"/></linearGradient></defs><g>${e}</g>${hub}<g>${n}</g></svg>`;
  const live = rows.filter((r) => r.s).length, b = (v) => `<b style="color:var(--text)">${v}</b>`;
  $('#topoLg').innerHTML = `<span>${ic('pc')}${b(T.pcs.length)}</span><span>${ic('app')}${b(seenA.size)}</span><span><i style="background:var(--ok);border-radius:50%"></i>${b(live)}</span><span><i style="background:var(--s-msg);border-radius:50%"></i>${b(me)}</span>`;
}

/* ---------- alerts + chips ---------- */
function alertBits(a) {
  const k = K(a.subject), d = det(a), t = atype(a), tm = S.teams.find((x) => x.id === a.subject) || S.teams.find((x) => x.name === d.team), ag = S.agents.find((x) => x.id === a.subject);
  const who = k ? keyName(k) + (keySub(k) ? ' · ' + keySub(k) : '') : tm ? tm.name : ag ? ag.label : a.subject || '—';
  const sub = `<span class="mono">${esc(d.tool || d.task || d.metric || a.type)}</span>`;
  let acts = '';
  if (a.type === 'checkpoint' && tm) acts += `<button class="btn sm ok" data-appr="${tm.id}|${a.subject}" aria-label="Approve">${ic('check')}</button>`;
  if (k && k.effective_status === 'active') acts += `<button class="btn sm bad" data-act="asusp|${a.id}" aria-label="Suspend">${ic('pause')}</button>`;
  if (k) acts += `<button class="btn sm" data-key="${k.id}">Open</button>`;
  else if (tm) acts += `<button class="btn sm" data-team="${tm.id}">Open</button>`;
  else if (ag) acts += `<button class="btn sm" data-ses="${ag.id}">Open</button>`;
  if (ACK && a.status === 'open') acts += `<button class="btn sm" data-act="ack|${a.id}" aria-label="Ack">${ic('check')}</button><button class="btn sm" data-act="close|${a.id}" aria-label="Close">${ic('x')}</button>`;
  return { who, sub, acts, t };
}
const SEEN = new Set();
/* ---------- activity ---------- */
const SER = [['v', 'Vault', 'var(--s-vault)'], ['t', 'Tools', 'var(--s-tool)'], ['d', 'Denials', 'var(--s-deny)']];
function renderAct() {
  const box = $('#act'), W = box.clientWidth; if (!W) return;
  const B = buckets(), NB = 60, Ht = W < 500 ? 150 : 190, pl = 30, pb = 20, pt = 6;
  const tot = B.map((b) => SER.reduce((a, s) => a + b[s[0]], 0)), mx = Math.max(Math.ceil(Math.max(...tot) / 4) * 4, 4);
  const bw = (W - pl) / NB, y = (v) => pt + (Ht - pb - pt) * (1 - v / mx);
  let g = '';
  [0, 0.5, 1].forEach((f) => { const yy = y(mx * f); g += `<line class="gl" x1="${pl}" x2="${W}" y1="${yy}" y2="${yy}"/><text class="ax" x="${pl - 6}" y="${yy + 3.5}" text-anchor="end">${fmt(mx * f)}</text>`; });
  let r = '';
  B.forEach((b, i) => { let acc = 0; const x = pl + i * bw + bw * 0.14, w = Math.max(1, bw * 0.72); SER.slice().reverse().forEach((s) => { const v = b[s[0]]; if (!v) return; const y1 = y(acc + v), h = y(acc) - y1; r += `<rect x="${x.toFixed(1)}" y="${y1.toFixed(1)}" width="${w.toFixed(1)}" height="${Math.max(0, h - 0.6).toFixed(1)}" rx="1.5" style="fill:${s[2]}" opacity="${i === NB - 1 ? 1 : 0.88}"/>`; acc += v; }); });
  const lab = [[0, '-60m'], [30, '-30m'], [NB - 1, 'now']].map(([i, t]) => `<text class="ax" x="${pl + i * bw + bw / 2}" y="${Ht - 5}" text-anchor="${i === 0 ? 'start' : i === NB - 1 ? 'end' : 'middle'}">${t}</text>`).join('');
  const html = `<svg viewBox="0 0 ${W} ${Ht}" height="${Ht}" role="img" aria-label="Activity">${g}${r}${lab}<rect id="hov" x="0" y="${pt}" width="${bw}" height="${Ht - pb - pt}" rx="3" style="fill:var(--text)" opacity="0"/></svg>`;
  const svg = box.querySelector('svg'); if (svg) svg.outerHTML = html; else box.insertAdjacentHTML('afterbegin', html);
  $('#actLg').innerHTML = SER.map((s) => `<span><i style="background:${s[2]}"></i>${s[1]} <b style="color:var(--text)">${fmt(B.reduce((a, b) => a + b[s[0]], 0))}</b></span>`).join('');
  box.onmousemove = (ev) => {
    const rc = box.getBoundingClientRect(), x = ev.clientX - rc.left, i = Math.floor((x - pl) / bw), tip = $('#tip'), hv = box.querySelector('#hov');
    if (i < 0 || i >= NB) { tip.style.display = 'none'; hv.setAttribute('opacity', 0); return; }
    hv.setAttribute('x', pl + i * bw); hv.setAttribute('opacity', 0.06);
    tip.innerHTML = `<div style="color:var(--muted);margin-bottom:3px">${i === NB - 1 ? 'now' : '-' + (NB - 1 - i) + 'm'}</div>` + SER.map((s) => `<div><span><i style="background:${s[2]}"></i>${s[1]}</span><b>${B[i][s[0]]}</b></div>`).join('');
    tip.style.display = 'block'; tip.style.left = Math.min(x + 12, W - 110) + 'px'; tip.style.top = '8px';
  };
  box.onmouseleave = () => { $('#tip').style.display = 'none'; const hv = box.querySelector('#hov'); hv && hv.setAttribute('opacity', 0); };
}

/* ---------- keys table ---------- */
function fillSelect(sel, first, items, cur) {
  sel.innerHTML = `<option value="">${first}</option>` + items.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('');
  sel.value = items.some(([v]) => v === cur) ? cur : '';
}
function renderKeys() {
  if (!$('#keys')) return;
  fillSelect($('#fPc'), 'PC', S.pcs.map((p) => [p.id, p.name]), S.f.pc);
  fillSelect($('#fAgent'), 'Agent', S.agents.map((a) => [a.id, a.label]), S.f.agent);
  S.f.pc = $('#fPc').value; S.f.agent = $('#fAgent').value;
  const f = S.f, rank = { live: 0, new: 1, idle: 2, susp: 3 };
  const L = S.keys.filter((k) => (!f.kind || k.kind === f.kind) && (!f.status || k.effective_status === f.status) && (!f.pc || k.machine_id === f.pc || k.pc?.id === f.pc) && (!f.agent || k.agent_id === f.agent))
    .sort((a, b) => rank[stOf(a)[2]] - rank[stOf(b)[2]] || (b.last_used_at || b.created_at) - (a.last_used_at || a.created_at));
  $('#keyN').textContent = L.length;
  $('#keys').innerHTML = L.map((k) => `<tr data-key="${k.id}" tabindex="0"><td><div class="nm"><span class="dot" style="background:${stOf(k)[3]}"></span>${esc(keyName(k))}${keySub(k) && k.kind !== 'app_key' ? `<span class="sub" style="color:var(--muted);font-weight:500">${esc(keySub(k))}</span>` : ''}</div></td><td>${kindTag(k)}</td><td class="pc">${esc(k.pc?.name || '—')}</td><td>${pill(k)}</td><td class="hm mono">${k.live_logins ? '×' + k.live_logins : '—'}</td><td class="r mono">${ago(k.last_used_at)}</td></tr>`).join('')
    || `<tr><td colspan="6">${none('key', 'No keys')}</td></tr>`;
}

/* ---------- refresh ---------- */
let busy = false;
async function refresh() {
  if (busy || !S.me) return; busy = true;
  try {
    const [k, p, a, al, iv, tp, mt, ss, tm, rq, lk, cf, ln] = await Promise.all([api('/keys'), api('/pcs').catch(() => null), api('/agents'), api('/alerts'), api('/invocations'), api('/topology').catch(() => null), api('/metrics').catch(() => null), api('/sessions').catch(() => null), api('/teams').catch(() => null), api('/requests?status=pending').catch(() => null), api('/lockdown').catch(() => null), api('/vault/conflicts').catch(() => null), api('/links').catch(() => null)]);
    if (!S.tpl.length) S.tpl = (await api('/templates')).templates;
    S.keys = k.keys; S.pcs = p ? p.pcs : [...new Map(k.keys.filter((x) => x.pc).map((x) => [x.pc.id, x.pc])).values()]; S.agents = a.agents; S.alerts = al.alerts; S.inv = iv.invocations;
    S.top = tp; S.met = mt; S.ses = ss ? ss.sessions : []; S.teams = tm ? tm.teams : []; S.reqs = rq ? rq.requests : []; S.lock = lk; S.conf = cf ? cf.conflicts : []; S.links = ln ? ln.links : S.links;
    renderAll(); $('#liveDot').classList.add('pulse'); $('#liveDot').style.background = '';
    if (!viewLoading && ['team', 'teams', 'sessions'].includes(DR.type)) openD(DR.type, DR.arg, true);
  } catch (e) { if (e.status !== 401) { $('#liveDot').classList.remove('pulse'); $('#liveDot').style.background = 'var(--bad)'; } } finally { busy = false; }
}
function renderAll() { renderKpis(); renderTopo(); renderAgentGraph(); renderAlerts(); renderAct(); renderKeys(); renderSes(); renderTeamsCard(); renderLock(); loadTree(); renderTree(); tipIcons(); }

/* ---------- main content ---------- */
const DR = { type: null, arg: null, stack: [] };
let lastFocus = null;
let viewRequest = 0;
let viewLoading = false;
async function openD(type, arg, replace, reset = false) {
  const request = ++viewRequest;
  viewLoading = true;
  let r;
  try { r = await VIEWS[type](arg); }
  catch (e) { if (request === viewRequest && e.status !== 401) toast(e.message, true); return; }
  finally { if (request === viewRequest) viewLoading = false; }
  if (request !== viewRequest) return;
  if (reset) DR.stack = [];
  else if (DR.type && !replace && (DR.type !== type || DR.arg !== arg)) DR.stack.push([DR.type, DR.arg]);
  if ($('#workspaceView').hidden) lastFocus = document.activeElement;
  DR.type = type; DR.arg = arg;
  $('#dT').innerHTML = r.t; $('#dA').innerHTML = r.a || ''; $('#dB').innerHTML = r.b;
  $('#ctxBar').innerHTML = r.bar || '';
  $('#dBack').hidden = !DR.stack.length || !!r.bar;
  // Views opened from a tab bar already carry their name in that bar: drop the card header and put its buttons at the bar's right end.
  const host = r.bar ? $('#ctxBar') : TAB_BAR[type] && $(TAB_BAR[type]);
  clearBarActions();
  $('#viewHeader').hidden = !!host;
  if (host && r.a) host.insertAdjacentHTML('beforeend', `<div class="ws-act">${r.a}</div>`);
  const workspace = $('#workspaceView');
  workspace.dataset.view = type;
  $('#overview').hidden = true;
  workspace.hidden = false;
  navOn(type, arg, !!r.bar);
  r.after && r.after();
  tipIcons(workspace); tipIcons($('#ctxBar'));
  if (!replace) {
    window.scrollTo(0, 0);
    $('#dT').focus({ preventScroll: true });
  }
  setRoute(type, type === 'key' ? arg + '|' + keyTab : arg, !replace);
}
/* The current view lives in the URL hash: #type or #type/arg (objects as JSON), so refresh and Back/Forward work. */
const routeOf = (type, arg) => '#' + type + (arg === undefined || arg === null || arg === '' ? '' : '/' + encodeURIComponent(typeof arg === 'object' ? JSON.stringify(arg) : String(arg)));
function setRoute(type, arg, push) {
  const h = routeOf(type, arg);
  if (location.hash !== h) history[push ? 'pushState' : 'replaceState'](null, '', h);
}
function restoreRoute() {
  const m = /^#([a-z]+)(?:\/(.*))?$/.exec(location.hash); if (!m) return false;
  const type = m[1]; let arg = m[2] === undefined ? undefined : decodeURIComponent(m[2]);
  if (arg && arg[0] === '{') { try { arg = JSON.parse(arg); } catch { arg = undefined; } }
  if (type === 'home' || type === 'monitoring') { go(type); return true; }
  if (!VIEWS[type]) return false;
  if (type === 'key' && typeof arg === 'string' && arg.includes('|')) { const [id, tab] = arg.split('|'); arg = id; lastKeyId = id; keyTab = KEY_TABS.some(([k]) => k === tab) ? tab : 'overview'; }
  openD(type, arg, false, true);
  return true;
}
addEventListener('popstate', () => { if (S.me) restoreRoute(); });
function closeD() {
  ++viewRequest;
  viewLoading = false;
  $('#workspaceView').hidden = true; $('#overview').hidden = false; clearBarActions();
  DR.type = null; DR.stack = []; $('#dB').innerHTML = '';
  navOn($('#overview').dataset.mode);
  if (S.me) { renderTopo(); renderAct(); renderTree(); }
  lastFocus && lastFocus.focus && lastFocus.isConnected && lastFocus.focus({ preventScroll: true });
  lastFocus = null;
}
function back() { const p = DR.stack.pop(); if (p) { openD(p[0], p[1], true); window.scrollTo(0, 0); } }
const TAB_BAR = { keys: '#securityBar', pcs: '#securityBar', req: '#securityBar', shares: '#securityBar', grant: '#securityBar', topology: '#agentsBar', sessions: '#agentsBar', teams: '#agentsBar', chats: '#agentsBar', log: '#auditBar' };
const clearBarActions = () => $$('.ws-act').forEach((x) => x.remove());
function navOn(t, arg, ctx = false) {
  const securityTab = { keys: 'keys', key: 'keys', pcs: 'pcs', req: 'req', shares: 'shares', share: 'shares', grant: 'grant', new: 'grant', app: 'grant' }[t];
  const agentTab = { topology: 'topology', sessions: 'sessions', ses: 'sessions', teams: 'teams', team: 'teams', tbuild: 'teams', chats: 'chats', room: 'chats' }[t];
  const page = securityTab ? 'security' : agentTab ? 'topology' : { log: 'log', vault: 'vault', diff: 'vault', monitoring: 'monitoring', lock: 'lock', account: 'account', shortcuts: 'shortcuts' }[t] || 'home';
  const highlight = (button, active) => {
    button.classList.toggle('on', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  };
  const bars = { security: '#securityBar', topology: '#agentsBar', vault: '#vaultBar', log: '#auditBar', monitoring: '#monitoringBar' };
  Object.entries(bars).forEach(([p, sel]) => { $(sel).hidden = ctx || p !== page; });
  $('#ctxBar').hidden = !ctx;
  $$('.nav[data-go],.bnav [data-go]').forEach(button => highlight(button, button.dataset.go === page));
  $$('#securityBar [data-go]').forEach(button => highlight(button, button.dataset.go === securityTab));
  $$('#agentsBar [data-go]').forEach(button => highlight(button, button.dataset.go === agentTab));
  $$('#auditBar [data-arg]').forEach(button => highlight(button, t === 'log' && button.dataset.arg === String(arg || 'audit').split('|')[0]));
  $$('#vaultBar [data-vault-tab]').forEach(button => highlight(button, t === 'vault' && button.dataset.vaultTab === vaultState(arg).tab));
}
function go(t, arg) {
  if (t === 'security') t = 'keys';
  if (t === 'agents') t = 'topology';
  if (t === 'home' || t === 'monitoring') {
    $('#overview').dataset.mode = t;
    closeD();
    setRoute(t, null, true);
    window.scrollTo(0, 0);
    if (t === 'monitoring') $('#monitoringTitle').focus({ preventScroll: true });
  }
  else if (t === 'theme') setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  else openD(t, arg, false, true);
}
function setTheme(th) {
  document.documentElement.dataset.theme = th;
  $$('.th-ic use').forEach((u) => u.setAttribute('href', th === 'dark' ? '#i-sun' : '#i-moon'));
  try { localStorage.setItem('ah-theme', th); } catch { /* ignore */ }
  setTimeout(renderTopo, 0);
}
const dotH = (k) => `<span class="dot" style="width:10px;height:10px;background:${stOf(k)[3]}"></span>`;

/* ---------- secret result view ---------- */
function secretView(res, title) {
  const sec_ = res.secret, k = res.key, mask = sec_.slice(0, 13) + '•'.repeat(18);
  $('#dA').innerHTML = ''; $('#dBack').hidden = !DR.stack.length; navOn(DR.type, DR.arg);
  clearBarActions(); $('#viewHeader').hidden = false;
  let b = sec('Key', `<div class="keyv" data-v="${esc(sec_)}"><span class="mono" id="kV">${mask}</span><button class="btn ic sm" id="kE" aria-label="Reveal">${ic('eye')}</button><button class="btn ic sm" data-copy aria-label="Copy">${ic('copy')}</button></div>`, `<span class="tag" style="margin-left:auto">Once</span>`);
  if (res.handoff) b += sec('Handoff', codeBox(res.handoff, true));
  if (res.setup) {
    b += sec('Claude Code', codeBox(res.setup.claude_code));
    b += sec('Codex', codeBox(res.setup.codex_env) + '<div style="height:8px"></div>' + codeBox(res.setup.codex_config_toml));
  }
  b += `<div class="wait" id="wS"><span class="dot pulse"></span><span id="wL">Waiting</span><span class="grow"></span><span class="mono" style="color:var(--muted)" id="wT">0s</span></div><div class="row"><button class="btn sm" data-key="${k.id}">${ic('key')}Open</button></div>`;
  return {
    t: `${ic('key')}<span>${esc(title || keyName(k))}</span>`, b,
    after() {
      $('#kE').onclick = () => { const e = $('#kV'); e.textContent = e.textContent.includes('•') ? sec_ : mask; };
      const t0 = Date.now(); let done = false;
      const iv = setInterval(async () => {
        const w = $('#wT'); if (!w) { clearInterval(iv); return; }
        w.textContent = Math.floor((Date.now() - t0) / 1000) + 's';
        if (done || Math.floor((Date.now() - t0) / 1000) % 3) return;
        try {
          const d = (await api('/keys/' + k.id)).key;
          if (d.live_logins > 0 || d.first_used_at) { done = true; $('#wS').classList.add('ok'); $('#wS').querySelector('.dot').classList.remove('pulse'); $('#wL').textContent = 'Connected'; refresh(); }
        } catch { /* ignore */ }
      }, 1000);
    },
  };
}

/* ---------- views ---------- */
const EXP = [['1d', 1], ['7d', 7], ['30d', 30], ['∞', 0]];
const OPS = ['list', 'read', 'search', 'create', 'update', 'rename', 'delete', 'history'];
const SIMA = ['tool.invoke', ...OPS.map((o) => 'fs.' + o), 'fs.download', 'fs.restore'];
/* Reach groups: [label, icon, globs used by Allow all / Deny all (null = per tool only)] */
const TG = [['Files', 'file', ['file_*']], ['Messages', 'chat', ['message_*', 'agent_list']], ['Rooms', 'team', ['room_*']], ['Teams and tasks', 'team', ['team_*', 'work_*', 'task_*']], ['Shares', 'link', ['share_*']], ['Channels', 'dl', ['channel_*']], ['Knowledge graph', 'hub', ['graph_*']], ['Access and setup', 'key', ['access_*', 'setup_*']], ['Other', 'app', null]];
const toolGroup = (t) => (TG.find(([, , g]) => g && g.some((p) => (p.endsWith('*') ? t.startsWith(p.slice(0, -1)) : t === p))) || TG.at(-1))[0];
const isToolRule = (r) => r.actions.length === 1 && r.actions[0] === 'tool.invoke' && r.resource.startsWith('tool:');
const ACTN = { 'tool.invoke': 'Use tool', 'fs.list': 'List', 'fs.read': 'Read', 'fs.search': 'Search', 'fs.create': 'Create', 'fs.update': 'Edit', 'fs.rename': 'Rename', 'fs.delete': 'Delete', 'fs.history': 'History', 'fs.download': 'Download', 'fs.restore': 'Restore' };
const effPill = (e) => `<span class="pill ${e === 'allow' ? 'p-live' : 'p-susp'}">${ic(e === 'allow' ? 'check' : 'x')}${e === 'allow' ? 'Allow' : 'Deny'}</span>`;
const resH = (r) => { const [kind, ...rest] = r.split(':'), v = rest.join(':'); const icn = { tool: 'bolt', path: 'vault', room: 'chat', agent: 'user', team: 'team', share: 'link' }[kind];
  return icn ? `<span class="resv" title="${esc(r)}">${ic(icn)}<span class="mono">${esc(v === '*' ? v : kind === 'agent' ? agLabel(v) : kind === 'team' ? S.teams.find((t) => t.id === v)?.name || v : v)}</span></span>` : `<span class="mono">${esc(r)}</span>`; };
const KEY_TABS = [['overview', 'Overview', 'key'], ['access', 'Access', 'vault'], ['reach', 'Reach', 'shield'], ['rules', 'Rules', 'sl'], ['simulate', 'Simulate', 'play']];
let keyTab = 'overview', lastKeyId = null;
const tick = (box, fn) => { box.onclick = (e) => { const b = e.target.closest('button'); if (!b) return; $$('button', box).forEach((x) => x.classList.remove('on')); b.classList.add('on'); fn && fn(b); }; };

const VIEWS = {
  async grant() {
    return {
      t: `${ic('shield')}Grant access`,
      b: `<div class="security-grants">
        <article class="card">
          <h3>${ic('key')} Agent session</h3>
          <p>Create a session key for a new or existing agent. Choose a permission template and set when the key expires.</p>
          <button class="btn" data-grant-flow="new">New session key</button>
        </article>
        <article class="card">
          <h3>${ic('pc')} Device and app</h3>
          <p>Register a new PC or choose an existing one, then create an app key so a client such as Codex can connect from that device.</p>
          <button class="btn" data-grant-flow="app">Set up device access</button>
        </article>
      </div>`,
    };
  },
  async new(arg) {
    if (!S.tpl.length) S.tpl = (await api('/templates')).templates;
    const ag = (S.agents || []).filter((a) => a.status !== 'revoked');
    return {
      t: `${ic('key')}Session`,
      b: sec('Agent', `<select class="inp" id="nA" aria-label="Agent" style="width:100%"><option value="">+ New</option>${ag.map((a) => `<option value="${a.id}">${esc(a.label)}${a.role ? ' · ' + esc(a.role) : ''}</option>`).join('')}</select>`) +
        sec('Label', `<input class="inp" id="nL" autocomplete="off" aria-label="Label" maxlength="80">`) +
        sec('Template', `<div class="row" id="nT"><button class="tog on" data-v="">—</button>${S.tpl.map((t) => `<button class="tog" data-v="${t.id}">${esc(t.name)}</button>`).join('')}</div>`) +
        sec('Expiry', `<div class="seg" id="nE" style="display:inline-flex">${EXP.map(([l, d]) => `<button data-d="${d}" class="${d === 7 ? 'on' : ''}">${l}</button>`).join('')}</div>`) +
        `<div><button class="btn pri" id="nGo" style="height:40px;padding:0 18px">${ic('key')}Create</button></div>`,
      after() {
        tick($('#nT')); tick($('#nE'));
        $('#nGo').onclick = () => run(async () => {
          const label = $('#nL').value.trim(); if (!label) { $('#nL').focus(); return toast('Label', true); }
          const aid = $('#nA').value, d = +$('#nE .on').dataset.d, tid = $('#nT .on').dataset.v;
          const res = await post('/keys', { kind: 'session_key', ...(aid ? { agent_id: aid } : { new_agent: { label } }), label, template_id: tid || null, expires_at: d ? Date.now() + d * 864e5 : null });
          refresh(); const v = secretView(res, label); $('#dT').innerHTML = v.t; $('#dB').innerHTML = v.b; v.after();
        });
      },
    };
  },

  async app(pcId) {
    return {
      t: `${ic('app')}App`,
      b: sec('PC', `<select class="inp" id="aP" aria-label="PC" style="width:100%"><option value="">+ New</option>${S.pcs.map((p) => `<option value="${p.id}"${p.id === pcId ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select><input class="inp" id="aPn" aria-label="PC name" placeholder="Name" style="margin-top:8px" maxlength="60" autocomplete="off">`) +
        sec('App', `<div class="row" id="aT">${['Claude Code', 'Claude Desktop', 'Codex'].map((n, i) => `<button class="tog${i === 0 ? ' on' : ''}" data-v="${n}">${n}</button>`).join('')}</div><input class="inp" id="aN" aria-label="App name" placeholder="Name" style="margin-top:8px" maxlength="60" autocomplete="off">`) +
        `<div><button class="btn pri" id="aGo" style="height:40px;padding:0 18px">${ic('app')}Create</button></div>`,
      after() {
        const sync = () => { $('#aPn').hidden = !!$('#aP').value; }; $('#aP').onchange = sync; sync();
        tick($('#aT'), (b) => { $('#aN').value = ''; $('#aN').dataset.t = b.dataset.v; });
        $('#aGo').onclick = () => run(async () => {
          let pid = $('#aP').value;
          if (!pid) { const n = $('#aPn').value.trim(); if (!n) { $('#aPn').focus(); return toast('Name', true); } pid = (await post('/pcs', { name: n })).pc.id; }
          const app = $('#aN').value.trim() || $('#aT .on').dataset.v;
          const res = await post('/keys', { kind: 'app_key', machine_id: pid, app_name: app });
          refresh(); const v = secretView(res, app); $('#dT').innerHTML = v.t; $('#dB').innerHTML = v.b; v.after();
        });
      },
    };
  },

  async log(arg = 'audit') {
    const [tab, pre] = String(arg).split('|');
    if (tab === 'alerts') return auditAlerts(pre);
    if (tab === 'calls') return auditCalls(pre);
    return auditEvents(pre);
  },

  async keys() {
    return {
      t: `${ic('key')}Keys <span class="n" id="keyN">0</span>`,
      a: `<button class="btn sm" data-go="new">${ic('plus')}Session</button><button class="btn sm" data-go="app">${ic('plus')}App</button>`,
      b: vtools(`<div class="seg" id="fKind" role="group" aria-label="Kind">${[['', 'All'], ['session_key', 'Session'], ['app_key', 'App']].map(([v, l]) => `<button data-v="${v}" class="${S.f.kind === v ? 'on' : ''}">${l}</button>`).join('')}</div>
        <select class="sel" id="fStatus" aria-label="Status"><option value="">Status</option>${['active', 'suspended', 'revoked', 'expired'].map((s) => `<option${S.f.status === s ? ' selected' : ''}>${s}</option>`).join('')}</select>
        <select class="sel" id="fPc" aria-label="PC"></select><select class="sel" id="fAgent" aria-label="Agent"></select>`) +
        `<div class="tscroll"><table class="tbl"><thead><tr><th>Key</th><th>Kind</th><th class="pc">PC</th><th>Status</th><th class="hm">Logins</th><th class="r">Seen</th></tr></thead><tbody id="keys"></tbody></table></div>`,
      after() {
        $('#fKind').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; $$('#fKind button').forEach((x) => x.classList.toggle('on', x === b)); S.f.kind = b.dataset.v; renderKeys(); };
        $('#fStatus').onchange = () => { S.f.status = $('#fStatus').value; renderKeys(); };
        $('#fPc').onchange = () => { S.f.pc = $('#fPc').value; renderKeys(); };
        $('#fAgent').onchange = () => { S.f.agent = $('#fAgent').value; renderKeys(); };
        renderKeys();
      },
    };
  },

  async account() {
    const me = S.me;
    return {
      t: `${ic('user')}${esc(me.username)}`,
      b: sec('2FA', me.totp_enrolled ? `<div class="chk y">${ic('check')}TOTP</div>` : `<div id="tB"><button class="btn" id="tGo">${ic('lock')}Enrol</button></div>`) +
        `<div><button class="btn bad" id="lo">${ic('out')}Sign out</button></div>`,
      after() {
        $('#lo').onclick = () => run(signOut);
        const g = $('#tGo'); if (!g) return;
        g.onclick = () => run(async () => {
          const r = await post('/totp/enroll');
          $('#tB').innerHTML = codeBox(r.secret) + '<div style="height:8px"></div>' + codeBox(r.otpauth_uri) + `<div class="row" style="margin-top:10px"><input class="inp mono" id="tC" inputmode="numeric" maxlength="6" placeholder="000000" aria-label="Code" style="width:140px" autocomplete="one-time-code"><button class="btn pri" id="tOk">${ic('check')}Confirm</button></div>`;
          $('#tC').focus();
          $('#tOk').onclick = () => run(async () => { await post('/totp/confirm', { code: $('#tC').value.trim() }); S.me.totp_enrolled = true; toast('2FA'); renderAlerts(); openD('account', null, true); });
        });
      },
    };
  },

  async shortcuts() {
    const L = [['S', 'Sessions'], ['M', 'Teams'], ['C', 'Chats'], ['K', 'Keys'], ['P', 'PCs'], ['V', 'Vault'], ['R', 'Requests'], ['H', 'Shares'], ['O', 'Lockdown'], ['G', 'Agents'], ['L', 'Auditing'], ['T', 'Theme'], ['Esc', 'Back']];
    return { t: `${ic('kbd')}Shortcuts`, b: `<div class="k-r">${L.map(([k, l]) => `<span class="kbd" style="font-size:12px;padding:3px 8px;justify-self:start">${k}</span><span>${l}</span>`).join('')}</div>` };
  },

  async key(id) {
    const [d, rl, vs, ef] = await Promise.all([api('/keys/' + id), api(`/keys/${id}/rules`), api(`/keys/${id}/versions`), api(`/keys/${id}/effective`)]);
    if (id !== lastKeyId) { keyTab = 'overview'; lastKeyId = id; }
    const keyTitle = (p) => { const [, l, icn] = KEY_TABS.find((x) => x[0] === p); return ic(icn) + l; };
    const k = d.key, alias = S.me.vault_alias, isApp = k.kind === 'app_key', dead = k.effective_status === 'revoked';
    const st = stOf(k), mine = S.inv.filter((i) => i.credential_id === id || i.app_credential_id === id);
    const B = buckets((i) => i.credential_id === id || i.app_credential_id === id), calls = mine.length, den = mine.filter((i) => i.result === 'denied').length;
    const rows = [{ res: `path:/${alias}/**`, label: '/', root: 1 }, ...ef.folders.map((f) => ({ res: `path:${f.path}/**`, label: f.path.split('/').pop() }))];
    const E = { M: {}, other: [], dirty: false, rules: rl.rules, pend: {}, open: new Set(), ef: null };
    const parse = (rules) => {
      E.M = {}; rows.forEach((r) => (E.M[r.res] = {})); E.other = [];
      for (const r of rules) {
        if (E.M[r.resource] && r.actions.every((a) => a.startsWith('fs.') && OPS.includes(a.slice(3)))) r.actions.forEach((a) => { const o = a.slice(3), c = E.M[r.resource]; if (r.effect === 'deny') c[o] = 'd'; else if (c[o] !== 'd') c[o] = 'a'; });
        else E.other.push({ effect: r.effect, actions: r.actions, resource: r.resource, from_template: r.from_template ?? null, note: r.note ?? null });
      }
    };
    parse(rl.rules);
    const cellOf = (r, o) => { const v = E.M[r.res][o]; if (v) return v; return !r.root && E.M[rows[0].res][o] === 'a' ? 'i' : ''; };
    const cic = { a: 'check', d: 'x' };
    const mxHtml = () => `<div class="mx"><span></span>${OPS.map((o) => `<span class="ch">${o}</span>`).join('')}${rows.map((r, ri) => `<span class="rh">${ic(r.root ? 'hub' : 'vault')}<span style="overflow:hidden;text-overflow:ellipsis">${esc(r.label)}</span></span>${OPS.map((o) => { const v = cellOf(r, o); return `<button class="cell c-${v || 'n'}${v === 'i' ? ' nc' : ''}" data-r="${ri}" data-o="${o}" aria-label="${esc(r.label)} ${o} ${v || 'none'}">${cic[v] ? ic(cic[v]) : ''}</button>`; }).join('')}`).join('')}</div>`;
    const othHtml = () => {
      const L = E.other.map((r, i) => [r, i]).filter(([r]) => !isToolRule(r));
      return L.length ? `<div class="tscroll"><table class="tbl rules"><thead><tr><th>Effect</th><th>Actions</th><th>Resource</th><th></th></tr></thead><tbody>${L.map(([r, i]) => `<tr>
        <td>${effPill(r.effect)}</td><td><span class="wrap">${r.actions.map((a) => `<span class="tag" title="${esc(a)}">${esc(ACTN[a] || a)}</span>`).join('')}</span></td>
        <td>${resH(r.resource)}</td><td class="r">${r.from_template ? '<span class="tag">Template</span>' : ''}<button class="btn ic sm" data-del="${i}" aria-label="Remove rule">${ic('x')}</button></td></tr>`).join('')}</tbody></table></div>` : none('sl', 'No other rules');
    };
    const lg = `<span class="lg lgs"><span><i class="c-a"></i>Allow</span><span><i class="c-i"></i>Inherit</span><span><i class="c-d"></i>Deny</span></span>`;
    const appKeys = S.keys.filter((x) => x.kind === 'app_key' && x.status !== 'revoked');
    const exp = k.expires_at;
    const toolOn = (t) => (t.tool in E.pend ? E.pend[t.tool] : t.allowed);
    const reach = (e) => {
      E.ef = e;
      const tools = e.tools.filter((t) => t.reason !== 'always available when logged in');
      const groups = TG.map(([name, icon, globs]) => ({ name, icon, globs, tools: tools.filter((t) => toolGroup(t.tool) === name) })).filter((g) => g.tools.length);
      const grp = (g) => {
        const on = g.tools.filter(toolOn).length, n = g.tools.length, pend = g.tools.some((t) => t.tool in E.pend);
        const count = on === n ? 'All' : on ? `${on} of ${n}` : 'None';
        return `<details class="rgrp" data-g="${esc(g.name)}"${E.open.has(g.name) ? ' open' : ''}><summary>
          <span class="ci">${ic(g.icon)}</span><b>${esc(g.name)}${pend ? ' <span class="tag pend">Unsaved</span>' : ''}</b>
          <span class="rbar" aria-hidden="true"><i style="width:${Math.round((on / n) * 100)}%"></i></span>
          <span class="rcount${on === n ? ' all' : on ? '' : ' none'}">${count}</span>
          <span class="rga">${g.globs ? `<button class="btn sm" data-ga="allow" data-g="${esc(g.name)}">Allow all</button><button class="btn sm" data-ga="deny" data-g="${esc(g.name)}">Deny all</button>` : ''}</span>
          ${ic('chev', 'rgo')}</summary>
          <div class="rtools">${g.tools.map((t) => { const y = toolOn(t), p = t.tool in E.pend; return `<button class="rtool${y ? ' y' : ''}${p ? ' p' : ''}" data-tt="${esc(t.tool)}" title="${esc(p ? 'Unsaved change' : t.reason)}">${ic(y ? 'check' : 'x')}<span>${esc(t.tool)}</span></button>`; }).join('')}</div></details>`;
      };
      const fold = (name, f, root) => `<div class="rfold">${ic(root ? 'hub' : 'vault')}<span class="nm">${esc(name)}</span>${['list', 'read'].map((o) => `<span class="chk${f[o] ? ' y' : ''}">${ic(f[o] ? 'check' : 'x')}${o === 'list' ? 'List' : 'Read'}</span>`).join('')}</div>`;
      return `<h5 class="subh">Tools</h5>${groups.map(grp).join('')}<h5 class="subh">Folders</h5><div>${fold('Vault root', e.root, 1)}${e.folders.map((f) => fold(f.path.split('/').pop(), f)).join('')}</div>`;
    };
    const pane = (p, html) => `<div class="kpane" data-pane="${p}"${p === keyTab ? '' : ' hidden'}>${html}</div>`;
    const body =
      pane('overview', `<div class="row">${pill(k)}${kindTag(k)}${k.agent ? `<span class="tag">${esc(k.agent.label)}${k.agent.role ? ' · ' + esc(k.agent.role) : ''}</span>` : ''}${k.pc ? `<span class="tag">${esc(k.pc.name)}${k.app_name ? ' · ' + esc(k.app_name) : ''}</span>` : ''}</div>` +
      (dead ? '' : `<div class="row">${k.effective_status === 'active' ? `<button class="btn sm bad" id="kSus">${ic('pause')}Suspend</button>` : k.effective_status === 'suspended' ? `<button class="btn sm ok" id="kRe">${ic('play')}Resume</button>` : ''}<button class="btn sm" id="kRot">${ic('rot')}Rotate</button><button class="btn sm" id="kEnd"${k.live_logins ? '' : ' disabled'}>${ic('out')}End${k.live_logins ? ' ×' + k.live_logins : ''}</button><button class="btn sm bad" id="kRev">${ic('trash')}Revoke</button></div>`) +
      `<div class="stat3"><div class="mini"><small>Calls/h</small><b>${calls}</b>${spark(B.map((b) => b.v + b.t + b.d), 100, 22, 'var(--s-tool)')}</div><div class="mini"><small>Denials/h</small><b style="color:${den ? 'var(--bad-t)' : ''}">${den}</b></div><div class="mini"><small>Seen</small><b>${ago(k.last_used_at)}</b></div></div>` +
      (dead ? '' : sec('Expiry', `<div class="row"><span class="tag">${exp ? day(exp) : '∞'}</span><div class="seg" id="kX">${EXP.map(([l, dd]) => `<button data-d="${dd}">${l}</button>`).join('')}</div></div>`))) +
      pane('access', sec('Folder permissions', `<div id="mxW">${mxHtml()}</div>`, lg)) +
      pane('reach', sec('Effective reach',`${isApp ? '' : vtools(`<label class="vlabel">Through app key <select class="sel" id="eA"><option value="">None</option>${appKeys.map((a) => `<option value="${a.id}">${esc(a.app_name)} · ${esc(a.pc?.name || '')}</option>`).join('')}</select></label>`)}<div id="eW">${reach(ef)}</div>`)) +
      pane('rules', sec('Other rules',`<div id="othW">${othHtml()}</div><div class="radd"><select class="sel" id="rE" aria-label="Effect"><option value="allow">Allow</option><option value="deny">Deny</option></select><input class="inp mono" id="rA" placeholder="Actions, e.g. fs.read" aria-label="Actions"><input class="inp mono" id="rR" placeholder="Resource, e.g. room:*" aria-label="Resource"><button class="btn sm" id="rAdd">${ic('plus')}Add</button></div>`, `<span class="tag" style="margin-left:auto">v${rl.version}</span>`) +
      sec('Template and versions', `<div class="row" style="margin-bottom:10px"><select class="sel" id="tS" aria-label="Template"><option value="">Template</option>${S.tpl.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select><button class="btn sm" id="tApply">Apply</button></div><div style="max-height:200px;overflow:auto">${vs.versions.map((v) => `<div class="rl"><span class="tag">v${v.version}</span><span class="mono">${ago(v.created_at)}${v.change_note ? ' · ' + esc(v.change_note) : ''}</span>${v.version === rl.version ? `<span class="tag">${ic('check')}Current</span>` : `<button class="btn sm" data-rb="${v.version}">${ic('rot')}Restore</button>`}</div>`).join('')}</div>`)) +
      pane('simulate', sec('Simulate', `<div class="row" style="margin-bottom:10px;flex-wrap:nowrap"><select class="sel" id="sA" aria-label="Action" style="height:38px">${SIMA.map((a) => `<option${a === 'fs.read' ? ' selected' : ''}>${a}</option>`).join('')}</select><input class="inp mono" id="sR" value="/${esc(alias)}/" aria-label="Resource" style="min-width:0"></div><div class="res" id="sRes"></div>`)) +
      `<div class="savebar" id="kSave" hidden><span>${ic('edit')}Unsaved changes</span><input class="inp" id="rN" placeholder="Note" aria-label="Change note" maxlength="200"><button class="btn sm" id="rDiscard">Discard</button><button class="btn pri sm" id="rSave">${ic('check')}Save</button></div>`;
    return {
      t: keyTitle(keyTab), b: body,
      bar: `<button class="btn ic" data-ctx-back aria-label="Back">${ic('back')}</button><h2 id="ctxTitle">${dotH(k)}<span class="ctx-name">${esc(keyName(k))}</span><span class="tag">${esc(k.masked_key)}</span></h2><nav class="seg ws-tabs" aria-label="Key sections">${KEY_TABS.map(([p, l, icn]) => `<button data-key-tab="${p}" class="${p === keyTab ? 'on' : ''}">${ic(icn)}${l}</button>`).join('')}</nav>`,
      after() {
        $$('#ctxBar [data-key-tab]').forEach((b) => (b.onclick = () => {
          keyTab = b.dataset.keyTab; setRoute('key', id + '|' + keyTab);
          $$('#ctxBar [data-key-tab]').forEach((x) => x.classList.toggle('on', x === b));
          $$('.kpane').forEach((p) => (p.hidden = p.dataset.pane !== keyTab));
          $('#dT').innerHTML = keyTitle(keyTab); window.scrollTo(0, 0);
        }));
        const act = (fn, msg) => run(async () => { await fn(); toast(msg); await refresh(); openD('key', id, true); });
        const on = (sel, fn) => { const e = $(sel); if (e) e.onclick = fn; };
        on('#kSus', () => act(() => post(`/keys/${id}/suspend`), 'Suspended'));
        on('#kRe', () => act(() => post(`/keys/${id}/reactivate`), 'Resumed'));
        if ($('#kEnd')) $('#kEnd').onclick = () => act(() => post(`/keys/${id}/end-logins`), 'Ended');
        if ($('#kRev')) arm($('#kRev'), () => act(() => post(`/keys/${id}/revoke`), 'Revoked'));
        if ($('#kRot')) arm($('#kRot'), () => run(async () => { const r = await post(`/keys/${id}/rotate`); refresh(); const v = secretView(r, keyName(k)); $('#dT').innerHTML = v.t; $('#dB').innerHTML = v.b; v.after(); }));
        if ($('#kX')) $('#kX').onclick = (e) => { const b = e.target.closest('button'); if (b) act(() => api('/keys/' + id, 'PATCH', { expires_at: +b.dataset.d ? Date.now() + +b.dataset.d * 864e5 : null }), 'Saved'); };
        const dirty = () => { E.dirty = true; $('#kSave').hidden = false; $('#mxW').innerHTML = mxHtml(); $('#othW').innerHTML = othHtml(); $('#eW').innerHTML = reach(E.ef); tipIcons($('#dB')); };
        const setTools = (names, globs, allow) => {
          const drop = new Set([...names, ...(globs || [])].map((n) => 'tool:' + n));
          E.other = E.other.filter((r) => !(isToolRule(r) && drop.has(r.resource)));
          if (allow && !globs) {
            // Deny wins, so a matching deny glob would keep the tool off: replace it with explicit denies for the rest.
            const hits = (r, t) => isToolRule(r) && r.effect === 'deny' && r.resource.endsWith('*') && t.startsWith(r.resource.slice(5, -1));
            const globsHit = E.other.filter((r) => hits(r, names[0]));
            if (globsHit.length) {
              E.other = E.other.filter((r) => !globsHit.includes(r));
              E.ef.tools.filter((t) => t.tool !== names[0] && globsHit.some((r) => hits(r, t.tool)) && !E.other.some((r) => isToolRule(r) && r.resource === 'tool:' + t.tool))
                .forEach((t) => E.other.push({ effect: 'deny', actions: ['tool.invoke'], resource: 'tool:' + t.tool, from_template: null, note: null }));
            }
          }
          (globs || names).forEach((n) => E.other.push({ effect: allow ? 'allow' : 'deny', actions: ['tool.invoke'], resource: 'tool:' + n, from_template: null, note: null }));
          names.forEach((n) => (E.pend[n] = allow)); dirty();
        };
        $('#eW').addEventListener('toggle', (e) => { const g = e.target.dataset?.g; if (g) e.target.open ? E.open.add(g) : E.open.delete(g); }, true);
        $('#eW').onclick = (e) => {
          const ga = e.target.closest('[data-ga]');
          if (ga) { e.preventDefault(); const g = TG.find(([n]) => n === ga.dataset.g); setTools(E.ef.tools.filter((t) => toolGroup(t.tool) === g[0]).map((t) => t.tool), g[2], ga.dataset.ga === 'allow'); return; }
          const tt = e.target.closest('[data-tt]');
          if (tt) { const t = E.ef.tools.find((x) => x.tool === tt.dataset.tt); setTools([t.tool], null, !toolOn(t)); $('#eW [data-tt="' + t.tool + '"]')?.focus(); }
        };
        $('#rDiscard').onclick = () => openD('key', id, true);
        $('#mxW').onclick = (e) => {
          const c = e.target.closest('.cell'); if (!c || c.classList.contains('nc')) return;
          const r = rows[+c.dataset.r], o = c.dataset.o, cur = E.M[r.res][o] || '';
          const nx = { '': 'a', a: 'd', d: '' }[cur]; if (nx) E.M[r.res][o] = nx; else delete E.M[r.res][o];
          dirty(); const f = $(`#mxW [data-r="${c.dataset.r}"][data-o="${o}"]`); f && f.focus();
        };
        $('#othW').onclick = (e) => { const b = e.target.closest('[data-del]'); if (b) { E.other.splice(+b.dataset.del, 1); dirty(); } };
        $('#rAdd').onclick = () => {
          const a = $('#rA').value.split(',').map((x) => x.trim()).filter(Boolean), r = $('#rR').value.trim();
          if (!a.length || !r) return toast('Rule', true);
          E.other.push({ effect: $('#rE').value, actions: a, resource: r.startsWith('/') ? 'path:' + r : r, from_template: null, note: null }); $('#rA').value = ''; $('#rR').value = ''; dirty();
        };
        $('#rSave').onclick = () => run(async () => {
          const gen = [];
          rows.forEach((r) => { const al = OPS.filter((o) => E.M[r.res][o] === 'a').map((o) => 'fs.' + o), dn = OPS.filter((o) => E.M[r.res][o] === 'd').map((o) => 'fs.' + o); if (dn.length) gen.push({ effect: 'deny', actions: dn, resource: r.res }); if (al.length) gen.push({ effect: 'allow', actions: al, resource: r.res }); });
          const rules = [...E.other, ...gen].map((r) => ({ effect: r.effect, actions: r.actions, resource: r.resource, from_template: r.from_template ?? null, note: r.note ?? null }));
          const res = await api(`/keys/${id}/rules`, 'PUT', { rules, note: $('#rN').value.trim() || null });
          toast('v' + res.version); openD('key', id, true);
        });
        $('#tApply').onclick = () => { const t = $('#tS').value; if (t) act(() => post(`/keys/${id}/apply-template`, { template_id: t }), 'Applied'); };
        $$('[data-rb]').forEach((b) => (b.onclick = () => act(() => post(`/keys/${id}/rollback`, { version: +b.dataset.rb }), 'v' + b.dataset.rb)));
        if ($('#eA')) $('#eA').onchange = () => run(async () => { const q = $('#eA').value; $('#eW').innerHTML = reach(await api(`/keys/${id}/effective${q ? '?app_key_id=' + q : ''}`)); simulate(); });
        let tm;
        const simulate = () => run(async () => {
          const r = $('#sR').value.trim(); if (!r) return;
          let dec;
          try { dec = (await post('/simulate', { credential_id: id, app_credential_id: ($('#eA') && $('#eA').value) || null, action: $('#sA').value, resource: r })).decision; }
          catch (e) { $('#sRes').className = 'res n'; $('#sRes').innerHTML = `<span class="big">${ic('x')}</span><span class="mono" style="color:var(--muted)">${esc(e.message)}</span>`; return; }
          const rule = dec.rule ? `${dec.rule.effect} ${dec.rule.actions.join(',')} ${dec.rule.resource}` : dec.reason;
          $('#sRes').className = 'res ' + (dec.allowed ? 'y' : 'n');
          $('#sRes').innerHTML = `<span class="big">${ic(dec.allowed ? 'check' : 'x')}${dec.allowed ? 'Allow' : 'Deny'}</span><span class="mono" style="color:var(--muted);overflow:hidden;text-overflow:ellipsis">${esc(rule)}</span>${dec.source ? `<span class="tag" style="margin-left:auto">${esc(dec.source)}</span>` : ''}`;
        });
        ['#sA', '#sR'].forEach((s) => ($(s).oninput = () => { clearTimeout(tm); tm = setTimeout(simulate, 250); }));
        simulate();
      },
    };
  },
};

/* ---------- phase 2/3/3b views ---------- */
const TCOL = { open: 'var(--idle)', assigned: 'var(--info)', in_progress: 'var(--accent)', in_review: 'var(--warn)', approved: 'var(--ok)', changes_requested: 'var(--warn)', blocked: 'var(--bad)', done: 'var(--ok)' };
const TSTC = { running: 'var(--ok)', paused: 'var(--warn)', draft: 'var(--idle)', stopped: 'var(--bad)', done: 'var(--accent)' };
const COLS = [['Open', ['open', 'assigned']], ['Doing', ['in_progress', 'changes_requested']], ['Review', ['in_review', 'approved']], ['Blocked', ['blocked']], ['Done', ['done']]];
const ring = (p, sz = 36, col = 'var(--ok)') => { const r = sz / 2 - 3, c = 2 * Math.PI * r, h = sz / 2; return `<svg class="rg" width="${sz}" height="${sz}" viewBox="0 0 ${sz} ${sz}" aria-hidden="true"><circle cx="${h}" cy="${h}" r="${r}" fill="none" stroke-width="3.5" style="stroke:var(--panel-3)"/><circle cx="${h}" cy="${h}" r="${r}" fill="none" stroke-width="3.5" stroke-linecap="round" stroke-dasharray="${(c * p / 100).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 ${h} ${h})" style="stroke:${col}"/><text x="50%" y="50%" dominant-baseline="central" text-anchor="middle" class="rt" style="font-size:${sz > 44 ? 14 : 10}px">${p}</text></svg>`; };
const tstat = (t) => `<span class="pill" style="background:color-mix(in srgb,${TSTC[t.status]} 16%,transparent);color:${TSTC[t.status]}">${esc(t.status)}</span>`;
const agLabel = (id) => (id === 'hub' ? 'hub' : S.agents.find((a) => a.id === id)?.label || S.ses.find((s) => s.agent.id === id)?.agent.label || trunc(String(id || '—'), 12));
/* Agents topology. Three levels: Projects (one node per project), Agents (agents only) and All (agents, teams, rooms).
   Clicking a project or, at the Agents level, an agent drills into its neighbourhood; the breadcrumb goes back.
   Edges are coloured by how recently they carried activity. */
const ACT_MS = 30_000, REC_MS = 300_000;
const TGW = [['5m', 300_000], ['1h', 3600_000], ['24h', 86400_000], ['7d', 7 * 86400_000]];
const TGL = [['projects', 'Projects', 'vault'], ['agents', 'Agents', 'ses'], ['all', 'All', 'hub']];
const TG_S = { win: 86400_000, layers: { team: true, msg: true, link: true }, hover: null, level: 'projects', focus: null };
try { TG_S.level = TGL.some(([k]) => k === localStorage.getItem('ah-topo-level')) ? localStorage.getItem('ah-topo-level') : 'projects'; } catch { /* ignore */ }
const recency = (t) => (!t ? 'old' : Date.now() - t < ACT_MS ? 'act' : Date.now() - t < REC_MS ? 'rec' : 'old');
const TEAM_TOOLS = /^(team_|task_|work_)/;
const NO_PROJECT = 'No project';
const projectOf = (a) => a.project || S.teams.find((t) => (t.agent_ids || []).includes(a.id))?.name || NO_PROJECT;
const initials = (s) => s.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
function topoModel() {
  const now = Date.now(), agents = S.agents.filter((a) => a.status !== 'archived'), ids = new Set(agents.map((a) => a.id));
  const keyAgent = new Map(S.keys.map((k) => [k.id, k.agent_id]));
  const act = new Map(agents.map((a) => [a.id, { last: 0, tool: null, result: null, denied: 0, teamLast: 0 }]));
  for (const i of S.inv) {
    const st = act.get(keyAgent.get(i.credential_id)); if (!st) continue;
    if (i.created_at > st.last) Object.assign(st, { last: i.created_at, tool: i.tool, result: i.result });
    if (i.result === 'denied' && now - i.created_at < REC_MS) st.denied++;
    if (TEAM_TOOLS.test(i.tool) && i.created_at > st.teamLast) st.teamLast = i.created_at;
  }
  const live = new Set(S.ses.filter((s) => s.live).map((s) => s.agent.id));
  const teamByRoom = new Map(S.teams.filter((t) => t.room_id).map((t) => [t.room_id, t]));
  const comm = (S.top?.comm_edges || []).filter((e) => now - e.last_at < TG_S.win && ids.has(e.from));
  const edges = new Map(), add = (key, e) => { const o = edges.get(key); if (!o) edges.set(key, e); else { o.count += e.count; o.last = Math.max(o.last, e.last); } };
  const rooms = new Map();
  for (const e of comm) {
    const team = teamByRoom.get(e.room_id);
    if (team) { const st = act.get(e.from); if (st) st.teamLast = Math.max(st.teamLast, e.last_at); continue; }
    if (e.room_kind === 'direct' && ids.has(e.to)) add('m:' + [e.from, e.to].sort().join('|'), { kind: 'msg', a: e.from, b: e.to, count: e.count, last: e.last_at, room: e.room_id });
    else { rooms.set(e.room_id, S.convs.find((c) => c.id === e.room_id)?.name || 'Room'); add('r:' + e.from + '|' + e.room_id, { kind: 'room', a: e.from, b: 'room:' + e.room_id, count: e.count, last: e.last_at, room: e.room_id }); }
  }
  for (const t of S.teams) for (const aid of t.agent_ids || []) if (ids.has(aid)) edges.set('t:' + aid + '|' + t.id, { kind: 'team', a: aid, b: 'team:' + t.id, count: 1, last: act.get(aid).teamLast, team: t.id });
  for (const l of S.links) if (ids.has(l.from_agent_id) && ids.has(l.to_agent_id)) {
    const k = 'l:' + [l.from_agent_id, l.to_agent_id].sort().join('|');
    if (!edges.has(k) && !edges.has('m' + k.slice(1))) edges.set(k, { kind: 'link', a: l.from_agent_id, b: l.to_agent_id, count: 1, last: 0, link: l });
  }
  const proj = new Map(agents.map((a) => [a.id, projectOf(a)]));
  return { agents, act, live, rooms, proj, edges: [...edges.values()].filter((e) => TG_S.layers[e.kind === 'room' ? 'msg' : e.kind]) };
}
/* Which part of the model the current level and focus show. drill: clicks drill in instead of opening the agent. */
function topoScope(M) {
  const f = TG_S.focus, between = (e, set) => set.has(e.a) && !e.b.includes(':') && set.has(e.b);
  if (f?.kind === 'project') {
    const inside = new Set(M.agents.filter((a) => M.proj.get(a.id) === f.id).map((a) => a.id)), ext = new Set();
    // Outside agents this project talks to stay visible, faded, so cross-project traffic is not hidden.
    for (const e of M.edges) if (!e.b.includes(':') && inside.has(e.a) !== inside.has(e.b)) ext.add(inside.has(e.a) ? e.b : e.a);
    const ids = new Set([...inside, ...ext]);
    return { ids, ext, center: null, drill: false, edges: M.edges.filter((e) => (e.b.includes(':') ? inside.has(e.a) : between(e, ids) && (inside.has(e.a) || inside.has(e.b)))) };
  }
  if (f?.kind === 'agent') {
    const ids = new Set([f.id]), teamsOf = new Set(M.edges.filter((e) => e.kind === 'team' && e.a === f.id).map((e) => e.b));
    for (const e of M.edges) {
      if (!e.b.includes(':') && (e.a === f.id || e.b === f.id)) ids.add(e.a === f.id ? e.b : e.a);
      if (e.kind === 'team' && teamsOf.has(e.b)) ids.add(e.a);
    }
    return { ids, ext: new Set(), center: f.id, drill: false, edges: M.edges.filter((e) => (e.b.includes(':') ? ids.has(e.a) && (e.kind !== 'team' || teamsOf.has(e.b)) && (e.kind !== 'room' || e.a === f.id) : between(e, ids))) };
  }
  const ids = new Set(M.agents.map((a) => a.id));
  if (TG_S.level === 'agents') return { ids, ext: new Set(), center: null, drill: true, edges: M.edges.filter((e) => !e.b.includes(':')) };
  return { ids, ext: new Set(), center: null, drill: false, edges: M.edges };
}
const edgeWidth = (e) => (e.kind === 'msg' || e.kind === 'room' ? Math.min(1.5 + Math.log2(e.count + 1), 6) : 1.6);
function bindGraphHover(svg) {
  const focus = (id) => {
    TG_S.hover = id; svg.classList.toggle('focus', !!id); $$('.hl', svg).forEach((x) => x.classList.remove('hl')); if (!id) return;
    $$('.tg-eg', svg).forEach((g) => { if (g.dataset.a === id || g.dataset.b === id) { g.classList.add('hl'); svg.querySelector(`[data-n="${CSS.escape(g.dataset.a === id ? g.dataset.b : g.dataset.a)}"]`)?.classList.add('hl'); } });
    svg.querySelector(`[data-n="${CSS.escape(id)}"]`)?.classList.add('hl');
  };
  svg.onmouseover = (e) => { const n = e.target.closest('.tg-node'); if (n) focus(n.dataset.n); };
  svg.onmouseleave = () => focus(null);
  if (TG_S.hover && svg.querySelector(`[data-n="${CSS.escape(TG_S.hover)}"]`)) focus(TG_S.hover);
}
function renderProjectGraph(graph, M) {
  const projects = new Map();
  for (const a of M.agents) {
    const name = M.proj.get(a.id), p = projects.get(name) || { name, agents: 0, live: 0, last: 0, denied: 0 }, st = M.act.get(a.id);
    p.agents++; if (M.live.has(a.id)) p.live++; p.last = Math.max(p.last, st.last, st.teamLast); p.denied += st.denied; projects.set(name, p);
  }
  const list = [...projects.values()].sort((x, y) => (x.name === NO_PROJECT) - (y.name === NO_PROJECT) || x.name.localeCompare(y.name));
  const edges = new Map();
  for (const e of M.edges) {
    if (e.b.includes(':') || e.kind === 'team') continue;
    const pa = M.proj.get(e.a), pb = M.proj.get(e.b); if (!pa || !pb || pa === pb) continue;
    const k = [pa, pb].sort().join('|'), o = edges.get(k) || { kind: e.kind, a: 'p:' + [pa, pb].sort()[0], b: 'p:' + [pa, pb].sort()[1], count: 0, last: 0 };
    if (e.kind === 'msg') { o.kind = 'msg'; o.count += e.count; o.last = Math.max(o.last, e.last); }
    edges.set(k, o);
  }
  const W = Math.max(graph.clientWidth, 320), H = Math.round(Math.min(Math.max(W * 0.5, 320), 520)), cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2 - 80;
  const P = new Map(list.map((p, i) => { const ang = -Math.PI / 2 + (2 * Math.PI * i) / list.length; return ['p:' + p.name, list.length === 1 ? { x: cx, y: cy } : { x: cx + R * Math.cos(ang), y: cy + R * Math.sin(ang) }]; }));
  const rad = (p) => 26 + Math.min(Math.sqrt(p.agents) * 5, 22);
  const edgeH = [...edges.values()].map((e) => {
    const p = P.get(e.a), q = P.get(e.b), d = `M${p.x.toFixed(1)} ${p.y.toFixed(1)}Q${((p.x + q.x) / 2 + (cx - (p.x + q.x) / 2) * 0.3).toFixed(1)} ${((p.y + q.y) / 2 + (cy - (p.y + q.y) / 2) * 0.3).toFixed(1)} ${q.x.toFixed(1)} ${q.y.toFixed(1)}`;
    const t = e.kind === 'msg' ? `${e.a.slice(2)} ↔ ${e.b.slice(2)} · ${e.count} messages · last ${ago(e.last)} ago` : `${e.a.slice(2)} ↔ ${e.b.slice(2)} · linked agents, no messages in window`;
    return `<g class="tg-eg" data-a="${esc(e.a)}" data-b="${esc(e.b)}"><title>${esc(t)}</title><path class="tg-e k-${e.kind} r-${e.kind === 'link' ? 'old' : recency(e.last)}" d="${d}" style="stroke-width:${edgeWidth(e)}"/><path class="tg-hit" d="${d}"/></g>`;
  }).join('');
  const nodeH = list.map((p) => {
    const q = P.get('p:' + p.name), r = rad(p), rc = recency(p.last);
    return `<g class="tg-node tg-proj${p.live ? ' live' : ''} r-${rc}" data-n="p:${esc(p.name)}" data-tg-proj="${esc(p.name)}" tabindex="0" role="button" aria-label="Open project ${esc(p.name)}">
      <title>${esc(p.name)} · ${p.agents} agent${p.agents === 1 ? '' : 's'} · ${p.live} live${p.last ? ' · last activity ' + ago(p.last) + ' ago' : ''}${p.denied ? ' · ' + p.denied + ' denied in 5m' : ''} · click to open</title>
      ${rc === 'act' ? `<circle class="halo" cx="${q.x.toFixed(1)}" cy="${q.y.toFixed(1)}" r="${r}"/>` : ''}
      <circle class="core" cx="${q.x.toFixed(1)}" cy="${q.y.toFixed(1)}" r="${r}"/>
      <text class="ini big" x="${q.x.toFixed(1)}" y="${(q.y - 6).toFixed(1)}" text-anchor="middle" dominant-baseline="central">${p.agents}</text>
      <text class="tg-sub" x="${q.x.toFixed(1)}" y="${(q.y + 12).toFixed(1)}" text-anchor="middle">agent${p.agents === 1 ? '' : 's'}</text>
      ${p.denied ? `<g class="tg-den"><circle cx="${(q.x + r * 0.72).toFixed(1)}" cy="${(q.y - r * 0.72).toFixed(1)}" r="9"/><text x="${(q.x + r * 0.72).toFixed(1)}" y="${(q.y - r * 0.72).toFixed(1)}" text-anchor="middle" dominant-baseline="central">${p.denied}</text></g>` : ''}
      <text class="tg-lbl" x="${q.x.toFixed(1)}" y="${(q.y + r + 18).toFixed(1)}" text-anchor="middle">${esc(trunc(p.name, 28))}</text>
      <text class="tg-sub" x="${q.x.toFixed(1)}" y="${(q.y + r + 32).toFixed(1)}" text-anchor="middle">${p.live ? p.live + ' live' : 'offline'}${p.last ? ' · ' + ago(p.last) : ''}</text></g>`;
  }).join('');
  const ys = list.flatMap((p) => { const q = P.get('p:' + p.name), r = rad(p); return [q.y - r - 6, q.y + r + 40]; });
  const y0 = Math.floor(Math.min(...ys) - 8), y1 = Math.ceil(Math.max(...ys) + 8);
  graph.innerHTML = `<svg class="tg" viewBox="0 ${y0} ${W} ${y1 - y0}" role="group" aria-label="Project topology">${edgeH}${nodeH}</svg>`;
  bindGraphHover(graph.querySelector('svg'));
}
function renderAgentGraph() {
  const graph = $('#agentGraph');
  if (!graph || graph.contains(document.activeElement)) return;
  syncTopoBar();
  const M = topoModel(), teams = S.teams;
  if (!M.agents.length) { graph.innerHTML = none('ses', 'No agents'); renderTopoFeed(M, null); return; }
  if (TG_S.level === 'projects' && !TG_S.focus) { renderProjectGraph(graph, M); renderTopoFeed(M, null); fitTopoFeed(graph); return; }
  const scope = topoScope(M), { act, live } = M, edges = scope.edges;
  const agents = M.agents.filter((a) => scope.ids.has(a.id));
  const W = Math.max(graph.clientWidth, 320), H = Math.round(Math.min(Math.max(W * 0.62, 380), 620));
  const cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2 - 64, r = R * 0.42;
  // Order agents by their first team so members sit next to each other and edges cross less.
  const first = (a) => { const i = teams.findIndex((t) => (t.agent_ids || []).includes(a.id)); return i < 0 ? teams.length : i; };
  const ordered = agents.filter((a) => a.id !== scope.center).sort((x, y) => scope.ext.has(x.id) - scope.ext.has(y.id) || first(x) - first(y) || x.label.localeCompare(y.label));
  const P = new Map();
  if (scope.center) P.set(scope.center, { x: cx, y: cy, ang: Math.PI / 2 });
  ordered.forEach((a, i) => { const ang = -Math.PI / 2 + (2 * Math.PI * i) / ordered.length; P.set(a.id, { x: cx + R * Math.cos(ang), y: cy + R * Math.sin(ang), ang }); });
  const used = new Set(edges.map((e) => e.b));
  const hubs = [...teams.filter((t) => used.has('team:' + t.id)).map((t) => ['team:' + t.id, t]), ...[...M.rooms].filter(([id]) => used.has('room:' + id)).map(([id, name]) => ['room:' + id, { name }])];
  hubs.forEach(([id], i) => {
    if (hubs.length === 1 && !scope.center) { P.set(id, { x: cx, y: cy }); return; }
    // Place each hub toward the middle of its members, falling back to an inner ring.
    const mem = edges.filter((e) => e.b === id).map((e) => P.get(e.a)).filter(Boolean);
    const ang = -Math.PI / 2 + (2 * Math.PI * (i + 0.5)) / hubs.length;
    const mx = mem.length ? mem.reduce((s, p) => s + p.x, 0) / mem.length : cx + r * Math.cos(ang), my = mem.length ? mem.reduce((s, p) => s + p.y, 0) / mem.length : cy + r * Math.sin(ang);
    const k = scope.center ? 0.6 : 0.35, off = scope.center ? r * 0.6 : 18;
    P.set(id, { x: cx + (mx - cx) * k + Math.cos(ang) * off, y: cy + (my - cy) * k + Math.sin(ang) * off });
  });
  const path = (e) => {
    const p = P.get(e.a), q = P.get(e.b); if (!p || !q) return '';
    if (e.kind === 'team' || e.kind === 'room' || e.a === scope.center || e.b === scope.center) return `M${p.x.toFixed(1)} ${p.y.toFixed(1)}L${q.x.toFixed(1)} ${q.y.toFixed(1)}`;
    const mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2, k = e.kind === 'link' ? 0.35 : 0.55;
    return `M${p.x.toFixed(1)} ${p.y.toFixed(1)}Q${(mx + (cx - mx) * k).toFixed(1)} ${(my + (cy - my) * k).toFixed(1)} ${q.x.toFixed(1)} ${q.y.toFixed(1)}`;
  };
  const nameOf = (id) => (id.startsWith('team:') ? teams.find((t) => 'team:' + t.id === id)?.name : id.startsWith('room:') ? M.rooms.get(id.slice(5)) : agLabel(id));
  const tip = (e) => e.kind === 'team' ? `${nameOf(e.a)} · member of ${nameOf(e.b)}${e.last ? ' · team activity ' + ago(e.last) + ' ago' : ''}`
    : e.kind === 'link' ? `${nameOf(e.a)} ↔ ${nameOf(e.b)} · ${e.link.kind} link${e.link.grants_messaging ? ' · messaging allowed' : ''} · no messages in window`
    : `${nameOf(e.a)} ${e.kind === 'room' ? '→' : '↔'} ${nameOf(e.b)} · ${e.count} message${e.count === 1 ? '' : 's'} · last ${ago(e.last)} ago`;
  const edgeH = edges.map((e) => { const d = path(e); if (!d) return ''; const rc = e.kind === 'link' ? 'old' : recency(e.last);
    return `<g class="tg-eg" data-a="${esc(e.a)}" data-b="${esc(e.b)}"${e.room ? ` data-room="${esc(e.room)}"` : e.team ? ` data-team="${esc(e.team)}"` : ''}><title>${esc(tip(e))}</title>
      <path class="tg-e k-${e.kind} r-${rc}" d="${d}" style="stroke-width:${edgeWidth(e)}"/><path class="tg-hit" d="${d}"/></g>`; }).join('');
  const lblPos = (p, id) => {
    if (id === scope.center) return { x: p.x, y: p.y + 40, anchor: 'middle' };
    const c = Math.cos(p.ang), s = Math.sin(p.ang), d = 30; return { x: p.x + c * d, y: p.y + s * d + (s > 0.3 ? 8 : s < -0.3 ? -14 : -3), anchor: Math.abs(c) < 0.3 ? 'middle' : c > 0 ? 'start' : 'end' };
  };
  // Drill levels click into the agent; elsewhere a click opens the agent page. Outside agents open their own project.
  const click = (a) => (scope.ext.has(a.id) ? `data-tg-proj="${esc(M.proj.get(a.id))}"` : scope.drill ? `data-tg-agent="${esc(a.id)}"` : `data-ses="${esc(a.id)}"`);
  const agentH = [...(scope.center ? [M.agents.find((a) => a.id === scope.center)] : []), ...ordered].map((a) => {
    const p = P.get(a.id), st = act.get(a.id), rc = recency(st.last), l = lblPos(p, a.id), on = live.has(a.id), ext = scope.ext.has(a.id), big = a.id === scope.center;
    const sub = ext ? M.proj.get(a.id) : st.last ? `${st.tool} · ${ago(st.last)}` : on ? 'connected' : 'offline';
    const rr = big ? 26 : 19;
    return `<g class="tg-node tg-agent${on ? ' live' : ''}${ext ? ' ext' : ''}${big ? ' center' : ''} r-${rc}" data-n="${esc(a.id)}" ${click(a)} tabindex="0" role="button" aria-label="${esc(a.label)}">
      <title>${esc(a.label)}${a.role ? ' · ' + esc(a.role) : ''} · ${on ? 'live' : 'offline'}${ext ? ' · project ' + esc(M.proj.get(a.id)) + ' · click to open that project' : ''}${st.last ? ' · last call ' + esc(st.tool) + ' ' + ago(st.last) + ' ago' : ''}${st.denied ? ' · ' + st.denied + ' denied in 5m' : ''}${scope.drill ? ' · click to focus' : ''}</title>
      ${rc === 'act' && !ext ? `<circle class="halo" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${rr + 1}"/>` : ''}
      <circle class="core" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${rr}"/>
      <text class="ini" x="${p.x.toFixed(1)}" y="${p.y.toFixed(1)}" text-anchor="middle" dominant-baseline="central">${esc(initials(a.label))}</text>
      ${st.denied && !ext ? `<g class="tg-den"><circle cx="${(p.x + rr * 0.8).toFixed(1)}" cy="${(p.y - rr * 0.8).toFixed(1)}" r="8"/><text x="${(p.x + rr * 0.8).toFixed(1)}" y="${(p.y - rr * 0.8).toFixed(1)}" text-anchor="middle" dominant-baseline="central">${st.denied}</text></g>` : ''}
      <text class="tg-lbl" x="${l.x.toFixed(1)}" y="${l.y.toFixed(1)}" text-anchor="${l.anchor}">${esc(trunc(a.label, 24))}</text>
      <text class="tg-sub${!ext && st.result && st.result !== 'ok' && rc !== 'old' ? ' bad' : ''}" x="${l.x.toFixed(1)}" y="${(l.y + 14).toFixed(1)}" text-anchor="${l.anchor}">${esc(trunc(sub, 30))}</text></g>`;
  }).join('');
  const hubH = hubs.map(([id, t]) => {
    const p = P.get(id), isTeam = id.startsWith('team:'), busy = edges.some((e) => e.b === id && recency(e.last) === 'act');
    return `<g class="tg-node ${isTeam ? 'tg-team' : 'tg-room'}${busy ? ' busy' : ''}" data-n="${esc(id)}"${isTeam ? ` data-team="${esc(t.id)}"` : ` data-room="${esc(id.slice(5))}"`} tabindex="0" role="button" aria-label="${esc(t.name)}">
      <title>${esc(t.name)}${isTeam ? ' · ' + esc(t.status) + ' · ' + t.members + ' members · ' + tasksLabel(t.progress) : ' · group chat'}</title>
      <rect x="${(p.x - 21).toFixed(1)}" y="${(p.y - 21).toFixed(1)}" width="42" height="42" rx="12"/>
      <use href="#i-${isTeam ? 'team' : 'chat'}" x="${(p.x - 11).toFixed(1)}" y="${(p.y - 11).toFixed(1)}" width="22" height="22"/>
      <text class="tg-lbl" x="${p.x.toFixed(1)}" y="${(p.y + 37).toFixed(1)}" text-anchor="middle">${esc(trunc(t.name, 22))}</text>
      ${isTeam ? `<text class="tg-sub" x="${p.x.toFixed(1)}" y="${(p.y + 51).toFixed(1)}" text-anchor="middle">${esc(t.status)} · ${esc(tasksLabel(t.progress))}</text>` : ''}</g>`;
  }).join('');
  // Crop the drawing to its nodes and labels so the card is only as tall as the content.
  const ys = [];
  P.forEach((p, id) => { if (id.includes(':')) { ys.push(p.y - 24, p.y + 56); return; } const l = lblPos(p, id); ys.push(p.y - 30, l.y - 14, l.y + 18); });
  const y0 = Math.floor(Math.min(...ys) - 8), y1 = Math.ceil(Math.max(...ys) + 8);
  graph.innerHTML = `<svg class="tg" viewBox="0 ${y0} ${W} ${y1 - y0}" role="group" aria-label="Agent topology">${edgeH}${hubH}${agentH}</svg>`;
  bindGraphHover(graph.querySelector('svg'));
  renderTopoFeed(M, TG_S.focus ? new Set([...scope.ids].filter((id) => !scope.ext.has(id))) : null);
  fitTopoFeed(graph);
}
function fitTopoFeed(graph) {
  // Beside the graph, the feed scrolls within the graph height instead of stretching the card.
  const feed = $('#topoFeed'), side = getComputedStyle(graph.parentElement).gridTemplateColumns.split(' ').length > 1;
  if (feed) feed.style.maxHeight = side ? graph.offsetHeight + 'px' : '';
}
function renderTopoFeed(M, only) {
  const box = $('#topoFeed'); if (!box) return;
  const keyAgent = new Map(S.keys.map((k) => [k.id, k.agent_id])), now = Date.now(), inScope = (id) => id && (!only || only.has(id));
  const recent = S.inv.filter((i) => now - i.created_at < REC_MS && inScope(keyAgent.get(i.credential_id))), L = recent.slice(0, 14);
  const agents = M ? M.agents.filter((a) => inScope(a.id)) : [];
  const liveN = agents.filter((a) => M.live.has(a.id)).length, activeN = agents.filter((a) => recency(M.act.get(a.id).last) === 'act').length;
  box.innerHTML = `<div class="tg-kpis"><div><b>${liveN}</b><small>Live</small></div><div><b style="${activeN ? 'color:var(--ok-t)' : ''}">${activeN}</b><small>Active 30s</small></div><div><b>${recent.length}</b><small>Calls 5m</small></div></div>
    <h5 class="subh">Last 5 minutes</h5>` + (L.length ? L.map((i) => { const aid = keyAgent.get(i.credential_id);
      return `<button class="fe" data-ses="${esc(aid)}"><span class="dot${recency(i.created_at) === 'act' ? ' pulse' : ''}" style="background:${i.result === 'ok' ? 'var(--ok)' : 'var(--bad)'}"></span><span class="fe-main"><b>${esc(agLabel(aid))}</b><span class="mono">${esc(i.tool)}${i.result !== 'ok' ? ' · ' + esc(i.result) : ''}</span></span><span class="mono fe-age">${ago(i.created_at)}</span></button>`; }).join('') : none('pulse', 'Quiet'));
}
/* Level switch and breadcrumb live above the graph; they follow TG_S on every render. */
function syncTopoBar() {
  $$('#tgLevel button').forEach((b) => b.classList.toggle('on', b.dataset.level === TG_S.level));
  const crumb = $('#tgCrumb'); if (!crumb) return;
  const f = TG_S.focus; crumb.hidden = !f; if (!f) { crumb.innerHTML = ''; return; }
  const up = TG_S.level === 'agents' ? 'Agents' : TG_S.level === 'all' ? 'All' : 'Projects';
  crumb.innerHTML = `<button class="btn sm" data-tg-up>${ic('back')}${up}</button>${ic('chev', 'sep')}<b>${esc(f.kind === 'agent' ? agLabel(f.id) : f.id)}</b>${f.kind === 'agent' ? `<button class="btn sm" data-ses="${esc(f.id)}">${ic('user')}Open agent</button>` : ''}`;
}
function topoFocus(f) {
  setRoute('topology', f ? f.kind + ':' + f.id : '');
  // The graph skips redraws while it holds focus; a level change must redraw, so release focus first.
  if ($('#agentGraph')?.contains(document.activeElement)) document.activeElement.blur();
  TG_S.focus = f; TG_S.hover = null; renderAgentGraph(); window.scrollTo(0, 0);
}
VIEWS.topology = async (arg) => {
  if (typeof arg === 'string' && /^(project|agent):/.test(arg)) { const i = arg.indexOf(':'); TG_S.focus = { kind: arg.slice(0, i), id: arg.slice(i + 1) }; }
  S.convs = (await api('/conversations').catch(() => ({ conversations: S.convs }))).conversations;
  return {
    t: `${ic('hub')}Topology <span class="n">${S.agents.filter((a) => a.status !== 'archived').length}</span>`,
    a: `<button class="btn sm" data-go="tbuild">${ic('plus')}Team</button>`,
    b: vtools(`<div class="seg" id="tgLevel" role="group" aria-label="Level">${TGL.map(([k, l, icn]) => `<button data-level="${k}">${ic(icn)}${l}</button>`).join('')}</div>
        <div class="seg" id="tgWin" role="group" aria-label="Time window">${TGW.map(([l, ms]) => `<button data-ms="${ms}" class="${ms === TG_S.win ? 'on' : ''}">${l}</button>`).join('')}</div>
        <div class="row" id="tgLayers">${[['team', 'Teams', 'team'], ['msg', 'Messages', 'chat'], ['link', 'Links', 'link']].map(([k, l, icn]) => `<button class="tog${TG_S.layers[k] ? ' on' : ''}" data-layer="${k}">${ic(icn)}${l}</button>`).join('')}</div>
        <span class="tg-lg"><span><i class="tg-sw is-act"></i>Active 30s</span><span><i class="tg-sw is-msg"></i>Messages</span><span><i class="tg-sw is-team"></i>Team</span><span><i class="tg-sw is-link"></i>Link</span><span><i class="tg-sw is-den"></i>Denied 5m</span></span>`) +
      `<nav class="tg-crumb" id="tgCrumb" aria-label="Topology level" hidden></nav>` +
      `<div class="tg-wrap"><div id="agentGraph" class="agent-graph"></div><aside id="topoFeed" class="tg-feed" aria-label="Recent activity"></aside></div>`,
    after() {
      $('#tgLevel').onclick = (e) => { const b = e.target.closest('[data-level]'); if (!b) return; TG_S.level = b.dataset.level; try { localStorage.setItem('ah-topo-level', TG_S.level); } catch { /* ignore */ } topoFocus(null); };
      $('#tgWin').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; TG_S.win = +b.dataset.ms; $$('#tgWin button').forEach((x) => x.classList.toggle('on', x === b)); renderAgentGraph(); };
      $('#tgLayers').onclick = (e) => { const b = e.target.closest('[data-layer]'); if (!b) return; TG_S.layers[b.dataset.layer] = !TG_S.layers[b.dataset.layer]; b.classList.toggle('on'); renderAgentGraph(); };
      $('#tgCrumb').onclick = (e) => { if (e.target.closest('[data-tg-up]')) topoFocus(null); };
      // Drill-down clicks are handled here, before the page-wide handler would open an agent.
      $('#agentGraph').onclick = (e) => {
        const p = e.target.closest('[data-tg-proj]'), a = e.target.closest('[data-tg-agent]');
        if (p) { e.stopPropagation(); topoFocus({ kind: 'project', id: p.dataset.tgProj }); }
        else if (a) { e.stopPropagation(); topoFocus({ kind: 'agent', id: a.dataset.tgAgent }); }
      };
      renderAgentGraph();
    },
  };
};
const sesDot = (s) => `<span class="dot${s.live ? ' pulse' : ''}" style="background:${s.live ? 'var(--ok)' : 'var(--idle)'}"></span>`;
const sesRow = (s) => { const l = s.logins[0], lc = s.last_tool_call; return `<tr data-ses="${s.agent.id}" tabindex="0"><td><div class="nm">${sesDot(s)}${esc(s.agent.label)}${s.concurrent_use ? `<span class="chk w" title="Concurrent use">${ic('warn')}Shared</span>` : ''}</div></td><td class="pc">${l ? esc((l.pc?.name || '—') + ' · ' + (l.app || '—')) : '—'}</td><td>${s.agent.role ? `<span class="tag">${esc(s.agent.role)}</span>` : ''}</td><td class="hm mono">${lc ? esc(lc.tool) : '—'}${lc && lc.result !== 'ok' ? ` <span class="pill p-susp">${esc(lc.result)}</span>` : ''}</td><td class="r mono">${lc ? ago(lc.at) : '—'}</td></tr>`; };
function renderSes() {
  $('#sesN').textContent = S.ses.length;
  $('#sesT').innerHTML = S.ses.slice(0, 8).map(sesRow).join('') || `<tr><td>${none('ses', 'No sessions')}</td></tr>`;
}
const tasksLabel = (p) => (p.total ? `${p.done}/${p.total} tasks` : 'No tasks');
const teamRow = (t) => `<div class="trow" data-team="${t.id}" tabindex="0" role="button">
  <span class="ci" style="background:color-mix(in srgb,${TSTC[t.status]} 16%,transparent);color:${TSTC[t.status]}">${ic('team')}</span>
  <div class="trow-main"><div class="trow-top"><span class="tn">${esc(t.name)}</span>${tstat(t)}</div>${t.goal ? `<div class="trow-goal">${esc(t.goal)}</div>` : ''}</div>
  <div class="trow-meta"><span title="Members">${ic('user')}${t.members}</span>${t.stalled ? `<span class="chk w">${ic('clock')}${t.stalled} stalled</span>` : ''}
    <span class="trow-prog"><span>${tasksLabel(t.progress)}</span><span class="pb"><i style="width:${t.progress.pct}%;background:${TSTC[t.status]}"></i></span></span></div>
  ${ic('chev', 'trow-go')}</div>`;
function renderTeamsCard() {
  $('#tmN').textContent = S.teams.length;
  $('#tmCard').innerHTML = S.teams.slice(0, 6).map(teamRow).join('') || none('team', 'No teams');
}

VIEWS.sessions = async () => {
  const all = (await api('/sessions?all=1')).sessions.sort((a, b) => b.live - a.live || (b.agent.last_seen_at || 0) - (a.agent.last_seen_at || 0));
  return {
    t: `${ic('user')}Sessions <span class="n">${all.length}</span>`,
    b: vtools(`<div class="seg" id="sF" role="group" aria-label="Filter"><button class="on" data-f="">All</button><button data-f="1">Live</button></div>`) + `<div class="tscroll"><table class="tbl"><thead><tr><th>Agent</th><th class="pc">PC · App</th><th>Role</th><th class="hm">Last call</th><th class="r">Seen</th></tr></thead><tbody id="sB"></tbody></table></div>`,
    after() {
      const draw = (f) => { $('#sB').innerHTML = all.filter((s) => !f || s.live).map(sesRow).join('') || `<tr><td colspan="5">${none('user', 'No sessions')}</td></tr>`; };
      draw(''); tick($('#sF'), (b) => draw(b.dataset.f));
    },
  };
};

const SES_TABS = [['overview', 'Overview', 'user'], ['keys', 'Keys', 'key'], ['teams', 'Teams', 'team'], ['chats', 'Chats', 'chat'], ['links', 'Links', 'link'], ['activity', 'Activity', 'pulse']];
VIEWS.ses = async (arg) => {
  const [id, tab0] = String(arg).split('|'), tab = SES_TABS.some(([k]) => k === tab0) ? tab0 : 'overview';
  const [d, lkr, conversations, teams] = await Promise.all([api('/sessions/' + id), api('/links?agent=' + id), api('/conversations'), api('/teams')]);
  const a = d.agent, LK = lkr.links, others = S.agents.filter((x) => x.id !== id && x.status !== 'archived');
  const chats = conversations.conversations.filter(room => room.members.some(member => member.agent_id === id));
  const groups = teams.teams.filter(team => team.agent_ids.includes(id));
  const sk = [...new Set(d.logins.map((l) => l.session_key_id).filter(Boolean))];
  const lc = d.last_tool_call;
  const counts = { keys: d.session_keys.length, teams: groups.length, chats: chats.length, links: LK.length, activity: d.recent_files.length + d.invocations.length };
  const bar = `<button class="btn ic" data-ctx-back aria-label="Back">${ic('back')}</button>
    <h2 id="ctxTitle">${sesDot(d)}<span class="ctx-name">${esc(a.label)}</span>${a.role ? `<span class="tag">${esc(a.role)}</span>` : ''}</h2>
    <nav class="seg ws-tabs" aria-label="Agent sections">${SES_TABS.map(([k, l, icn]) => `<button data-ses-tab="${id}|${k}" class="${k === tab ? 'on' : ''}"${k === tab ? ' aria-current="page"' : ''}>${ic(icn)}${l}${counts[k] ? `<span class="tabn">${counts[k]}</span>` : ''}</button>`).join('')}</nav>`;
  const tbl = (head, rows, empty) => rows.length ? `<div class="tscroll"><table class="tbl"><thead><tr>${head.map((h, i) => `<th${i === head.length - 1 ? ' class="r"' : ''}>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>` : empty;
  const V = {
    overview: () => ({
      t: `${ic('user')}Overview`,
      a: `<button class="btn sm bad" id="sArc">${ic('trash')}Archive</button>`,
      b: `<div class="tstats">
          <div class="tstat"><small>Status</small><b style="font-size:18px">${d.live ? 'Live' : 'Idle'}</b><span class="sub">Seen ${ago(lc ? lc.at : a.last_seen_at)} ago</span></div>
          <div class="tstat"><small>Last call</small><b class="mono" style="font-size:14px;overflow:hidden;text-overflow:ellipsis">${lc ? esc(lc.tool) : '—'}</b><span class="sub" style="${lc && lc.result !== 'ok' ? 'color:var(--bad-t)' : ''}">${lc ? esc(lc.result) : 'No calls'}</span></div>
          <div class="tstat"><small>Logins</small><b>${d.logins.length}</b><span class="sub">${d.concurrent_use ? 'Shared by several clients' : d.logins.length ? 'Connected' : 'Not connected'}</span></div>
        </div>` +
        ((a.model_label || a.project || a.status_text) ? `<div class="wrap">${a.model_label ? `<span class="tag">${esc(a.model_label)}</span>` : ''}${a.project ? `<span class="tag">${esc(a.project)}</span>` : ''}${a.status_text ? `<span class="tag">${esc(a.status_text)}</span>` : ''}</div>` : '') +
        sec('Logins', tbl(['PC · App', 'Last used'], d.logins.map((l) => `<tr><td><div class="nm"><span class="dot" style="background:var(--ok)"></span>${esc((l.pc?.name || '—') + ' · ' + (l.app || '—'))}</div></td><td class="r mono">${ago(l.last_used_at)}</td></tr>`), none('pc', 'No logins')),
          `<span style="margin-left:auto"><button class="btn sm" id="sEnd"${sk.length ? '' : ' disabled'}>${ic('out')}End all</button></span>`) +
        sec('Role', `<div class="grid2"><label class="fld"><span class="vlabel">Role</span><input class="inp" id="sRole" value="${esc(a.role || '')}" maxlength="80"></label><label class="fld"><span class="vlabel">Details</span><input class="inp" id="sRoleDetail" value="${esc(a.role_detail || '')}" maxlength="500"></label></div><div style="margin-top:10px"><button class="btn sm" id="sRoleGo">${ic('check')}Save role</button></div>`),
    }),
    keys: () => ({
      t: `${ic('key')}Keys <span class="n">${counts.keys}</span>`,
      b: tbl(['Key', 'Status', 'Seen'], d.session_keys.map((k) => `<tr data-key="${k.id}" tabindex="0"><td><div class="nm">${ic('key')}${esc(k.label)}</div></td><td><span class="pill ${k.status === 'active' ? 'p-live' : k.status === 'suspended' ? 'p-susp' : 'p-idle'}">${esc(k.status)}</span></td><td class="r mono">${ago(k.last_used_at)}</td></tr>`), none('key', 'No keys')),
    }),
    teams: () => ({
      t: `${ic('team')}Teams <span class="n">${counts.teams}</span>`,
      b: `<div class="tlist">${groups.map(teamRow).join('') || none('team', 'No teams')}</div>`,
    }),
    chats: () => ({
      t: `${ic('chat')}Chats <span class="n">${counts.chats}</span>`,
      b: vtools(subTabs('data-chat-kind', [['', 'All'], ['direct', 'Direct'], ['group', 'Group']], '')) + `<div id="sesChats">${chats.map(convRow).join('') || none('chat', 'No chats')}</div>`,
    }),
    links: () => ({
      t: `${ic('link')}Links <span class="n">${counts.links}</span>`,
      b: tbl(['Agent', 'Direction', 'Kind', 'Messaging', ''], LK.map((l) => { const out = l.from_agent_id === id, o = out ? l.to_agent_id : l.from_agent_id; return `<tr><td><button class="mem-name" data-ses="${o}">${esc(agLabel(o))}</button></td><td>${out ? 'Outgoing' : 'Incoming'}</td><td><span class="tag">${esc(l.kind)}</span></td><td><button class="tog${l.grants_messaging ? ' on' : ''}" style="height:26px" data-lm="${l.id}" data-on="${l.grants_messaging ? 0 : 1}">${ic('chat')}${l.grants_messaging ? 'On' : 'Off'}</button></td><td class="r"><button class="btn ic sm" data-ld="${l.id}" aria-label="Remove link">${ic('x')}</button></td></tr>`; }), none('link', 'No links')) +
        `<div class="radd"><select class="sel" id="lA" aria-label="Agent">${others.map((x) => `<option value="${x.id}">${esc(x.label)}</option>`).join('')}</select><input class="inp" id="lK" value="peer" maxlength="40" aria-label="Kind"><button class="tog" id="lM" style="height:30px">${ic('chat')}Messaging</button><button class="btn sm" id="lAdd">${ic('plus')}Add link</button></div>`,
    }),
    activity: () => ({
      t: `${ic('pulse')}Activity`,
      b: sec('Files', tbl(['Action', 'Path', 'Result', 'Age'], d.recent_files.map((f) => `<tr><td><span class="tag">${esc(ACTN[f.action] || f.action.replace('fs.', ''))}</span></td><td class="mono" style="white-space:normal;word-break:break-all">${esc(f.path)}</td><td>${effPill(f.decision)}</td><td class="r mono">${ago(f.created_at)}</td></tr>`), none('file', 'No file activity'))) +
        sec('Calls', tbl(['Tool', 'Result', 'Age'], d.invocations.slice(0, 30).map((i) => `<tr><td class="mono">${esc(i.tool)}</td><td><span class="pill ${i.result === 'ok' ? 'p-live' : 'p-susp'}">${esc(i.result)}</span></td><td class="r mono">${ago(i.created_at)}</td></tr>`), none('bolt', 'No calls'))),
    }),
  };
  const v = V[tab]();
  return {
    ...v, bar,
    after() {
      const re = () => openD('ses', id + '|' + tab, true);
      const on = (sel, fn) => { const e = $(sel); if (e) e.onclick = fn; };
      on('#sEnd', () => run(async () => { for (const k of sk) await post(`/keys/${k}/end-logins`); toast('Ended'); await refresh(); re(); }));
      on('#sRoleGo', () => run(async () => { await api('/agents/' + id, 'PATCH', { role: $('#sRole').value.trim() || null, role_detail: $('#sRoleDetail').value.trim() || null }); toast('Saved'); await refresh(); re(); }));
      on('#lM', () => $('#lM').classList.toggle('on'));
      on('#lAdd', () => run(async () => { const to = $('#lA').value, kind = $('#lK').value.trim(); if (!to || !kind) return toast('Link', true); await post('/links', { from_agent_id: id, to_agent_id: to, kind, grants_messaging: $('#lM').classList.contains('on') }); re(); }));
      $$('[data-ld]').forEach((b) => (b.onclick = () => run(async () => { await api('/links/' + b.dataset.ld, 'DELETE'); re(); })));
      $$('[data-lm]').forEach((b) => (b.onclick = () => run(async () => { await api('/links/' + b.dataset.lm, 'PATCH', { grants_messaging: b.dataset.on === '1' }); re(); })));
      $$('[data-chat-kind]').forEach((b) => (b.onclick = () => {
        $$('[data-chat-kind]').forEach((x) => x.classList.toggle('on', x === b));
        const k = b.dataset.chatKind, L = chats.filter((r) => !k || (r.kind === 'direct') === (k === 'direct'));
        $('#sesChats').innerHTML = L.map(convRow).join('') || none('chat', 'No chats');
      }));
      if ($('#sArc')) arm($('#sArc'), () => run(async () => { await post(`/sessions/${id}/archive`); toast('Archived'); closeD(); refresh(); }));
    },
  };
};

const SETUP = {};
VIEWS.pcs = async () => {
  const apps = S.keys.filter((k) => k.kind === 'app_key' && k.status !== 'revoked');
  const fi = { approved: ['check', 'var(--ok-t)'], rejected: ['x', 'var(--bad-t)'], proposed: ['clock', 'var(--warn-t)'] };
  return {
    t: `${ic('pc')}PCs <span class="n">${S.pcs.length}</span>`,
    a: `<button class="btn sm" data-go="app">${ic('plus')}App</button>`,
    b: S.pcs.length ? S.pcs.map((p) => {
      const as = apps.filter((a) => a.machine_id === p.id), n = as.reduce((x, a) => x + (a.live_logins || 0), 0), on = p.status === 'active', br = p.bridge || {};
      const bp = br.online ? '<span class="pill p-live">Online</span>' : br.paired ? '<span class="pill p-block">Offline</span>' : '<span class="pill p-idle">Unpaired</span>';
      const su = SETUP[p.id];
      return `<div class="mini" style="display:flex;flex-direction:column;gap:10px;padding:12px;margin-bottom:12px"><div class="row" style="flex-wrap:nowrap"><span class="dot" style="background:${on ? 'var(--ok)' : 'var(--bad)'}"></span><b style="flex:1;overflow:hidden;text-overflow:ellipsis">${esc(p.name)}</b>${bp}${br.os ? `<span class="tag">${esc(br.os)}</span>` : ''}${br.version ? `<span class="tag">${esc(br.version)}</span>` : ''}<span class="tag">${n ? '×' + n : '—'}</span></div>
        <div class="wrap">${as.map((a) => `<button class="tag" data-key="${a.id}" style="cursor:pointer">${esc(a.app_name)}</button>`).join('')}</div>
        ${(p.folders || []).map((f) => { const m = fi[f.status] || fi.proposed; return `<div class="rl"><span style="color:${m[1]};display:flex">${ic(m[0])}</span><span class="mono" title="${esc(f.path)}">${esc(f.path)}</span>${f.status === 'proposed' ? `<button class="btn ic sm ok" data-fd="approve" data-p="${p.id}" data-path="${esc(f.path)}" aria-label="Approve">${ic('check')}</button><button class="btn ic sm bad" data-fd="reject" data-p="${p.id}" data-path="${esc(f.path)}" aria-label="Reject">${ic('x')}</button>` : ''}</div>`; }).join('')}
        <div class="row"><button class="btn sm" data-setup="${p.id}">${ic('key')}Setup</button><button class="btn sm ${on ? 'bad' : 'ok'}" data-pcs="${p.id}" data-on="${on ? 0 : 1}">${ic(on ? 'pause' : 'play')}${on ? 'Suspend' : 'Resume'}</button><button class="btn sm" data-go="app" data-arg="${p.id}" aria-label="App">${ic('plus')}</button></div>
        ${su ? codeBox(su.message) + `<span class="tag" style="align-self:flex-start">${ic('clock')} ${Math.max(0, Math.round((su.exp - Date.now()) / 60000))}m</span>` : ''}</div>`;
    }).join('') : none('pc', 'No PCs'),
    after() {
      const re = async () => { await refresh(); openD('pcs', null, true); };
      $$('[data-pcs]').forEach((b) => (b.onclick = () => run(async () => { await post(`/pcs/${b.dataset.pcs}/${b.dataset.on === '1' ? 'reactivate' : 'suspend'}`); re(); })));
      $$('[data-setup]').forEach((b) => (b.onclick = () => run(async () => { const r = await post(`/pcs/${b.dataset.setup}/setup`); SETUP[b.dataset.setup] = { message: r.setup_message, exp: r.expires_at }; re(); })));
      $$('[data-fd]').forEach((b) => (b.onclick = () => run(async () => { await post(`/pcs/${b.dataset.p}/folders/${encodeURIComponent(b.dataset.path)}/${b.dataset.fd}`); re(); })));
    },
  };
};

VIEWS.teams = async () => ({
  t: `${ic('team')}Teams <span class="n">${S.teams.length}</span>`,
  a: `<button class="btn sm" data-go="tbuild">${ic('plus')}Team</button>`,
  b: `<div class="tlist">${S.teams.map(teamRow).join('') || none('team', 'No teams')}</div>`,
});

VIEWS.team = async (id) => {
  const t = (await api('/teams/' + id)).team, nm = (aid) => t.members.find((m) => m.agent_id === aid)?.label || agLabel(aid);
  const awaiting = t.board.filter((k) => k.awaiting_approval).length, stalled = t.members.filter((m) => m.stalled).length;
  const tk = (k, main) => `<div class="tk${k.awaiting_approval ? ' aw' : ''}"><div class="tt">${esc(k.title)}</div>
    <div class="tk-meta">${k.assignee ? `<span class="who">${ic('user')}${esc(nm(k.assignee))}</span>` : '<span class="who">Unassigned</span>'}${k.status !== main ? `<span class="tag" style="color:${TCOL[k.status]}">${esc(k.status.replace('_', ' '))}</span>` : ''}${k.review_rounds ? `<span class="tag">Round ${k.review_rounds}</span>` : ''}${k.awaiting_approval ? `<button class="btn sm ok" data-appr="${k.id}">${ic('check')}Approve</button>` : ''}</div>
    ${k.blocked_reason ? `<div class="tk-block">${ic('warn')}${esc(k.blocked_reason)}</div>` : ''}</div>`;
  const act = (cls, ico, lbl, p) => `<button class="btn sm ${cls}" data-ta="${p}">${ic(ico)}${lbl}</button>`;
  const limits = Object.entries(t.limits || {}).map(([k, v]) => {
    const u = t.usage?.[k] ?? t.usage?.[k.replace('_per_hour', '')] ?? 0;
    return `<div class="lim"><span>${esc(k.replace(/_per_hour|_bytes/g, '').replace(/_/g, ' '))}</span><span class="pb"><i style="width:${Math.min(100, Math.round((u / v) * 100))}%"></i></span><span class="mono">${u}/${v}</span></div>`;
  }).join('');
  const parts = Object.entries(t.counts).filter(([k, v]) => v && k !== 'cancelled');
  const board = t.board.length ? `<div class="board">${COLS.map(([l, sts]) => {
    const L = t.board.filter((k) => sts.includes(k.status)).sort((a, b) => b.awaiting_approval - a.awaiting_approval);
    return `<div class="bc"><h5><i style="background:${TCOL[sts[0]]}"></i>${l}<span>${L.length}</span></h5>${L.map((k) => tk(k, sts[0])).join('') || '<div class="bc-empty">—</div>'}</div>`;
  }).join('')}</div>` : none('note', 'No tasks yet');
  const member = (m) => `<div class="mem">
    <span class="mav">${esc((m.label || m.agent_id || '?')[0].toUpperCase())}<span class="dot" style="background:${m.stalled ? 'var(--warn)' : 'var(--ok)'}"></span></span>
    <div style="min-width:0"><button class="mem-name" data-ses="${m.agent_id}">${esc(m.label || m.agent_id)}</button><div class="mem-sub">${esc(m.role)}</div></div>
    <div class="mem-side">${m.stalled ? `<span class="chk w">${ic('clock')}Stalled</span>` : ''}${m.pending_items ? `<span>${m.pending_items} pending</span>` : ''}<span>Active ${ago(m.last_activity_at)} ago</span><button class="btn sm" data-hand="${m.agent_id}">${ic('copy')}Handoff</button></div></div>`;
  return {
    t: `${ic('team')}<span style="overflow:hidden;text-overflow:ellipsis">${esc(t.name)}</span>${tstat(t)}`,
    a: `${t.status === 'draft' ? act('ok', 'play', 'Start', 'start') : ''}${t.status === 'running' ? act('', 'pause', 'Pause', 'pause') : ''}${t.status === 'paused' ? act('ok', 'play', 'Resume', 'resume') : ''}${t.room_id ? `<button class="btn sm" data-room="${t.room_id}">${ic('chat')}Chat</button>` : ''}${['draft', 'running', 'paused'].includes(t.status) ? `<button class="btn sm bad" id="tStop">${ic('stop')}Stop</button>` : ''}`,
    b: `<div class="team-head"><p class="team-goal">${esc(t.goal)}</p>
        <div class="wrap">${t.paused_reason ? `<span class="chk w">${ic('pause')}${esc(t.paused_reason)}</span>` : ''}<span class="chk${t.grant_messaging ? ' y' : ''}">${ic('chat')}Messaging ${t.grant_messaging ? 'on' : 'off'}</span>${t.checkpoints?.length ? `<span class="chk y">${ic('shield')}Approval before done</span>` : ''}${(t.warnings || []).map((w) => `<span class="chk w">${ic('warn')}${esc(w.label)} · ${esc(w.app_name)}</span>`).join('')}</div></div>` +
      `<div class="tstats">
        <div class="tstat"><small>Progress</small><b>${t.progress.pct}%</b><div class="sbar">${parts.map(([k, v]) => `<i style="flex:${v};background:${TCOL[k]}"></i>`).join('')}</div><span class="sub">${tasksLabel(t.progress)}</span></div>
        <div class="tstat"><small>Members</small><b>${t.members.length}</b><span class="sub" style="${stalled ? 'color:var(--warn-t)' : ''}">${stalled ? stalled + ' stalled' : 'All active'}</span></div>
        <div class="tstat"><small>Awaiting approval</small><b style="${awaiting ? 'color:var(--warn-t)' : ''}">${awaiting}</b><span class="sub">${awaiting ? 'Review on the board' : 'Nothing waiting'}</span></div>
        <div class="tstat"><small>Hourly limits</small>${limits || '<span class="sub">No limits</span>'}</div>
      </div>` +
      sec('Board', board) +
      sec('Members', `<div>${t.members.map(member).join('')}</div>`),
    after() {
      $$('[data-ta]').forEach((b) => (b.onclick = () => run(async () => { await post(`/teams/${id}/${b.dataset.ta}`); await refresh(); openD('team', id, true); })));
      if ($('#tStop')) arm($('#tStop'), () => run(async () => { await post(`/teams/${id}/stop`); await refresh(); openD('team', id, true); }));
      $$('[data-appr]').forEach((b) => (b.onclick = () => run(async () => { await post(`/teams/${id}/tasks/${b.dataset.appr}/approve`); toast('Approved'); await refresh(); openD('team', id, true); })));
      $$('[data-hand]').forEach((b) => (b.onclick = () => run(async () => { const h = await api(`/teams/${id}/handoff`); const m = h.messages.find((x) => x.agent_id === b.dataset.hand); if (m) copy(m.text); })));
    },
  };
};

VIEWS.tbuild = async () => {
  const ag = S.agents.filter((a) => a.status !== 'archived' && a.status !== 'revoked'), RL = ['coordinator', 'worker', 'reviewer', 'stakeholder'];
  const lim = [['tasks_per_hour', 'Tasks/h'], ['messages_per_hour', 'Msgs/h'], ['writes_per_hour', 'Writes/h']];
  return {
    t: `${ic('team')}Team`,
    b: sec('Name', `<input class="inp" id="bN" maxlength="80" autocomplete="off" aria-label="Name">`) +
      sec('Goal', `<textarea class="inp" id="bG" rows="3" maxlength="4000" aria-label="Goal" style="height:auto;padding:10px 12px;resize:vertical"></textarea>`) +
      sec('Members', `<div id="bM">${ag.map((a, i) => `<div class="rl mrow" data-a="${a.id}"><input type="checkbox" aria-label="${esc(a.label)}"><span class="mono">${esc(a.label)}</span><select class="sel" aria-label="Role">${RL.map((r) => `<option${r === (i === 0 ? 'coordinator' : 'worker') ? ' selected' : ''}>${r}</option>`).join('')}</select></div>`).join('') || none('ses', 'No agents')}</div>`) +
      sec('Limits', `<div class="row">${lim.map(([k, l]) => `<input class="inp" data-lim="${k}" type="number" min="1" placeholder="${l}" aria-label="${l}" style="width:100px;height:34px">`).join('')}</div>`) +
      `<div class="row"><button class="tog on" id="bMsg">${ic('chat')}Messaging</button><button class="tog" id="bCp">${ic('shield')}Checkpoint</button></div>` +
      `<div><button class="btn pri" id="bGo" style="height:40px;padding:0 18px">${ic('team')}Create</button></div>`,
    after() {
      $('#bMsg').onclick = () => $('#bMsg').classList.toggle('on'); $('#bCp').onclick = () => $('#bCp').classList.toggle('on');
      $('#bGo').onclick = () => run(async () => {
        const name = $('#bN').value.trim(), goal = $('#bG').value.trim();
        if (!name) { $('#bN').focus(); return toast('Name', true); }
        if (!goal) { $('#bG').focus(); return toast('Goal', true); }
        const members = $$('#bM .mrow').filter((r) => r.querySelector('input').checked).map((r) => {
          const aid = r.dataset.a, ck = S.keys.filter((k) => k.kind === 'session_key' && k.agent_id === aid && k.effective_status === 'active').sort((x, y) => y.created_at - x.created_at)[0];
          return { agent_id: aid, role: r.querySelector('select').value, ...(ck ? { credential_id: ck.id } : {}) };
        });
        if (!members.length) return toast('Members', true);
        const limits = {}; $$('[data-lim]').forEach((i) => { if (+i.value > 0) limits[i.dataset.lim] = Math.floor(+i.value); });
        const r = await post('/teams', { name, goal, members, grant_messaging: $('#bMsg').classList.contains('on'), ...(Object.keys(limits).length ? { limits } : {}), ...($('#bCp').classList.contains('on') ? { checkpoints: ['done'] } : {}) });
        await refresh(); openD('team', r.team.id, false, true);
      });
    },
  };
};

/* ---------- conversations ---------- */
const convRow = (c) => `<div class="cv" data-room="${c.id}" tabindex="0" role="button"><span class="ci">${ic(c.kind === 'direct' ? 'user' : 'team')}</span><div style="min-width:0;flex:1"><div class="tn">${esc(c.name || c.id)}</div><div class="ts mono">${c.last_message ? esc(trunc(c.last_message.content.replace(/\s+/g, ' '), 70)) : '—'}</div></div><div class="cr"><span class="tag">${c.message_count}</span><span class="mono" style="color:var(--faint);font-size:11px">${ago(c.last_message?.created_at || c.created_at)}</span></div></div>`;
VIEWS.chats = async () => {
  S.convs = (await api('/conversations')).conversations;
  return {
    t: `${ic('chat')}Chats <span class="n">${S.convs.length}</span>`,
    b: vtools(`<div class="srch">${ic('search')}<input class="inp" id="cQ" aria-label="Search" placeholder="Search" autocomplete="off"></div>
      <select class="sel" id="chatKind" aria-label="Conversation type"><option value="">All chats</option><option value="direct">Direct</option><option value="group">Group</option></select>`) + `<div id="cL"></div>`,
    after() {
      const search = $('#cQ'), kind = $('#chatKind'), list = $('#cL');
      let timer, request = 0;
      const draw = async () => {
        const current = ++request, q = search.value.trim();
        const rooms = S.convs.filter(room => !kind.value || (room.kind === 'direct') === (kind.value === 'direct'));
        const empty = none('chat', 'No chats');
        if (!q) { list.innerHTML = rooms.map(convRow).join('') || empty; return; }
        const r = (await api('/messages/search?q=' + encodeURIComponent(q))).messages;
        if (current !== request || !list.isConnected) return;
        const byId = new Map(rooms.map(room => [room.id, room]));
        list.innerHTML = r.filter(m => byId.has(m.room_id)).map(m => `<div class="cv" data-room="${m.room_id}" tabindex="0" role="button"><span class="ci">${ic('chat')}</span><div style="min-width:0;flex:1"><div class="tn">${esc(byId.get(m.room_id).name || m.room_id)} <span class="tag">${esc(agLabel(m.from))}</span></div><div class="ts mono">${esc(trunc(m.content.replace(/\s+/g, ' '), 100))}</div></div><span class="mono" style="color:var(--faint);font-size:11px">${ago(m.created_at)}</span></div>`).join('') || empty;
      };
      search.oninput = () => { ++request; clearTimeout(timer); timer = setTimeout(() => run(draw), 300); };
      kind.onchange = () => { clearTimeout(timer); run(draw); };
      draw();
    },
  };
};

const RM_ = { id: null, msgs: new Map(), room: null, more: false, before: null };
function drawRoom(stick) {
  const L = $('#rmL'); if (!L) return;
  const near = stick || L.scrollHeight - L.scrollTop - L.clientHeight < 80, nm = (m) => RM_.room?.members.find((x) => x.agent_id === m.from)?.label || agLabel(m.from);
  const ms = [...RM_.msgs.values()].sort((a, b) => a.seq - b.seq);
  L.innerHTML = (RM_.more ? `<button class="btn sm" id="rmMore" style="align-self:center" aria-label="Older">${ic('up')}</button>` : '') + (ms.map((m) => `<div class="msg${m.from === 'hub' ? ' hub' : ''}"><div class="mh"><b>${esc(nm(m))}</b>${m.kind !== 'text' ? `<span class="tag">${esc(m.kind)}</span>` : ''}<span>${ago(m.created_at)}</span></div><div class="mb">${m.redacted ? ic('ban') : esc(m.content)}</div></div>`).join('') || none('chat', 'No messages'));
  if (near) L.scrollTop = L.scrollHeight;
  const mo = $('#rmMore'); if (mo) mo.onclick = () => run(async () => { const r = await api(`/conversations/${RM_.id}/messages?limit=50&before=${RM_.before}`); r.messages.forEach((m) => RM_.msgs.set(m.seq, m)); RM_.more = r.more; RM_.before = r.next_before; const h = L.scrollHeight; drawRoom(false); L.scrollTop = L.scrollHeight - h; });
}
async function pollRoom() {
  if (DR.type !== 'room' || document.hidden) return;
  try { const id = DR.arg, r = await api(`/conversations/${id}/messages?limit=50`); if (RM_.id !== id || DR.arg !== id) return; r.messages.forEach((m) => RM_.msgs.set(m.seq, m)); RM_.room = r.room; drawRoom(false); } catch { /* ignore */ }
}
setInterval(pollRoom, 3000);
VIEWS.room = async (id) => {
  const r = await api(`/conversations/${id}/messages?limit=50`);
  Object.assign(RM_, { id, msgs: new Map(r.messages.map((m) => [m.seq, m])), room: r.room, more: r.more, before: r.next_before });
  return {
    t: `${ic(r.room.kind === 'direct' ? 'user' : 'team')}<span style="overflow:hidden;text-overflow:ellipsis">${esc(r.room.name || id)}</span><span class="n">${r.room.message_count}</span>`,
    a: `<a class="btn sm" href="/api/conversations/${encodeURIComponent(id)}/export" download>${ic('dl')}Export</a>`,
    b: `<div class="wrap">${r.room.members.map((m) => `<span class="tag" ${m.agent_id ? `data-ses="${m.agent_id}" style="cursor:pointer"` : ''}>${esc(m.label || m.agent_id)}</span>`).join('')}</div><div class="msgs" id="rmL"></div>`,
    after() { drawRoom(true); },
  };
};

/* ---------- account menu: opens beside the avatar that was clicked ---------- */
async function signOut() { await post('/logout'); S.me = null; csrf = ''; closeMe(); closeD(); showLogin(); }
function closeMe() {
  const m = $('#meMenu'); if (m.hidden) return;
  m.hidden = true; $$('[data-me]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
}
function openMe(btn) {
  const m = $('#meMenu'), me = S.me;
  m.innerHTML = `<div class="me-head"><span class="av">${esc((me.username[0] || 'A').toUpperCase())}</span><span><b>${esc(me.username)}</b><small>Administrator</small></span></div>
    <button role="menuitem" data-mi="account">${ic(me.totp_enrolled ? 'check' : 'lock')}<span>${me.totp_enrolled ? 'Two-factor is on' : 'Set up two-factor'}</span>${me.totp_enrolled ? '' : '<i class="me-dot"></i>'}</button>
    <button role="menuitem" data-mi="shortcuts">${ic('kbd')}<span>Keyboard shortcuts</span><span class="kbd">?</span></button>
    <hr><button role="menuitem" class="bad" data-mi="out">${ic('out')}<span>Sign out</span></button>`;
  m.hidden = false;
  const r = btn.getBoundingClientRect(), mr = m.getBoundingClientRect();
  if (btn.closest('.side')) { m.style.left = r.right + 8 + 'px'; m.style.top = Math.max(8, r.bottom - mr.height) + 'px'; }
  else { m.style.left = Math.max(8, r.right - mr.width) + 'px'; m.style.top = r.bottom + 8 + 'px'; }
  btn.setAttribute('aria-expanded', 'true');
  m.querySelector('[role=menuitem]').focus();
}
$('#meMenu').addEventListener('keydown', (e) => {
  const items = $$('#meMenu [role=menuitem]'), i = items.indexOf(document.activeElement);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus(); }
});

/* ---------- login / boot ---------- */
function showLogin() {
  $('#login').hidden = false; $('#app').hidden = true; $('.side').style.display = 'none'; $('.bnav').style.display = 'none';
  $('#overview').dataset.mode = 'home';
  closeD();
  setTimeout(() => $('#lu').focus(), 30);
}
async function enter(me) {
  S.me = me; csrf = me.csrf; $('#login').hidden = true; $('#app').hidden = false; $('.side').style.display = ''; $('.bnav').style.display = '';
  $$('[data-av]').forEach((el) => { el.textContent = (me.username[0] || 'A').toUpperCase(); });
  await refresh();
  restoreRoute();
}
$('#lf').onsubmit = async (e) => {
  e.preventDefault(); $('#le').textContent = '';
  try {
    const r = await api('/login', 'POST', { username: $('#lu').value, password: $('#lp').value, ...($('#lt').hidden ? {} : { totp: $('#lt').value.trim() }) });
    csrf = r.csrf; $('#lp').value = ''; $('#lt').value = ''; $('#lt').hidden = true;
    const me = await api('/me'); await enter(me);
  } catch (er) {
    if (er.code === 'mfa_required') { $('#lt').hidden = false; $('#lt').focus(); return; }
    $('#le').textContent = { invalid_credentials: 'Invalid', mfa_failed: 'Wrong code', rate_limited: 'Locked' }[er.code] || er.message;
  }
};

/* ---------- phase 4/5: urgent items, lockdown, vault, requests, shares ---------- */
const fmtB = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + 'M' : n >= 1024 ? Math.round(n / 1024) + 'K' : (n || 0) + 'B');
const fmtD = (s) => (!s ? '·' : s >= 86400 ? Math.round(s / 86400) + 'd' : s >= 3600 ? Math.round(s / 3600) + 'h' : s >= 60 ? Math.round(s / 60) + 'm' : s + 's');
const left = (t) => { const d = Math.max(0, (t - Date.now()) / 1000); return d < 60 ? Math.floor(d) + 's' : d < 3600 ? Math.floor(d / 60) + 'm' : d < 86400 ? Math.floor(d / 3600) + 'h' : Math.floor(d / 86400) + 'd'; };
const rv = (r) => (r === 'absent' || !r ? '∅' : String(r).replace(/^\w+[:-]/, '').slice(0, 8));
const tagH = (s, x = '') => `<span class="tag ${x}">${s}</span>`;
const stPill = (s) => `<span class="pill ${{ open: 'p-live', done: 'p-live', approved: 'p-live', partially_approved: 'p-live', closed: 'p-idle', revoked: 'p-susp', denied: 'p-susp', failed: 'p-susp', expired: 'p-idle', withdrawn: 'p-idle', offered: 'p-block', pending: 'p-block' }[s] || 'p-idle'}">${esc(s.replace('_', ' '))}</span>`;
const reopen = () => DR.type && openD(DR.type, DR.arg, true);

function urgent() {
  const L = openAlerts().map((a) => { const b = alertBits(a), s = SEV[a.severity]; return { id: a.id, s, r: s === 'crit' ? 0 : s === 'warn' ? 2 : 4, ts: a.created_at, ico: b.t[1], ttl: b.t[0], who: b.who, sub: b.sub, acts: b.acts, chip: a.severity !== 'info', age: 1 }; });
  for (const q of S.reqs) L.push({ id: q.id, s: 'warn', r: 1, ts: q.created_at, ico: 'key', ttl: 'Access', who: q.agent_label || trunc(q.agent_id, 12), sub: `<span class="mono">${esc(q.actions.join(' '))} ${esc(q.resource)}</span>`, acts: `<button class="btn sm ok" data-act="rqok|${q.id}" aria-label="Approve">${ic('check')}</button><button class="btn sm bad" data-act="rqno|${q.id}" aria-label="Deny">${ic('x')}</button><button class="btn sm" data-go="req" aria-label="Narrow">${ic('sl')}</button>`, chip: true, age: 1 });
  for (const c of S.conf) L.push({ id: c.id, s: 'warn', r: 3, ts: c.created_at, ico: 'note', ttl: 'Conflict', who: c.path, sub: `<span class="mono">${esc(c.agent_label || c.source)}</span>`, acts: `<button class="btn sm" data-go="vault" data-arg="conf">Open</button>`, chip: true, age: 1 });
  if (!openAlerts().some((a) => a.type === 'stalled_member' || a.type === 'task_blocked')) {
    for (const t of S.teams) { const bl = t.counts?.blocked || 0; if (t.stalled || bl) L.push({ id: 'tm' + t.id, s: 'warn', r: 3, ts: t.updated_at, ico: bl ? 'warn' : 'clock', ttl: bl ? 'Blocked' : 'Stalled', who: t.name, sub: `<span class="mono">×${bl || t.stalled}</span>`, acts: `<button class="btn sm" data-team="${t.id}">Open</button>`, chip: true, age: 1 }); }
  }
  return L.sort((a, b) => a.r - b.r || b.ts - a.ts);
}
function renderAlerts() {
  const L = urgent(), fr = (id) => (SEEN.has(id) ? '' : ' fresh');
  $('#alN').textContent = L.length;
  $('#alerts').innerHTML = L.length ? L.map((a) => `<div class="al sev-${a.s}${fr(a.id)}"><div class="ico">${ic(a.ico)}</div><div style="min-width:0"><div class="t">${esc(a.ttl)} <span>${esc(a.who)}</span></div><div class="s">${a.sub}<span>${ago(a.ts)}</span></div></div><div class="a">${a.acts}</div></div>`).join('')
    : `<div class="empty">${ic('check')}Clear</div>`;
  let chips = L.filter((a) => a.chip).slice(0, 4).map((a) => `<div class="chip sev-${a.s}${fr(a.id)}"><span class="ico">${ic(a.ico)}</span><b>${esc(a.ttl)}</b><span class="who">${esc(trunc(a.who, 28))}</span>${a.sub}${a.acts}</div>`).join('');
  if (S.me && !S.me.totp_enrolled) chips += `<div class="chip sev-warn"><span class="ico">${ic('lock')}</span><b>2FA</b><button class="btn sm" data-go="account">Enrol</button></div>`;
  $('#chips').innerHTML = chips || `<div class="chip clear"><span class="ico">${ic('check')}</span><b>Clear</b></div>`;
  L.forEach((a) => SEEN.add(a.id));
  $$('[data-request-badge]').forEach(badge => { badge.hidden = !S.reqs.length; });
}

/* ---------- auditing: alerts triage, calls, audit trail ---------- */
const keyAgentOf = (id) => K(id)?.agent_id || null;
const subjName = (id) => { if (!id) return '—'; const k = K(id); if (k) return keyName(k); const a = S.agents.find((x) => x.id === id); if (a) return a.label; const t = S.teams.find((x) => x.id === id); return t ? t.name : trunc(id, 18); };
const dayLabel = (t) => { const d = new Date(t), n = new Date(), y = new Date(Date.now() - 864e5); return d.toDateString() === n.toDateString() ? 'Today' : d.toDateString() === y.toDateString() ? 'Yesterday' : d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }); };
const byDay = (rows, at, row) => { let cur = '', out = ''; for (const r of rows) { const d = dayLabel(at(r)); if (d !== cur) { cur = d; out += `<h5 class="subh day">${esc(d)}</h5>`; } out += row(r); } return out; };
const clock = (t) => new Date(t).toTimeString().slice(0, 5);
/* Ids inside details and arguments read as names where the console knows them. */
const idName = (v) => { const str = String(v); const a = S.agents.find((x) => x.id === str); if (a) return a.label; const k = K(str); if (k) return keyName(k); const t = S.teams.find((x) => x.id === str); return t ? t.name : str; };
const NOISE = new Set(['session_token', 'client_msg_id', 'repeats', 'last_seen_at']);
const kvChips = (obj, max = 4) => Object.entries(obj || {}).filter(([k, v]) => !NOISE.has(k) && v !== null && v !== '' && typeof v !== 'object')
  .slice(0, max).map(([k, v]) => `<span class="tag" title="${esc(k)}: ${esc(String(v))}">${esc(k.replace(/_/g, ' '))}: ${esc(trunc(idName(v), 48))}</span>`).join('');
/* The full record, pretty-printed, behind a toggle; the chips above only show the most useful fields. */
const rawJson = (v) => { if (v === null || v === undefined || v === '') return ''; let txt; try { txt = JSON.stringify(typeof v === 'string' ? JSON.parse(v) : v, null, 2); } catch { txt = String(v); }
  return `<details class="raw"><summary>${ic('chev')}Raw</summary><pre class="mono">${esc(txt)}</pre></details>`; };
const argChips = (summary) => { if (!summary) return ''; try { return kvChips(JSON.parse(summary), 3); } catch { return `<span class="mono">${esc(trunc(summary, 80))}</span>`; } };

/* What each alert type means, in plain words, and which actions help. who/agent/team are resolved names. */
function alertInfo(a) {
  const d = det(a), k = K(a.subject), agentId = d.agent || k?.agent_id || (S.agents.some((x) => x.id === a.subject) ? a.subject : null);
  const agent = agentId ? agLabel(agentId) : null, team = S.teams.find((t) => t.name === d.team || t.id === a.subject) || null;
  const keyActs = () => k ? [['Open key', 'key', `data-key="${k.id}"`], ...(k.effective_status === 'active' ? [['Suspend key', 'pause', `data-act="asusp|${a.id}"`, 'bad']] : [])] : [];
  const calls = k ? [['View calls', 'bolt', `data-go="log" data-arg="calls|${k.id}"`]] : agentId ? [['View calls', 'bolt', `data-go="log" data-arg="calls|agent:${agentId}"`]] : [];
  const who = agent || subjName(a.subject);
  const M = {
    key_in_payload: ['Key leaked in a call', `${who} sent a secret (${d.kind || 'key'}) in ${d.tool || 'a tool call'}${d.field ? ' · field ' + d.field : ''}. The call was blocked and the key suspended. Rotate it before reuse.`, [...keyActs(), ...calls]],
    key_in_result: ['Secret withheld from output', `${d.tool || 'A tool'} would have returned a secret${d.kind ? ' (' + d.kind + ')' : ''} to ${who}. It was withheld. Find and remove it at the source.`, [...keyActs()]],
    repeated_denials: ['Repeated denials', `${who} was denied ${d.count || 'several'} times in ${d.window_minutes || '?'} min${d.last_tool ? ' · last tool ' + d.last_tool : ''}. Either it needs access or it is probing.`, [...calls, ...keyActs()]],
    forbidden_path: ['Forbidden path', `${who} tried ${d.tool || 'a tool'} outside its grants${d.error ? ' (' + d.error + ')' : ''}.`, [...calls, ...keyActs()]],
    unusual_volume: ['Unusual volume', `${who}: ${d.count_this_hour} ${d.kind || 'calls'} this hour vs a baseline of ${d.hourly_baseline} (limit ${d.limit}).`, [...calls, ...keyActs()]],
    login_burst: ['Login burst', `${d.count} failed logins in ${d.window_minutes} min from ${a.subject || 'an unknown source'}${d.last_subject ? ' · last ' + d.last_subject : ''}.`, [['View audit', 'log', `data-go="log" data-arg="audit|${esc(a.subject || '')}"`]]],
    concurrent_use: ['Key used twice at once', `${who}'s session key logged in while another login was live. Two clients may share one key.`, [...keyActs(), ...(k ? [['End logins', 'out', `data-end-logins="${k.id}"`]] : [])]],
    quota_trip: ['Team limit reached', `${d.team || 'A team'} hit its ${String(d.metric || 'limit').replace(/_/g, ' ')} limit (${d.count}/${d.limit}).`, team ? [['Open team', 'team', `data-team="${team.id}"`]] : []],
    task_blocked: ['Task blocked', `"${d.task || 'A task'}" in ${d.team || 'a team'} is blocked${d.reason ? ': ' + d.reason : ''}.`, team ? [['Open team', 'team', `data-team="${team.id}"`]] : []],
    checkpoint: ['Approval needed', `"${d.task || 'A task'}" in ${d.team || 'a team'} is done and waits for your approval.`, team ? [['Approve', 'check', `data-appr="${team.id}|${a.subject}"`, 'ok'], ['Open team', 'team', `data-team="${team.id}"`]] : []],
    stalled_member: ['Member stalled', `${who} (${d.role || 'member'}) in ${d.team || 'a team'} has stopped making progress.`, [...(agentId ? [['Open agent', 'user', `data-ses="${agentId}"`]] : []), ...(team ? [['Open team', 'team', `data-team="${team.id}"`]] : [])]],
    vault_conflict: ['Vault conflict', `${d.path || 'A file'} changed outside the hub during a commit.`, [['Resolve', 'warn', `data-go="vault" data-arg="conf"`]]],
  };
  const [title, text, acts] = M[a.type] || [a.type.replace(/_/g, ' '), JSON.stringify(d).slice(0, 160), keyActs()];
  return { title, text, acts, who, repeats: d.repeats || 1, last: d.last_seen_at || a.updated_at || a.created_at };
}
const AL_STATUS = [['open', 'Open'], ['acknowledged', 'Acknowledged'], ['closed', 'Closed'], ['', 'All']];
const AL_SEV = [['critical', 'Critical', 'shield'], ['warning', 'Warning', 'warn'], ['info', 'Info', 'clock']];
const AL_F = { status: 'open', sev: '', q: '' };
async function auditAlerts() {
  const all = (await api('/alerts?limit=200')).alerts;
  const shown = () => all.filter((a) => (!AL_F.status || a.status === AL_F.status) && (!AL_F.sev || a.severity === AL_F.sev));
  const card = (a) => {
    const i = alertInfo(a), s = SEV[a.severity];
    const btn = ([l, icn, attr, cls]) => `<button class="btn sm${cls ? ' ' + cls : ''}" ${attr}>${ic(icn)}${l}</button>`;
    return `<article class="alc sev-${s}${a.status !== 'open' ? ' done' : ''}" data-text="${esc((i.title + ' ' + i.text + ' ' + i.who).toLowerCase())}">
      <span class="ico">${ic(atype(a)[1])}</span>
      <div class="alc-main"><div class="alc-top"><b>${esc(i.title)}</b>${i.repeats > 1 ? `<span class="tag">×${i.repeats}</span>` : ''}${a.status !== 'open' ? `<span class="pill p-idle">${esc(a.status)}</span>` : ''}<span class="alc-age" title="${esc(new Date(a.created_at).toLocaleString())}">${ago(i.last)} ago</span></div>
        <p>${esc(i.text)}</p>
        <div class="alc-acts">${i.acts.map(btn).join('')}<span class="grow"></span>${a.status === 'open' ? `<button class="btn sm" data-act="ack|${a.id}">${ic('check')}Acknowledge</button>` : ''}${a.status !== 'closed' ? `<button class="btn sm" data-act="close|${a.id}">${ic('x')}Close</button>` : ''}</div>${rawJson({ id: a.id, type: a.type, severity: a.severity, status: a.status, subject: a.subject, details: det(a), created_at: new Date(a.created_at).toISOString(), updated_at: a.updated_at && new Date(a.updated_at).toISOString() })}</div></article>`;
  };
  const cnt = (f) => all.filter(f).length;
  const draw = () => {
    const txt = (a) => { const i = alertInfo(a); return (i.title + ' ' + i.text + ' ' + i.who).toLowerCase(); };
    const L = shown().filter((a) => !AL_F.q || txt(a).includes(AL_F.q));
    $('#alL').innerHTML = L.length ? L.map(card).join('') : none('check', AL_F.status === 'open' ? 'All clear' : 'No alerts', AL_F.status === 'open');
    $('#alBulk').hidden = !L.some((a) => a.status === 'open');
    tipIcons($('#alL'));
  };
  return {
    t: `${ic('warn')}Alerts`,
    a: `<button class="btn sm" id="alBulk">${ic('check')}Acknowledge shown</button>`,
    b: vtools(`<div class="seg" id="alSt" role="group" aria-label="Status">${AL_STATUS.map(([v, l]) => `<button data-st="${v}" class="${AL_F.status === v ? 'on' : ''}">${l}${v ? ` <span class="tabn">${cnt((a) => a.status === v)}</span>` : ''}</button>`).join('')}</div><div class="seg" id="alSev" role="group" aria-label="Severity">${[['', 'All'], ...AL_SEV].map(([v, l]) => `<button data-sev="${v}" class="${AL_F.sev === v ? 'on' : ''}">${l}</button>`).join('')}</div><div class="srch">${ic('search')}<input class="inp" id="alQ" type="search" placeholder="Search alerts" aria-label="Search alerts" value="${esc(AL_F.q)}"></div>`) +
      `<div id="alL" class="al-list"></div>`,
    after() {
      draw();
      $('#alSt').onclick = (e) => { const b = e.target.closest('[data-st]'); if (!b) return; AL_F.status = b.dataset.st; $$('#alSt button').forEach((x) => x.classList.toggle('on', x === b)); draw(); };
      $('#alSev').onclick = (e) => { const b = e.target.closest('[data-sev]'); if (!b) return; AL_F.sev = b.dataset.sev; $$('#alSev button').forEach((x) => x.classList.toggle('on', x === b)); draw(); };
      $('#alQ').oninput = () => { AL_F.q = $('#alQ').value.trim().toLowerCase(); $$('#alL .alc').forEach((c) => (c.hidden = !!AL_F.q && !c.dataset.text.includes(AL_F.q))); };
      $('#alBulk').onclick = () => run(async () => {
        const ids = shown().filter((a) => a.status === 'open').map((a) => a.id);
        await Promise.all(ids.map((id) => post(`/alerts/${id}/ack`)));
        toast(`Acknowledged ${ids.length}`); await refresh(); reopen();
      });
    },
  };
}
const CALL_R = [['', 'All'], ['ok', 'OK'], ['denied', 'Denied'], ['error', 'Errors']];
async function auditCalls(pre) {
  const all = (await api('/invocations?limit=200')).invocations;
  const F = { r: '', who: pre || '', q: '' };
  const agentOf = (i) => i.agent_id || keyAgentOf(i.credential_id);
  const whoName = (i) => (agentOf(i) ? agLabel(agentOf(i)) : K(i.app_credential_id || i.credential_id) ? keyName(K(i.app_credential_id || i.credential_id)) : '—');
  const match = (i) => (!F.r || (F.r === 'error' ? !['ok', 'denied'].includes(i.result) : i.result === F.r))
    && (!F.who || (F.who.startsWith('agent:') ? agentOf(i) === F.who.slice(6) : i.credential_id === F.who || i.app_credential_id === F.who))
    && (!F.q || [i.tool, i.args_summary, i.error_code, whoName(i)].some((x) => String(x || '').toLowerCase().includes(F.q)));
  const agents = [...new Set(all.map(agentOf).filter(Boolean))].map((id) => [id, agLabel(id)]).sort((a, b) => a[1].localeCompare(b[1]));
  const row = (i) => `<tr${agentOf(i) ? ` data-ses="${agentOf(i)}" tabindex="0"` : ''}><td class="mono" title="${esc(new Date(i.created_at).toLocaleString())}">${clock(i.created_at)}</td><td><div class="nm">${esc(whoName(i))}</div></td><td class="mono">${esc(i.tool)}</td>
    <td class="w"><span class="wrap">${argChips(i.args_summary)}</span>${rawJson({ tool: i.tool, result: i.result, error_code: i.error_code, args: (() => { try { return JSON.parse(i.args_summary || 'null'); } catch { return i.args_summary; } })(), agent_id: i.agent_id, credential_id: i.credential_id, app_credential_id: i.app_credential_id, machine_id: i.machine_id, duration_ms: i.duration_ms, at: new Date(i.created_at).toISOString() })}</td><td><span class="pill ${i.result === 'ok' ? 'p-live' : i.result === 'denied' ? 'p-susp' : 'p-block'}">${esc(i.result)}${i.error_code && i.result !== 'denied' ? ' · ' + esc(i.error_code) : ''}</span></td><td class="r mono">${i.duration_ms}ms</td></tr>`;
  const draw = () => {
    const L = all.filter(match);
    $('#clB').innerHTML = L.length ? L.map(row).join('') : `<tr><td colspan="6">${none('bolt', 'No calls')}</td></tr>`;
  };
  return {
    t: `${ic('bolt')}Calls`,
    b: vtools(`<div class="seg" id="clR" role="group" aria-label="Result">${CALL_R.map(([v, l]) => `<button data-r="${v}" class="${v === F.r ? 'on' : ''}">${l}</button>`).join('')}</div>
        <select class="sel" id="clW" aria-label="Agent or key"><option value="">Everyone</option>${agents.map(([id, l]) => `<option value="agent:${id}"${F.who === 'agent:' + id ? ' selected' : ''}>${esc(l)}</option>`).join('')}${F.who && !F.who.startsWith('agent:') ? `<option value="${esc(F.who)}" selected>Key: ${esc(subjName(F.who))}</option>` : ''}</select>
        <div class="srch">${ic('search')}<input class="inp" id="clQ" type="search" placeholder="Tool, argument, error" aria-label="Search calls"></div>`) +
      `<div class="tscroll"><table class="tbl tsm"><thead><tr><th>Time</th><th>Agent</th><th>Tool</th><th class="w">Arguments</th><th>Result</th><th class="r">Duration</th></tr></thead><tbody id="clB"></tbody></table></div>`,
    after() {
      draw();
      $('#clR').onclick = (e) => { const b = e.target.closest('[data-r]'); if (!b) return; F.r = b.dataset.r; $$('#clR button').forEach((x) => x.classList.toggle('on', x === b)); draw(); };
      $('#clW').onchange = () => { F.who = $('#clW').value; draw(); };
      $('#clQ').oninput = () => { F.q = $('#clQ').value.trim().toLowerCase(); draw(); };
    },
  };
}
/* Audit trail: who did what to which object, in words, grouped by day. */
const AUD_VERB = { create: 'created', update: 'changed', delete: 'deleted', rotate: 'rotated', revoke: 'revoked', suspend: 'suspended', reactivate: 'resumed', expiry: 'changed expiry of', start: 'started', stop: 'stopped', pause: 'paused', resume: 'resumed', on: 'turned on', off: 'turned off', bootstrap: 'set up', approve: 'approved', deny: 'denied', end_logins: 'ended logins of' };
const AUD_NOUN = { key: 'key', policy: 'permissions', agent: 'agent', team: 'team', link: 'link', pc: 'PC', lockdown: 'lockdown', admin: 'admin', share: 'share', request: 'request', alert: 'alert', template: 'template' };
const AUD_CAT = [['', 'All'], ['key', 'Keys'], ['policy', 'Permissions'], ['agent|link|team', 'Agents & teams'], ['lockdown|alert', 'Safety'], ['pc|share|request', 'Devices & sharing']];
function auditTarget(e) {
  if (!e.target_id) return '';
  if (e.target_kind === 'credential' && K(e.target_id)) return `<a href="#" data-key="${e.target_id}">${esc(keyName(K(e.target_id)))}</a>`;
  if (e.target_kind === 'policy') { const k = S.keys.find((x) => x.policy_id === e.target_id); if (k) return `<a href="#" data-key="${k.id}">${esc(keyName(k))}</a>`; }
  if (e.target_kind === 'agent' && S.agents.some((a) => a.id === e.target_id)) return `<a href="#" data-ses="${e.target_id}">${esc(agLabel(e.target_id))}</a>`;
  if (e.target_kind === 'team' && S.teams.some((t) => t.id === e.target_id)) return `<a href="#" data-team="${e.target_id}">${esc(subjName(e.target_id))}</a>`;
  if (e.target_kind === 'system') return `<span class="mono">${esc(e.target_id.replace(/^emergency\./, '').replace(/_/g, ' '))}</span>`;
  return `<span class="mono">${esc(trunc(e.target_id, 22))}</span>`;
}
async function auditEvents(pre) {
  const d = await api('/audit?limit=200');
  const F = { q: (pre || '').toLowerCase(), who: '', cat: '' };
  const actor = (e) => (e.actor_kind === 'admin' ? (e.actor_id === S.me.id ? S.me.username : 'Admin') : e.actor_kind === 'agent' ? agLabel(e.actor_id) : e.actor_kind === 'system' ? 'System' : e.actor_kind);
  const sentence = (e) => { const [noun, verb] = e.action.split('.'); return `${AUD_VERB[verb] || (verb || '').replace(/_/g, ' ')} ${AUD_NOUN[noun] || noun}`; };
  const detailChips = (e) => { try { return kvChips(JSON.parse(e.details || '{}')); } catch { return e.details ? `<span class="tag">${esc(trunc(e.details, 60))}</span>` : ''; } };
  const row = (e) => `<div class="aud"><span class="aud-t mono" title="${esc(new Date(e.created_at).toLocaleString())}">${clock(e.created_at)}</span><span class="aud-ico ${e.actor_kind}">${ic(e.actor_kind === 'admin' ? 'user' : e.actor_kind === 'agent' ? 'ses' : 'hub')}</span>
    <div class="aud-main"><div><b>${esc(actor(e))}</b> ${esc(sentence(e))} ${auditTarget(e)}</div><div class="wrap">${detailChips(e)}</div>${rawJson({ action: e.action, actor: { kind: e.actor_kind, id: e.actor_id }, target: { kind: e.target_kind, id: e.target_id }, details: (() => { try { return JSON.parse(e.details || 'null'); } catch { return e.details; } })(), at: new Date(e.created_at).toISOString() })}</div></div>`;
  const cats = (e) => e.action.split('.')[0];
  const day0 = (id, end) => { const v = $(id)?.value; return v ? Date.parse(v + 'T00:00:00') + (end ? 864e5 - 1 : 0) : 0; };
  const match = (e) => (!F.who || e.actor_kind === F.who) && (!F.cat || F.cat.split('|').includes(cats(e))) && (!day0('#aF') || e.created_at >= day0('#aF')) && (!day0('#aT', 1) || e.created_at <= day0('#aT', 1))
    && (!F.q || [e.action, e.target_id, e.actor_id, e.details, actor(e), sentence(e)].some((x) => String(x || '').toLowerCase().includes(F.q)));
  const draw = () => { const L = d.events.filter(match); $('#auB').innerHTML = L.length ? byDay(L, (e) => e.created_at, row) : none('log', 'No events'); tipIcons($('#auB')); };
  return {
    t: `${ic('log')}Audit`,
    a: `<button class="btn sm" data-ax="json">${ic('dl')}JSON</button><button class="btn sm" data-ax="csv">${ic('dl')}CSV</button>`,
    b: vtools(`<div class="seg" id="auW" role="group" aria-label="Actor">${[['', 'Everyone'], ['admin', 'Admins'], ['agent', 'Agents'], ['system', 'System']].map(([v, l]) => `<button data-w="${v}" class="${v ? '' : 'on'}">${l}</button>`).join('')}</div>
        <select class="sel" id="auC" aria-label="Category">${AUD_CAT.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
        <div class="srch">${ic('search')}<input class="inp" id="auQ" type="search" placeholder="Search" aria-label="Search audit"></div>
        <label class="vlabel">From <input class="inp" type="date" id="aF" aria-label="From"></label><label class="vlabel">To <input class="inp" type="date" id="aT" aria-label="To"></label>`) +
      `<div id="auB" class="aud-list"></div>`,
    after() {
      $('#auQ').value = pre || '';
      draw();
      $('#auW').onclick = (e) => { const b = e.target.closest('[data-w]'); if (!b) return; F.who = b.dataset.w; $$('#auW button').forEach((x) => x.classList.toggle('on', x === b)); draw(); };
      $('#auC').onchange = () => { F.cat = $('#auC').value; draw(); };
      $('#auQ').oninput = () => { F.q = $('#auQ').value.trim().toLowerCase(); draw(); };
      ['#aF', '#aT'].forEach((id) => ($(id).onchange = draw));
      const ms = (id, end) => { const v = $(id).value; return v ? Date.parse(v + 'T00:00:00Z') + (end ? 864e5 - 1 : 0) : 0; };
      $$('[data-ax]').forEach((b) => (b.onclick = () => { const f = ms('#aF'), t = ms('#aT', 1), u = '/api/audit/export?format=' + b.dataset.ax + (f ? '&from=' + f : '') + (t ? '&to=' + t : ''); const a = document.createElement('a'); a.href = u; a.download = ''; document.body.append(a); a.click(); a.remove(); }));
    },
  };
}

/* lockdown */
const LKI = { writes: 'pause', vault: 'vault', agent: 'user', pc: 'pc', team: 'team' };
function lkName(s, id) { return s === 'writes' ? 'Writes' : s === 'vault' ? 'Vault' : s === 'agent' ? agLabel(id) : s === 'pc' ? PC(id)?.name || trunc(id, 12) : S.teams.find((x) => x.id === id)?.name || trunc(id, 12); }
function lockItems() {
  const l = S.lock; if (!l) return [];
  return [...(l.writes_disabled ? [['writes', '']] : []), ...l.vaults.map((v) => ['vault', v]), ...l.agents.map((v) => ['agent', v]), ...l.pcs.map((v) => ['pc', v]), ...l.teams.map((v) => ['team', v])];
}
function renderLock() {
  const L = lockItems(); $('#lk').classList.toggle('on', L.length > 0); $('#lk').title = L.length ? `Lockdown · ${L.length} active` : 'Lockdown';
  const b = $('#lkb'); b.hidden = !L.length;
  b.innerHTML = L.map(([s, id]) => `<div class="chip sev-crit"><span class="ico">${ic('lock')}</span><b>${ic(LKI[s])}</b><span class="who">${esc(lkName(s, id))}</span><button class="btn sm" data-lk="${s}|${id}|0" aria-label="Unlock">${ic('x')}</button></div>`).join('');
}
let uT;
function undo(msg, fn) {
  const u = $('#undo'); u.querySelector('span').textContent = msg; u.classList.remove('on'); void u.offsetWidth; u.classList.add('on');
  clearTimeout(uT); uT = setTimeout(() => u.classList.remove('on'), 10000);
  $('#undoGo').onclick = () => { clearTimeout(uT); u.classList.remove('on'); run(fn); };
}
async function lock(scope, id, on, quiet) {
  S.lock = await post('/lockdown', { scope, ...(id ? { id } : {}), on });
  renderLock(); if (DR.type === 'lock') reopen();
  if (!quiet) undo((on ? 'Lock · ' : 'Open · ') + lkName(scope, id), () => lock(scope, id, !on, true));
}
VIEWS.lock = async () => {
  const l = S.lock || { writes_disabled: false, vaults: [], agents: [], pcs: [], teams: [] };
  const al = S.me.vault_alias, active = lockItems();
  // One large toggle per system-wide switch; the colour and verb always say what clicking will do.
  const big = (on, scope, id, icon, title, sub) => `<button class="lk-big${on ? ' on' : ''}" data-lk="${scope}|${id}|${on ? 0 : 1}" aria-pressed="${on}">
      <span class="lk-ico">${ic(on ? 'lock' : icon)}</span><span class="lk-txt"><b>${title}</b><small>${on ? 'Locked · click to lift' : sub}</small></span>
      <span class="lk-act">${on ? 'Lift' : 'Lock'}</span></button>`;
  // Every entity is a one-click toggle; locked ones sort first.
  const grid = (scope, items, ids) => items.length ? `<div class="lk-grid">${items.slice().sort((a, b) => ids.includes(b[0]) - ids.includes(a[0]) || a[1].localeCompare(b[1])).map(([id, name, sub]) => {
    const on = ids.includes(id);
    return `<button class="lk-chip${on ? ' on' : ''}" data-lk="${scope}|${id}|${on ? 0 : 1}" data-lk-name="${esc(name.toLowerCase())}" aria-pressed="${on}" title="${on ? 'Locked · click to lift' : 'Click to lock'}">${ic(on ? 'lock' : LKI[scope])}<span><b>${esc(name)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</span></button>`;
  }).join('')}</div>` : none(LKI[scope], 'None');
  const live = new Set(S.ses.filter((s) => s.live).map((s) => s.agent.id));
  const agents = S.agents.filter((a) => a.status !== 'archived').map((a) => [a.id, a.label, live.has(a.id) ? 'live' : a.role || '']);
  const pcs = S.pcs.map((p) => [p.id, p.name, p.bridge?.online ? 'online' : '']);
  const teams = S.teams.map((t) => [t.id, t.name, t.status]);
  const cnt = (n, ids) => `<span class="tag" style="margin-left:auto">${ids.length ? ids.length + ' locked' : n}</span>`;
  return {
    t: `${ic('lock')}Lockdown ${active.length ? `<span class="pill p-susp">${active.length} active</span>` : '<span class="pill p-live">Open</span>'}`,
    a: active.length ? `<button class="btn sm" id="lkAll">${ic('play')}Lift all</button>` : '',
    b: `<div class="lk-bigs">${big(l.writes_disabled, 'writes', '', 'pause', 'Pause all writes', 'Every agent, every app')}${big(l.vaults.includes(al), 'vault', al, 'vault', 'Freeze vault', 'No changes to ' + al)}</div>` +
      vtools(`<div class="srch">${ic('search')}<input class="inp" id="lkQ" type="search" placeholder="Find agent, PC or team" aria-label="Filter"></div>`) +
      sec('Agents', grid('agent', agents, l.agents), cnt(agents.length, l.agents)) +
      sec('PCs', grid('pc', pcs, l.pcs), cnt(pcs.length, l.pcs)) +
      sec('Teams', grid('team', teams, l.teams), cnt(teams.length, l.teams)),
    after() {
      $('#lkQ').oninput = () => { const q = $('#lkQ').value.trim().toLowerCase(); $$('.lk-chip').forEach((c) => (c.hidden = !!q && !c.dataset.lkName.includes(q))); };
      const all = $('#lkAll');
      if (all) all.onclick = () => run(async () => {
        // Send every change at once and redraw once, so lifting many locks feels instant.
        const items = lockItems(), setAll = async (on) => {
          await Promise.all(items.map(([sc, id]) => post('/lockdown', { scope: sc, ...(id ? { id } : {}), on })));
          S.lock = await api('/lockdown'); renderLock(); if (DR.type === 'lock') reopen();
        };
        await setAll(false);
        undo('Lifted ' + items.length, () => setAll(true));
      });
    },
  };
};

/* exposure treemap */
const heat = (n) => (n >= 5 ? 4 : n >= 4 ? 3 : n >= 2 ? 2 : n >= 1 ? 1 : 0);
function squarify(items, x, y, w, h) {
  const out = [], tot = items.reduce((a, b) => a + b.v, 0); if (!tot) return out;
  const sc = (w * h) / tot; let rest = items.map((it) => ({ ...it, a: it.v * sc }));
  while (rest.length) {
    const sh = Math.min(w, h), worst = (r) => { const s = r.reduce((a, b) => a + b.a, 0), mx = Math.max(...r.map((q) => q.a)), mn = Math.min(...r.map((q) => q.a)); return Math.max((sh * sh * mx) / (s * s), (s * s) / (sh * sh * mn)); };
    let row = [rest[0]], i = 1; while (i < rest.length && worst([...row, rest[i]]) <= worst(row)) { row.push(rest[i]); i++; }
    const s = row.reduce((a, b) => a + b.a, 0);
    if (w >= h) { const cw = s / h; let cy = y; row.forEach((r) => { const ch = r.a / cw; out.push({ ...r, x, y: cy, w: cw, h: ch }); cy += ch; }); x += cw; w -= cw; }
    else { const rh = s / w; let cx = x; row.forEach((r) => { const c2 = r.a / rh; out.push({ ...r, x: cx, y, w: c2, h: rh }); cx += c2; }); y += rh; h -= rh; }
    rest = rest.slice(i);
  }
  return out;
}
function treemap(el, T) {
  if (!el) return; const W = el.clientWidth, H = el.clientHeight; if (!W || !T) return;
  const it = T.folders.map((f) => ({ n: f.name, p: f.path, v: Math.max(f.files, 0.4), e: f.exposure.read }));
  if (T.files.length) it.push({ n: '·', p: T.path, v: T.files.length, e: Math.max(0, ...T.files.map((f) => f.exposure.read)), loose: 1 });
  const cells = squarify(it.sort((a, b) => b.v - a.v), 0, 0, W, H);
  el.innerHTML = cells.map((c) => { const h = heat(c.e), small = c.w < 56 || c.h < 40; return `<button class="tc" ${c.loose ? '' : `data-vp="${esc(c.p)}"`} style="left:${c.x + 2}px;top:${c.y + 2}px;width:${Math.max(0, c.w - 4)}px;height:${Math.max(0, c.h - 4)}px;background:var(--h${h});color:${h >= 3 ? 'var(--h-ink)' : 'var(--text)'}" aria-label="${esc(c.n)} ${c.e}"><b>${small ? '' : esc(c.n)}</b><span>${ic('key')}${c.e}</span></button>`; }).join('') || `<div class="empty sm">${ic('vault')}</div>`;
}
let treeAt = 0;
function renderTree() { treemap($('#tm'), S.tree); }
function loadTree() { if (Date.now() - treeAt < 30000) return; treeAt = Date.now(); api('/vault/tree').then((t) => { S.tree = t; renderTree(); }, () => {}); }

/* Vault workspace */
let lastVault = null;
const vaultRoot = () => '/' + S.me.vault_alias;
function vaultState(arg) {
  if (arg && typeof arg === 'object') return arg;
  const [tab, path] = (arg || '').split('|');
  return { tab: ['access', 'act', 'conf'].includes(tab) ? tab : 'contents', path: path || vaultRoot(), file: false, agent: '' };
}
function vaultEvents(activity) {
  const revisions = activity.revisions.map(r => ({
    path: r.path, agent: r.agent_label || (r.admin_id ? 'Admin' : r.origin === 'platform' ? 'Unknown' : 'External change'),
    at: r.created_at, action: r.op === 'update' ? 'Edited' : r.op, tone: 'edit',
    diff: r.file_id + '|' + (r.parent_revision || 'absent') + '|' + r.revision,
  }));
  const accesses = activity.access.map(a => ({
    path: a.path || a.resource || '', agent: a.agent_label || 'Unknown', at: a.created_at,
    action: a.decision === 'deny' ? 'Denied · ' + a.action.slice(3) : a.action === 'fs.read' ? 'Read' : a.action.slice(3),
    tone: a.decision === 'deny' ? 'denied' : 'read',
  }));
  return [...revisions, ...accesses].sort((a, b) => b.at - a.at);
}
function vaultTimeline(events) {
  return events.length ? '<div class="vault-timeline">' + events.map(e => `<div class="vault-event">
    <span class="vault-status ${e.tone}">${esc(e.action)}</span>
    <span class="vault-event-detail"><strong>${esc(e.agent)}</strong><small class="mono">${esc(e.path)}</small></span>
    <time datetime="${new Date(e.at).toISOString()}">${ago(e.at)}</time>
    ${e.diff ? `<button class="btn sm" data-df="${esc(e.diff)}">Diff</button>` : ''}
  </div>`).join('') + '</div>' : none('pulse', 'No activity');
}
function vaultAccess(entry, state) {
  const read = entry.exposure.read_agents, update = entry.exposure.update_agents;
  const ids = state.agent ? [state.agent] : [...new Set([...read, ...update])];
  const verb = state.file ? 'Session key grants for this file.' : 'Session keys that may reach this folder or something inside it. Access can vary by file.';
  return `<p class="vault-hint">${verb} App key restrictions and pauses can further limit a session.</p>` +
    (ids.length ? ids.map(id => {
      const keys = S.keys.filter(k => k.kind === 'session_key' && k.agent_id === id && k.effective_status === 'active');
      return `<div class="vault-access-row"><strong>${esc(agLabel(id))}</strong>
        <span class="vault-grants">${read.includes(id) ? '<span class="vault-status read">Read</span>' : ''}
        ${update.includes(id) ? '<span class="vault-status edit">Edit</span>' : ''}
        ${!read.includes(id) && !update.includes(id) ? '<span class="vault-status">No read or edit grant</span>' : ''}</span>
        <span class="wrap">${keys.map(k => `<button class="btn sm" data-key="${esc(k.id)}">${keys.length === 1 ? 'Manage access' : 'Manage ' + esc(k.label)}</button>`).join('')}</span></div>`;
    }).join('') : none('key', 'No access'));
}
function vaultTree(levels, state) {
  const markers = {
    reachable: ['check', 'May contain accessible items'],
    read: ['eye', 'Can read'],
    edit: ['edit', 'Can edit'],
    blocked: ['ban', 'No read or edit grant'],
  };
  const marker = (kind, label = markers[kind][1]) =>
    `<span class="vault-marker ${kind}" title="${label}" role="img" aria-label="${label}">${ic(markers[kind][0])}</span>`;
  const line = (entry, depth, file = false) => {
    const selected = entry.path === state.path;
    const expanded = entry.path !== state.collapsed && levels.some(level => level.path === entry.path);
    const read = entry.exposure.read_agents.includes(state.agent);
    const edit = entry.exposure.update_agents.includes(state.agent);
    const kind = !read && !edit ? 'blocked' : !file ? 'reachable' : edit ? 'edit' : 'read';
    const label = kind === 'edit' && read ? 'Can read and edit' : markers[kind][1];
    return `<button class="vault-node${state.agent && kind === 'blocked' ? ' dimmed' : ''}" style="--depth:${depth}" data-vault-path="${esc(entry.path)}"${file ? ' data-vault-file' : ` aria-expanded="${expanded}"`}${selected ? ' aria-current="true"' : ''}>
      <span class="vault-disclosure" aria-hidden="true">${file ? '' : ic('chev')}</span>
      ${ic(file ? 'file' : 'vault', 'vault-kind')}<span class="vault-node-name">${esc(entry.name)}</span>${state.agent ? marker(kind, label) : ''}</button>`;
  };
  const descend = depth => {
    const level = levels[depth];
    if (!level || level.path === state.collapsed) return '';
    const next = levels[depth + 1];
    return level.folders.map(f => line(f, depth + 1) + (next?.path === f.path ? descend(depth + 1) : '')).join('') +
      level.files.map(f => line(f, depth + 1, true)).join('');
  };
  return line({ ...levels[0], name: 'Vault root' }, 0) + descend(0);
}
/* ---------- markdown preview for vault notes ----------
   A small renderer for the Obsidian-flavoured markdown agents write: frontmatter, headings, lists and tasks,
   tables, quotes and callouts, code, links, [[wikilinks]], ![[embeds]] and #tags. Every piece of text is escaped
   before any markup is added, and only http(s)/mailto links get an href, so a note cannot inject HTML or script. */
const isMarkdown = (path) => /\.(md|markdown)$/i.test(path);
function mdInline(text, resolve) {
  const keep = [], hold = (html) => `\u0000${keep.push(html) - 1}\u0000`;
  let s = text.replace(/`([^`]+)`/g, (_, c) => hold(`<code>${esc(c)}</code>`));
  s = s.replace(/!\[\[([^\]]+)\]\]/g, (_, t) => hold(`<span class="md-embed">${ic('file')}${esc(t.split('|')[0])}</span>`));
  s = s.replace(/\[\[([^\]]+)\]\]/g, (_, t) => {
    const [target, alias] = t.split('|'), name = target.split('#')[0].trim(), path = name ? resolve(name) : null, label = esc((alias || target).trim());
    return hold(path ? `<a href="#" class="md-wl" data-vault-path="${esc(path)}" data-vault-file title="${esc(path)}">${label}</a>` : `<span class="md-wl miss" title="Not found in the folders shown">${label}</span>`);
  });
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_, alt, url) => hold(`<span class="md-embed">${ic('file')}${esc(alt || url)}</span>`));
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_, label, url) => hold(/^(https?:|mailto:)/i.test(url)
    ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`
    : resolve(decodeURIComponent(url).replace(/\.md$/i, '').split('/').pop()) ? `<a href="#" class="md-wl" data-vault-path="${esc(resolve(decodeURIComponent(url).replace(/\.md$/i, '').split('/').pop()))}" data-vault-file>${esc(label)}</a>` : `<span class="md-wl miss">${esc(label)}</span>`));
  s = s.replace(/\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)]/g, (u) => hold(`<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(u)}</a>`));
  s = esc(s);
  s = s.replace(/\*\*(.+?)\*\*|__(.+?)__/g, (_, a, b) => `<strong>${a ?? b}</strong>`)
    .replace(/(^|[^*\w])\*(?!\s)(.+?)\*(?!\w)|(^|[^_\w])_(?!\s)(.+?)_(?!\w)/g, (_, p1, a, p2, b) => `${p1 ?? p2}<em>${a ?? b}</em>`)
    .replace(/~~(.+?)~~/g, '<del>$1</del>').replace(/==(.+?)==/g, '<mark>$1</mark>')
    .replace(/(^|\s)#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu, '$1<span class="md-tag">#$2</span>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => keep[+i]);
}
function mdFrontmatter(src) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(src); if (!m) return { props: [], body: src };
  const props = []; let cur = null;
  for (const line of m[1].split('\n')) {
    const kv = /^([\w .-]+):\s*(.*)$/.exec(line), item = /^\s+-\s+(.*)$/.exec(line);
    if (kv) { cur = { key: kv[1].trim(), values: [] }; props.push(cur); const v = kv[2].trim(); if (v.startsWith('[') && v.endsWith(']')) cur.values.push(...v.slice(1, -1).split(',').map((x) => x.trim()).filter(Boolean)); else if (v) cur.values.push(v); }
    else if (item && cur) cur.values.push(item[1].trim());
  }
  for (const p of props) p.values = p.values.map((v) => v.replace(/^["']|["']$/g, ''));
  return { props, body: src.slice(m[0].length) };
}
function mdRender(src, resolve) {
  const { props, body } = mdFrontmatter(String(src).replace(/\r\n?/g, '\n'));
  const lines = body.split('\n'), out = [], inl = (t) => mdInline(t, resolve);
  let para = [];
  const flush = () => { if (para.length) { out.push(`<p>${inl(para.join(' '))}</p>`); para = []; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^(```|~~~)\s*([\w+-]*)/.exec(line);
    if (fence) {
      flush(); const code = [];
      while (++i < lines.length && !lines[i].startsWith(fence[1])) code.push(lines[i]);
      out.push(`<pre class="md-code"${fence[2] ? ` data-lang="${esc(fence[2])}"` : ''}><code>${esc(code.join('\n'))}</code></pre>`); continue;
    }
    if (!line.trim()) { flush(); continue; }
    const h = /^(#{1,6})\s+(.*?)\s*#*$/.exec(line);
    if (h) { flush(); out.push(`<h${h[1].length}>${inl(h[2])}</h${h[1].length}>`); continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); out.push('<hr>'); continue; }
    if (/^\s*>/.test(line)) {
      flush(); const q = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''));
      i--;
      const call = /^\[!(\w+)\][+-]?\s*(.*)$/.exec(q[0] || '');
      const inner = mdRender(call ? q.slice(1).join('\n') : q.join('\n'), resolve);
      out.push(call ? `<div class="md-callout k-${esc(call[1].toLowerCase())}"><b>${inl(call[2] || call[1])}</b>${inner}</div>` : `<blockquote>${inner}</blockquote>`); continue;
    }
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      flush(); const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(line), rows = []; i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      i--;
      out.push(`<div class="tscroll"><table class="md-table"><thead><tr>${head.map((c) => `<th>${inl(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${head.map((_, j) => `<td>${inl(r[j] || '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`); continue;
    }
    const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      flush(); const stack = [];
      for (; i < lines.length; i++) {
        const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        if (!m) { if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && stack.length) { out.push(' ' + inl(lines[i].trim())); continue; } break; }
        const depth = m[1].replace(/\t/g, '    ').length, tag = /\d/.test(m[2]) ? 'ol' : 'ul';
        while (stack.length && depth < stack.at(-1).depth) out.push(`</li></${stack.pop().tag}>`);
        if (!stack.length || depth > stack.at(-1).depth) { out.push(`<${tag}>`); stack.push({ depth, tag }); }
        else out.push('</li>');
        const task = /^\[([ xX])\]\s+(.*)$/.exec(m[3]);
        out.push(task ? `<li class="md-task"><input type="checkbox" disabled${task[1] !== ' ' ? ' checked' : ''}> ${inl(task[2])}` : `<li>${inl(m[3])}`);
      }
      while (stack.length) out.push(`</li></${stack.pop().tag}>`);
      i--; continue;
    }
    para.push(line.trim());
  }
  flush();
  const propsH = props.length ? `<dl class="md-props">${props.map((p) => `<dt>${esc(p.key)}</dt><dd>${p.values.map((v) => `<span class="tag">${inl(v)}</span>`).join('') || '—'}</dd>`).join('')}</dl>` : '';
  return propsH + out.join('\n');
}
let mdMode = 'preview';
try { mdMode = localStorage.getItem('ah-md-mode') === 'source' ? 'source' : 'preview'; } catch { /* ignore */ }

VIEWS.vault = async arg => {
  const state = vaultState(arg);
  const parts = state.path.split('/').filter(Boolean);
  const folders = parts.slice(0, state.file ? -1 : undefined).map((_, i) => '/' + parts.slice(0, i + 1).join('/'));
  const activityQuery = new URLSearchParams({ path: state.path, limit: '100', ...(state.file ? { exact: '1' } : {}), ...(state.agent ? { agent: state.agent } : {}) });
  const [levels, activity, preview, conflicts] = await Promise.all([
    Promise.all(folders.map(path => api('/vault/tree?path=' + encodeURIComponent(path)))),
    api('/vault/activity?' + activityQuery),
    state.file && state.tab === 'contents' ? api('/vault/preview?path=' + encodeURIComponent(state.path)) : null,
    state.tab === 'conf' ? VIEWS.vaultConflicts() : null,
  ]);
  const current = levels.at(-1);
  const entry = state.file ? current.files.find(f => f.path === state.path) : current;
  const events = vaultEvents(activity);
  const paused = activity.writes_disabled || S.lock?.vaults?.includes(S.me.vault_alias);
  const title = parts.length === 1 ? 'Vault root' : parts.at(-1);
  const last = new Map();
  for (const e of events) if (e.tone !== 'denied' && !last.has(e.path)) last.set(e.path, e);
  const contents = () => {
    if (state.file) {
      const md = isMarkdown(state.path) && preview?.preview;
      // [[Note]] links resolve against the folders already loaded for this view (this folder and its parents).
      const resolve = (name) => { const n = name.toLowerCase(); for (const lv of levels.slice().reverse()) { const f = lv.files.find((x) => x.name.toLowerCase() === n || x.name.toLowerCase() === n + '.md'); if (f) return f.path; } return null; };
      const src = preview?.preview ? `<pre class="vault-preview" data-md-pane="source"${md && mdMode === 'preview' ? ' hidden' : ''}>${esc(preview.preview.content)}</pre>` : '';
      return `<div class="vault-file-bar"><div class="vault-file-meta">${preview ? esc(fmtB(preview.size)) : ''}${last.has(state.path) ? ' · Last touched by ' + esc(last.get(state.path).agent) : ''}</div>
          ${md ? `<div class="seg" id="mdMode" role="group" aria-label="View">${[['preview', 'Preview', 'eye'], ['source', 'Source', 'note']].map(([k, l, icn]) => `<button data-md="${k}" class="${mdMode === k ? 'on' : ''}">${ic(icn)}${l}</button>`).join('')}</div>` : ''}</div>
        ${preview?.preview ? (md ? `<article class="md" data-md-pane="preview"${mdMode === 'preview' ? '' : ' hidden'}>${mdRender(preview.preview.content, resolve)}</article>` : '') + src + (preview.preview.truncated ? '<p class="vault-hint">Showing the first 24 KB.</p>' : '') : none('file', 'No preview')}`;
    }
    const rows = [...current.folders.map(item => ({ item, file: false })), ...current.files.map(item => ({ item, file: true }))];
    return rows.length ? vtools(`<div class="srch">${ic('search')}<input class="inp" id="vaultFilter" type="search" placeholder="Filter" aria-label="Filter this folder"></div>`) + `
      <div class="vault-items">${rows.map(({ item, file }) => {
        const touched = last.get(item.path);
        const grant = state.agent ? item.exposure.read_agents.includes(state.agent) || item.exposure.update_agents.includes(state.agent)
          : item.exposure.read_agents.length;
        return `<button class="vault-item" data-vault-path="${esc(item.path)}"${file ? ' data-vault-file' : ''}>
          ${ic(file ? 'file' : 'vault', 'vault-kind')}<span><strong>${esc(item.name)}</strong><small>${file ? fmtB(item.size) : item.files + ' files'}${touched ? ' · Last touched by ' + esc(touched.agent) : ''}</small></span>
          <span class="tag">${state.agent ? grant ? file ? 'Has access' : 'May reach' : 'No access' : grant + (file ? ' readers' : ' can reach')}</span>
        </button>`;
      }).join('')}</div><div id="vaultNoMatches" hidden>${none('search', 'No matches')}</div>` : none('vault', 'Empty folder');
  };
  const panel = state.tab === 'conf' ? conflicts.b : state.tab === 'act' ? vaultTimeline(events)
    : state.tab === 'access' ? entry ? vaultAccess(entry, state) : none('file', 'Not found') : contents();
  const crumbs = folders.map((path, i) => i === folders.length - 1 && !state.file
    ? `<b>${esc(i ? parts[i] : title)}</b>` : `<button data-vault-path="${esc(path)}">${esc(i ? parts[i] : 'Vault root')}</button>`);
  if (state.file) crumbs.push(`<b>${esc(title)}</b>`);
  lastVault = state;
  return {
    t: `${ic(state.file ? 'file' : 'vault')}<span class="bc2">${crumbs.join(ic('chev', 'sep'))}</span>`,
    a: (paused ? `<span class="chk n">${ic('lock')}Writes paused</span>` : '') +
      `<select class="sel" id="vaultAgent" aria-label="Agent"><option value="">Everyone</option>${S.agents.filter(a => a.status !== 'archived').map(a => `<option value="${esc(a.id)}"${a.id === state.agent ? ' selected' : ''}>${esc(a.label)}</option>`).join('')}</select>`,
    b: `<div class="vault-workspace">
      <nav class="vault-tree" aria-label="Vault folders">${vaultTree(levels, state)}</nav>
      <section class="vault-detail" aria-label="Selected vault item">${panel}</section></div>`,
    after() {
      const mdSw = $('#mdMode');
      if (mdSw) mdSw.onclick = (e) => {
        const b = e.target.closest('[data-md]'); if (!b) return;
        mdMode = b.dataset.md; try { localStorage.setItem('ah-md-mode', mdMode); } catch { /* ignore */ }
        $$('#mdMode button').forEach((x) => x.classList.toggle('on', x === b));
        $$('[data-md-pane]').forEach((p) => (p.hidden = p.dataset.mdPane !== mdMode));
      };
      $('#vaultAgent').onchange = e => openD('vault', { ...state, agent: e.target.value, tab: state.tab === 'contents' ? 'access' : state.tab }, true);
      const filter = $('#vaultFilter');
      if (filter) filter.oninput = () => {
        const query = filter.value.trim().toLowerCase();
        const items = $$('.vault-item');
        for (const item of items) item.hidden = !item.querySelector('strong').textContent.toLowerCase().includes(query);
        $('#vaultNoMatches').hidden = items.some(item => !item.hidden);
      };
      conflicts?.after();
    },
  };
};

VIEWS.vaultConflicts = async () => {
    const C = (await api('/vault/conflicts')).conflicts;
    return {
      b: (C.map((c) => `<div class="cf"><div class="row" style="flex-wrap:nowrap"><span class="mono" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis">${esc(c.path)}</span>${tagH(esc(c.source))}${tagH(ago(c.created_at))}</div>${c.agent_label ? `<div class="row">${ic('user')}${esc(c.agent_label)}</div>` : ''}${c.conflict_path ? `<div class="mono" style="color:var(--muted)">${esc(c.conflict_path)}</div>` : ''}${(Array.isArray(c.revisions) ? c.revisions : []).map((v) => `<div class="rl">${tagH(esc(v.role || ''))}<span class="mono">${rv(v.revision)}</span><button class="btn ic sm" data-df="${c.file_id}|${c.base_revision || 'absent'}|${esc(v.revision)}" aria-label="Diff">${ic('eye')}</button><button class="btn sm ok" data-keep="${c.id}|${esc(v.revision)}" aria-label="Keep">${ic('check')}</button></div>`).join('')}</div>`).join('') || none('check', 'Clear', true)),
      after() { $$('[data-keep]').forEach((b) => arm(b, () => run(async () => { const [id, rev] = b.dataset.keep.split('|'); await post(`/vault/conflicts/${id}/resolve`, { keep: rev }); toast('Resolved'); await refresh(); reopen(); }))); },
    };
};
VIEWS.diff = async (arg) => {
  const [fid, from, to] = arg.split('|');
  const R = await api('/vault/revisions/' + fid);
  let D = null, err = '';
  try { D = await api(`/vault/diff?file=${fid}&from=${encodeURIComponent(from)}${to ? '&to=' + encodeURIComponent(to) : ''}`); } catch (e) { err = e.message; }
  const opt = (cur, none) => `${none ? `<option value="absent"${cur === 'absent' ? ' selected' : ''}>∅</option>` : ''}${R.revisions.map((r) => `<option value="${esc(r.revision)}"${r.revision === cur ? ' selected' : ''}>${rv(r.revision)} · ${esc(r.op)} · ${ago(r.created_at)}</option>`).join('')}`;
  const cls = (l) => (l.startsWith('+++') || l.startsWith('---') ? 'h' : l[0] === '+' ? 'a' : l[0] === '-' ? 'd' : l[0] === '@' ? 'h' : '');
  return {
    t: `${ic('note')}<span class="mono" style="overflow:hidden;text-overflow:ellipsis">${esc(R.file.path)}</span>`,
    b: `<div class="row" style="flex-wrap:nowrap"><select class="sel" id="dF" aria-label="From" style="max-width:none;flex:1;min-width:0">${opt(from, 1)}</select>→<select class="sel" id="dT2" aria-label="To" style="max-width:none;flex:1;min-width:0">${opt(to || D?.to || R.file.current_revision)}</select></div>` +
      (D ? (D.identical ? `<div class="empty sm">${ic('check')}=</div>` : `<pre class="df">${D.diff.split('\n').map((l) => `<div class="${cls(l)}">${esc(l) || ' '}</div>`).join('')}</pre>`) : `<div class="chk n">${ic('warn')}${esc(err)}</div>`),
    after() { const go_ = () => openD('diff', `${fid}|${$('#dF').value}|${$('#dT2').value}`, true); $('#dF').onchange = go_; $('#dT2').onchange = go_; },
  };
};

/* requests + grants */
async function decide(id, ok, body) { await post(`/requests/${id}/${ok ? 'approve' : 'deny'}`, body || {}); toast(ok ? 'Approved' : 'Denied'); await refresh(); if (DR.type === 'req') reopen(); }
VIEWS.req = async (tab = 'req') => {
  const seg = vtools(subTabs('data-rt', [['req', 'Pending', S.reqs.length ? ' ' + S.reqs.length : ''], ['grants', 'Temporary grants']], tab));
  if (tab === 'grants') {
    const G = (await api('/grants')).grants;
    return { t: `${ic('clock')}Requests <span class="n">${G.length}</span>`, b: seg + `<div>${G.map((g) => { const k = K(g.credential_id); return `<div class="rl"><span class="mono" title="${esc(g.resource)}">${esc(g.resource)}</span>${g.actions.map((a) => tagH(esc(a.replace('fs.', '')))).join('')}${k ? tagH(esc(trunc(keyName(k), 14)), 'k-ses') : ''}${tagH(ic('clock') + left(g.not_after))}<button class="btn ic sm bad" data-gr="${g.id}" aria-label="Revoke">${ic('trash')}</button></div>`; }).join('') || none('clock', 'No grants')}</div>`,
      after() { $$('[data-gr]').forEach((b) => arm(b, () => run(async () => { await api('/grants/' + b.dataset.gr, 'DELETE'); toast('Revoked'); reopen(); }))); } };
  }
  const all = (await api('/requests')).requests, P = all.filter((r) => r.status === 'pending'), D = all.filter((r) => r.status !== 'pending').slice(0, 12);
  return {
    t: `${ic('clock')}Requests <span class="n">${P.length}</span>`,
    b: seg + `<div class="tlist">` + (P.map((r) => `<div class="rq" data-rq="${r.id}"><div class="hh"><b>${esc(r.agent_label || trunc(r.agent_id, 12))}</b>${tagH(ago(r.created_at))}${r.requested_duration_s ? tagH(ic('clock') + fmtD(r.requested_duration_s)) : ''}</div>
      <div class="row">${r.actions.map((a) => tagH(esc(a))).join('')}<span class="mono" style="word-break:break-all">${esc(r.resource)}</span></div>${r.justification ? `<div class="q">${esc(r.justification)}</div>` : ''}
      <div class="row"><div class="seg" data-dur>${['15m', '1h', '4h', '1d'].map((d) => `<button data-d="${d}">${d}</button>`).join('')}</div><input class="inp mono" data-narrow placeholder="${esc(r.resource)}" aria-label="Narrow" maxlength="1024" autocomplete="off" style="height:32px;flex:1;min-width:120px"></div>
      <div class="row"><button class="btn ok" data-rqa="ok">${ic('check')}Approve</button><button class="btn bad" data-rqa="no">${ic('x')}Deny</button></div></div>`).join('') || none('check', 'Clear', true)) + '</div>'
      + (D.length ? `<div>${D.map((r) => `<div class="rl">${stPill(r.status)}<span class="mono">${esc(r.agent_label || '')} ${esc(r.resource)}</span>${tagH(ago(r.decided_at || r.created_at))}</div>`).join('')}</div>` : ''),
    after() {
      $$('.rq').forEach((c) => {
        const id = c.dataset.rq, dur = c.querySelector('[data-dur]');
        dur.onclick = (e) => { const b = e.target.closest('button'); if (!b) return; const was = b.classList.contains('on'); $$('button', dur).forEach((x) => x.classList.remove('on')); if (!was) b.classList.add('on'); };
        c.querySelector('[data-rqa=ok]').onclick = () => run(() => { const d = dur.querySelector('.on')?.dataset.d, n = c.querySelector('[data-narrow]').value.trim(); return decide(id, true, { ...(d ? { duration: d } : {}), ...(n ? { narrowed_resource: n } : {}) }); });
        c.querySelector('[data-rqa=no]').onclick = () => run(() => decide(id, false));
      });
    },
  };
};

/* shares + channels */
VIEWS.shares = async (tab = 'shares') => {
  const seg = (extra = '') => vtools(subTabs('data-sht', [['shares', 'Shares'], ['chans', 'Channels']], tab) + extra);
  if (tab === 'chans') {
    const C = (await api('/channels')).channels, tot = C.reduce((a, c) => a + (c.bytes_moved || 0), 0);
    return {
      t: `${ic('link')}Shares <span class="n">${C.length}</span>`,
      b: seg(tagH(ic('dl') + fmtB(tot))) + `<div class="tlist">` + (C.map((c) => `<div class="cf"><div class="row" style="flex-wrap:nowrap"><span class="mono" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis">${esc(c.from_label || trunc(String(c.from), 12))} → ${esc(c.to_label || String(c.to))}</span>${stPill(c.status)}${['offered', 'open'].includes(c.status) ? `<button class="btn ic sm bad" data-cc="${c.channel_id}" aria-label="Close">${ic('x')}</button>` : ''}</div>
        <div class="row" style="flex-wrap:nowrap">${tagH(esc(c.mode))}${c.size ? `<div class="pb" style="flex:1"><i style="width:${Math.min(100, Math.round(((c.bytes_moved || 0) / c.size) * 100))}%"></i></div>` : '<span style="flex:1"></span>'}${tagH(fmtB(c.bytes_moved || 0) + (c.size ? '/' + fmtB(c.size) : ''))}${tagH(ago(c.created_at))}</div>${c.purpose ? `<div class="mono" style="color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.purpose)}</div>` : ''}${c.failure_reason ? `<div class="chk n">${esc(c.failure_reason)}</div>` : ''}</div>`).join('') || none('link', 'No channels')) + '</div>',
      after() { $$('[data-cc]').forEach((b) => arm(b, () => run(async () => { await post(`/channels/${b.dataset.cc}/close`); toast('Closed'); reopen(); }))); },
    };
  }
  const L = (await api('/shares')).shares;
  return { t: `${ic('link')}Shares <span class="n">${L.length}</span>`, b: seg() + `<div>${L.map((s) => `<div class="rl clk" data-share="${s.id}" tabindex="0" role="button"><span class="mono">${esc(s.name)}</span>${stPill(s.status)}${tagH('v' + s.versions.length)}${tagH(esc(trunc(s.author_label || '', 12)), 'k-ses')}${tagH(ago(s.updated_at))}</div>`).join('') || none('link', 'No shares')}</div>` };
};
VIEWS.share = async (id) => {
  const [{ share: s }, V, F] = await Promise.all([api('/shares/' + id), api(`/shares/${id}/versions`), api(`/shares/${id}/feedback`)]);
  return {
    t: `${ic('link')}<span style="overflow:hidden;text-overflow:ellipsis">${esc(s.name)}</span>${stPill(s.status)}`,
    b: `<div class="row">${tagH(esc(s.author_label || ''), 'k-ses')}${s.recipients.map((r) => tagH(esc(r.startsWith('agent:') ? agLabel(r.slice(6)) : r))).join('')}</div>` +
      sec('Versions', V.versions.slice().reverse().map((v) => `<details class="cf"><summary class="row" style="cursor:pointer"><b>v${v.version}</b>${stPill(v.status)}${tagH(esc(v.upload_kind))}${tagH(ic('note') + v.files.length)}${tagH(fmtB(v.total_bytes))}${tagH(ago(v.created_at))}</summary>${v.note ? `<div class="q">${esc(v.note)}</div>` : ''}${v.files.slice(0, 50).map((f) => `<div class="rl"><span class="mono">${esc(f.path)}</span>${tagH(fmtB(f.size))}</div>`).join('')}</details>`).join('')) +
      (F.feedback.length ? sec('Feedback', F.feedback.map((f) => `<div class="cf"><div class="row">${tagH(esc(f.kind))}<b>${esc(f.author_label || '')}</b>${tagH('v' + f.version)}${f.path ? `<span class="mono">${esc(f.path)}${f.line ? ':' + f.line : ''}</span>` : ''}<span style="flex:1"></span>${tagH(esc(f.status))}${tagH(ago(f.created_at))}</div><div class="q">${esc(f.body)}</div></div>`).join('')) : '') +
      `<div class="row">${s.status !== 'revoked' ? `<button class="btn bad" id="shR">${ic('ban')}Revoke</button>` : ''}<button class="btn bad" id="shD">${ic('trash')}Delete</button></div>`,
    after() {
      const r = $('#shR'); r && arm(r, () => run(async () => { await post(`/shares/${id}/revoke`); toast('Revoked'); reopen(); }));
      arm($('#shD'), () => run(async () => { await api('/shares/' + id, 'DELETE'); toast('Deleted'); DR.stack.length ? back() : openD('shares', null, true); }));
    },
  };
};

/* ---------- events ---------- */
document.addEventListener('click', (e) => {
  const t = e.target;
  if (t.closest('details.raw')) return;
  const meB = t.closest('[data-me]'); if (meB) { if ($('#meMenu').hidden) openMe(meB); else closeMe(); return; }
  const mi = t.closest('[data-mi]'); if (mi) { closeMe(); if (mi.dataset.mi === 'out') run(signOut); else go(mi.dataset.mi); return; }
  if (!t.closest('#meMenu')) closeMe();
  const c = t.closest('[data-copy]'); if (c) { const v = c.closest('[data-v]'); copy(v ? v.dataset.v : c.dataset.copy); return; }
  const ac = t.closest('[data-act]');
  if (ac) { const [kd, id] = ac.dataset.act.split('|'); run(async () => { if (kd === 'rqok' || kd === 'rqno') return decide(id, kd === 'rqok'); if (kd === 'asusp') await post('/alerts/' + id + '/suspend-key'); else await post('/alerts/' + id + '/' + kd); toast('✓'); await refresh(); if (DR.type === 'log') reopen(); }); return; }
  const lk = t.closest('[data-lk]'); if (lk) { const [sc, id, on] = lk.dataset.lk.split('|'); run(() => lock(sc, id, on === '1')); return; }
  const vp = t.closest('[data-vp]'); if (vp) { openD('vault', 'map|' + vp.dataset.vp); return; }
  const vaultPath = t.closest('[data-vault-path]');
  if (vaultPath) {
    const path = vaultPath.dataset.vaultPath;
    const collapsed = vaultPath.getAttribute('aria-expanded') === 'true' ? path : null;
    openD('vault', { ...vaultState(DR.arg), path, collapsed, file: vaultPath.hasAttribute('data-vault-file') }, true);
    return;
  }
  const vaultTab = t.closest('[data-vault-tab]');
  if (vaultTab) { openD('vault', { ...(DR.type === 'vault' ? vaultState(DR.arg) : lastVault || vaultState()), tab: vaultTab.dataset.vaultTab }, DR.type === 'vault'); return; }
  const rt = t.closest('[data-rt]'); if (rt) { openD('req', rt.dataset.rt, true); return; }
  const st_ = t.closest('[data-sht]'); if (st_) { openD('shares', st_.dataset.sht, true); return; }
  const sh = t.closest('[data-share]'); if (sh) { openD('share', sh.dataset.share); return; }
  const df = t.closest('[data-df]'); if (df) { openD('diff', df.dataset.df); return; }
  const su = t.closest('[data-susp]'); if (su) { run(async () => { await post(`/keys/${su.dataset.susp}/suspend`); toast('Suspended'); refresh(); }); return; }
  const grant = t.closest('[data-grant-flow]');
  if (grant) { openD(grant.dataset.grantFlow); return; }
  const g = t.closest('[data-go]'); if (g) { go(g.dataset.go, g.dataset.arg); return; }
  const ak = t.closest('[data-ack]'); if (ak) { run(async () => { await post(`/alerts/${ak.dataset.ack}/ack`); refresh(); }); return; }
  const ap = t.closest('[data-appr]'); if (ap && ap.dataset.appr.includes('|')) { const [tid, kid] = ap.dataset.appr.split('|'); run(async () => { await post(`/teams/${tid}/tasks/${kid}/approve`); toast('Approved'); await refresh(); if (DR.type === 'log') reopen(); }); return; }
  const el = t.closest('[data-end-logins]'); if (el) { run(async () => { await post(`/keys/${el.dataset.endLogins}/end-logins`); toast('Ended'); await refresh(); if (DR.type === 'log') reopen(); }); return; }
  const cb = t.closest('[data-ctx-back]'); if (cb) { if (DR.stack.length) back(); else go(DR.type === 'key' ? 'keys' : 'sessions'); return; }
  const stb = t.closest('[data-ses-tab]'); if (stb) { openD('ses', stb.dataset.sesTab, true); return; }
  const ss = t.closest('[data-ses]'); if (ss) { e.preventDefault(); openD('ses', ss.dataset.ses); return; }
  const tmm = t.closest('[data-team]'); if (tmm) { openD('team', tmm.dataset.team); return; }
  const rm = t.closest('[data-room]'); if (rm) { openD('room', rm.dataset.room); return; }
  const k = t.closest('[data-key]'); if (k) { e.preventDefault(); openD('key', k.dataset.key); return; }
  const p = t.closest('[data-pc]'); if (p) openD('pcs');
});
$('#dBack').onclick = back;
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#meMenu').hidden) { const b = $$('[data-me]').find((x) => x.getAttribute('aria-expanded') === 'true'); closeMe(); b && b.focus(); return; }
  if (!S.me) return;
  if (e.key === 'Escape') { if (DR.type === 'topology' && TG_S.focus) { topoFocus(null); return; } back(); return; }
  if (e.target.matches?.('input,select,textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('[role=button],tr[data-key],tr[data-ses],.ev[data-df]')) { e.preventDefault(); e.target.dispatchEvent(new MouseEvent('click', { bubbles: true })); return; }
  // Some layouts report Shift+/ as "/" with Shift held rather than "?".
  const key = e.key === '/' && e.shiftKey ? '?' : e.key.toLowerCase();
  const m = { s: 'sessions', m: 'teams', c: 'chats', k: 'keys', p: 'pcs', v: 'vault', r: 'req', h: 'shares', o: 'lock', g: 'agents', l: 'log', t: 'theme', '?': 'shortcuts' }[key];
  if (m) { e.preventDefault(); closeMe(); go(m); }
});
document.addEventListener('mouseover', (e) => {
  const n = e.target.closest('.n-s'); if (!n) return;
  $$('#topo .e').forEach((p) => p.classList.toggle('dim', p.dataset.e !== n.dataset.row)); $$('#topo .n-s').forEach((x) => x.classList.toggle('dim', x !== n));
  n.addEventListener('mouseleave', () => $$('#topo .dim').forEach((x) => x.classList.remove('dim')), { once: true });
});
let rz; addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { if (S.me) { renderTopo(); renderAct(); renderTree(); renderAgentGraph(); } }, 120); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
setInterval(() => { if (!document.hidden) refresh(); }, 10000);
// The topology colours edges by 30 s activity, so poll faster while it is on screen.
setInterval(() => { if (!document.hidden && DR.type === 'topology') refresh(); }, 4000);
setInterval(() => { $('#clock').textContent = new Date().toTimeString().slice(0, 8); }, 1000);

/* init */
let th = 'dark'; try { th = localStorage.getItem('ah-theme') || 'dark'; } catch { /* ignore */ }
setTheme(th);
api('/me').then(enter, () => showLogin());
