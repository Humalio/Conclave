/**
 * The operator's console walk-through for 0.9.6: Add PC shows that it is working and a way on when the name is taken (1),
 * moved keys are named by their checkout, not its id, and the key id shows once (4), Rotate says what happens to the agent
 * and how the new key gets there (5), Feedback never shows a number next to an empty list (6), the same directive set for
 * several scopes is one row and "not read by everyone" filters (7), the lockdown chips say what they are and what X does (8),
 * and the small items (9): the 2FA warning, one meaning of "live", Connector versions under a search, Re-enrol's confirm,
 * no refused /api/me before sign-in, and what an empty Approve box grants. Mostly read from the source files; the pure
 * helpers run in a sandbox, and GET /api/session runs on a hub.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { buildApp, type App } from '../src/app.js';
import { testConfig, adminLogin } from './hub.js';

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), 'utf8').replace(/\r\n/g, '\n');
const js = read('public', 'app.js'), html = read('public', 'index.html');
const between = (a: string, b: string) => { const i = js.indexOf(a); expect(i, a).toBeGreaterThan(-1); return js.slice(i, js.indexOf(b, i)); };
const fn = (name: string) => { const i = js.indexOf(`function ${name}(`); expect(i, name).toBeGreaterThan(-1); return js.slice(i, js.indexOf('\n}\n', i) + 3); };
const run = <T>(code: string, ctx: Record<string, unknown> = {}): T => vm.runInNewContext(code, ctx) as T;

describe('1. Add PC', () => {
  const create = between('  async function create() {', '\n  }\n');
  it('the button is busy while the hub answers, and a second press does nothing', () => {
    expect(create).toContain('if (go.disabled) return;');
    expect(create).toContain("go.disabled = true; go.setAttribute('aria-busy', 'true');");
    expect(create).toContain('Getting the prompt…');
    expect(create).toContain("finally { if (!made) { go.disabled = false; go.removeAttribute('aria-busy'); go.innerHTML = label; } }");
  });
  it('a taken name points to the PC and to Re-enrol PC, since the code is shown only once', () => {
    expect(create).toContain("if (e.code !== 'conflict') throw e;");
    expect(create).toContain('already exists.');
    expect(create).toContain('use <b>Re-enrol PC</b> for a new code.');
    expect(create).toContain("$('#jnOpenPc', sh).onclick = () => { closeSheet(); openD('pc', p.id); };");
  });
});

describe('4. Moved keys', () => {
  const keyMoved = run<(k: object) => { title: string; by: string | null }>(`${between('const keyName = ', '\n')}\n${between('const keyMoved = ', '\n};\n')}\n};\nkeyMoved`);
  it('the title is the label; the checkout is named in words, and an old checkout id reads "a checkout"', () => {
    expect(keyMoved({ kind: 'session_key', label: 'dev key (moved by the Relay Engineering checkout)' })).toEqual({ title: 'dev key', by: 'the Relay Engineering checkout' });
    expect(keyMoved({ kind: 'session_key', label: 'dev key (moved by cko_ab12cd34)' })).toEqual({ title: 'dev key', by: 'a checkout' });
    expect(keyMoved({ kind: 'session_key', label: 'dev key' })).toEqual({ title: 'dev key', by: null });
  });
  it('the key page shows the name as its title, a Moved by row, and the key id once, in full', () => {
    expect(js).toContain('<span class="ctx-name">${esc(keyMoved(k).title)}</span></h2>');
    expect(js).not.toContain('<span class="tag">${esc(k.masked_key)}</span></h2>');
    expect(js).toContain("${keyMoved(k).by ? kv('Moved by', esc(cap(keyMoved(k).by))) : ''}");
    expect(js).toContain("${kv('Key id', esc(k.masked_key), { id: true })}");
  });
});

describe('5. Rotate secret', () => {
  const rotWhat = run<(k: object) => string>(`${between('const rotWhat = ', '\nfunction secretView')}\nrotWhat`);
  it('says who is signed out and how the new key arrives', () => {
    const s = rotWhat({ kind: 'session_key', agent: { label: 'Ayo' } });
    // Key handover: a connector PC gets the new key and the old one works until the PC user allows it; otherwise shown once.
    expect(s).toContain('Ayo keeps working with the old one until the PC user allows it');
    expect(s).toContain('Ayo is signed out until the new key, shown once, reaches it');
    const a = rotWhat({ kind: 'app_key', pc: { name: 'pc-tern9' } });
    expect(a).toContain('agents on pc-tern9 that log in through it are signed out');
    expect(a).toContain('Re-enrol PC hands a new key over instead');
  });
  it('the danger zone and the rotate sheet use it', () => {
    expect(js).toContain("${dz('rot', 'Rotate secret', rotWhat(k),");
    expect(js).toContain("The current key works until then; nothing changes if nobody allows it within 24 hours.");
  });
});

describe('6. Feedback', () => {
  const fbDefault = (fbc: object | null) => run<string>(`${between('const fbDefault = ', '\n')}\nfbDefault()`, { S: { fbc } });
  it('opens on Open when New is empty and reports are open, else on New', () => {
    expect(fbDefault({ new: 0, open: 1, closed: 0 })).toBe('open');
    expect(fbDefault({ new: 2, open: 1, closed: 0 })).toBe('new');
    expect(fbDefault({ new: 0, open: 0, closed: 3 })).toBe('new');
    expect(fbDefault(null)).toBe('new');
  });
  it('the number on the title counts the list shown', () => {
    const view = between('VIEWS.feedback = ', '\n};\n');
    expect(view).toContain("const bucket = ['new', 'open', 'closed'].includes(arg) ? arg : fbDefault();");
    expect(view).toContain('Feedback <span class="n">${d.counts[bucket]}</span>');
    expect(view).not.toContain('d.counts.new + d.counts.open');
  });
});

describe('7. Directives', () => {
  type D = { id: string; title: string; body: string; current: number; agents: number; twins?: D[] };
  const dirFold = run<(L: D[]) => D[]>(`${between('const dirTwinKey = ', '\n')}\n${between('const dirFold = ', '\n};\n')}\n};\ndirFold`);
  const d = (id: string, title: string, current: number, agents: number, body = 'Every timing cites its capture ID.'): D => ({ id, title, body, current, agents });
  it('the same rule set for several scopes is one row, with the reads added up', () => {
    const L = dirFold([d('a', 'Cite the capture ID', 0, 5), d('k', 'Never paste a key', 1, 47, 'Never.'), d('b', 'cite the capture ID ', 2, 3), d('c', 'Cite the capture ID', 0, 0)]);
    expect(L.map((x) => x.id)).toEqual(['a', 'k']);
    expect(L[0]).toMatchObject({ current: 2, agents: 8 });
    expect(L[0]!.twins!.map((x) => x.id)).toEqual(['b', 'c']);
    expect(L[1]!.twins).toBeUndefined();
    // A different text is a different rule.
    expect(dirFold([d('a', 'Same title', 0, 1, 'One.'), d('b', 'Same title', 0, 1, 'Two.')])).toHaveLength(2);
  });
  it('the row names every scope; ticking it ticks each directive; the pane names the others', () => {
    const row = fn('dirRow');
    expect(row).toContain('`${all.length} scopes`');
    expect(row).toContain('`Same rule for ${targets.join(\', \')}`');
    expect(js).toContain("for (const id of [chk.dataset.dchk, ...(DIR_UI.twins.get(chk.dataset.dchk) || []).map((x) => x.id)])");
    expect(fn('dirShowPane')).toContain('The same rule is also set for');
    expect(fn('dirShowPane')).toContain("$$('[data-dtw]', pane).forEach((b) => { b.onclick = () => dirSelect(b.dataset.dtw); });");
  });
  it('"not read by everyone" filters to those rules, the most unread first', () => {
    expect(fn('dirListHtml')).toContain('data-drd="behind"');
    expect(js).toContain("if (t.closest('[data-drd]')) { dirSet({ rd: t.closest('[data-drd]').dataset.drd });");
    expect(between('const dirOrdered = ', '\n};\n')).toContain("if (f.rd === 'behind') L.sort((a, b) => (b.agents - b.current) - (a.agents - a.current));");
  });
});

describe('8. Lockdown chips', () => {
  const render = fn('renderLock');
  it('say Locked, what the lock stops, open Lockdown, and the X says it lifts the lock', () => {
    expect(render).toContain('title="${esc(LK_WHAT[s])}"');
    expect(render).toContain('data-go="lock"');
    expect(render).toContain('Locked · ${esc(nm)}');
    expect(render).toContain('aria-label="Lift the lock on ${esc(nm)}"');
    expect(render).not.toContain('aria-label="Unlock"');
    const what = run<Record<string, string>>(`(${between('const LK_WHAT = ', '\n};\n').slice('const LK_WHAT = '.length)}\n})`);
    expect(Object.keys(what).sort()).toEqual(['agent', 'pc', 'team', 'vault', 'writes']);
    expect(what.pc).toBe('Lockdown on this PC: agents working through it cannot change anything; they can still read.');
  });
});

describe('9. The small items', () => {
  it('2FA reads as a warning, with the way to fix it on hover', () => {
    expect(html).toContain('title="Your admin login has no second factor. Set up 2FA in Account."><svg class="i"><use href="#i-warn"/></svg>No 2FA</button>');
    expect(html).not.toContain('Enrol 2FA');
  });
  it('PCs are Connected, and app keys have agents signed in: one meaning of "live" on the PCs page', () => {
    expect(js).toContain("['live', 'Connected', (p) =>");
    expect(fn('pcRow')).toContain("${live ? `<span class=\"ok-t\">${live} signed in</span>` : 'no one signed in'}");
    expect(fn('pcRow')).not.toContain('none live');
  });
  it('Connector versions steps aside while the search narrows the PCs', () => {
    expect(js).toContain("const verCard = () => { const c = $('#pcVer'); if (c) c.hidden = !!PCF.q; }; verCard();");
    expect(js).toContain("onSearch($('#pcQ'), (v) => { PCF.q = v; $('#pcL').innerHTML = pcList(); tipIcons($('#pcL')); verCard(); });");
  });
  it("Re-enrol PC's confirmation says the keys are revoked now", () => {
    expect(js).toContain("arm($('#pcReEnrol'), () => run(() => obReEnrol(p)), 'Yes, revoke its keys now');");
  });
  it('the console asks GET /api/session before /api/me', () => {
    expect(js).toContain("fetch('/api/session', { credentials: 'same-origin' }).then((r) => r.json()).then((x) => (x.signed_in ? start() : showLogin()), start);");
  });
  it('the Approve box says what leaving both fields empty grants', () => {
    expect(js).toContain('Left empty, Approve grants what was asked: ${esc(r.actions.join(\', \'))} on the whole resource, for ${r.requested_duration_s ? fmtD(Math.min(r.requested_duration_s, 7 * 86400)) : \'1 hour\'}.');
  });
});

describe('9. GET /api/session', () => {
  let app: App, base = '';
  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ahsess-')); mkdirSync(join(dir, 'vault'), { recursive: true });
    app = await buildApp(testConfig(dir, { maintenanceSeconds: undefined }));
    await app.store.ready;
    await app.fastify.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.fastify.server.address() as { port: number }).port}`;
  });
  afterAll(async () => { await app.close(); });
  const session = async (cookie?: string) => { const r = await fetch(`${base}/api/session`, { headers: cookie ? { cookie } : {} }); return { status: r.status, body: await r.json() }; };
  it('answers 200 with signed_in only, before and after sign-in and after sign-out', async () => {
    expect(await session()).toEqual({ status: 200, body: { signed_in: false } });
    expect(await session('ah_sid=not-a-session')).toEqual({ status: 200, body: { signed_in: false } });
    const admin = await adminLogin(base);
    expect(await session(admin.cookie)).toEqual({ status: 200, body: { signed_in: true } });
    const out = await fetch(`${base}/api/logout`, { method: 'POST', headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf } });
    expect(out.status).toBeLessThan(300);
    expect(await session(admin.cookie)).toEqual({ status: 200, body: { signed_in: false } });
  });
});
