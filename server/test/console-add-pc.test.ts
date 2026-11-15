/**
 * The Add dialog (docs/onboarding.md#1-one-key-add-pc-and-the-prompt): the header Add button, the More sheet and the command
 * list say just "Add" and open on "What do you want to add?" (a new PC, or a team on a PC that is already connected); the PCs
 * page's Add PC opens straight on the new-PC screen with Back to the choices. The new-PC screen says what it is for, asks for
 * the PC's coding agent and names that agent in the paste line. The onboarding prompt tells no one to restart Claude Code or
 * run `claude`. Read from the source files.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
    expect(sheet).toContain('Paste this into <b>${esc(jnAgent(client))}</b> on <b>${esc(made.pc.name)}</b>. The pairing code in it works once and is not shown again; ');
    expect(js).toContain("const jnAgent = (c) => (c === 'other' ? 'your coding agent' : promptClient(c));");
    expect(sheet).toContain("Waiting for <b>${esc(made.pc.name)}</b>. You'll approve its request here.");
    expect(sheet).not.toMatch(/into Claude Code/);
    expect(fn('obPromptSheet')).toContain('Paste it into the coding agent (Claude Code, Codex or another) on <b>');
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
