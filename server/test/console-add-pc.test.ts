/**
 * The Add dialog (docs/onboarding.md#1-one-key-add-pc-and-the-prompt): the header Add button, the More sheet and the command
 * list say just "Add" and open on "What do you want to add?" (a new PC, or a team on a PC that is already connected); the PCs
 * page's Add PC opens straight on the new-PC screen with Back to the choices. The new-PC screen says what it is for, asks for
 * the PC's coding agent and names that agent in the paste line. Add PC and Re-enrol PC show only the connector prompt, or
 * why there is none. The onboarding prompt tells no one to restart Claude Code or
 * run `claude`. Read from the source files.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const read = (...p: string[]) => readFileSync(join(process.cwd(), '..', ...p), 'utf8').replace(/\r\n/g, '\n');
const js = read('server', 'public', 'app.js');
const fn = (name: string) => { const i = js.indexOf(`function ${name}(`); return js.slice(i, js.indexOf('\n}\n', i) + 3); };

describe('Add button', () => {
  it('is just "Add" in the header, the More sheet and the command list', () => {
    const html = read('server', 'public', 'index.html');
    expect(html).toMatch(/<button class="btn join hide-m" id="joinBtn" aria-label="Add" title="Add: a new PC or a team">[^]*?<\/svg>Add<\/button>/);
    expect(js).toContain("{ label: 'Add', icon: 'plus', fn: () => joinSheet(null) },");
    expect(js).toContain("item('join', 'plus', 'Add', '', '')");
    expect(js).not.toContain("'Add PC', icon");
  });
  it('the PCs page keeps Add PC and opens on the new-PC screen', () => {
    expect(js).toContain("const obAddPc = () => joinSheet(null, 'pc');");
  });
});

describe('Add dialog', () => {
  const sheet = fn('joinSheet');
  it('opens on "What do you want to add?" with a new PC and a team, and no invented agent flow', () => {
    expect(sheet).toContain("function joinSheet(anchor, start = 'choose')");
    expect(sheet).toContain("title: 'What do you want to add?'");
    expect(sheet).toContain('<b>A new PC</b><span>Connect a new PC to Conclave and set up its security and keys. Its first team comes with it.</span>');
    expect(sheet).toContain("<b>A team</b><span>On a PC that's already connected${known}</span>");
    expect(sheet).not.toMatch(/An agent to a team/);
    // A team opens the existing New team screen.
    expect(sheet).toContain("$('#jnOptTeam', sh).onclick = () => { closeSheet(); go('tbuild'); };");
  });
  it('lists the active PCs by name, at most four', () => {
    const known = js.slice(js.indexOf('const joinKnown'), js.indexOf('const JN_CLIENTS'));
    expect(known).toContain("p.status === 'active'");
    expect(known).toContain('n.slice(0, 4)');
  });
  it('the new-PC screen says what it is for, asks for the coding agent and has Back until the prompt exists', () => {
    expect(sheet).toContain('Use this to connect a new PC to Conclave and set up its security and keys.');
    expect(sheet).toContain("The PC's coding agent");
    expect(js).toContain("const JN_CLIENTS = [['claude_code', 'Claude Code'], ['codex', 'Codex'], ['other', 'Another agent']];");
    expect(sheet).toContain("'Connect a new PC'");
    expect(sheet).toContain("back.setAttribute('aria-label', 'Back to the choices')");
    expect(sheet).toContain('back.hidden = v !== \'pc\' || !!made;');
    expect(sheet).toContain('view(start);');
  });
  it('names the chosen agent in the paste line and shows the waiting line', () => {
    expect(sheet).toContain('<b>3.</b> Open <b>${esc(jnAgent(client))}</b> on <b>${esc(made.pc.name)}</b> and paste this prompt into it. The prompt holds no code and no key');
    expect(js).toContain("const jnAgent = (c) => (c === 'other' ? 'your coding agent' : promptClient(c));");
    expect(sheet).toContain("Waiting for <b>${esc(made.pc.name)}</b>. You'll approve its request here.");
    expect(sheet).not.toMatch(/into Claude Code/);
    expect(fn('obPromptSheet')).toContain('Then paste this into the coding agent (Claude Code, Codex or another) on <b>');
  });
});

/* Add PC and Re-enrol PC show only the connector prompt (connector_prompt); the legacy setup.mjs prompt is gone from the hub. */
describe('only the connector prompt', () => {
  const sheet = fn('joinSheet'), re = fn('obPromptSheet');
  it('never reads the legacy prompt', () => {
    for (const f of [sheet, re]) expect(f).not.toMatch(/\.prompt\.text|\.prompt\.hashes|prompt\?\.hashes/);
    expect(sheet).toContain('const text = () => joinPrompt(made.connector_prompt, want.value);');
    expect(re).toContain('data-v="${esc(r.connector_prompt)}"');
    expect(re).toContain('b.dataset.copy = r.connector_prompt;');
  });
  it('shows the pairing code and the hub check as chips for the connector\'s pairing screen, in both sheets', () => {
    const pair = js.slice(js.indexOf('const obPairH = '), js.indexOf('const OB_NO_PROMPT'));
    expect(pair).toContain("open the connector's pairing screen and enter the code <code class=\"ob-chip\">${esc(p.code)}</code> and the hub check <code class=\"ob-chip\">${esc(p.ca_check)}</code>");
    expect(sheet).toContain("${obPairH(made, '<b>2.</b> ')}");
    expect(re).toContain('${obPairH(r)}');
    expect(read('server', 'public', 'style.css')).toMatch(/\.ob-chip\{[^}]*border-radius:var\(--r-chip\)/);
  });
  it('without a connector prompt says why (no CA, or no HTTPS address), offers no Copy and falls back to nothing', () => {
    const no = js.slice(js.indexOf('const OB_NO_PROMPT = {'), js.indexOf('/* Re-enrol PC'));
    expect(no).toContain("no_ca: \"The hub has no CA certificate (<code>CA_CERT_FILE</code>), so the connector can't check the hub before it sends the code.\"");
    expect(no).toContain("no_origin: \"The hub's public address isn't HTTPS (<code>PUBLIC_URL</code>), so the connector has no hub address to check.\"");
    expect(no).toContain("OB_NO_PROMPT[r.connector_unavailable]");
    expect(no).toContain("then use <b>Re-enrol PC</b> on the PC's page for a new code.");
    expect(sheet).toContain("if (!made.connector_prompt || !made.pairing) { out.innerHTML = `${obNoPrompt(made)}<div class=\"sheet-acts jn-acts\"><button type=\"button\" class=\"btn lg\" data-sheet-close>Done</button></div>`; refresh(); return; }");
    expect(re).toContain(': obNoPrompt(r)}');
    expect(re).toContain("${ok ? `<button type=\"button\" class=\"btn pri lg\" data-copy>");
  });
});

