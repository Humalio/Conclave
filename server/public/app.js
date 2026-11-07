/* Conclave dashboard — vanilla ES module, no build. */
const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
const RM = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const ic = (n, c = '') => `<svg class="i ${c}"><use href="#i-${n}"/></svg>`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => (n >= 1e4 ? (n / 1e3).toFixed(0) + 'k' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n)));
const ago = (t) => { if (!t) return '—'; const d = Math.max(0, (Date.now() - t) / 1000); return d < 60 ? Math.floor(d) + 's' : d < 3600 ? Math.floor(d / 60) + 'm' : d < 86400 ? Math.floor(d / 3600) + 'h' : Math.floor(d / 86400) + 'd'; };
const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const day = (t) => new Date(t).toISOString().slice(0, 10);
/* Detail dates read "10 Nov, 15:09" (design guidelines §6); lists use ago(). Long identifiers (paths) are cut in the middle so the end stays visible. */
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dt = (t) => { if (!t) return '—'; const d = new Date(t); return `${d.getDate()} ${MON[d.getMonth()]}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const midTrunc = (s, n) => { s = String(s ?? ''); return s.length <= n ? s : s.slice(0, Math.ceil((n - 1) * 0.4)) + '…' + s.slice(s.length - Math.floor((n - 1) * 0.6)); };

/* ---------- api ---------- */
let csrf = '';
async function api(path, method = 'GET', body) {
  const h = {};
  if (body !== undefined) h['content-type'] = 'application/json';
  if (method !== 'GET') h['x-csrf-token'] = csrf;
  // A hung request must fail, or the refresh loop would wait on it (busy) forever. Writes such as a reset get longer.
  const ac = new AbortController(), tm = setTimeout(() => ac.abort(), method === 'GET' ? 20000 : 60000);
  let r, j;
  try {
    r = await fetch('/api' + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined, credentials: 'same-origin', signal: ac.signal });
    j = await r.json().catch((e) => { if (ac.signal.aborted) throw e; return {}; });
  } catch (e) {
    throw Object.assign(new Error(ac.signal.aborted ? 'The hub did not answer in time' : 'Cannot reach the hub'), { status: 0 });
  } finally { clearTimeout(tm); }
  if (!r.ok) {
    if (r.status === 401 && path !== '/login') showLogin();
    throw Object.assign(new Error(j.message || j.error || String(r.status)), { code: j.error, status: r.status });
  }
  return j;
}
const post = (p, b) => api(p, 'POST', b);

/* ---------- state ---------- */
const S = { me: null, keys: [], pcs: [], agents: [], alerts: [], inv: [], tpl: [], top: null, met: null, ses: [], teams: [], convs: [], links: [], reqs: [], lock: null, tree: null, conf: [], f: { kind: '', status: '', pc: '', agent: '' } };
/* id → object lookups for code that runs in per-tick loops. Each map is rebuilt only when refresh replaces its list. */
const idMap = (list, key = (x) => x.id) => { let src, m; return (id) => { const a = list(); if (a !== src) { src = a; m = new Map(a.map((x) => [key(x), x])); } return m.get(id); }; };
const K = idMap(() => S.keys);
const PC = idMap(() => S.pcs);
const AG = idMap(() => S.agents);
const SESA = idMap(() => S.ses, (s) => s.agent.id);
const keyName = (k) => (k.kind === 'app_key' ? k.app_name || k.label : k.label);
const stOf = (k) => {
  const e = k.effective_status;
  if (e !== 'active') return [e, e[0].toUpperCase() + e.slice(1), 'susp', 'var(--bad)'];
  if (k.live_logins > 0) return ['live', 'Live', 'live', 'var(--ok)'];
  if (!k.first_used_at) return ['new', 'New', 'new', 'var(--info)'];
  return ['idle', 'Idle', 'idle', 'var(--idle)'];
};
/* pill(key) shows a key's state; pill(text, tone) shows any short state, tone one of ok | warn | bad | info | idle. */
const pill = (k, tone) => (tone ? `<span class="pill ${esc(tone)}">${esc(k)}</span>` : (() => { const s = stOf(k); return `<span class="pill p-${s[2]}">${s[1]}</span>`; })());

/* ---------- misc ui ---------- */
let tT;
function toast(m, bad) {
  const t = $('#toast');
  t.querySelector('svg').outerHTML = ic(bad ? 'x' : 'check', bad ? 'bad' : '');
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
const codeBox = (text, big) => `<div class="code mono" data-v="${esc(text)}">${esc(text)}<button class="btn ${big ? 'pri' : 'ic'} sm cp" data-copy aria-label="Copy">${ic('copy')}</button></div>`;
const sec = (h, b, extra = '') => `<section class="sec"><h4>${h}${extra}</h4>${b}</section>`;
const none = (icon, label, ok) => `<div class="empty${ok ? ' ok' : ''}">${ic(icon)}<span>${label}</span></div>`;
const vtools = (html) => `<div class="vtools">${html}</div>`;
/* Filter button: opens a sheet with the secondary filters; .on and a count while any is active (setFilterCount updates it). */
const filterBtn = (id, n = 0, label = 'Filters') => `<button type="button" class="btn${n ? ' on' : ''}" id="${id}" aria-haspopup="dialog">${ic('sl')}${esc(label)}<span class="fcount">${n ? ' · ' + n : ''}</span></button>`;
const setFilterCount = (id, n) => { const b = $('#' + id); if (b) { b.classList.toggle('on', n > 0); b.querySelector('.fcount').textContent = n ? ' · ' + n : ''; } };
/* A labelled select for a filter sheet. */
const selField = (id, label, items, cur) => `<label class="fld"><span class="vlabel">${esc(label)}</span><select class="sel" id="${id}" aria-label="${esc(label)}">${items.map(([v, l]) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
/* Consecutive events of one kind on the same day collapse into a group row; the rows sit hidden under it until it is expanded (data-gtoggle). */
function groupRuns(list, isGroupable, at, min = 2) {
  const out = [];
  for (let i = 0; i < list.length;) {
    if (!isGroupable(list[i])) { out.push(list[i++]); continue; }
    let j = i; const d = dayLabel(at(list[i]));
    while (j < list.length && isGroupable(list[j]) && dayLabel(at(list[j])) === d) j++;
    if (j - i >= min) out.push({ group: list.slice(i, j) }); else out.push(...list.slice(i, j));
    i = j;
  }
  return out;
}
const OUTSIDE_INFO = 'Changed on disk (Obsidian, sync or a script), not by an agent. Picked up on the next scan.';
/* The group row's chevron expands it; the info button inside is a sibling control, so the row is a div with role=button. */
const groupHead = (n, at) => row({ as: 'div', group: true, expanded: false, cls: 'vg-head', extra: 'role="button" tabindex="0" data-gtoggle',
  title: raw(`<span class="vg-n">${n}</span> changes · outside the hub ${info(OUTSIDE_INFO)}`), trail: `<time title="${esc(new Date(at).toLocaleString())}">${clock(at)}</time>` });
const groupBlock = (g, at, rowFn) => `<div class="vgroup">${groupHead(g.length, at(g[0]))}<div class="vg-rows" hidden>${g.map(rowFn).join('')}</div></div>`;
const subTabs = (attr, tabs, cur) => `<div class="seg" role="group">${tabs.map(([k, l, n = '']) => `<button ${attr}="${k}" class="${k === cur ? 'on' : ''}">${l}${n}</button>`).join('')}</div>`;
/* ---------- shared components (docs/design-guidelines.md §5): screens render these instead of hand-written markup ---------- */
/* Text arguments are escaped; pass raw(html) for trusted markup. Lead and trail slots take trusted markup built with ic()/pill()/esc(). */
const raw = (html) => ({ html });
const txt = (v) => (v && typeof v === 'object' && 'html' in v ? v.html : esc(v));
const safeHref = (h) => (/^\s*(javascript|data|vbscript):/i.test(String(h)) ? '#' : String(h));
/* List row: 56 px (title + meta) or 44 px (one: true). href renders a link, attrs ({ 'data-go': 'keys' }) a button, neither a plain row.
   metaId sets the meta line in the identifier font; metaEl gives the meta element an id so it can be updated in place. */
function row({ lead = '', dot = false, title = '', meta = '', metaId = false, metaEl = '', trail = '', chev = false, href = '', attrs = {}, cls = '', one = false, group = false, expanded, as = '', extra = '' } = {}) {
  const at = Object.entries(attrs).filter(([k]) => /^[a-z][a-z0-9-]*$/i.test(k)).map(([k, v]) => ` ${k}="${esc(v)}"`).join('');
  const tag = as || (href ? 'a' : at || group ? 'button' : 'div');
  const head = `<${tag} class="lrow${one ? ' one' : ''}${group ? ' group' : ''}${cls ? ' ' + esc(cls) : ''}"${href ? ` href="${esc(safeHref(href))}"` : ''}${tag === 'button' ? ' type="button"' : ''}${extra ? ' ' + extra : ''}${group ? ` aria-expanded="${expanded ? 'true' : 'false'}"` : ''}${at}>`;
  const tr = `${trail}${chev || group ? ic('chev', 'chev') : ''}`;
  return `${head}${lead ? `<span class="lrow-lead${dot ? ' dot-lead' : ''}">${lead}</span>` : ''}<span class="lrow-main"><span class="lrow-title">${txt(title)}</span>${!one && meta !== '' ? `<span class="lrow-meta${metaId ? ' id' : ''}"${metaEl ? ` id="${esc(metaEl)}"` : ''}>${txt(meta)}</span>` : ''}</span>${tr ? `<span class="lrow-trail">${tr}</span>` : ''}</${tag}>`;
}
/* Key-value row (44 px): label left, value right. The value is trusted markup (a pill, esc()'d text). */
const kv = (label, valueHtml, { id = false } = {}) => `<div class="kv"><span class="kv-k">${txt(label)}</span><span class="kv-v${id ? ' id' : ''}">${valueHtml}</span></div>`;
/* Section label inside a card: "ACTIVE · 7". extra is trusted markup after the label, for example an info() button. */
const overline = (text, count, extra = '') => `<div class="overline"><span>${esc(text)}</span>${count === undefined || count === null ? '' : `<span aria-hidden="true">·</span><span>${esc(count)}</span>`}${extra}</div>`;
/* Info button: tooltip on hover/focus on desktop, a sheet on touch (handled by the click listener below). Keep the text to two short sentences. */
const info = (text) => `<button type="button" class="info" data-info="${esc(text)}" aria-label="More information">${ic('info')}<span class="info-tip" role="tooltip">${esc(text)}</span></button>`;
/* Sheet: bottom sheet on phones, popover under options.anchor (or a centred dialog) on desktop. One at a time; Esc, the scrim and the close
   button close it, Tab stays inside it, and focus returns to what opened it. html is trusted markup; title is escaped. */
let SHEET = null;
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
function openSheet({ title = '', html = '', onClose, anchor } = {}) {
  closeSheet();
  const pop = !!anchor && matchMedia('(min-width: 768px)').matches;
  const scrim = document.createElement('div'); scrim.className = 'scrim' + (pop ? ' pop' : '');
  const sh = document.createElement('div'); sh.className = 'sheet' + (pop ? ' pop' : '');
  sh.setAttribute('role', 'dialog'); sh.setAttribute('aria-modal', 'true'); sh.tabIndex = -1;
  if (title) sh.setAttribute('aria-labelledby', 'sheetT'); else sh.setAttribute('aria-label', 'Details');
  sh.innerHTML = (title ? `<div class="sheet-hd"><h2 id="sheetT">${esc(title)}</h2><button type="button" class="ibtn" data-sheet-close aria-label="Close">${ic('x')}</button></div>` : '') + html;
  document.body.append(scrim, sh);
  if (pop) { const r = anchor.getBoundingClientRect(); sh.style.left = Math.max(8, Math.min(innerWidth - sh.offsetWidth - 8, r.right - sh.offsetWidth)) + 'px'; sh.style.top = (r.bottom + 8 + sh.offsetHeight > innerHeight - 8 && r.top - 8 - sh.offsetHeight >= 8 ? r.top - 8 - sh.offsetHeight : r.bottom + 8) + 'px'; } // above the anchor when it does not fit below (bulk bars sit at the bottom)
  SHEET = { sh, scrim, opener: document.activeElement, onClose };
  scrim.addEventListener('click', () => closeSheet());
  sh.addEventListener('click', (e) => { if (e.target.closest('[data-sheet-close]')) closeSheet(); });
  sh.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const f = $$(FOCUSABLE, sh).filter((x) => !x.closest('[hidden]'));
    if (!f.length) { e.preventDefault(); sh.focus(); return; }
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === sh)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  const f = $$(FOCUSABLE, sh); // first real control, not the Close button
  (f.find((x) => !x.matches('[data-sheet-close]')) || f[0] || sh).focus({ preventScroll: true });
  return sh;
}
function closeSheet() {
  if (!SHEET) return;
  const { sh, scrim, opener, onClose } = SHEET; SHEET = null;
  sh.remove(); scrim.remove();
  opener && opener.isConnected && opener.focus && opener.focus({ preventScroll: true });
  onClose && onClose();
}
/* Switch: an on/off control. It keeps an .on class next to aria-checked so callers can read it with classList.contains('on'). attrs is trusted markup (an id, data-*). */
const switchBtn = (label, on, attrs = '') => `<button type="button" class="switch${on ? ' on' : ''}" role="switch" aria-checked="${on ? 'true' : 'false'}" aria-label="${esc(label)}"${attrs ? ' ' + attrs : ''}></button>`;
const flipSwitch = (b) => { const on = !b.classList.contains('on'); b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); return on; };
/* Detail app bar: on phones a screen with a parent shows back · title + meta · overflow in place of the page app bar (CSS swaps them with body.has-dbar).
   A view returns dbar: { title, meta, menu: [{ label, icon, bad, confirm, fn }] }; the same menu opens from moreBtn() in the desktop header, as a popover. */
let DBAR_MENU = [], PAGE_MENU = []; // PAGE_MENU: a page view's actions (view.pmenu) in the phone app bar's overflow
const moreBtn = () => `<button type="button" class="btn ic" data-dbar-more aria-label="More actions" aria-haspopup="dialog">${ic('more')}</button>`;
function setDetailBar(d) {
  DBAR_MENU = (d && d.menu || []).filter(Boolean);
  document.body.classList.toggle('has-dbar', !!d);
  // The overflow is always there on phones: it also carries the hub actions the page app bar holds elsewhere.
  $('#dbar').innerHTML = d ? `<button type="button" class="ibtn" data-dbar-back aria-label="Back">${ic('back')}</button><div class="ttl"><h1>${d.dot ? `<i class="dot ${esc(d.dot)}"></i>` : ''}${esc(d.title)}</h1><span class="meta">${esc(d.meta || '')}</span></div><button type="button" class="ibtn" data-dbar-more aria-label="More actions" aria-haspopup="dialog">${ic('more')}</button>` : '';
}
/* Hub actions (Lockdown, two-factor, theme, sign out). On phones a detail screen hides the page app bar, so its overflow lists them too. */
const hubMenu = () => { const dark = document.documentElement.dataset.theme === 'dark'; return [
  { heading: 'Hub' },
  { label: 'Lockdown', icon: 'lock', fn: () => go('lock') },
  { label: S.me?.totp_enrolled ? 'Two-factor is on' : 'Set up two-factor', icon: 'shield', fn: () => go('account') },
  { label: dark ? 'Light theme' : 'Dark theme', icon: dark ? 'sun' : 'moon', fn: () => go('theme') },
  { label: 'Sign out', icon: 'out', bad: true, fn: () => run(signOut) },
]; };
/* Destructive items ask once more inside the sheet (confirm is the second label), then run fn. */
function openOverflow(btn) { openMenu(matchMedia('(max-width: 767.98px)').matches ? [...DBAR_MENU, ...hubMenu()] : DBAR_MENU, btn); }
function openMenu(items, btn) {
  items = items.filter(Boolean); if (!items.some((m) => !m.heading)) return;
  if (items[0].heading) items = items.slice(1); // no group heading when the screen has no actions of its own
  const sh = openSheet({ anchor: btn, html: `<div class="sheet-list">${items.map((m, i) => m.heading ? `<div class="overline sheet-group">${esc(m.heading)}</div>` : `<button type="button" class="sheet-item${m.bad ? ' bad' : ''}" data-ovf="${i}">${ic(m.icon || 'more')}<span>${esc(m.label)}</span></button>`).join('')}</div>` });
  sh.addEventListener('click', (e) => {
    const b = e.target.closest('[data-ovf]'); if (!b) return;
    const m = items[+b.dataset.ovf];
    if (m.confirm && !b.classList.contains('armed')) { b.classList.add('armed'); b.querySelector('span').textContent = m.confirm; return; }
    closeSheet(); m.fn();
  });
}
/* Back from a detail screen: the history stack if there is one, then the screen it was opened from (go() records it),
   else its parent list. Returning to the origin does not record a new origin, so Back never ping-pongs. */
function detailBack() {
  if (DR.stack.length) return back();
  if (DR.type === 'vault') { const v = vaultState(DR.arg); if (v.file) return openD('vault', { ...v, file: false, tab: 'contents', path: v.path.split('/').slice(0, -1).join('/') || vaultRoot() }, true); }
  const from = DR.from; DR.from = null;
  if (from && !(from[0] === DR.type && from[1] === DR.arg)) return from[0] === 'home' ? go('home') : openD(from[0], from[1], false, true);
  const [t, a] = { task: ['team', String(DR.arg).split('|')[0]], plan: ['team', String(DR.arg).split('|')[0]], tasks: ['team', String(DR.arg).split('|')[0]], members: ['team', DR.arg], tsettings: ['team', DR.arg], tstatus: ['team', DR.arg], decisions: ['team', String(DR.arg).split('|')[0]], dec: ['teams'], directive: ['directives'], directives: ['teams'], team: ['teams'], tbuild: ['teams'], room: ['chats'], fbr: ['feedback'], ses: ['sessions'], key: ['keys'], new: ['keys'], app: ['keys'], share: ['shares'], lock: ['home'] }[DR.type] || ['home'];
  go(t, a);
}
/* Tabs scroll sideways; show a 24 px fade on whichever edge is clipped. */
const tabsFadeOne = (el) => { el.classList.toggle('fade-l', el.scrollLeft > 1); el.classList.toggle('fade-r', el.scrollLeft < el.scrollWidth - el.clientWidth - 1); };
const tabsFade = (root = document) => $$('.tabs', root).forEach(tabsFadeOne);
/* The active tab scrolls into view (on phones it may start off-screen), then the fade is redrawn. */
const tabsReveal = (root = document) => $$('.tabs', root).forEach((t) => { const b = t.querySelector('.on,[aria-current]'); if (b) t.scrollLeft = Math.max(0, b.offsetLeft - (t.clientWidth - b.offsetWidth) / 2); tabsFadeOne(t); });
/* Icon-only controls get their aria-label as a hover tooltip. */
function tipIcons(root = document) {
  $$('button[aria-label],a[aria-label]', root).forEach((b) => { if (!b.title && !b.textContent.trim()) b.title = b.getAttribute('aria-label'); });
}
function arm(btn, fn) {
  const o = btn.innerHTML, disarm = () => { clearTimeout(btn._t); btn.classList.remove('armed'); btn.innerHTML = o; };
  btn.onclick = () => {
    // Disarm before acting, so an action that fails asks for confirmation again on the next click.
    if (btn.classList.contains('armed')) { disarm(); return fn(); }
    btn.classList.add('armed'); btn.innerHTML = ic('check') + 'Confirm';
    btn._t = setTimeout(disarm, 3000);
  };
}
/* Search boxes filter after a short pause in typing, not on every key; a box that has left the page does nothing. */
const onSearch = (el, fn, ms = 180) => { let t; el.oninput = () => { clearTimeout(t); t = setTimeout(() => el.isConnected && fn(el.value.trim().toLowerCase()), ms); }; };
function spark(arr, w, h, col, area = true) {
  const mx = Math.max(...arr, 1), mn = Math.min(...arr, 0), r = mx - mn || 1, sx = w / Math.max(1, arr.length - 1);
  const pts = arr.map((v, i) => [i * sx, h - 3 - ((v - mn) / r) * (h - 8)]);
  const l = 'M' + pts.map((p) => p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('L');
  const id = 'g' + (spark.n = (spark.n || 0) + 1);
  return `<svg class="spk" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">${area ? `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:${col};stop-opacity:.32"/><stop offset="1" style="stop-color:${col};stop-opacity:0"/></linearGradient></defs><path d="${l}L${w} ${h}L0 ${h}Z" fill="url(#${id})"/>` : ''}<path d="${l}" fill="none" style="stroke:${col}" stroke-width="1.7" vector-effect="non-scaling-stroke" stroke-linejoin="round"/></svg>`;
}

/* ---------- derived data ---------- */
function buckets(filter, src = S.inv) {
  const now = Date.now(), B = Array.from({ length: 60 }, () => ({ v: 0, t: 0, d: 0 }));
  for (const i of src) {
    if (filter && !filter(i)) continue;
    const x = 59 - Math.floor((now - i.created_at) / 6e4);
    if (x < 0 || x > 59) continue;
    if (i.result === 'denied') B[x].d++; else if (i.tool.startsWith('file_')) B[x].v++; else B[x].t++;
  }
  return B;
}
/* refresh loads open alerts only (all of them, not the open share of the latest 200); the Alerts tab loads every state. */
const openAlerts = () => S.alerts;
/* Alerts name their team; match it by id (alert subject or details.team_id), and by name only when no team id is given. */
const alertTeam = (a, d) => S.teams.find((x) => x.id === a.subject || (d.team_id && x.id === d.team_id)) || (!d.team_id && S.teams.find((x) => x.name === d.team)) || null;
const SEV = { critical: 'crit', warning: 'warn', info: 'info' };
const AT = { key_in_payload: ['Leak', 'shield'], auth_bruteforce: ['Brute', 'lock'], login_burst: ['Logins', 'lock'], concurrent_use: ['Shared', 'key'], quota_trip: ['Quota', 'ban'], task_blocked: ['Blocked', 'warn'], checkpoint: ['Approve', 'check'], stalled_member: ['Stalled', 'clock'] };
const atype = (a) => AT[a.type] || [a.type.replace(/_/g, ' '), 'ban'];
const det = (a) => { try { return JSON.parse(a.details || '{}') || {}; } catch { return {}; } };

/* ---------- KPIs ---------- */
const H = {};
function kpiDefs() {
  const m = S.met, c = m?.counts || {}, sr = (k) => (m?.series?.[k] || []).map((x) => x.count), last = (k) => sr(k).slice(-1)[0] || 0;
  // alarm: the status class a figure takes only while it is in that state (otherwise it stays neutral)
  return [
    { id: 'ses', l: 'Sessions', go: 'sessions', v: c.live_agents || 0, of: c.agents || 0, series: sr('logins') },
    { id: 'pcs', l: 'PCs', go: 'pcs', v: S.top ? S.top.pcs.filter(pcOnline).length : c.pcs_online_bridge || 0, of: c.pcs || 0 },
    { id: 'req', l: 'Requests', go: 'req', v: S.reqs.length, alarm: 'warn' },
    { id: 'tasks', l: 'Tasks', go: 'teams', v: c.tasks_open || 0, series: sr('tasks_done') },
    { id: 'msgs', l: 'Msgs', u: '/h', go: 'chats', v: last('messages'), series: sr('messages') },
    { id: 'calls', l: 'Calls', u: '/h', v: last('tool_calls'), series: sr('tool_calls') },
    { id: 'deny', l: 'Denials', u: '/h', v: last('denials'), series: sr('denials'), alarm: 'bad' },
  ];
}
/* One card of seven figures. Phones read it as the stats grid (NOW, LAST HOUR; Requests live on the Security badge);
   from 768 px it is a strip of equal cells with a neutral sparkline each. */
function renderKpis() {
  const el = $('#kpis'), defs = kpiDefs();
  if (!el.children.length) {
    const cell = (k) => `<div class="kpi-c" data-k="${k.id}" ${k.go ? `data-go="${k.go}" tabindex="0" role="button"` : ''} aria-label="${k.l}${k.u || ''}"><span class="stat-v"><b data-v="0">0</b><small></small></span><span class="stat-l">${k.l}${k.u ? `<span class="u">${k.u}</span>` : ''}</span><span class="sp"></span></div>`;
    const by = Object.fromEntries(defs.map((k) => [k.id, k]));
    el.innerHTML = overline('Now') + ['ses', 'pcs', 'req', 'tasks'].map((i) => cell(by[i])).join('') + overline('Last hour') + ['msgs', 'calls', 'deny'].map((i) => cell(by[i])).join('');
  }
  for (const k of defs) {
    const c = el.querySelector(`[data-k=${k.id}]`);
    let ser = k.series;
    if (!ser) { const h = (H[k.id] = H[k.id] || []); h.push(k.v); if (h.length > 30) h.shift(); ser = h.length > 1 ? h : [k.v, k.v]; }
    tween(c.querySelector('b'), k.v); c.querySelector('small').textContent = k.of != null ? '/' + k.of : '';
    const alarm = k.alarm && k.v > 0 ? k.alarm : '';
    c.querySelector('.stat-v').className = 'stat-v' + (alarm ? ' ' + alarm : '');
    c.querySelector('.sp').innerHTML = spark(ser, 200, 24, alarm ? `var(--${alarm})` : 'var(--spark)', false);
  }
}
function tween(el, to) {
  const from = +el.dataset.v || 0; el.dataset.v = to;
  if (RM() || from === to) { el.textContent = fmt(to); return; }
  const t0 = performance.now();
  const st = (t) => { const p = Math.min(1, (t - t0) / 500), e = 1 - Math.pow(1 - p, 3); el.textContent = fmt(from + (to - from) * e); if (p < 1) requestAnimationFrame(st); };
  requestAnimationFrame(st);
}

/* ---------- fleet ---------- */
const pcOnline = (p) => p.status === 'active' && (p.bridge?.online || p.app_keys.some((k) => k.sessions.length));
const pcState = (p) => (p.status !== 'active' ? [p.status || 'Suspended', 'bad'] : pcOnline(p) ? ['Online', 'ok'] : p.bridge?.paired ? ['Offline', 'warn'] : ['Unpaired', 'warn']);
const cap = (s) => String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1);
/* Hub → PCs → apps. Phones read it as a list (a PC row with its apps indented under it); from 768 px the same nodes are spread across the card. */
function renderTopo() {
  const box = $('#topo'), T = S.top;
  if (!T || !T.pcs.length) { box.innerHTML = none('hub', 'No PCs paired yet'); $('#fleetN').textContent = ''; return; }
  const apps = (p) => p.app_keys.filter((a) => a.status !== 'revoked');
  const n = T.pcs.reduce((a, p) => a + apps(p).length, 0);
  $('#fleetN').textContent = `${T.pcs.length} PC${T.pcs.length === 1 ? '' : 's'} · ${n} app${n === 1 ? '' : 's'}`;
  const lane = (p) => { const [st, tone] = pcState(p);
    return `<div class="fl-lane">${row({ lead: ic('pc'), title: p.name, one: true, cls: 'fl-pc', trail: pill(cap(st), tone), attrs: { 'data-pc': p.id, title: p.name } })}<i class="fl-ln"></i>
      <div class="fl-apps">${apps(p).map((a) => { const live = a.sessions.length; return row({ lead: ic('app'), title: a.app || 'App', one: true, cls: 'fl-app', trail: live ? `<span class="ok-t">${live} live</span>` : '<span class="faint">No live session</span>', attrs: { 'data-key': a.id, title: a.app || '' } }); }).join('')}</div></div>`; };
  box.innerHTML = `<div class="fleet"><div class="fl-hub">${ic('hub')}<span class="tid">Hub</span></div><i class="fl-ln"></i><div class="fl-pcs">${T.pcs.map(lane).join('')}</div></div>`;
}

/* ---------- alerts + chips ---------- */
/* ---------- activity ---------- */
const SER = [['v', 'Vault', 'ser-v'], ['t', 'Tools', 'ser-t'], ['d', 'Denials', 'ser-d']];
function renderAct() {
  const box = $('#act'), W = box.clientWidth || $('#act').parentElement.clientWidth - 2 * 16; if (!(W > 0)) return; // hidden (another view is open): draw when shown
  const B = buckets(), quiet = !B.some((b) => b.v || b.t || b.d), NB = 60, Ht = W < 500 ? 150 : 190, pl = 30, pb = 20, pt = 6;
  const tot = B.map((b) => SER.reduce((a, s) => a + b[s[0]], 0)), mx = Math.max(Math.ceil(Math.max(...tot) / 4) * 4, 4);
  $('#actEmpty').hidden = !quiet; box.hidden = quiet;
  if (quiet) { box.onmousemove = box.onmouseleave = null; $('#actLg').innerHTML = ''; return; }
  const bw = (W - pl) / NB, y = (v) => pt + (Ht - pb - pt) * (1 - v / mx);
  let g = '';
  [0, 0.5, 1].forEach((f) => { const yy = y(mx * f); g += `<line class="gl" x1="${pl}" x2="${W}" y1="${yy}" y2="${yy}"/><text class="ax" x="${pl - 6}" y="${yy + 3.5}" text-anchor="end">${fmt(mx * f)}</text>`; });
  let r = '';
  B.forEach((b, i) => { let acc = 0; const x = pl + i * bw + bw * 0.14, w = Math.max(1, bw * 0.72); SER.slice().reverse().forEach((s) => { const v = b[s[0]]; if (!v) return; const y1 = y(acc + v), h = y(acc) - y1; r += `<rect x="${x.toFixed(1)}" y="${y1.toFixed(1)}" width="${w.toFixed(1)}" height="${Math.max(0, h - 0.6).toFixed(1)}" rx="1.5" class="${s[2]}" opacity="${i === NB - 1 ? 1 : 0.88}"/>`; acc += v; }); });
  const lab = [[0, '-60m'], [30, '-30m'], [NB - 1, 'now']].map(([i, t]) => `<text class="ax" x="${pl + i * bw + bw / 2}" y="${Ht - 5}" text-anchor="${i === 0 ? 'start' : i === NB - 1 ? 'end' : 'middle'}">${t}</text>`).join('');
  const html = `<svg viewBox="0 0 ${W} ${Ht}" height="${Ht}" role="img" aria-label="Activity">${g}${r}${lab}<rect id="hov" x="0" y="${pt}" width="${bw}" height="${Ht - pb - pt}" rx="3" class="f-text" opacity="0"/></svg>`;
  const svg = box.querySelector('svg'); if (svg) svg.outerHTML = html; else box.insertAdjacentHTML('afterbegin', html);
  $('#actLg').innerHTML = SER.map((s) => `<span><i class="${s[2]}"></i>${s[1]} <b class="txt">${fmt(B.reduce((a, b) => a + b[s[0]], 0))}</b></span>`).join('');
  box.onmousemove = (ev) => {
    const rc = box.getBoundingClientRect(), x = ev.clientX - rc.left, i = Math.floor((x - pl) / bw), tip = $('#tip'), hv = box.querySelector('#hov');
    if (i < 0 || i >= NB) { tip.style.display = 'none'; hv.setAttribute('opacity', 0); return; }
    hv.setAttribute('x', pl + i * bw); hv.setAttribute('opacity', 0.06);
    tip.innerHTML = `<div class="tip-h">${i === NB - 1 ? 'now' : '-' + (NB - 1 - i) + 'm'}</div>` + SER.map((s) => `<div><span><i class="${s[2]}"></i>${s[1]}</span><b>${B[i][s[0]]}</b></div>`).join('');
    tip.style.display = 'block'; tip.style.left = Math.min(x + 12, W - 110) + 'px'; tip.style.top = '8px';
  };
  box.onmouseleave = () => { $('#tip').style.display = 'none'; const hv = box.querySelector('#hov'); hv && hv.setAttribute('opacity', 0); };
}

/* ---------- keys table ---------- */
/* The key's state as a pill tone and its kind as words ("SES" and "APP" never appear in the UI). */
const KEY_TONE = { live: 'ok', new: 'info', idle: 'idle' };
const keyTone = (k) => KEY_TONE[stOf(k)[2]] || (k.effective_status === 'suspended' ? 'warn' : k.effective_status === 'expired' ? 'idle' : 'bad');
/* The status dot's class ("info" is the info button's class, so a new key's dot is "new"). */
const dotCls = (tone) => (tone === 'info' ? 'new' : tone);
const keyKind = (k) => (k.kind === 'app_key' ? 'App key' : 'Session key');
function keyRow(k) {
  const tone = keyTone(k), used = k.last_used_at ? ago(k.last_used_at) + ' ago' : 'never used';
  const meta = k.kind === 'app_key' ? ['App key', k.pc?.name, used].filter(Boolean).join(' · ') : `Session key · ${k.last_used_at ? 'seen ' + used : used}`;
  return row({ lead: `<i class="dot ${dotCls(tone)}"></i>`, dot: true, title: keyName(k), meta, attrs: { 'data-key': k.id }, cls: 'top' + (['revoked', 'expired'].includes(k.effective_status) ? ' dim' : ''),
    trail: `${k.pc?.name ? `<span class="tr-where">${esc(k.pc.name)}</span>` : ''}${pill(stOf(k)[1], tone)}` });
}
function renderKeys() {
  if (!$('#keys')) return;
  const f = S.f, rank = { live: 0, new: 1, idle: 2, susp: 3 };
  if (f.pc && !S.pcs.some((p) => p.id === f.pc)) f.pc = '';
  if (f.agent && !S.agents.some((a) => a.id === f.agent)) f.agent = '';
  const L = S.keys.filter((k) => (!f.kind || k.kind === f.kind) && (!f.status || k.effective_status === f.status) && (!f.pc || k.machine_id === f.pc || k.pc?.id === f.pc) && (!f.agent || k.agent_id === f.agent))
    .sort((a, b) => rank[stOf(a)[2]] - rank[stOf(b)[2]] || (b.last_used_at || b.created_at) - (a.last_used_at || a.created_at));
  $('#keyN').textContent = L.length;
  const groups = [['Active', (k) => !['revoked', 'expired'].includes(k.effective_status)], ['Expired', (k) => k.effective_status === 'expired'], ['Revoked', (k) => k.effective_status === 'revoked']];
  $('#keys').innerHTML = L.length ? groups.map(([name, fn]) => { const g = L.filter(fn); return g.length ? overline(name, g.length) + g.map(keyRow).join('') : ''; }).join('') : none('key', 'No keys');
  const n = [f.status, f.pc, f.agent].filter(Boolean).length, b = $('#fMore');
  if (b) { b.classList.toggle('on', n > 0); b.querySelector('.fcount').textContent = n ? ' · ' + n : ''; }
}
/* Filters: Status, PC and Agent in a sheet (a popover on desktop); the kind segment stays in the row. */
function openKeyFilters(btn) {
  const sel = (id, label, first, items, cur) => `<label class="fld"><span class="vlabel">${label}</span><select class="sel" id="${id}" aria-label="${label}"><option value="">${first}</option>${items.map(([v, l]) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
  const sh = openSheet({ title: 'Filter keys', anchor: btn, html: `<div class="sheet-form">
    ${sel('fStatus', 'Status', 'Any status', ['active', 'suspended', 'revoked', 'expired'].map((s) => [s, cap(s)]), S.f.status)}
    ${sel('fPc', 'PC', 'Any PC', S.pcs.map((p) => [p.id, p.name]), S.f.pc)}
    ${sel('fAgent', 'Agent', 'Any agent', S.agents.map((a) => [a.id, a.label]), S.f.agent)}
    <div class="sheet-acts"><button type="button" class="btn lg" id="fClear">Clear</button><button type="button" class="btn pri lg" data-sheet-close>Done</button></div></div>` });
  [['#fStatus', 'status'], ['#fPc', 'pc'], ['#fAgent', 'agent']].forEach(([s, key]) => ($(s, sh).onchange = () => { S.f[key] = $(s, sh).value; renderKeys(); }));
  $('#fClear', sh).onclick = () => { S.f.status = S.f.pc = S.f.agent = ''; $$('select', sh).forEach((x) => (x.value = '')); renderKeys(); };
}

/* ---------- refresh ---------- */
let busy = false;
async function refresh() {
  if (busy || !S.me) return; busy = true;
  try {
    const [k, p, a, al, iv, tp, mt, ss, tm, rq, lk, cf, ln, fc, dc, drp] = await Promise.all([api('/keys'), api('/pcs').catch(() => null), api('/agents'), api('/alerts?status=open'), api('/invocations'), api('/topology').catch(() => null), api('/metrics').catch(() => null), api('/sessions?all=1').catch(() => null), api('/teams').catch(() => null), api('/requests?status=pending').catch(() => null), api('/lockdown').catch(() => null), api('/vault/conflicts').catch(() => null), api('/links').catch(() => null), api('/feedback/counts').catch(() => null), api('/decisions?status=open').catch(() => null), api('/directives/unreviewed-count').catch(() => null)]);
    if (!S.tpl.length) S.tpl = (await api('/templates')).templates;
    S.keys = k.keys; S.pcs = p ? p.pcs : [...new Map(k.keys.filter((x) => x.pc).map((x) => [x.pc.id, x.pc])).values()]; S.agents = a.agents; S.alerts = al.alerts; S.inv = iv.invocations;
    S.top = tp; S.met = mt; S.ses = ss ? ss.sessions : []; S.teams = tm ? tm.teams : []; S.reqs = rq ? rq.requests : []; S.lock = lk; S.conf = cf ? cf.conflicts : []; S.links = ln ? ln.links : S.links; S.fbc = fc || S.fbc; S.dec = dc ? dc.decisions : S.dec || []; S.dirU = drp ? drp.count : S.dirU || 0;
    renderAll(); $('#liveDot').classList.add('pulse'); $('#liveDot').classList.remove('bad');
    // Not while a sheet is open: the redraw would close it under the operator's hands.
    if (!viewLoading && !SHEET && ['team', 'teams', 'sessions', 'plan', 'tasks', 'members', 'feedback', 'decisions', 'directives'].includes(DR.type) && !viewInUse()) {
      const f = focusSel(); await openD(DR.type, DR.arg, true); if (f) $(f)?.focus({ preventScroll: true });
    }
  } catch (e) { if (e.status !== 401) { $('#liveDot').classList.remove('pulse'); $('#liveDot').classList.add('bad'); } } finally { busy = false; }
}
/* While a workspace view covers the overview, draw only what stays on screen; closeD() redraws the overview. */
function renderAll() {
  const ov = !$('#overview').hidden;
  if (ov) { renderKpis(); renderTopo(); renderAct(); renderSes(); renderTeamsCard(); loadTree(); renderTree(); }
  renderAlerts(ov); renderAgentGraph(); renderKeys(); renderLock(); tipIcons();
}
/* The background refresh does not redraw a view the user is working in: a focused field, or edits since it was drawn
   (a redraw would put the saved values back, and Save would then save those). */
let viewEdited = false;
const markEdited = () => { viewEdited = true; };
['input', 'change'].forEach((ev) => $('#dB').addEventListener(ev, markEdited));
const viewInUse = () => viewEdited || !!(document.activeElement?.matches('input,textarea,select') && $('#dB').contains(document.activeElement));
// Which control had focus, by id or its first data-* attribute, so focus can return to it after a redraw.
const focusSel = () => {
  const a = document.activeElement; if (!a || a === $('#dB') || !$('#dB').contains(a)) return null;
  if (a.id) return '#' + CSS.escape(a.id);
  const d = [...a.attributes].find((x) => x.name.startsWith('data-'));
  return d ? `#dB ${a.localName}[${d.name}="${CSS.escape(d.value)}"]` : null;
};

/* ---------- main content ---------- */
const DR = { type: null, arg: null, stack: [] };
let lastFocus = null;
let viewRequest = 0;
let viewLoading = false;
async function openD(type, arg, replace, reset = false) {
  closeSheet(); // a sheet belongs to the screen it was opened on
  // From 1024 px a directive opens beside the list (Work → Directives), keeping the list's filters when it is already open.
  if (type === 'directive' && dirWide() && RID.test(String(arg))) { const f = (DR.type === 'directives' && dirArgs(DR.arg)) || dirArgs(''); type = 'directives'; arg = dirArgStr({ ...f, d: String(arg) }); }
  const request = ++viewRequest;
  viewLoading = true;
  let r;
  try { r = await VIEWS[type](arg); }
  catch (e) { if (request === viewRequest && e.status !== 401) toast(e.message, true); return; }
  finally { if (request === viewRequest) viewLoading = false; }
  if (request !== viewRequest) return;
  if (reset) DR.stack = [];
  else if (DR.type && !replace && (DR.type !== type || DR.arg !== arg)) DR.stack.push([DR.type, DR.arg]);
  else if (!DR.type) DR.from = ['home']; // opened from the overview (no view was open): Back returns there
  if ($('#workspaceView').hidden) lastFocus = document.activeElement;
  DR.type = type; DR.arg = arg;
  $('#dT').innerHTML = r.t; $('#dA').innerHTML = r.a || ''; $('#dB').innerHTML = r.b; viewEdited = false;
  PAGE_MENU = (r.pmenu || []).filter(Boolean);
  $('#ctxBar').innerHTML = r.bar || '';
  $('#dBack').hidden = !DR.stack.length || !!r.bar;
  // Views opened from a tab bar already carry their name in that bar: drop the card header and put its buttons at the bar's right end.
  const host = r.bar ? $('#ctxBar') : TAB_BAR[type] && $(TAB_BAR[type]);
  clearBarActions();
  $('#viewHeader').hidden = !!host;
  if (host && r.a) host.insertAdjacentHTML('beforeend', `<div class="ws-act">${r.a}</div>`);
  const workspace = $('#workspaceView');
  workspace.dataset.view = type; workspace.dataset.area = areaOf(type) || '';
  setDetailBar(r.dbar);
  $('#overview').hidden = true;
  workspace.hidden = false;
  navOn(type, arg, !!r.bar);
  r.after && r.after();
  tipIcons(workspace); tipIcons($('#ctxBar')); tabsReveal(workspace); ['#securityBar', '#vaultBar', '#auditBar'].forEach((b) => tabsReveal($(b)));
  if (!replace) {
    window.scrollTo(0, 0);
    $('#dT').focus({ preventScroll: true });
  }
  setRoute(type, type === 'key' ? String(arg).split('|')[0] + '|' + keyTab : arg, !replace);
}
/* The current view lives in the URL hash: #type or #type/arg (objects as JSON), so refresh and Back/Forward work. */
const routeOf = (type, arg) => '#' + type + (arg === undefined || arg === null || arg === '' ? '' : '/' + encodeURIComponent(typeof arg === 'object' ? JSON.stringify(arg) : String(arg)));
function setRoute(type, arg, push) {
  const h = routeOf(type, arg);
  if (location.hash !== h) history[push ? 'pushState' : 'replaceState'](null, '', h);
}
/* Route args come from the URL, which anyone can link to (an agent can write such a link into a note or a report).
   Views that take ids accept only well-formed ids; the vault's JSON state is rebuilt field by field. */
const RID = /^[a-z]+[_-][A-Za-z0-9_-]+$/;
const ROUTE_OK = {
  key: (a) => RID.test(a.split('|')[0]), ses: (a) => RID.test(a.split('|')[0]),
  team: (a) => RID.test(a), tstatus: (a) => RID.test(a),
  tasks: (a) => { const [i, f = ''] = a.split('|'); return RID.test(i) && /^[a-z]*$/.test(f); }, members: (a) => RID.test(a), tsettings: (a) => RID.test(a),
  plan: (a) => { const [i, k = 'req', f = ''] = a.split('|'); return RID.test(i) && ['req', 'ms'].includes(k) && /^[a-z]*$/.test(f); }, room: (a) => RID.test(a), share: (a) => RID.test(a), app: (a) => !a || RID.test(a),
  task: (a) => { const p = a.split('|'); return p.length === 2 && p.every((x) => RID.test(x)); },
  feedback: (a) => ['', 'new', 'open', 'closed'].includes(a), fbr: (a) => RID.test(a),
  directive: (a) => RID.test(a), directives: (a) => !!dirArgs(a), teams: (a) => !!tmArgs(a),
  dec: (a) => RID.test(a), decisions: (a) => { const [i, f = ''] = a.split('|'); return RID.test(i) && ['', 'open', 'answered', 'all'].includes(f); },
  diff: (a) => { const [f, from = '', to] = a.split('|'); return RID.test(f) && (from === 'absent' || RID.test(from)) && (!to || RID.test(to)); },
};
const cleanVault = (s) => ({
  tab: ['contents', 'access', 'act', 'conf'].includes(s.tab) ? s.tab : 'contents', path: typeof s.path === 'string' && s.path.startsWith('/') ? s.path : vaultRoot(),
  file: !!s.file, agent: typeof s.agent === 'string' && RID.test(s.agent) ? s.agent : '', collapsed: typeof s.collapsed === 'string' ? s.collapsed : null,
});
function restoreRoute() {
  const home = () => { $('#overview').dataset.mode = 'home'; closeD(); };
  // No hash is the page as first opened: Back from the first view returns to the overview.
  if (!location.hash || location.hash === '#') { if (!$('#workspaceView').hidden) home(); return true; }
  const m = /^#([a-z]+)(?:\/(.*))?$/.exec(location.hash); if (!m) return false;
  const type = m[1]; let arg;
  try { arg = m[2] === undefined ? undefined : decodeURIComponent(m[2]); } catch { arg = undefined; }
  if (arg && arg[0] === '{') { try { arg = JSON.parse(arg); } catch { arg = undefined; } }
  if (type === 'home' || type === 'monitoring') { go(type); return true; }
  if (!VIEWS[type]) return false;
  if (arg && typeof arg === 'object') arg = type === 'vault' ? cleanVault(arg) : undefined;
  const ok = ROUTE_OK[type];
  if (ok && !ok(arg == null ? '' : String(arg))) { home(); setRoute('home', null, false); return true; }
  DR.from = null; // browser Back/Forward: the history itself is the way back
  openD(type, arg, false, true);
  return true;
}
addEventListener('popstate', () => { if (S.me) restoreRoute(); });
function closeD() {
  closeSheet();
  ++viewRequest;
  viewLoading = false;
  $('#workspaceView').hidden = true; $('#overview').hidden = false; clearBarActions(); setDetailBar(null);
  DR.type = null; DR.stack = []; $('#dB').innerHTML = ''; PAGE_MENU = [];
  navOn($('#overview').dataset.mode);
  // The overview was not redrawn while hidden (renderAll): draw it fresh now that it shows.
  if (S.me) renderAll();
  lastFocus && lastFocus.focus && lastFocus.isConnected && lastFocus.focus({ preventScroll: true });
  lastFocus = null;
}
function back() { const p = DR.stack.pop(); if (p) { openD(p[0], p[1], true); window.scrollTo(0, 0); } }
const TAB_BAR = { keys: '#securityBar', pcs: '#securityBar', req: '#securityBar', shares: '#securityBar', grant: '#securityBar', reset: '#securityBar', topology: '#agentsBar', sessions: '#agentsBar', teams: '#agentsBar', chats: '#agentsBar', feedback: '#agentsBar', log: '#auditBar' };
const clearBarActions = () => $$('.ws-act').forEach((x) => x.remove());
/* The area a screen belongs to; the rail, the bottom nav and the bar titles all follow it (detail screens included). */
const AREA = {
  security: ['security', 'keys', 'key', 'new', 'app', 'pcs', 'req', 'shares', 'share', 'grant', 'reset', 'lock'],
  agents: ['agents', 'teams', 'topology', 'sessions', 'chats', 'team', 'task', 'tstatus', 'plan', 'tasks', 'members', 'tsettings', 'tbuild', 'room', 'ses', 'feedback', 'fbr', 'dec', 'decisions', 'directives', 'directive'],
  vault: ['vault', 'diff'],
  log: ['log'],
  home: ['home', 'monitoring'],
};
const areaOf = (t) => Object.keys(AREA).find((a) => AREA[a].includes(t)) || null;
const AREA_TITLE = { home: 'Overview', agents: 'Work', vault: 'Vault', security: 'Security', log: 'Audit' };
function navOn(t, arg, ctx = false) {
  const securityTab = { keys: 'keys', key: 'keys', pcs: 'pcs', req: 'req', shares: 'shares', share: 'shares', grant: 'grant', new: 'grant', app: 'grant', reset: 'reset' }[t];
  const agentTab = { topology: 'topology', sessions: 'sessions', ses: 'sessions', teams: 'teams', team: 'teams', plan: 'teams', tasks: 'teams', members: 'teams', tsettings: 'teams', tbuild: 'teams', chats: 'chats', room: 'chats', feedback: 'feedback', fbr: 'feedback', dec: 'teams', decisions: 'teams', directives: 'directives', directive: 'directives' }[t];
  const area = t ? areaOf(t) : 'home';
  const highlight = (button, active) => {
    button.classList.toggle('on', active);
    if (button.getAttribute('role') === 'tab') button.setAttribute('aria-selected', String(active));
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  };
  const bars = { security: '#securityBar', agents: '#agentsBar', vault: '#vaultBar', log: '#auditBar' };
  Object.entries(bars).forEach(([a, sel]) => { $(sel).hidden = ctx || a !== area; });
  $('#ctxBar').hidden = !ctx;
  const act = $('#appAct'); act.hidden = !((area === 'agents' || area === 'security') && !ctx);
  // One app-bar "+": a new team in Agents, a new key (session or app, in a sheet) in Security.
  if (area === 'security') { act.removeAttribute('data-go'); act.setAttribute('data-new-key', ''); act.setAttribute('aria-label', 'New key'); }
  else { act.removeAttribute('data-new-key'); act.dataset.go = 'tbuild'; act.setAttribute('aria-label', 'New team'); }
  $('#pageTitle').textContent = AREA_TITLE[area] || { account: 'Account', shortcuts: 'Shortcuts' }[t] || 'Overview';
  $$('.nav[data-go],.bnav [data-go]').forEach((button) => highlight(button, button.dataset.go === area));
  $$('#securityBar [data-go]').forEach(button => highlight(button, button.dataset.go === securityTab));
  $$('#agentsBar [data-go]').forEach(button => highlight(button, button.dataset.go === agentTab));
  $$('#auditBar [data-arg]').forEach(button => highlight(button, t === 'log' && button.dataset.arg === String(arg || 'audit').split('|')[0]));
  $$('#vaultBar [data-vault-tab]').forEach(button => highlight(button, t === 'vault' && button.dataset.vaultTab === vaultState(arg).tab));
}
function go(t, arg) {
  if (t === 'security') t = 'keys';
  if (t === 'agents') t = 'teams';
  if (t === 'monitoring') t = 'home';
  if (t === 'home') {
    $('#overview').dataset.mode = 'home';
    closeD();
    setRoute('home', null, true);
    window.scrollTo(0, 0);
  }
  else if (t === 'theme') setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  else { DR.from = DR.type ? [DR.type, DR.arg] : ['home']; openD(t, arg, false, true); }
}
function setTheme(th) {
  document.documentElement.dataset.theme = th;
  $$('.th-ic use').forEach((u) => u.setAttribute('href', th === 'dark' ? '#i-sun' : '#i-moon'));
  try { localStorage.setItem('ah-theme', th); } catch { /* ignore */ }
  setTimeout(renderTopo, 0);
}
const dotH = (k) => `<span class="dot lg ${dotCls(keyTone(k))}"></span>`;

/* ---------- secret result view ---------- */
function secretView(res, title) {
  const sec_ = res.secret, k = res.key, mask = sec_.slice(0, 13) + '•'.repeat(18);
  $('#dA').innerHTML = ''; $('#dBack').hidden = !DR.stack.length; navOn(DR.type, DR.arg);
  setDetailBar({ title: title || keyName(k), meta: 'Copy the key now. It is shown once.' });
  clearBarActions(); $('#viewHeader').hidden = false;
  let b = sec('Key', `<div class="keyv" data-v="${esc(sec_)}"><span class="mono" id="kV">${mask}</span><button class="btn ic sm" id="kE" aria-label="Reveal">${ic('eye')}</button><button class="btn ic sm" data-copy aria-label="Copy">${ic('copy')}</button></div>`, `<span class="tag ml-auto">Once</span>`);
  if (res.handoff) b += sec('Handoff', codeBox(res.handoff, true));
  if (res.setup) {
    b += sec('Claude Code', codeBox(res.setup.claude_code));
    b += sec('Codex', codeBox(res.setup.codex_env) + '<div class="sp-2"></div>' + codeBox(res.setup.codex_config_toml));
  }
  b += `<div class="wait" id="wS"><span class="dot pulse"></span><span id="wL">Waiting</span><span class="grow"></span><span class="mono muted" id="wT">0s</span></div><div class="row"><button class="btn sm" data-key="${esc(k.id)}">${ic('key')}Open</button></div>`;
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
const EXP = [['1d', 1], ['7d', 7], ['30d', 30], ['Never', 0]];
const OPS = ['list', 'read', 'search', 'create', 'update', 'rename', 'delete', 'history'];
const OPL = Object.fromEntries(OPS.map((o) => [o, cap(o)]));
const SIMA = ['tool.invoke', ...OPS.map((o) => 'fs.' + o), 'fs.download', 'fs.restore'];
/* Reach groups: [label, icon, globs used by Allow all / Deny all (null = per tool only)] */
const TG = [['Files', 'file', ['file_*']], ['Messages', 'chat', ['message_*', 'agent_list']], ['Rooms', 'team', ['room_*']], ['Teams and tasks', 'team', ['team_*', 'work_*', 'task_*']], ['Shares', 'link', ['share_*']], ['Channels', 'dl', ['channel_*']], ['Knowledge graph', 'hub', ['graph_*']], ['Access and setup', 'key', ['access_*', 'setup_*']], ['Other', 'app', null]];
const toolGroup = (t) => (TG.find(([, , g]) => g && g.some((p) => (p.endsWith('*') ? t.startsWith(p.slice(0, -1)) : t === p))) || TG.at(-1))[0];
const isToolRule = (r) => r.actions.length === 1 && r.actions[0] === 'tool.invoke' && r.resource.startsWith('tool:');
const ACTN = { 'tool.invoke': 'Use tool', 'fs.list': 'List', 'fs.read': 'Read', 'fs.search': 'Search', 'fs.create': 'Create', 'fs.update': 'Edit', 'fs.rename': 'Rename', 'fs.delete': 'Delete', 'fs.history': 'History', 'fs.download': 'Download', 'fs.restore': 'Restore' };
const effPill = (e) => pill(e === 'allow' ? 'Allow' : 'Deny', e === 'allow' ? 'ok' : 'bad');
const KEY_TABS = [['overview', 'Overview', 'key'], ['access', 'Access', 'vault'], ['reach', 'Reach', 'shield'], ['rules', 'Rules', 'sl'], ['simulate', 'Simulate', 'play']];
let keyTab = 'overview', lastKeyId = null;
const tick = (box, fn) => { box.onclick = (e) => { const b = e.target.closest('button'); if (!b) return; $$('button', box).forEach((x) => x.classList.remove('on')); b.classList.add('on'); fn && fn(b); }; };

const VIEWS = {
  async grant() {
    // Two list rows, each a flow: the title says what it is, one line says what you get.
    const flow = (icn, title, meta, go) => row({ lead: `<span class="av lg">${ic(icn)}</span>`, title, meta, chev: true, attrs: { 'data-grant-flow': go } });
    return {
      t: `${ic('shield')}Grant access`,
      b: `<div class="pcard">${flow('key', 'Agent session', 'A session key for a new or existing agent', 'new')}${flow('pc', 'Device and app', 'An app key so a client can connect from a PC', 'app')}</div>`,
    };
  },
  async new(arg) {
    if (!S.tpl.length) S.tpl = (await api('/templates')).templates;
    const ag = (S.agents || []).filter((a) => a.status !== 'revoked');
    return {
      t: `${ic('key')}New session key`,
      dbar: { title: 'New session key', meta: 'A key for an agent' },
      b: `<div class="pcard kform">
          <label class="fld"><span class="vlabel">Agent</span><select class="sel" id="nA" aria-label="Agent"><option value="">New agent</option>${ag.map((a) => `<option value="${esc(a.id)}">${esc(a.label)}${a.role ? ' · ' + esc(a.role) : ''}</option>`).join('')}</select></label>
          <label class="fld"><span class="vlabel">Label</span><input class="inp" id="nL" autocomplete="off" aria-label="Label" maxlength="80"></label>
          <div class="fld"><span class="vlabel" id="nTl">Template</span><div class="seg fit only-d" id="nT" role="group" aria-labelledby="nTl"><button type="button" class="on" data-v="">None</button>${S.tpl.map((t) => `<button type="button" data-v="${esc(t.id)}">${esc(t.name)}</button>`).join('')}</div><select class="inp only-m" id="nTs" aria-labelledby="nTl"><option value="">None</option>${S.tpl.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('')}</select></div>
          <div class="fld"><span class="vlabel" id="nEl">Expiry</span><div class="seg" id="nE" role="group" aria-labelledby="nEl">${EXP.map(([l, d]) => `<button type="button" data-d="${d}" class="${d === 7 ? 'on' : ''}">${l}</button>`).join('')}</div></div>
        </div>
        <div class="actionbar"><button type="button" class="btn pri lg" id="nGo">${ic('key')}Create key</button></div>`,
      after() {
        tick($('#nT')); tick($('#nE'));
        /* Phones pick the template from a select (five or more names do not fit a segment); it drives the same #nT state the submit reads. */
        $('#nTs').onchange = (e) => $$('#nT button').forEach((x) => x.classList.toggle('on', x.dataset.v === e.target.value));
        $('#nT').addEventListener('click', (e) => { const x = e.target.closest('button'); if (x) $('#nTs').value = x.dataset.v; });
        $('#nGo').onclick = () => run(async () => {
          const label = $('#nL').value.trim(); if (!label) { $('#nL').focus(); return toast('Give the key a label', true); }
          const aid = $('#nA').value, d = +$('#nE .on').dataset.d, tid = $('#nT .on').dataset.v;
          const res = await post('/keys', { kind: 'session_key', ...(aid ? { agent_id: aid } : { new_agent: { label } }), label, template_id: tid || null, expires_at: d ? Date.now() + d * 864e5 : null });
          refresh(); const v = secretView(res, label); $('#dT').innerHTML = v.t; $('#dB').innerHTML = v.b; v.after();
        });
      },
    };
  },

  async app(pcId) {
    return {
      t: `${ic('app')}New app key`,
      dbar: { title: 'New app key', meta: 'A key for an app on a PC' },
      b: `<div class="pcard kform">
          <label class="fld"><span class="vlabel">PC</span><select class="sel" id="aP" aria-label="PC"><option value="">New PC</option>${S.pcs.map((p) => `<option value="${esc(p.id)}"${p.id === pcId ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
          <label class="fld" id="aPw"><span class="vlabel">PC name</span><input class="inp mono" id="aPn" aria-label="PC name" maxlength="60" autocomplete="off"></label>
          <div class="fld"><span class="vlabel" id="aTl">App</span><div class="seg fit" id="aT" role="group" aria-labelledby="aTl">${['Claude Code', 'Claude Desktop', 'Codex'].map((n, i) => `<button type="button" class="${i === 0 ? 'on' : ''}" data-v="${n}">${n}</button>`).join('')}</div></div>
          <label class="fld"><span class="vlabel">App name (optional)</span><input class="inp" id="aN" aria-label="App name" maxlength="60" autocomplete="off"></label>
        </div>
        <div class="actionbar"><button type="button" class="btn pri lg" id="aGo">${ic('app')}Create key</button></div>`,
      after() {
        const sync = () => { $('#aPw').hidden = !!$('#aP').value; }; $('#aP').onchange = sync; sync();
        tick($('#aT'), (b) => { $('#aN').value = ''; $('#aN').dataset.t = b.dataset.v; });
        $('#aGo').onclick = () => run(async () => {
          let pid = $('#aP').value;
          if (!pid) { const n = $('#aPn').value.trim(); if (!n) { $('#aPn').focus(); return toast('Name the PC', true); } pid = (await post('/pcs', { name: n })).pc.id; }
          const app = $('#aN').value.trim() || $('#aT .on').dataset.v;
          const res = await post('/keys', { kind: 'app_key', machine_id: pid, app_name: app });
          refresh(); const v = secretView(res, app); $('#dT').innerHTML = v.t; $('#dB').innerHTML = v.b; v.after();
        });
      },
    };
  },

  async log(arg = 'audit') {
    const [tab, pre, r] = String(arg).split('|');
    if (tab === 'alerts') return auditAlerts(pre);
    if (tab === 'calls') return auditCalls(pre, r);
    if (tab === 'files') return auditFiles(pre);
    if (tab === 'telemetry') return auditTelemetry();
    return auditEvents(pre);
  },

  async keys() {
    return {
      t: `${ic('key')}Keys <span class="n" id="keyN">0</span>`,
      a: `<button class="btn sm" data-go="new">${ic('plus')}Session</button><button class="btn sm" data-go="app">${ic('plus')}App</button>`,
      b: vtools(`<div class="seg" id="fKind" role="group" aria-label="Kind">${[['', 'All'], ['session_key', 'Session'], ['app_key', 'App']].map(([v, l]) => `<button type="button" data-v="${v}" class="${S.f.kind === v ? 'on' : ''}">${l}</button>`).join('')}</div>
        <button type="button" class="btn" id="fMore" aria-haspopup="dialog">${ic('sl')}Filters<span class="fcount"></span></button>`) +
        `<div class="pcard" id="keys"></div>`,
      after() {
        $('#fKind').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; $$('#fKind button').forEach((x) => x.classList.toggle('on', x === b)); S.f.kind = b.dataset.v; renderKeys(); };
        $('#fMore').onclick = (e) => openKeyFilters(e.currentTarget);
        renderKeys();
      },
    };
  },

  /* Account: the same content as the phone account sheet (admin, two-factor, theme, sign out), as a screen. */
  async account() {
    const me = S.me, dark = document.documentElement.dataset.theme === 'dark';
    return {
      t: `${ic('user')}${esc(me.username)}`,
      dbar: { title: me.username, meta: 'Administrator' },
      b: `<div class="pcard kvc acc">${kv('Admin', esc(me.username))}${kv('Two-factor', me.totp_enrolled ? pill('On', 'ok') : `<button type="button" class="btn sm" id="tGo">Set up ›</button>`)}${kv('Theme', `<button type="button" class="btn sm" id="thB">${ic(dark ? 'moon' : 'sun')}${dark ? 'Dark' : 'Light'}</button>`)}</div>
        <div id="tB"></div>
        <div class="pcard kvc"><button type="button" class="sheet-item bad" id="lo">${ic('out')}<span>Sign out</span></button></div>`,
      after() {
        $('#lo').onclick = () => run(signOut);
        $('#thB').onclick = () => { go('theme'); reopen(); };
        const g = $('#tGo'); if (!g) return;
        g.onclick = () => run(async () => {
          const r = await post('/totp/enroll');
          $('#tB').innerHTML = `<div class="pcard">${codeBox(r.secret)}<div class="sp-2"></div>${codeBox(r.otpauth_uri)}<div class="row mt-3"><input class="inp mono w-code" id="tC" inputmode="numeric" maxlength="6" placeholder="000000" aria-label="Code" autocomplete="one-time-code"><button type="button" class="btn pri" id="tOk">${ic('check')}Confirm</button></div></div>`;
          $('#tC').focus();
          $('#tOk').onclick = () => run(async () => { await post('/totp/confirm', { code: $('#tC').value.trim() }); S.me.totp_enrolled = true; toast('Two-factor is on'); renderAlerts(); openD('account', null, true); });
        });
      },
    };
  },

  async shortcuts() {
    const L = [['S', 'Sessions'], ['M', 'Teams'], ['C', 'Chats'], ['K', 'Keys'], ['P', 'PCs'], ['V', 'Vault'], ['R', 'Requests'], ['H', 'Shares'], ['O', 'Lockdown'], ['G', 'Work'], ['L', 'Audit'], ['T', 'Theme'], ['J / K', 'Next or previous (Directives, feedback report)'], ['Esc', 'Back']];
    // Touch devices have no keyboard: they get a one-line note instead of the list (CSS, @media (hover: none)).
    return { t: `${ic('kbd')}Shortcuts`, dbar: { title: 'Shortcuts', meta: 'Keyboard' },
      b: `<div class="pcard kb-list">${L.map(([k, l]) => `<span class="kbd">${k}</span><span>${l}</span>`).join('')}</div><p class="kb-note hint">Keyboard shortcuts are available with a keyboard.</p>` };
  },

  /* Key detail. Phones: detail app bar (End logins, Suspend/Resume and Revoke in its overflow) + scrollable tabs; desktop: the context bar with the section switch. */
  async key(arg) {
    // 'crd_…|rules' opens that tab directly (the URL, "N rules" links in Auditing).
    const [id, tab] = String(arg).split('|'), kp = '/keys/' + encodeURIComponent(id);
    const [d, rl, vs, ef, inv] = await Promise.all([api(kp), api(`${kp}/rules`), api(`${kp}/versions`), api(`${kp}/effective`), api(`/invocations?credential=${encodeURIComponent(id)}&since=${Date.now() - 3600_000}&limit=2000`)]);
    if (tab) { keyTab = KEY_TABS.some(([t]) => t === tab) ? tab : 'overview'; lastKeyId = id; }
    else if (id !== lastKeyId) { keyTab = 'overview'; lastKeyId = id; }
    const keyTitle = (p) => { const [, l, icn] = KEY_TABS.find((x) => x[0] === p); return ic(icn) + l; };
    const k = d.key, alias = S.me.vault_alias, isApp = k.kind === 'app_key', dead = k.effective_status === 'revoked';
    const st = stOf(k);
    // Counts are this key's own calls in the last hour (fetched for the key, not the console's recent sample).
    const hour = inv.invocations.filter((i) => Date.now() - i.created_at < 3600_000);
    const calls = hour.length, den = hour.filter((i) => i.result === 'denied').length;
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
    // The template is whichever template the key's rules were copied from.
    const tplName = [...new Set(rl.rules.map((r) => r.from_template).filter(Boolean).map((t) => t.replace(/@\d+$/, '')))].join(', ') || 'None';
    const act = (fn, msg) => run(async () => { await fn(); toast(msg); await refresh(); openD('key', id, true); });
    const doSus = () => act(() => post(`${kp}/suspend`), 'Suspended');
    const doRe = () => act(() => post(`${kp}/reactivate`), 'Resumed');
    const doEnd = () => act(() => post(`${kp}/end-logins`), 'Ended');
    const doRev = () => act(() => post(`${kp}/revoke`), 'Revoked');
    const doRot = () => run(async () => { const r = await post(`${kp}/rotate`); refresh(); const v = secretView(r, keyName(k)); $('#dT').innerHTML = v.t; $('#dB').innerHTML = v.b; v.after(); });

    /* Access: the matrix on desktop, folder rows on phones. Both read the same grid state (E.M). */
    const cellOf = (r, o) => { const v = E.M[r.res][o]; if (v) return v; return !r.root && E.M[rows[0].res][o] === 'a' ? 'i' : ''; };
    const cic = { a: 'check', d: 'x' };
    const mxHtml = () => `<div class="mx"><span></span>${OPS.map((o) => `<span class="ch">${o}</span>`).join('')}${rows.map((r, ri) => `<span class="rh">${ic(r.root ? 'hub' : 'vault')}<span class="ellip">${esc(r.label)}</span></span>${OPS.map((o) => { const v = cellOf(r, o); return `<button class="cell c-${v || 'n'}${v === 'i' ? ' nc' : ''}" data-r="${ri}" data-o="${o}" aria-label="${esc(r.label)} ${o} ${v || 'none'}">${cic[v] ? ic(cic[v]) : ''}</button>`; }).join('')}`).join('')}</div>`;
    const foldName = (r) => (r.root ? 'Vault root' : r.label);
    const foldSum = (r) => {
      const own = OPS.some((o) => E.M[r.res][o]), yes = OPS.filter((o) => ['a', 'i'].includes(cellOf(r, o))), no = OPS.filter((o) => cellOf(r, o) === 'd');
      if (!own) return yes.length ? 'Inherited' : 'No access';
      return [...yes.map((o) => OPL[o]), ...(no.length ? [`${no.length} denied`] : [])].join(' · ') || 'No access';
    };
    const foldRows = () => rows.map((r, ri) => row({ lead: ic(r.root ? 'hub' : 'vault'), title: foldName(r), meta: foldSum(r), chev: true, attrs: { 'data-fold': ri } })).join('');
    const accHtml = () => `<div class="only-d">${mxHtml()}</div><div class="only-m">${foldRows()}</div>`;

    /* Rules: rows, the add-rule form in a sheet. */
    const othHtml = () => {
      const L = E.other.map((r, i) => [r, i]).filter(([r]) => !isToolRule(r));
      return `<div class="ohd">${overline('Other rules', L.length)}<button type="button" class="btn sm" data-rnew>${ic('plus')}Rule</button></div>${L.length ? L.map(([r, i]) => row({
        title: raw(`<span class="mono" title="${esc(r.actions.join(', '))}">${esc(r.actions.join(', '))}</span>`),
        meta: raw(`${r.from_template ? `From ${esc(r.from_template.replace(/@\d+$/, ''))} · ` : ''}<span class="tid" title="${esc(r.resource)}">${esc(midTrunc(r.resource.replace(/^(path|tool):/, ''), 40))}</span>`),
        trail: `${effPill(r.effect)}<button type="button" class="btn ic sm" data-del="${i}" aria-label="Remove rule">${ic('x')}</button>` })).join('') : none('sl', 'No other rules')}`;
    };
    const appKeys = S.keys.filter((x) => x.kind === 'app_key' && x.status !== 'revoked');
    const exp = k.expires_at, expText = exp ? `${new Date(exp).getDate()} ${MON[new Date(exp).getMonth()]}` : 'Never';

    /* Reach: tools by group (a row per group on phones, with a sheet for the allow/deny controls), then the folders. */
    const toolOn = (t) => (t.tool in E.pend ? E.pend[t.tool] : t.allowed);
    const reachGroups = () => {
      const tools = E.ef.tools.filter((t) => t.reason !== 'always available when logged in');
      return TG.map(([name, icon, globs]) => ({ name, icon, globs, tools: tools.filter((t) => toolGroup(t.tool) === name) })).filter((g) => g.tools.length);
    };
    const gCount = (g) => { const on = g.tools.filter(toolOn).length, n = g.tools.length; return [on, n, on === n ? 'All' : on ? `${on} of ${n}` : 'None']; };
    const reach = (e) => {
      E.ef = e;
      const groups = reachGroups();
      const grp = (g) => {
        const [on, n, count] = gCount(g), pend = g.tools.some((t) => t.tool in E.pend);
        return `<details class="rgrp" data-g="${esc(g.name)}"${E.open.has(g.name) ? ' open' : ''}><summary>
          <span class="ci">${ic(g.icon)}</span><b>${esc(g.name)}${pend ? ' <span class="tag pend">Unsaved</span>' : ''}</b>
          <span class="rbar" aria-hidden="true"><i style="width:${Math.round((on / n) * 100)}%"></i></span>
          <span class="rcount${on === n ? ' all' : on ? '' : ' none'}">${count}</span>
          <span class="rga">${g.globs ? `<button class="btn sm" data-ga="allow" data-g="${esc(g.name)}">Allow all</button><button class="btn sm" data-ga="deny" data-g="${esc(g.name)}">Deny all</button>` : ''}</span>
          ${ic('chev', 'rgo')}</summary>
          <div class="rtools">${g.tools.map((t) => { const y = toolOn(t), p = t.tool in E.pend; return `<button class="rtool${y ? ' y' : ''}${p ? ' p' : ''}" data-tt="${esc(t.tool)}" title="${esc(p ? 'Unsaved change' : t.reason)}">${ic(y ? 'check' : 'x')}<span>${esc(t.tool)}</span></button>`; }).join('')}</div></details>`;
      };
      const mob = (g) => { const [on, n, count] = gCount(g), pend = g.tools.some((t) => t.tool in E.pend);
        return row({ one: true, lead: ic(g.icon), title: g.name, trail: `${pend ? pill('Unsaved', 'info') : ''}<span class="rg-v${on === n || on ? '' : ' none'}">${count}</span>`, chev: true, attrs: { 'data-rg': g.name } }); };
      const fold = (name, f, root) => row({ one: true, lead: ic(root ? 'hub' : 'vault'), title: name, trail: ['list', 'read'].map((o) => pill(OPL[o], f[o] ? 'ok' : 'idle')).join('') });
      return `${overline('Tools', groups.length)}<div class="only-d">${groups.map(grp).join('')}</div><div class="only-m">${groups.map(mob).join('')}</div>${overline('Folders', e.folders.length + 1)}${fold('Vault root', e.root, 1)}${e.folders.map((f) => fold(f.path.split('/').pop(), f)).join('')}`;
    };

    const VN = 5;
    const verRows = vs.versions.map((v, i) => row({ lead: `<span class="mono">v${v.version}</span>`, title: v.change_note || (v.version === 1 ? 'Created' : 'Saved'), meta: `${ago(v.created_at)} ago`,
      trail: v.version === rl.version ? pill('Current', 'ok') : `<button type="button" class="btn sm" data-rb="${v.version}">${ic('rot')}Restore</button>`, cls: i >= VN ? 'more-extra' : '' }));

    const pane = (p, html) => `<div class="kpane" data-pane="${p}"${p === keyTab ? '' : ' hidden'}>${html}</div>`;
    const lg = `<span class="lg lgs only-d"><span><i class="c-a"></i>Allow</span><span><i class="c-i"></i>Inherit</span><span><i class="c-d"></i>Deny</span></span>`;
    const body =
      pane('overview', `<div class="pcard kvc">${kv('Status', pill(k))}${k.agent ? kv('Agent', `<span title="${esc(k.agent.label)}">${esc(k.agent.label)}</span>`) : ''}${k.pc ? kv('PC', `<span class="mono" title="${esc(k.pc.name)}">${esc(k.pc.name)}</span>${k.app_name ? ' · ' + esc(k.app_name) : ''}`) : ''}${kv('Template', esc(tplName))}
          ${kv('Key id', `<span title="${esc(k.masked_key)}">${esc(midTrunc(k.masked_key, 22))}</span>`, { id: true })}
          ${kv('Expires', `${esc(expText)}${dead ? '' : `<button type="button" class="btn ghost sm" id="kExp" aria-haspopup="dialog">Change</button>`}`)}
          ${kv('Last seen', esc(k.last_used_at ? ago(k.last_used_at) + ' ago' : 'Never'))}</div>` +
        (dead ? '' : `<div class="kacts"><button type="button" class="btn" id="kRot">${ic('rot')}Rotate</button>${k.effective_status === 'active' ? `<button type="button" class="btn" id="kSus">${ic('pause')}Suspend</button>` : k.effective_status === 'suspended' ? `<button type="button" class="btn ok" id="kRe">${ic('play')}Resume</button>` : ''}<button type="button" class="btn only-d" id="kEnd"${k.live_logins ? '' : ' disabled'}>${ic('out')}End${k.live_logins ? ' ×' + k.live_logins : ' logins'}</button><button type="button" class="btn only-d" id="kRev">${ic('trash')}Revoke</button></div>`) +
        `<div class="pcard"><div class="stats c2"><button type="button" class="stat" data-go="log" data-arg="calls|${esc(id)}" title="Open these calls in Auditing"><span class="stat-v">${calls}</span><span class="stat-l">Calls, last hour</span></button><button type="button" class="stat" data-go="log" data-arg="calls|${esc(id)}|denied" title="Open the denied calls in Auditing"><span class="stat-v${den ? ' bad-t' : ''}">${den}</span><span class="stat-l">Denied, last hour</span></button></div></div>`) +
      pane('access', `<div class="pcard"><div class="ohd">${overline('Folders', rows.length)}${info('Each folder is allowed, denied or inherited from its parent.')}${lg}</div><div id="mxW">${accHtml()}</div></div>`) +
      pane('reach', `${isApp ? '' : `<div class="pcard kvc">${kv('Through app key', `<select class="sel" id="eA" aria-label="Through app key"><option value="">None</option>${appKeys.map((a) => `<option value="${esc(a.id)}">${esc(a.app_name)} · ${esc(a.pc?.name || '')}</option>`).join('')}</select>`)}</div>`}<div class="pcard" id="eW">${reach(ef)}</div>`) +
      pane('rules', `<div class="pcard" id="othW">${othHtml()}</div><div class="pcard">${overline('Template and versions')}${row({ lead: ic('sl'), title: 'Apply a template', meta: S.tpl.map((t) => t.name).join(' · ') || 'No templates', chev: true, attrs: { id: 'tplRow' } })}<div class="more-box" id="verW">${verRows.join('')}${vs.versions.length > VN ? row({ one: true, title: `Show all ${vs.versions.length} versions`, group: true, expanded: false, attrs: { 'data-more': 'verW' } }) : ''}</div></div>`) +
      pane('simulate', `<div class="pcard kform"><label class="fld"><span class="vlabel">Action</span><select class="sel mono" id="sA" aria-label="Action">${SIMA.map((a) => `<option${a === 'fs.read' ? ' selected' : ''}>${a}</option>`).join('')}</select></label>
          <label class="fld"><span class="vlabel">Path</span><input class="inp mono" id="sR" value="/${esc(alias)}/" aria-label="Resource" autocomplete="off" spellcheck="false"></label></div><div class="res" id="sRes"></div>`);
    const tabsH = `<nav class="tabs only-m" role="tablist" aria-label="Key sections">${KEY_TABS.map(([p, l]) => `<button type="button" role="tab" aria-selected="${p === keyTab}" data-key-tab="${p}" class="${p === keyTab ? 'on' : ''}">${l}</button>`).join('')}</nav>`;
    const savebar = `<div class="savebar" id="kSave" hidden><span>${ic('edit')}Unsaved changes</span><input class="inp" id="rN" placeholder="Note" aria-label="Change note" maxlength="200"><button type="button" class="btn sm" id="rDiscard">Discard</button><button type="button" class="btn pri sm" id="rSave">${ic('check')}Save</button></div>`;

    const dirty = () => { E.dirty = true; $('#kSave').hidden = false; $('#mxW').innerHTML = accHtml(); $('#othW').innerHTML = othHtml(); $('#eW').innerHTML = reach(E.ef); tipIcons($('#dB')); };
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
    // Allow all / Deny all and the per-tool switch; shared by the desktop list and the phone sheet. Returns the toggled tool, true for a group action, false for neither.
    const reachAct = (e) => {
      const ga = e.target.closest('[data-ga]');
      if (ga) { e.preventDefault(); const g = TG.find(([n]) => n === ga.dataset.g); setTools(E.ef.tools.filter((t) => toolGroup(t.tool) === g[0]).map((t) => t.tool), g[2], ga.dataset.ga === 'allow'); return true; }
      const tt = e.target.closest('[data-tt]');
      if (tt) { const t = E.ef.tools.find((x) => x.tool === tt.dataset.tt); setTools([t.tool], null, !toolOn(t)); return t.tool; }
      return false;
    };
    const openFold = (ri, anchor) => {
      const r = rows[ri], name = foldName(r);
      const sw = () => OPS.map((o) => { const v = cellOf(r, o); return row({ one: true, title: OPL[o], trail: `${v === 'd' ? pill('Denied', 'bad') : v === 'i' ? pill('Inherited', 'idle') : ''}${switchBtn(`${name}: ${OPL[o]}`, v === 'a', `data-fo="${o}"`)}` }); }).join('');
      const sh = openSheet({ title: name, anchor, html: `<div id="foSw">${sw()}</div><div class="sheet-acts"><button type="button" class="btn pri lg" data-sheet-close>Done</button></div>` });
      sh.addEventListener('click', (e) => {
        const b = e.target.closest('[data-fo]'); if (!b) return;
        const o = b.dataset.fo;
        if (E.M[r.res][o] === 'a') delete E.M[r.res][o]; else E.M[r.res][o] = 'a';
        dirty(); $('#foSw', sh).innerHTML = sw(); $(`[data-fo="${o}"]`, sh)?.focus();
      });
    };
    const openRg = (name, anchor) => {
      const body = () => { const g = reachGroups().find((x) => x.name === name); if (!g) return '';
        return `${g.globs ? `<div class="sheet-acts"><button type="button" class="btn lg" data-ga="allow" data-g="${esc(g.name)}">Allow all</button><button type="button" class="btn lg" data-ga="deny" data-g="${esc(g.name)}">Deny all</button></div>` : ''}${g.tools.map((t) => row({ one: true, title: raw(`<span class="mono">${esc(t.tool)}</span>`), trail: switchBtn(t.tool, toolOn(t), `data-tt="${esc(t.tool)}"`) })).join('')}`; };
      const sh = openSheet({ title: name, anchor, html: `<div id="rgBody">${body()}</div>` });
      sh.addEventListener('click', (e) => { const h = reachAct(e); if (!h) return; $('#rgBody', sh).innerHTML = body(); if (typeof h === 'string') $(`[data-tt="${CSS.escape(h)}"]`, sh)?.focus(); });
    };

    return {
      t: keyTitle(keyTab), b: tabsH + body + savebar,
      bar: `<button class="btn ic" data-ctx-back aria-label="Back">${ic('back')}</button><h2 id="ctxTitle">${dotH(k)}<span class="ctx-name">${esc(keyName(k))}</span><span class="tag">${esc(k.masked_key)}</span></h2><nav class="seg ws-tabs" aria-label="Key sections">${KEY_TABS.map(([p, l, icn]) => `<button data-key-tab="${p}" class="${p === keyTab ? 'on' : ''}">${ic(icn)}${l}</button>`).join('')}</nav>`,
      dbar: { title: keyName(k), dot: dotCls(keyTone(k)), meta: `${keyKind(k)} · ${st[1]}`,
        menu: dead ? [] : [k.live_logins ? { label: 'End logins', icon: 'out', fn: doEnd } : null,
          k.effective_status === 'active' ? { label: 'Suspend key', icon: 'pause', fn: doSus } : k.effective_status === 'suspended' ? { label: 'Resume key', icon: 'play', fn: doRe } : null,
          { label: 'Revoke key', icon: 'trash', bad: true, confirm: 'Tap again to revoke', fn: doRev }] },
      after() {
        $$('[data-key-tab]').forEach((b) => (b.onclick = () => {
          keyTab = b.dataset.keyTab; setRoute('key', id + '|' + keyTab);
          $$('[data-key-tab]').forEach((x) => { const on = x.dataset.keyTab === keyTab; x.classList.toggle('on', on); if (x.getAttribute('role') === 'tab') x.setAttribute('aria-selected', String(on)); });
          $$('.kpane').forEach((p) => (p.hidden = p.dataset.pane !== keyTab));
          $('#dT').innerHTML = keyTitle(keyTab); window.scrollTo(0, 0);
        }));
        const on = (sel, fn) => { const e = $(sel); if (e) e.onclick = fn; };
        on('#kSus', doSus);
        on('#kRe', doRe);
        on('#kEnd', doEnd);
        if ($('#kRev')) arm($('#kRev'), doRev);
        if ($('#kRot')) arm($('#kRot'), doRot);
        // Expiry: the existing period control, in a sheet.
        on('#kExp', (e) => {
          const sh = openSheet({ title: 'Expiry', anchor: e.currentTarget, html: `<p>${exp ? 'Expires ' + esc(dt(exp)) + '.' : 'Never expires.'} Pick a new period from now.</p><div class="seg sheet-seg" id="kX">${EXP.map(([l, dd]) => `<button type="button" data-d="${dd}">${l}</button>`).join('')}</div>` });
          $('#kX', sh).onclick = (ev) => { const b = ev.target.closest('button'); if (b) { closeSheet(); act(() => api(kp, 'PATCH', { expires_at: +b.dataset.d ? Date.now() + +b.dataset.d * 864e5 : null }), 'Saved'); } };
        });
        $('#eW').addEventListener('toggle', (e) => { const g = e.target.dataset?.g; if (g) e.target.open ? E.open.add(g) : E.open.delete(g); }, true);
        $('#eW').onclick = (e) => {
          const r = reachAct(e);
          if (typeof r === 'string') { $('#eW [data-tt="' + r + '"]')?.focus(); return; }
          const rg = !r && e.target.closest('[data-rg]'); if (rg) openRg(rg.dataset.rg, rg);
        };
        $('#rDiscard').onclick = () => openD('key', id, true);
        $('#mxW').onclick = (e) => {
          const fo = e.target.closest('[data-fold]'); if (fo) { openFold(+fo.dataset.fold, fo); return; }
          const c = e.target.closest('.cell'); if (!c || c.classList.contains('nc')) return;
          const r = rows[+c.dataset.r], o = c.dataset.o, cur = E.M[r.res][o] || '';
          const nx = { '': 'a', a: 'd', d: '' }[cur]; if (nx) E.M[r.res][o] = nx; else delete E.M[r.res][o];
          dirty(); const f = $(`#mxW [data-r="${c.dataset.r}"][data-o="${o}"]`); f && f.focus();
        };
        $('#othW').onclick = (e) => {
          const b = e.target.closest('[data-del]'); if (b) { E.other.splice(+b.dataset.del, 1); dirty(); return; }
          const nb = e.target.closest('[data-rnew]'); if (!nb) return;
          const sh = openSheet({ title: 'Add rule', anchor: nb, html: `<div class="sheet-form">
            <label class="fld"><span class="vlabel">Effect</span><select class="sel" id="rE" aria-label="Effect"><option value="allow">Allow</option><option value="deny">Deny</option></select></label>
            <label class="fld"><span class="vlabel">Actions</span><input class="inp mono" id="rA" placeholder="fs.read, fs.list" aria-label="Actions" autocomplete="off"></label>
            <label class="fld"><span class="vlabel">Resource</span><input class="inp mono" id="rR" placeholder="room:*" aria-label="Resource" autocomplete="off"></label>
            <p class="hint">Separate actions with commas. A path starts with a slash.</p>
            <button type="button" class="btn pri lg" id="rAdd">${ic('plus')}Add rule</button></div>` });
          $('#rAdd', sh).onclick = () => {
            const a = $('#rA', sh).value.split(',').map((x) => x.trim()).filter(Boolean), r = $('#rR', sh).value.trim();
            if (!a.length || !r) return toast('Add an action and a resource', true);
            E.other.push({ effect: $('#rE', sh).value, actions: a, resource: r.startsWith('/') ? 'path:' + r : r, from_template: null, note: null }); closeSheet(); dirty();
          };
        };
        $('#rSave').onclick = () => run(async () => {
          const gen = [];
          rows.forEach((r) => { const al = OPS.filter((o) => E.M[r.res][o] === 'a').map((o) => 'fs.' + o), dn = OPS.filter((o) => E.M[r.res][o] === 'd').map((o) => 'fs.' + o); if (dn.length) gen.push({ effect: 'deny', actions: dn, resource: r.res }); if (al.length) gen.push({ effect: 'allow', actions: al, resource: r.res }); });
          const rules = [...E.other, ...gen].map((r) => ({ effect: r.effect, actions: r.actions, resource: r.resource, from_template: r.from_template ?? null, note: r.note ?? null }));
          const res = await api(`${kp}/rules`, 'PUT', { rules, note: $('#rN').value.trim() || null });
          toast('v' + res.version); openD('key', id, true);
        });
        // Apply a template: pick it in a sheet.
        on('#tplRow', (e) => {
          const sh = openSheet({ title: 'Apply a template', anchor: e.currentTarget, html: `<div class="sheet-form"><label class="fld"><span class="vlabel">Template</span><select class="sel" id="tS" aria-label="Template"><option value="">Choose a template</option>${S.tpl.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('')}</select></label>
            <p class="hint">Its rules are added to this key's rules.</p><button type="button" class="btn pri lg" id="tApply">Apply template</button></div>` });
          $('#tApply', sh).onclick = () => { const t = $('#tS', sh).value; if (t) { closeSheet(); act(() => post(`${kp}/apply-template`, { template_id: t }), 'Applied'); } };
        });
        $$('[data-rb]').forEach((b) => (b.onclick = () => act(() => post(`${kp}/rollback`, { version: +b.dataset.rb }), 'v' + b.dataset.rb)));
        $$('[data-more]').forEach((b) => (b.onclick = () => { const box = $('#' + b.dataset.more), all = box.classList.toggle('all'); b.setAttribute('aria-expanded', String(all)); b.querySelector('.lrow-title').textContent = all ? 'Show fewer' : `Show all ${box.querySelectorAll('.lrow:not(.group)').length} versions`; }));
        if ($('#eA')) $('#eA').onchange = () => run(async () => { const q = $('#eA').value; $('#eW').innerHTML = reach(await api(`${kp}/effective${q ? '?app_key_id=' + encodeURIComponent(q) : ''}`)); simulate(); });
        let tm;
        const simulate = () => run(async () => {
          const r = $('#sR').value.trim(); if (!r) return;
          let dec;
          try { dec = (await post('/simulate', { credential_id: id, app_credential_id: ($('#eA') && $('#eA').value) || null, action: $('#sA').value, resource: r })).decision; }
          catch (e) { $('#sRes').className = 'res n'; $('#sRes').innerHTML = `<span class="big">${ic('x')}Error</span><p class="res-rule mono">${esc(e.message)}</p>`; return; }
          const rule = dec.rule ? `${dec.rule.effect} ${dec.rule.actions.join(', ')} ${dec.rule.resource}` : dec.reason;
          $('#sRes').className = 'res ' + (dec.allowed ? 'y' : 'n');
          $('#sRes').innerHTML = `<span class="big">${ic(dec.allowed ? 'check' : 'x')}${dec.allowed ? 'Allow' : 'Deny'}</span><p class="res-rule mono">${esc(rule)}</p>${dec.source ? kv('Decided by', esc(dec.source), { id: true }) : ''}`;
        });
        ['#sA', '#sR'].forEach((s) => ($(s).oninput = () => { clearTimeout(tm); tm = setTimeout(simulate, 250); }));
        simulate();
      },
    };
  },
};

/* ---------- phase 2/3/3b views ---------- */
const TCOL = { open: 'idle', assigned: 'info', in_progress: 'accent', in_review: 'warn', approved: 'ok', changes_requested: 'warn', blocked: 'bad', done: 'ok' }; // tone classes (.sbar i.<tone>)
const TSTC = { running: 'ok', paused: 'warn', draft: 'idle', stopped: 'bad', done: 'accent' }; // tone classes (.tg-pbf.<tone>)
const ring = (p, sz = 36, col = 'var(--ok)') => { const r = sz / 2 - 3, c = 2 * Math.PI * r, h = sz / 2; return `<svg class="rg" width="${sz}" height="${sz}" viewBox="0 0 ${sz} ${sz}" aria-hidden="true"><circle cx="${h}" cy="${h}" r="${r}" fill="none" stroke-width="3.5" class="rg-trk"/><circle cx="${h}" cy="${h}" r="${r}" fill="none" stroke-width="3.5" stroke-linecap="round" stroke-dasharray="${(c * p / 100).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 ${h} ${h})" style="stroke:${col}"/><text x="50%" y="50%" dominant-baseline="central" text-anchor="middle" class="rt${sz > 44 ? ' big' : ''}">${p}</text></svg>`; };
const agLabel = (id) => (id === 'hub' ? 'hub' : AG(id)?.label || SESA(id)?.agent.label || trunc(String(id || '—'), 12));
/* Agents topology (Work → Activity): agents, team hubs and group chats; Teams → Connections graph scopes it to one project.
   Edges are coloured by how recently they carried activity. The focus view is described above EGO. */
const ACT_MS = 30_000, REC_MS = 300_000;
const TGW = [['5m', 300_000], ['1h', 3600_000], ['24h', 86400_000], ['7d', 7 * 86400_000]];
const TG_S = { win: 86400_000, layers: { team: true, msg: true, link: true }, focus: null };
const recency = (t) => (!t ? 'old' : Date.now() - t < ACT_MS ? 'act' : Date.now() - t < REC_MS ? 'rec' : 'old');
const TEAM_TOOLS = /^(team_|task_|work_)/;
const NO_PROJECT = 'No project';
const projectOf = (a) => a.project || S.teams.find((t) => (t.agent_ids || []).includes(a.id))?.name || NO_PROJECT;
const initials = (s) => { const w = String(s).trim().split(/\s+/); return (w.length > 1 ? w.map((x) => x[0]).join('') : w[0]).slice(0, 2).toUpperCase(); };
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
/* Which part of the model a project focus shows (Teams → Connections graph). Without one, the whole hub. */
function topoScope(M) {
  const f = TG_S.focus;
  if (f?.kind === 'project') {
    const inside = new Set(M.agents.filter((a) => M.proj.get(a.id) === f.id).map((a) => a.id)), ext = new Set();
    // Outside agents this project talks to stay visible, faded, so cross-project traffic is not hidden.
    for (const e of M.edges) if (!e.b.includes(':') && inside.has(e.a) !== inside.has(e.b)) ext.add(inside.has(e.a) ? e.b : e.a);
    const ids = new Set([...inside, ...ext]), between = (e) => ids.has(e.a) && ids.has(e.b) && (inside.has(e.a) || inside.has(e.b));
    return { ids, ext, edges: M.edges.filter((e) => (e.b.includes(':') ? inside.has(e.a) : between(e))) };
  }
  return { ids: new Set(M.agents.map((a) => a.id)), ext: new Set(), edges: M.edges };
}
const edgeWidth = (e) => (e.kind === 'msg' || e.kind === 'room' ? Math.min(1.5 + Math.log2(e.count + 1), 6) : 1.6);
/* What a denied call was aimed at (a path or resource), never the content it carried. */
const denTarget = (i) => { try { const a = JSON.parse(i.args_summary || '{}') || {}; return [a.path, a.resource, a.to, a.room_id, a.team_id].find((v) => typeof v === 'string') || ''; } catch { return ''; } };
/* Activity graph. At rest, agents sit in clusters around their team hub (hubs on an ellipse, agents in no team in the middle).
   Resting the pointer on a node for 250 ms, or giving it keyboard focus, moves it to the centre with its direct connections on a
   ring (team first, then messages by count, then links) and fades the rest. Leaving the graph or Esc goes back; resting on a ring
   node walks to it (the trail above the graph jumps back); a click or Enter pins. The SVG is built once and reconciled on every
   refresh: one element per node and edge id, positions interpolated with requestAnimationFrame, so the 4 s poll keeps the focus,
   the pin and keyboard focus. */
const SVGNS = 'http://www.w3.org/2000/svg';
const EGO = { focus: null, pinned: false, trail: [], hov: null, dwell: 0, anim: 0, lock: null, px: null, cur: new Map(), G: null, ring: [], nb: new Map(), role: new Map(), only: null, W: 0, avail: 0, vk: '', sig: '' };
const EGO_DWELL = 250, EGO_MS = 380, EGO_TRAIL = 6, EGO_RANK = { team: 0, msg: 1, room: 1, link: 2 };
function egoReset() { clearTimeout(EGO.dwell); cancelAnimationFrame(EGO.anim); Object.assign(EGO, { focus: null, pinned: false, trail: [], hov: null, lock: null, cur: new Map(), G: null, W: 0, vk: '', sig: '' }); }
/* Nodes, edges and the resting layout for the current scope. Team hubs appear with the Teams layer; clusters always follow teams. */
function topoGraph(M, scope, W, avail) {
  const nodes = new Map(), narrow = W < 560;
  for (const a of M.agents) if (scope.ids.has(a.id)) nodes.set(a.id, { id: a.id, kind: 'agent', label: a.label || a.id, a, ext: scope.ext.has(a.id) });
  const teams = S.teams.map((t) => ({ t, members: (t.agent_ids || []).filter((id) => nodes.has(id) && !scope.ext.has(id)) })).filter((x) => x.members.length);
  if (TG_S.layers.team) for (const { t, members } of teams) nodes.set('team:' + t.id, { id: 'team:' + t.id, kind: 'team', label: t.name, t, members });
  for (const e of scope.edges) if (e.kind === 'room' && !nodes.has(e.b)) nodes.set(e.b, { id: e.b, kind: 'room', label: M.rooms.get(e.b.slice(5)) || 'Room', room: e.b.slice(5) });
  const edges = scope.edges.filter((e) => nodes.has(e.a) && nodes.has(e.b)).map((e) => ({ ...e, key: e.kind + ':' + e.a + '|' + e.b }));
  const G = { M, nodes, edges, teams, W, narrow };
  Object.assign(G, topoBase(G, avail));
  return G;
}
/* Rows of boxes ({w, h}) no wider than maxW, each row centred (across and on its middle line); returns the offsets and the size. */
function shelfPack(items, maxW, gap) {
  const at = [], rows = []; let x = 0, y = 0, rowH = 0, row = [], w = 0;
  const close = () => { row.forEach((i) => (at[i].y += (rowH - items[i].h) / 2)); rows.push({ row, rw: x - gap }); y += rowH + gap; rowH = 0; row = []; x = 0; };
  items.forEach((b, i) => {
    if (row.length && x + b.w > maxW) close();
    at[i] = { x, y }; row.push(i); x += b.w + gap; rowH = Math.max(rowH, b.h); w = Math.max(w, x - gap);
  });
  if (row.length) close();
  rows.forEach(({ row, rw }) => row.forEach((i) => (at[i].x += (w - rw) / 2)));
  return { at, w, h: Math.max(0, y - gap) };
}
/* The packing (of every row width worth trying) that fits the target box best: least shrinking first (the width must fit; the
   height may scroll, so shrinking for it stops at floor), then the most compact block whose shape is nearest the target's. */
function bestPack(items, gap, TW, TH, floor) {
  let best = null; const seen = new Set();
  for (let k = 1; k <= items.length; k++) {
    const sorted = items.map((b) => b.w).sort((a, b) => b - a), maxW = sorted.slice(0, k).reduce((s, w) => s + w, 0) + gap * (k - 1);
    if (seen.has(maxW)) continue; seen.add(maxW);
    const p = shelfPack(items, maxW, gap), s = Math.min(1, TW / p.w, Math.max(TH / p.h, floor));
    const score = Math.round(s * 50) * 1e9 - p.w * p.h * (1 + Math.abs(Math.log(p.w / p.h / (TW / TH))));
    if (!best || score > best.score) best = { ...p, score };
  }
  return best;
}
/* Resting layout. Each team is a cluster: members on an arc around the hub, leaving the space under it for the hub's name and
   progress bar (sized to the member count). A project's clusters, and its agents in no team, are packed into one block; blocks
   are packed in rows with a modest gap, then scaled (positions only, never the nodes) to the graph's width and the height left
   in the window. Returns the positions, the graph height H (the content plus padding) and the project captions. */
function topoBase(G, avail) {
  const { nodes, teams, W, narrow } = G, M = G.M;
  const rr = narrow ? 14 : 19, hs = narrow ? 15 : 21, lblW = narrow ? 100 : 150, gap = narrow ? 14 : 24, pgap = narrow ? 26 : 48, pad = narrow ? 18 : 28, capH = narrow ? 20 : 24;
  const home = new Map(); teams.forEach(({ t, members }) => members.forEach((id) => { if (!home.has(id)) home.set(id, t.id); }));
  const cl = (P, n, extra = []) => {
    const pts = [...P].flatMap(([id, p]) => { const r = id.includes(':') ? hs : rr; return [{ x: p.x - r, y: p.y - r }, { x: p.x + r, y: p.y + r }]; }).concat(extra);
    const x0 = Math.min(...pts.map((p) => p.x)), y0 = Math.min(...pts.map((p) => p.y)), x1 = Math.max(...pts.map((p) => p.x)), y1 = Math.max(...pts.map((p) => p.y));
    return { P, n, x0, y0, w: x1 - x0, h: y1 - y0 };
  };
  const groups = new Map(), put = (g, c) => { if (!groups.has(g)) groups.set(g, []); groups.get(g).push(c); };
  for (const { t, members } of teams) {
    const mem = members.filter((id) => home.get(id) === t.id), m = mem.length, P = new Map([['team:' + t.id, { x: 0, y: 0 }]]);
    const r = Math.max(narrow ? 34 : 54, m * (narrow ? 8 : 11)), arc = (narrow ? 140 : 160) * Math.PI / 180;
    mem.forEach((id, j) => { const b = Math.PI / 2 + arc / 2 + ((2 * Math.PI - arc) * (m === 1 ? 0.5 : j / (m - 1))); P.set(id, { x: r * Math.cos(b), y: r * Math.sin(b) }); });
    put(tmProject(t), cl(P, m + 1, [{ x: -lblW / 2, y: 0 }, { x: lblW / 2, y: hs + 34 }]));
  }
  // Agents in no team (in a project view, also the outside agents it talks to) in a small grid with their project.
  const free = [...nodes.values()].filter((n) => n.kind === 'agent' && !home.has(n.id)).sort((x, y) => x.ext - y.ext || x.label.localeCompare(y.label));
  const grid = (list, g) => {
    const k = list.length, cols = Math.ceil(Math.sqrt(k * 1.5)), sp = narrow ? 40 : 54, P = new Map();
    list.forEach((n, i) => P.set(n.id, { x: (i % cols) * sp, y: Math.floor(i / cols) * sp }));
    put(g, cl(P, k));
  };
  const byProj = new Map(); for (const n of free) { const p = M.proj.get(n.id); if (!byProj.has(p)) byProj.set(p, []); byProj.get(p).push(n); }
  byProj.forEach(grid);
  const rooms = [...nodes.values()].filter((n) => n.kind === 'room');
  if (rooms.length) grid(rooms, '');
  // Blocks: biggest clusters first inside a project; projects by name, No project and group chats last.
  const multi = groups.size > 1, TW = W - 2 * pad, TH = Math.max(avail - 2 * pad, 200), floor = narrow ? 0.9 : 0.8;
  const blocks = [...groups].sort(([a], [b]) => (a === '') - (b === '') || (a === NO_PROJECT) - (b === NO_PROJECT) || a.localeCompare(b)).map(([name, cs]) => {
    cs.sort((x, y) => y.n - x.n);
    const area = cs.reduce((s, c) => s + c.w * c.h, 0), side = Math.sqrt(area * (TW / TH));
    const p = bestPack(cs, gap, groups.size <= 2 ? TW : Math.min(TW, side * 1.15), TH, floor), top = multi ? capH : 0;
    return { name, cs, p, w: Math.max(p.w, multi ? Math.min(TW, name.length * 7.5) : 0), h: p.h + top, top };
  });
  const outer = bestPack(blocks, pgap, TW, TH, floor), cw = outer.w + 2 * pad, ch = outer.h + 2 * pad;
  // Shrink (positions only) to the width, and to the window height down to a floor that keeps nodes apart; never grow.
  let s = Math.min(1, W / cw); if (ch * s > avail) s = Math.min(s, Math.max(avail / ch, floor));
  const H = Math.round(Math.max(ch * s, Math.min(avail, narrow ? 380 : 440))), ox = (W - cw * s) / 2, oy = (H - ch * s) / 2;
  const base = new Map(), caps = [], at = (x, y) => ({ x: ox + (pad + x) * s, y: oy + (pad + y) * s });
  blocks.forEach((b, i) => {
    const bo = outer.at[i];
    if (multi && b.name) caps.push({ name: b.name, ...at(bo.x, bo.y + capH - 8) });
    b.cs.forEach((c, j) => { const co = b.p.at[j]; c.P.forEach((p, id) => base.set(id, at(bo.x + co.x + p.x - c.x0, bo.y + b.top + co.y + p.y - c.y0))); });
  });
  return { base, H, caps };
}
/* Direct connections of a node, one edge per neighbour (the strongest kind wins). */
function egoNbrs(G, id) {
  const nb = new Map();
  for (const e of G.edges) { const o = e.a === id ? e.b : e.b === id ? e.a : null; if (!o) continue; const p = nb.get(o); if (!p || EGO_RANK[e.kind] < EGO_RANK[p.kind]) nb.set(o, e); }
  return nb;
}
function egoLayout(G) {
  const f = EGO.focus, P = new Map(G.base), role = new Map();
  if (!f) { G.nodes.forEach((_, id) => role.set(id, 'base')); return { P, role, nb: new Map(), ring: [] }; }
  const nb = egoNbrs(G, f), lab = (id) => G.nodes.get(id).label;
  const ring = [...nb.keys()].sort((x, y) => EGO_RANK[nb.get(x).kind] - EGO_RANK[nb.get(y).kind] || (nb.get(y).count || 0) - (nb.get(x).count || 0) || lab(x).localeCompare(lab(y)));
  const { W, H, narrow } = G, cx = W / 2, cy = H / 2, n = ring.length;
  const rx = Math.min(W / 2 - (narrow ? 44 : 110), (narrow ? 90 : 150) + n * 16), ry = Math.min(H / 2 - 56, 120 + n * 10);
  P.set(f, { x: cx, y: cy }); role.set(f, 'focus');
  ring.forEach((id, i) => { const a = -Math.PI / 2 + (2 * Math.PI * i) / n; P.set(id, { x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) }); role.set(id, 'n1'); });
  G.nodes.forEach((_, id) => { if (!role.has(id)) role.set(id, 'out'); });
  return { P, role, nb, ring };
}
/* Markup inside a node's or edge's <g>, drawn around the origin (the <g> carries the position). */
function egoNodeParts(n, G) {
  const M = G.M;
  if (n.kind === 'agent') {
    const st = M.act.get(n.id), rc = recency(st.last), on = M.live.has(n.id), rr = G.narrow ? 14 : 19;
    const sub = n.ext ? M.proj.get(n.id) : st.last ? `${st.tool} · ${ago(st.last)}` : on ? 'connected' : 'offline';
    const tip = `${n.label}${n.a.role ? ' · ' + n.a.role : ''} · ${on ? 'live' : 'offline'}${n.ext ? ' · project ' + M.proj.get(n.id) : ''}${st.last ? ' · last call ' + st.tool + ' ' + ago(st.last) + ' ago' : ''}${st.denied ? ' · ' + st.denied + ' denied in 5m' : ''}`;
    return { cls: `tg-node tg-agent${on ? ' live' : ''}${n.ext ? ' ext' : ''} r-${rc}`, html: `<title>${esc(tip)}</title>`
      + (rc === 'act' && !n.ext ? `<circle class="halo" r="${rr + 1}"/>` : '') + `<circle class="core" r="${rr}"/>`
      + `<text class="ini" text-anchor="middle" dominant-baseline="central">${esc(initials(n.label))}</text>`
      + (st.denied && !n.ext ? `<g class="tg-den"><circle cx="${rr * 0.8}" cy="${-rr * 0.8}" r="8"/><text x="${rr * 0.8}" y="${-rr * 0.8}" text-anchor="middle" dominant-baseline="central">${st.denied}</text></g>` : '')
      + `<text class="tg-lbl" y="${rr + 15}" text-anchor="middle">${esc(trunc(n.label, G.narrow ? 12 : 18))}</text>`
      + `<text class="tg-sub${!n.ext && st.result && st.result !== 'ok' && rc !== 'old' ? ' bad' : ''}" y="${rr + 29}" text-anchor="middle">${esc(trunc(sub, G.narrow ? 16 : 24))}</text>` };
  }
  const team = n.kind === 'team', t = n.t, hs = G.narrow ? 15 : 21, is = G.narrow ? 8 : 11, busy = G.edges.some((e) => e.b === n.id && recency(e.last) === 'act'), pct = team ? t.progress?.pct || 0 : 0;
  return { cls: `tg-node ${team ? 'tg-team' : 'tg-room'}${busy ? ' busy' : ''}`, html: `<title>${esc(n.label + (team ? ' · ' + t.status + ' · ' + t.members + ' members · ' + tasksLabel(t.progress || {}) : ' · group chat'))}</title>`
    + `<rect x="${-hs}" y="${-hs}" width="${2 * hs}" height="${2 * hs}" rx="${hs * 0.57}"/><use href="#i-${team ? 'team' : 'chat'}" x="${-is}" y="${-is}" width="${2 * is}" height="${2 * is}"/>`
    + `<text class="tg-lbl" y="${hs + 16}" text-anchor="middle">${esc(trunc(n.label, G.narrow ? 14 : 22))}</text>`
    + (team ? `<g class="tg-prog"><rect class="tg-pb" x="-26" y="${hs + 25}" width="52" height="5" rx="2.5"/><rect class="tg-pbf ${TSTC[t.status] || ''}" x="-26" y="${hs + 25}" width="${(52 * pct / 100).toFixed(1)}" height="5" rx="2.5"/><text class="tg-sub" x="31" y="${hs + 30}">${pct}%</text></g>` : '') };
}
/* A link's kind for people: team:<id> links are named after their team, never by id. */
const linkKindLabel = (k) => { if (!k) return 'Link'; if (!k.startsWith('team:')) return cap(k) + ' link'; const t = S.teams.find((x) => x.id === k.slice(5)); return t ? 'Team link (' + t.name + ')' : 'Team link'; };
function egoEdgeParts(e, G) {
  const name = (id) => G.nodes.get(id)?.label || id, rc = e.kind === 'link' ? 'old' : recency(e.last);
  const tip = e.kind === 'team' ? `${name(e.a)} · member of ${name(e.b)}${e.last ? ' · team activity ' + ago(e.last) + ' ago' : ''}`
    : e.kind === 'link' ? `${name(e.a)} ↔ ${name(e.b)} · ${linkKindLabel(e.link.kind)}${e.link.grants_messaging ? ' · messaging allowed' : ''} · no messages in this window`
    : `${name(e.a)} ${e.kind === 'room' ? '→' : '↔'} ${name(e.b)} · ${e.count} message${e.count === 1 ? '' : 's'} · last ${ago(e.last)} ago`;
  return `<title>${esc(tip)}</title><path class="tg-e k-${e.kind} r-${rc}" style="stroke-width:${edgeWidth(e)}"/><path class="tg-hit"/>`;
}
/* Writes markup only when it differs from what the element last got here (a refresh mostly brings the same). */
const htmlIf = (el, html) => { if (el._h === html && el.innerHTML) return false; el.innerHTML = html; el._h = html; return true; };
const egoEl = (cls) => { const g = document.createElementNS(SVGNS, 'g'); g.setAttribute('class', cls); return g; };
/* The SVG for #agentGraph, created once per visit to the view; later renders only reconcile it. */
function egoSvg(graph) {
  let svg = graph.querySelector('svg.tg');
  if (svg) return svg;
  graph.innerHTML = `<div class="tg-trail" id="tgTrail"></div><svg class="tg" role="group" aria-label="Agent topology"><g class="tg-caps" aria-hidden="true"></g><g class="tg-edges"></g><g class="tg-nodes"></g></svg>`;
  svg = graph.querySelector('svg.tg'); svg._n = new Map(); svg._e = new Map(); EGO.cur = new Map();
  egoBind(svg);
  graph.querySelector('#tgTrail').addEventListener('click', (e) => {
    if (e.target.closest('[data-tg-pin]')) { egoPin(!EGO.pinned); return; }
    const c = e.target.closest('[data-tg-crumb]'); if (!c) return;
    const i = +c.dataset.tgCrumb, id = EGO.trail[i];
    EGO.trail = EGO.trail.slice(0, i); EGO.focus = id; EGO.pinned = true; EGO.hov = null; egoApply();
  });
  return svg;
}
function egoSync(svg, G) {
  const nodesG = svg.querySelector('.tg-nodes'), edgesG = svg.querySelector('.tg-edges');
  for (const [id, g] of svg._n) if (!G.nodes.has(id)) { g.remove(); svg._n.delete(id); EGO.cur.delete(id); }
  for (const n of G.nodes.values()) {
    let g = svg._n.get(n.id);
    if (!g) { g = egoEl('tg-node'); g.dataset.n = n.id; g.setAttribute('role', 'button'); nodesG.appendChild(g); svg._n.set(n.id, g); }
    const { cls, html } = egoNodeParts(n, G);
    g._base = cls; g.setAttribute('aria-label', n.label + (n.kind === 'team' ? ' (team)' : n.kind === 'room' ? ' (group chat)' : ''));
    if (g._html !== html) { g.innerHTML = html; g._html = html; }
  }
  const keys = new Set(G.edges.map((e) => e.key));
  for (const [k, g] of svg._e) if (!keys.has(k)) { g.remove(); svg._e.delete(k); }
  for (const e of G.edges) {
    let g = svg._e.get(e.key);
    if (!g) {
      g = egoEl('tg-eg'); g.dataset.a = e.a; g.dataset.b = e.b;
      if (e.room) g.dataset.room = e.room; else if (e.team) g.dataset.team = e.team;
      edgesG.appendChild(g); svg._e.set(e.key, g);
    }
    g._e = e;
    const html = egoEdgeParts(e, G);
    if (g._html !== html) { g.innerHTML = html; g._html = html; g._p = [...g.querySelectorAll('path')]; }
  }
}
function egoDraw(svg) {
  // Only what moved is written: nodes that stay put (the faded rest during a focus move) cost nothing per frame.
  svg._n.forEach((g, id) => { const p = EGO.cur.get(id); if (!p) return; const t = `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`; if (g._t !== t) { g.setAttribute('transform', t); g._t = t; } });
  svg._e.forEach((g) => {
    const p = EGO.cur.get(g._e.a), q = EGO.cur.get(g._e.b); if (!p || !q) return;
    const d = `M${p.x.toFixed(1)} ${p.y.toFixed(1)}L${q.x.toFixed(1)} ${q.y.toFixed(1)}`;
    if (g._d !== d || g._p[0].getAttribute('d') !== d) { g._p.forEach((x) => x.setAttribute('d', d)); g._d = d; }
  });
}
/* Moves every node from where it is drawn now to P, and fades what changes role: 380 ms ease-out, or at once (first draw,
   resize, reduced motion). The fade runs in the same frames as the move (inline opacity, cleared at the end so the classes
   rule again): CSS opacity transitions on every node and edge gave each its own compositor layer and halved the frame rate. */
function egoAnimate(svg, P, instant, fades = []) {
  cancelAnimationFrame(EGO.anim);
  const keep = new Set(fades.map((x) => x.el));
  (EGO.fades || []).forEach(({ el }) => { if (!keep.has(el)) { el.style.opacity = ''; el._cur = undefined; } });
  const from = new Map(EGO.cur); let far = 0;
  P.forEach((p, id) => { const a = from.get(id); if (a) far = Math.max(far, Math.hypot(a.x - p.x, a.y - p.y)); });
  const end = () => { fades.forEach(({ el }) => { el.style.opacity = ''; el._cur = undefined; }); EGO.fades = []; svg.classList.remove('moving'); };
  if (instant || RM() || (far < 0.5 && !fades.length)) { EGO.cur = new Map(P); egoDraw(svg); end(); return; }
  const t0 = performance.now(), ease = (t) => 1 - Math.pow(1 - t, 3);
  EGO.fades = fades; svg.classList.add('moving');
  const step = (now) => {
    const k = ease(Math.min(1, (now - t0) / EGO_MS)), cur = new Map();
    P.forEach((p, id) => { const a = from.get(id) || p; cur.set(id, { x: a.x + (p.x - a.x) * k, y: a.y + (p.y - a.y) * k }); });
    EGO.cur = cur; egoDraw(svg);
    fades.forEach((x) => { x.el._cur = x.from + (x.to - x.from) * k; x.el.style.opacity = x.el._cur.toFixed(3); });
    if (k < 1) EGO.anim = requestAnimationFrame(step); else end();
  };
  EGO.anim = requestAnimationFrame(step);
}
/* Applies the focus: roles (focus, ring, faded), the move, the trail and hint, and the side panel. */
function egoApply(instant) {
  const G = EGO.G, svg = $('#agentGraph svg.tg'); if (!G || !svg) return;
  if (EGO.focus && !G.nodes.has(EGO.focus)) { EGO.focus = null; EGO.pinned = false; }
  EGO.trail = EGO.focus ? EGO.trail.filter((id) => G.nodes.has(id) && id !== EGO.focus) : [];
  const { P, role, nb, ring } = egoLayout(G), f = EGO.focus;
  Object.assign(EGO, { role, nb, ring });
  svg.classList.toggle('ego', !!f); svg.classList.toggle('narrow', G.narrow);
  // Attributes are written only when they change, so a redraw with the same focus costs no style work.
  const set = (g, k, v) => { if (g.getAttribute(k) !== v) { if (v === null) g.removeAttribute(k); else g.setAttribute(k, v); } };
  // Each element's resting opacity for its role (what the classes give), so the move can fade from where it is drawn now.
  const fades = [], fade = (g, to) => { const from = g._cur ?? g._op; g._op = to; if (from !== undefined && Math.abs(from - to) > 0.005) fades.push({ el: g, from, to }); };
  svg._n.forEach((g, id) => {
    const r = role.get(id), hov = g.classList.contains('hov') ? ' hov' : '';
    fade(g, r === 'out' ? 0.07 : G.nodes.get(id)?.ext ? 0.55 : 1);
    set(g, 'class', g._base + (r === 'focus' ? ' focus' : r === 'n1' ? ' n1' : r === 'out' ? ' ego-out' : '') + hov);
    set(g, 'tabindex', r === 'out' ? '-1' : '0');
    set(g, 'aria-current', r === 'focus' ? 'true' : null);
  });
  const near = (id) => role.get(id) === 'focus' || role.get(id) === 'n1';
  svg._e.forEach((g) => {
    const e = g._e, k = !f ? '' : e.a === f || e.b === f ? ' on' : near(e.a) && near(e.b) ? ' mid' : ' off';
    set(g, 'class', 'tg-eg' + k + (g.classList.contains('hl') ? ' hl' : '')); fade(g, k === ' off' ? 0.04 : k === ' mid' ? 0.4 : 1);
  });
  egoHov(EGO.hov);
  egoAnimate(svg, P, instant, fades);
  egoChrome(); egoPanels();
}
function egoSet(id, walk) {
  clearTimeout(EGO.dwell);
  if (id === EGO.focus) return;
  if (!id) { EGO.trail = []; EGO.pinned = false; }
  else if (walk && EGO.focus) { const i = EGO.trail.indexOf(id); EGO.trail = i >= 0 ? EGO.trail.slice(0, i) : [...EGO.trail, EGO.focus].slice(-EGO_TRAIL); }
  else EGO.trail = [];
  EGO.focus = id; EGO.hov = null; egoApply();
}
function egoPin(on) { EGO.pinned = on; egoChrome(); egoPanels(); }
/* Pointer or keyboard over a node: outline it and light its line to the focus (at rest, all its lines). */
function egoHov(id) {
  EGO.hov = id; const svg = $('#agentGraph svg.tg'); if (!svg) return;
  const f = EGO.focus;
  svg._n.forEach((g, k) => g.classList.toggle('hov', k === id));
  svg._e.forEach((g) => { const e = g._e; g.classList.toggle('hl', !!id && (f && id !== f ? (e.a === id && e.b === f) || (e.b === id && e.a === f) : e.a === id || e.b === id)); });
  $$('[data-tg-go]').forEach((b) => b.classList.toggle('hov', b.dataset.tgGo === id));
}
function egoDwell(id) {
  clearTimeout(EGO.dwell);
  if (!id || EGO.pinned || id === EGO.focus || EGO.role.get(id) === 'out') return;
  EGO.dwell = setTimeout(() => { EGO.lock = EGO.px; egoSet(id, true); }, EGO_DWELL);
}
function egoBind(svg) {
  const nodeOf = (t) => t.closest?.('.tg-node');
  svg.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') return;
    EGO.px = { x: e.clientX, y: e.clientY };
    // After a move the pointer sits over whatever slid under it; wait for a real movement before it can walk again.
    if (EGO.lock) { if (Math.hypot(e.clientX - EGO.lock.x, e.clientY - EGO.lock.y) < 8) return; EGO.lock = null; }
    const g = nodeOf(e.target), id = g ? g.dataset.n : null;
    if (id === EGO.hov) return;
    egoHov(id); egoDwell(id);
  });
  svg.addEventListener('pointerleave', (e) => {
    clearTimeout(EGO.dwell); EGO.lock = null; egoHov(null);
    if (e.pointerType !== 'touch' && !EGO.pinned) egoSet(null);
  });
  svg.addEventListener('click', (e) => {
    clearTimeout(EGO.dwell);
    const g = nodeOf(e.target);
    if (!g) { if (!e.target.closest('.tg-eg')) egoSet(null); return; }
    const id = g.dataset.n;
    if (id === EGO.focus) egoPin(!EGO.pinned); else { EGO.pinned = true; egoSet(id, true); }
  });
  svg.addEventListener('focusin', (e) => { const g = nodeOf(e.target); if (g) { egoHov(g.dataset.n); egoDwell(g.dataset.n); } });
  svg.addEventListener('focusout', (e) => {
    if (svg.contains(e.relatedTarget)) return;
    clearTimeout(EGO.dwell); egoHov(null);
    if (!EGO.pinned && e.relatedTarget) egoSet(null);
  });
}
/* Above the graph: the trail of focused nodes (click one to jump back; the last one pins) and a short hint. */
function egoChrome() {
  const bar = $('#tgTrail'), G = EGO.G; if (!bar || !G) return;
  const f = EGO.focus, lab = (id) => G.nodes.get(id)?.label || id, touch = matchMedia('(hover: none)').matches;
  const hint = !f ? (touch ? 'Tap a node to focus it' : 'Rest on a node to focus it · click to pin')
    : touch ? 'Tap the background to go back' : EGO.pinned ? 'Pinned · Esc or a click on the background goes back' : 'Move off the graph or press Esc to go back · click to pin';
  const keep = bar.contains(document.activeElement) ? document.activeElement.getAttribute('data-tg-crumb') ?? (document.activeElement.hasAttribute('data-tg-pin') ? 'pin' : null) : null;
  bar.classList.toggle('has', !!f);
  if (!htmlIf(bar, (f ? `<nav class="tg-crumbs" aria-label="Focus trail">${EGO.trail.map((id, i) => `<button type="button" class="btn sm" data-tg-crumb="${i}">${esc(trunc(lab(id), 18))}</button>${ic('chev', 'sep')}`).join('')}`
    + `<button type="button" class="btn sm${EGO.pinned ? ' on' : ''}" data-tg-pin aria-pressed="${EGO.pinned}" title="${EGO.pinned ? 'Pinned: click to unpin' : 'Click to pin'}">${esc(trunc(lab(f), 22))}</button></nav>` : '')
    + `<span class="tg-hint">${esc(hint)}</span>`)) return;
  if (keep !== null) bar.querySelector(keep === 'pin' ? '[data-tg-pin]' : `[data-tg-crumb="${keep}"]`)?.focus();
}
/* The side panel (desktop) and the list under the graph (phones) show the focused node's connections by kind. */
function egoPanelHtml() {
  const G = EGO.G, M = G.M, f = EGO.focus, n = G.nodes.get(f), nb = EGO.nb;
  const lead = (x) => (x.kind === 'agent' ? `<span class="av lg">${esc(initials(x.label))}<i class="st${M.live.has(x.id) ? ' on' : ''}"></i></span>` : `<span class="av lg">${ic(x.kind === 'team' ? 'team' : 'chat')}</span>`);
  let meta, open;
  if (n.kind === 'agent') {
    const st = M.act.get(f);
    meta = [n.a.role || 'No role', M.live.has(f) ? 'live' : 'offline', st.last ? `last call ${ago(st.last)} ago` : ''].filter(Boolean).join(' · ');
    open = `<button type="button" class="btn sm pri" data-ses="${esc(f)}">${ic('user')}Open agent</button>`;
  } else if (n.kind === 'team') {
    meta = `${cap(n.t.status)} · ${n.t.members} members · ${tasksLabel(n.t.progress || {})}`;
    open = `<button type="button" class="btn sm pri" data-team="${esc(n.t.id)}">${ic('team')}Open team</button>`;
  } else {
    meta = 'Group chat';
    open = `<button type="button" class="btn sm pri" data-room="${esc(n.room)}">${ic('chat')}Open chat</button>`;
  }
  const rel = (id, e) => {
    const x = G.nodes.get(id);
    if (e.kind === 'team') return x.kind === 'team' ? `${cap(x.t.status)}${e.last ? ' · team activity ' + ago(e.last) + ' ago' : ''}` : `${M.live.has(id) ? 'Live' : 'Offline'}${e.last ? ' · team activity ' + ago(e.last) + ' ago' : ''}`;
    if (e.kind === 'link') return `${linkKindLabel(e.link.kind)} · no messages in this window`;
    return `${e.count} message${e.count === 1 ? '' : 's'} · last ${ago(e.last)} ago`;
  };
  const by = { team: [], msg: [], room: [], link: [] };
  EGO.ring.forEach((id) => by[nb.get(id).kind].push(id));
  const title = { team: n.kind === 'agent' ? 'Teams' : 'Members', msg: 'Messages', room: n.kind === 'room' ? 'Members' : 'Group chats', link: 'Links' };
  const grp = (k) => (by[k].length ? overline(title[k], by[k].length) + by[k].map((id) => row({ lead: lead(G.nodes.get(id)), title: G.nodes.get(id).label, meta: rel(id, nb.get(id)), attrs: { 'data-tg-go': id, title: 'Walk to ' + G.nodes.get(id).label } })).join('') : '');
  const body = ['team', 'msg', 'room', 'link'].map(grp).join('');
  return `<div class="tg-ego"><div class="tg-ego-h">${lead(n)}<div class="tg-ego-id"><h4>${esc(n.label)}</h4><p>${esc(meta)}</p></div></div>`
    + `<div class="tg-ego-act"><button type="button" class="btn sm${EGO.pinned ? ' on' : ''}" data-tg-pin aria-pressed="${EGO.pinned}">${EGO.pinned ? 'Unpin' : 'Pin'}</button>${open}</div>`
    + (body || none('link', 'No connections in this window')) + '</div>';
}
function egoPanels() {
  const G = EGO.G; if (!G) return;
  if (!EGO.focus) { renderTopoFeed(G.M, EGO.only); renderTgRank(G.M); return; }
  const html = egoPanelHtml();
  for (const box of [tgShown($('#topoFeed')), tgShown($('#tgRank'))]) {
    if (!box) continue;
    // Keep keyboard focus on the same control across a redraw.
    const a = box.contains(document.activeElement) ? document.activeElement : null, sel = a?.dataset.tgGo ? `[data-tg-go="${CSS.escape(a.dataset.tgGo)}"]` : a?.hasAttribute('data-tg-pin') ? '[data-tg-pin]' : a?.dataset.ses ? '[data-ses]' : null;
    if (htmlIf(box, html) && sel) box.querySelector(sel)?.focus();
  }
  egoHov(EGO.hov);
}
function egoPanelBind(box) {
  if (!box) return;
  box.addEventListener('click', (e) => {
    if (!EGO.focus) return;
    if (e.target.closest('[data-tg-pin]')) { e.stopPropagation(); egoPin(!EGO.pinned); return; }
    const b = e.target.closest('[data-tg-go]'); if (b) { e.stopPropagation(); EGO.pinned = true; egoSet(b.dataset.tgGo, true); }
  });
  box.addEventListener('pointerover', (e) => { if (EGO.focus) egoHov(e.target.closest('[data-tg-go]')?.dataset.tgGo || null); });
}
/* What the graph is drawn from. The 4 s refresh redraws only when this changes; the 10 s bucket keeps "12s ago" labels and the
   30 s activity colours current without redrawing on every poll. */
function topoSig() {
  const inv = S.inv, i0 = inv[0] || {}, f = TG_S.focus;
  return [EGO.vk, TG_S.win, TG_S.layers.team, TG_S.layers.msg, TG_S.layers.link, f ? f.kind + f.id : '', Math.floor(Date.now() / 10_000),
    S.agents.map((a) => a.id + a.status + a.label + a.project + a.role).join(), S.keys.length, inv.length, i0.id, i0.created_at, i0.result,
    S.ses.map((s) => (s.live ? s.agent.id : '')).join(), S.teams.map((t) => [t.id, t.name, t.status, t.members, t.lead_id, t.room_id, t.progress?.pct, (t.agent_ids || []).join()].join('/')).join(),
    (S.top?.comm_edges || []).map((e) => e.from + e.to + e.room_id + e.count + e.last_at).join(), S.links.map((l) => l.id || l.from_agent_id + l.to_agent_id).join(), S.convs.length].join('|');
}
function renderAgentGraph() {
  const graph = $('#agentGraph');
  if (!graph) return;
  const fresh = !graph.querySelector('svg.tg'), vk = innerWidth + 'x' + innerHeight + (TG_S.focus ? 'p' : '');
  // Measure only when the window or the level changed: reading the layout during a refresh, after the rest of the page was
  // written, forces a reflow. The graph gets the width and the height left in the window under it.
  if (fresh || EGO.vk !== vk) {
    syncTopoBar();
    const r = graph.getBoundingClientRect(), narrow = r.width < 560;
    EGO.vk = vk; EGO.W = Math.max(Math.round(r.width), 240);
    EGO.avail = Math.max(Math.round(innerHeight - (r.top + scrollY) - 44 - (narrow ? 104 : 40)), 300);
  }
  const sig = topoSig();
  if (!fresh && sig === EGO.sig) return;
  EGO.sig = sig;
  const M = topoModel();
  if (!M.agents.length) { graph.innerHTML = none('ses', 'No agents'); EGO.G = null; renderTopoFeed(M, null); renderTgRank(M); return; }
  const scope = topoScope(M), W = EGO.W, svg = egoSvg(graph), resized = EGO.G?.W !== W;
  const G = (EGO.G = topoGraph(M, scope, W, EGO.avail));
  EGO.only = TG_S.focus ? new Set([...scope.ids].filter((id) => !scope.ext.has(id))) : null;
  svg.setAttribute('viewBox', `0 0 ${W} ${G.H}`);
  const caps = G.caps.map((c) => `<text class="tg-cap" x="${c.x.toFixed(1)}" y="${c.y.toFixed(1)}">${esc(trunc(c.name, G.narrow ? 22 : 34))}</text>`).join('');
  const cg = svg.querySelector('.tg-caps'); if (cg._html !== caps) { cg.innerHTML = caps; cg._html = caps; }
  egoSync(svg, G);
  egoApply(fresh || resized);
}
/* Phones: a ranked list under the graph ("Most active · last 24 h"), because a node diagram is a poor way to read who is busy. */
/* The feed shows from 768 px, the ranked list below it; only the one on screen is drawn (a resize redraws). */
const TG_PHONE = matchMedia('(max-width:767.98px)');
const tgShown = (box) => (box && (box.id === 'tgRank') === TG_PHONE.matches ? box : null);
function renderTgRank(M) {
  const box = tgShown($('#tgRank')); if (!box) return;
  const now = Date.now(), keyAgent = new Map(S.keys.map((k) => [k.id, k.agent_id])), ids = new Set(M.agents.map((a) => a.id)), by = new Map();
  for (const i of S.inv) {
    if (now - i.created_at > TG_S.win) continue;
    const aid = keyAgent.get(i.credential_id); if (!aid || !ids.has(aid)) continue;
    const o = by.get(aid) || { calls: 0, last: 0, tool: '' }; o.calls++;
    if (i.created_at > o.last) { o.last = i.created_at; o.tool = i.tool; }
    by.set(aid, o);
  }
  const win = (TGW.find(([, ms]) => ms === TG_S.win) || ['24h'])[0].replace(/(\d)([a-z])/, '$1 $2');
  const L = [...by].sort((x, y) => y[1].calls - x[1].calls).slice(0, 8);
  htmlIf(box, overline('Most active', 'last ' + win) + (L.map(([aid, o]) => row({
    lead: `<span class="av lg">${esc(initials(agLabel(aid)))}<i class="st${M.live.has(aid) ? ' on' : ''}"></i></span>`, title: agLabel(aid),
    meta: raw(`<span class="tid">${esc(o.tool)}</span> · ${o.calls} call${o.calls === 1 ? '' : 's'}`), trail: `<span>${ago(o.last)}</span>`, attrs: { 'data-ses': aid } })).join('') || none('pulse', 'No calls in this window')));
}
function renderTopoFeed(M, only) {
  const box = tgShown($('#topoFeed')); if (!box) return;
  const keyAgent = new Map(S.keys.map((k) => [k.id, k.agent_id])), now = Date.now(), inScope = (id) => id && (!only || only.has(id));
  const recent = S.inv.filter((i) => now - i.created_at < REC_MS && inScope(keyAgent.get(i.credential_id))), L = recent.slice(0, 14);
  const agents = M ? M.agents.filter((a) => inScope(a.id)) : [];
  const liveN = agents.filter((a) => M.live.has(a.id)).length, activeN = agents.filter((a) => recency(M.act.get(a.id).last) === 'act').length;
  htmlIf(box, `<div class="tg-kpis"><div><b>${liveN}</b><small>Live</small></div><div><b${activeN ? ' class="ok-t"' : ''}>${activeN}</b><small>Active 30s</small></div><div><b>${recent.length}</b><small>Calls 5m</small></div></div>
    <h5 class="subh">Last 5 minutes</h5>` + (L.length ? L.map((i) => { const aid = keyAgent.get(i.credential_id);
      return `<button class="fe" data-ses="${esc(aid)}"><span class="dot${recency(i.created_at) === 'act' ? ' pulse' : ''} ${i.result === 'ok' ? 'ok' : 'bad'}"></span><span class="fe-main"><b>${esc(agLabel(aid))}</b><span class="mono">${esc(i.tool)}${i.result !== 'ok' ? ' · ' + esc(i.result) : ''}</span></span><span class="mono fe-age">${ago(i.created_at)}</span></button>`; }).join('') : none('pulse', 'Quiet')));
}
/* The project breadcrumb (Teams → Connections graph) lives above the graph; it follows TG_S on every render. */
function syncTopoBar() {
  const crumb = $('#tgCrumb'); if (!crumb) return;
  const f = TG_S.focus; crumb.hidden = !f; if (!f) { crumb.innerHTML = ''; return; }
  const up = 'Everyone';
  crumb.innerHTML = `<button class="btn sm" data-tg-up>${ic('back')}${up}</button>${ic('chev', 'sep')}<b>${f.kind === 'project' ? `${ic('graph')}Connections graph · ${esc(f.id)}` : esc(f.id)}</b>`;
}
function topoFocus(f) {
  setRoute('topology', f ? f.kind + ':' + f.id : '');
  EGO.focus = null; EGO.pinned = false; EGO.trail = [];
  TG_S.focus = f; renderAgentGraph(); window.scrollTo(0, 0);
}
const TG_LAYERS = [['team', 'Teams', 'team'], ['msg', 'Messages', 'chat'], ['link', 'Links', 'link']];
const TG_LEGEND = '<span><i class="tg-sw is-act"></i>Active 30s</span><span><i class="tg-sw is-msg"></i>Messages</span><span><i class="tg-sw is-team"></i>Team</span><span><i class="tg-sw is-link"></i>Link</span><span><i class="tg-sw is-den"></i>Denied 5m</span>';
VIEWS.topology = async (arg) => {
  TG_S.focus = null; egoReset();
  // project:<name> scopes the graph to a project; agent:<id> opens with that agent focused and pinned.
  if (typeof arg === 'string' && arg.startsWith('project:')) TG_S.focus = { kind: 'project', id: arg.slice(8) };
  else if (typeof arg === 'string' && arg.startsWith('agent:')) Object.assign(EGO, { focus: arg.slice(6), pinned: true });
  S.convs = (await api('/conversations').catch(() => ({ conversations: S.convs }))).conversations;
  return {
    t: `${ic('pulse')}Activity <span class="n">${S.agents.filter((a) => a.status !== 'archived').length}</span>`,
    a: `<button class="btn sm" data-go="tbuild">${ic('plus')}Team</button>`,
    b: `<div class="vtools tg-bar"><div class="seg" id="tgWin" role="group" aria-label="Time window">${TGW.map(([l, ms]) => `<button data-ms="${ms}" class="${ms === TG_S.win ? 'on' : ''}">${l}</button>`).join('')}</div>
        <div class="row only-d" id="tgLayers">${TG_LAYERS.map(([k, l, icn]) => `<button class="tog${TG_S.layers[k] ? ' on' : ''}" data-layer="${k}">${ic(icn)}${l}</button>`).join('')}</div>
        <button type="button" class="btn only-m" id="tgLayersBtn" aria-haspopup="dialog">${ic('sl')}Layers</button>
        <span class="tg-lg only-d">${TG_LEGEND}</span></div>` +
      `<nav class="tg-crumb" id="tgCrumb" aria-label="Topology level" hidden></nav>` +
      `<div class="tg-wrap"><div class="pcard tg-card"><div id="agentGraph" class="agent-graph"></div></div><aside id="topoFeed" class="tg-feed only-d" aria-label="Recent activity"></aside></div><div class="pcard only-m" id="tgRank"></div>`,
    after() {
      $('#tgWin').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; TG_S.win = +b.dataset.ms; $$('#tgWin button').forEach((x) => x.classList.toggle('on', x === b)); renderAgentGraph(); };
      $('#tgLayers').onclick = (e) => { const b = e.target.closest('[data-layer]'); if (!b) return; TG_S.layers[b.dataset.layer] = !TG_S.layers[b.dataset.layer]; b.classList.toggle('on'); renderAgentGraph(); };
      // Phones: the three layers are switches in one sheet, with the legend under them.
      $('#tgLayersBtn').onclick = (e) => {
        const sh = openSheet({ title: 'Layers', anchor: e.currentTarget, html: `<div class="sheet-list">${TG_LAYERS.map(([k, l, icn]) => row({ one: true, lead: ic(icn), title: l, trail: switchBtn(l, TG_S.layers[k], `data-layer="${k}"`) })).join('')}</div><div class="tg-lg sheet-lg">${TG_LEGEND}</div>` });
        sh.addEventListener('click', (ev) => {
          const b = ev.target.closest('[data-layer]'); if (!b) return;
          const k = b.dataset.layer; TG_S.layers[k] = flipSwitch(b);
          $$(`#tgLayers [data-layer="${k}"]`).forEach((x) => x.classList.toggle('on', TG_S.layers[k]));
          renderAgentGraph();
        });
      };
      $('#tgCrumb').onclick = (e) => { if (e.target.closest('[data-tg-up]')) topoFocus(null); };
      egoPanelBind($('#topoFeed')); egoPanelBind($('#tgRank'));
      renderAgentGraph();
    },
  };
};
const sesDot = (s) => `<span class="dot${s.live ? ' pulse ok' : ' idle'}"></span>`;
/* Overview sessions: who (live or when last seen), what they last did and touched, and where they run. */
const SES_N = 10;
function sesCard(s) {
  const a = s.agent, l = s.logins[0], lc = s.last_tool_call;
  const lead = `<span class="av lg">${esc(initials(a.label || '?'))}<i class="st${s.live ? ' on' : ''}" title="${s.live ? 'Logged in' : 'Not logged in'}"></i></span>`;
  const role = [a.role, a.project].filter(Boolean).join(' · ') || 'No role';
  const meta = raw(`${lc ? `<span class="tid">${esc(lc.tool)}</span> · ` : ''}${esc(role)}`);
  const when = lc ? ago(lc.at) : a.last_seen_at ? ago(a.last_seen_at) : 'never';
  const trail = `${s.concurrent_use ? pill('Shared', 'warn') : ''}${lc && lc.result !== 'ok' ? pill(lc.result, 'bad') : ''}${l ? `<span class="tr-where">${esc((l.pc?.name || '—') + ' · ' + (l.app || '—'))}</span>` : ''}<span class="tr-when">${esc(when)}</span>`;
  return row({ lead, title: a.label, meta, trail, attrs: { 'data-ses': a.id } });
}
function renderSes() {
  const L = S.ses.filter((s) => s.agent.status !== 'archived').sort((a, b) => b.live - a.live || (b.agent.last_seen_at || 0) - (a.agent.last_seen_at || 0));
  $('#sesN').textContent = L.filter((s) => s.live).length + ' live · ' + L.length;
  $('#sesT').innerHTML = L.slice(0, SES_N).map(sesCard).join('') || none('ses', 'No agents yet');
}
const tasksLabel = (p) => (p.total ? `${p.done}/${p.total} tasks` : 'No tasks');

const TONE = { running: 'ok', paused: 'warn', draft: 'idle', stopped: 'bad', done: 'info' };
const homeTeam = (t) => {
  const mem = (t.agent_ids || []).map((id) => AG(id)?.label).filter(Boolean);
  const done = t.progress?.done || 0, tot = t.progress?.total || 0;
  return `<div class="tmrow" data-team="${esc(t.id)}" tabindex="0" role="button">
    <div class="tmrow-hd"><span class="tmrow-name">${esc(t.name)}</span>${pill(cap(t.status), TONE[t.status] || 'idle')}</div>
    ${t.goal ? `<p class="tmrow-goal">${esc(t.goal)}</p>` : ''}
    <div class="tmrow-meta"><span class="avs">${mem.slice(0, 5).map((n) => `<span class="av" title="${esc(n)}">${esc(initials(n))}</span>`).join('')}${mem.length > 5 ? `<span class="meta">+${mem.length - 5}</span>` : ''}</span>${t.stalled ? pill(`${t.stalled} stalled`, 'warn') : ''}<span class="meta">${tot ? `${done} of ${tot} tasks` : 'No tasks'}</span></div>
    <span class="pb" role="progressbar" aria-label="Task progress" aria-valuenow="${t.progress?.pct || 0}" aria-valuemin="0" aria-valuemax="100"><i style="width:${t.progress?.pct || 0}%"></i></span></div>`;
};
const TEAMS_N = 4;
function renderTeamsCard() {
  $('#tmN').textContent = S.teams.length;
  const more = S.teams.length - TEAMS_N;
  $('#tmCard').innerHTML = S.teams.slice(0, TEAMS_N).map(homeTeam).join('') + (more > 0 ? row({ title: `${more} more team${more === 1 ? '' : 's'}`, one: true, chev: true, attrs: { 'data-go': 'teams' } }) : '') || none('team', 'No teams');
}

let SES_F = ''; // Sessions filter ('' all, '1' live); kept here so the background refresh does not reset it.
VIEWS.sessions = async () => {
  const all = (await api('/sessions?all=1')).sessions.sort((a, b) => b.live - a.live || (b.agent.last_seen_at || 0) - (a.agent.last_seen_at || 0));
  const liveN = all.filter((s) => s.live).length;
  return {
    t: `${ic('user')}Sessions <span class="n">${all.length}</span>`,
    b: `<div class="vtools"><div class="seg" id="sF" role="group" aria-label="Filter">${[['', 'All · ' + all.length], ['1', 'Live · ' + liveN]].map(([v, l]) => `<button class="${SES_F === v ? 'on' : ''}" data-f="${v}">${l}</button>`).join('')}</div></div><div class="pcard" id="sB"></div>`,
    after() {
      const draw = () => { $('#sB').innerHTML = all.filter((s) => !SES_F || s.live).map(sesCard).join('') || none('user', 'No sessions'); };
      draw(); tick($('#sF'), (b) => { SES_F = b.dataset.f; draw(); });
    },
  };
};

const SES_TABS = [['overview', 'Overview', 'user'], ['keys', 'Keys', 'key'], ['teams', 'Teams', 'team'], ['chats', 'Chats', 'chat'], ['links', 'Links', 'link'], ['activity', 'Activity', 'pulse']];
/* Agent detail. Phones: detail app bar (End logins and Archive in its overflow) + scrollable tabs; desktop: the context bar with the section switch. */
VIEWS.ses = async (arg) => {
  const [id, tab0] = String(arg).split('|'), tab = SES_TABS.some(([k]) => k === tab0) ? tab0 : 'overview';
  const u = encodeURIComponent(id);
  const [d, lkr, conversations, teams, dv] = await Promise.all([api('/sessions/' + u), api('/links?agent=' + u), api('/conversations'), api('/teams'), api('/agents/' + u + '/directives').catch(() => ({ directives: [], reports: [] }))]);
  const a = d.agent, LK = lkr.links, others = S.agents.filter((x) => x.id !== id && x.status !== 'archived');
  const chats = conversations.conversations.filter(room => room.members.some(member => member.agent_id === id));
  const groups = teams.teams.filter(team => team.agent_ids.includes(id));
  const sk = [...new Set(d.logins.map((l) => l.session_key_id).filter(Boolean))];
  const lc = d.last_tool_call;
  const counts = { keys: d.session_keys.length, teams: groups.length, chats: chats.length, links: LK.length, activity: d.recent_files.length + d.invocations.length };
  const re = () => openD('ses', id + '|' + tab, true);
  const endLogins = () => run(async () => { for (const k of sk) await post(`/keys/${k}/end-logins`); toast('Ended'); await refresh(); re(); });
  const archive = () => run(async () => { await post(`/sessions/${u}/archive`); toast('Archived'); closeD(); refresh(); });
  const bar = `<button class="btn ic" data-ctx-back aria-label="Back">${ic('back')}</button>
    <h2 id="ctxTitle">${sesDot(d)}<span class="ctx-name">${esc(a.label)}</span>${a.role ? `<span class="tag">${esc(a.role)}</span>` : ''}</h2>
    <nav class="seg ws-tabs" aria-label="Agent sections">${SES_TABS.map(([k, l, icn]) => `<button data-ses-tab="${esc(id)}|${k}" class="${k === tab ? 'on' : ''}"${k === tab ? ' aria-current="page"' : ''}>${ic(icn)}${l}${counts[k] ? `<span class="tabn">${counts[k]}</span>` : ''}</button>`).join('')}</nav>`;
  const tabsH = `<nav class="tabs only-m" role="tablist" aria-label="Agent sections">${SES_TABS.map(([k, l]) => `<button type="button" role="tab" aria-selected="${k === tab}" data-ses-tab="${esc(id)}|${k}" class="${k === tab ? 'on' : ''}">${l}${counts[k] ? `<span class="cnt">${counts[k]}</span>` : ''}</button>`).join('')}</nav>`;
  const V = {
    /* Overview in two columns. Left: who the agent is (status, role, its own words, team playbooks). Right: talking to it
       (send a directive or message, what you sent and whether it confirmed, hub notices). One card style throughout. */
    overview: () => {
      const acked = d.notices_acked_seq || 0;
      const NK = { directive: ['Directive', 'sl'], message: ['Message', 'chat'], role_changed: ['Role changed', 'user'], access_decision: ['Access decision', 'key'], permissions_changed: ['Permissions', 'shield'], link_added: ['Link', 'link'], link_removed: ['Link', 'link'], team_mode: ['Team mode', 'team'], task_overdue: ['Overdue', 'warn'], status_request: ['Status request', 'note'] };
      const mine = d.notices.filter((n) => n.kind === 'directive' || n.kind === 'message');
      const system = d.notices.filter((n) => n.kind !== 'directive' && n.kind !== 'message');
      const noteRow = (n) => { const [l, icn] = NK[n.kind] || [n.kind.replace(/_/g, ' '), 'note'];
        return `<li class="nt"><span class="nt-k">${ic(icn)}${esc(l)}</span><div class="nt-b">${esc(n.body)}</div><span class="nt-s ${n.seq <= acked ? 'ok' : ''}" title="${esc(dt(n.created_at))}">${n.seq <= acked ? ic('check') + 'Confirmed' : ic('clock') + 'Pending'} · ${ago(n.created_at)}</span></li>`; };
      const adminRole = a.role_source === 'admin';
      const playbooks = d.playbooks || [];
      const own = a.role_note || (!adminRole && a.role ? `${a.role}${a.role_detail ? ': ' + a.role_detail : ''}` : '');
      const card = (icn, title, body, act = '') => `<section class="agc"><header>${ic(icn)}<h4>${title}</h4>${act}</header>${body}</section>`;
      const status = `<section class="agc kvc">${kv('Status', `${pill(d.live ? 'Live' : 'Idle', d.live ? 'ok' : 'idle')} <span class="kv-sub">${lc || a.last_seen_at ? 'seen ' + ago(lc ? lc.at : a.last_seen_at) + ' ago' : 'never seen'}</span>`)}
        ${kv('Last call', lc ? `${esc(lc.tool)}${lc.result !== 'ok' ? ' ' + pill(lc.result, 'bad') : ''} <span class="kv-sub">${ago(lc.at)}</span>` : '—', { id: true })}
        ${kv('Logins', d.logins.length ? esc(`${d.logins.length} · ${d.logins.map((l) => (l.pc?.name || '—') + ' · ' + (l.app || '—')).join(', ')}`) + (d.concurrent_use ? ' ' + pill('Shared key', 'warn') : '') : 'None')}
        ${kv('Team', groups.length ? esc(groups.map((g) => g.name).join(', ')) : 'None')}${a.project ? kv('Project', esc(a.project)) : ''}${a.model_label ? kv('Model', esc(a.model_label)) : ''}</section>`;
      return {
        t: `${ic('user')}Overview`,
        a: moreBtn(),
        b: `<div class="ag-cols"><div class="ag-col">` + status +
          card('user', 'Role', `<div id="sRoleView">
              <div class="ag-role-h"><b class="ag-role-name">${esc(a.role || 'No role yet')}</b><span class="tag">${adminRole ? 'Set by you' : a.role_source === 'agent' ? 'Stated by the agent' : 'Not set'}</span></div>
              ${a.role_detail ? `<p>${esc(a.role_detail)}</p>` : '<p class="faint">No description yet.</p>'}
              <blockquote class="ag-own">${own ? esc(own) : '<span class="faint">The agent has not described itself (session_describe).</span>'}${a.status_text ? `<small>Status: ${esc(a.status_text)}</small>` : ''}</blockquote>
            </div>
            <div id="sRoleForm" hidden>
              <label class="fld"><span class="vlabel">Role</span><input class="inp" id="sRole" value="${esc(a.role || '')}" maxlength="80"></label>
              <label class="fld"><span class="vlabel">How it should understand the role</span><textarea class="inp" id="sRoleDetail" rows="4" maxlength="500">${esc(a.role_detail || '')}</textarea></label>
              <div class="row"><button class="btn ok sm" id="sRoleGo">${ic('check')}Save and tell the agent</button><button class="btn sm" id="sRoleCancel">Cancel</button></div>
            </div>`, `<button class="btn sm" id="sRoleEdit">${ic('edit')}Edit</button>`) +
          card('team', 'Team playbooks', playbooks.length ? playbooks.map((p) => `<div class="pbk">
              <div class="pbk-h"><span><button class="mem-name" data-team="${esc(p.team_id)}">${esc(p.team_name)}</button> · ${esc(p.role)}</span><button class="btn sm" data-pb-edit>${ic('edit')}Edit</button></div>
              <div class="pb-view"><article class="md task-md clamp">${mdRender(p.playbook || '', () => null)}</article><button type="button" class="btn ghost sm" data-clamp>Show all</button></div>
              <div class="pb-form" hidden><p class="meta">Applies to every <b>${esc(p.role)}</b> in ${esc(p.team_name)}. Members read it with team_info.</p><textarea class="inp mono" rows="8" maxlength="8000">${esc(p.playbook || '')}</textarea>
                <div class="row"><button class="btn ok sm" data-pb-save="${esc(p.team_id)}|${esc(p.role)}">${ic('check')}Save playbook</button><button class="btn sm" data-pb-cancel>Cancel</button></div></div>
            </div>`).join('') : '<p class="faint">Not in a team. Team members get a playbook for their role.</p>') +
          card('sl', 'Directives', (dv.directives.length ? dv.directives.map((x) => row({ title: x.title, meta: `${cap(x.scope_label)} · v${x.version}${x.reported_by === id ? ' · registered by it' : ''}${x.reviewed ? '' : ' · not reviewed'}`, trail: dirRead(x.acked_version === null ? 'unread' : x.acked_version >= x.version ? 'current' : 'outdated', x.acked_version), chev: true, attrs: { 'data-dir': x.id } })).join('') : '<p class="faint">No directives reach this agent.</p>')
            ,
            info('Standing rules from Work → Directives that reach this agent, and whether it confirmed the current version. Rules it registered itself are in force at once; you review them in Work → Directives.')) +
          `</div><div class="ag-col">` +
          card('chat', 'Tell the agent', `<div class="ag-send">
              <div class="seg" id="sNoteKind" role="group" aria-label="Kind"><button data-nk="directive" class="on">${ic('sl')}Directive</button><button data-nk="message">${ic('chat')}Message</button></div>
              <textarea class="inp" id="sNoteBody" rows="3" maxlength="4000" placeholder='A standing instruction, e.g. "Cite the source file for every claim."'></textarea>
              <label class="chk-row" id="sNoteKeepR"><input type="checkbox" id="sNoteKeep" checked> Keep as a standing directive for this agent</label>
              <div class="row"><button class="btn ok sm" id="sNoteGo" disabled>${ic('up')}Send</button>${info('Arrives with its next hub call, or at its next login if it is offline; it confirms with session_ack.')}</div>
            </div>
            ${mine.length ? `<ul class="nts">${mine.map(noteRow).join('')}</ul>` : ''}
            ${system.length ? `<details class="task-brief"><summary>${ic('chev')}From the hub (${system.length})</summary><ul class="nts">${system.map(noteRow).join('')}</ul></details>` : ''}`, info('The hub sees only what it gives the agent (role, playbooks, directives), not its local prompt, CLAUDE.md or skills.')) +
          `</div></div>`,
      };
    },
    keys: () => ({
      t: `${ic('key')}Keys <span class="n">${counts.keys}</span>`,
      b: `<div class="pcard">${d.session_keys.map((k) => row({ lead: ic('key'), title: k.label, meta: `Session key · ${k.last_used_at ? 'seen ' + ago(k.last_used_at) + ' ago' : 'never used'}`, trail: `${k.status !== 'active' ? pill(cap(k.status), k.status === 'suspended' ? 'warn' : 'bad') : ''}`, chev: true, attrs: { 'data-key': k.id } })).join('') || none('key', 'No keys')}</div>`,
    }),
    teams: () => ({
      t: `${ic('team')}Teams <span class="n">${counts.teams}</span>`,
      b: `<div class="pcard">${groups.map((t) => row({ lead: ic('team'), title: t.name, meta: `${tasksLabel(t.progress)} · ${t.members} member${t.members === 1 ? '' : 's'}`, trail: pill(cap(t.status), TONE[t.status] || 'idle'), chev: true, attrs: { 'data-team': t.id } })).join('') || none('team', 'No teams')}</div>`,
    }),
    chats: () => ({
      t: `${ic('chat')}Chats <span class="n">${counts.chats}</span>`,
      b: vtools(subTabs('data-chat-kind', [['', 'All'], ['direct', 'Direct'], ['group', 'Group']], '')) + `<div class="pcard" id="sesChats">${chats.map(convRow).join('') || none('chat', 'No chats')}</div>`,
    }),
    links: () => ({
      t: `${ic('link')}Links <span class="n">${counts.links}</span>`,
      b: `<div class="vtools"><span class="grow"></span><button type="button" class="btn" id="lNew">${ic('plus')}Add link</button></div><div class="pcard">${LK.map((l) => { const out = l.from_agent_id === id, o = out ? l.to_agent_id : l.from_agent_id;
        return row({ lead: `<span class="av lg">${esc(initials(agLabel(o)))}</span>`, title: raw(`<button type="button" class="mem-name" data-ses="${esc(o)}">${esc(agLabel(o))}</button>`), meta: `${out ? 'Outgoing' : 'Incoming'} · ${l.kind}`,
          trail: `${switchBtn('Messaging with ' + agLabel(o), l.grants_messaging, `data-lm="${esc(l.id)}" data-on="${l.grants_messaging ? 0 : 1}"`)}<button type="button" class="btn ic sm" data-ld="${esc(l.id)}" aria-label="Remove link">${ic('x')}</button>` }); }).join('') || none('link', 'No links')}</div>`,
    }),
    activity: () => {
      const files = [...d.recent_files.filter((f) => f.decision !== 'allow'), ...d.recent_files.filter((f) => f.decision === 'allow')], FN = 8;
      const fileRow = (f, i) => { const ok = f.decision === 'allow', what = ACTN[f.action] || f.action.replace('fs.', '');
        return row({ lead: ic(ok ? 'file' : 'ban'), title: ok ? what : what + ' denied', meta: raw(`<span title="${esc(f.path)}">${esc(midTrunc(f.path, 44))}</span>`), metaId: true, trail: `<span>${ago(f.created_at)}</span>`, cls: (ok ? '' : 'tint-bad ') + (i >= FN ? 'act-extra' : '') }); };
      const by = new Map();
      for (const i of d.invocations) { const o = by.get(i.tool) || { n: 0, bad: 0, last: 0 }; o.n++; if (i.result !== 'ok') o.bad++; o.last = Math.max(o.last, i.created_at); by.set(i.tool, o); }
      const calls = [...by].sort((x, y) => y[1].n - x[1].n);
      return {
        t: `${ic('pulse')}Activity`,
        b: sec('Files · ' + files.length, `<div id="actFiles">${files.map(fileRow).join('') || none('file', 'No file activity')}${files.length > FN ? row({ title: `Show all ${files.length} events`, one: true, group: true, expanded: false, attrs: { 'data-show-all': 'actFiles' } }) : ''}</div>`) +
          sec('Calls · ' + d.invocations.length, calls.map(([tool, o]) => row({ one: true, lead: ic('bolt'), title: raw(`<span class="mono">${esc(tool)}</span>`), trail: `${o.bad ? pill(`${o.bad} failed`, 'bad') : ''}<span>${o.n}×</span><span class="tr-when">${ago(o.last)}</span>` })).join('') || none('bolt', 'No calls')),
      };
    },
  };
  const v = V[tab]();
  return {
    ...v, bar, a: v.a || moreBtn(),
    dbar: { title: a.label, meta: [[a.project, a.role].filter(Boolean).join(' '), d.live ? 'live' : 'idle', lc || a.last_seen_at ? 'seen ' + ago(lc ? lc.at : a.last_seen_at) : 'never seen'].filter(Boolean).join(' · '),
      menu: [sk.length ? { label: 'End logins', icon: 'out', fn: endLogins } : null, { label: 'Archive', icon: 'trash', bad: true, confirm: 'Tap again to archive', fn: archive }] },
    b: tabsH + v.b,
    after() {
      const on = (sel, fn) => { const e = $(sel); if (e) e.onclick = fn; };
      on('#sRoleGo', () => run(async () => { await api('/agents/' + u, 'PATCH', { role: $('#sRole').value.trim() || null, role_detail: $('#sRoleDetail').value.trim() || null }); toast('Saved. The agent is told with its next call.'); await refresh(); re(); }));
      $$('.md.clamp').forEach((m) => (m.onclick = (e) => { if (!e.target.closest('a,button')) m.classList.toggle('open'); }));
      $$('[data-clamp]').forEach((b) => { const m = b.previousElementSibling; if (m.scrollHeight <= m.clientHeight + 1) { b.hidden = true; m.classList.add('open'); } });
      $$('[data-clamp]').forEach((b) => (b.onclick = () => { const m = b.previousElementSibling, open = m.classList.toggle('open'); b.textContent = open ? 'Show less' : 'Show all'; }));
      on('#sRoleEdit', () => { $('#sRoleView').hidden = true; $('#sRoleForm').hidden = false; $('#sRole').focus(); });
      on('#sRoleCancel', () => { $('#sRoleView').hidden = false; $('#sRoleForm').hidden = true; });
      let nk = 'directive';
      const nb = $('#sNoteKind');
      if (nb) nb.onclick = (e) => { const b = e.target.closest('[data-nk]'); if (!b) return; nk = b.dataset.nk; $$('#sNoteKind button').forEach((x) => x.classList.toggle('on', x === b)); $('#sNoteKeepR').hidden = nk !== 'directive'; $('#sNoteBody').placeholder = nk === 'directive' ? 'A standing instruction, e.g. "Cite the source file for every claim."' : 'A message, e.g. "Pause after the next step and report."'; };
      const nbody = $('#sNoteBody');
      if (nbody) nbody.oninput = () => { $('#sNoteGo').disabled = !nbody.value.trim(); };
      on('#sNoteGo', () => run(async () => {
        const txt = nbody.value.trim();
        // A kept directive is a hub record (scope: this agent) with a version the agent confirms; otherwise a one-off notice.
        if (nk === 'directive' && $('#sNoteKeep')?.checked) { await post('/directives', { title: trunc(txt.split('\n')[0], 80), body: txt, scope: { kind: 'agent', ref: id } }); toast('Directive kept; the agent is told'); }
        else { await post('/agents/' + u + '/notices', { kind: nk, body: txt }); toast(nk === 'directive' ? 'Directive sent' : 'Message sent'); }
        await refresh(); re();
      }));
      $$('[data-pb-edit]').forEach((b) => (b.onclick = () => { const box = b.closest('.pbk'); box.querySelector('.pb-view').hidden = true; box.querySelector('.pb-form').hidden = false; b.hidden = true; }));
      $$('[data-pb-cancel]').forEach((b) => (b.onclick = () => re()));
      $$('[data-pb-save]').forEach((b) => (b.onclick = () => run(async () => { const [tid, role] = b.dataset.pbSave.split('|'), txt = b.closest('.pbk').querySelector('textarea').value.trim(); if (!txt) return toast('A playbook cannot be empty', true); await api(`/teams/${tid}/roles/${role}`, 'PUT', { playbook: txt }); toast('Playbook saved for every ' + role + ' in the team'); re(); })));
      // Add link: a sheet with the peer, the kind and the messaging switch.
      on('#lNew', () => {
        const sh = openSheet({ title: 'Add link', html: `<div class="sheet-form"><label class="fld"><span class="vlabel">Agent</span><select class="sel fill" id="lA" aria-label="Agent">${others.map((x) => `<option value="${esc(x.id)}">${esc(x.label)}</option>`).join('')}</select></label>
          <label class="fld"><span class="vlabel">Kind</span><input class="inp" id="lK" value="peer" maxlength="40"></label>
          ${row({ one: true, title: 'Allow messaging', trail: switchBtn('Allow messaging', false, 'id="lM"') })}<button type="button" class="btn pri lg" id="lAdd">${ic('plus')}Add link</button></div>` });
        $('#lM', sh).onclick = (e) => flipSwitch(e.currentTarget);
        $('#lAdd', sh).onclick = () => run(async () => { const to = $('#lA', sh).value, kind = $('#lK', sh).value.trim(); if (!to || !kind) return toast('Link', true); await post('/links', { from_agent_id: id, to_agent_id: to, kind, grants_messaging: $('#lM', sh).classList.contains('on') }); closeSheet(); re(); });
      });
      $$('[data-ld]').forEach((b) => (b.onclick = () => run(async () => { await api('/links/' + b.dataset.ld, 'DELETE'); re(); })));
      $$('[data-lm]').forEach((b) => (b.onclick = () => run(async () => { await api('/links/' + b.dataset.lm, 'PATCH', { grants_messaging: b.dataset.on === '1' }); re(); })));
      $$('[data-show-all]').forEach((b) => (b.onclick = () => { const box = $('#' + b.dataset.showAll), all = box.classList.toggle('all'); b.setAttribute('aria-expanded', String(all)); b.querySelector('.lrow-title').textContent = all ? 'Show fewer' : `Show all ${box.querySelectorAll('.lrow:not(.group)').length} events`; }));
      $$('[data-chat-kind]').forEach((b) => (b.onclick = () => {
        $$('[data-chat-kind]').forEach((x) => x.classList.toggle('on', x === b));
        const k = b.dataset.chatKind, L = chats.filter((r) => !k || (r.kind === 'direct') === (k === 'direct'));
        $('#sesChats').innerHTML = L.map(convRow).join('') || none('chat', 'No chats');
      }));
    },
  };
};

const SETUP = {};
/* One-time recruit handoffs per team id, shown on the team page until dismissed (like SETUP for PCs). */
const HANDOFF = {};
VIEWS.pcs = async () => {
  const apps = S.keys.filter((k) => k.kind === 'app_key' && k.status !== 'revoked');
  const fi = { approved: ['check', 'approved'], rejected: ['x', 'rejected'], proposed: ['clock', 'proposed'] };
  /* One card per PC: the PC row (hostname, "n apps · state", Setup, a menu), its apps under an APPS overline, then its folders. */
  const pcCard = (p) => {
    const as = apps.filter((a) => a.machine_id === p.id), on = p.status === 'active', br = p.bridge || {}, su = SETUP[p.id], folders = p.folders || [];
    const state = br.online ? 'online' : br.paired ? 'paired' : 'unpaired';
    return `<div class="pcard">${row({ lead: `<i class="dot ${on ? 'ok' : 'bad'}" title="${on ? 'Active' : 'Suspended'}"></i>`, dot: true,
      title: raw(`<span class="mono" title="${esc([p.name, br.os, br.version].filter(Boolean).join(' · '))}">${esc(p.name)}</span>`),
      meta: `${as.length} app${as.length === 1 ? '' : 's'} · ${state}${on ? '' : ' · suspended'}`,
      trail: `<button type="button" class="btn sm" data-setup="${esc(p.id)}">${ic('key')}Setup</button><button type="button" class="btn ic sm" data-pc-more="${esc(p.id)}" aria-label="More actions for ${esc(p.name)}" aria-haspopup="dialog">${ic('more')}</button>` })}
      ${as.length ? overline('Apps', as.length) + as.map((a) => row({ one: true, lead: ic('app'), title: a.app_name || a.label, trail: a.live_logins ? `<span>${a.live_logins} live</span>` : '', chev: true, attrs: { 'data-key': a.id } })).join('') : ''}
      ${folders.length ? overline('Folders', folders.length) + folders.map((f) => { const m = fi[f.status] || fi.proposed;
        return row({ one: true, lead: `<span class="fi-${m[1]}">${ic(m[0])}</span>`, title: raw(`<span class="mono" title="${esc(f.path)}">${esc(midTrunc(f.path, 40))}</span>`),
          trail: f.status === 'proposed' ? `<button type="button" class="btn ic sm ok" data-fd="approve" data-p="${esc(p.id)}" data-path="${esc(f.path)}" aria-label="Approve folder">${ic('check')}</button><button type="button" class="btn ic sm bad" data-fd="reject" data-p="${esc(p.id)}" data-path="${esc(f.path)}" aria-label="Reject folder">${ic('x')}</button>` : '' }); }).join('') : ''}
      ${su ? `<div class="pc-setup">${codeBox(su.message)}<span class="tag self-start">${ic('clock')} ${Math.max(0, Math.round((su.exp - Date.now()) / 60000))}m</span></div>` : ''}</div>`;
  };
  return {
    t: `${ic('pc')}PCs <span class="n">${S.pcs.length}</span>`,
    a: `<button class="btn sm" data-go="app">${ic('plus')}App</button>`,
    b: S.pcs.length ? S.pcs.map(pcCard).join('') : `<div class="pcard">${none('pc', 'No PCs')}</div>`,
    after() {
      const re = async () => { await refresh(); openD('pcs', null, true); };
      $$('[data-pc-more]').forEach((b) => (b.onclick = () => {
        const p = PC(b.dataset.pcMore), on = p.status === 'active';
        openMenu([
          { label: on ? 'Suspend PC' : 'Resume PC', icon: on ? 'pause' : 'play', bad: on, confirm: on ? 'Tap again to suspend' : '', fn: () => run(async () => { await post(`/pcs/${p.id}/${on ? 'suspend' : 'reactivate'}`); re(); }) },
          { label: 'Add app', icon: 'plus', fn: () => openD('app', p.id) },
        ], b);
      }));
      $$('[data-setup]').forEach((b) => (b.onclick = () => run(async () => { const r = await post(`/pcs/${b.dataset.setup}/setup`); SETUP[b.dataset.setup] = { message: r.setup_message, exp: r.expires_at }; re(); })));
      $$('[data-fd]').forEach((b) => (b.onclick = () => run(async () => { await post(`/pcs/${b.dataset.p}/folders/${encodeURIComponent(b.dataset.path)}/${b.dataset.fd}`); re(); })));
    },
  };
};

/* Work → Teams: a card per project. Its header band says "Project" and holds the project actions; teams are 56 px rows
   inside it with the same columns in every card, and agents in no team form the last card.
   Filters live in the route (#teams/s=running&n=1&o=act&q=…) so the background redraw and Back keep them. */
const TM_ST = [['', 'All'], ['running', 'Running'], ['draft', 'Draft'], ['paused', 'Paused'], ['done', 'Done']];
const TM_SORT = [['', 'Sort: Needs attention'], ['act', 'Sort: Last activity'], ['name', 'Sort: Name']];
const TM_POOL = 'Unassigned agents';
function tmArgs(a = '') {
  a = String(a ?? '');
  const f = { s: '', n: '', o: '', q: '' };
  if (a === '') return f;
  if (!a.includes('=')) return null;
  const p = new URLSearchParams(a);
  if ([...p.keys()].some((k) => !(k in f))) return null;
  const x = { s: p.get('s') || '', n: p.get('n') === '1' ? '1' : '', o: p.get('o') || '', q: (p.get('q') || '').slice(0, 100) };
  return TM_ST.some(([k]) => k === x.s) && TM_SORT.some(([k]) => k === x.o) ? x : null;
}
const tmArgStr = (f) => { const p = new URLSearchParams(); for (const k of ['s', 'n', 'o', 'q']) if (f[k]) p.set(k, f[k]); return p.toString(); };
/* Folded project groups survive the background redraw (they are not in the route). */
const TM_UI = { folded: new Set() };
/* What needs the operator or the coordinator, per team: questions and approvals waiting on you, blocked tasks, stalled members. */
function tmAttn(t) {
  const asks = (S.dec || []).filter((d) => d.team_id === t.id && d.status === 'open').length + (t.approvals || 0);
  return { asks, blocked: t.counts?.blocked || 0, stalled: t.stalled || 0 };
}
const tmScore = (a) => a.asks * 4 + a.blocked * 2 + a.stalled;
/* A team belongs to its lead's project, else to the project most of its members are in. */
function tmProject(t) {
  const lead = AG(t.lead_id)?.project; if (lead) return lead;
  const n = new Map(); for (const id of t.agent_ids || []) { const p = AG(id)?.project; if (p) n.set(p, (n.get(p) || 0) + 1); }
  return [...n].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || NO_PROJECT;
}
function tmModel(f) {
  const M = topoModel(), q = f.q.toLowerCase(), inTeam = new Set(S.teams.flatMap((t) => t.agent_ids || []));
  const teams = S.teams.map((t) => {
    const mem = (t.agent_ids || []).map((id) => AG(id)).filter(Boolean);
    return { t, proj: tmProject(t), mem, lead: t.lead_id ? agLabel(t.lead_id) : '', attn: tmAttn(t), last: t.last_activity_at || t.updated_at || 0 };
  });
  const hit = (x) => !q || [x.t.name, x.proj, x.lead, ...x.mem.map((a) => a.label)].some((s) => String(s || '').toLowerCase().includes(q));
  const counts = Object.fromEntries(TM_ST.map(([k]) => [k, teams.filter((x) => hit(x) && (!k || x.t.status === k)).length]));
  const needN = teams.filter((x) => hit(x) && x.attn.asks).length;
  const shown = teams.filter((x) => hit(x) && (!f.s || x.t.status === f.s) && (!f.n || x.attn.asks));
  const seen = (a) => Math.max(a.last_seen_at || 0, M.act.get(a.id)?.last || 0);
  const pool = f.s || f.n ? [] : M.agents.filter((a) => !inTeam.has(a.id) && (!q || [a.label, a.role, a.project].some((s) => String(s || '').toLowerCase().includes(q))))
    .map((a) => ({ a, live: M.live.has(a.id), last: seen(a) }));
  return { M, teams, shown, counts, needN, pool };
}
const tmSorter = (o) => ({
  act: (a, b) => b.last - a.last,
  name: (a, b) => a.t.name.localeCompare(b.t.name),
  '': (a, b) => tmScore(b.attn) - tmScore(a.attn) || b.last - a.last,
}[o]);
function tmGroups(f, D) {
  const by = new Map(); for (const x of D.shown) { if (!by.has(x.proj)) by.set(x.proj, []); by.get(x.proj).push(x); }
  const G = [...by].map(([name, L]) => ({ name, L: L.sort(tmSorter(f.o)), all: D.teams.filter((x) => x.proj === name) }));
  const key = { act: (g) => -Math.max(...g.L.map((x) => x.last)), name: () => 0, '': (g) => -Math.max(...g.L.map((x) => tmScore(x.attn))) }[f.o];
  return G.sort((a, b) => (a.name === NO_PROJECT) - (b.name === NO_PROJECT) || key(a) - key(b) || (f.o === '' ? Math.max(...b.L.map((x) => x.last)) - Math.max(...a.L.map((x) => x.last)) : 0) || a.name.localeCompare(b.name));
}
const tmAvatars = (labels) => `<span class="tm-avs" title="${esc(labels.join(', '))}">${labels.slice(0, 4).map((n) => `<span class="av">${esc(initials(n))}</span>`).join('')}${labels.length > 4 ? `<span class="av more">+${labels.length - 4}</span>` : ''}</span>`;
const tmPlural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
/* One team row: team icon · name and lead · status · progress · needs attention · members · last activity · "Open team".
   The whole row is the one way to open a team; its trailing words say so. On phones the cells after the status fold
   into the second line (lead · progress · what needs attention), and the time with an open chevron stays right. */
function tmRow(x) {
  const { t, attn } = x, done = t.progress?.done || 0, tot = t.progress?.total || 0, pct = t.progress?.pct || 0;
  const at = [attn.asks ? pill(`${attn.asks} waiting on you`, 'bad') : '', attn.blocked ? pill(`${attn.blocked} blocked`, 'warn') : '', attn.stalled ? pill(`${attn.stalled} stalled`, 'warn') : ''].join('');
  const atTxt = [attn.asks ? `<span class="bad-t">${attn.asks} waiting on you</span>` : '', attn.blocked ? `<span class="warn-t">${attn.blocked} blocked</span>` : '', attn.stalled ? `<span class="warn-t">${attn.stalled} stalled</span>` : ''].filter(Boolean);
  const lead = x.lead ? `Lead: ${esc(x.lead)}` : 'No lead';
  const mMeta = [x.lead ? esc(x.lead) : '', tot ? `${done}/${tot}` : 'No tasks', ...atTxt].filter(Boolean).join(' · ');
  return `<div class="tm-row" role="row" tabindex="0" data-team="${esc(t.id)}" title="Open team ${esc(t.name)}" aria-label="Open team ${esc(t.name)}">
    <span class="tm-c tm-lead" role="cell" aria-hidden="true"><span class="tm-ico">${ic('team')}</span></span>
    <span class="tm-c tm-name" role="cell"><b>${esc(t.name)}</b><span class="meta"><span class="only-d">${lead}</span><span class="only-m">${mMeta}</span></span></span>
    <span class="tm-c tm-st" role="cell">${pill(cap(t.status), TONE[t.status] || 'idle')}</span>
    <span class="tm-c tm-prog" role="cell"><span class="pb" role="progressbar" aria-label="Task progress" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><i class="s-${esc(t.status)}" style="width:${pct}%"></i></span><span>${tot ? `${done}/${tot}` : '–'}</span></span>
    <span class="tm-c tm-attn" role="cell"${atTxt.length ? ` title="${esc(atTxt.map((h) => h.replace(/<[^>]+>/g, '')).join(', '))}"` : ''}>${at || '<span class="faint">–</span>'}</span>
    <span class="tm-c tm-mem" role="cell">${tmAvatars(x.mem.map((a) => a.label))}</span>
    <span class="tm-c tm-when" role="cell">${x.last ? ago(x.last) : '–'}${ic('chev', 'chev only-m')}</span>
    <span class="tm-c tm-open" role="cell" aria-hidden="true">Open team${ic('chev', 'chev')}</span></div>`;
}
/* An agent in no team, in the same columns: agent icon · name and role · Live when logged in · itself as the member · "Open agent". */
function tmPoolRow(p) {
  const { a } = p, meta = [a.role || 'No role', a.project || ''].filter(Boolean).map(esc).join(' · ');
  return `<div class="tm-row" role="row" tabindex="0" data-ses="${esc(a.id)}" title="Open agent ${esc(a.label)}" aria-label="Open agent ${esc(a.label)}">
    <span class="tm-c tm-lead" role="cell" aria-hidden="true"><span class="tm-ico agent">${ic('bot')}</span></span>
    <span class="tm-c tm-name" role="cell"><b>${esc(a.label)}</b><span class="meta">${meta}</span></span>
    <span class="tm-c tm-st" role="cell">${p.live ? pill('Live', 'ok') : ''}</span>
    <span class="tm-c tm-prog" role="cell"><span class="faint">–</span></span>
    <span class="tm-c tm-attn" role="cell"><span class="faint">–</span></span>
    <span class="tm-c tm-mem" role="cell">${tmAvatars([a.label])}</span>
    <span class="tm-c tm-when" role="cell" title="${p.last ? 'Last seen' : 'Never signed in'}">${p.last ? ago(p.last) : '–'}${ic('chev', 'chev only-m')}</span>
    <span class="tm-c tm-open" role="cell" aria-hidden="true">Open agent${ic('chev', 'chev')}</span></div>`;
}
/* Fold button of a card: a caret and a word ("Collapse", "Show 4 teams"); never a right chevron, which only means "open". */
function tmFoldBtn(key, open, show, name) {
  const tip = open ? `Collapse ${name}` : `Show ${show} of ${name}`;
  return `<button type="button" class="btn sm tm-fold" data-tmgrp="${esc(key)}" aria-expanded="${open}" title="${esc(tip)}" aria-label="${esc(tip)}">${ic(open ? "cup" : "cdown")}<span>${open ? "Collapse" : "Show " + show}</span></button>`;
}
/* A project card's header band: project icon, the word "Project" and the name, then teams · agents · last activity,
   the denied-calls pill (opens Audit), Connections graph (who talks to whom in the project) and the fold button. */
function tmBand(g, open) {
  const now = Date.now(), noProj = g.name === NO_PROJECT;
  const ids = new Set(g.all.flatMap((x) => x.t.agent_ids || [])), last = Math.max(0, ...g.all.map((x) => x.last));
  const den = S.inv.filter((i) => i.result === 'denied' && !i.now_allowed && now - i.created_at < 3600_000 && ids.has(i.agent_id || keyAgentOf(i.credential_id))).sort((a, b) => b.created_at - a.created_at);
  const denWho = [...new Set(den.map((i) => i.agent_id || keyAgentOf(i.credential_id)))];
  const denCalls = tmPlural(den.length, 'denied call');
  const denTip = den.length ? `${denCalls} in the last hour. Latest: ${agLabel(denWho[0])}, ${den[0].tool}${denTarget(den[0]) ? ' on ' + denTarget(den[0]) : ''}, ${ago(den[0].created_at)} ago. Open them in Audit.` : '';
  const denPill = den.length ? `<button type="button" class="pill bad pill-btn tm-den" data-go="log" data-arg="calls|${denWho.length === 1 ? 'agent:' + esc(denWho[0]) : ''}|denied" title="${esc(denTip)}" aria-label="${esc(`${denCalls} in the last hour, open in Audit`)}">${ic('ban')}<span class="only-d">${denCalls} · Open in Audit</span><span class="only-m">${den.length} denied · Audit</span></button>` : '';
  const facts = [tmPlural(g.all.length, 'team'), tmPlural(ids.size, 'agent'), last ? `active ${ago(last)} ago` : 'no activity yet'].join(' · ');
  const label = noProj ? 'Teams in no project' : g.name;
  const act = noProj ? '' : `<button type="button" class="btn sm" data-go="topology" data-arg="project:${esc(g.name)}" title="Open the connections graph for ${esc(g.name)}" aria-label="Open the connections graph for ${esc(g.name)}">${ic('graph')}<span class="only-d">Connections graph</span><span class="only-m">Graph</span></button>`;
  return `<div class="tm-band"><span class="tm-ico proj" aria-hidden="true">${ic('proj')}</span><h2 class="tm-pn"><span class="tm-ov">${noProj ? 'Not in a project' : 'Project'}</span><span class="tm-gn">${esc(label)}</span></h2>
    <span class="meta tm-gf">${facts}</span><span class="tm-pacts">${denPill}${act}${tmFoldBtn(g.name, open, tmPlural(g.all.length, 'team'), noProj ? label.toLowerCase() : 'project ' + g.name)}</span></div>`;
}
const tmHead = () => `<div class="tm-row tm-head only-d" role="row"><span role="columnheader"><span class="sr">Type</span></span><span role="columnheader">Team</span><span role="columnheader">Status</span><span role="columnheader">Progress</span><span role="columnheader">Needs attention</span><span role="columnheader" class="tm-mem">Members</span><span role="columnheader" class="tm-when">Activity</span><span role="columnheader"><span class="sr">Open</span></span></div>`;
/* Work → Teams: a card per project (a header band, then its teams as rows), and agents in no team as the last card. */
function tmTableHtml(f, D) {
  const G = tmGroups(f, D);
  let h = G.map((g) => { const open = !TM_UI.folded.has(g.name), label = g.name === NO_PROJECT ? 'Teams in no project' : g.name;
    return `<section class="tm-proj${open ? '' : ' folded'}" aria-label="${esc(g.name === NO_PROJECT ? label : 'Project ' + g.name)}">${tmBand(g, open)}${open ? `<div class="tm-tbl" role="table" aria-label="Teams in ${esc(label)}">${tmHead()}${g.L.map(tmRow).join('')}</div>` : ''}</section>`; }).join('');
  if (D.pool.length) {
    const open = !TM_UI.folded.has(TM_POOL), L = D.pool.slice().sort(f.o === 'name' ? (a, b) => a.a.label.localeCompare(b.a.label) : (a, b) => b.live - a.live || b.last - a.last);
    h += `<section class="tm-proj tm-pool${open ? '' : ' folded'}" aria-label="${TM_POOL}"><div class="tm-band"><span class="tm-ico agent" aria-hidden="true">${ic('bot')}</span><h2 class="tm-pn"><span class="tm-ov">Not in a team</span><span class="tm-gn">${TM_POOL}</span></h2>
      <span class="meta tm-gf">${tmPlural(D.pool.length, 'agent')} · ${D.pool.filter((p) => p.live).length} live</span><span class="tm-pacts">${info('Agents in no team. Add one to a team to give it work.')}${tmFoldBtn(TM_POOL, open, tmPlural(D.pool.length, 'agent'), 'unassigned agents')}</span></div>${open ? `<div class="tm-tbl" role="table" aria-label="${TM_POOL}">${L.map(tmPoolRow).join('')}</div>` : ''}</section>`;
  }
  if (!h) return `<div class="card">${none('team', D.teams.length || D.M.agents.length ? 'No team matches these filters' : 'No teams yet')}</div>`;
  return h;
}
/* Toolbar: search, status with counts, Needs me and sort inline from 768 px; on phones a filter button opens them in a sheet. */
function tmTools(f, D) {
  const st =`<div class="seg fit" role="group" aria-label="Status">${TM_ST.map(([k, l]) => `<button type="button" data-tms="${k}" class="${k === f.s ? 'on' : ''}" aria-pressed="${k === f.s}">${l} <span class="faint">${D.counts[k]}</span></button>`).join('')}</div>`;
  const need = `<button type="button" class="btn${f.n ? ' on' : ''}" id="tmNeed" aria-pressed="${!!f.n}" title="Show only teams with questions or approvals waiting on you">Needs me <span class="fcount">${D.needN}</span></button>`;
  const sort = `<select class="sel" id="tmSort" aria-label="Sort">${TM_SORT.map(([k, l]) => `<option value="${k}"${k === f.o ? ' selected' : ''}>${l}</option>`).join('')}</select>`;
  return st + need + sort;
}
function tmToolbar(f, D) {
  const n = ['s', 'n', 'o', 'q'].filter((k) => f[k]).length;
  return vtools(`<div class="srch only-d tm-q">${ic('search')}<input class="inp" id="tmQ" type="search" placeholder="Search teams, agents, projects" aria-label="Search teams" value="${esc(f.q)}" autocomplete="off"></div>`
    + `<span class="only-d tm-tools" id="tmTools">${tmTools(f, D)}</span><span class="only-m">${filterBtn('tmMore', n)}</span>`);
}
/* Redraw in place: the list and the toolbar counts, keeping the page scroll; replace the route (no history entry per keystroke). */
function tmSet(patch) {
  const f = { ...(tmArgs(DR.arg) || tmArgs('')), ...patch };
  DR.arg = tmArgStr(f); setRoute('teams', DR.arg, false);
  const D = tmModel(f), box = $('#tmList'), tools = $('#tmTools');
  if (box) { box.innerHTML = tmTableHtml(f, D); tipIcons(box); }
  // Redraw the chips (their counts follow the search) but not the search field, so typing keeps its focus.
  if (tools) { const foc = tools.contains(document.activeElement) && focusSel(); tools.innerHTML = tmTools(f, D); tmBindBar(); if (foc) $(foc)?.focus(); }
  setFilterCount('tmMore', ['s', 'n', 'o', 'q'].filter((k) => f[k]).length);
  return f;
}
function tmBindBar() {
  const q = $('#tmQ'); if (q) onSearch(q, (v) => { tmSet({ q: v }); });
  $$('[data-tms]').forEach((b) => (b.onclick = () => tmSet({ s: b.dataset.tms })));
  const nd = $('#tmNeed'); if (nd) nd.onclick = () => tmSet({ n: (tmArgs(DR.arg) || {}).n ? '' : '1' });
  const so = $('#tmSort'); if (so) { so.onchange = () => tmSet({ o: so.value }); so.onclick = (e) => e.stopPropagation(); }
  const m = $('#tmMore'); if (m) m.onclick = (e) => tmFilterSheet(e.currentTarget);
}
function tmFilterSheet(btn) {
  const f = tmArgs(DR.arg) || tmArgs(''), D = tmModel(f);
  const sh = openSheet({ title: 'Filter teams', anchor: btn, html: `<div class="sheet-form">
    <label class="fld"><span class="vlabel">Search</span><div class="srch">${ic('search')}<input class="inp" id="tmQm" type="search" placeholder="Search teams, agents, projects" aria-label="Search teams" value="${esc(f.q)}"></div></label>
    ${selField('tmSm', 'Status', TM_ST.map(([k, l]) => [k, `${l} (${D.counts[k]})`]), f.s)}
    <label class="chk-row"><input type="checkbox" id="tmNm"${f.n ? ' checked' : ''}>Needs me only (${D.needN})</label>
    ${selField('tmOm', 'Sort', TM_SORT.map(([k, l]) => [k, l.replace('Sort: ', '')]), f.o)}
    <div class="sheet-acts"><button type="button" class="btn lg" id="tmClear">Clear</button><button type="button" class="btn pri lg" data-sheet-close>Done</button></div></div>` });
  const cnt = () => setFilterCount('tmMore', ['s', 'n', 'o', 'q'].filter((k) => (tmArgs(DR.arg) || {})[k]).length);
  onSearch($('#tmQm', sh), (q) => { tmSet({ q }); cnt(); });
  $('#tmSm', sh).onchange = (e) => { tmSet({ s: e.target.value }); cnt(); };
  $('#tmNm', sh).onchange = (e) => { tmSet({ n: e.target.checked ? '1' : '' }); cnt(); };
  $('#tmOm', sh).onchange = (e) => { tmSet({ o: e.target.value }); cnt(); };
  $('#tmClear', sh).onclick = () => { tmSet({ s: '', n: '', o: '', q: '' }); cnt(); closeSheet(); };
}
VIEWS.teams = async (arg = '') => {
  const f = tmArgs(arg) || tmArgs(''), D = tmModel(f);
  return {
    t: `${ic('team')}Teams <span class="n">${S.teams.length}</span>`,
    a: `<button class="btn sm pri" data-go="tbuild">${ic('plus')}Team</button>`,
    b: `<div id="tmBar">${tmToolbar(f, D)}</div><div class="tm-stack" id="tmList">${tmTableHtml(f, D)}</div>`,
    after() {
      tmBindBar();
      const box = $('#tmList');
      // Folding is not an edit: keep it from pausing the background redraw. Clicks on rows reach the global handlers (data-team, data-ses, data-go).
      box.addEventListener('click', (e) => {
        const g = e.target.closest('[data-tmgrp]'); if (!g) return;
        const k = g.dataset.tmgrp; TM_UI.folded[TM_UI.folded.has(k) ? 'delete' : 'add'](k); tmSet({}); $(`[data-tmgrp="${CSS.escape(k)}"]`)?.focus();
      });
    },
  };
};

/* Task deadline on a board card: overdue (on-demand), check-in or lease time, waiting to start, awaiting review. */
const dur2 = (ms) => { const m = Math.round(Math.abs(ms) / 60000); return m < 60 ? m + ' min' : m < 2880 ? Math.round(m / 60) + ' h' : Math.round(m / 1440) + ' d'; };
function tkText(k, t) {
  const now = Date.now();
  if (k.overdue_at) return { text: 'Overdue ' + dur2(now - (k.lease_expires_at || k.overdue_at)), cls: 'bad-t' };
  if (k.status === 'in_review') return { text: 'Awaiting review', cls: '' };
  if (!['assigned', 'in_progress'].includes(k.status) || !k.lease_expires_at) return null;
  const left = k.lease_expires_at - now, label = t.delivery_mode === 'on_demand' ? 'Check-in' : 'Lease';
  return { text: k.status === 'assigned' ? 'Waiting to start' : `${label} ${left > 0 ? 'in ' + dur2(left) : 'now'}`, cls: left < 30 * 60000 ? 'warn-t' : '' };
}
/* The team plan (requirements the goal implies, then milestones), kept by the coordinator, in two layers.
   The team page shows a summary: the numbers, what needs attention, and a row for each full list.
   The lists open on their own screens (VIEWS.plan): requirements as list rows with a Must / Should / All filter, milestones as a stepper. */
const REQ_ST = { open: ['Open', 'open'], met: ['Met', 'met'], unclear: ['Unclear', 'unclear'], dropped: ['Dropped', 'dropped'] };
const MS_ST = { planned: ['Planned', 'idle'], in_progress: ['In progress', 'accent'], reached: ['Reached', 'ok'], missed: ['Missed', 'bad'], dropped: ['Dropped', 'idle'] };
const PRI = { must: 'Must', should: 'Should', could: 'Could' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/* "10 Nov", with the year only when it is not this year. Never a numeric date: those read differently by locale. */
const planDate = (t) => { const d = new Date(t); return `${d.getDate()} ${MONTHS[d.getMonth()]}${d.getFullYear() === new Date().getFullYear() ? '' : ' ' + d.getFullYear()}`; };
const planSentence = (s) => (/[.!?…]$/.test(s.trim()) ? s.trim() : s.trim() + '.');
const planLate = (m) => m.due_at && m.due_at < Date.now() && ['planned', 'in_progress'].includes(m.status);
function planModel(t) {
  const p = t.plan || { requirements: [], milestones: [] }, R = p.requirements, M = p.milestones;
  const live = R.filter((r) => r.status !== 'dropped');
  return {
    p, R, M, ms: Object.fromEntries(M.map((m) => [m.key, m])), live, met: live.filter((r) => r.status === 'met').length,
    unclear: R.filter((r) => r.status === 'unclear').length, mustOpen: R.filter((r) => r.priority === 'must' && r.status === 'open').length, reached: M.filter((m) => m.status === 'reached').length,
  };
}
const planGlyph = (tone, icon, label) => `<span class="pl-lead ${tone}" role="img" aria-label="${esc(label)}" title="${esc(label)}">${icon}</span>`;
const planTitle = (s) => raw(`<span title="${esc(s)}">${esc(s)}</span>`);
// Requirement: status glyph, title, "Must · M1, M2 · 2 of 3 tasks". The full text (title, detail, criteria, evidence) sits behind the info button.
function planReq(r, ms) {
  const [lbl, tone] = REQ_ST[r.status] || [r.status, 'dropped'];
  const msTip = (m, k) => (m ? `${m.title} · ${(MS_ST[m.status] || [m.status])[0]}` : k);
  const links = r.links.length ? r.links.map((k) => `<span class="pl-k" title="${esc(msTip(ms[k], k))}">${esc(k)}</span>`).join(', ') : '<span title="No milestone linked; fine for open-ended research">No milestone</span>';
  const meta = [r.priority ? `<span${r.priority === 'must' ? ' class="pl-must"' : ''}>${esc(PRI[r.priority] || r.priority)}</span>` : '', links,
    r.tasks.total ? `<span title="Linked tasks done">${r.tasks.done} of ${r.tasks.total} task${r.tasks.total === 1 ? '' : 's'}</span>` : ''].filter(Boolean).join(' · ');
  const more = [r.title, r.detail, r.criteria && 'Done when: ' + r.criteria, r.evidence && 'Evidence: ' + r.evidence].filter(Boolean).map(planSentence).join(' ');
  return row({ lead: planGlyph(tone, { met: ic('check'), unclear: ic('warn'), dropped: ic('ban') }[r.status] || '', lbl), title: planTitle(r.title), meta: raw(meta), trail: info(more), cls: `pl-req${r.status === 'dropped' ? ' pl-off' : ''}` });
}
// Milestone: status dot on the name line, "M2 · In progress" under it, the date on the right.
function planMile(m) {
  const [lbl, tone] = MS_ST[m.status] || [m.status, 'idle'], late = planLate(m);
  return row({ lead: `<span class="dot ${tone}" title="${esc(lbl)}"></span>`, title: planTitle(m.title),
    meta: raw(`<span class="pl-k">${esc(m.key)}</span> · ${esc(lbl)}${late ? ' · <span class="pl-late">Overdue</span>' : ''}`),
    trail: m.due_at ? `<span${late || m.status === 'missed' ? ' class="pl-late"' : ''}>${planDate(m.due_at)}</span>` : '', cls: `pl-m${m.status === 'dropped' ? ' pl-off' : ''}` });
}
/* Plan items that need a decision, as list rows for the team's attention list: overdue and missed milestones, unclear requirements. */
function planAttentionRows(t, id) {
  const { R, M } = planModel(t), door = (go) => ({ 'data-plan': `${id}|${go}` });
  const mile = (m, label, tail) => row({ lead: planGlyph('bad', label === 'Missed' ? ic('x') : ic('clock'), label), title: planTitle(m.title), meta: raw(`Milestone · <span class="pl-k">${esc(m.key)}</span> · <span class="pl-late">${tail}</span>`), chev: true, attrs: door('ms') });
  return [
    ...M.filter(planLate).map((m) => mile(m, 'Overdue', `Overdue since ${planDate(m.due_at)}`)),
    ...M.filter((m) => m.status === 'missed').map((m) => mile(m, 'Missed', 'Missed')),
    ...R.filter((r) => r.status === 'unclear').sort((a, b) => (b.priority === 'must') - (a.priority === 'must'))
      .map((r) => row({ lead: planGlyph('unclear', ic('warn'), 'Unclear'), title: planTitle(r.title), meta: raw(`Requirement · ${r.priority === 'must' ? '<span class="pl-must">Must</span>' : esc(PRI[r.priority] || r.priority || '')} · Unclear`), chev: true, attrs: door('req|unclear') })),
  ];
}
/* The goal and where its plan stands, in one card: the goal text, the plan numbers, a row each for the lists and the status report. */
function teamGoalPlan(t, id, nm) {
  const { p, R, M, live, met, unclear, mustOpen, reached } = planModel(t), door = (go) => ({ 'data-plan': `${id}|${go}` });
  const stat = (v, l) => `<div class="stat"><span class="stat-v">${v}</span><span class="stat-l">${l}</span></div>`;
  const report = t.status_requested_at ? `<span class="warn-t">Update requested ${ago(t.status_requested_at)} ago</span>` : t.status_report ? `${esc(nm(t.status_report.agent_id))}, ${ago(t.status_report.created_at)} ago` : 'No report yet';
  const doors = (R.length ? row({ one: true, title: 'Requirements', trail: `<span>${R.length}</span>`, chev: true, attrs: door('req') }) : '')
    + (M.length ? row({ one: true, title: 'Milestones', trail: `<span>${M.length} · ${reached} reached</span>`, chev: true, attrs: door('ms') }) : '')
    + row({ one: true, title: 'Status report', trail: `<span>${report}</span>`, chev: true, attrs: { 'data-tstatus': id } })
    + row({ one: true, title: 'Decisions', trail: `<span>${decDoor(t)}</span>`, chev: true, attrs: { 'data-decs': id } });
  const when = [p.updated_at ? `Plan updated ${ago(p.updated_at)} ago` : '', p.requested_at ? `<span class="w">Review asked ${ago(p.requested_at)} ago</span>` : ''].filter(Boolean).join(' · ');
  const foot = `<div class="pl-foot"><span class="pl-when">${when}</span><button class="btn" id="planAsk">${ic('note')}Ask the coordinator to review</button></div>`;
  const stats = R.length || M.length ? `<div class="stats">${stat(`${met}<small>/${live.length}</small>`, 'Met')}${stat(mustOpen, 'Must open')}${stat(unclear, 'Unclear')}</div>` : none('note', 'No plan yet');
  return sec('Goal', `<p class="team-goal tm-goal" title="${esc(t.goal)}">${esc(t.goal)}</p>${overline('Plan', null, info('What the team must reach, kept by the coordinator. Each requirement can be delivered by one or more milestones.'))}<div class="pl-sum">${stats}<div class="doors">${doors}</div>${foot}</div>`);
}
/* The full lists, one screen each: #plan/<team id>|req|<filter> and #plan/<team id>|ms. */
VIEWS.plan = async (arg) => {
  const [teamId, kind = 'req', fl = ''] = String(arg).split('|');
  const t = (await api('/teams/' + encodeURIComponent(teamId))).team, m = planModel(t), ms = kind === 'ms';
  let body;
  if (ms) body = m.M.length ? `<section class="sec"><div class="pl-steps">${m.M.map(planMile).join('')}</div></section>` : none('note', 'No milestones yet');
  else {
    const F = [['must', 'Must', (r) => r.priority === 'must'], ['should', 'Should', (r) => r.priority === 'should'], ['could', 'Could', (r) => r.priority === 'could'],
      ['unclear', 'Unclear', (r) => r.status === 'unclear'], ['all', 'All', () => true]].filter(([k, , f]) => k === 'all' || m.R.some(f));
    const cur = F.find(([k]) => k === fl) || F[0];
    body = m.R.length
      ? `<nav class="seg eq" role="group" aria-label="Filter">${F.map(([k, l, f]) => `<button type="button" class="${k === cur[0] ? 'on' : ''}" aria-pressed="${k === cur[0]}" data-plan-f="${esc(teamId)}|req|${k}">${l} ${m.R.filter(f).length}</button>`).join('')}</nav>`
        + `<section class="sec"><div>${m.R.filter(cur[2]).map((r) => planReq(r, m.ms)).join('')}</div></section>`
      : none('note', 'No requirements yet');
  }
  const title = ms ? 'Milestones' : 'Requirements', meta = ms ? (m.M.length ? `${m.reached} of ${m.M.length} reached` : 'None yet') : `${m.met} of ${m.live.length} met`;
  return {
    t: `${ic('team')}<span class="ellip">${esc(t.name)} · ${title}</span>`,
    a: `<button class="btn sm" data-team="${esc(teamId)}">${ic('team')}Team</button>`,
    dbar: { title, meta: `${t.name} · ${meta}`, menu: [{ label: 'Open ' + t.name, icon: 'team', fn: () => openD('team', teamId) }] },
    b: body,
  };
};
/* ---------- decisions: questions agents ask the operator (docs/decisions.md) ---------- */
/* Questions and context are written by agents: every piece goes through esc() or row()'s escaping. */
const DEC_ST = { open: ['Open', 'warn'], needs_info: ['Needs info', 'info'], answered: ['Answered', 'ok'], declined: ['Declined', 'idle'], withdrawn: ['Withdrawn', 'idle'] };
const DEC_OPEN = ['open', 'needs_info'];
const decStatus = (s) => pill((DEC_ST[s] || [s])[0], (DEC_ST[s] || [0, 'idle'])[1]);
/* The status glyph: a ring for open, a question mark shape for needs info, a check, a ban, an x; never colour only. */
const decGlyph = (d) => d.status === 'answered' ? planGlyph('met', ic('check'), 'Answered') : d.status === 'declined' ? planGlyph('', ic('ban'), 'Declined')
  : d.status === 'withdrawn' ? planGlyph('', ic('x'), 'Withdrawn') : d.status === 'needs_info' ? planGlyph('open', '', 'Needs info') : planGlyph('unclear', ic('chat'), 'Question for you');
const decAnswer = (d) => [d.answer_label, d.answer_text].filter(Boolean).join(' — ');
/* A question as a list row: open ones say who asks and since when; settled ones show the answer. */
function decRow(d, nm = (id, l) => l || agLabel(id)) {
  const who = nm(d.agent_id, d.agent_label);
  const meta = DEC_OPEN.includes(d.status)
    ? `${who} asks${d.task_title ? ' · blocks a task' : ''}${d.status === 'needs_info' ? ' · waiting for the agent' : ''} · ${ago(d.created_at)} ago`
    : d.status === 'answered' ? `${decAnswer(d)} · ${ago(d.answered_at)} ago` : `${(DEC_ST[d.status] || [d.status])[0]} · ${ago(d.updated_at)} ago`;
  return row({ lead: decGlyph(d), title: d.question, meta, chev: true, attrs: { 'data-dec': d.id } });
}
/* Attach the team's questions to a fetched team: t.dec (all, newest settled last) and t.decTask (open question per blocked task). */
async function withDecisions(t) {
  try { t.dec = (await api('/decisions?team=' + encodeURIComponent(t.id) + '&limit=200')).decisions; } catch { t.dec = []; }
  t.decTask = Object.fromEntries(t.dec.filter((d) => DEC_OPEN.includes(d.status) && d.blocks_task && d.task_id).map((d) => [d.task_id, d]));
  return t;
}

/* One question (docs/decisions.md), laid out to be decided in one pass: the question as the screen's heading with who
   asked and when; what it affects (the blocked task and its worker, the plan items by name); the agent's context,
   shortened; the options in full with the recommended one first and chosen; one button that names the answer.
   Settled: the decision first, then the same question and context for the record. */
VIEWS.dec = async (id) => {
  const dp = '/decisions/' + encodeURIComponent(id), d = (await api(dp)).decision, open = DEC_OPEN.includes(d.status);
  let t = null; try { t = (await api('/teams/' + encodeURIComponent(d.team_id))).team; } catch { /* the team may be gone; the question still shows */ }
  const nm = t ? teamNm(t) : (aid) => agLabel(aid), asker = d.agent_label || nm(d.agent_id);
  const task = d.task_id ? t?.board.find((k) => k.id === d.task_id) : null, worker = task?.assignee ? nm(task.assignee) : null;
  const re = async (msg) => { toast(msg); await refresh(); openD('dec', id, true); };
  const more = (anchor) => fbSheet({ title: 'Ask for more information', anchor, label: 'Ask', fields: fbArea('dcN', 'What do you need to know?', 2000),
    onGo: (sh) => { const note = fbVal(sh, 'dcN'); if (!note) return 'Say what you need to know.'; run(async () => { await post(dp + '/more-info', { note }); await re('Asked'); }); } });
  const decline = () => fbSheet({ title: 'Decline to decide', label: 'Decline', tone: 'bad', fields: fbArea('dcN', 'Note for the agent (optional)', 2000),
    onGo: (sh) => { run(async () => { await post(dp + '/decline', { note: fbVal(sh, 'dcN') || null }); await re('Declined'); }); } });
  // Plan items by name: "R4 · Must · <title>", the full title on hover.
  const R = Object.fromEntries((t?.plan?.requirements || []).map((r) => [r.key, r])), M = Object.fromEntries((t?.plan?.milestones || []).map((m) => [m.key, m]));
  const refChip = (key) => { const r = R[key], m = M[key], title = r?.title || m?.title || '', head = [key, r ? PRI[r.priority] : m ? 'Milestone' : ''].filter(Boolean).join(' · ');
    return `<span class="dc-ref" title="${esc(title ? `${head}: ${title}` : key)}">${esc(head)}${title ? ` · ${esc(title)}` : ''}</span>`; };
  const affects = (task || d.task_id ? row({ lead: planGlyph(d.blocks_task ? 'bad' : '', ic(d.blocks_task ? 'ban' : 'note'), d.blocks_task ? 'Blocked by this question' : 'Linked task'),
      title: d.task_title || d.task_id, meta: `${worker ? worker + ' · ' : ''}${d.blocks_task ? 'blocked until you answer' : 'linked task'}`, chev: true, attrs: { 'data-task': `${d.team_id}|${d.task_id}` } }) : '')
    + (d.refs.length ? `<div class="dc-refs">${d.refs.map(refChip).join('')}</div>` : '');
  const long = (d.context || '').length > 320;
  const context = d.context ? `${overline(`Context from ${asker}`)}<p class="fb-text dc-ctx${long ? ' clamp' : ''}" id="dcCtx">${esc(d.context)}</p>${long ? '<button type="button" class="btn ghost sm dc-more" id="dcCtxMore">Show more</button>' : ''}` : '';
  // Options: the recommended one first and chosen, labelled by letter (the agent's keys are ids, not names).
  const opts = [...d.options].sort((a, b) => (b.key === d.recommended) - (a.key === d.recommended));
  const optRow = (o, i) => `<button type="button" class="lrow dc-opt" role="radio" aria-checked="${o.key === d.recommended}" data-dc-opt="${esc(o.key)}" data-dc-label="${esc(o.label)}">
      <span class="lrow-lead"><span class="pl-lead dc-key" aria-hidden="true">${'ABCDEF'[i]}</span></span>
      <span class="lrow-main"><span class="dc-opt-t">${esc(o.label)}${o.key === d.recommended ? ' ' + pill(`${asker} recommends`, 'acc') : ''}</span>${o.effect ? `<span class="dc-opt-e">${esc(o.effect)}</span>` : ''}</span></button>`;
  const recLabel = d.options.find((o) => o.key === d.recommended)?.label;
  const who = [...new Set([asker, worker].filter(Boolean))].join(' and ');
  const after = `${who} ${who.includes(' and ') ? 'get' : 'gets'} it with the next hub call${task && d.blocks_task ? `; the task goes back to ${worker || 'its assignee'} as assigned` : ''}.`;
  const noteOpen = !d.options.length;
  const form = open ? `<section class="sec">${d.options.length ? `${overline('Choose one')}<div role="radiogroup" aria-label="Options" class="dc-opts">${opts.map(optRow).join('')}</div>` : ''}
      <button type="button" class="btn ghost sm" id="dcNoteT"${noteOpen ? ' hidden' : ''}>${ic('plus')}Add a note or write another answer</button>
      <label class="fld" id="dcNoteF"${noteOpen ? '' : ' hidden'}><span class="vlabel">${d.options.length ? 'Note (optional)' : 'Your answer'}</span><textarea class="inp" id="dcText" rows="3" maxlength="4000"></textarea></label>
      <span class="err" id="dcErr" role="alert"></span></section>
    <div class="actionbar dc-bar"><span class="dc-after">${esc(after)}</span><button type="button" class="btn" id="dcMore">${ic('chat')}Ask for more</button><button type="button" class="btn pri lg" id="dcGo">${ic('check')}<span id="dcGoL">${esc(recLabel ? `Answer: ${recLabel}` : 'Answer')}</span></button></div>` : '';
  const settled = open ? '' : sec(d.status === 'answered' ? 'Decision' : (DEC_ST[d.status] || [d.status])[0],
    `${d.status === 'answered' ? `<p class="dc-answer">${esc(decAnswer(d))}</p>` : d.answer_text ? `<p class="fb-text">${esc(d.answer_text)}</p>` : ''}<p class="meta">${esc([d.answered_at ? `${d.status === 'answered' ? 'Answered' : 'Closed'} by ${d.answered_by_name || 'the operator'}, ${dt(d.answered_at)}` : '', d.log_revision ? 'copied to the vault note' : ''].filter(Boolean).join(' · '))}</p>`);
  const metaLine = [d.team_name, `question from ${asker}`, `${ago(d.created_at)} ago`, d.needed_by ? `needed by ${dt(d.needed_by)}` : ''].filter(Boolean).join(' · ');
  return {
    t: `${decGlyph(d)}<span class="ellip">Question from ${esc(asker)}</span>${decStatus(d.status)}`,
    a: moreBtn(),
    dbar: { title: 'Question', meta: `${d.team_name || ''} · ${asker} · ${ago(d.created_at)} ago`,
      menu: [open ? { label: 'Ask for more information', icon: 'chat', fn: () => more() } : null, open ? { label: 'Decline to decide', icon: 'ban', bad: true, fn: decline } : null,
        { label: 'Decision log', icon: 'log', fn: () => openD('decisions', d.team_id) }] },
    b: settled
      + `<section class="sec dc-head"><p class="meta">${esc(metaLine)}</p><h3 class="dc-q">${esc(d.question)}</h3>${d.status === 'needs_info' && d.info_note ? `<p class="dc-wait">${ic('chat')}You asked: ${esc(d.info_note)} · waiting for ${esc(asker)}</p>` : ''}</section>`
      + (affects || context ? `<section class="sec">${affects ? overline('Affects') + affects : ''}${context}</section>` : '')
      + form,
    after() {
      const m = $('#dcCtxMore'), cx = $('#dcCtx');
      // Only offer Show more when the clamp actually cuts the text at this width.
      if (m && cx.scrollHeight <= cx.clientHeight + 1) { cx.classList.remove('clamp'); m.hidden = true; }
      if (m) m.onclick = () => { const more_ = cx.classList.toggle('clamp'); m.textContent = more_ ? 'Show more' : 'Show less'; };
      if (!open) return;
      let pick = d.recommended || null;
      const label = $('#dcGoL'), text = $('#dcText'), err = $('#dcErr');
      const sync = () => { const o = d.options.find((x) => x.key === pick); label.textContent = o ? `Answer: ${o.label}` : 'Answer'; err.textContent = ''; };
      $$('[data-dc-opt]').forEach((b) => (b.onclick = () => { pick = pick === b.dataset.dcOpt ? null : b.dataset.dcOpt; $$('[data-dc-opt]').forEach((x) => x.setAttribute('aria-checked', String(x.dataset.dcOpt === pick))); sync(); }));
      $('#dcNoteT').onclick = () => { $('#dcNoteT').hidden = true; $('#dcNoteF').hidden = false; text.focus(); };
      text.oninput = () => { err.textContent = ''; };
      $('#dcGo').onclick = () => {
        if (!pick && !text.value.trim()) { err.textContent = d.options.length ? 'Choose an option or write an answer.' : 'Write an answer.'; return; }
        run(async () => { $('#dcGo').disabled = true; await post(dp + '/answer', { option: pick, text: text.value.trim() || null }); await re('Answered'); });
      };
      $('#dcMore').onclick = (e) => more(e.currentTarget);
    },
  };
};

/* A team's decision log: #decisions/<team id>|open|all. Open questions first, then the decisions, newest first. */
VIEWS.decisions = async (arg) => {
  const [teamId, fl = ''] = String(arg).split('|');
  const t = await withDecisions((await api('/teams/' + encodeURIComponent(teamId))).team), nm = teamNm(t);
  const O = t.dec.filter((d) => DEC_OPEN.includes(d.status)), A = t.dec.filter((d) => d.status === 'answered');
  const F = [['open', 'Open', O], ['answered', 'Decided', A], ['all', 'All', t.dec]];
  const cur = F.find(([k]) => k === fl) || (O.length ? F[0] : F[1]);
  const logPath = t.decision_log_path;
  const setLog = (anchor) => fbSheet({ title: 'Copy decisions to the vault', anchor, label: 'Save', fields: `<label class="fld"><span class="vlabel">Note in the vault (empty: no copy)</span><input class="inp mono" id="dcLog" maxlength="1024" value="${esc(logPath || '')}" placeholder="/${esc(S.me?.vault_alias || 'vault')}/Project/Decisions log.md" autocomplete="off"></label>`,
    onGo: (sh) => { run(async () => { await api(`/teams/${encodeURIComponent(teamId)}/decision-log`, 'PUT', { path: fbVal(sh, 'dcLog') || null }); toast('Saved'); openD('decisions', arg, true); }); } });
  return {
    t: `${ic('team')}<span class="ellip">${esc(t.name)} · Decisions</span>`,
    a: `<button class="btn sm" data-team="${esc(teamId)}">${ic('team')}Team</button>`,
    dbar: { title: 'Decisions', meta: `${t.name} · ${O.length} open · ${A.length} decided`, menu: [{ label: 'Copy to a vault note', icon: 'note', fn: () => setLog() }, { label: 'Open ' + t.name, icon: 'team', fn: () => openD('team', teamId) }] },
    b: `<nav class="seg eq" role="group" aria-label="Filter">${F.map(([k, l, L]) => `<button type="button" class="${k === cur[0] ? 'on' : ''}" aria-pressed="${k === cur[0]}" data-decs="${esc(teamId)}|${k}">${l} ${L.length}</button>`).join('')}</nav>`
      + `<section class="sec"><div>${cur[2].map((d) => decRow(d, (id, l) => nm(id) || l)).join('') || none('chat', cur[0] === 'open' ? 'No open questions' : 'No decisions yet')}</div></section>`
      + `<section class="sec"><div>${row({ title: 'Vault copy', meta: 'Each decision is also added to this note', trail: logPath ? `<span class="mono" title="${esc(logPath)}">${esc(midTrunc(logPath, 36))}</span>` : '<span>Off</span>', chev: true, attrs: { 'data-dclog': '' } })}</div></section>`,
    after() { const b = $('[data-dclog]'); if (b) b.onclick = (e) => { e.preventDefault(); setLog(b); }; },
  };
};
/* ---------- directives: standing rules with scope, version and who has read them (docs/directives.md) ---------- */
const DIR_READ = { current: ['Read', 'ok'], outdated: ['Out of date', 'warn'], unread: ['Not read', 'bad'] };
const dirRead = (r, v) => pill(r === 'outdated' && v ? `Read v${v}, out of date` : DIR_READ[r][0], DIR_READ[r][1]);
/* Scope choices for a directive: what it reaches, then which one. */
function dirScopeFields(cur = { kind: 'hub', ref: null }) {
  const projects = [...new Set(S.agents.map((a) => a.project).filter(Boolean))].sort();
  const teams = S.teams.filter((t) => t.status !== 'done' && t.status !== 'stopped');
  const opts = {
    project: projects.map((p) => [p, p]),
    team: teams.map((t) => [t.id, t.name]),
    role: teams.flatMap((t) => ['coordinator', 'worker', 'reviewer', 'stakeholder'].map((r) => [`${t.id}|${r}`, `${cap(r)}s of ${t.name}`])),
    agent: S.agents.filter((a) => a.status !== 'archived').map((a) => [a.id, a.label + (a.project ? ` · ${a.project}` : '')]),
  };
  const kinds = [['hub', 'All agents'], ['project', 'One project'], ['team', 'One team'], ['role', 'One role in a team'], ['agent', 'One agent']];
  return { html: `<label class="fld"><span class="vlabel">Applies to</span><select class="sel fill" id="dsK">${kinds.map(([k, l]) => `<option value="${k}"${k === cur.kind ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="fld" id="dsRF"${cur.kind === 'hub' ? ' hidden' : ''}><span class="vlabel">Which</span><select class="sel fill" id="dsR"></select></label>`,
    bind(sh) {
      const k = $('#dsK', sh), r = $('#dsR', sh), f = $('#dsRF', sh);
      const fill = () => { const L = opts[k.value] || []; f.hidden = k.value === 'hub'; r.innerHTML = L.map(([v, l]) => `<option value="${esc(v)}"${v === cur.ref ? ' selected' : ''}>${esc(l)}</option>`).join(''); };
      k.onchange = fill; fill();
      return () => ({ kind: k.value, ref: k.value === 'hub' ? null : r.value || null });
    } };
}
/* New or edited directive, in a sheet: title, text, scope, and for an edit a change note. */
function dirSheet({ title = 'New directive', d = null, anchor, onDone }) {
  const sc = dirScopeFields(d ? { kind: d.scope_kind, ref: d.scope_ref } : undefined);
  const sh = fbSheet({ title, anchor, label: d ? 'Save new version' : 'Create', fields: `<label class="fld"><span class="vlabel">Title</span><input class="inp" id="dsT" maxlength="120" value="${esc(d?.title || '')}" autocomplete="off"></label>
      <label class="fld"><span class="vlabel">Text (what agents must do)</span><textarea class="inp" id="dsB" rows="6" maxlength="20000">${esc(d?.body || '')}</textarea></label>${sc.html}
      ${dirCatField(d ? d.category || (!d.reviewed_at && d.proposed_category) || '' : '', d && !d.category && !d.reviewed_at && d.proposed_category ? 'Category (the agent proposed it)' : 'Category')}
      <label class="fld"><span class="vlabel">Tags (comma-separated)</span><input class="inp" id="dsG" maxlength="400" value="${esc((d?.tags || []).join(', '))}" placeholder="e.g. git, vault" autocomplete="off"></label>
      ${d ? fbArea('dsN', 'What changed (optional, agents see it)', 500, 2) : ''}`,
    onGo: (s) => {
      const t = fbVal(s, 'dsT'), b = fbVal(s, 'dsB'), scope = get(), category = $('#dsC', s).value || null, tags = dirTagList($('#dsG', s).value);
      if (!t || !b) return 'Give a title and the text.';
      if (scope.kind !== 'hub' && !scope.ref) return 'Choose what it applies to.';
      if (tags.length > 10) return 'Use at most 10 tags.';
      run(async () => {
        const r = d ? await api('/directives/' + encodeURIComponent(d.id), 'PATCH', { title: t, body: b, scope, note: fbVal(s, 'dsN') || null, category, tags }) : await post('/directives', { title: t, body: b, scope, category, tags });
        toast(d ? 'Saved; agents are told' : 'Created; agents are told'); onDone?.(r.directive);
      });
    } });
  const get = sc.bind(sh);
}
/* Merge: the same rule registered by several agents becomes one directive with the scope you choose. The default scope
   reaches every reporter: their common team, else their common project, else all agents. */
function dirMergeSheet(group, anchor, onDone) {
  const ag = group.map((d) => AG(d.reported_by)).filter(Boolean), proj = [...new Set(ag.map((a) => a.project).filter(Boolean))];
  const teams = S.teams.filter((t) => t.status !== 'done' && t.status !== 'stopped' && ag.every((a) => (t.agent_ids || []).includes(a.id)));
  const cur = teams.length ? { kind: 'team', ref: teams[0].id } : proj.length === 1 ? { kind: 'project', ref: proj[0] } : { kind: 'hub', ref: null };
  const sc = dirScopeFields(cur), first = group.slice().sort((a, b) => b.body.length - a.body.length)[0];
  const sh = fbSheet({ title: `Merge ${group.length} into one`, anchor, label: 'Merge', fields: `<p class="meta">Reported by ${esc(group.map((d) => d.reported_by_label || '?').join(', '))}. Each gets a notice to follow the merged one.</p>
      <label class="fld"><span class="vlabel">Title</span><input class="inp" id="dsT" maxlength="120" value="${esc(first.title)}" autocomplete="off"></label>
      <label class="fld"><span class="vlabel">Text</span><textarea class="inp" id="dsB" rows="6" maxlength="20000">${esc(first.body)}</textarea></label>${sc.html}`,
    onGo: (s) => { const t = fbVal(s, 'dsT'), b = fbVal(s, 'dsB'), scope = get(); if (!t || !b) return 'Give a title and the text.';
      run(async () => { const x = await post('/directives/merge', { ids: group.map((d) => d.id), title: t, body: b, scope }); toast('Merged; agents are told'); onDone?.(x.directive); }); } });
  const get = sc.bind(sh);
}
/* ---------- Work → Directives list (docs/dashboard-ux.md#directives) ----------
   Filters live in the route: #directives, #directives/retired, or #directives/<query> with
   s=retired · q=search · sc=scope kind · rd=read state · g=grouping · d=selected directive.
   From 1024 px the list and the selected directive sit side by side; narrower, a row opens the directive's own screen. */
const DIR_KINDS = ['hub', 'project', 'team', 'role', 'agent'];
const DIR_KIND_LABEL = { hub: 'All agents', project: 'Project', team: 'Team', role: 'Role', agent: 'Agent' };
const DIR_READS = [['', 'Any read state'], ['behind', 'Not read by everyone'], ['old', 'Read an old version'], ['all', 'Read by everyone'], ['new', 'Not reviewed']];
const DIR_GROUPS = [['', 'Group by scope'], ['cat', 'Group by category'], ['none', 'No grouping']];
/* The hub's fixed category list (docs/directives.md#categories-and-tags); "none" filters directives without one. */
const DIR_CATS = [['access', 'Access & security'], ['communication', 'Communication'], ['tokens', 'Token economy'], ['reporting', 'Reporting'], ['sources', 'Sources & quality'], ['process', 'Process & workflow'], ['tooling', 'Tooling']];
const DIR_CAT_LABEL = Object.fromEntries(DIR_CATS);
const dirCatOpts = (cur) => [['', 'No category'], ...DIR_CATS].map(([v, l]) => `<option value="${v}"${v === (cur || '') ? ' selected' : ''}>${esc(l)}</option>`).join('');
const dirCatField = (cur, label = 'Category') => `<label class="fld"><span class="vlabel">${esc(label)}</span><select class="sel fill" id="dsC">${dirCatOpts(cur)}</select></label>`;
/* Tags typed as a comma-separated list; the hub lowercases them and turns spaces into dashes. */
const dirTagList = (v) => String(v || '').split(',').map((t) => t.trim()).filter(Boolean);
const dirWide = () => matchMedia('(min-width: 1024px)').matches;
/* Route arg → filters, or null when the arg is not one this view writes (ROUTE_OK refuses it). */
function dirArgs(a = '') {
  a = String(a ?? '');
  const f = { st: 'active', q: '', sc: '', rd: '', g: '', c: '', t: '', d: '' };
  if (a === '') return f;
  if (a === 'retired') return { ...f, st: 'retired' };
  if (!a.includes('=')) return null;
  const p = new URLSearchParams(a);
  if ([...p.keys()].some((k) => !['s', 'q', 'sc', 'rd', 'g', 'c', 't', 'd'].includes(k))) return null;
  const x = { st: p.get('s') === 'retired' ? 'retired' : 'active', q: (p.get('q') || '').slice(0, 100), sc: p.get('sc') || '', rd: p.get('rd') || '', g: p.get('g') || '', c: p.get('c') || '', t: p.get('t') || '', d: p.get('d') || '' };
  if (x.sc && !DIR_KINDS.includes(x.sc)) return null;
  if (x.c && x.c !== 'none' && !DIR_CAT_LABEL[x.c]) return null;
  if (x.t && !/^[a-z0-9._-]{1,32}$/.test(x.t)) return null;
  if (!DIR_READS.some(([k]) => k === x.rd) || !DIR_GROUPS.some(([k]) => k === x.g) || (x.d && !RID.test(x.d))) return null;
  return x;
}
function dirArgStr(f) {
  const p = new URLSearchParams();
  if (f.st === 'retired') p.set('s', 'retired');
  for (const k of ['q', 'sc', 'rd', 'g', 'c', 't', 'd']) if (f[k]) p.set(k, f[k]);
  const s = p.toString();
  return s === 's=retired' ? 'retired' : s;
}
/* State that is not in the route and must survive the background redraw: ticked rows and folded groups. */
const DIR_UI = { data: null, checked: new Set(), folded: new Set(), req: 0 };
const dirFirstLine = (b) => String(b || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
const dirMatch = (d, f) => {
  if (f.q) { const hay = [d.title, d.body, d.scope_label, ...(d.tags || [])].join(' ').toLowerCase(); if (!f.q.toLowerCase().split(/\s+/).every((w) => hay.includes(w))) return false; }
  if (f.sc && d.scope_kind !== f.sc) return false;
  if (f.rd === 'behind' && !(d.current < d.agents)) return false;
  if (f.rd === 'old' && !d.outdated) return false;
  if (f.rd === 'all' && !(d.agents && d.current >= d.agents)) return false;
  if (f.rd === 'new' && d.reviewed_at) return false;
  if (f.c && (f.c === 'none' ? !!d.category : d.category !== f.c)) return false;
  if (f.t && !(d.tags || []).includes(f.t)) return false;
  return true;
};
const dirCatKey = (d) => d.category || 'none';
/* Category shown on a row: the operator's, or what the agent proposed while the rule waits for review. */
const dirCatText = (d) => d.category ? DIR_CAT_LABEL[d.category] : d.status === 'active' && !d.reviewed_at && d.proposed_category ? `Proposed: ${DIR_CAT_LABEL[d.proposed_category]}` : '';
/* Category chips over the list: All, each category and No category, counted under the other filters. */
function dirCatChips(f) {
  const base = DIR_UI.data.directives.filter((d) => dirMatch(d, { ...f, c: '' }));
  const chip = (k, label, n) => `<button type="button" class="btn sm${f.c === k ? ' on' : ''}" data-dcat="${k}" aria-pressed="${f.c === k}">${esc(label)} <span class="fcount">${n}</span></button>`;
  const tag = f.t ? `<button type="button" class="btn sm on" data-dtagclr aria-label="Remove the tag filter ${esc(f.t)}">#${esc(f.t)}${ic('x')}</button>` : '';
  return `<div class="dl-cats" role="group" aria-label="Category">${chip('', 'All', base.length)}${[...DIR_CATS, ['none', 'No category']].map(([k, l]) => chip(k, l, base.filter((d) => dirCatKey(d) === k).length)).join('')}${tag}</div>`;
}
/* "7/9 read": muted when everyone read the current version, a warn pill when some lag, bad when nobody read it. */
const dirReadPill = (d) => !d.agents ? '<span class="faint">No agents</span>'
  : d.current >= d.agents ? `<span class="dl-n">${d.current}/${d.agents} read</span>` : pill(`${d.current}/${d.agents} read`, d.current ? 'warn' : 'bad');
const dirTarget = (d) => d.scope_kind === 'hub' ? 'All agents' : d.scope_kind === 'role' ? cap(d.scope_label) : String(d.scope_label).replace(/^(project|team|agent) /, '');
function dirRow(d, f) {
  const live = d.status === 'active', sel = d.id === f.d;
  const box = live ? `<label class="dl-hit"><input type="checkbox" class="dl-chk" data-dchk="${esc(d.id)}" aria-label="Select ${esc(d.title)}"${DIR_UI.checked.has(d.id) ? ' checked' : ''}></label>` : '';
  const where = f.g === '' ? dirTarget(d) : DIR_KIND_LABEL[d.scope_kind] || cap(d.scope_kind);
  // Grouped by category, the group header already names it (a proposal still shows).
  const cat = f.g === 'cat' && d.category ? '' : dirCatText(d);
  // Phones have no room for the scope chip: it moves to the start of the meta line (design guidelines §4).
  const scope = `<span class="tag txt dl-scope only-d" title="${esc(cap(d.scope_label))}">${esc(where)}</span>`;
  return row({ as: 'div', cls: 'dl-row' + (sel ? ' on' : ''), lead: box, chev: true,
    title: raw(`${live && !d.reviewed_at ? pill('New', 'info') : ''}<span class="dl-t">${esc(d.title)}</span>`), meta: raw(`<span class="only-m">${esc(where)} · </span>${cat ? `<span class="dl-cat">${esc(cat)}</span> · ` : ''}${esc(dirFirstLine(d.body))}`),
    trail: scope + (live ? dirReadPill(d) : ''),
    attrs: { 'data-dsel': d.id }, extra: `tabindex="0" role="button" aria-label="${esc(d.title)}"${sel ? ' aria-current="true"' : ''}` });
}
/* The groups of a list: [fold key, header, rows], by scope or by category (No category last); empty groups left out. */
const dirGroups = (f, L) => (f.g === 'cat'
  ? [...DIR_CATS, ['none', 'No category']].map(([k, l]) => ['c:' + k, l, L.filter((d) => dirCatKey(d) === k)])
  : DIR_KINDS.map((k) => [k, DIR_KIND_LABEL[k], L.filter((d) => d.scope_kind === k)])).filter(([, , g]) => g.length);
/* Matching directives in display order: by group (unless ungrouped), not reviewed first, then the hub's order. */
const dirOrdered = (f) => { const L = DIR_UI.data.directives.filter((d) => dirMatch(d, f)).sort((a, b) => !!a.reviewed_at - !!b.reviewed_at);
  return f.g === 'none' ? L : dirGroups(f, L).flatMap(([, , g]) => g); };
/* The list pane: summary line with select-all, folding groups, and the bulk bar while rows are ticked. */
function dirListHtml(f) {
  const D = DIR_UI.data, all = D.directives, live = f.st === 'active';
  const L = dirOrdered(f);
  // Only rows the filters show stay ticked, so a bulk action never reaches a hidden one.
  const shown = new Set(L.map((d) => d.id)); for (const id of DIR_UI.checked) if (!shown.has(id)) DIR_UI.checked.delete(id);
  const unrev = L.filter((d) => live && !d.reviewed_at).length, behind = L.filter((d) => live && d.current < d.agents).length;
  const ticked = L.filter((d) => DIR_UI.checked.has(d.id)).length;
  const sum = `<div class="dl-sum">${live && L.length ? `<input type="checkbox" class="dl-chk" id="dlAll" aria-label="Select all shown"${ticked && ticked === L.length ? ' checked' : ''}>` : ''}
    <span class="meta"><b>${L.length}</b> of ${all.length}${unrev ? ` · <span class="info-t">${unrev} not reviewed</span>` : ''}${behind ? ` · <span class="warn-t">${behind} not read by everyone</span>` : ''}</span></div>`;
  let body;
  if (!L.length) body = none('sl', all.length ? 'No directive matches these filters' : f.st === 'retired' ? 'No retired directives' : 'No directives yet');
  else if (f.g === 'none') body = L.map((d) => dirRow(d, f)).join('');
  else body = dirGroups(f, L).map(([k, label, g]) => {
    const open = !DIR_UI.folded.has(k);
    return `<div class="dl-grp"><button type="button" class="dl-gh" data-dgrp="${k}" aria-expanded="${open}">${ic('chev', 'chev')}<span>${esc(label)}</span><span aria-hidden="true">·</span><span>${g.length}</span></button>${open ? g.map((d) => dirRow(d, f)).join('') : ''}</div>`;
  }).join('');
  const n = DIR_UI.checked.size, canRev = [...DIR_UI.checked].some((id) => all.find((d) => d.id === id && !d.reviewed_at));
  const bulk = n ? `<div class="dl-bulk" role="region" aria-label="Selected directives"><span class="dl-bn">${n} selected</span>
    <button type="button" class="btn sm" id="dlRev"${canRev ? '' : ' disabled'}>${ic('check')}Mark reviewed</button><button type="button" class="btn sm" id="dlCat">${ic('tag')}Set category</button><button type="button" class="btn sm" id="dlRet">${ic('ban')}Retire</button><button type="button" class="btn sm ic ghost" id="dlClr" aria-label="Clear selection">${ic('x')}</button></div>` : '';
  return (all.length ? dirCatChips(f) : '') + sum + `<div class="dl-rows">${body}</div>` + bulk;
}
/* The toolbar: In force / Retired, then search, scope, read state and grouping inline from 768 px; on phones these four are in a filter sheet. */
function dirToolbar(f) {
  const n = ['q', 'sc', 'rd', 'g'].filter((k) => f[k]).length;
  const sel = (id, label, items, cur) => `<select class="sel" id="${id}" aria-label="${esc(label)}">${items.map(([v, l]) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  return vtools(subTabs('data-dirs', [['', 'In force'], ['retired', 'Retired']], f.st === 'retired' ? 'retired' : '')
    + `<div class="srch only-d dl-q">${ic('search')}<input class="inp" id="dlQ" type="search" placeholder="Search title, text, tags" aria-label="Search directives" value="${esc(f.q)}" autocomplete="off"></div>`
    + `<span class="only-d dl-sels">${sel('dlSc', 'Scope', [['', 'Any scope'], ...DIR_KINDS.map((k) => [k, DIR_KIND_LABEL[k]])], f.sc)}${f.st === 'active' ? sel('dlRd', 'Read state', DIR_READS, f.rd) : ''}${sel('dlG', 'Group by', DIR_GROUPS, f.g)}</span>`
    + `<span class="only-m">${filterBtn('dlMore', n)}</span>`);
}
/* One directive in the side pane: the same parts as its own screen, with the title as the pane heading. */
const dirPaneHtml = (r) => `<div class="dl-dh"><h3>${r.t}</h3><div class="dact">${r.a || ''}</div></div>${r.b}`;
async function dirShowPane(id, keepScroll = 0) {
  const pane = $('#dlDet'); if (!pane) return;
  const req = ++DIR_UI.req;
  if (!id) { pane.innerHTML = none('sl', 'Select a directive'); DBAR_MENU = []; return; }
  let r; try { r = await dirDetail(id); } catch (e) { if (req === DIR_UI.req && pane.isConnected) pane.innerHTML = none('sl', e.status === 404 ? 'This directive no longer exists' : 'Could not load it'); return; }
  if (req !== DIR_UI.req || !pane.isConnected) return;
  pane.innerHTML = dirPaneHtml(r); pane.scrollTop = keepScroll;
  DBAR_MENU = (r.dbar.menu || []).filter(Boolean);
  r.after(); tipIcons(pane);
}
/* Change filters in place: redraw the list pane only, keep the page scroll, and replace the route (no history entry per keystroke). */
function dirSet(patch) {
  const f = { ...(dirArgs(DR.arg) || dirArgs('')), ...patch };
  DR.arg = dirArgStr(f); setRoute('directives', DR.arg, false);
  const box = $('#dlList'); if (box) { box.innerHTML = dirListHtml(f); dirBindList(f); }
  setFilterCount('dlMore', ['q', 'sc', 'rd', 'g'].filter((k) => f[k]).length);
  return f;
}
/* Select a row: side by side, show it in the pane; narrower, open its screen (Back returns to the list as it was). */
function dirSelect(id, { focus = false } = {}) {
  if (!dirWide()) { openD('directive', id); return; }
  dirSet({ d: id });
  const rowEl = $(`.dl-row[data-dsel="${CSS.escape(id)}"]`);
  if (rowEl) { rowEl.scrollIntoView({ block: 'nearest' }); if (focus) rowEl.focus({ preventScroll: true }); }
  dirShowPane(id);
}
/* j / k: the next or previous visible row. */
function dirStep(dir) {
  const rows = $$('.dl-row'); if (!rows.length) return;
  const f = dirArgs(DR.arg) || dirArgs(''), cur = rows.findIndex((r) => r === document.activeElement || (!rows.includes(document.activeElement) && r.dataset.dsel === f.d));
  const next = rows[cur < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, cur + dir))];
  if (dirWide()) dirSelect(next.dataset.dsel, { focus: true });
  else { next.focus(); next.scrollIntoView({ block: 'nearest' }); }
}
/* Run one request per directive, eight at a time. */
async function dirEach(ids, fn) { for (let i = 0; i < ids.length; i += 8) await Promise.all(ids.slice(i, i + 8).map(fn)); }
function dirBindList(f) {
  const box = $('#dlList'); if (!box) return;
  // Ticking rows and folding groups are not edits: keep them from pausing the background redraw (viewInUse).
  box.onchange = (e) => e.stopPropagation();
  box.onclick = (e) => {
    const t = e.target;
    if (t.closest('.dl-hit') && !t.matches('input')) return; // the label passes the click on to its box
    const chk = t.closest('[data-dchk]'); if (chk) { DIR_UI.checked[chk.checked ? 'add' : 'delete'](chk.dataset.dchk); dirSet({}); return; }
    if (t.id === 'dlAll') { const L = DIR_UI.data.directives.filter((d) => dirMatch(d, f)); L.forEach((d) => DIR_UI.checked[t.checked ? 'add' : 'delete'](d.id)); dirSet({}); return; }
    const cat = t.closest('[data-dcat]'); if (cat) { dirSet({ c: cat.dataset.dcat }); $(`[data-dcat="${cat.dataset.dcat}"]`)?.focus(); return; }
    if (t.closest('[data-dtagclr]')) { dirSet({ t: '' }); $('[data-dcat].on')?.focus(); return; }
    const g = t.closest('[data-dgrp]'); if (g) { const k = g.dataset.dgrp; DIR_UI.folded[DIR_UI.folded.has(k) ? 'delete' : 'add'](k); dirSet({}); $(`[data-dgrp="${k}"]`)?.focus(); return; }
    const r = t.closest('[data-dsel]'); if (r) { e.preventDefault(); dirSelect(r.dataset.dsel); }
  };
  const clr = $('#dlClr'); if (clr) clr.onclick = () => { DIR_UI.checked.clear(); dirSet({}); };
  const rev = $('#dlRev');
  if (rev) rev.onclick = () => run(async () => {
    const ids = [...DIR_UI.checked].filter((id) => DIR_UI.data.directives.some((d) => d.id === id && !d.reviewed_at));
    await dirEach(ids, (id) => post('/directives/' + encodeURIComponent(id) + '/review', {}));
    toast(`${fbPlural(ids.length, 'directive', 'directives')} marked as reviewed`); DIR_UI.checked.clear(); await refresh(); reopen();
  });
  // Set category: filing only, so no new version and no notice to agents; it replaces what agents proposed.
  const cat = $('#dlCat');
  if (cat) cat.onclick = (e) => { const ids = [...DIR_UI.checked], cur = [...new Set(ids.map((id) => DIR_UI.data.directives.find((d) => d.id === id)?.category || ''))];
    fbSheet({ title: `Set category of ${fbPlural(ids.length, 'directive', 'directives')}`, anchor: e.currentTarget, label: 'Set category', fields: `${dirCatField(cur.length === 1 ? cur[0] : '')}<p class="meta">Agents are not notified; versions stay the same.</p>`,
      onGo: (s) => { const category = $('#dsC', s).value || null; run(async () => { const r = await post('/directives/categorize', { ids, category }); toast(`${category ? DIR_CAT_LABEL[category] : 'No category'}: ${fbPlural(r.changed, 'directive', 'directives')} changed`); DIR_UI.checked.clear(); await refresh(); reopen(); }); } }); };
  const ret = $('#dlRet');
  if (ret) ret.onclick = (e) => { const ids = [...DIR_UI.checked];
    fbSheet({ title: `Retire ${fbPlural(ids.length, 'directive', 'directives')}`, anchor: e.currentTarget, label: 'Retire', tone: 'bad', fields: `<p class="meta">Agents they reach are told to stop following them.</p>${fbArea('dsN', 'Why (optional, agents see it)', 500, 2)}`,
      onGo: (s) => { const note = fbVal(s, 'dsN') || null; run(async () => { await dirEach(ids, (id) => post('/directives/' + encodeURIComponent(id) + '/retire', { note })); toast(`${fbPlural(ids.length, 'directive', 'directives')} retired; agents are told`); DIR_UI.checked.clear(); await refresh(); reopen(); }); } }); };
}
function dirFilterSheet(btn) {
  const f = dirArgs(DR.arg) || dirArgs('');
  const sh = openSheet({ title: 'Filter directives', anchor: btn, html: `<div class="sheet-form">
    <label class="fld"><span class="vlabel">Search</span><div class="srch">${ic('search')}<input class="inp" id="dlQm" type="search" placeholder="Search title, text, tags" aria-label="Search directives" value="${esc(f.q)}"></div></label>
    ${selField('dlScm', 'Scope', [['', 'Any scope'], ...DIR_KINDS.map((k) => [k, DIR_KIND_LABEL[k]])], f.sc)}
    ${f.st === 'active' ? selField('dlRdm', 'Read state', DIR_READS, f.rd) : ''}
    ${selField('dlGm', 'Group', DIR_GROUPS, f.g)}
    <div class="sheet-acts"><button type="button" class="btn lg" id="dlClear">Clear</button><button type="button" class="btn pri lg" data-sheet-close>Done</button></div></div>` });
  onSearch($('#dlQm', sh), (q) => dirSet({ q }));
  [['#dlScm', 'sc'], ['#dlRdm', 'rd'], ['#dlGm', 'g']].forEach(([s, k]) => { const el = $(s, sh); if (el) el.onchange = () => dirSet({ [k]: el.value }); });
  $('#dlClear', sh).onclick = () => { dirSet({ q: '', sc: '', rd: '', g: '' }); closeSheet(); };
}

/* Work → Directives: what agents must follow, at which scope, and who has read the current version. Rules agents
   registered themselves are in force at once and carry a New pill until you review them (filter: Not reviewed). */
VIEWS.directives = async (arg = '') => {
  const f = dirArgs(arg) || dirArgs('');
  const detScroll = DR.type === 'directives' ? $('#dlDet')?.scrollTop || 0 : 0;
  DIR_UI.data = await api('/directives?status=' + f.st);
  if (DR.type !== 'directives') { DIR_UI.checked.clear(); DIR_UI.folded.clear(); }
  // Side by side, the first row is selected when none is.
  if (dirWide() && !f.d) { const first = dirOrdered(f)[0]; if (first) f.d = first.id; }
  const fa = dirArgStr(f);
  return {
    t: `${ic('sl')}Directives <span class="n">${DIR_UI.data.directives.length}</span>`,
    a: `<button class="btn sm pri" id="dirNew">${ic('plus')}New directive</button>`,
    b: dirToolbar(f) + `<div class="dl"><div class="dl-list pcard" id="dlList">${dirListHtml(f)}</div><div class="dl-det" id="dlDet" aria-live="polite"></div></div>`,
    after() {
      if (fa !== arg) { DR.arg = fa; setRoute('directives', fa, false); }
      $('#dirNew').onclick = (e) => dirSheet({ anchor: e.currentTarget, onDone: (d) => openD('directive', d.id) });
      dirBindList(f);
      const q = $('#dlQ'); if (q) { onSearch(q, (v) => dirSet({ q: v })); q.addEventListener('input', (e) => e.stopPropagation()); }
      [['#dlSc', 'sc'], ['#dlRd', 'rd'], ['#dlG', 'g']].forEach(([s, k]) => { const el = $(s); if (el) el.addEventListener('change', (e) => { e.stopPropagation(); dirSet({ [k]: el.value }); }); });
      const m = $('#dlMore'); if (m) m.onclick = (e) => dirFilterSheet(e.currentTarget);
      if (dirWide()) dirShowPane(f.d, detScroll);
    },
  };
};
/* One directive: its text, scope and version, who it reaches and whether each agent read the current version, and its
   history. A rule an agent registered shows who and where from, with Keep as is; the same rule from others offers Merge. */
async function dirDetail(id) {
  const dp = '/directives/' + encodeURIComponent(id), x = await api(dp), d = x.directive, active = d.status === 'active';
  const C = x.coverage.slice().sort((a, b) => ({ unread: 0, outdated: 1, current: 2 }[a.read] - { unread: 0, outdated: 1, current: 2 }[b.read]) || a.label.localeCompare(b.label));
  const retire = () => fbSheet({ title: 'Retire directive', label: 'Retire', tone: 'bad', fields: fbArea('dsN', 'Why (optional, agents see it)', 500, 2),
    onGo: (s) => { run(async () => { await post(dp + '/retire', { note: fbVal(s, 'dsN') || null }); toast('Retired; agents are told'); await refresh(); reopen(); }); } });
  // Keep confirms the category chosen in the review card (preset to what the agent proposed).
  const keep = () => run(async () => { const c = $('#dirRevCat'); await post(dp + '/review', c ? { category: c.value || null } : {}); toast(c && c.value ? `Kept as ${DIR_CAT_LABEL[c.value]}` : 'Kept as it is'); await refresh(); reopen(); });
  const read = C.filter((c) => c.read === 'current').length, pending = active && !d.reviewed_at;
  const group = [{ ...d, reported_by_label: d.reported_by_label }, ...x.same];
  const review = pending ? `<div class="pcard dir-review">${overline('Not reviewed')}<p class="fb-text">${esc(d.reported_by_label || 'An agent')} registered this rule${d.source ? ` from ${esc(d.source)}` : ''}. It is in force for ${esc(d.scope_label)}.</p>
      ${x.same.length ? `<p class="meta">Also registered by ${esc(x.same.map((s) => s.reported_by_label || '?').join(', '))}.</p>` : ''}
      <label class="fld dir-revcat"><span class="vlabel">${d.proposed_category && !d.category ? 'Category (proposed by the agent)' : 'Category'}</span><select class="sel fill" id="dirRevCat">${dirCatOpts(d.category || d.proposed_category)}</select></label>
      <div class="row">${x.same.length ? `<button class="btn" id="dirMerge">${ic('link')}Merge the ${x.same.length + 1} into one</button>` : ''}<button class="btn" id="dirEditR">${ic('edit')}Edit or widen</button><button class="btn pri" id="dirKeep">${ic('check')}Keep as is</button></div></div>` : '';
  return {
    t: `${ic('sl')}<span class="ellip">${esc(d.title)}</span>${active ? (pending ? pill('Not reviewed', 'idle') : '') : pill('Retired', 'idle')}`,
    a: (active ? `<button class="btn sm" id="dirEdit">${ic('edit')}Edit</button>` : '') + moreBtn(),
    dbar: { title: d.title, meta: `${cap(d.scope_label)} · v${d.version}${active ? ` · ${read} of ${C.length} read` : ' · retired'}`,
      menu: [pending ? { label: 'Keep as is', icon: 'check', fn: keep } : null, active ? { label: 'Edit', icon: 'edit', fn: () => dirSheet({ title: 'Edit directive', d, onDone: async () => { await refresh(); reopen(); } }) } : null, active ? { label: 'Retire', icon: 'ban', bad: true, fn: retire } : null] },
    b: review + sec('Text', `<p class="fb-text">${esc(d.body)}</p>`)
      + `<div class="pcard kvc">${kv('Applies to', esc(cap(d.scope_label)))}${kv('Version', esc(`v${d.version} · ${dt(d.updated_at)}`))}${d.category ? kv('Category', `<a href="#directives/c=${d.category}" data-dirs="c=${d.category}">${esc(DIR_CAT_LABEL[d.category])}</a>`) : pending && d.proposed_category ? kv('Category', esc(`Proposed: ${DIR_CAT_LABEL[d.proposed_category]}`)) : ''}${d.tags?.length ? kv('Tags', `<span class="dir-tags">${d.tags.map((t) => `<a class="tag txt" href="#directives/t=${encodeURIComponent(t)}" data-dirs="t=${encodeURIComponent(t)}">#${esc(t)}</a>`).join('')}</span>`) : ''}${d.source ? kv('Source', esc(d.source)) : ''}${d.reported_by_label ? kv('Registered by', esc(d.reported_by_label)) : ''}</div>`
      + (active ? sec(`Agents · ${read} of ${C.length} read`, C.map((c) => row({ lead: `<span class="av lg">${esc(initials(c.label))}</span>`, title: c.label,
          meta: c.acked_at ? `Confirmed v${c.version} ${ago(c.acked_at)} ago` : 'Has not confirmed it', trail: dirRead(c.read, c.version), chev: true, attrs: { 'data-ses': c.agent_id } })).join('') || none('user', 'It reaches no agent right now'),
          info('Agents confirm a version with directive_ack after reading it. Out of date: they read an older version.')) : '')
      + sec('History', x.versions.map((v) => row({ title: `v${v.version} · ${v.title}`, meta: v.change_note || (v.version === 1 ? 'Created' : 'Edited'), trail: `<span>${ago(v.created_at)} ago</span>` })).join(''))
      + (pending ? `<div class="actionbar only-m"><button class="btn" id="dirEditM">${ic('edit')}Edit</button><button class="btn pri" id="dirKeepM">${ic('check')}Keep as is</button></div>` : active ? `<div class="actionbar only-m"><button class="btn pri" id="dirEditM">${ic('edit')}Edit</button></div>` : ''),
    after() {
      const e = () => dirSheet({ title: 'Edit directive', d, onDone: async () => { await refresh(); reopen(); } });
      for (const sel of ['#dirEdit', '#dirEditM', '#dirEditR']) { const b = $(sel); if (b) b.onclick = e; }
      for (const sel of ['#dirKeep', '#dirKeepM']) { const b = $(sel); if (b) b.onclick = keep; }
      const m = $('#dirMerge'); if (m) m.onclick = () => dirMergeSheet(group.map((g) => ({ ...g, body: g.body ?? d.body })), m, (nd) => openD('directive', nd.id, true));
    },
  };
}
VIEWS.directive = dirDetail;
/* One settings row: label with an info button for the explanation, control on the right. Shared by the team page and the new-team form. */
const twRow = (label, tip, ctrl, cls = '') => `<div class="tw-row${cls ? ' ' + cls : ''}"><div class="tw-l"><b>${label}</b>${tip ? info(tip) : ''}</div>${ctrl}</div>`;
/* How the team works: delivery mode, close on approval, coordinator review, check-in/lease time, recruiting. */
function teamWorkflow(t) {
  const h = (t.lease_minutes / 60).toFixed(t.lease_minutes % 60 ? 1 : 0);
  return `<div class="tw">
    ${twRow('Mode', 'Polling: agents loop on work_next and a silent task goes back to open when its lease ends. On demand: agents work when woken and never poll; a task past its check-in time raises an alert and keeps its assignee.', `<div class="seg" id="twMode" role="group" aria-label="Mode"><button data-mode="poll" class="${t.delivery_mode === 'poll' ? 'on' : ''}">${ic('rot')}Polling</button><button data-mode="on_demand" class="${t.delivery_mode === 'on_demand' ? 'on' : ''}">${ic('bolt')}On demand</button></div>`)}
    ${twRow('Close on approval', 'An approving review closes the task in the same call. With "Approval before done" the task waits for you instead.', switchBtn('Close on approval', t.close_on_approve, 'id="twClose"'))}
    ${twRow('Coordinator may review', 'A coordinator named as a task\'s reviewer may review it; never their own work.', switchBtn('Coordinator may review', t.coordinator_reviews, 'id="twCoord"'))}
    ${twRow(t.delivery_mode === 'on_demand' ? 'Default check-in time' : 'Lease', 'Hours until a started task needs news. Agents set their own with task_progress until.', `<label class="tw-num"><input class="inp" id="twLease" type="number" min="0.05" max="24" step="0.5" value="${h}" aria-label="Hours"> h</label>`)}
    ${twRow('Recruiting', 'Lets the coordinator add agents with team_recruit. Ask me: you approve each one and get its key. Automatic: created at once within the limits below. Switching it off revokes recruited agents\' keys.', `<div class="seg" id="twRec">${[['off', 'Off'], ['propose', 'Ask me'], ['auto', 'Automatic']].map(([v, l]) => `<button data-rec="${v}" class="${t.recruiting === v ? 'on' : ''}">${l}</button>`).join('')}</div>`)}
    <div class="tw-row tw-rec"${t.recruiting === 'off' ? ' hidden' : ''}><div class="tw-l"><b>Recruit limits</b>${info('Never a coordinator. Access: a template you choose, refused if it exceeds the coordinator\'s own; by default a read-only copy of the coordinator\'s vault access.')}</div>
      <div class="tw-recf">
        <label class="tw-num">Up to <input class="inp" id="twRecMax" type="number" min="1" max="20" value="${t.recruit_max}"> agents</label>
        <label class="tw-num">Keys last <input class="inp" id="twRecDays" type="number" min="1" max="90" value="${t.recruit_days}"> days</label>
        <span class="tw-roles">${['worker', 'reviewer', 'stakeholder'].map((r) => `<label><input type="checkbox" data-recrole="${r}"${(t.recruit_roles || []).includes(r) ? ' checked' : ''}> ${r}</label>`).join('')}</span>
        <select class="sel" id="twRecTpl" aria-label="Recruit access"><option value="">Read-only copy of the coordinator</option>${S.tpl.map((p) => `<option value="${esc(p.id)}"${t.recruit_template_id === p.id ? ' selected' : ''}>Template: ${esc(p.name)}</option>`).join('')}</select>
      </div></div>
  </div>`;
}
/* Team page, in layers: what needs you first, then the goal and plan, the tasks (a row per status on phones, the board on desktop) and the team.
   The lists open on their own screens: tasks (#tasks/<team>|<status>), members (#members/<team>), settings (#tsettings/<team>).
   Phones: the detail app bar. Desktop: the header row; from 1180 px two columns of cards sit above the board. */
const BOARD_COLS = [['open', 'Open', ['open', 'assigned'], 'idle'], ['doing', 'Doing', ['in_progress', 'changes_requested'], 'accent'], ['review', 'Review', ['in_review', 'approved'], 'warn'], ['blocked', 'Blocked', ['blocked'], 'bad'], ['done', 'Done', ['done'], 'ok']];
const teamNm = (t) => (aid) => t.members.find((m) => m.agent_id === aid)?.label || agLabel(aid);
/* The board's columns with their tasks. Done keeps growing: it shows the newest few; the rest is one tap away. */
function taskGroups(t, id) {
  return BOARD_COLS.map(([key, label, sts, tone]) => {
    const all = t.board.filter((k) => sts.includes(k.status)), hiddenN = all.filter((k) => k.dismissed_at).length;
    const L = all.filter((k) => key !== 'done' || !k.dismissed_at || DONE_HIDDEN.has(id)).sort((a, b) => b.awaiting_approval - a.awaiting_approval || (key === 'done' ? b.updated_at - a.updated_at : 0));
    const capped = key === 'done' && !DONE_ALL.has(id) && L.length > DONE_CAP;
    return { key, label, tone, sts, L, hiddenN, capped, shown: capped ? L.slice(0, DONE_CAP) : L };
  });
}
const progressBar = (t) => {
  const parts = Object.entries(t.counts).filter(([k, v]) => v && k !== 'cancelled');
  return `<div class="tprog" title="${esc(tasksLabel(t.progress))}"><b>${t.progress.pct}%</b><div class="sbar">${parts.map(([k, v]) => `<i class="${TCOL[k]}" style="flex:${v}" title="${esc(k.replace('_', ' '))}: ${v}"></i>`).join('') || '<i class="rest"></i>'}</div></div>`;
};
/* The decision log door's count: "2 open · 5 decided", or "None yet". */
const decDoor = (t) => { const L = t.dec || [], o = L.filter((d) => DEC_OPEN.includes(d.status)).length, a = L.filter((d) => d.status === 'answered').length; return L.length ? [o ? `<span class="warn-t">${o} open</span>` : '', a ? `${a} decided` : ''].filter(Boolean).join(' · ') || `${L.length}` : 'None yet'; };
/* The state line of a task: what to look at, in one line (overdue, waiting for you, check-in time, the blocking reason). */
function cardState(k, t) {
  const q = t.decTask?.[k.id];
  if (q) return { ico: 'chat', text: q.status === 'needs_info' ? 'Question · waiting for the agent' : `Question for you: ${q.question}`, tone: 'warn', clamp: true, tip: q.question };
  if (k.awaiting_approval) return { ico: 'check', text: 'Approved · waits for you', tone: 'warn', tip: 'The reviewer approved it; it waits for you' };
  if (k.blocked_reason) return { ico: 'warn', text: k.blocked_reason, tone: 'bad', clamp: true };
  const ts = tkText(k, t); if (!ts) return null;
  const tip = k.overdue_at ? `Past its check-in time since ${dt(k.overdue_at)}; the assignee still holds it` : k.status === 'in_review' ? 'Submitted; waiting for the reviewer' : k.lease_expires_at ? `${t.delivery_mode === 'on_demand' ? 'Check-in' : 'Lease'} ${dt(k.lease_expires_at)}` : '';
  return { ico: /^Awaiting/.test(ts.text) ? 'eye' : 'clock', text: ts.text, tone: ts.cls === 'bad-t' ? 'bad' : ts.cls === 'warn-t' ? 'warn' : '', tip };
}
/* A plan reference on a task (R1, M2): hover or focus shows what it is; on touch the same text opens in a sheet. */
function refChips(k, t) {
  if (!(k.refs || []).length) return '';
  const R = Object.fromEntries((t.plan?.requirements || []).map((r) => [r.key, r])), M = Object.fromEntries((t.plan?.milestones || []).map((m) => [m.key, m]));
  return `<span class="refs">${k.refs.map((key) => {
    const r = R[key], m = M[key], title = r ? r.title : m ? m.title : '';
    const head = r ? [key, PRI[r.priority], (REQ_ST[r.status] || [r.status])[0]].filter(Boolean).join(' · ') : m ? `${key} · ${(MS_ST[m.status] || [m.status])[0]}` : key;
    const full = title ? `${head}: ${title}` : `${key} is not in the plan any more`;
    return `<button type="button" class="ref" data-info="${esc(full)}" aria-label="${esc(full)}">${esc(key)}<span class="info-tip" role="tooltip"><b>${esc(head)}</b><span>${esc(title || 'Not in the plan any more.')}</span></span></button>`;
  }).join('')}</span>`;
}
/* Board card: the title (the whole card opens the task), one meta line, one state line, at most one button. */
function taskCard(k, main, t, id, nm) {
  const st = cardState(k, t), status = k.status !== main && !k.awaiting_approval ? k.status.replace('_', ' ') : '';
  const who = `${k.assignee ? esc(nm(k.assignee)) : 'Unassigned'}${status ? ' · ' + esc(status) : ''}${k.review_rounds ? ` · round ${k.review_rounds}` : ''}`;
  return `<article class="kc${k.awaiting_approval ? ' aw' : ''}"><button type="button" class="kc-t" data-task="${esc(id)}|${esc(k.id)}" title="${esc(k.title)}">${esc(k.title)}</button><div class="kc-m"><span class="who">${who}</span>${refChips(k, t)}</div>`
    + (st ? `<div class="kc-s ${st.tone}${st.clamp ? ' clamp' : ''}"${st.tip ? ` title="${esc(st.tip)}"` : ''}>${ic(st.ico)}<span>${esc(st.text)}</span></div>` : '')
    + (k.awaiting_approval ? `<button type="button" class="btn sm ok" data-appr="${esc(k.id)}">${ic('check')}Approve</button>` : t.decTask?.[k.id] ? `<button type="button" class="btn sm" data-dec="${esc(t.decTask[k.id].id)}">${ic('chat')}Answer</button>` : '') + '</article>';
}
function boardHtml(t, id, nm) {
  if (!t.board.length) return none('note', 'No tasks yet');
  return `<div class="board">${taskGroups(t, id).map(({ key, label, tone, sts, L, hiddenN, capped, shown }) => `<div class="bc"><h5><i class="dot ${tone}"></i>${label}<span>${L.length}</span></h5>${shown.map((k) => taskCard(k, sts[0], t, id, nm)).join('') || '<div class="bc-empty">None</div>'}`
    + `${key === 'done' && L.length > DONE_CAP ? `<button class="btn sm bc-more" data-done-all="${esc(id)}">${capped ? `Show all ${L.length}` : 'Show newest only'}</button>` : ''}${key === 'done' && hiddenN ? `<button class="btn sm bc-more" data-done-hidden="${esc(id)}">${ic('eye')}${DONE_HIDDEN.has(id) ? 'Leave out hidden' : `${hiddenN} hidden`}</button>` : ''}</div>`).join('')}</div>`;
}
/* A task as a list row (phone lists, the tasks screen, the attention list). */
function taskRow(k, main, t, id, nm) {
  const st = k.status !== main ? k.status.replace('_', ' ') : '', ts = tkText(k, t);
  return row({ title: k.title, chev: true, cls: k.awaiting_approval ? 'aw' : '', attrs: { 'data-task': `${id}|${k.id}` },
    meta: raw(`${esc(k.assignee ? nm(k.assignee) : 'Unassigned')}${st ? ' · ' + esc(st) : ''}${k.review_rounds ? ` · round ${k.review_rounds}` : ''}${ts ? ` · <span class="${ts.cls}">${esc(ts.text)}</span>` : ''}`) })
    + (k.awaiting_approval ? `<div class="tk-act"><span>Waiting for your approval</span><button type="button" class="btn sm ok" data-appr="${esc(k.id)}">${ic('check')}Approve</button></div>` : '')
    + (t.decTask?.[k.id] ? `<div class="tk-act"><span>Question for you</span><button type="button" class="btn sm" data-dec="${esc(t.decTask[k.id].id)}">${ic('chat')}Answer</button></div>`
      : k.blocked_reason ? `<div class="tk-block">${ic('warn')}${esc(k.blocked_reason)}</div>` : '');
}
const memberRow = (m, nm) => row({ lead: `<span class="av lg">${esc(initials(m.label || m.agent_id || '?'))}<i class="st ${m.stalled ? 'warn' : 'on'}"></i></span>`,
  title: raw(`<button type="button" class="mem-name" data-ses="${esc(m.agent_id)}">${esc(m.label || m.agent_id)}</button>`),
  meta: `${cap(m.role)}${m.recruited_by ? ` · recruited by ${nm(m.recruited_by)}` : ''} · active ${ago(m.last_activity_at)} ago${m.pending_items ? ` · ${m.pending_items} pending` : ''}`,
  trail: `${m.stalled ? pill('Stalled', 'warn') : ''}<button type="button" class="btn ic sm" data-hand="${esc(m.agent_id)}" aria-label="Copy handoff for ${esc(m.label || m.agent_id)}" title="Copy handoff">${ic('copy')}</button>` });
/* Everything that needs the operator, in one list: approvals first, then problems, then plan items. */
function teamAttention(t, id, nm) {
  const who = (k) => esc(k.assignee ? nm(k.assignee) : 'Unassigned');
  const task = (k, glyph, meta) => row({ lead: glyph, title: planTitle(k.title), meta: raw(meta), chev: true, attrs: { 'data-task': `${id}|${k.id}` } });
  const items = [
    ...(t.dec || []).filter((d) => DEC_OPEN.includes(d.status)).map((d) => decRow(d, (aid) => nm(aid))),
    ...t.board.filter((k) => k.awaiting_approval).map((k) => task(k, planGlyph('acc', ic('check'), 'Needs your approval'), `${who(k)} · in review`)
      + `<div class="tk-act"><span>Waiting for your approval</span><button type="button" class="btn sm ok" data-appr="${esc(k.id)}">${ic('check')}Approve</button></div>`),
    ...(t.paused_reason ? [row({ lead: planGlyph('unclear', ic('pause'), 'Paused'), title: 'Team paused', meta: t.paused_reason })] : []),
    ...(t.warnings || []).map((w) => row({ lead: planGlyph('unclear', ic('warn'), 'Warning'), title: w.label, meta: w.app_name })),
    ...t.board.filter((k) => k.status === 'blocked' && !t.decTask?.[k.id]).map((k) => task(k, planGlyph('bad', ic('ban'), 'Blocked'), `${who(k)} · <span class="bad-t">Blocked</span>`)),
    ...t.board.filter((k) => k.overdue_at).map((k) => task(k, planGlyph('bad', ic('clock'), 'Overdue'), `${who(k)}${k.review_rounds ? ` · round ${k.review_rounds}` : ''} · <span class="bad-t">${esc(tkText(k, t)?.text || 'Overdue')}</span>`)),
    ...t.members.filter((m) => m.stalled).map((m) => row({ lead: planGlyph('unclear', ic('clock'), 'Stalled'), title: `${m.label || m.agent_id} is stalled`, meta: `${m.pending_items ? m.pending_items + ' pending · ' : ''}active ${ago(m.last_activity_at)} ago`, chev: true, attrs: { 'data-ses': m.agent_id } })),
    ...(t.status_requested_at ? [row({ lead: planGlyph('unclear', ic('note'), 'Waiting'), title: 'Status update requested', meta: `Asked ${ago(t.status_requested_at)} ago; no report yet`, chev: true, attrs: { 'data-tstatus': id } })] : []),
    ...planAttentionRows(t, id),
  ];
  if (!items.length) return '';
  const SHOW = 6;
  return sec(`Needs attention · ${items.length}`, items.slice(0, SHOW).join('') + (items.length > SHOW ? row({ one: true, title: `${items.length - SHOW} more`, chev: true, attrs: { 'data-tasks': `${id}|all` } }) : ''));
}
VIEWS.team = async (id) => {
  const tp = '/teams/' + encodeURIComponent(id), [t, tdir] = await Promise.all([api(tp).then((r) => withDecisions(r.team)), api(tp + '/directives').catch(() => null)]), nm = teamNm(t);
  const stalled = t.members.filter((m) => m.stalled).length, pendingRec = (t.recruits || []).filter((q) => q.status === 'pending');
  const onDemand = t.delivery_mode === 'on_demand', nMem = t.members.length;
  const stopTeam = () => run(async () => { await post(`${tp}/stop`); await refresh(); openD('team', id, true); });
  const act = (cls, ico, lbl, p, sm) => `<button class="btn${sm ? ' sm' : ''} ${cls}" data-ta="${p}">${ic(ico)}${lbl}</button>`;
  const prim = (sm) => `${t.status === 'draft' ? act('ok', 'play', 'Start', 'start', sm) : ''}${t.status === 'running' ? act('', 'pause', 'Pause', 'pause', sm) : ''}${t.status === 'paused' ? act('ok', 'play', 'Resume', 'resume', sm) : ''}${t.room_id ? `<button class="btn${sm ? ' sm' : ''}" data-room="${esc(t.room_id)}">${ic('chat')}Chat</button>` : ''}`;
  // Hourly limits, when set, read as part of the settings line: "tasks 2/10 · messages 14/60".
  const limitList = Object.entries(t.limits || {}).map(([k, v]) => { const u = t.usage?.[k] ?? t.usage?.[k.replace('_per_hour', '')] ?? 0; return { k: k.replace(/_per_hour|_bytes/g, '').replace(/_/g, ' '), u, v }; });
  const settings = [onDemand ? 'On demand' : 'Polling', `Messaging ${t.grant_messaging ? 'on' : 'off'}`, limitList.length ? 'Limits ' + limitList.map((x) => `${x.k} ${x.u}/${x.v}`).join(' · ') : '', t.close_on_approve ? 'Closes on approval' : '', t.coordinator_reviews ? 'Coordinator reviews' : '', t.checkpoints?.length ? 'Approval before done' : ''].filter(Boolean);
  const G = taskGroups(t, id), total = t.progress.total;
  const tasksIdx = total ? `${progressBar(t)}<p class="meta tm-counts">${t.progress.done} of ${total} tasks done</p><div class="doors tm-idx">${['doing', 'review', 'blocked', 'open', 'done'].map((k) => G.find((g) => g.key === k)).filter((g) => g.L.length)
    .map((g) => row({ one: true, lead: `<span class="dot ${g.tone}"></span>`, dot: true, title: g.label, trail: `<span>${g.L.length}</span>`, chev: true, attrs: { 'data-tasks': `${id}|${g.key}` } })).join('')}</div>` : none('note', 'No tasks yet');
  const avs = `<span class="t-avs">${t.members.slice(0, 4).map((m) => `<span class="av">${esc(initials(m.label || m.agent_id || '?'))}</span>`).join('')}${nMem > 4 ? `<span class="av more">+${nMem - 4}</span>` : ''}</span>`;
  const teamCard = sec('Team', row({ title: 'Members', meta: raw(`${nMem}${stalled ? ` · <span class="warn-t">${stalled} stalled</span>` : ''}`), trail: avs, chev: true, attrs: { 'data-members': id } })
    + row({ title: 'Settings', meta: settings.join(' · '), chev: true, attrs: { 'data-tsettings': id } })
    + (tdir ? row({ title: 'Directives', meta: raw(tdir.count ? `${tdir.count} in force${tdir.behind ? ` · <span class="warn-t">${tdir.behind} not read</span>` : ' · all read'}${tdir.open_reports ? ` · ${tdir.open_reports} not reviewed` : ''}` : 'None yet'), chev: true, attrs: { 'data-go': 'directives' } }) : ''));
  const recruits = (HANDOFF[id]?.length ? sec('Approved recruits', `<div class="rq-list">${HANDOFF[id].map((h, i) => `<div class="rq"><div class="rq-out">${vnote('Start a session for <b>' + esc(h.label) + '</b> with this handoff. The hub shows it only once: copy it before you dismiss it.') + codeBox(h.text, true)}</div><div class="row"><button class="btn sm" data-hand-x="${i}">${ic('x')}Dismiss</button></div></div>`).join('')}</div>`) : '')
    + (pendingRec.length ? sec('Recruit requests', `<div class="rq-list">${pendingRec.map((q) => `<div class="rq" data-rq="${esc(q.id)}"><div><b>${esc(q.label)}</b> <span class="tag">${esc(q.role)}</span><small>${esc(q.purpose)} · asked by ${esc(nm(q.requested_by))}, ${ago(q.created_at)} ago</small></div><div class="row"><button class="btn ok sm" data-rq-ok="${esc(q.id)}">${ic('check')}Approve</button><button class="btn sm" data-rq-no="${esc(q.id)}">${ic('x')}Deny</button></div><div class="rq-out"></div></div>`).join('')}</div>`) : '');
  return {
    t: `${ic('team')}<span class="ellip">${esc(t.name)}</span>${pill(cap(t.status), TONE[t.status] || 'idle')}<span class="tmeta">${esc(`${onDemand ? 'On demand' : 'Polling'} · ${nMem} member${nMem === 1 ? '' : 's'}${stalled ? ` · ${stalled} stalled` : ''}`)}</span>`,
    a: prim(true) + moreBtn(),
    dbar: { title: t.name, meta: `${cap(t.status)} · ${onDemand ? 'on demand' : 'polling'} · ${nMem} member${nMem === 1 ? '' : 's'}`,
      menu: [{ label: 'Team status', icon: 'note', fn: () => openD('tstatus', id) }, ['draft', 'running', 'paused'].includes(t.status) ? { label: 'Stop team', icon: 'stop', bad: true, confirm: 'Tap again to stop the team', fn: stopTeam } : null] },
    b: `<div class="tm-acts only-m">${prim(false)}</div>`
      + `<div class="tm-grid"><div class="tm-a">${teamAttention(t, id, nm)}${recruits}</div><div class="tm-gp">${teamGoalPlan(t, id, nm)}</div>`
      + `<div class="tm-tasks only-m">${sec(total ? `Tasks · ${total}` : 'Tasks', tasksIdx)}</div><div class="tm-team">${teamCard}</div></div>`
      + `<section class="sec tm-board only-d"><div class="bh"><h4>Board</h4>${total ? progressBar(t) + `<span class="meta">${t.progress.done} of ${total} done</span>` : ''}</div>${boardHtml(t, id, nm)}</section>`,
    after() {
      $$('[data-ta]').forEach((b) => (b.onclick = () => run(async () => { await post(`${tp}/${b.dataset.ta}`); await refresh(); openD('team', id, true); })));
      // Only this screen's buttons: the hidden overview's alert chips carry data-appr too.
      $$('[data-appr]', $('#dB')).forEach((b) => (b.onclick = () => run(async () => { await post(`${tp}/tasks/${b.dataset.appr}/approve`); toast('Approved'); await refresh(); openD('team', id, true); })));
      $$('[data-rq-ok]').forEach((b) => (b.onclick = () => run(async () => {
        const r = await post(`/recruits/${b.dataset.rqOk}/approve`);
        // The handoff holds a new key the hub shows once: keep it until dismissed, so a redraw of the team cannot lose it.
        (HANDOFF[id] = HANDOFF[id] || []).push({ label: r.agent.label, text: r.handoff });
        toast('Approved'); await refresh(); openD('team', id, true);
      })));
      $$('[data-hand-x]').forEach((b) => (b.onclick = () => { HANDOFF[id].splice(+b.dataset.handX, 1); openD('team', id, true); }));
      $$('[data-rq-no]').forEach((b) => (b.onclick = () => run(async () => { const note = prompt('Reason for the coordinator (optional)') ?? ''; await post(`/recruits/${b.dataset.rqNo}/deny`, { note }); toast('Denied'); openD('team', id, true); })));
      const pr = $('#planAsk');
      if (pr) pr.onclick = () => run(async () => { const note = prompt('What should the coordinator look at? (optional)') ?? ''; if (note === null) return; await post(`${tp}/plan-request`, { note }); toast('Asked the coordinator to review the plan'); openD('team', id, true); });
      $$('[data-done-hidden]').forEach((b) => (b.onclick = () => { if (DONE_HIDDEN.has(id)) DONE_HIDDEN.delete(id); else DONE_HIDDEN.add(id); openD('team', id, true); }));
      $$('[data-done-all]').forEach((b) => (b.onclick = () => { if (DONE_ALL.has(id)) DONE_ALL.delete(id); else DONE_ALL.add(id); openD('team', id, true); }));
    },
  };
};
/* Tasks of a team, one status at a time: #tasks/<team>|doing|review|blocked|open|done|all. */
VIEWS.tasks = async (arg) => {
  const [teamId, fl = ''] = String(arg).split('|'), tp = '/teams/' + encodeURIComponent(teamId);
  const t = await withDecisions((await api(tp)).team), nm = teamNm(t), G = taskGroups(t, teamId);
  const order = ['doing', 'review', 'blocked', 'open', 'done'].map((k) => G.find((g) => g.key === k)).filter((g) => g.L.length || g.hiddenN);
  const cur = fl === 'all' ? 'all' : order.find((g) => g.key === fl)?.key || order[0]?.key || 'all';
  const list = (g) => g.shown.map((k) => taskRow(k, g.sts[0], t, teamId, nm)).join('')
    + (g.key === 'done' && g.L.length > DONE_CAP ? row({ one: true, title: g.capped ? `Show all ${g.L.length}` : 'Show newest only', attrs: { 'data-done-all': teamId } }) : '')
    + (g.key === 'done' && g.hiddenN ? row({ one: true, title: DONE_HIDDEN.has(teamId) ? 'Leave out hidden' : `${g.hiddenN} hidden`, attrs: { 'data-done-hidden': teamId } }) : '');
  const tab = (key, label, n) => `<button type="button" role="tab" class="${key === cur ? 'on' : ''}" aria-selected="${key === cur}" data-tasks-f="${esc(teamId)}|${key}">${label}<span class="cnt">${n}</span></button>`;
  const body = t.board.length
    ? `<nav class="tabs" role="tablist" aria-label="Task status">${order.map((g) => tab(g.key, g.label, g.L.length)).join('')}${tab('all', 'All', order.reduce((n, g) => n + g.L.length, 0))}</nav>`
      + `<section class="sec"><div>${cur === 'all' ? order.map((g) => overline(g.label, g.L.length) + list(g)).join('') : list(order.find((g) => g.key === cur))}</div></section>`
    : none('note', 'No tasks yet');
  return {
    t: `${ic('team')}<span class="ellip">${esc(t.name)} · Tasks</span>`,
    a: `<button class="btn sm" data-team="${esc(teamId)}">${ic('team')}Team</button>`,
    dbar: { title: 'Tasks', meta: `${t.name} · ${t.progress.total ? `${t.progress.done} of ${t.progress.total} done` : 'none yet'}`, menu: [{ label: 'Open ' + t.name, icon: 'team', fn: () => openD('team', teamId) }] },
    b: body,
    after() {
      $$('[data-appr]', $('#dB')).forEach((b) => (b.onclick = () => run(async () => { await post(`${tp}/tasks/${b.dataset.appr}/approve`); toast('Approved'); await refresh(); openD('tasks', arg, true); })));
      $$('[data-done-hidden]').forEach((b) => (b.onclick = () => { if (DONE_HIDDEN.has(teamId)) DONE_HIDDEN.delete(teamId); else DONE_HIDDEN.add(teamId); openD('tasks', arg, true); }));
      $$('[data-done-all]').forEach((b) => (b.onclick = () => { if (DONE_ALL.has(teamId)) DONE_ALL.delete(teamId); else DONE_ALL.add(teamId); openD('tasks', arg, true); }));
    },
  };
};
VIEWS.members = async (teamId) => {
  const tp = '/teams/' + encodeURIComponent(teamId), t = (await api(tp)).team, nm = teamNm(t);
  return {
    t: `${ic('team')}<span class="ellip">${esc(t.name)} · Members</span>`,
    a: `<button class="btn sm" data-team="${esc(teamId)}">${ic('team')}Team</button>`,
    dbar: { title: 'Members', meta: `${t.name} · ${t.members.length}`, menu: [{ label: 'Open ' + t.name, icon: 'team', fn: () => openD('team', teamId) }] },
    b: t.members.length ? `<section class="sec"><div>${t.members.map((m) => memberRow(m, nm)).join('')}</div></section>` : none('team', 'No members'),
    after() { $$('[data-hand]').forEach((b) => (b.onclick = () => run(async () => { const h = await api(`${tp}/handoff`); const m = h.messages.find((x) => x.agent_id === b.dataset.hand); if (m) copy(m.text); }))); },
  };
};
VIEWS.tsettings = async (teamId) => {
  const tp = '/teams/' + encodeURIComponent(teamId), t = (await api(tp)).team;
  return {
    t: `${ic('team')}<span class="ellip">${esc(t.name)} · Settings</span>`,
    a: `<button class="btn sm" data-team="${esc(teamId)}">${ic('team')}Team</button>`,
    dbar: { title: 'Settings', meta: t.name, menu: [{ label: 'Open ' + t.name, icon: 'team', fn: () => openD('team', teamId) }] },
    b: sec('How it works', teamWorkflow(t))
      + `<div class="actionbar">${info('Members get a notice; playbooks still at the default switch to the new mode\'s text.')}<button type="button" class="btn pri" id="twSave">${ic('check')}Save workflow</button></div>`,
    after() {
      // These controls are buttons, not inputs: mark the form edited so the background refresh leaves it alone.
      $$('#twMode button').forEach((b) => (b.onclick = () => { markEdited(); $$('#twMode button').forEach((x) => x.classList.toggle('on', x === b)); }));
      $$('#twRec button').forEach((b) => (b.onclick = () => { markEdited(); $$('#twRec button').forEach((x) => x.classList.toggle('on', x === b)); $('.tw-rec').hidden = b.dataset.rec === 'off'; }));
      $$('.tw [role=switch]').forEach((b) => (b.onclick = () => { markEdited(); flipSwitch(b); }));
      $('#twSave').onclick = () => run(async () => {
        const mode = $('#twMode button.on')?.dataset.mode || t.delivery_mode, mins = Math.round(Number($('#twLease').value) * 60);
        if (!(mins >= 1 && mins <= 1440)) return toast('Check-in time: between 1 minute and 24 hours', true);
        const rec = $('#twRec button.on')?.dataset.rec || t.recruiting, roles = $$('[data-recrole]').filter((x) => x.checked).map((x) => x.dataset.recrole);
        if (rec !== 'off' && !roles.length) return toast('Pick at least one role a recruit may take', true);
        if (rec === 'off' && t.recruiting !== 'off' && !confirm('Switching recruiting off revokes the keys of agents this team recruited. Continue?')) return;
        await api(tp, 'PATCH', { delivery_mode: mode, close_on_approve: $('#twClose').classList.contains('on'), coordinator_reviews: $('#twCoord').classList.contains('on'), lease_minutes: mins,
          recruiting: rec, ...(rec !== 'off' ? { recruit_max: Math.max(1, Math.min(20, +$('#twRecMax').value || 4)), recruit_days: Math.max(1, Math.min(90, +$('#twRecDays').value || 7)), recruit_roles: roles, recruit_template_id: $('#twRecTpl').value || null } : {}) });
        toast('Workflow saved; members were told'); openD('tsettings', teamId, true);
      });
    },
  };
};
const DONE_CAP = 8, DONE_ALL = new Set(), DONE_HIDDEN = new Set();
/* Task report: what was asked, what came back, review and issues, the timeline, and vault files the assignee
   changed while the task was open. Opened from a board card; Back returns to the team. */
const TE_LABEL = { task_create: 'Created', task_assign: 'Assigned', task_claim: 'Claimed', task_start: 'Started', task_progress: 'Progress', task_submit: 'Submitted for review', task_review: 'Reviewed', task_complete: 'Closed', task_block: 'Blocked', task_cancel: 'Cancelled', lease_expired: 'Lease expired', admin_approve: 'Approved by admin' };
/* Notes written by the hub name agents by id; show their labels. */
const noteH = (s) => esc(s).replace(/agent-[a-z0-9]{6,}/g, (id) => esc(agLabel(id)));
const dHM = (ms) => { const m = Math.round(ms / 60000); return m < 60 ? m + ' min' : m < 1440 ? Math.floor(m / 60) + ' h ' + (m % 60) + ' min' : Math.round(m / 1440) + ' d'; };
/* Lifecycle: the six steps a task passes through. changes_requested sits on In progress (the assignee reworks it); blocked stays on the step it was
   blocked at; cancelled leaves every step untouched. */
const LC = [['open', 'Open'], ['assigned', 'Assigned'], ['in_progress', 'In progress'], ['in_review', 'In review'], ['approved', 'Approved'], ['done', 'Done']];
const LC_AT = { open: 0, assigned: 1, in_progress: 2, changes_requested: 2, in_review: 3, approved: 4, done: 5 };
function lifecycle(k, t, events) {
  const blocked = k.status === 'blocked', cancelled = k.status === 'cancelled', done = k.status === 'done';
  const was = [...events].reverse().find((e) => e.to_status === 'blocked')?.from_status;
  const at = cancelled ? -1 : blocked ? LC_AT[was] ?? 2 : LC_AT[k.status] ?? 0;
  const dots = LC.map(([, label], i) => {
    const st = done || i < at ? 'done' : i === at ? 'cur' : 'todo';
    return `<li class="lc-s ${st}${blocked && i === at ? ' bad' : ''}" aria-label="${esc(label)}, ${st === 'done' ? 'done' : st === 'cur' ? 'current' : 'to come'}"${st === 'cur' && !done ? ' aria-current="step"' : ''}><span class="lc-dot">${st === 'done' ? ic('check') : ''}</span><span class="lc-l">${esc(label)}</span></li>`;
  }).join('');
  const odd = blocked || cancelled, ts = tkText(k, t), chip = ts && ts.text !== 'Awaiting review' ? pill(ts.text, ts.cls === 'bad-t' ? 'bad' : ts.cls === 'warn-t' ? 'warn' : 'idle') : '';
  const label = cancelled ? 'Cancelled' : blocked ? 'Blocked' : done ? 'Done' : LC[at][1];
  const note = k.status === 'changes_requested' ? 'Changes requested' : blocked && k.blocked_reason ? trunc(k.blocked_reason, 90) : '';
  const round = k.review_rounds ? `<span class="only-m">Round ${k.review_rounds}</span>` : '';
  const sub = [round, note ? esc(note) : ''].filter(Boolean).join('<span class="only-m"> · </span>');
  const foot = `<div class="lc-foot${odd || note || chip ? '' : ' only-m'}"><span class="lc-now"><b class="${odd ? '' : 'only-m'}${blocked ? ' bad-t' : ''}">${esc(label)}</b>${sub ? `<span class="lc-sub${k.status === 'changes_requested' ? ' warn-t' : ''}"${blocked ? ` title="${esc(k.blocked_reason || '')}"` : ''}>${sub}</span>` : ''}</span>${chip}</div>`;
  return `<ol class="lc${cancelled ? ' off' : ''}" aria-label="Task progress">${dots}</ol>${foot}`;
}
VIEWS.task = async (arg) => {
  const [teamId, taskId] = String(arg).split('|'), tp = '/teams/' + encodeURIComponent(teamId);
  const [{ task: k, events }, { team: t }] = await Promise.all([api(`${tp}/tasks/${encodeURIComponent(taskId)}`), api(tp)]);
  if (!k) return { t: `${ic('note')}Task`, b: none('note', 'Task not found'), dbar: { title: 'Task', meta: '' } };
  const nm = (aid) => (aid ? t.members.find((m) => m.agent_id === aid)?.label || agLabel(aid) : '—');
  const who = (aid) => (aid && AG(aid) ? `<a href="#" data-ses="${esc(aid)}">${esc(nm(aid))}</a>` : esc(nm(aid)));
  const evActor = (e) => (e.actor_kind === 'agent' ? who(e.actor_id) : e.actor_kind === 'admin' ? 'Admin' : 'Hub');
  const start = events.find((e) => e.tool === 'task_start')?.created_at;
  const end = k.status === 'done' ? events.filter((e) => e.to_status === 'done').at(-1)?.created_at : null;
  // Files the assignee changed while the task was open (hub vault only; work done elsewhere is not visible here).
  let files = [];
  if (k.assignee) {
    try { const a = await api('/vault/activity?writes=1&limit=200&agent=' + encodeURIComponent(k.assignee)); files = a.revisions.filter((r) => r.created_at >= k.created_at && r.created_at <= (end || Date.now())); }
    catch { /* optional */ }
  }
  const md = (txt) => `<article class="md task-md">${mdRender(txt, () => null)}</article>`;
  const hideTask = () => run(async () => { await post(`${tp}/tasks/${encodeURIComponent(taskId)}/dismiss`, { dismissed: !k.dismissed_at }); toast(k.dismissed_at ? 'Shown on the board' : 'Hidden from the board'); openD('task', arg, true); });
  const closed = k.status === 'done' || k.status === 'cancelled', refs = (k.refs || []).join(', '), status = k.status.replace('_', ' ');
  const metaLine = [t.name, refs, status].filter(Boolean).join(' · ');
  // People: who does the work and who reviews it, then the dates.
  const person = (aid, what) => {
    const r = t.members.find((m) => m.agent_id === aid)?.role;
    return aid ? row({ as: 'div', lead: `<span class="av lg">${esc(initials(nm(aid)))}</span>`, title: raw(who(aid)), meta: [what, r && cap(r) !== what && cap(r)].filter(Boolean).join(' · ') })
      : row({ as: 'div', cls: 'tk-none', lead: `<span class="av lg">${ic('user')}</span>`, title: what === 'Assignee' ? 'Not assigned' : 'No reviewer', meta: what });
  };
  const share = k.share_id ? kv('Attached share', `<button class="btn sm" data-share="${esc(k.share_id)}">${ic('link')}Open${k.share_version ? ' v' + k.share_version : ''}</button>`) : '';
  const people = sec('People', person(k.assignee, 'Assignee') + person(k.reviewer, 'Reviewer')
    + `<div class="tk-kv">${kv('Opened', esc(dt(k.created_at)))}${kv('Review rounds', String(k.review_rounds || 0))}${refs ? kv('Requirement', refChips(k, t)) : ''}${end ? kv('Closed', esc(dt(end))) + kv('Took', esc(dHM(end - (start || k.created_at)))) : ''}${share}</div>`);
  // Review rounds: each submission with the reviewer's verdict under it. The newest round comes first; every comment appears once.
  const rounds = []; let cur = null;
  for (const e of events) {
    if (e.tool === 'task_submit') rounds.push((cur = { at: e.created_at, by: e.actor_id, text: e.note || '', rev: null }));
    else if (cur && !cur.rev && (e.tool === 'task_review' || e.tool === 'admin_approve')) cur.rev = e;
  }
  if (!rounds.length && k.summary) rounds.push({ at: k.updated_at, by: k.assignee, text: k.summary, rev: null });
  const lastR = rounds.at(-1);
  if (lastR) {
    if (k.summary) lastR.text = k.summary;
    if (k.review_comments) lastR.rev = lastR.rev ? { ...lastR.rev, note: k.review_comments } : ['approved', 'changes_requested', 'done'].includes(k.status) ? { to_status: k.status, actor_kind: 'agent', actor_id: k.reviewer, created_at: k.updated_at, note: k.review_comments } : null;
  }
  const VERD = { approved: ['Approved', 'ok', 'check'], done: ['Approved', 'ok', 'check'], changes_requested: ['Changes requested', 'warn', 'warn'] };
  const round = (r, i) => {
    const used = files.filter((f, j) => files.findIndex((g) => g.path === f.path) === j && (r.text.includes(f.path) || r.text.includes(f.path.split('/').pop())));
    const v = r.rev && (VERD[r.rev.to_status] || [TE_LABEL[r.rev.tool] || 'Reviewed', '', 'note']);
    const verdict = v ? `<div class="rd-rev ${v[1]}"><div class="rd-st"><span class="rd-lab ${v[1] ? v[1] + '-t' : ''}">${ic(v[2])}${esc(v[0])}</span><span class="meta"> · ${evActor(r.rev)} · ${esc(dt(r.rev.created_at))}</span></div>${r.rev.note ? md(r.rev.note) : ''}</div>`
      : r === lastR && k.status === 'in_review' ? `<p class="rd-wait">Awaiting review</p>` : '';
    return `<article class="rd" data-round="${i + 1}"><div class="rd-h"><span class="rd-n">v${i + 1}</span><span class="meta">Submitted · ${r.by ? who(r.by) : 'Hub'} · ${esc(dt(r.at))}</span></div>${r.text ? md(r.text) : ''}`
      + `${used.length ? `<div class="rd-files">${used.map((f) => `<span>${ic('file')}${vaultFileLink(f.path)}</span>`).join('')}</div>` : ''}${verdict}</article>`;
  };
  const thread = sec('Review rounds', rounds.length ? rounds.map(round).reverse().join('') : none('note', k.status === 'done' ? 'No summary was submitted' : 'Not submitted yet'));
  // Vault files the assignee changed meanwhile: five rows, the rest on request.
  const FN = 5, hm = (ms) => (new Date(ms).toDateString() === new Date().toDateString() ? clock(ms) : dt(ms));
  const fileRow = (r, i) => row({ one: true, as: 'div', cls: i >= FN ? 'tk-xtra' : '', lead: ic('file'), title: raw(vaultFileLink(r.path)), trail: `<span>${esc(VE_OP[r.op] || r.op)} · ${esc(hm(r.created_at))}</span>` });
  const fileCard = files.length ? sec(`Vault files changed meanwhile · ${files.length}`, `<div class="tk-files" id="tkFiles">${files.map(fileRow).join('')}${files.length > FN ? row({ one: true, cls: 'tk-more', title: `Show ${files.length - FN} more`, attrs: { id: 'tkMore', 'aria-expanded': 'false' } }) : ''}</div>`) : '';
  // Timeline: compact rows; what rounds already show is not repeated (a one-line excerpt at most).
  const days = new Set(events.map((e) => new Date(e.created_at).toDateString())).size > 1;
  let day = '';
  const tlRows = events.map((e) => {
    const d = new Date(e.created_at).toDateString(), head = days && d !== day ? overline(planDate(e.created_at)) : ''; day = d;
    const long = e.tool === 'task_submit' || e.tool === 'task_review', ex = e.note && !long ? noteH(trunc(e.note.replace(/\s+/g, ' '), 100)) : '';
    return head + row({ as: 'div', cls: 'aud', one: !ex, lead: auTime(e.created_at), title: raw(`${esc(TE_LABEL[e.tool] || e.tool || e.to_status)} · ${evActor(e)}`), meta: raw(ex) });
  }).join('');
  const fold = (cls, label, body) => `<details class="task-brief tk-fold ${cls}"><summary><span>${label}</span>${ic('chev')}</summary>${body}</details>`;
  const more = `<section class="sec tk-more">${fold('tk-tl', `Full timeline · ${events.length} event${events.length === 1 ? '' : 's'}`, `<div class="tk-tlr">${tlRows}</div>`) + (k.description ? fold('', 'Original brief', md(k.description)) : '')}</section>`;
  return {
    t: `${ic('note')}<span class="tk-ht"><span class="tk-h">${esc(k.title)}</span><span class="tmeta">${esc(metaLine)}</span></span>`,
    a: `${closed ? `<button class="btn sm" id="tkHide">${ic(k.dismissed_at ? 'eye' : 'x')}${k.dismissed_at ? 'Show on board' : 'Hide from board'}</button>` : ''}<button class="btn sm" data-team="${esc(teamId)}">${ic('team')}${esc(t.name)}</button>`,
    dbar: { title: k.title, meta: metaLine, menu: [closed ? { label: k.dismissed_at ? 'Show on board' : 'Hide from board', icon: k.dismissed_at ? 'eye' : 'x', fn: hideTask } : null, { label: 'Open ' + t.name, icon: 'team', fn: () => openD('team', teamId) }] },
    after() {
      const h = $('#tkHide'); if (h) h.onclick = hideTask;
      const m = $('#tkMore'); if (m) m.onclick = () => { const all = $('#tkFiles').classList.toggle('all'); m.setAttribute('aria-expanded', String(all)); m.querySelector('.lrow-title').textContent = all ? 'Show fewer' : `Show ${files.length - FN} more`; };
    },
    b: `<div class="tk">${k.dismissed_at ? vnote(`Hidden from the board ${esc(ago(k.dismissed_at))} ago. The task and this report are kept.`) : ''}<section class="sec tk-lc">${lifecycle(k, t, events)}</section>`
      + `<div class="tk-grid"><aside class="tk-side">${people}</aside><div class="tk-main">${thread}${fileCard}${more}</div></div></div>`,
  };
};
/* Team status: the coordinator's latest status report (each team_report replaces it), earlier ones below,
   and a way to ask for a fresh one. Asking notifies the coordinators with the expected format. */
VIEWS.tstatus = async (teamId) => {
  const tp = '/teams/' + encodeURIComponent(teamId);
  const [{ team: t }, st] = await Promise.all([api(tp), api(`${tp}/status`)]);
  const nm = (aid) => (aid ? t.members.find((m) => m.agent_id === aid)?.label || agLabel(aid) : 'Unknown');
  const [cur, ...older] = st.reports;
  const coords = t.members.filter((m) => m.role === 'coordinator').map((m) => m.label).join(', ') || 'the coordinator';
  const head = (r) => `<div class="rep-meta"><span>${esc(nm(r.agent_id))} · ${esc(dt(r.created_at))}</span><span>${ago(r.created_at)} ago</span></div>`;
  return {
    t: `${ic('note')}<span class="ellip">${esc(t.name)} status</span>`,
    a: `<button class="btn sm" data-team="${esc(teamId)}">${ic('team')}Board</button>`,
    dbar: { title: 'Team status', meta: t.name, menu: [{ label: 'Open ' + t.name, icon: 'team', fn: () => openD('team', teamId) }] },
    b: (st.requested_at ? vnote(`<b>Update requested ${esc(ago(st.requested_at))} ago</b>${st.request_note ? ': ' + esc(st.request_note) : ''}. Waiting for ${esc(coords)}.`) : '') +
      (cur ? `<section class="sec rep">${head(cur)}<article class="md task-md">${mdRender(cur.body, () => null)}</article></section>` : none('note', 'No status report yet')) +
      (older.length ? `<details class="task-brief"><summary>${ic('chev')}Earlier reports (${older.length})</summary>${older.map((r) => `<section class="sec rep">${head(r)}<article class="md task-md">${mdRender(r.body, () => null)}</article></section>`).join('')}</details>` : '') +
      `<div class="actionbar tsask">${info('The coordinator gets the request with its next hub call, with the expected format: progress, key results, blockers, decisions needed.')}<input class="inp" id="tsNote" maxlength="500" placeholder="Ask for an update (optional note)" aria-label="Ask for an update">
        <button class="btn pri" id="tsAsk" aria-label="Ask ${esc(coords)} for an update">${ic('up')}<span class="hide-m">Ask ${esc(coords)}</span></button></div>`,
    after() {
      const b = $('#tsAsk');
      if (b) b.onclick = () => run(async () => { await post(`${tp}/status-request`, { note: $('#tsNote').value.trim() || undefined }); toast('Update requested'); openD('tstatus', teamId, true); });
    },
  };
};
/* Team builder. Members are agents: one identity each, with its permissions on its own session key. An agent can be
   in several teams and projects at once; the team adds team tools and messaging, not vault access. Where it runs is
   the PC and app key it logs in through, which can change: a team does not bind a PC. */
VIEWS.tbuild = async () => {
  if (!S.tpl.length) S.tpl = (await api('/templates')).templates;
  const RL = [['coordinator', 'Coordinator', 'Plans, assigns and closes tasks'], ['worker', 'Worker', 'Does assigned tasks'], ['reviewer', 'Reviewer', 'Reviews submissions'], ['stakeholder', 'Stakeholder', 'Receives reports']];
  const lim = [['tasks_per_hour', 'Tasks/h'], ['messages_per_hour', 'Msgs/h'], ['writes_per_hour', 'Writes/h']];
  const B = { sel: new Map(), q: '', made: [] };
  const keyOf = (aid) => S.keys.filter((k) => k.kind === 'session_key' && k.agent_id === aid && k.effective_status === 'active').sort((x, y) => y.created_at - x.created_at)[0];
  const agentCard = (a) => {
    const teams = S.teams.filter((t) => (t.agent_ids || []).includes(a.id) && !['done', 'stopped'].includes(t.status));
    const ses = SESA(a.id), login = ses?.logins?.[0], key = keyOf(a.id), role = B.sel.get(a.id);
    return `<div class="bm${role ? ' on' : ''}${key ? '' : ' nokey'}" data-a="${esc(a.id)}">
      <label class="bm-pick"><input type="checkbox"${role ? ' checked' : ''}${key ? '' : ' disabled'} aria-label="Add ${esc(a.label)}"></label>
      <div class="bm-main"><b>${esc(a.label)}</b><small>${esc([a.role, a.project].filter(Boolean).join(' · ') || 'No role or project')}</small>
        <div class="bm-ctx">
          <span title="Teams this agent is already in. It can be in several.">${ic('team')}${teams.length ? teams.map((t) => esc(t.name)).join(', ') : 'No team'}</span>
          <span title="Its permissions come from this session key">${ic('key')}${key ? esc(key.label) : 'No active key'}</span>
          <span title="Where it last logged in (PC · app). An agent can move between PCs.">${ic('pc')}${login ? esc((login.pc?.name || '—') + ' · ' + (login.app || '—')) : ses?.agent?.last_seen_at ? 'Seen ' + ago(ses.agent.last_seen_at) + ' ago' : 'Never logged in'}</span>
        </div></div>
      <select class="sel bm-role" aria-label="Role in this team"${role ? '' : ' disabled'}>${RL.map(([r, l]) => `<option value="${r}"${r === (role || 'worker') ? ' selected' : ''}>${l}</option>`).join('')}</select>
    </div>`;
  };
  const draw = () => {
    const ag = S.agents.filter((a) => a.status !== 'archived' && a.status !== 'revoked' && (!B.q || (a.label + ' ' + (a.project || '') + ' ' + (a.role || '')).toLowerCase().includes(B.q)));
    $('#bM').innerHTML = ag.map(agentCard).join('') || none('ses', B.q ? 'No match' : 'No agents yet. Create one below.');
    const n = B.sel.size, c = [...B.sel.values()].filter((r) => r === 'coordinator').length;
    $('#bSum').innerHTML = n ? `${n} member${n === 1 ? '' : 's'}${c ? '' : ` · <span class="warn-t">pick a coordinator</span>`}` : 'No members yet';
  };
  return {
    t: `${ic('team')}New team`,
    dbar: { title: 'New team', meta: 'Name, members and rules' },
    b: `<div class="tb">
      <div class="tb-col">
        ${sec('Team', `<label class="fld"><span class="vlabel">Name</span><input class="inp" id="bN" maxlength="80" autocomplete="off"></label>
          <label class="fld"><span class="vlabel">Goal</span><textarea class="inp" id="bG" rows="3" maxlength="4000" ></textarea></label>`)}
        ${sec('Members', `<div class="tb-tools"><div class="srch">${ic('search')}<input class="inp" id="bQ" type="search" placeholder="Find an agent" aria-label="Find an agent"></div><span class="faint" id="bSum"></span></div>
          <div id="bM" class="bms"></div>
          <details class="tb-new" id="bNew"><summary>${ic('plus')}New agent for this team</summary>
            <div class="tb-new-f">
              <label class="fld"><span class="vlabel">Name</span><input class="inp" id="nnL" maxlength="80" placeholder="e.g. Reviewer B"></label>
              <label class="fld"><span class="vlabel">Project</span><input class="inp" id="nnP" maxlength="80" placeholder="Defaults to the team name"></label>
              <label class="fld"><span class="vlabel">Role in this team</span><select class="sel" id="nnR">${RL.map(([r, l]) => `<option value="${r}"${r === 'worker' ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
              <label class="fld"><span class="vlabel">Vault permissions</span><select class="sel" id="nnT"><option value="">None yet (set later)</option>${S.tpl.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('')}</select></label>
              <div class="row"><button class="btn ok sm" id="nnGo">${ic('key')}Create agent and key</button>${info('Same as Security → Session: the key is shown once, to hand to the agent.')}</div>
              <div id="nnOut"></div>
            </div></details>`, info('Members are agents. Each has its own permissions through its session key, and can belong to several teams. A team needs at least one coordinator.'))}
      </div>
      <div class="tb-col">
        ${sec('How it works', `<div class="tw">
          ${twRow('Mode', 'Polling agents loop on work_next. On-demand agents work when woken and never poll.', `<div class="seg" id="bMode"><button data-mode="poll" class="on">${ic('rot')}Polling</button><button data-mode="on_demand">${ic('bolt')}On demand</button></div>`)}
          ${twRow('Messaging', 'Members may message each other and the team room.', switchBtn('Messaging', true, 'id="bMsg"'))}
          ${twRow('Approval before done', 'Finished tasks wait for you.', switchBtn('Approval before done', false, 'id="bCp"'))}
          ${twRow('Close on approval', 'An approving review closes the task in one call.', switchBtn('Close on approval', false, 'id="bClose"'))}
          ${twRow('Coordinator may review', 'For small teams without a separate reviewer.', switchBtn('Coordinator may review', false, 'id="bCoord"'))}
          ${twRow('Hourly limits', 'Optional; the team pauses when one is hit.', `<div class="row">${lim.map(([k, l]) => `<input class="inp sm w-num" data-lim="${k}" type="number" min="1" placeholder="${l}" aria-label="${l}">`).join('')}</div>`)}
        </div>`)}
        <div class="actionbar"><button class="btn pri lg" id="bGo">${ic('team')}Create team</button></div>
      </div></div>`,
    after() {
      draw();
      const tog = (b) => (b.onclick = () => flipSwitch(b));
      ['#bMsg', '#bCp', '#bClose', '#bCoord'].forEach((id) => tog($(id)));
      $$('#bMode button').forEach((b) => (b.onclick = () => $$('#bMode button').forEach((x) => x.classList.toggle('on', x === b))));
      $('#bQ').oninput = () => { B.q = $('#bQ').value.trim().toLowerCase(); draw(); };
      $('#bM').onchange = (e) => {
        const member = e.target.closest('.bm'); if (!member) return;
        const aid = member.dataset.a;
        if (e.target.type === 'checkbox') { if (e.target.checked) B.sel.set(aid, B.sel.size ? 'worker' : 'coordinator'); else B.sel.delete(aid); }
        else if (e.target.classList.contains('bm-role')) B.sel.set(aid, e.target.value);
        draw();
      };
      $('#nnGo').onclick = () => run(async () => {
        const label = $('#nnL').value.trim(); if (!label) { $('#nnL').focus(); return toast('Name the agent', true); }
        const project = $('#nnP').value.trim() || $('#bN').value.trim() || null;
        const res = await post('/keys', { kind: 'session_key', new_agent: { label, project }, label: `${label} key`, template_id: $('#nnT').value || null, expires_at: Date.now() + 30 * 864e5 });
        await refresh();
        B.sel.set(res.key.agent_id, $('#nnR').value);
        $('#nnOut').innerHTML = vnote(`<b>${esc(label)}</b> was created and added. Give it this handoff once; the key is not shown again.`) + codeBox(res.handoff || res.secret, true);
        $('#nnL').value = ''; draw();
      });
      $('#bGo').onclick = () => run(async () => {
        const name = $('#bN').value.trim(), goal = $('#bG').value.trim();
        if (!name) { $('#bN').focus(); return toast('Name the team', true); }
        if (!goal) { $('#bG').focus(); return toast('Give the team a goal', true); }
        const members = [...B.sel].map(([aid, role]) => { const ck = keyOf(aid); return { agent_id: aid, role, ...(ck ? { credential_id: ck.id } : {}) }; });
        if (!members.some((m) => m.role === 'coordinator')) return toast('A team needs a coordinator', true);
        const limits = {}; $$('[data-lim]').forEach((i) => { if (+i.value > 0) limits[i.dataset.lim] = Math.floor(+i.value); });
        const r = await post('/teams', { name, goal, members, grant_messaging: $('#bMsg').classList.contains('on'), ...(Object.keys(limits).length ? { limits } : {}), ...($('#bCp').classList.contains('on') ? { checkpoints: ['done'] } : {}) });
        const mode = $('#bMode button.on')?.dataset.mode || 'poll', close = $('#bClose').classList.contains('on'), coord = $('#bCoord').classList.contains('on');
        if (mode !== 'poll' || close || coord) await api('/teams/' + r.team.id, 'PATCH', { delivery_mode: mode, close_on_approve: close, coordinator_reviews: coord });
        await refresh(); openD('team', r.team.id, false, true);
      });
    },
  };
};

/* ---------- conversations ---------- */
const convRow = (c) => {
  const direct = c.kind === 'direct', nm = c.name || c.id, last = c.last_message ? trunc(c.last_message.content.replace(/\s+/g, ' '), 90) : 'No messages yet';
  return row({ lead: `<span class="av lg">${direct ? ic('user') : esc(initials(String(nm).replace(/^Team:\s*/, '')))}</span>`, title: nm, meta: last, trail: `<span>${ago(c.last_message?.created_at || c.created_at)}</span>`, attrs: { 'data-room': c.id } });
};
VIEWS.chats = async () => {
  S.convs = (await api('/conversations')).conversations;
  const KINDS = [['', 'All chats'], ['direct', 'Direct'], ['group', 'Group']];
  return {
    t: `${ic('chat')}Chats <span class="n">${S.convs.length}</span>`,
    b: `<div class="vtools"><div class="srch">${ic('search')}<input class="inp" id="cQ" aria-label="Search" placeholder="Search" autocomplete="off"></div>
      <select class="sel only-d" id="chatKind" aria-label="Conversation type">${KINDS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
      <button type="button" class="btn ic only-m" id="chatFilter" aria-label="Filter chats" aria-haspopup="dialog">${ic('sl')}</button></div><div class="pcard" id="cL"></div>`,
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
        list.innerHTML = r.filter(m => byId.has(m.room_id)).map(m => row({ lead: `<span class="av lg">${ic('chat')}</span>`, title: byId.get(m.room_id).name || m.room_id, meta: `${agLabel(m.from)}: ${trunc(m.content.replace(/\s+/g, ' '), 100)}`, trail: `<span>${ago(m.created_at)}</span>`, attrs: { 'data-room': m.room_id } })).join('') || empty;
      };
      search.oninput = () => { ++request; clearTimeout(timer); timer = setTimeout(() => run(draw), 300); };
      kind.onchange = () => { clearTimeout(timer); $('#chatFilter').classList.toggle('on', !!kind.value); run(draw); };
      // Phones: the type filter is one button that opens a sheet (the select stays the single source of truth).
      $('#chatFilter').onclick = (e) => {
        const sh = openSheet({ title: 'Show', anchor: e.currentTarget, html: `<div class="sheet-list">${KINDS.map(([v, l]) => row({ one: true, title: l, trail: kind.value === v ? ic('check') : '', attrs: { 'data-kind': v } })).join('')}</div>` });
        sh.addEventListener('click', (ev) => { const b = ev.target.closest('[data-kind]'); if (!b) return; kind.value = b.dataset.kind; closeSheet(); kind.onchange(); });
      };
      draw();
    },
  };
};

const RM_ = { id: null, msgs: new Map(), room: null, more: false, before: null, last: 0, polling: false };
/* Phones show the thread as part of the page (no inner scroll box), so "at the bottom" and "stay at the bottom" use the window there. */
const rmPaged = (L) => getComputedStyle(L).overflowY === 'visible';
const rmNear = (L) => (rmPaged(L) ? document.documentElement.scrollHeight - scrollY - innerHeight < 120 : L.scrollHeight - L.scrollTop - L.clientHeight < 80);
const rmStick = (L) => { if (rmPaged(L)) window.scrollTo(0, document.documentElement.scrollHeight); else L.scrollTop = L.scrollHeight; };
const msgH = (m) => { const nm = RM_.room?.members.find((x) => x.agent_id === m.from)?.label || agLabel(m.from);
  return `<div class="msg${m.from === 'hub' ? ' hub' : ''}"><div class="mh"><b>${esc(nm)}</b>${m.kind !== 'text' ? `<span class="tag">${esc(m.kind)}</span>` : ''}<span class="mt">${esc(dt(m.created_at))}</span></div><div class="mb">${m.redacted ? ic('ban') : esc(m.content)}</div></div>`; };
function drawRoom(stick) {
  const L = $('#rmL'); if (!L) return;
  const near = stick || rmNear(L);
  const ms = [...RM_.msgs.values()].sort((a, b) => a.seq - b.seq);
  RM_.last = ms.length ? ms.at(-1).seq : 0;
  L.innerHTML = (RM_.more ? `<button class="btn sm self-center" id="rmMore" aria-label="Older">${ic('up')}</button>` : '') + (ms.map(msgH).join('') || none('chat', 'No messages'));
  if (near) rmStick(L);
  const mo = $('#rmMore'); if (mo) mo.onclick = () => run(async () => {
    const r = await api(`/conversations/${encodeURIComponent(RM_.id)}/messages?limit=50&before=${encodeURIComponent(RM_.before)}`); r.messages.forEach((m) => RM_.msgs.set(m.seq, m)); RM_.more = r.more; RM_.before = r.next_before;
    const paged = rmPaged(L), h = paged ? document.documentElement.scrollHeight : L.scrollHeight, y = scrollY; drawRoom(false);
    if (paged) window.scrollTo(0, y + document.documentElement.scrollHeight - h); else L.scrollTop = L.scrollHeight - h;
  });
}
/* Each poll appends only messages newer than the last one drawn, so the chat is not rebuilt (which would also clear
   the reader's text selection), and skips its turn while the previous poll is still out. */
async function pollRoom() {
  if (DR.type !== 'room' || document.hidden || RM_.polling) return;
  RM_.polling = true;
  try {
    const id = DR.arg, r = await api(`/conversations/${encodeURIComponent(id)}/messages?limit=50`); if (RM_.id !== id || DR.arg !== id) return;
    const fresh = r.messages.filter((m) => !RM_.msgs.has(m.seq)).sort((a, b) => a.seq - b.seq);
    r.messages.forEach((m) => RM_.msgs.set(m.seq, m)); RM_.room = r.room;
    const L = $('#rmL'); if (!L) return;
    if (fresh.length && fresh[0].seq < RM_.last) { drawRoom(false); return; } // older than what is shown: redraw in order
    if (fresh.length) {
      const near = rmNear(L);
      $('.empty', L)?.remove();
      L.insertAdjacentHTML('beforeend', fresh.map(msgH).join(''));
      RM_.last = fresh.at(-1).seq;
      if (near) rmStick(L);
    }
  } catch { /* ignore */ } finally { RM_.polling = false; }
}
setInterval(pollRoom, 3000);
VIEWS.room = async (id) => {
  const r = await api(`/conversations/${encodeURIComponent(id)}/messages?limit=50`);
  Object.assign(RM_, { id, msgs: new Map(r.messages.map((m) => [m.seq, m])), room: r.room, more: r.more, before: r.next_before });
  const href = `/api/conversations/${encodeURIComponent(id)}/export`, mem = r.room.members, nMem = mem.length;
  const exportRoom = () => { const a = document.createElement('a'); a.href = href; a.download = ''; document.body.append(a); a.click(); a.remove(); };
  return {
    t: `${ic(r.room.kind === 'direct' ? 'user' : 'team')}<span class="ellip">${esc(r.room.name || id)}</span><span class="n">${r.room.message_count}</span>`,
    a: `<a class="btn sm" href="${href}" download>${ic('dl')}Export</a>`,
    dbar: { title: r.room.name || id, meta: `${r.room.message_count} message${r.room.message_count === 1 ? '' : 's'} · ${nMem} member${nMem === 1 ? '' : 's'}`, menu: [{ label: 'Export', icon: 'dl', fn: exportRoom }] },
    b: `<div class="rm-mem"><span class="avs">${mem.map((m) => m.agent_id ? `<button type="button" class="av" data-ses="${esc(m.agent_id)}" title="${esc(m.label || m.agent_id)}" aria-label="${esc(m.label || m.agent_id)}">${esc(initials(m.label || m.agent_id))}</button>` : `<span class="av" title="${esc(m.label || '')}">${esc(initials(m.label || '?'))}</span>`).join('')}</span><span class="meta rm-names">${esc(mem.map((m) => m.label || m.agent_id).join(', '))}</span></div><div class="msgs" id="rmL"></div>`,
    after() { drawRoom(true); requestAnimationFrame(() => { const L = $('#rmL'); if (L) rmStick(L); }); },
  };
};

/* ---------- Security → Reset: remove hub data by part ---------- */
/* What each table holds, in words, and where it can be inspected before it is removed. */
const RS_TABLE = {
  tool_invocations: ['Tool calls', 'log', 'calls'], security_alerts: ['Alerts', 'log', 'alerts'], authentication_events: ['Sign-in events', 'log', 'audit'],
  resource_access_events: ['File reads and denials', 'vault', 'act'], usage_counters: ['Rate-limit counters'],
  rooms: ['Chats and rooms', 'chats'], room_memberships: ['Room memberships', 'chats'], messages: ['Messages', 'chats'], message_delivery_cursors: ['Read positions'],
  teams: ['Teams', 'teams'], team_members: ['Team members', 'teams'], team_roles: ['Team playbooks', 'teams'], tasks: ['Tasks', 'teams'], task_events: ['Task history', 'teams'],
  work_items: ['Queued work items'], team_status_reports: ['Team status reports', 'teams'],
  agents: ['Agents', 'sessions'], credentials: ['Keys', 'keys'], session_tokens: ['Logins', 'sessions'], agent_links: ['Agent links', 'sessions'], agent_notices: ['Notices to agents', 'sessions'],
  access_requests: ['Access requests', 'req'], temporary_grants: ['Temporary grants', 'req'], permission_policies: ['Key permissions', 'keys'], permission_rules: ['Permission rules', 'keys'], policy_versions: ['Permission history', 'keys'],
  machines: ['PCs', 'pcs'], machine_folders: ['Approved PC folders', 'pcs'], bridge_keys: ['Bridge pairings', 'pcs'], setup_keys: ['PC setup codes', 'pcs'],
  shares: ['Shares', 'shares'], share_versions: ['Share versions', 'shares'], share_recipients: ['Share recipients', 'shares'], share_feedback: ['Share feedback', 'shares'], share_promotions: ['Share promotions', 'shares'], data_channels: ['Transfer channels', 'shares'],
  files: ['Vault file index', 'vault'], file_revisions: ['File revisions', 'log', 'files'], file_conflicts: ['File conflicts', 'vault', 'conf'], write_intents: ['Pending writes'],
  system_settings: ['Settings (vault state or lockdown switches)', 'lock'],
  feedback_reports: ['Agent feedback reports', 'feedback'], feedback_entries: ['Feedback entries'], feedback_links: ['Feedback links'], feedback_calls: ['Feedback evidence'], feedback_history: ['Feedback history'], feedback_requests: ['Feedback retries'], feedback_hints: ['Feedback hints'],
};
VIEWS.reset = async () => {
  const [{ parts }, { plan: full }] = await Promise.all([api('/reset/parts'), api('/reset/plan?parts=all')]);
  const rows = Object.fromEntries(full.byPart.map((p) => [p.key, p.rows]));
  const picked = new Set();
  // A part: checkbox lead, name (the label toggles it), record count and an info button with what it removes.
  const part = (key, label, detail, n) => row({ as: 'div', one: true, cls: 'rs-row', lead: `<input type="checkbox" id="rs_${esc(key)}" data-part="${esc(key)}" aria-label="Select ${esc(label)}">`,
    title: raw(`<label for="rs_${esc(key)}">${esc(label)}</label>`), trail: `<span class="rs-n">${n.toLocaleString()}</span>${info(detail)}` });
  return {
    t: `${ic('rot')}Reset`,
    b: `<div class="pcard"><div class="overline rs-caution">${ic('warn')}<span>Removes hub data</span>${info('The audit trail, admin accounts and the notes on disk are always kept. Every reset is recorded in the audit trail.')}</div>
      <div id="rsGrid">${parts.map((p) => part(p.key, p.label, p.detail, rows[p.key] || 0)).join('')}${part('all', 'Everything', 'All parts above. The hub starts empty with your admin login.', full.total)}</div></div>
      <button type="button" class="btn lg rs-open" id="rsOpen" disabled>${ic('trash')}Reset selected…</button>`,
    after() {
      const label = (k) => (parts.find((p) => p.key === k) || { label: 'Other linked records' }).label;
      const sync = () => {
        $$('#rsGrid [data-part]').forEach((x) => { x.checked = x.dataset.part === 'all' ? picked.size === parts.length : picked.has(x.dataset.part); });
        const n = picked.size; $('#rsOpen').disabled = !n; $('#rsOpen').lastChild.textContent = n ? `Reset ${n} part${n === 1 ? '' : 's'}…` : 'Reset selected…';
      };
      $('#rsGrid').onchange = (e) => {
        const b = e.target.closest('[data-part]'); if (!b) return;
        const k = b.dataset.part;
        if (k === 'all') { picked.clear(); if (b.checked) parts.forEach((p) => picked.add(p.key)); }
        else if (b.checked) picked.add(k); else picked.delete(k);
        sync();
      };
      // The confirmation lives in a sheet: what will be removed, the typed word, the password, the two-factor code, then Cancel or Reset.
      $('#rsOpen').onclick = (ev) => {
        const n = picked.size; if (!n) return;
        const sh = openSheet({ title: `Reset ${n} part${n === 1 ? '' : 's'}?`, anchor: ev.currentTarget, html: `<div class="sheet-form">
          <div id="rsPlan" class="rs-plan"><span class="faint">Counting records…</span></div>
          <label class="fld"><span class="vlabel">Type RESET to confirm</span><input class="inp mono" id="rsWord" autocomplete="off" spellcheck="false"></label>
          <label class="fld"><span class="vlabel">Your password</span><input class="inp" id="rsPw" type="password" autocomplete="current-password"></label>
          ${S.me.totp_enrolled ? '<label class="fld"><span class="vlabel">Two-factor code</span><input class="inp mono" id="rsCode" inputmode="numeric" maxlength="6" autocomplete="one-time-code"></label>' : ''}
          <span class="err" id="rsErr" role="alert"></span>
          <div class="sheet-acts"><button type="button" class="btn lg" data-sheet-close>Cancel</button><button type="button" class="btn bad lg" id="rsGo" disabled>${ic('trash')}Reset</button></div></div>` });
        const ready = () => { $('#rsGo', sh).disabled = !($('#rsWord', sh).value === 'RESET' && $('#rsPw', sh).value && (!$('#rsCode', sh) || $('#rsCode', sh).value.length === 6)); };
        ['#rsWord', '#rsPw', '#rsCode'].forEach((id) => { const el = $(id, sh); if (el) el.oninput = ready; });
        api('/reset/plan?parts=' + [...picked].join(',')).then(({ plan }) => {
          if (!sh.isConnected) return;
          $('#rsPlan', sh).innerHTML = `<div class="rs-sum"><b>${plan.total.toLocaleString()}</b> records will be removed${plan.total ? '' : ' (nothing to remove)'}</div>
            <div class="rs-parts">${plan.byPart.filter((p) => p.rows).map((p) => {
              const rows = (plan.byTable || []).filter((x) => x.part === p.key);
              return `<details class="rs-part-d"><summary>${ic('chev')}<b>${esc(p.label)}</b><span class="tag${p.selected ? '' : ' pend'}">${p.rows.toLocaleString()}</span>${p.selected ? '' : '<small>depends on your selection</small>'}</summary>
                <ul>${rows.map((x) => { const [name, go, arg] = RS_TABLE[x.table] || [x.table.replace(/_/g, ' ')]; return `<li><span>${esc(name)}</span><b>${x.rows.toLocaleString()}</b>${go ? `<button class="btn sm" data-go="${go}"${arg ? ` data-arg="${arg}"` : ''}>${ic('eye')}View</button>` : '<span></span>'}</li>`; }).join('')}</ul></details>`;
            }).join('')}</div>
            ${plan.implied.length ? `<p class="rs-warn">${ic('warn')}<span>Also removes records in <b>${plan.implied.map((k) => esc(label(k))).join(', ')}</b>, because they depend on what you selected.</span></p>` : ''}`;
        }, () => { if (sh.isConnected) $('#rsPlan', sh).innerHTML = '<span class="err">Could not count the records.</span>'; });
        $('#rsGo', sh).onclick = () => run(async () => {
          $('#rsErr', sh).textContent = '';
          let r;
          try { r = await post('/reset', { parts: [...picked], confirm: $('#rsWord', sh).value, password: $('#rsPw', sh).value, ...($('#rsCode', sh) ? { totp: $('#rsCode', sh).value } : {}) }); }
          catch (e) { $('#rsErr', sh).textContent = e.message; $('#rsPw', sh).value = ''; ready(); return; }
          closeSheet();
          toast(`Removed ${r.result.total.toLocaleString()} records`);
          if (!r.restart) { await refresh(); openD('reset', null, true); return; }
          // A deployed hub restarts itself so nothing cached in memory survives; wait for it, then reload.
          $('#dB').innerHTML = `<div class="rs-restart">${ic('rot')}<b>Restarting the hub</b><small>Removed ${r.result.total.toLocaleString()} records. This page reloads when the hub is back.</small></div>`;
          await new Promise((ok) => setTimeout(ok, 1500));
          for (let i = 0; i < 60; i++) {
            try { if ((await fetch('/health', { cache: 'no-store' })).ok) { location.reload(); return; } } catch { /* still restarting */ }
            await new Promise((ok) => setTimeout(ok, 1000));
          }
          $('#dB').innerHTML = none('warn', 'The hub did not come back. Check the service.');
        });
      };
    },
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
  m.innerHTML = `<div class="me-head"><span class="av lg">${esc((me.username[0] || 'A').toUpperCase())}</span><span><b>${esc(me.username)}</b><small>Administrator</small></span></div>
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
/* Phone overflow: Lockdown, two-factor, theme and sign-out in one labelled sheet (the app bar keeps only the clock and this button). */
function openMore(btn) {
  if (PAGE_MENU.length) return openMenu([{ heading: AREA_TITLE[areaOf(DR.type)] || 'Screen' }, ...PAGE_MENU, ...hubMenu()], btn);
  const me = S.me, dark = document.documentElement.dataset.theme === 'dark';
  const item = (mi, icon, label, val = '', cls = '') => `<button type="button" class="sheet-item${cls ? ' ' + cls : ''}" data-mi="${mi}">${ic(icon)}<span>${label}</span>${val ? `<span class="sheet-val">${val}</span>` : ''}</button>`;
  openSheet({ title: me.username, anchor: btn, html: `<div class="sheet-list">${item('lock', 'lock', 'Lockdown', '', '')}${item('account', 'shield', 'Two-factor', me.totp_enrolled ? 'On' : 'Set up ›')}${item('theme', dark ? 'moon' : 'sun', 'Theme', dark ? 'Dark' : 'Light')}${item('out', 'out', 'Sign out', '', 'bad')}</div>` });
}
$('#moreBtn').addEventListener('click', (e) => openMore(e.currentTarget));
$('#meMenu').addEventListener('keydown', (e) => {
  const items = $$('#meMenu [role=menuitem]'), i = items.indexOf(document.activeElement);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus(); }
});

/* ---------- login / boot ---------- */
function showLogin() {
  closeSheet();
  // An expired session: forget it so refresh() stops, and focus the user field only when the form first appears,
  // not on every failing request (someone typing a password would end up typing it into the visible user field).
  const shown = !$('#login').hidden;
  S.me = null; csrf = '';
  $('#login').hidden = false; $('#app').hidden = true; $('.side').style.display = 'none'; $('.bnav').style.display = 'none';
  $('#overview').dataset.mode = 'home';
  closeD();
  if (!shown) setTimeout(() => $('#lu').focus(), 30);
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
const stPill = (s) => `<span class="pill ${{ open: 'p-live', done: 'p-live', approved: 'p-live', partially_approved: 'p-live', closed: 'p-idle', revoked: 'p-susp', denied: 'p-susp', failed: 'p-susp', expired: 'p-idle', withdrawn: 'p-idle', offered: 'p-block', pending: 'p-block' }[s] || 'p-idle'}">${esc(cap(s.replace(/_/g, ' ')))}</span>`;
const reopen = () => DR.type && openD(DR.type, DR.arg, true);

/* The things that need an operator now, most urgent first. msg is plain prose; btns are the labelled actions of the Home alert card
   (the first is the primary one). Every action keeps its existing data-* handler. */
const bt = (label, attrs, cls = '') => `<button class="btn${cls ? ' ' + cls : ''}" ${attrs}>${esc(label)}</button>`;
function urgent() {
  const L = openAlerts().map((a) => {
    const t = atype(a), s = SEV[a.severity], k = K(a.subject), d = det(a), tm = alertTeam(a, d), ag = AG(a.subject);
    const open = k ? bt('Open', `data-key="${esc(k.id)}"`, 'pri') : tm ? bt('Open', `data-team="${esc(tm.id)}"`, 'pri') : ag ? bt('Open', `data-ses="${esc(ag.id)}"`, 'pri') : bt('Open', 'data-go="log" data-arg="alerts"', 'pri');
    const approve = a.type === 'checkpoint' && tm ? bt('Approve', `data-appr="${esc(tm.id)}|${esc(a.subject)}"`) : a.status === 'open' ? bt('Acknowledge', `data-act="ack|${esc(a.id)}"`) : '';
    return { id: a.id, s, r: s === 'crit' ? 0 : s === 'warn' ? 2 : 4, ts: a.created_at, ico: t[1], ttl: cap(t[0]), tag: tm ? tm.name : k ? keyName(k) : ag ? ag.label : '', msg: String(d.message || d.task || d.tool || d.metric || a.type).replace(/_/g, ' '), btns: open + approve + (a.status === 'open' ? bt('Close', `data-act="close|${esc(a.id)}"`) : '') };
  });
  for (const q of S.reqs) L.push({ id: q.id, s: 'warn', r: 1, ts: q.created_at, ico: 'key', ttl: 'Access request', tag: q.agent_label || trunc(q.agent_id, 12), msg: `Asks to ${q.actions.join(', ')} on ${q.resource}`, btns: bt('Open', 'data-go="req"', 'pri') + bt('Approve', `data-act="rqok|${esc(q.id)}"`) + bt('Deny', `data-act="rqno|${esc(q.id)}"`) });
  for (const d of S.dec || []) L.push({ id: d.id, s: 'warn', r: 1, ts: d.created_at, ico: 'chat', ttl: d.status === 'needs_info' ? 'Question · waiting for the agent' : 'Question for you', tag: d.team_name || '', msg: `${d.agent_label || agLabel(d.agent_id)}: ${d.question}`, btns: bt('Answer', `data-dec="${esc(d.id)}"`, 'pri') });
  if (S.dirU) L.push({ id: 'dirU', s: 'info', r: 4, ts: 0, ico: 'sl', ttl: 'Directives to review', tag: '', msg: `${fbPlural(S.dirU, 'rule', 'rules')} agents registered are in force and wait for your review.`, btns: bt('Review', 'data-go="directives"', 'pri') });
  for (const u of S.fbc?.urgent || []) L.push({ id: u.id, s: 'warn', r: 2, ts: u.last_seen_at, ico: 'warn', ttl: 'Blocking feedback', tag: u.tool || u.area, msg: `${u.agents} agents report this blocks their work: ${u.title}`, btns: bt('Open', `data-fb="${esc(u.id)}"`, 'pri') });
  for (const c of S.conf) L.push({ id: c.id, s: 'warn', r: 3, ts: c.created_at, ico: 'note', ttl: 'Vault conflict', tag: c.agent_label || c.source || '', msg: c.path, btns: bt('Open', 'data-go="vault" data-arg="conf"', 'pri') });
  if (!openAlerts().some((a) => a.type === 'stalled_member' || a.type === 'task_blocked')) {
    for (const t of S.teams) { const bl = t.counts?.blocked || 0; if (t.stalled || bl) L.push({ id: 'tm' + t.id, s: 'warn', r: 3, ts: t.updated_at, ico: bl ? 'warn' : 'clock', ttl: bl ? 'Task blocked' : 'Member stalled', tag: t.name, msg: bl ? `${bl} blocked task${bl === 1 ? '' : 's'}` : `${t.stalled} stalled member${t.stalled === 1 ? '' : 's'}`, btns: bt('Open', `data-team="${esc(t.id)}"`, 'pri') }); }
  }
  return L.sort((a, b) => a.r - b.r || b.ts - a.ts);
}
/* Home: the most urgent item as an alert card (a banner on desktop); any others collapse to one row that opens Audit → Alerts. */
function renderAlerts(full = true) {
  // Two-factor enrolment (an account setting, not an alert: it sits next to Lockdown, or in the phone overflow) and the
  // request badges are outside the overview, so they update even while it is hidden.
  const pending2fa = !!(S.me && !S.me.totp_enrolled);
  $('#enrol2fa').hidden = !pending2fa; $('#moreDot').hidden = !pending2fa;
  $$('[data-request-badge]').forEach(badge => { badge.hidden = !S.reqs.length; });
  const newFb = S.fbc?.new || 0;
  $$('[data-feedback-badge]').forEach((badge) => { badge.hidden = !newFb; badge.title = newFb ? fbPlural(newFb, 'new feedback report', 'new feedback reports') : ''; });
  const openDec = (S.dec || []).length, openDrp = S.dirU || 0, workTip = [openDec ? fbPlural(openDec, 'question for you', 'questions for you') : '', newFb ? fbPlural(newFb, 'new feedback report', 'new feedback reports') : '', openDrp ? fbPlural(openDrp, 'directive to review', 'directives to review') : ''].filter(Boolean).join(' · ');
  $$('[data-dir-badge]').forEach((badge) => { badge.hidden = !openDrp; badge.title = openDrp ? fbPlural(openDrp, 'directive to review', 'directives to review') : ''; });
  $$('[data-work-badge]').forEach((badge) => { badge.hidden = !workTip; badge.title = workTip; });
  $$('[data-alert-count]').forEach((n) => { n.textContent = S.alerts.length || ''; });
  if (!full) return;
  const L = urgent(), a = L[0], box = $('#ovAlert');
  box.hidden = !a;
  box.innerHTML = !a ? '' : `<div class="alert${a.s === 'crit' ? ' bad' : a.s === 'info' ? ' info' : ''}" role="group" aria-label="Most urgent"><div class="alert-hd"><span class="alert-ico">${ic(a.ico)}</span><span class="alert-title">${esc(a.ttl)}</span>${a.tag ? `<span class="tag">${esc(trunc(a.tag, 28))}</span>` : ''}</div><p class="alert-msg">${esc(a.msg)}</p><div class="alert-acts">${a.btns}</div></div>`
    + (L.length > 1 ? `<div class="card card-row">${row({ title: `${L.length - 1} more alert${L.length === 2 ? '' : 's'}`, one: true, chev: true, attrs: { 'data-go': 'log', 'data-arg': 'alerts' } })}</div>` : '');
}

const keyAgentOf = (id) => K(id)?.agent_id || null;
const subjName = (id) => { if (!id) return '—'; const k = K(id); if (k) return keyName(k); const a = AG(id); if (a) return a.label; const t = S.teams.find((x) => x.id === id); return t ? t.name : trunc(id, 18); };
const dayLabel = (t) => { const d = new Date(t), n = new Date(), y = new Date(Date.now() - 864e5); return d.toDateString() === n.toDateString() ? 'Today' : d.toDateString() === y.toDateString() ? 'Yesterday' : d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }); };
const byDay = (rows, at, render) => { let cur = '', out = ''; for (const r of rows) { const d = dayLabel(at(r)); if (d !== cur) { cur = d; out += `<h5 class="subh day">${esc(d)}</h5>`; } out += render(r); } return out; };
const clock = (t) => new Date(t).toTimeString().slice(0, 5);
/* Ids inside details and arguments read as names where the console knows them. */
const idName = (v) => { const str = String(v); const a = AG(str); if (a) return a.label; const k = K(str); if (k) return keyName(k); const t = S.teams.find((x) => x.id === str); return t ? t.name : str; };
const NOISE = new Set(['session_token', 'client_msg_id', 'repeats', 'last_seen_at']);

/* References inside audit records become links to the panel that owns them. */
const tplOf = (pid) => S.tpl.find((t) => t.id === pid);
const keyOfPolicy = (pid) => S.keys.find((k) => k.policy_id === pid);
const vaultFileLink = (p, label) => `<a href="#" data-vf="${esc(p)}" title="${esc(p)}">${esc(label || p.split('/').pop())}</a>`;
function refLink(v) {
  const s = String(v);
  if (/^agent-/.test(s)) return AG(s) ? `<a href="#" data-ses="${esc(s)}">${esc(agLabel(s))}</a>` : `<span class="mono">${esc(s)}</span>`;
  if (/^crd_/.test(s)) { const k = K(s); return k ? `<a href="#" data-key="${esc(s)}">${esc(keyName(k))}</a>` : '<span class="faint">removed key</span>'; }
  if (/^team_/.test(s)) { const t = S.teams.find((x) => x.id === s); return t ? `<a href="#" data-team="${esc(s)}">${esc(t.name)}</a>` : `<span class="mono">${esc(trunc(s, 18))}</span>`; }
  if (/^team:team_/.test(s)) return 'team ' + refLink(s.slice(5));
  if (/^pol_/.test(s)) { const k = keyOfPolicy(s), t = tplOf(s); return k ? `<a href="#" data-key="${esc(k.id)}|rules">${esc(keyName(k))} rules</a>` : t ? `template <b>${esc(t.name)}</b>` : `<span class="mono">${esc(s)}</span>`; }
  if (/^pc-/.test(s)) return PC(s) ? `<a href="#" data-go="pcs">${esc(PC(s).name)}</a>` : `<span class="mono">${esc(s)}</span>`;
  if (/^path:\/[^*]*$/.test(s)) return vaultFileLink(s.slice(5), s.slice(5));
  if (/^path:\//.test(s)) return `<span class="mono" title="${esc(s.slice(5))}">${esc(trunc(s.slice(5), 60))}</span>`;
  return null;
}
const AF_LABEL = { agent: 'agent', agent_id: 'agent', credential_id: 'key', from: 'from', to: 'to', kind: 'kind', role: 'role', label: 'label', project: 'project', note: 'note', rules: 'rules', version: 'version', members: 'members', name: 'name', resource: 'resource', actions: 'actions', seconds: 'for', grant: 'grant', parts: 'parts', rows: 'records', stall_minutes: 'stall timer' };
const AF_SKIP = new Set([...NOISE, 'tokens', 'implied', 'blobs', 'by_part', 'partial', 'grant']);
/* Fields the object column already shows, per target kind. */
const AF_IN_TARGET = { link: ['from', 'to'], access_request: ['resource'], team: ['name'], credential: ['label'], agent: ['label'], pc: ['name'], admin: ['username'] };
const dur = (s) => (s >= 86400 ? Math.round(s / 86400) + ' d' : s >= 3600 ? Math.round(s / 3600) + ' h' : s >= 60 ? Math.round(s / 60) + ' min' : s + ' s');
const afVal = (k, v) => {
  if (Array.isArray(v)) return esc(v.map(String).join(', '));
  if (k === 'seconds') return esc(dur(+v));
  if (k === 'stall_minutes') return esc(dur(+v * 60));
  return refLink(v) ?? `<span title="${esc(String(v))}">${esc(trunc(String(v), 90))}</span>`;
};
/* An audit record's details as "label value" pairs; before/after objects collapse to the fields that changed. */
function auditFields(e, details) {
  const d = details || {}, out = [];
  if (d.before && d.after && typeof d.before === 'object') {
    for (const f of new Set([...Object.keys(d.before), ...Object.keys(d.after)])) {
      const a = d.before[f], b = d.after[f];
      if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) out.push([f.replace(/_/g, ' '), `<span class="faint">${esc(trunc(String(a ?? '—'), 40))}</span> → ${esc(trunc(String(b ?? '—'), 90))}`]);
    }
  }
  const shown = AF_IN_TARGET[e.target_kind] || [];
  for (const [k, v] of Object.entries(d)) {
    if (shown.includes(k)) continue;
    if (AF_SKIP.has(k) || k === 'before' || k === 'after' || v === null || v === '' || (typeof v === 'object' && !Array.isArray(v))) continue;
    if (e.target_kind === 'policy' && k === 'rules') { const kk = keyOfPolicy(e.target_id); out.push(['rules', kk ? `<a href="#" data-key="${esc(kk.id)}|rules">${esc(v)} rules</a>` : esc(v)]); continue; }
    out.push([AF_LABEL[k] || k.replace(/_/g, ' '), afVal(k, v)]);
  }
  return out.map(([l, h]) => `<span class="af"><i>${esc(l)}</i>${h}</span>`).join('');
}

/* What each alert type means, in plain words, and which actions help. who/agent/team are resolved names. */
function alertInfo(a) {
  const d = det(a), k = K(a.subject), agentId = d.agent || k?.agent_id || (AG(a.subject) ? a.subject : null);
  const agent = agentId ? agLabel(agentId) : null, team = alertTeam(a, d);
  const keyActs = () => k ? [['Open key', 'key', `data-key="${esc(k.id)}"`], ...(k.effective_status === 'active' ? [['Suspend key', 'pause', `data-act="asusp|${esc(a.id)}"`, 'bad']] : [])] : [];
  const calls = k ? [['View calls', 'bolt', `data-go="log" data-arg="calls|${esc(k.id)}"`]] : agentId ? [['View calls', 'bolt', `data-go="log" data-arg="calls|agent:${esc(agentId)}"`]] : [];
  const who = agent || subjName(a.subject);
  const M = {
    key_in_payload: ['Key leaked in a call', `${who} sent a secret (${d.kind || 'key'}) in ${d.tool || 'a tool call'}${d.field ? ' · field ' + d.field : ''}. The call was blocked and the key suspended. Rotate it before reuse.`, [...keyActs(), ...calls]],
    key_in_result: ['Secret withheld from output', `${d.tool || 'A tool'} would have returned a secret${d.kind ? ' (' + d.kind + ')' : ''} to ${who}. It was withheld. Find and remove it at the source.`, [...keyActs()]],
    repeated_denials: ['Repeated denials', `${who} was denied ${d.count || 'several'} times in ${d.window_minutes || '?'} min${d.last_tool ? ' · last tool ' + d.last_tool : ''}. Either it needs access or it is probing.`, [...calls, ...keyActs()]],
    forbidden_path: ['Forbidden path', `${who} tried ${d.tool || 'a tool'} outside its grants${d.error ? ' (' + d.error + ')' : ''}.`, [...calls, ...keyActs()]],
    unusual_volume: ['Unusual volume', `${who}: ${d.count_this_hour} ${d.kind || 'calls'} this hour vs a baseline of ${d.hourly_baseline} (limit ${d.limit}).`, [...calls, ...keyActs()]],
    login_burst: ['Login burst', `${d.count} failed logins in ${d.window_minutes} min from ${a.subject || 'an unknown source'}${d.last_subject ? ' · last ' + d.last_subject : ''}.`, [['View audit', 'log', `data-go="log" data-arg="audit|${esc(a.subject || '')}"`]]],
    concurrent_use: ['Key used twice at once', `${who}'s session key logged in while another login was live. Two clients may share one key.`, [...keyActs(), ...(k ? [['End logins', 'out', `data-end-logins="${esc(k.id)}"`]] : [])]],
    quota_trip: ['Team limit reached', `${d.team || 'A team'} hit its ${String(d.metric || 'limit').replace(/_/g, ' ')} limit (${d.count}/${d.limit}).`, team ? [['Open team', 'team', `data-team="${esc(team.id)}"`]] : []],
    task_blocked: ['Task blocked', `"${d.task || 'A task'}" in ${d.team || 'a team'} is blocked${d.reason ? ': ' + d.reason : ''}.`, team ? [['Open team', 'team', `data-team="${esc(team.id)}"`]] : []],
    checkpoint: ['Approval needed', `"${d.task || 'A task'}" in ${d.team || 'a team'} is done and waits for your approval.`, team ? [['Approve', 'check', `data-appr="${esc(team.id)}|${esc(a.subject)}"`, 'ok'], ['Open team', 'team', `data-team="${esc(team.id)}"`]] : []],
    stalled_member: ['Member stalled', `${who} (${d.role || 'member'}) in ${d.team || 'a team'} has stopped making progress.`, [...(agentId ? [['Open agent', 'user', `data-ses="${esc(agentId)}"`]] : []), ...(team ? [['Open team', 'team', `data-team="${esc(team.id)}"`]] : [])]],
    recruit_request: ['Recruit request', `${d.team || 'A team'}'s coordinator asks to add "${d.agent}" as ${d.role}: ${d.purpose || ''}`, team ? [['Review on the team', 'team', `data-team="${esc(team.id)}"`]] : []],
    agent_recruited: ['Agent recruited', `${d.by || 'A coordinator'} added "${d.agent}" as ${d.role} to ${d.team || 'a team'}.`, [...(AG(a.subject) ? [['Open agent', 'user', `data-ses="${esc(a.subject)}"`]] : []), ...(team ? [['Open team', 'team', `data-team="${esc(team.id)}"`]] : [])]],
    task_overdue: ['Task overdue', `"${d.task}" in ${d.team || 'a team'} passed its check-in time; ${d.assignee || 'the assignee'} still holds it.`, team ? [['Open team', 'team', `data-team="${esc(team.id)}"`]] : []],
    vault_conflict: ['Vault conflict', `${d.path || 'A file'} changed outside the hub during a commit.`, [['Resolve', 'warn', `data-go="vault" data-arg="conf"`]]],
  };
  const [title, text, acts] = M[a.type] || [a.type.replace(/_/g, ' '), JSON.stringify(d).slice(0, 160), keyActs()];
  return { title, text, acts, who, repeats: d.repeats || 1, last: d.last_seen_at || a.updated_at || a.created_at };
}
/* Audit screens share one shape: tabs, ONE filter row (segment + Filters button opening a sheet), rows grouped by day.
   auTime is the fixed 48 px time column; auSheet opens the filter sheet with the screen's own fields. */
const auTime = (t) => `<time class="aud-t" title="${esc(new Date(t).toLocaleString())}">${clock(t)}</time>`;
const argText = (summary) => { if (!summary) return ''; try { return Object.entries(JSON.parse(summary) || {}).filter(([k, v]) => !NOISE.has(k) && v !== null && v !== '' && typeof v !== 'object').slice(0, 3).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${trunc(idName(v), 40)}`).join(', '); } catch { return trunc(summary, 80); } };
const segBtns = (items, cur, attr, count) => items.map(([v, l]) => `<button type="button" ${attr}="${esc(v)}" class="${v === cur ? 'on' : ''}">${esc(l)}${count && count(v) ? ` <span class="tabn">${count(v)}</span>` : ''}</button>`).join('');
const AL_STATUS = [['open', 'Open'], ['acknowledged', 'Acknowledged'], ['closed', 'Closed']];
const AL_SEV = [['critical', 'Critical'], ['warning', 'Warning'], ['info', 'Info']];
const AL_F = { status: 'open', sev: '', q: '' };
const alFilters = () => (AL_F.sev ? 1 : 0) + (AL_F.q ? 1 : 0) + (AL_F.status === '' ? 1 : 0);
async function auditAlerts() {
  const all = (await api('/alerts?limit=200')).alerts;
  const shown = () => all.filter((a) => (!AL_F.status || a.status === AL_F.status) && (!AL_F.sev || a.severity === AL_F.sev));
  // Alerts use the Home alert card: title, who, message (2 lines), then labelled actions (Open first). Handled ones are neutral.
  const card = (a) => {
    const i = alertInfo(a), s = SEV[a.severity], open = a.status === 'open';
    const tm = alertTeam(a, det(a)), tag = tm ? tm.name : i.who === '—' ? '' : i.who;
    const acts = i.acts.map(([l, , attr], n) => bt(l, attr, open && n === 0 ? 'pri' : '')).join('')
      + (open ? bt('Acknowledge', `data-act="ack|${esc(a.id)}"`) : '') + (a.status !== 'closed' ? bt('Close', `data-act="close|${esc(a.id)}"`) : '');
    return `<article class="alert${s === 'crit' ? ' bad' : s === 'info' ? ' info' : ''}${open ? '' : ' done'}" data-text="${esc((i.title + ' ' + i.text + ' ' + i.who).toLowerCase())}">
      <div class="alert-hd"><span class="alert-ico">${ic(atype(a)[1])}</span><span class="alert-title">${esc(i.title)}</span>${tag ? `<span class="tag">${esc(trunc(tag, 28))}</span>` : ''}${i.repeats > 1 ? `<span class="tag">×${esc(i.repeats)}</span>` : ''}${open ? '' : pill(a.status === 'closed' ? 'Closed' : 'Acknowledged', 'idle')}<span class="meta" title="${esc(new Date(a.created_at).toLocaleString())}">${ago(i.last)} ago</span></div>
      <p class="alert-msg">${esc(i.text)}</p>${acts ? `<div class="alert-acts">${acts}</div>` : ''}</article>`;
  };
  const cnt = (v) => all.filter((a) => a.status === v).length;
  const txtOf = (a) => { const i = alertInfo(a); return (i.title + ' ' + i.text + ' ' + i.who).toLowerCase(); };
  const draw = () => {
    const L = shown().filter((a) => !AL_F.q || txtOf(a).includes(AL_F.q));
    $('#alL').innerHTML = L.length ? L.map(card).join('') : none('bolt', AL_F.status === 'open' ? 'No open alerts' : 'No alerts');
    $('#alBulk').hidden = !L.some((a) => a.status === 'open');
    $$('#alSt button').forEach((x) => x.classList.toggle('on', x.dataset.st === AL_F.status));
    setFilterCount('alMore', alFilters());
  };
  const bulk = () => run(async () => {
    const ids = shown().filter((a) => a.status === 'open').map((a) => a.id);
    if (!ids.length) return toast('Nothing to acknowledge');
    await Promise.all(ids.map((id) => post(`/alerts/${id}/ack`)));
    toast(`Acknowledged ${ids.length}`); await refresh(); reopen();
  });
  return {
    t: `${ic('warn')}Alerts`,
    a: `<button type="button" class="btn sm" id="alBulk">${ic('check')}Acknowledge shown</button>`,
    pmenu: [{ label: 'Acknowledge shown', icon: 'check', fn: bulk }],
    b: vtools(`<div class="seg" id="alSt" role="group" aria-label="Status">${segBtns(AL_STATUS, AL_F.status, 'data-st', (v) => (v === 'open' ? cnt(v) : 0))}</div>${filterBtn('alMore', alFilters())}`) + `<div id="alL" class="al-list"></div>`,
    after() {
      draw();
      $('#alSt').onclick = (e) => { const b = e.target.closest('[data-st]'); if (!b) return; AL_F.status = b.dataset.st; draw(); };
      $('#alMore').onclick = (e) => {
        const sh = openSheet({ title: 'Filter alerts', anchor: e.currentTarget, html: `<div class="sheet-form">
          ${selField('alStF', 'Status', [['', 'All states'], ...AL_STATUS], AL_F.status)}${selField('alSevF', 'Severity', [['', 'Any severity'], ...AL_SEV], AL_F.sev)}
          <label class="fld"><span class="vlabel">Search</span><div class="srch">${ic('search')}<input class="inp" id="alQ" type="search" placeholder="Search alerts" aria-label="Search alerts" value="${esc(AL_F.q)}"></div></label>
          <div class="sheet-acts"><button type="button" class="btn lg" id="alClear">Clear</button><button type="button" class="btn pri lg" data-sheet-close>Done</button></div></div>` });
        $('#alStF', sh).onchange = () => { AL_F.status = $('#alStF', sh).value; draw(); };
        $('#alSevF', sh).onchange = () => { AL_F.sev = $('#alSevF', sh).value; draw(); };
        onSearch($('#alQ', sh), (q) => { AL_F.q = q; draw(); });
        $('#alClear', sh).onclick = () => { AL_F.status = 'open'; AL_F.sev = AL_F.q = ''; $('#alStF', sh).value = 'open'; $('#alSevF', sh).value = ''; $('#alQ', sh).value = ''; draw(); };
      };
      $('#alBulk').onclick = bulk;
    },
  };
}
const CALL_R = [['', 'All'], ['ok', 'OK'], ['denied', 'Denied'], ['error', 'Errors']];
async function auditCalls(pre, r0) {
  // A key opens with that key's own calls (up to 1000), not just the hub-wide recent 200.
  const all = (await api(pre && /^crd_/.test(pre) ? `/invocations?credential=${encodeURIComponent(pre)}&limit=2000` : '/invocations?limit=200')).invocations;
  const F = { r: CALL_R.some(([v]) => v === r0) ? r0 : '', who: pre || '', q: '' };
  const agentOf = (i) => i.agent_id || keyAgentOf(i.credential_id);
  const whoName = (i) => (agentOf(i) ? agLabel(agentOf(i)) : K(i.app_credential_id || i.credential_id) ? keyName(K(i.app_credential_id || i.credential_id)) : '—');
  const match = (i) => (!F.r || (F.r === 'error' ? !['ok', 'denied'].includes(i.result) : i.result === F.r))
    && (!F.who || (F.who.startsWith('agent:') ? agentOf(i) === F.who.slice(6) : i.credential_id === F.who || i.app_credential_id === F.who))
    && (!F.q || [i.tool, i.args_summary, i.error_code, whoName(i)].some((x) => String(x || '').toLowerCase().includes(F.q)));
  const agents = [...new Set(all.map(agentOf).filter(Boolean))].map((id) => [id, agLabel(id)]).sort((a, b) => a[1].localeCompare(b[1]));
  // time · agent · tool; the result shows only when it is not ok; the duration ends the row.
  const rw = (i) => { const ag = agentOf(i), a = argText(i.args_summary);
    return row({ cls: 'aud', attrs: ag ? { 'data-ses': ag } : {}, lead: auTime(i.created_at), title: whoName(i), metaId: true, meta: raw(`<span title="${esc(i.args_summary || '')}">${esc(i.tool)}${a ? ` · ${esc(a)}` : ''}</span>`),
      trail: `${i.now_allowed ? `<span class="pill ok" title="${esc(`${i.denied_action || 'This action'} on ${i.denied_path || 'this path'} is allowed now${i.access_changed_at ? `: access changed ${dt(i.access_changed_at)}` : ''}. The call itself stays denied in the record.`)}">Allowed now</span>` : ''}${i.result === 'ok' ? '' : pill(i.result + (i.error_code && i.result !== 'denied' ? ' · ' + i.error_code : ''), i.result === 'denied' ? 'bad' : 'warn')}<span class="aud-d">${esc(i.duration_ms)} ms</span>` }); };
  const nF = () => (F.who ? 1 : 0) + (F.q ? 1 : 0);
  const draw = () => {
    const L = all.filter(match);
    $('#clB').innerHTML = L.length ? byDay(L, (i) => i.created_at, rw) : none('bolt', 'No calls');
    $$('#clR button').forEach((x) => x.classList.toggle('on', x.dataset.r === F.r));
    setFilterCount('clMore', nF());
  };
  return {
    t: `${ic('bolt')}Calls`,
    b: vtools(`<div class="seg" id="clR" role="group" aria-label="Result">${segBtns(CALL_R, F.r, 'data-r')}</div>${filterBtn('clMore', nF())}`) + `<div class="pcard" id="clB"></div>`,
    after() {
      draw();
      $('#clR').onclick = (e) => { const b = e.target.closest('[data-r]'); if (!b) return; F.r = b.dataset.r; draw(); };
      $('#clMore').onclick = (e) => {
        const who = [['', 'Everyone'], ...agents.map(([id, l]) => ['agent:' + id, l]), ...(F.who && !F.who.startsWith('agent:') ? [[F.who, 'Key: ' + subjName(F.who)]] : [])];
        const sh = openSheet({ title: 'Filter calls', anchor: e.currentTarget, html: `<div class="sheet-form">
          ${selField('clW', 'Agent or key', who, F.who)}
          <label class="fld"><span class="vlabel">Search</span><div class="srch">${ic('search')}<input class="inp" id="clQ" type="search" placeholder="Tool, argument, error" aria-label="Search calls" value="${esc(F.q)}"></div></label>
          <div class="sheet-acts"><button type="button" class="btn lg" id="clClear">Clear</button><button type="button" class="btn pri lg" data-sheet-close>Done</button></div></div>` });
        $('#clW', sh).onchange = () => { F.who = $('#clW', sh).value; draw(); };
        onSearch($('#clQ', sh), (q) => { F.q = q; draw(); });
        $('#clClear', sh).onclick = () => { F.who = F.q = ''; $('#clW', sh).value = ''; $('#clQ', sh).value = ''; draw(); };
      };
    },
  };
}
/* Telemetry: what coordination through the hub costs, from what the hub already records (no extra agent calls).
   The token figure is only the hub's share: the size of its answers, about 4 bytes per token. */
const TM_F = { team: '', days: 7 };
const kTok = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + ' M' : n >= 1e3 ? Math.round(n / 1e3) + ' k' : String(n));
async function auditTelemetry() {
  const q = new URLSearchParams({ days: String(TM_F.days), ...(TM_F.team ? { team: TM_F.team } : {}) });
  const d = await api('/telemetry?' + q);
  const C = d.cycles, done = C.filter((c) => c.status === 'done');
  const avg = (L, f) => (L.length ? L.reduce((n, x) => n + f(x), 0) / L.length : 0);
  const share = d.totals.calls ? Math.round((d.totals.bookkeeping_calls / d.totals.calls) * 100) : 0;
  // Before/after a team's last change of mode, when there is one in the window.
  const sw = d.switches.at(-1);
  const split = sw ? [done.filter((c) => c.closed_at < sw.at), done.filter((c) => c.closed_at >= sw.at)] : null;
  const cols = split ? [['Before', split[0]], ['After', split[1]]] : [['With the hub', done]];
  const cmpRows = [['Calls / cycle', (L) => avg(L, (c) => c.calls).toFixed(1)], ['Hub tokens / cycle', (L) => kTok(Math.round(avg(L, (c) => c.est_tokens)))], ['Time / cycle', (L) => dHM(avg(L, (c) => c.elapsed_ms))], ['Cycles', (L) => String(L.length)]];
  const cmp = `<div class="tm-cmp c${cols.length}"><span></span>${cols.map(([h]) => `<span class="tm-h">${esc(h)}</span>`).join('')}${cmpRows.map(([l, f]) => `<span class="tm-l">${esc(l)}</span>${cols.map(([, L]) => `<span class="tm-v">${L.length ? f(L) : '—'}</span>`).join('')}`).join('')}</div>`;
  const b = d.baseline;
  const spark7 = (arr) => { const m = Math.max(1, ...arr); return `<span class="tm-spk">${arr.map((v) => `<i style="height:${Math.round((v / m) * 100)}%" title="${v}"></i>`).join('')}</span>`; };
  const stat = (v, l) => `<div class="stat"><span class="stat-v">${v}</span><span class="stat-l">${l}</span></div>`;
  const nTeam = TM_F.team ? 1 : 0;
  return {
    t: `${ic('pulse')}Telemetry`,
    b: vtools(`<div class="seg" id="tmDays" role="group" aria-label="Window">${[1, 7, 30].map((n) => `<button type="button" data-days="${n}" class="${TM_F.days === n ? 'on' : ''}">${n === 1 ? '24 h' : n + ' days'}</button>`).join('')}</div>${filterBtn('tmMore', nTeam)}`) +
      `<div class="pcard"><div class="stats">${overline('Hub')}${stat(d.totals.calls.toLocaleString(), 'Hub calls')}${stat(`${share}<small>%</small>`, 'Coordination')}${stat(kTok(d.totals.est_tokens), 'Hub tokens')}
        ${overline('Work')}${stat(done.length, 'Tasks closed')}${stat(`${d.operator.status_reports}<small>/${d.operator.status_requests}</small>`, 'Reports / asked')}${stat(d.operator.directives, 'Directives')}</div>
        ${d.operator.approvals_waiting ? `<div class="tm-wait">${pill(`${d.operator.approvals_waiting} approval${d.operator.approvals_waiting === 1 ? '' : 's'} waiting`, 'warn')}</div>` : ''}</div>` +
      `<div class="pcard"><div class="ohd">${overline('Is it worth it?')}${info('The hub counts its own calls and the size of its answers, not the agents\' whole context. It pays off when its cycles need fewer calls than the baseline.')}</div>
        ${split ? `<p class="tm-sub">${esc(dt(sw.at))} · switched to ${sw.mode === 'on_demand' ? 'on demand' : 'polling'}</p>` : ''}${cmp}
        ${b ? `${overline('Baseline · ' + b.label)}${kv('Calls / cycle', String(b.calls_per_cycle))}${kv('Tokens / cycle', esc(kTok(b.tokens_per_cycle)))}${b.note ? `<p class="tm-sub">${esc(b.note)}</p>` : ''}` : ''}
        <details class="task-brief"${b ? '' : ' open'}><summary>${ic('chev')}${b ? 'Change the baseline' : 'Set a baseline'}</summary>
          <div class="tm-base"><label class="fld"><span class="vlabel">Name</span><input class="inp" id="tbL" value="${esc(b?.label || 'Before the hub')}"></label>
          <label class="fld"><span class="vlabel">Calls per cycle</span><input class="inp" id="tbC" type="number" min="0" step="0.5" value="${b?.calls_per_cycle ?? ''}"></label>
          <label class="fld"><span class="vlabel">Tokens per cycle</span><input class="inp" id="tbT" type="number" min="0" step="1000" value="${b?.tokens_per_cycle ?? ''}"></label>
          <label class="fld"><span class="vlabel">Note</span><input class="inp" id="tbN" maxlength="500" value="${esc(b?.note || '')}" placeholder="Where the numbers come from"></label>
          <button type="button" class="btn pri" id="tbGo">${ic('check')}Save baseline</button></div></details></div>` +
      `<div class="pcard"><div class="ohd">${overline('Task cycles', C.length)}${info('Calls count everything the task\'s people did between assignment and close, so tasks worked in parallel overlap.')}</div>${C.length ? C.map((c) => row({ as: 'div',
          title: raw(`<a href="#" data-task="${esc(c.team_id)}|${esc(c.task_id)}">${esc(c.title)}</a>${c.status === 'cancelled' ? ' <span class="tag">cancelled</span>' : ''}`),
          meta: `${c.assignee} · ${dHM(c.elapsed_ms)} · ${c.review_rounds} round${c.review_rounds === 1 ? '' : 's'} · ${c.calls} calls (${c.bookkeeping_calls})${c.review_wait_ms === null ? '' : ' · review wait ' + dHM(c.review_wait_ms)}`,
          trail: `${c.overdue ? pill('overdue × ' + c.overdue, 'warn') : ''}<span title="Hub tokens">${esc(kTok(c.est_tokens))}</span>` })).join('') : none('note', 'No task closed in this window')}</div>` +
      `<div class="pcard"><div class="ohd">${overline('Agents', d.agents.length)}${d.totals.measured_calls < d.totals.calls ? info(`Answer sizes are recorded from this release on: ${d.totals.measured_calls} of ${d.totals.calls} calls in the window have one.`) : ''}</div>${d.agents.length ? d.agents.map((a) => row({ as: 'div',
          lead: `<span class="av lg">${esc(initials(a.label))}</span>`, title: raw(`<a href="#" data-ses="${esc(a.agent_id)}">${esc(a.label)}</a>`),
          meta: `${a.calls} calls · ${a.calls ? Math.round((a.bookkeeping_calls / a.calls) * 100) : 0}% coordination · ${a.denied} denied · ${a.errors} errors`,
          trail: `${spark7(a.per_day)}<span title="Hub tokens">${esc(kTok(a.est_tokens))}</span>` })).join('') : none('ses', 'No agent activity in this window')}</div>`,
    after() {
      $$('#tmDays button').forEach((x) => (x.onclick = () => { TM_F.days = +x.dataset.days; openD('log', 'telemetry', true); }));
      $('#tmMore').onclick = (e) => {
        const sh = openSheet({ title: 'Filter telemetry', anchor: e.currentTarget, html: `<div class="sheet-form">${selField('tmTeam', 'Team', [['', 'All teams'], ...S.teams.map((t) => [t.id, t.name])], TM_F.team)}</div>` });
        $('#tmTeam', sh).onchange = () => { TM_F.team = $('#tmTeam', sh).value; openD('log', 'telemetry', true); };
      };
      $('#tbGo').onclick = () => run(async () => {
        const calls = Number($('#tbC').value), tok = Number($('#tbT').value);
        if (!(calls >= 0) || !(tok >= 0) || $('#tbC').value === '' || $('#tbT').value === '') return toast('Enter calls and tokens per cycle', true);
        await api('/telemetry/baseline', 'PUT', { label: $('#tbL').value.trim() || 'Before the hub', calls_per_cycle: calls, tokens_per_cycle: tok, ...($('#tbN').value.trim() ? { note: $('#tbN').value.trim() } : {}) });
        toast('Baseline saved'); openD('log', 'telemetry', true);
      });
    },
  };
}
/* File writes: every change to a vault file, by whom, with a diff. Reads stay in Calls. Consecutive outside-the-hub changes collapse into one row. */
const FW_OP = { create: 'Created', update: 'Edited', patch: 'Patched', rename: 'Renamed', delete: 'Deleted', restore: 'Restored', observe: 'Changed outside' };
const FW_R = [['', 'All'], ['create', 'Created'], ['update|patch', 'Edited'], ['rename', 'Renamed'], ['delete', 'Deleted'], ['ext', 'Outside the hub']];
async function auditFiles(pre) {
  const all = (await api('/vault/activity?writes=1&limit=200')).revisions;
  const F = { op: '', who: pre || '', q: '' };
  const ext = (r) => r.origin === 'external_observed' || r.op === 'observe';
  const whoH = (r) => (r.agent_id ? (AG(r.agent_id) ? `<a href="#" data-ses="${esc(r.agent_id)}">${esc(r.agent_label || agLabel(r.agent_id))}</a>` : esc(r.agent_label || 'removed agent'))
    : r.admin_id ? 'Admin' : ext(r) ? 'Outside the hub' : r.origin === 'restore' ? 'Restore' : '—');
  const whoTxt = (r) => r.agent_label || (r.admin_id ? 'Admin' : ext(r) ? 'Outside the hub' : '');
  const match = (r) => (!F.op || (F.op === 'ext' ? ext(r) : F.op.split('|').includes(r.op) && !ext(r)))
    && (!F.who || (F.who.startsWith('agent:') ? r.agent_id === F.who.slice(6) : F.who === 'admin' ? !!r.admin_id : F.who === 'ext' ? ext(r) : true))
    && (!F.q || [r.path, whoTxt(r), r.op].some((x) => String(x || '').toLowerCase().includes(F.q)));
  const agents = [...new Set(all.map((r) => r.agent_id).filter(Boolean))].map((id) => [id, agLabel(id)]).sort((a, b) => a[1].localeCompare(b[1]));
  const kb = (n) => (n == null ? '' : n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB');
  // Colour only where it means something: outside the hub (warn) and a delete made by an agent (bad).
  const rw = (r) => { const o = ext(r), label = o && r.op === 'delete' ? 'Deleted outside' : FW_OP[o ? 'observe' : r.op] || r.op, tone = o ? 'warn' : r.op === 'delete' && r.agent_id ? 'bad' : '';
    const canDiff = r.parent_revision && r.revision && r.revision !== 'tombstone';
    const dir = r.path.split('/').slice(0, -1).join('/');
    return row({ as: 'div', cls: 'aud', lead: auTime(r.created_at), title: raw(r.op === 'delete' ? `<span class="fw-gone">${esc(r.path.split('/').pop())}</span>` : vaultFileLink(r.path)),
      meta: raw(`<span class="ve-a ${tone}">${esc(label)}</span> · ${whoH(r)} · <span title="${esc(dir)}">${esc(midTrunc(dir, 40))}</span>`),
      trail: `${canDiff ? `<button type="button" class="btn sm" data-df="${esc(r.file_id + '|' + r.parent_revision + '|' + r.revision)}">Diff</button>` : ''}<span class="aud-d">${esc(kb(r.size))}</span>` }); };
  const nF = () => (F.who ? 1 : 0) + (F.q ? 1 : 0) + (F.op && !['update|patch', 'delete'].includes(F.op) ? 1 : 0);
  const draw = () => {
    const L = all.filter(match), at = (r) => r.created_at;
    const items = groupRuns(L, ext, at);
    $('#fwB').innerHTML = L.length ? byDay(items, (it) => (it.group ? at(it.group[0]) : at(it)), (it) => (it.group ? groupBlock(it.group, at, rw) : rw(it))) : none('file', 'No file changes');
    $$('#fwR button').forEach((x) => x.classList.toggle('on', x.dataset.op === F.op));
    setFilterCount('fwMore', nF());
  };
  const seg = [['', 'All'], ['update|patch', 'Edited'], ['delete', 'Deleted']];
  return {
    t: `${ic('file')}Files`,
    b: vtools(`<div class="seg" id="fwR" role="group" aria-label="Change">${segBtns(seg, F.op, 'data-op')}</div>${filterBtn('fwMore', nF())}`) + `<div class="pcard" id="fwB"></div>`,
    after() {
      draw();
      $('#fwR').onclick = (e) => { const b = e.target.closest('[data-op]'); if (!b) return; F.op = b.dataset.op; draw(); };
      $('#fwMore').onclick = (e) => {
        const who = [['', 'Everyone'], ...agents.map(([id, l]) => ['agent:' + id, l]), ['admin', 'Admin'], ['ext', 'Outside the hub']];
        const sh = openSheet({ title: 'Filter file changes', anchor: e.currentTarget, html: `<div class="sheet-form">
          ${selField('fwOp', 'Change', FW_R, F.op)}${selField('fwW', 'Who', who, F.who)}
          <label class="fld"><span class="vlabel">Search</span><div class="srch">${ic('search')}<input class="inp" id="fwQ" type="search" placeholder="File or folder" aria-label="Search file changes" value="${esc(F.q)}"></div></label>
          <div class="sheet-acts"><button type="button" class="btn lg" id="fwClear">Clear</button><button type="button" class="btn pri lg" data-sheet-close>Done</button></div></div>` });
        $('#fwOp', sh).onchange = () => { F.op = $('#fwOp', sh).value; draw(); };
        $('#fwW', sh).onchange = () => { F.who = $('#fwW', sh).value; draw(); };
        onSearch($('#fwQ', sh), (q) => { F.q = q; draw(); });
        $('#fwClear', sh).onclick = () => { F.op = F.who = F.q = ''; $$('select,input', sh).forEach((x) => (x.value = '')); draw(); };
      };
    },
  };
}
/* Audit trail: who did what to which object, in words, grouped by day. */
const AUD_VERB = { reset: 'reset', member_add: 'added a member to', member_remove: 'removed a member from', acknowledged: 'acknowledged', closed: 'closed', request: 'requested', archive: 'archived', playbook: 'changed the playbook of', create: 'created', update: 'changed', delete: 'deleted', rotate: 'rotated', revoke: 'revoked', suspend: 'suspended', reactivate: 'resumed', expiry: 'changed expiry of', start: 'started', stop: 'stopped', pause: 'paused', resume: 'resumed', on: 'turned on', off: 'turned off', bootstrap: 'set up', approve: 'approved', deny: 'denied', end_logins: 'ended logins of' };
const AUD_NOUN = { system: '', access: 'access to', key: 'key', policy: 'permissions', agent: 'agent', team: 'team', link: 'link', pc: 'PC', lockdown: 'lockdown', admin: 'admin', share: 'share', request: 'request', alert: 'alert', template: 'template' };
const AUD_CAT = [['', 'All'], ['key', 'Keys'], ['policy', 'Permissions'], ['agent|link|team', 'Agents & teams'], ['lockdown|alert|system|admin', 'Safety'], ['pc|share|request|access', 'Devices, sharing & access']];
/* The object an event acted on, named and linked to its panel; removed objects fall back to what the record says. */
function auditTarget(e, d) {
  const id = e.target_id; if (!id) return '';
  switch (e.target_kind) {
    case 'credential': { const k = K(id); return k ? `<a href="#" data-key="${esc(id)}">${esc(keyName(k))}</a>` : `<span class="faint">${esc(d.label || 'removed key')}</span>`; }
    case 'policy': { const k = keyOfPolicy(id), t = tplOf(id); return k ? `<a href="#" data-key="${esc(k.id)}|rules">${esc(keyName(k))}</a>` : t ? `template <b>${esc(t.name)}</b>` : '<span class="faint">removed key</span>'; }
    case 'agent': return AG(id) ? `<a href="#" data-ses="${esc(id)}">${esc(agLabel(id))}</a>` : `<span class="faint">${esc(d.label || d.after?.label || 'removed agent')}</span>`;
    case 'team': { const t = S.teams.find((x) => x.id === id); return t ? `<a href="#" data-team="${esc(id)}">${esc(t.name)}</a>` : `<span class="faint">${esc(d.name || 'removed team')}</span>`; }
    case 'link': return d.from && d.to ? `${refLink(d.from) ?? esc(d.from)} ↔ ${refLink(d.to) ?? esc(d.to)}` : '';
    case 'pc': return refLink(id) ?? esc(d.name || id);
    case 'access_request': return d.resource ? (refLink(d.resource) ?? esc(d.resource)) : '';
    case 'alert': { const a = AUD_AL.get(id); if (!a) return 'alert'; const i = alertInfo(a); return `<a href="#" data-go="log" data-arg="alerts">${esc(i.title)}</a> <span class="faint">· ${esc(i.who)}</span>`; }
    case 'system': return id === 'system' || e.action === 'system.reset' ? 'hub data' : `<span class="mono">${esc(id.replace(/^emergency\./, '').replace(/_/g, ' '))}</span>`;
    case 'admin': return esc(d.username || 'admin');
    default: return refLink(id) ?? `<span class="mono">${esc(trunc(id, 22))}</span>`;
  }
}
const AUD_TONE = { create: 'ok', approve: 'ok', start: 'ok', reactivate: 'ok', resume: 'ok', member_add: 'ok', delete: 'bad', revoke: 'bad', suspend: 'bad', archive: 'bad', deny: 'bad', stop: 'bad', reset: 'bad', on: 'bad', end_logins: 'bad' };
// Alerts of any state, by id, for audit rows that acknowledged or closed one (the overview keeps only open alerts).
let AUD_AL = new Map();
async function auditEvents(pre) {
  const [d, al] = await Promise.all([api('/audit?limit=200'), api('/alerts?limit=200').catch(() => ({ alerts: S.alerts }))]);
  AUD_AL = new Map(al.alerts.map((a) => [a.id, a]));
  const F = { q: (pre || '').toLowerCase(), who: '', cat: '', from: '', to: '' };
  const actor = (e) => (e.actor_kind === 'admin' ? (e.actor_id === S.me.id ? S.me.username : 'Admin') : e.actor_kind === 'agent' ? agLabel(e.actor_id) : e.actor_kind === 'system' ? 'System' : e.actor_kind);
  const actorH = (e) => (e.actor_kind === 'agent' && AG(e.actor_id) ? `<a href="#" data-ses="${esc(e.actor_id)}">${esc(actor(e))}</a>` : esc(actor(e)));
  const sentence = (e) => { const [noun, verb] = e.action.split('.'); return `${AUD_VERB[verb] || (verb || '').replace(/_/g, ' ')} ${AUD_NOUN[noun] ?? noun}`.trim(); };
  const details = (e) => { try { return JSON.parse(e.details || '{}') || {}; } catch { return {}; } };
  // Two lines: who + what, then the object and the facts that matter. The time sits in a fixed 48 px column.
  const rw = (e) => { const d = details(e), verb = e.action.split('.')[1] || '', f = auditFields(e, d), obj = auditTarget(e, d);
    return row({ as: 'div', cls: 'aud', lead: auTime(e.created_at), title: raw(`${actorH(e)} <span class="aud-what ${AUD_TONE[verb] || ''}">${esc(sentence(e))}</span>`),
      meta: raw(`${obj || ''}${obj && f ? ' · ' : ''}${f}${obj || f ? '' : '—'}`) }); };
  const cats = (e) => e.action.split('.')[0];
  const day0 = (v, end) => (v ? Date.parse(v + 'T00:00:00') + (end ? 864e5 - 1 : 0) : 0);
  const match = (e) => (!F.who || e.actor_kind === F.who) && (!F.cat || F.cat.split('|').includes(cats(e))) && (!F.from || e.created_at >= day0(F.from)) && (!F.to || e.created_at <= day0(F.to, 1))
    && (!F.q || [e.action, e.target_id, e.actor_id, e.details, actor(e), sentence(e), auditTarget(e, details(e)).replace(/<[^>]+>/g, '')].some((x) => String(x || '').toLowerCase().includes(F.q)));
  const nF = () => [F.cat, F.q, F.from, F.to].filter(Boolean).length;
  const draw = () => {
    const L = d.events.filter(match); $('#auB').innerHTML = L.length ? byDay(L, (e) => e.created_at, rw) : none('log', 'No events'); tipIcons($('#auB'));
    $$('#auW button').forEach((x) => x.classList.toggle('on', x.dataset.w === F.who));
    setFilterCount('auMore', nF());
  };
  const ms = (v, end) => (v ? Date.parse(v + 'T00:00:00Z') + (end ? 864e5 - 1 : 0) : 0);
  const exp = (fmt) => { const f = ms(F.from), t = ms(F.to, 1), u = '/api/audit/export?format=' + fmt + (f ? '&from=' + f : '') + (t ? '&to=' + t : ''); const a = document.createElement('a'); a.href = u; a.download = ''; document.body.append(a); a.click(); a.remove(); };
  return {
    t: `${ic('log')}Audit`,
    a: `<button type="button" class="btn sm" data-ax="json">${ic('dl')}JSON</button><button type="button" class="btn sm" data-ax="csv">${ic('dl')}CSV</button>`,
    pmenu: [{ label: 'Export JSON', icon: 'dl', fn: () => exp('json') }, { label: 'Export CSV', icon: 'dl', fn: () => exp('csv') }],
    b: vtools(`<div class="seg" id="auW" role="group" aria-label="Actor">${segBtns([['', 'Everyone'], ['admin', 'Admins'], ['agent', 'Agents'], ['system', 'System']], '', 'data-w')}</div>${filterBtn('auMore', nF())}`) + `<div id="auB" class="pcard aud-list"></div>`,
    after() {
      draw();
      $('#auW').onclick = (e) => { const b = e.target.closest('[data-w]'); if (!b) return; F.who = b.dataset.w; draw(); };
      $('#auMore').onclick = (e) => {
        const sh = openSheet({ title: 'Filter audit', anchor: e.currentTarget, html: `<div class="sheet-form">
          ${selField('auC', 'Category', AUD_CAT, F.cat)}
          <div class="dates"><label class="fld"><span class="vlabel">From</span><input class="inp" type="date" id="aF" aria-label="From" value="${esc(F.from)}"></label><label class="fld"><span class="vlabel">To</span><input class="inp" type="date" id="aT" aria-label="To" value="${esc(F.to)}"></label></div>
          <label class="fld"><span class="vlabel">Search</span><div class="srch">${ic('search')}<input class="inp" id="auQ" type="search" placeholder="Search" aria-label="Search audit" value="${esc(F.q)}"></div></label>
          <div class="sheet-acts"><button type="button" class="btn lg" id="auClear">Clear</button><button type="button" class="btn pri lg" data-sheet-close>Done</button></div></div>` });
        $('#auC', sh).onchange = () => { F.cat = $('#auC', sh).value; draw(); };
        $('#aF', sh).onchange = () => { F.from = $('#aF', sh).value; draw(); };
        $('#aT', sh).onchange = () => { F.to = $('#aT', sh).value; draw(); };
        onSearch($('#auQ', sh), (q) => { F.q = q; draw(); });
        $('#auClear', sh).onclick = () => { F.cat = F.q = F.from = F.to = ''; $$('select,input', sh).forEach((x) => (x.value = '')); draw(); };
      };
      $$('[data-ax]').forEach((b) => (b.onclick = () => exp(b.dataset.ax)));
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
  b.innerHTML = L.map(([s, id]) => `<div class="chip sev-crit"><span class="ico">${ic('lock')}</span><b>${ic(LKI[s])}</b><span class="who">${esc(lkName(s, id))}</span><button class="btn sm" data-lk="${esc(s)}|${esc(id)}|0" aria-label="Unlock">${ic('x')}</button></div>`).join('');
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
let LK_Q = ''; // the lockdown search text; kept here because every toggle redraws the view
async function liftAll() {
  // Send every change at once and redraw once, so lifting many locks feels instant.
  const items = lockItems(), setAll = async (on) => {
    await Promise.all(items.map(([sc, id]) => post('/lockdown', { scope: sc, ...(id ? { id } : {}), on })));
    S.lock = await api('/lockdown'); renderLock(); if (DR.type === 'lock') reopen();
  };
  await setAll(false);
  undo('Lifted ' + items.length, () => setAll(true));
}
VIEWS.lock = async () => {
  const l = S.lock || { writes_disabled: false, vaults: [], agents: [], pcs: [], teams: [] };
  const al = S.me.vault_alias, active = lockItems();
  const switchRow = (scope, id, on, icn, name, meta, extra = '') => row({ as: 'div', extra, one: !meta, cls: 'lk-row', lead: ic(on ? 'lock' : icn), title: name, meta,
    trail: switchBtn((on ? 'Unlock ' : 'Lock ') + name, on, `data-lk="${scope}|${esc(id)}|${on ? 0 : 1}"`) });
  // Every entity is a one-switch row; locked ones sort first.
  const list = (title, scope, items, ids) => `<div class="pcard">${overline(title, ids.length ? `${items.length} · ${ids.length} locked` : items.length)}${items.length
    ? items.slice().sort((a, b) => ids.includes(b[0]) - ids.includes(a[0]) || a[1].localeCompare(b[1])).map(([id, name, sub]) => switchRow(scope, id, ids.includes(id), LKI[scope], name, sub, `data-lk-name="${esc(name.toLowerCase())}"`)).join('')
    : none(LKI[scope], 'None')}</div>`;
  const live = new Set(S.ses.filter((s) => s.live).map((s) => s.agent.id));
  const agents = S.agents.filter((a) => a.status !== 'archived').map((a) => [a.id, a.label, live.has(a.id) ? 'live' : a.role || '']);
  const pcs = S.pcs.map((p) => [p.id, p.name, p.bridge?.online ? 'online' : '']);
  const teams = S.teams.map((t) => [t.id, t.name, t.status]);
  const status = active.length ? `${active.length} locked: ${active.map(([s, id]) => lkName(s, id)).join(', ')}` : 'Nothing is locked';
  return {
    t: `${ic('lock')}Lockdown ${active.length ? `<span class="pill p-susp">${active.length} active</span>` : ''}`,
    a: active.length ? `<button class="btn sm" id="lkAll">${ic('play')}Lift all</button>` : '',
    dbar: { title: 'Lockdown', meta: active.length ? `${active.length} locked` : 'Nothing is locked', menu: [active.length ? { label: 'Lift all locks', icon: 'play', fn: () => run(liftAll) } : null] },
    b: `<div class="lk-status${active.length ? ' on' : ''}" role="status">${ic(active.length ? 'lock' : 'check')}<span>${esc(status)}</span></div>
      <div class="pcard">${switchRow('writes', '', l.writes_disabled, 'pause', 'Pause all writes', l.writes_disabled ? 'Locked' : 'Every agent, every app')}${switchRow('vault', al, l.vaults.includes(al), 'vault', 'Freeze vault', l.vaults.includes(al) ? 'Locked' : 'No changes to ' + al)}</div>` +
      vtools(`<div class="srch">${ic('search')}<input class="inp" id="lkQ" type="search" placeholder="Find agent, PC or team" aria-label="Filter" value="${esc(LK_Q)}"></div>`) +
      list('Agents', 'agent', agents, l.agents) + list('PCs', 'pc', pcs, l.pcs) + list('Teams', 'team', teams, l.teams),
    after() {
      const apply = () => $$('.lk-row[data-lk-name]').forEach((c) => (c.hidden = !!LK_Q && !c.dataset.lkName.includes(LK_Q)));
      apply();
      $('#lkQ').oninput = () => { LK_Q = $('#lkQ').value.trim().toLowerCase(); apply(); };
      const all = $('#lkAll');
      if (all) all.onclick = () => run(liftAll);
    },
  };
};

/* Exposure: vault folders ranked by how many keys can reach them. */
const XR_N = 5;
function exposure(el, T) {
  if (!el) return;
  if (!T) { el.innerHTML = ''; return; }
  // Only what some agent can reach: folders and loose files no session key can read are left out.
  const it = T.folders.filter((f) => f.exposure.read > 0).map((f) => ({ n: f.name, p: f.path, e: f.exposure.read }));
  const loose = T.files.filter((f) => f.exposure.read > 0);
  if (loose.length) it.push({ n: 'Loose files', e: Math.max(...loose.map((f) => f.exposure.read)) });
  if (!it.length) { el.innerHTML = none('vault', 'No agent can reach anything here'); return; }
  it.sort((a, b) => b.e - a.e || a.n.localeCompare(b.n));
  const mx = it[0].e, top = it.slice(0, XR_N), rest = it.slice(XR_N);
  const ramp = (e) => { const f = e / mx; return f >= 0.75 ? 4 : f >= 0.4 ? 3 : f >= 0.15 ? 2 : 1; };
  const rowH = (c) => { const inner = `<span class="xr-n" title="${esc(c.n)}">${esc(c.n)}</span><span class="xr-bar"><i class="r${ramp(c.e)}" style="width:${Math.round((c.e / mx) * 100)}%"></i></span><span class="xr-e">${c.e}</span>`;
    return c.p ? `<button type="button" class="xr" data-vp="${esc(c.p)}">${inner}</button>` : `<div class="xr">${inner}</div>`; };
  const same = rest.length && rest.every((c) => c.e === rest[0].e);
  el.innerHTML = top.map(rowH).join('') + (rest.length ? `<button type="button" class="xr-more" data-go="vault">+${rest.length} more folder${rest.length === 1 ? '' : 's'}${same ? ` · ${rest[0].e} key${rest[0].e === 1 ? '' : 's'} each` : ''}</button>` : '');
}
/* From 768 px exposure is a treemap: a box per reachable folder, sized by its file count, shaded by how many keys reach it. */
function squarify(items, x, y, w, h) {
  const out = [], tot = items.reduce((a, b) => a + b.v, 0); if (!tot) return out;
  const sc = (w * h) / tot; let rest = items.map((it) => ({ ...it, a: it.v * sc }));
  while (rest.length) {
    const sh = Math.min(w, h), worst = (r) => { const s = r.reduce((a, b) => a + b.a, 0), mx = Math.max(...r.map((q) => q.a)), mn = Math.min(...r.map((q) => q.a)); return Math.max((sh * sh * mx) / (s * s), (s * s) / (sh * sh * mn)); };
    let strip = [rest[0]], i = 1; while (i < rest.length && worst([...strip, rest[i]]) <= worst(strip)) { strip.push(rest[i]); i++; }
    const s = strip.reduce((a, b) => a + b.a, 0);
    if (w >= h) { const cw = s / h; let cy = y; strip.forEach((r) => { const ch = r.a / cw; out.push({ ...r, x, y: cy, w: cw, h: ch }); cy += ch; }); x += cw; w -= cw; }
    else { const rh = s / w; let cx = x; strip.forEach((r) => { const c2 = r.a / rh; out.push({ ...r, x: cx, y, w: c2, h: rh }); cx += c2; }); y += rh; h -= rh; }
    rest = rest.slice(i);
  }
  return out;
}
function treemap(el, T) {
  if (!el) return;
  if (!T) { el.innerHTML = ''; return; }
  el.classList.add('tm'); const W = el.clientWidth, H = el.clientHeight; if (!(W > 0 && H > 0)) return;
  const it = T.folders.filter((f) => f.exposure.read > 0).map((f) => ({ n: f.name, p: f.path, files: f.files, v: Math.max(f.files, 0.4), e: f.exposure.read }));
  const loose = T.files.filter((f) => f.exposure.read > 0);
  if (loose.length) it.push({ n: 'Loose files', files: loose.length, v: loose.length, e: Math.max(...loose.map((f) => f.exposure.read)) });
  if (!it.length) { el.classList.remove('tm'); el.innerHTML = none('vault', 'No agent can reach anything here'); return; }
  // Three tints, never the solid accent: when most folders share the top count the card stays calm and the labels readable.
  const mx = Math.max(...it.map((c) => c.e)), ramp = (e) => { const f = e / mx; return f >= 0.75 ? 3 : f >= 0.4 ? 2 : 1; };
  const G = 4; // gap between boxes, on the 4 px grid
  el.innerHTML = squarify(it.sort((a, b) => b.v - a.v), 0, 0, W + G, H + G).map((c) => {
    const w = Math.max(0, Math.floor(c.w - G)), h = Math.max(0, Math.floor(c.h - G)), full = w >= 96 && h >= 56, label = w >= 64 && h >= 32; // text only where it fits whole
    const meta = `${c.files} file${c.files === 1 ? '' : 's'} · ${c.e} key${c.e === 1 ? '' : 's'}`;
    return `<${c.p ? `button type="button" data-vp="${esc(c.p)}"` : 'div'} class="tc r${ramp(c.e)}${label ? '' : ' bare'}" style="left:${Math.round(c.x)}px;top:${Math.round(c.y)}px;width:${w}px;height:${h}px" title="${esc(c.n)} · ${meta}" aria-label="${esc(c.n)}, ${meta}">${label ? `<b class="tc-n">${esc(c.n)}</b>` : ''}${full ? `<span class="tc-m">${ic('key')}${esc(meta)}</span>` : ''}</${c.p ? 'button' : 'div'}>`;
  }).join('');
}
let treeAt = 0;
function renderTree() {
  const el = $('#tm'), boxes = matchMedia('(min-width: 768px)').matches;
  if ($('#expMeta')) $('#expMeta').textContent = boxes ? 'size: files · shade: keys' : 'keys per folder';
  if (el && boxes) treemap(el, S.tree); else { el?.classList.remove('tm'); exposure(el, S.tree); }
}
function loadTree() { if (Date.now() - treeAt < 30000) return; treeAt = Date.now(); api('/vault/tree').then((t) => { S.tree = t; renderTree(); }, () => {}); }

/* Vault workspace */
let lastVault = null;
/* Each click on the tree reloads every folder level above the selection; reuse levels fetched in the last
   20 seconds so a click on a large vault answers at once instead of recomputing exposure for each ancestor. */
const treeCache = new Map();
let vaultTreeScroll = 0;
function treeLevel(path) {
  const hit = treeCache.get(path);
  if (hit && Date.now() - hit.at < 20000) return hit.p;
  const p = api('/vault/tree?path=' + encodeURIComponent(path));
  treeCache.set(path, { at: Date.now(), p });
  p.catch(() => treeCache.delete(path));
  return p;
}
const vaultRoot = () => '/' + S.me.vault_alias;
function vaultState(arg) {
  if (arg && typeof arg === 'object') return cleanVault(arg); // a partial state (a tab but no path) gets the defaults
  const [tab, path] = String(arg || '').split('|');
  return { tab: ['access', 'act', 'conf'].includes(tab) ? tab : 'contents', path: path || vaultRoot(), file: false, agent: '' };
}
/* Vault activity: file changes (through the hub or outside it) and file access decisions, newest first.
   kind is what the filters use: change | outside | read | denied. */
const VE_OP = { create: 'Created', update: 'Edited', patch: 'Edited', rename: 'Renamed', delete: 'Deleted', restore: 'Restored' };
function vaultEvents(activity) {
  const revisions = activity.revisions.map(r => {
    const outside = r.origin === 'external_observed' || r.op === 'observe';
    return {
      path: r.path, at: r.created_at, kind: outside ? 'outside' : 'change', agentId: r.agent_id,
      agent: r.agent_label || (r.admin_id ? 'Admin' : outside ? 'Outside the hub' : r.origin === 'restore' ? 'Restore' : 'Unknown'),
      action: outside ? (r.op === 'delete' ? 'Deleted outside' : r.parent_revision ? 'Changed outside' : 'Added outside') : VE_OP[r.op] || r.op,
      tone: outside ? 'outside' : r.op === 'delete' ? 'denied' : 'edit',
      diff: r.parent_revision && r.revision && r.revision !== 'tombstone' ? r.file_id + '|' + r.parent_revision + '|' + r.revision : '',
    };
  });
  // Allowed writes are already listed as changes above; keep reads and every denial.
  const accesses = activity.access.filter(a => a.decision === 'deny' || !['fs.create', 'fs.update', 'fs.delete', 'fs.rename', 'fs.restore'].includes(a.action)).map(a => ({
    path: a.path || a.resource || '', agent: a.agent_label || 'Unknown', agentId: a.agent_id, at: a.created_at,
    kind: a.decision === 'deny' ? 'denied' : 'read',
    action: a.decision === 'deny' ? 'Denied ' + a.action.slice(3) : a.action === 'fs.read' ? 'Read' : cap(a.action.slice(3)),
    tone: a.decision === 'deny' ? 'denied' : 'read',
  }));
  return [...revisions, ...accesses].sort((a, b) => b.at - a.at);
}
const VA_KINDS = [['', 'All'], ['change', 'Changes'], ['read', 'Reads'], ['outside', 'Outside the hub'], ['denied', 'Denied']];
const VA_F = { kind: '', q: '' };
const vnote = (html) => `<p class="vnote">${ic('note')}<span>${html}</span></p>`;
const vaFilters = () => (VA_F.kind && !['change', 'read'].includes(VA_F.kind) ? 1 : 0) + (VA_F.q ? 1 : 0);
/* Activity: one filter row (segment + Filters button). Consecutive outside-the-hub changes collapse into one group row. */
function vaultTimeline(events, state) {
  const n = (k) => events.filter((e) => !k || e.kind === k).length;
  const seg = [['', 'All'], ['change', 'Changes'], ['read', 'Reads']];
  const tools = vtools(`<div class="seg" id="vaK" role="group" aria-label="Kind">${seg.map(([k, l]) => `<button type="button" data-va="${k}" class="${VA_F.kind === k ? 'on' : ''}"${k && !n(k) ? ' disabled' : ''}>${l} <span class="tabn">${n(k)}</span></button>`).join('')}</div>${filterBtn('vaMore', vaFilters())}`);
  const rw = (e) => {
    const name = e.path.split('/').pop(), dir = e.path.split('/').slice(0, -1).join('/');
    const who = e.agentId && AG(e.agentId) ? `<a href="#" data-ses="${esc(e.agentId)}">${esc(e.agent)}</a>` : esc(e.agent);
    const file = e.kind === 'denied' || /Deleted/.test(e.action) ? esc(name) : vaultFileLink(e.path, name);
    return row({ as: 'div', cls: 'vault-event', extra: `data-kind="${e.kind}" data-text="${esc((e.path + ' ' + e.agent + ' ' + e.action).toLowerCase())}"`,
      title: raw(file), meta: raw(`<span class="ve-a ${e.tone}">${esc(e.action)}</span> · ${who} · <span class="ve-dir" title="${esc(dir)}">${esc(midTrunc(dir, 40))}</span>`),
      trail: `${e.diff ? `<button type="button" class="btn sm" data-df="${esc(e.diff)}">Diff</button>` : ''}<time title="${esc(new Date(e.at).toLocaleString())}">${clock(e.at)}</time>` });
  };
  const items = groupRuns(events, (e) => e.kind === 'outside', (e) => e.at);
  const draw = (it) => (it.group ? groupBlock(it.group, (e) => e.at, rw) : rw(it));
  const empty = state.agent ? none('pulse', `No activity by ${esc(agLabel(state.agent))} here`) : none('pulse', 'No activity');
  return tools + `<div class="pcard vault-timeline" id="vaL">${events.length ? byDay(items, (it) => (it.group ? it.group[0].at : it.at), draw) : empty}</div><div id="vaNone" hidden>${none('search', 'No matches')}</div>`;
}
function vaultTimelineFilter() {
  const L = $('#vaL'); if (!L) return;
  let shown = 0;
  for (const el of $$('.vault-event', L)) { el.hidden = (VA_F.kind && el.dataset.kind !== VA_F.kind) || (VA_F.q && !el.dataset.text.includes(VA_F.q)); if (!el.hidden) shown++; }
  // A group shows how many of its changes match, and goes when none do.
  for (const g of $$('.vgroup', L)) { const k = $$('.vault-event', g).filter((x) => !x.hidden).length; g.hidden = !k; $('.vg-n', g).textContent = k; }
  // Hide day headings with nothing left under them.
  for (const h of $$('h5.day', L)) { let x = h.nextElementSibling, any = false; while (x && !x.matches('h5.day')) { if (!x.hidden) any = true; x = x.nextElementSibling; } h.hidden = !any; }
  $('#vaNone').hidden = shown > 0 || !$$('.vault-event', L).length;
  $$('#vaK button').forEach((x) => x.classList.toggle('on', x.dataset.va === VA_F.kind));
  setFilterCount('vaMore', vaFilters());
}
function openVaultFilters(btn) {
  const sh = openSheet({ title: 'Filter activity', anchor: btn, html: `<div class="sheet-form">
    ${selField('vaKind', 'Show', VA_KINDS, VA_F.kind)}
    <label class="fld"><span class="vlabel">Search</span><div class="srch">${ic('search')}<input class="inp" id="vaQ" type="search" placeholder="File, folder or agent" aria-label="Search activity" value="${esc(VA_F.q)}"></div></label>
    <div class="sheet-acts"><button type="button" class="btn lg" id="vaClear">Clear</button><button type="button" class="btn pri lg" data-sheet-close>Done</button></div></div>` });
  $('#vaKind', sh).onchange = () => { VA_F.kind = $('#vaKind', sh).value; vaultTimelineFilter(); };
  onSearch($('#vaQ', sh), (q) => { VA_F.q = q; vaultTimelineFilter(); });
  $('#vaClear', sh).onclick = () => { VA_F.kind = VA_F.q = ''; $('#vaKind', sh).value = ''; $('#vaQ', sh).value = ''; vaultTimelineFilter(); };
}
/* Access: a row per agent (and per active session key), Read / Edit pills, chevron to the key's access editor. */
function vaultAccess(entry, state) {
  const read = entry.exposure.read_agents, update = entry.exposure.update_agents;
  const ids = state.agent ? [state.agent] : [...new Set([...read, ...update])];
  const verb = state.file ? 'Who can read or edit this file, from their session key rules.' : 'Who can reach this folder or something inside it, from their session key rules. Access can differ per file inside.';
  const head = `<div class="ohd">${overline('Who can reach it', ids.length)}${info(`${verb} App key limits and pauses can restrict a session further.`)}</div>`;
  const pills = (id) => `${read.includes(id) ? pill('Read', 'ok') : ''}${update.includes(id) ? pill('Edit', 'info') : ''}${!read.includes(id) && !update.includes(id) ? pill('No access', 'idle') : ''}`;
  const rows = ids.flatMap((id) => {
    const keys = S.keys.filter((k) => k.kind === 'session_key' && k.agent_id === id && k.effective_status === 'active');
    const lead = `<span class="av lg">${esc(initials(agLabel(id)))}</span>`;
    return keys.length ? keys.map((k) => row({ lead, title: agLabel(id), meta: keys.length === 1 ? 'Session key · manage access' : 'Session key · ' + k.label, trail: pills(id), chev: true, attrs: { 'data-key': k.id } }))
      : [row({ lead, title: agLabel(id), meta: 'No active session key', trail: pills(id) })];
  });
  return `<div class="pcard">${head}${rows.join('') || none('key', 'No access')}</div>`;
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
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_, label, url) => {
    if (/^(https?:|mailto:)/i.test(url)) return hold(`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`);
    // A malformed %-escape in one link must not throw and blank the whole note or report.
    let name = url; try { name = decodeURIComponent(url); } catch { /* keep it as written */ }
    const path = resolve(name.replace(/\.md$/i, '').split('/').pop());
    return hold(path ? `<a href="#" class="md-wl" data-vault-path="${esc(path)}" data-vault-file>${esc(label)}</a>` : `<span class="md-wl miss">${esc(label)}</span>`);
  });
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
      // Short cells (dates, names) never wrap mid-word; long ones wrap at a minimum width, and the table scrolls inside its own box.
      const nw = (c) => (c.length <= 24 ? ' class="nw"' : '');
      out.push(`<div class="tscroll"><table class="md-table"><thead><tr>${head.map((c) => `<th${nw(c)}>${inl(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${head.map((_, j) => `<td${nw(r[j] || '')}>${inl(r[j] || '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`); continue;
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
  const activityQuery = new URLSearchParams({ path: state.path, limit: '200', writes: '1', ...(state.file ? { exact: '1' } : {}), ...(state.agent ? { agent: state.agent } : {}) });
  const [levels, activity, preview, conflicts] = await Promise.all([
    Promise.all(folders.map(treeLevel)),
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
  const touchedBy = last.has(state.path) ? last.get(state.path).agent : '';
  const contents = () => {
    if (state.file) {
      const md = isMarkdown(state.path) && preview?.preview;
      // [[Note]] links resolve against the folders already loaded for this view (this folder and its parents).
      const resolve = (name) => { const n = name.toLowerCase(); for (const lv of levels.slice().reverse()) { const f = lv.files.find((x) => x.name.toLowerCase() === n || x.name.toLowerCase() === n + '.md'); if (f) return f.path; } return null; };
      const src = preview?.preview ? `<pre class="vault-preview" data-md-pane="source"${md && mdMode === 'preview' ? ' hidden' : ''}>${esc(preview.preview.content)}</pre>` : '';
      return `<div class="vault-file-bar"><div class="vault-file-meta only-d">${preview ? esc(fmtB(preview.size)) : ''}${touchedBy ? ' · touched by ' + esc(touchedBy) : ''}</div>
          ${md ? `<div class="seg" id="mdMode" role="group" aria-label="View">${[['preview', 'Preview', 'eye'], ['source', 'Source', 'note']].map(([k, l, icn]) => `<button type="button" data-md="${k}" class="${mdMode === k ? 'on' : ''}">${ic(icn)}${l}</button>`).join('')}</div>` : ''}</div>
        ${preview?.preview ? (md ? `<article class="md pcard" data-md-pane="preview"${mdMode === 'preview' ? '' : ' hidden'}>${mdRender(preview.preview.content, resolve)}</article>` : '') + src + (preview.preview.truncated ? '<p class="vault-hint">Showing the first 24 KB.</p>' : '') : none('file', 'No preview')}`;
    }
    const rows = [...current.folders.map(item => ({ item, file: false })), ...current.files.map(item => ({ item, file: true }))];
    const one = ({ item, file }) => {
      const touched = last.get(item.path);
      const grant = state.agent ? item.exposure.read_agents.includes(state.agent) || item.exposure.update_agents.includes(state.agent) : item.exposure.read_agents.length;
      return row({ cls: 'vault-item', lead: `<span class="av lg">${ic(file ? 'file' : 'vault')}</span>`, title: item.name,
        meta: file ? `${fmtB(item.size)}${touched ? ' · touched by ' + touched.agent : ''}` : `${item.files} file${item.files === 1 ? '' : 's'}`,
        trail: state.agent ? (grant ? pill(file ? 'Has access' : 'May reach', 'ok') : pill('No access', 'idle')) : `<span>${grant} ${file ? (grant === 1 ? 'reader' : 'readers') : 'can reach'}</span>`,
        chev: true, attrs: file ? { 'data-vault-path': item.path, 'data-vault-file': '' } : { 'data-vault-path': item.path } });
    };
    const fo = rows.filter((r) => !r.file), fi = rows.filter((r) => r.file);
    return rows.length ? vtools(`<div class="srch">${ic('search')}<input class="inp" id="vaultFilter" type="search" placeholder="Filter" aria-label="Filter this folder"></div>`) + `
      <div class="pcard vault-items">${fo.length ? overline('Folders', fo.length) + fo.map(one).join('') : ''}${fi.length ? overline('Files', fi.length) + fi.map(one).join('') : ''}</div><div id="vaultNoMatches" hidden>${none('search', 'No matches')}</div>` : none('vault', 'Empty folder');
  };
  const panel = state.tab === 'conf' ? conflicts.b : state.tab === 'act' ? vaultTimeline(events, state)
    : state.tab === 'access' ? entry ? vaultAccess(entry, state) : none('file', 'Not found') : contents();
  const crumbs = folders.map((path, i) => i === folders.length - 1 && !state.file
    ? `<b>${esc(i ? parts[i] : title)}</b>` : `<button data-vault-path="${esc(path)}">${esc(i ? parts[i] : 'Vault root')}</button>`);
  if (state.file) crumbs.push(`<b>${esc(title)}</b>`);
  /* Phone breadcrumb: one line, root · … · the folder you are in. The collapsed middle opens as a sheet (data-vcrumbs). */
  const seg = folders.map((path, i) => ({ path, name: i ? parts[i] : 'Vault root' }));
  const crumbBtn = (g) => `<button type="button" data-vault-path="${esc(g.path)}"><span>${esc(g.name)}</span></button>`;
  const cur = (name) => `<span aria-current="page"><span>${esc(name)}</span></span>`;
  const sepH = ic('chev', 'sep'), hiddenSegs = seg.slice(1, -1), lastSeg = seg.at(-1);
  // Root · … · the folder you are in (a file's crumbs end at its folder; its name is in the detail bar).
  const crumbsM = `<nav class="crumbs" aria-label="Path">${seg.length === 1 ? (state.file ? crumbBtn(seg[0]) : cur(seg[0].name))
    : crumbBtn(seg[0]) + sepH + (hiddenSegs.length ? `<button type="button" class="more" data-vcrumbs aria-label="Show the whole path">…</button>${sepH}` : '') + (state.file ? crumbBtn(lastSeg) : cur(lastSeg.name))}</nav>`;
  const agentName = state.agent ? agLabel(state.agent) : 'Everyone';
  const bar = state.tab === 'conf' ? '' : `<div class="vbar only-m">${crumbsM}${state.file && state.tab === 'contents' ? '' : `<button type="button" class="btn${state.agent ? ' on' : ''}" id="vaAgentBtn" aria-haspopup="dialog">${ic('sl')}<span class="vbar-l">${esc(agentName)}</span></button>`}</div>`;
  lastVault = state;
  const fileMenu = state.file ? [
    state.tab !== 'contents' ? { label: 'Preview', icon: 'eye', fn: () => openD('vault', { ...state, tab: 'contents' }, true) } : null,
    state.tab !== 'access' ? { label: 'Access', icon: 'key', fn: () => openD('vault', { ...state, tab: 'access' }, true) } : null,
    state.tab !== 'act' ? { label: 'History', icon: 'pulse', fn: () => openD('vault', { ...state, tab: 'act' }, true) } : null,
  ] : [];
  const fileMeta = [entry && !preview ? fmtB(entry.size) : preview ? fmtB(preview.size) : '', touchedBy ? 'touched by ' + touchedBy : ''].filter(Boolean).join(' · ');
  return {
    t: `${ic(state.file ? 'file' : 'vault')}<span class="bc2">${crumbs.join(ic('chev', 'sep'))}</span>`,
    a: (paused ? `<span class="chk n">${ic('lock')}Writes paused</span>` : '') +
      `<select class="sel" id="vaultAgent" aria-label="Agent"><option value="">Everyone</option>${S.agents.filter(a => a.status !== 'archived').map(a => `<option value="${esc(a.id)}"${a.id === state.agent ? ' selected' : ''}>${esc(a.label)}</option>`).join('')}</select>`,
    dbar: state.file ? { title: title, meta: fileMeta || 'File', menu: fileMenu } : undefined,
    b: `${paused ? `<div class="vpaused only-m">${pill('Writes paused', 'warn')}</div>` : ''}${bar}<div class="vault-workspace">
      <nav class="vault-tree only-d" aria-label="Vault folders">${vaultTree(levels, state)}</nav>
      <section class="vault-detail" aria-label="Selected vault item">${panel}</section></div>`,
    after() {
      // Keep the tree where the user left it, and the selected entry in view.
      const tree = $('.vault-tree');
      if (tree) {
        tree.scrollTop = vaultTreeScroll;
        tree.onscroll = () => { vaultTreeScroll = tree.scrollTop; };
        const cur = $('[aria-current="true"]', tree);
        if (cur) { const t = cur.offsetTop - tree.scrollTop; if (t < 0 || t > tree.clientHeight - cur.offsetHeight) cur.scrollIntoView({ block: 'nearest' }); }
      }
      const vk = $('#vaK');
      if (vk) {
        vk.onclick = (e) => { const b = e.target.closest('[data-va]'); if (!b) return; VA_F.kind = b.dataset.va; vaultTimelineFilter(); };
        $('#vaMore').onclick = (e) => openVaultFilters(e.currentTarget);
        vaultTimelineFilter();
      }
      const mdSw = $('#mdMode');
      if (mdSw) mdSw.onclick = (e) => {
        const b = e.target.closest('[data-md]'); if (!b) return;
        mdMode = b.dataset.md; try { localStorage.setItem('ah-md-mode', mdMode); } catch { /* ignore */ }
        $$('#mdMode button').forEach((x) => x.classList.toggle('on', x === b));
        $$('[data-md-pane]').forEach((p) => (p.hidden = p.dataset.mdPane !== mdMode));
      };
      const pickAgent = (id) => openD('vault', { ...state, agent: id, tab: state.tab === 'contents' ? 'access' : state.tab }, true);
      $('#vaultAgent').onchange = e => pickAgent(e.target.value);
      const ab = $('#vaAgentBtn');
      if (ab) ab.onclick = () => {
        const list = [['', 'Everyone'], ...S.agents.filter(a => a.status !== 'archived').map(a => [a.id, a.label])];
        const sh = openSheet({ title: 'Show access for', anchor: ab, html: `<div class="sheet-list">${list.map(([id, l]) => `<button type="button" class="sheet-item" data-vagent="${esc(id)}">${state.agent === id ? ic('check') : ic('user')}<span>${esc(l)}</span></button>`).join('')}</div>` });
        sh.addEventListener('click', (e) => { const b = e.target.closest('[data-vagent]'); if (b) pickAgent(b.dataset.vagent); });
      };
      const cb = $('[data-vcrumbs]');
      if (cb) cb.onclick = () => openSheet({ title: 'Path', anchor: cb, html: `<div class="sheet-list">${seg.map((g) => `<button type="button" class="sheet-item" data-vault-path="${esc(g.path)}">${ic('vault')}<span>${esc(g.name)}</span></button>`).join('')}</div>` });
      const filter = $('#vaultFilter');
      if (filter) filter.oninput = () => {
        const query = filter.value.trim().toLowerCase();
        const items = $$('.vault-item');
        for (const item of items) item.hidden = !item.querySelector('.lrow-title').textContent.toLowerCase().includes(query);
        for (const o of $$('.vault-items .overline')) { let x = o.nextElementSibling, any = false; while (x && !x.matches('.overline')) { if (!x.hidden) any = true; x = x.nextElementSibling; } o.hidden = !any; }
        $('#vaultNoMatches').hidden = items.some(item => !item.hidden);
      };
      conflicts?.after();
    },
  };
};

/* Conflicts: a card per conflicted file, a row per revision with Diff and Keep. */
VIEWS.vaultConflicts = async () => {
    const C = (await api('/vault/conflicts')).conflicts;
    return {
      b: C.map((c) => `<div class="pcard cf"><div class="cf-hd"><span class="mono" title="${esc(c.path)}">${esc(midTrunc(c.path, 44))}</span><span class="meta">${esc(ago(c.created_at))} ago</span></div>
        <div class="cf-meta">${tagH(esc(c.source))}${c.agent_label ? `<span class="meta">${ic('user')}${esc(c.agent_label)}</span>` : ''}</div>${c.conflict_path ? `<div class="mono muted ellip" title="${esc(c.conflict_path)}">${esc(midTrunc(c.conflict_path, 48))}</div>` : ''}
        ${(Array.isArray(c.revisions) ? c.revisions : []).map((v) => row({ one: true, as: 'div', title: raw(`${v.role ? `<span class="tag">${esc(v.role)}</span> ` : ''}<span class="mono">${esc(rv(v.revision))}</span>`),
          trail: `<button type="button" class="btn ic sm" data-df="${esc(c.file_id)}|${esc(c.base_revision || 'absent')}|${esc(v.revision)}" aria-label="Diff">${ic('eye')}</button><button type="button" class="btn sm" data-keep="${esc(c.id)}|${esc(v.revision)}" aria-label="Keep revision">${ic('check')}Keep</button>` })).join('')}</div>`).join('') || none('check', 'No conflicts'),
      after() { $$('[data-keep]').forEach((b) => arm(b, () => run(async () => { const [id, rev] = b.dataset.keep.split('|'); await post(`/vault/conflicts/${id}/resolve`, { keep: rev }); toast('Resolved'); await refresh(); reopen(); }))); },
    };
};
VIEWS.diff = async (arg) => {
  const [fid, from, to] = arg.split('|');
  const R = await api('/vault/revisions/' + encodeURIComponent(fid));
  let D = null, err = '';
  try { D = await api(`/vault/diff?file=${encodeURIComponent(fid)}&from=${encodeURIComponent(from)}${to ? '&to=' + encodeURIComponent(to) : ''}`); } catch (e) { err = e.message; }
  const opt = (cur, none) => `${none ? `<option value="absent"${cur === 'absent' ? ' selected' : ''}>∅</option>` : ''}${R.revisions.map((r) => `<option value="${esc(r.revision)}"${r.revision === cur ? ' selected' : ''}>${esc(rv(r.revision))} · ${esc(r.op)} · ${ago(r.created_at)}</option>`).join('')}`;
  const cls = (l) => (l.startsWith('+++') || l.startsWith('---') ? 'h' : l[0] === '+' ? 'a' : l[0] === '-' ? 'd' : l[0] === '@' ? 'h' : '');
  const toRev = to || D?.to || R.file.current_revision;
  return {
    t: `${ic('note')}<span class="mono ellip">${esc(R.file.path)}</span>`,
    dbar: { title: R.file.path.split('/').pop(), meta: `${rv(from)} → ${rv(toRev)}` },
    b: `<div class="pcard dfsel"><label class="fld"><span class="vlabel">From</span><select class="sel fill" id="dF" aria-label="From">${opt(from, 1)}</select></label><span class="dfsel-a only-d" aria-hidden="true">→</span><label class="fld"><span class="vlabel">To</span><select class="sel fill" id="dT2" aria-label="To">${opt(toRev)}</select></label></div>` +
      (D ? (D.identical ? `<div class="empty sm">${ic('check')}<span>No difference</span></div>` : `<pre class="df">${D.diff.split('\n').map((l) => `<div class="${cls(l)}">${esc(l) || ' '}</div>`).join('')}</pre>`) : `<div class="chk n">${ic('warn')}${esc(err)}</div>`),
    after() { const go_ = () => openD('diff', `${fid}|${$('#dF').value}|${$('#dT2').value}`, true); $('#dF').onchange = go_; $('#dT2').onchange = go_; },
  };
};

/* requests + grants */
async function decide(id, ok, body) { await post(`/requests/${id}/${ok ? 'approve' : 'deny'}`, body || {}); toast(ok ? 'Approved' : 'Denied'); await refresh(); if (DR.type === 'req') reopen(); }
const RQ_DUR = ['15m', '1h', '4h', '1d'];
/* A pending request: who asks, for which action on which resource, why, then the duration, the narrowing and the two answers. */
const reqCard = (r) => `<div class="pcard rqc" data-rq="${esc(r.id)}">
  <div class="rq-hd"><span class="rq-who">${esc(r.agent_label || trunc(r.agent_id, 12))}</span><span class="meta">${ago(r.created_at)} ago${r.requested_duration_s ? ' · for ' + fmtD(r.requested_duration_s) : ''}</span></div>
  <div class="rq-what"><span class="mono">${esc(r.actions.join(', '))}</span><span class="mono rq-res">${esc(r.resource)}</span></div>
  ${r.justification ? `<p class="rq-why">${esc(r.justification)}</p>` : ''}
  <div class="fld"><span class="vlabel">Grant for (optional)</span><div class="seg" data-dur>${RQ_DUR.map((d) => `<button type="button" data-d="${d}">${d}</button>`).join('')}</div></div>
  <label class="fld"><span class="vlabel">Narrow to (optional)</span><input class="inp mono" data-narrow placeholder="${esc(r.resource)}" aria-label="Narrow the resource" maxlength="1024" autocomplete="off"></label>
  <div class="rq-acts"><button type="button" class="btn pri" data-rqa="ok">${ic('check')}Approve</button><button type="button" class="btn" data-rqa="no">${ic('x')}Deny</button></div></div>`;
VIEWS.req = async (tab = 'req') => {
  const seg = vtools(subTabs('data-rt', [['req', 'Pending', S.reqs.length ? ' ' + S.reqs.length : ''], ['grants', 'Temporary grants']], tab));
  if (tab === 'grants') {
    const G = (await api('/grants')).grants;
    return { t: `${ic('clock')}Requests <span class="n">${G.length}</span>`,
      b: seg + `<div class="pcard">${G.map((g) => { const k = K(g.credential_id);
        return row({ lead: ic('clock'), title: raw(`<span class="mono" title="${esc(g.resource)}">${esc(midTrunc(g.resource, 40))}</span>`),
          meta: `${g.actions.map((a) => ACTN[a] || a.replace('fs.', '')).join(', ')}${k ? ' · ' + keyName(k) : ''} · ${left(g.not_after)} left`,
          trail: `<button type="button" class="btn sm" data-gr="${esc(g.id)}" aria-label="Revoke grant">${ic('trash')}Revoke</button>` }); }).join('') || none('clock', 'No temporary grants')}</div>`,
      after() { $$('[data-gr]').forEach((b) => arm(b, () => run(async () => { await api('/grants/' + b.dataset.gr, 'DELETE'); toast('Revoked'); reopen(); }))); } };
  }
  const all = (await api('/requests')).requests, P = all.filter((r) => r.status === 'pending'), D = all.filter((r) => r.status !== 'pending').slice(0, 12);
  return {
    t: `${ic('clock')}Requests <span class="n">${P.length}</span>`,
    b: seg + (P.length ? P.map(reqCard).join('') : `<div class="pcard">${none('clock', 'No pending requests')}</div>`)
      + (D.length ? `<div class="pcard">${overline('Recent', D.length)}${D.map((r) => row({ title: r.agent_label || '—', meta: `${r.actions.join(', ')} · ${midTrunc(r.resource, 36)}`, metaId: true, trail: `${stPill(r.status)}<span>${ago(r.decided_at || r.created_at)}</span>` })).join('')}</div>` : ''),
    after() {
      $$('.rqc').forEach((c) => {
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
      b: seg(C.length ? `<span class="meta">${fmtB(tot)} moved</span>` : '') + `<div class="pcard">` + (C.map((c) => row({ lead: ic('dl'),
          title: raw(`<span class="mono" title="${esc((c.from_label || c.from) + ' → ' + (c.to_label || c.to))}">${esc(c.from_label || trunc(String(c.from), 12))} → ${esc(c.to_label || String(c.to))}</span>`),
          meta: c.failure_reason ? c.failure_reason : `${c.mode} · ${fmtB(c.bytes_moved || 0)}${c.size ? ' of ' + fmtB(c.size) : ''} · ${ago(c.created_at)} ago${c.purpose ? ' · ' + c.purpose : ''}`,
          trail: `${stPill(c.status)}${['offered', 'open'].includes(c.status) ? `<button type="button" class="btn sm" data-cc="${esc(c.channel_id)}" aria-label="Close channel">${ic('x')}Close</button>` : ''}` })).join('') || none('dl', 'No channels')) + '</div>',
      after() { $$('[data-cc]').forEach((b) => arm(b, () => run(async () => { await post(`/channels/${b.dataset.cc}/close`); toast('Closed'); reopen(); }))); },
    };
  }
  const L = (await api('/shares')).shares;
  return { t: `${ic('link')}Shares <span class="n">${L.length}</span>`, b: seg() + `<div class="pcard">${L.map((s) => row({ lead: ic('link'), title: s.name, meta: `${s.author_label || 'Unknown'} · v${s.versions.length} · ${ago(s.updated_at)} ago`, trail: stPill(s.status), chev: true, attrs: { 'data-share': s.id } })).join('') || none('link', 'No shares')}</div>` };
};
VIEWS.share = async (id) => {
  const sp = '/shares/' + encodeURIComponent(id);
  const [{ share: s }, V, F] = await Promise.all([api(sp), api(`${sp}/versions`), api(`${sp}/feedback`)]);
  const revoke = () => run(async () => { await post(`${sp}/revoke`); toast('Revoked'); reopen(); });
  const del = () => run(async () => { await api(sp, 'DELETE'); toast('Deleted'); DR.stack.length ? back() : openD('shares', null, true); });
  const who = s.recipients.map((r) => (r.startsWith('agent:') ? agLabel(r.slice(6)) : r)).join(', ');
  return {
    t: `${ic('link')}<span class="ellip">${esc(s.name)}</span>${stPill(s.status)}`,
    dbar: { title: s.name, meta: `${cap(s.status.replace('_', ' '))} · ${s.author_label || 'Unknown author'}`,
      menu: [s.status !== 'revoked' ? { label: 'Revoke share', icon: 'ban', bad: true, confirm: 'Tap again to revoke', fn: revoke } : null, { label: 'Delete share', icon: 'trash', bad: true, confirm: 'Tap again to delete', fn: del }] },
    b: `<div class="pcard kvc">${kv('Status', stPill(s.status))}${kv('Author', esc(s.author_label || '—'))}${kv('Recipients', `<span title="${esc(who)}">${esc(who || '—')}</span>`)}${kv('Updated', esc(dt(s.updated_at)))}</div>` +
      `<div class="pcard">${overline('Versions', V.versions.length)}${V.versions.slice().reverse().map((v) => `<div class="vers">${row({ group: true, expanded: false, title: `v${v.version}`, meta: `${v.upload_kind} · ${v.files.length} file${v.files.length === 1 ? '' : 's'} · ${fmtB(v.total_bytes)} · ${ago(v.created_at)} ago`, trail: stPill(v.status), attrs: { 'data-vtoggle': '' } })}<div class="vfiles" hidden>${v.note ? `<p class="rq-why">${esc(v.note)}</p>` : ''}${v.files.slice(0, 50).map((f) => row({ one: true, lead: ic('file'), title: raw(`<span class="mono" title="${esc(f.path)}">${esc(midTrunc(f.path, 40))}</span>`), trail: `<span>${fmtB(f.size)}</span>` })).join('')}</div></div>`).join('')}</div>` +
      (F.feedback.length ? `<div class="pcard">${overline('Feedback', F.feedback.length)}${F.feedback.map((f) => `<div class="fb"><div class="rq-hd"><span class="rq-who">${esc(f.author_label || 'Unknown')}</span><span class="meta">${esc(f.kind)} · v${f.version} · ${esc(f.status)} · ${ago(f.created_at)} ago</span></div>${f.path ? `<span class="mono rq-res">${esc(f.path)}${f.line ? ':' + esc(f.line) : ''}</span>` : ''}<p class="rq-why">${esc(f.body)}</p></div>`).join('')}</div>` : '') +
      `<div class="row only-d">${s.status !== 'revoked' ? `<button class="btn" id="shR">${ic('ban')}Revoke</button>` : ''}<button class="btn" id="shD">${ic('trash')}Delete</button></div>`,
    after() {
      $$('[data-vtoggle]').forEach((b) => (b.onclick = () => { const open = b.getAttribute('aria-expanded') !== 'true'; b.setAttribute('aria-expanded', String(open)); b.parentElement.querySelector('.vfiles').hidden = !open; }));
      const r = $('#shR'); r && arm(r, revoke);
      arm($('#shD'), del);
    },
  };
};

/* ---------- agent feedback (Work → Feedback; docs/feedback.md) ---------- */
/* Reports are written by agents. Every piece of their text goes through esc() or row()'s escaping, never into markup as is. */
const FB_F = { kind: '', tool: '', team: '', agent: '', q: '', sort: 'impact', group: false };
const FB_KIND = { bug: ['Bug', 'bug'], limitation: ['Limitation', 'limit'], wish: ['Wish', 'wish'] };
const FB_SEV = { blocking: 'Blocking', costly: 'Costly', minor: 'Minor' };
const FB_ST = { new: ['New', 'info'], needs_info: ['Needs info', 'warn'], accepted: ['Accepted', 'acc'], fixed: ['Fixed', 'ok'], wont_fix: ["Won't fix", 'idle'], duplicate: ['Duplicate', 'idle'], withdrawn: ['Withdrawn', 'idle'] };
const FB_OPEN = ['new', 'needs_info', 'accepted'];
const FB_EMPTY = { new: 'No new reports', open: 'Nothing open', closed: 'Nothing closed' };
const fbStatusName = (s) => (FB_ST[s] || [s])[0];
const fbStatus = (s) => pill(fbStatusName(s), (FB_ST[s] || [0, 'idle'])[1]);
const fbPlural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
/* The kind glyph: a different shape per kind (bug, limitation, wish), never colour only. */
const fbGlyph = (kind) => { const [l, i] = FB_KIND[kind] || [kind, 'note']; return `<span class="pl-lead" role="img" aria-label="${esc(l)}" title="${esc(l)}">${ic(i)}</span>`; };
const fbCost = (c) => (c ? [c.extra_calls ? `${fmt(c.extra_calls)} calls` : '', c.extra_tokens ? `${kTok(c.extra_tokens)} tokens` : '', c.minutes_lost ? `${fmt(c.minutes_lost)} min` : ''].filter(Boolean).join(' · ') : '');
function fbRow(r, bucket) {
  const sum = bucket === 'open' ? fbCost(r.cost_sum) : '';
  return row({ lead: fbGlyph(r.kind), title: r.title,
    meta: [r.tool || r.area, r.error_code, fbPlural(r.backers, 'agent', 'agents'), sum && 'est. ' + sum, ago(r.last_seen_at)].filter(Boolean).join(' · '),
    trail: (r.reopen_count && r.status === 'new' ? pill('Reopened', 'warn') : '') + (r.severity === 'blocking' ? pill('Blocking', 'bad') : ''), chev: true, attrs: { 'data-fb': r.id } });
}
/* The list: rows in impact order, or under an overline per tool or area when grouped. */
function fbList(reports, bucket) {
  if (!reports.length) return none('wish', FB_EMPTY[bucket]);
  if (!FB_F.group) return reports.map((r) => fbRow(r, bucket)).join('');
  const by = new Map();
  for (const r of reports) { const k = r.tool || r.area; by.set(k, [...(by.get(k) || []), r]); }
  return [...by].map(([k, g]) => overline(k, g.length) + g.map((r) => fbRow(r, bucket)).join('')).join('');
}
const fbQuery = (bucket) => { const q = new URLSearchParams({ bucket, sort: FB_F.sort }); for (const k of ['kind', 'tool', 'team', 'agent', 'q']) if (FB_F[k]) q.set(k, FB_F[k]); return q; };
const fbFilterN = () => ['kind', 'tool', 'team', 'agent', 'q'].filter((k) => FB_F[k]).length + (FB_F.sort !== 'impact' ? 1 : 0) + (FB_F.group ? 1 : 0);
/* Copy a report, or the filtered list, as Markdown or JSON, ready to paste into an issue tracker. The hub audits every export. */
async function fbExport(params, format) {
  const q = new URLSearchParams({ ...params, format });
  const r = await fetch('/api/feedback/export?' + q, { credentials: 'same-origin' });
  if (!r.ok) { const j = await r.json().catch(() => ({})); throw Object.assign(new Error(j.message || 'Export failed'), { status: r.status }); }
  copy(await r.text());
}
const fbExportItems = (params) => [{ label: 'Export as Markdown', icon: 'dl', fn: () => run(() => fbExport(params, 'md')) }, { label: 'Export as JSON', icon: 'dl', fn: () => run(() => fbExport(params, 'json')) }];
/* Hub-wide switches: feedback on or off, and agents seeing only their own reports. */
function openFbSettings(btn, set) {
  const L = set.limits;
  const sh = openSheet({ title: 'Feedback settings', anchor: btn, html: `<div class="sheet-form"><div>
    ${row({ one: true, as: 'div', title: 'Agents can use feedback', trail: info('Off: every feedback tool is refused for every agent.') + switchBtn('Agents can use feedback', set.enabled, 'data-fbs="enabled"') })}
    ${row({ one: true, as: 'div', title: 'Agents see only their own', trail: info('On: an agent finds and reads only the reports it filed or backed.') + switchBtn('Agents see only their own reports', set.own_only, 'data-fbs="own_only"') })}
    ${row({ one: true, as: 'div', title: 'Rate limits', trail: info(`Per agent: ${L.reportsPerHour} new reports an hour, ${L.reportsPerDay} a day, ${L.entriesPerHour} entries an hour. Hub-wide: ${L.hubReportsPerDay} new reports a day.`) + `<span>${L.reportsPerHour} an hour</span>` })}
    </div><div class="sheet-acts"><button type="button" class="btn pri lg" data-sheet-close>Done</button></div></div>` });
  sh.addEventListener('click', (e) => {
    const b = e.target.closest('[data-fbs]'); if (!b) return;
    const on = flipSwitch(b);
    run(async () => { await api('/feedback/settings', 'PUT', { [b.dataset.fbs]: on }); toast('Saved'); set[b.dataset.fbs] = on; refresh(); });
  });
}
function openFbFilters(btn, tools, draw) {
  const sh = openSheet({ title: 'Filter reports', anchor: btn, html: `<div class="sheet-form">
    ${selField('fbK', 'Kind', [['', 'Any kind'], ...Object.entries(FB_KIND).map(([v, [l]]) => [v, l])], FB_F.kind)}
    ${selField('fbT', 'Tool or area', [['', 'Any tool or area'], ...tools.map((t) => [t, t])], FB_F.tool)}
    ${selField('fbTm', 'Team', [['', 'Any team'], ...S.teams.map((t) => [t.id, t.name])], FB_F.team)}
    ${selField('fbA', 'Agent', [['', 'Any agent'], ...S.agents.map((a) => [a.id, a.label])], FB_F.agent)}
    ${selField('fbS', 'Sort by', [['impact', 'Impact'], ['recent', 'Last seen']], FB_F.sort)}
    <label class="fld"><span class="vlabel">Search</span><div class="srch">${ic('search')}<input class="inp" id="fbQ" type="search" placeholder="Title, tool, error code" aria-label="Search reports" value="${esc(FB_F.q)}"></div></label>
    ${row({ one: true, as: 'div', title: 'Group by tool or area', trail: switchBtn('Group by tool or area', FB_F.group, 'id="fbG"') })}
    <div class="sheet-acts"><button type="button" class="btn lg" id="fbClear">Clear</button><button type="button" class="btn pri lg" data-sheet-close>Done</button></div></div>` });
  [['#fbK', 'kind'], ['#fbT', 'tool'], ['#fbTm', 'team'], ['#fbA', 'agent'], ['#fbS', 'sort']].forEach(([s, k]) => ($(s, sh).onchange = () => { FB_F[k] = $(s, sh).value; draw(); }));
  onSearch($('#fbQ', sh), (q) => { FB_F.q = q; draw(); });
  $('#fbG', sh).onclick = (e) => { FB_F.group = flipSwitch(e.currentTarget); draw(); };
  $('#fbClear', sh).onclick = () => { Object.assign(FB_F, { kind: '', tool: '', team: '', agent: '', q: '', sort: 'impact', group: false }); closeSheet(); draw(); };
}
VIEWS.feedback = async (arg) => {
  const bucket = ['new', 'open', 'closed'].includes(arg) ? arg : 'new';
  FB_Q.bucket = bucket; // a report opened from here steps through this list
  const [d, set] = await Promise.all([api('/feedback?' + fbQuery(bucket)), api('/feedback/settings')]);
  S.fbc = { ...(S.fbc || {}), ...d.counts };
  const seg = [['new', 'New'], ['open', 'Open'], ['closed', 'Closed']];
  const exportParams = () => Object.fromEntries(fbQuery(bucket));
  return {
    t: `${ic('wish')}Feedback <span class="n">${d.counts.new + d.counts.open}</span>`,
    a: `<button type="button" class="btn sm" id="fbEx">${ic('dl')}Export</button><button type="button" class="btn sm" id="fbSet">${ic('shield')}Settings</button>`,
    pmenu: [...fbExportItems(exportParams()), { label: 'Feedback settings', icon: 'shield', fn: () => openFbSettings(null, set) }],
    b: (set.enabled ? '' : vnote('Feedback is turned off. Agents cannot file or read reports until you turn it on in Settings.'))
      + vtools(`<div class="seg eq" role="group" aria-label="Show">${seg.map(([k, l]) => `<button type="button" data-fbb="${k}" class="${k === bucket ? 'on' : ''}" aria-pressed="${k === bucket}">${l}${d.counts[k] ? ' ' + d.counts[k] : ''}</button>`).join('')}</div>${filterBtn('fbMore', fbFilterN())}`)
      + `<div class="pcard" id="fbL">${fbList(d.reports, bucket)}</div>`,
    after() {
      const L = $('#fbL');
      const draw = async () => { setFilterCount('fbMore', fbFilterN()); const r = await api('/feedback?' + fbQuery(bucket)); if (L.isConnected) L.innerHTML = fbList(r.reports, bucket); };
      $('#fbMore').onclick = (e) => openFbFilters(e.currentTarget, d.tools, () => run(draw));
      $('#fbEx').onclick = (e) => openMenu(fbExportItems(exportParams()), e.currentTarget);
      $('#fbSet').onclick = (e) => openFbSettings(e.currentTarget, set);
    },
  };
};
/* A sheet with a short form: fields (trusted markup), a Cancel and one action. onGo returns an error message to keep the sheet open. */
function fbSheet({ title, fields, label, tone = 'pri', anchor, onGo }) {
  const sh = openSheet({ title, anchor, html: `<div class="sheet-form">${fields}<span class="err" id="fbErr" role="alert"></span><div class="sheet-acts"><button type="button" class="btn lg" data-sheet-close>Cancel</button><button type="button" class="btn ${tone} lg" id="fbGo">${esc(label)}</button></div></div>` });
  $('#fbGo', sh).onclick = () => run(async () => { const err = await onGo(sh); if (err) { $('#fbErr', sh).textContent = err; return; } closeSheet(); });
  return sh;
}
const fbArea = (id, label, max, rows = 3) => `<label class="fld"><span class="vlabel">${esc(label)}</span><textarea class="inp" id="${id}" rows="${rows}" maxlength="${max}"></textarea></label>`;
const fbVal = (sh, id) => $('#' + id, sh).value.trim();
const FB_FIELD = { status: 'Status', title: 'Title', severity: 'Severity', hidden: 'Visibility', merged_from: 'Merged from' };
const fbWho = (id, label) => (AG(id) ? `<a href="#" data-ses="${esc(id)}">${esc(label)}</a>` : esc(label));
const fbLinkH = (l) => (l.startsWith('/') ? vaultFileLink(l) : l.startsWith('share:') ? `<a href="#" data-share="${esc(l.slice(6))}">${esc(l)}</a>` : esc(l));
/* The report queue beside a report (from 1024 px) and the ‹ n of N › stepper: the reports of the list the operator came from
   (its bucket and filters), in the queue's own order. Impact = agents × (minutes lost + extra calls), from the agents' estimates. */
const FB_Q = { sort: 'impact', bucket: null, ids: [], scroll: 0 };
const FB_QSORT = [['impact', 'Impact'], ['new', 'Newest'], ['backed', 'Most backed']];
const fbImpact = (r) => r.backers * ((r.cost_sum?.minutes_lost || 0) + (r.cost_sum?.extra_calls || 0));
const fbQueueOrder = (L) => L.slice().sort((a, b) => FB_Q.sort === 'new' ? b.created_at - a.created_at : FB_Q.sort === 'backed' ? b.backers - a.backers : fbImpact(b) - fbImpact(a));
const fbBucketOf = (st) => (st === 'new' ? 'new' : ['needs_info', 'accepted'].includes(st) ? 'open' : 'closed');
const FB_BUCKET = { new: 'New', open: 'Open', closed: 'Closed' };
/* j / k and the stepper: the next or previous report in the queue. Replaces the route, so Back still returns to the list. */
function fbStep(dir) {
  const L = FB_Q.ids; if (!L.length || DR.type !== 'fbr') return;
  const i = L.indexOf(DR.arg), next = i < 0 ? L[0] : L[i + dir];
  if (next && next !== DR.arg) openD('fbr', next, true);
}
const FB_SEV_TONE = { blocking: 'bad', costly: 'warn', minor: 'idle' };
const FB_HIST = { title: 'Changed the title', severity: 'Changed the severity', hidden: 'Changed visibility', guidance: 'Changed the guidance', merged_from: 'Merged a report into this one', note: 'Note' };
VIEWS.fbr = async (id) => {
  const u = encodeURIComponent(id), fp = '/feedback/' + u;
  FB_Q.scroll = DR.type === 'fbr' ? $('#fbQ')?.scrollTop || 0 : 0;
  const [d, set] = await Promise.all([api(fp), api('/feedback/settings')]);
  const r = d.report, kindL = (FB_KIND[r.kind] || [r.kind])[0], isOpen = FB_OPEN.includes(r.status), canSet = isOpen || ['fixed', 'wont_fix'].includes(r.status);
  const bucket = (FB_Q.bucket ||= fbBucketOf(r.status)); // kept while stepping, so a report that changes status does not switch the queue
  const Q = fbQueueOrder((await api('/feedback?' + fbQuery(bucket)).catch(() => ({ reports: [] }))).reports);
  FB_Q.ids = Q.map((x) => x.id);
  const pos = FB_Q.ids.indexOf(id);
  // The sheets' guidance field: empty keeps the current guidance (edit or clear it in place on the report).
  const gLbl = (l) => (r.guidance ? 'New guidance (empty keeps the current one)' : l);
  const re = async () => { await refresh(); openD('fbr', id, true); };
  const setStatus = (body) => run(async () => { await post(fp + '/status', body); toast('Saved'); await re(); });
  const patch = (body) => run(async () => { await api(fp, 'PATCH', body); toast('Saved'); await re(); });
  const accept = (anchor) => fbSheet({ title: 'Accept report', anchor, label: 'Accept', fields: fbArea('fbN', 'Note for the agents (optional)', 2000) + fbArea('fbGd', gLbl('Guidance: a workaround or the right way to do it (optional)'), 2000),
    onGo: (sh) => { setStatus({ status: 'accepted', note: fbVal(sh, 'fbN') || null, guidance: fbVal(sh, 'fbGd') || undefined }); } });
  const fixed = (anchor) => fbSheet({ title: 'Mark fixed', anchor, label: 'Mark fixed', fields: fbArea('fbN', 'What changed', 2000)
      + `<label class="fld"><span class="vlabel">Hub version (optional)</span><input class="inp mono" id="fbV" maxlength="40" value="${esc(r.fixed_in || set.hub_version || '')}" autocomplete="off"></label>` + fbArea('fbGd', gLbl('Guidance (optional)'), 2000),
    onGo: (sh) => { const note = fbVal(sh, 'fbN'); if (!note) return 'Say what changed.'; setStatus({ status: 'fixed', note, fixed_in: fbVal(sh, 'fbV') || null, guidance: fbVal(sh, 'fbGd') || undefined }); } });
  const ask = () => fbSheet({ title: 'Ask a question', label: 'Ask', fields: fbArea('fbN', 'Your question for the filing agent', 2000),
    onGo: (sh) => { const note = fbVal(sh, 'fbN'); if (!note) return 'Write the question.'; setStatus({ status: 'needs_info', note }); } });
  const wont = () => fbSheet({ title: "Won't fix", label: "Won't fix", fields: fbArea('fbN', 'Reason', 2000) + fbArea('fbGd', gLbl('Guidance: what to do instead (optional)'), 2000),
    onGo: (sh) => { const note = fbVal(sh, 'fbN'); if (!note) return 'Give a reason.'; setStatus({ status: 'wont_fix', note, guidance: fbVal(sh, 'fbGd') || undefined }); } });
  const dup = async () => {
    const all = (await api('/feedback?sort=recent&limit=500')).reports.filter((x) => x.id !== id && !['duplicate', 'withdrawn'].includes(x.status));
    if (!all.length) return toast('No other report to merge into', true);
    fbSheet({ title: 'Mark duplicate of', label: 'Mark duplicate', fields: selField('fbT', 'Continues as', all.map((x) => [x.id, `${trunc(x.title, 60)} (${x.id})`]), all[0].id),
      onGo: (sh) => { const target = $('#fbT', sh).value; run(async () => { await post(fp + '/merge', { target_id: target }); toast('Merged'); await refresh(); openD('fbr', target, true); }); } });
  };
  const severity = () => fbSheet({ title: 'Change severity', label: 'Save', fields: selField('fbSv', 'Severity', Object.entries(FB_SEV), r.severity), onGo: (sh) => { patch({ severity: $('#fbSv', sh).value }); } });
  const title = () => fbSheet({ title: 'Edit title', label: 'Save', fields: `<label class="fld"><span class="vlabel">Title (one line, at most 120 characters)</span><input class="inp" id="fbTi" maxlength="120" value="${esc(r.title)}" autocomplete="off"></label>`,
    onGo: (sh) => { const t = fbVal(sh, 'fbTi'); if (!t) return 'The title cannot be empty.'; patch({ title: t }); } });
  const del = () => run(async () => { await api(fp, 'DELETE'); toast('Deleted'); await refresh(); DR.stack.length ? back() : openD('feedback', undefined, true); });
  // The primary action follows the status; the other statuses and Merge sit in its menu (a split button), the rest in the overflow.
  const prim = r.status === 'new' ? ['accept', 'Accept'] : r.status === 'accepted' ? ['fixed', 'Mark fixed'] : null;
  const statusMenu = [
    r.status === 'new' ? { label: 'Accept', icon: 'check', fn: () => accept(null) } : null,
    ['new', 'accepted'].includes(r.status) ? { label: 'Ask a question', icon: 'chat', fn: ask } : null,
    isOpen ? { label: "Won't fix", icon: 'ban', fn: wont } : null,
    !isOpen && canSet ? { label: 'Reopen as new', icon: 'rot', fn: () => setStatus({ status: 'new' }) } : null,
    r.status !== 'duplicate' && r.status !== 'withdrawn' ? { label: 'Merge into another report…', icon: 'link', fn: () => run(dup) } : null,
  ].filter((m) => m && !(prim && m.label === prim[1]));
  const otherMenu = [
    { label: 'Change severity', icon: 'warn', fn: severity },
    { label: 'Edit title', icon: 'edit', fn: title },
    { label: r.hidden ? 'Show to other agents' : 'Hide from other agents', icon: 'eye', fn: () => patch({ hidden: !r.hidden }) },
    ...fbExportItems({ ids: id }),
    { label: 'Delete report', icon: 'trash', bad: true, confirm: 'Tap again to delete', fn: del },
  ];
  const split = prim
    ? `<span class="split"><button type="button" class="btn sm pri" data-fba="${prim[0]}">${ic('check')}${prim[1]}</button>${statusMenu.length ? `<button type="button" class="btn sm pri ic" data-fbsm aria-label="Other statuses" aria-haspopup="dialog">${ic('chev', 'dn')}</button>` : ''}</span>`
    : statusMenu.length ? `<button type="button" class="btn sm" data-fbsm aria-haspopup="dialog">Status${ic('chev', 'dn')}</button>` : '';
  const stepper = (cls = '') => FB_Q.ids.length ? `<span class="fb-step${cls}" role="group" aria-label="Reports in ${FB_BUCKET[bucket]}"><button type="button" class="btn sm ic" data-fstep="-1" aria-label="Previous report"${pos > 0 ? '' : ' disabled'}>${ic('back')}</button>`
    + `<span class="meta">${pos < 0 ? `${FB_Q.ids.length} in ${FB_BUCKET[bucket]}` : `${pos + 1} of ${FB_Q.ids.length}`}</span><button type="button" class="btn sm ic" data-fstep="1" aria-label="Next report"${pos < FB_Q.ids.length - 1 ? '' : ' disabled'}>${ic('chev')}</button></span>` : '';

  // Impact strip: what this costs, from the agents' own estimates summed over the report and its entries. Zeros are left out.
  const c = r.cost;
  const sums = d.entries.reduce((a, e) => ({ extra_calls: a.extra_calls + (e.cost?.extra_calls || 0), extra_tokens: a.extra_tokens + (e.cost?.extra_tokens || 0), minutes_lost: a.minutes_lost + (e.cost?.minutes_lost || 0) }), { extra_calls: c?.extra_calls || 0, extra_tokens: c?.extra_tokens || 0, minutes_lost: c?.minutes_lost || 0 });
  const fig = (v, label, f = fmt) => (v ? `<span class="fbi"><b>${f(v)}</b><span>${label}</span></span>` : '');
  const others = d.backers.filter((b) => !b.filer).length;
  const impact = `<div class="fb-impact">${pill(FB_SEV[r.severity] || r.severity, FB_SEV_TONE[r.severity] || 'idle')}${fig(d.backers.length, d.backers.length === 1 ? 'agent' : 'agents')}${fig(sums.extra_calls, 'extra calls')}${fig(sums.extra_tokens, 'extra tokens', kTok)}${fig(sums.minutes_lost, 'min lost')}${fig(others, 'backed')}`
    + `${r.tool || r.area ? `<span class="tag">${esc(r.tool || r.area)}</span>` : ''}${info("The agents' own estimates, summed over the report and its entries.")}</div>`;

  // Decision: the note and the guidance agents see. Guidance edits in place.
  const decision = `<section class="pcard fb-sec fb-guide">${overline('Guidance for agents', null, info("Agents see it with the report once it is accepted, fixed, answered, won't fix or a duplicate, and in the hint on the same error only while it is accepted or won't fix. On a new report it stays hidden until you decide."))}
    <div class="fb-gview">${r.guidance ? `<p class="fb-text">${esc(r.guidance)}</p>` : '<p class="faint">No guidance yet.</p>'}<button type="button" class="btn sm" id="fbGEdit">${ic('edit')}${r.guidance ? 'Edit' : 'Write guidance'}</button></div>
    <div class="fb-gedit" hidden><textarea class="inp" id="fbGTxt" rows="3" maxlength="2000" aria-label="Guidance for agents">${esc(r.guidance || '')}</textarea><div class="row"><button type="button" class="btn sm" id="fbGCancel">Cancel</button><button type="button" class="btn sm pri" id="fbGSave">Save guidance</button></div></div>
    ${r.status_note ? `${overline(r.status === 'needs_info' ? 'Your question' : 'Note')}<p class="fb-text">${esc(r.status_note)}</p>` : ''}</section>`;
  const cells = [['Tried', r.tried], ['Happened', r.happened], ['Expected', r.expected], ['Workaround', r.workaround]].filter(([, v]) => v);
  const account = cells.length ? `<section class="pcard fb-sec">${overline("Agent's account", null, info('Written by the agent that filed it, shown as plain text.'))}<div class="fb-acct">${cells.map(([k, v]) => `<div class="fb-cell">${overline(k)}<p class="fb-text">${esc(v)}</p></div>`).join('')}</div></section>` : '';

  // Side: the facts, who is affected, and the hub's own evidence. Empty fields are left out.
  const kvs = [
    kv('Status', fbStatus(r.status) + (r.reopen_count ? ' ' + pill(`Reopened ${r.reopen_count}×`, 'warn') : '')),
    kv('Severity', pill(FB_SEV[r.severity] || r.severity, FB_SEV_TONE[r.severity] || 'idle')),
    kv('Kind', esc(kindL)), r.tool ? kv('Tool', esc(r.tool), { id: true }) : '', r.area && r.area !== r.tool ? kv('Area', esc(r.area)) : '', r.error_code ? kv('Error code', esc(r.error_code), { id: true }) : '',
    kv('Filed by', fbWho(r.filer_agent_id, d.filer.label)), kv('Filed', esc(dt(r.created_at))), d.filer.client ? kv('Client', esc(d.filer.client)) : '', r.hub_version ? kv('Hub version', esc(r.hub_version), { id: true }) : '',
    r.fixed_in ? kv('Fixed in', esc(r.fixed_in), { id: true }) : '', r.hidden ? kv('Visibility', pill('Hidden', 'idle')) : '',
    d.notices.notified ? kv(raw(`Last decision ${info('How many agents received the latest status notice, and how many have confirmed it.')}`), `${d.notices.seen} of ${d.notices.notified} seen`) : '',
  ].join('');
  const bkRow = (b) => row({ as: 'div', one: true, lead: `<span class="av">${esc(initials(b.label))}</span>`, title: raw(fbWho(b.agent_id, b.label)), trail: b.filer ? '<span>Filer</span>' : `<span title="${esc([b.teams.map((t) => t.name).join(', '), b.app, b.client].filter(Boolean).join(' · '))}">${ago(b.since)}</span>` });
  const E = d.hub_evidence;
  const callRow = (x) => row({ one: true, cls: 'aud', attrs: { 'data-go': 'log', 'data-arg': `calls|agent:${x.agent_id}`, title: `${x.tool} · ${x.invocation_id} · ${x.agent_label}` }, title: raw(`<time title="${esc(new Date(x.created_at).toLocaleString())}">${esc(dt(x.created_at))}</time>`),
    trail: x.result === 'ok' ? `<span>${esc(x.duration_ms)} ms</span>` : pill(x.result + (x.error_code && x.result !== 'denied' ? ' · ' + x.error_code : ''), x.result === 'denied' ? 'bad' : 'warn'), chev: true });
  const same = E.same_error_7d ? kv(raw(`Same error, 7 days ${info('Calls to this tool that failed with this error code, across all agents.')}`), `${fbPlural(E.same_error_7d.calls, 'call', 'calls')} · ${fbPlural(E.same_error_7d.agents, 'agent', 'agents')}`) : '';
  const evidence = same || E.calls.length ? `<section class="pcard fb-sec">${overline('Hub evidence', E.calls.length || null, info("Recorded by the hub, not written by an agent: the filer's calls to this tool in the 30 minutes before it filed. Open one in Calls."))}${same}${E.calls.slice(0, 12).map(callRow).join('')}</section>` : '';
  const side = `<aside class="fb-side" aria-label="Details"><section class="pcard fb-sec kvc">${kvs}</section>
    <section class="pcard fb-sec">${overline('Affected', d.backers.length)}${d.backers.map(bkRow).join('')}</section>${evidence}</aside>`;

  // One timeline: filed, backed, entries, status changes, edits and your notes, in time order. Bare +1s in a row fold into one line.
  const ENTRY = { plus_one: 'Backed it', evidence: 'Added evidence', answer: 'Answered', still_happening: 'Still happening', withdraw: 'Withdrew it' };
  const ev = [
    ...d.entries.map((e) => ({ at: e.created_at, bare: e.kind === 'plus_one' && !e.text, who: fbWho(e.agent_id, e.agent_label), what: (ENTRY[e.kind] || e.kind) + (e.from_report ? ` · from ${e.from_report}` : ''),
      body: `${e.text ? `<p class="fb-text">${esc(e.text)}</p>` : ''}${fbCost(e.cost) ? `<span class="meta">Estimate: ${esc(fbCost(e.cost))}</span>` : ''}${e.links.length ? `<span class="meta">${e.links.map(fbLinkH).join(', ')}</span>` : ''}` })),
    ...d.history.map((h) => {
      const who = h.actor_kind === 'admin' ? 'You' : h.actor_kind === 'agent' && h.actor_id ? fbWho(h.actor_id, h.actor_label) : esc(cap(h.actor_label));
      const what = h.field === 'status' ? (h.old_value ? `${fbStatusName(h.old_value)} → ${fbStatusName(h.new_value)}` : 'Filed the report')
        : h.field === 'merged_from' ? `Merged ${h.new_value} into this one` : h.field === 'guidance' ? (h.new_value ? 'Changed the guidance' : 'Removed the guidance')
        : h.field === 'note' ? 'Note' : `${FB_HIST[h.field] || h.field}${h.field === 'severity' ? `: ${FB_SEV[h.old_value] || h.old_value} → ${FB_SEV[h.new_value] || h.new_value}` : ''}`;
      const text = h.field === 'guidance' ? h.new_value : h.note;
      return { at: h.created_at, who, what, body: text ? `<p class="fb-text">${esc(text)}</p>` : '', note: h.field === 'note' };
    }),
  ].sort((a, b) => a.at - b.at);
  const evH = (e) => `<div class="fb${e.note ? ' fb-mine' : ''}"><div class="rq-hd"><span class="rq-who">${e.who}</span><span class="meta">${esc(e.what)} · ${esc(dt(e.at))}</span></div>${e.body}</div>`;
  const timeline = groupRuns(ev, (e) => e.bare, (e) => e.at, 3).map((x) => x.group
    ? `<div class="vgroup">${row({ as: 'div', group: true, expanded: false, cls: 'vg-head', extra: 'role="button" tabindex="0" data-gtoggle', title: `${x.group.length} agents backed it`, trail: `<span>${esc(dt(x.group[0].at))}</span>` })}<div class="vg-rows" hidden>${x.group.map(evH).join('')}</div></div>`
    : evH(x)).join('');
  const noteForm = `<form class="fb-note" id="fbNoteF"><input class="inp" id="fbNote" maxlength="2000" placeholder="Add a note (only you see it)" aria-label="Add a note to the timeline" autocomplete="off"><button type="submit" class="btn sm">Add</button></form>`;
  const dupNote = r.status === 'duplicate' && r.duplicate_of ? vnote(`Merged into <a href="#" data-fb="${esc(r.duplicate_of)}">${esc(r.duplicate_of)}</a>. Its backers and entries moved there.`) : '';
  const links = d.links.length ? `<section class="pcard fb-sec">${overline('Links', d.links.length)}${d.links.map((l) => row({ one: true, as: 'div', title: raw(`<span class="mono">${fbLinkH(l)}</span>`) })).join('')}</section>` : '';
  const dups = d.duplicates.length ? `<section class="pcard fb-sec">${overline('Merged into this report', d.duplicates.length)}${d.duplicates.map((x) => row({ title: x.title, meta: x.id, metaId: true, chev: true, attrs: { 'data-fb': x.id } })).join('')}</section>` : '';

  const queue = `<nav class="fb-queue" id="fbQ" aria-label="Reports in ${FB_BUCKET[bucket]}"><div class="fbq-hd">${overline(FB_BUCKET[bucket], Q.length)}<select class="sel" id="fbQs" aria-label="Order of the queue">${FB_QSORT.map(([v, l]) => `<option value="${v}"${v === FB_Q.sort ? ' selected' : ''}>${l}</option>`).join('')}</select></div>`
    + (Q.map((x) => row({ cls: 'fbq-row' + (x.id === id ? ' on' : ''), title: x.title, meta: [x.severity === 'blocking' ? 'Blocking' : '', x.tool || x.area, fbPlural(x.backers, 'agent', 'agents'), ago(x.created_at)].filter(Boolean).join(' · '),
      attrs: { 'data-fbq': x.id, title: x.title }, extra: x.id === id ? 'aria-current="true"' : '' })).join('') || none('wish', FB_EMPTY[bucket])) + '</nav>';
  return {
    t: `${fbGlyph(r.kind)}<span class="ellip">${esc(r.title)}</span>${fbStatus(r.status)}`,
    a: stepper() + split + `<button type="button" class="btn ic" id="fbMore" aria-label="More actions" aria-haspopup="dialog">${ic('more')}</button>`,
    dbar: { title: r.title, meta: `${kindL} · ${fbStatusName(r.status)} · ${fbPlural(r.backers, 'agent', 'agents')}`, menu: [...statusMenu, ...otherMenu] },
    b: `<div class="fbx">${queue}<div class="fb-rep">${stepper(' only-m')}${dupNote}${impact}<div class="fb-cols"><div class="fb-main">${decision}${account}
      <section class="pcard fb-sec fb-tl">${overline('Timeline', ev.length)}${timeline}${noteForm}</section>${links}${dups}</div>${side}</div></div></div>`
      + (prim ? `<div class="actionbar only-m"><button type="button" class="btn pri" data-fba="${prim[0]}">${ic('check')}${prim[1]}</button></div>` : ''),
    after() {
      $$('[data-fba]').forEach((b) => (b.onclick = () => (b.dataset.fba === 'accept' ? accept(b) : fixed(b))));
      $$('[data-fbsm]').forEach((b) => (b.onclick = () => openMenu(statusMenu, b)));
      $('#fbMore').onclick = (e) => openMenu(otherMenu, e.currentTarget);
      $$('[data-fstep]').forEach((b) => (b.onclick = () => fbStep(+b.dataset.fstep)));
      const qs = $('#fbQs'); if (qs) qs.addEventListener('change', (e) => { e.stopPropagation(); FB_Q.sort = qs.value; openD('fbr', id, true); });
      $$('[data-fbq]').forEach((b) => (b.onclick = () => { if (b.dataset.fbq !== id) openD('fbr', b.dataset.fbq, true); }));
      const q = $('#fbQ'); if (q) { q.scrollTop = FB_Q.scroll; const on = q.querySelector('.fbq-row.on'); if (on) { const qr = q.getBoundingClientRect(), orr = on.getBoundingClientRect(); if (orr.top < qr.top + 44 || orr.bottom > qr.bottom) on.scrollIntoView({ block: 'center' }); } }
      const gv = $('.fb-gview'), ge = $('.fb-gedit');
      $('#fbGEdit').onclick = () => { gv.hidden = true; ge.hidden = false; $('#fbGTxt').focus(); };
      $('#fbGCancel').onclick = () => { $('#fbGTxt').value = r.guidance || ''; ge.hidden = true; gv.hidden = false; viewEdited = false; $('#fbGEdit').focus(); };
      $('#fbGSave').onclick = () => patch({ guidance: $('#fbGTxt').value.trim() || null });
      $('#fbNoteF').onsubmit = (e) => { e.preventDefault(); const t = $('#fbNote').value.trim(); if (!t) return; run(async () => { await post(fp + '/notes', { text: t }); toast('Note added'); openD('fbr', id, true); }); };
    },
  };
};

/* ---------- events ---------- */
document.addEventListener('click', (e) => {
  const t = e.target;
  // In-app links are <a href="#"> handled below; without this each click also adds a '#' history entry.
  if (t.closest('a[href="#"]')) e.preventDefault();
  const dmore = t.closest('[data-dbar-more]'); if (dmore) { openOverflow(dmore); return; }
  if (t.closest('[data-dbar-back]')) { detailBack(); return; }
  const inf = t.closest('[data-info]'); if (inf) { if (matchMedia('(hover: none)').matches) openSheet({ title: 'Details', html: `<p>${esc(inf.dataset.info)}</p>` }); return; }
  const gt = t.closest('[data-gtoggle]'); if (gt) { const on = gt.getAttribute('aria-expanded') !== 'true'; gt.setAttribute('aria-expanded', String(on)); gt.nextElementSibling.hidden = !on; return; }
  const meB = t.closest('[data-me]'); if (meB) { if ($('#meMenu').hidden) openMe(meB); else closeMe(); return; }
  const mi = t.closest('[data-mi]'); if (mi) { closeMe(); closeSheet(); if (mi.dataset.mi === 'out') run(signOut); else go(mi.dataset.mi); return; }
  if (!t.closest('#meMenu')) closeMe();
  const c = t.closest('[data-copy]'); if (c) { const v = c.closest('[data-v]'); copy(v ? v.dataset.v : c.dataset.copy); return; }
  const ac = t.closest('[data-act]');
  if (ac) { const [kd, id] = ac.dataset.act.split('|'); run(async () => { if (kd === 'rqok' || kd === 'rqno') return decide(id, kd === 'rqok'); if (kd === 'asusp') await post('/alerts/' + id + '/suspend-key'); else await post('/alerts/' + id + '/' + kd); toast('✓'); await refresh(); if (DR.type === 'log') reopen(); }); return; }
  const lk = t.closest('[data-lk]'); if (lk) { const [sc, id, on] = lk.dataset.lk.split('|'); run(() => lock(sc, id, on === '1')); return; }
  const vp = t.closest('[data-vp]'); if (vp) { openD('vault', 'map|' + vp.dataset.vp); return; }
  const vf = t.closest('[data-vf]'); if (vf) { e.preventDefault(); openD('vault', { ...vaultState(), path: vf.dataset.vf, file: true }); return; }
  const vaultPath = t.closest('[data-vault-path]');
  if (vaultPath) {
    vaultPath.classList.add('busy'); $('.vault-detail')?.setAttribute('aria-busy', 'true');
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
  const fbr = t.closest('[data-fb]'); if (fbr) { e.preventDefault(); openD('fbr', fbr.dataset.fb); return; }
  const dir = t.closest('[data-dir]'); if (dir) { e.preventDefault(); openD('directive', dir.dataset.dir); return; }
  const dirs = t.closest('[data-dirs]'); if (dirs) { e.preventDefault(); openD('directives', dirs.dataset.dirs, true); return; }
  const dec = t.closest('[data-dec]'); if (dec) { e.preventDefault(); openD('dec', dec.dataset.dec); return; }
  const decs = t.closest('[data-decs]'); if (decs) { e.preventDefault(); openD('decisions', decs.dataset.decs, DR.type === 'decisions'); return; }
  const fbb = t.closest('[data-fbb]'); if (fbb) { openD('feedback', fbb.dataset.fbb, true); return; }
  const df = t.closest('[data-df]'); if (df) { openD('diff', df.dataset.df); return; }
  const grant = t.closest('[data-grant-flow]');
  if (grant) { openD(grant.dataset.grantFlow); return; }
  const nk = t.closest('[data-new-key]');
  if (nk) { openMenu([{ label: 'New session key', icon: 'key', fn: () => go('new') }, { label: 'New app key', icon: 'app', fn: () => go('app') }], nk); return; }
  const g = t.closest('[data-go]'); if (g) { closeSheet(); go(g.dataset.go, g.dataset.arg); return; }
  const ap = t.closest('[data-appr]'); if (ap && ap.dataset.appr.includes('|')) { const [tid, kid] = ap.dataset.appr.split('|'); run(async () => { await post(`/teams/${tid}/tasks/${kid}/approve`); toast('Approved'); await refresh(); if (DR.type === 'log') reopen(); }); return; }
  const el = t.closest('[data-end-logins]'); if (el) { run(async () => { await post(`/keys/${el.dataset.endLogins}/end-logins`); toast('Ended'); await refresh(); if (DR.type === 'log') reopen(); }); return; }
  const cb = t.closest('[data-ctx-back]'); if (cb) { if (DR.stack.length) back(); else go(DR.type === 'key' ? 'keys' : 'sessions'); return; }
  const stb = t.closest('[data-ses-tab]'); if (stb) { openD('ses', stb.dataset.sesTab, true); return; }
  const ss = t.closest('[data-ses]'); if (ss) { e.preventDefault(); openD('ses', ss.dataset.ses); return; }
  const tsv = t.closest('[data-tstatus]'); if (tsv) { openD('tstatus', tsv.dataset.tstatus); return; }
  const tkf = t.closest('[data-tasks-f]'); if (tkf) { openD('tasks', tkf.dataset.tasksF, true); return; }
  const tks = t.closest('[data-tasks]'); if (tks) { openD('tasks', tks.dataset.tasks); return; }
  const mbs = t.closest('[data-members]'); if (mbs) { openD('members', mbs.dataset.members); return; }
  const tss = t.closest('[data-tsettings]'); if (tss) { openD('tsettings', tss.dataset.tsettings); return; }
  const plf = t.closest('[data-plan-f]'); if (plf) { openD('plan', plf.dataset.planF, true); return; }
  const pln = t.closest('[data-plan]'); if (pln) { openD('plan', pln.dataset.plan); return; }
  const tsk = t.closest('[data-task]'); if (tsk) { openD('task', tsk.dataset.task); return; }
  const tmm = t.closest('[data-team]'); if (tmm) { openD('team', tmm.dataset.team); return; }
  const rm = t.closest('[data-room]'); if (rm) { openD('room', rm.dataset.room); return; }
  const k = t.closest('[data-key]'); if (k) { e.preventDefault(); openD('key', k.dataset.key); return; }
  const p = t.closest('[data-pc]'); if (p) openD('pcs');
});
$('#dBack').onclick = back;
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && SHEET) { e.preventDefault(); closeSheet(); return; }
  if (SHEET) return; // a sheet is modal: shortcuts wait until it closes
  if (e.key === 'Escape' && !$('#meMenu').hidden) { const b = $$('[data-me]').find((x) => x.getAttribute('aria-expanded') === 'true'); closeMe(); b && b.focus(); return; }
  if (!S.me) return;
  if (e.key === 'Escape') {
    // Escape while typing leaves the field; it must not navigate away and drop a drafted directive or form.
    if (e.target.matches?.('input,select,textarea')) { e.target.blur(); return; }
    if (DR.type === 'topology' && EGO.focus) { egoSet(null); return; }
    if (DR.type === 'topology' && TG_S.focus) { topoFocus(null); return; } back(); return;
  }
  if (e.target.matches?.('input,select,textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('[role=button],tr[data-key],tr[data-ses],.ev[data-df],.tm-row[tabindex]')) { e.preventDefault(); e.target.dispatchEvent(new MouseEvent('click', { bubbles: true })); return; }
  // Some layouts report Shift+/ as "/" with Shift held rather than "?".
  const key = e.key === '/' && e.shiftKey ? '?' : e.key.toLowerCase();
  // In Work → Directives, j and k move through the list (k is Keys elsewhere).
  if (DR.type === 'directives' && !$('#workspaceView').hidden && (key === 'j' || key === 'k')) { e.preventDefault(); dirStep(key === 'j' ? 1 : -1); return; }
  // On a feedback report, j and k step through the queue (k is Keys elsewhere).
  if (DR.type === 'fbr' && !$('#workspaceView').hidden && (key === 'j' || key === 'k')) { e.preventDefault(); fbStep(key === 'j' ? 1 : -1); return; }
  const m = { s: 'sessions', m: 'teams', c: 'chats', k: 'keys', p: 'pcs', v: 'vault', r: 'req', h: 'shares', o: 'lock', g: 'agents', l: 'log', t: 'theme', '?': 'shortcuts' }[key];
  if (m) { e.preventDefault(); closeMe(); go(m); }
});
/* An info tooltip that would run off the right edge opens leftwards instead. */
const placeInfo = (e) => { const b = e.target.closest?.('.info'); if (b) b.classList.toggle('end', b.getBoundingClientRect().left + 260 > innerWidth - 8); };
document.addEventListener('mouseover', placeInfo); document.addEventListener('focusin', placeInfo);
document.addEventListener('scroll', (e) => { if (e.target.classList?.contains('tabs')) tabsFadeOne(e.target); }, true);
let rz; addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { tabsFade(); if (S.me) { renderTopo(); renderAct(); renderTree(); renderAgentGraph(); } }, 120); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
setInterval(() => { if (!document.hidden) refresh(); }, 10000);
// The topology colours edges by 30 s activity, so poll faster while it is on screen.
setInterval(() => { if (!document.hidden && DR.type === 'topology') refresh(); }, 4000);
const clockTick = () => { $('#clock').textContent = clock(Date.now()); }; clockTick(); setInterval(clockTick, 10000); // HH:MM: seconds only in audit exports (design guidelines §6)

/* init */
$('#expInfo').innerHTML = info('Which vault folders agents can reach: more keys means more exposure.');
let th = 'dark'; try { th = localStorage.getItem('ah-theme') || 'dark'; } catch { /* ignore */ }
setTheme(th);
api('/me').then(enter, () => showLogin());