/* Add PC numbers its steps: install (naming the installer and how to run it), pair, paste (onboarding-e2e findings 8). */
describe('Add PC steps', () => {
  const sheet = fn('joinSheet'), inst = js.slice(js.indexOf('const jnInstallH = '), js.indexOf('const OB_NO_PROMPT'));
  it('step 1 names the installer file from the newest approved version and the command that runs it', () => {
    expect(sheet).toContain('out.innerHTML = `${jnInstallH(made)}');
    expect(inst).toContain("const file = `conclave-install-${made.connector_version || '<version>'}.mjs`");
    expect(inst).toContain('then run <code class="ob-chip">node ${esc(file)}</code> in a terminal there. It installs the connector and opens its pairing screen.');
    expect(inst).toContain('from <a href="${esc(made.download_url)}" target="_blank" rel="noopener noreferrer">GitHub Releases</a>');
    expect(inst).toContain("copy <code>${esc(file)}</code> from the connector's release files to it");
  });
  it('steps 2 and 3 are the pairing screen and the paste, and Re-enrol keeps its unnumbered pairing line', () => {
    expect(sheet).toContain("${obPairH(made, '<b>2.</b> ')}");
    expect(fn('obPromptSheet')).toContain('${obPairH(r)}');
    expect(sheet).not.toMatch(/It holds no code and no key: the agent drafts/);
  });
});

/* The PCs list shows the connector's state, not "Bridge · Not paired" on a connector PC (onboarding-e2e findings 9). */
describe('PCs list connection', () => {
  const conn = js.slice(js.indexOf('const pcHasBridge = '), js.indexOf('const PCF_SEG'));
  it('reads the connector first, the bridge only where one is paired or being set up, else Not connected', () => {
    expect(conn).toContain("if (c && c.status !== 'never') return c.status === 'disconnected' ? ['Disconnected', 'bad'] : c.online ? ['Connector online', 'ok'] : ['Connector offline', 'idle'];");
    expect(conn).toContain('if (pcHasBridge(p)) { const [l, t] = pcBridge(p); return [`Bridge ${l.toLowerCase()}`, t]; }');
    expect(conn).toContain("return ['Not connected', ''];");
    expect(js).toContain('<span role="columnheader" class="pc-br">Connection</span>');
    expect(fn('pcRow')).toContain("pill('Suspended', 'bad') : pcConnH(p)");
    expect(js).toContain("(p) => pcLive(p) > 0 || p.bridge?.online || p.connector?.online]");
  });
  it('a bridge counts only when paired or being set up, not for setup_status none or done', () => {
    expect(conn).toContain("const pcHasBridge = (p) => !!(p.bridge?.paired || ['waiting_install', 'waiting_pairing', 'waiting_folder_approval'].includes(p.bridge?.setup_status));");
  });
  it('the PC page hides the Bridge row on a connector PC with no bridge', () => {
    expect(js).toContain("${pcHasBridge(p) || cn.status === 'never' ? kv('Bridge', ");
  });
});

/* A decision on a team request shows at once; the page does not read "Waiting for you" while it reloads (findings 9).
   obDecided runs in a vm with the console's own $ and $$ (line 3 of app.js) against a small fake page. */
describe('team request decision', () => {
  const helpers = js.slice(js.indexOf('const $ = '), js.indexOf('\n', js.indexOf('const $ = ')));
  const decide = js.slice(js.indexOf('const obDecided = '), js.indexOf('\n', js.indexOf('const obDecided = ')));
  const page = () => {
    const meta = { innerHTML: 'Waiting for you' }, buttons = [{ disabled: false }, { disabled: false }, { disabled: false }];
    const document = { querySelector: (s: string) => (s === '#ctxBar .ctx-meta' ? meta : null), querySelectorAll: (s: string) => (s === '#ctxBar .ws-act button' ? buttons : []) };
    const ctx = vm.createContext({ document, obPill: (st: string) => `pill:${st}` });
    vm.runInContext(`${helpers}\n${decide}\nthis.obDecided = obDecided;`, ctx);
    return { run: (ctx as unknown as { obDecided: (st: string) => void }).obDecided, meta, buttons };
  };
  it('swaps the header pill and turns every button off, without throwing', () => {
    for (const st of ['approved', 'denied']) {
      const p = page();
      expect(() => p.run(st)).not.toThrow();
      expect(p.meta.innerHTML).toBe(`pill:${st}`);
      expect(p.buttons.every((b) => b.disabled)).toBe(true);
    }
  });
  it('runs after a saved Approve or Deny, before the toast and the reload', () => {
    expect(js).toContain("obDecided('approved'); toast('Approved; the PC collects the keys'); viewEdited = false; re();");
    expect(js).toContain("obDecided('approved'); toast('Approved; the PC collects the key'); viewEdited = false; re();");
    expect(js).toContain("obDecided('denied'); toast('Denied'); re();");
  });
});

describe('onboarding prompt', () => {
  const p = read('deploy', 'client', 'onboarding-prompt.md');
  it('does not tell a Codex user to restart Claude Code or run `claude`', () => {
    expect(p).not.toMatch(/Claude Code restart|run `claude`|restart Claude Code/);
    expect(p).toContain('working after the client is restarted');
    expect(p).toContain('tell me to open my coding agent in that folder');
  });
  it('mentions ~/.claude.json only as Claude Code\'s own file', () => {
    expect(p).toContain('(Claude Code: ~/.claude.json)');
  });
});
