/**
 * Tell the agent (console-systems NAVAGENTS-3, §4.5 E): one compose form and one sheet for the agent page's card and the
 * Message button on a team's Members rows. Static checks on the console source, like console-fixes.test.ts; the API side
 * (a member gets 403 admin_only on POST /api/agents/:id/notices) is in multiuser-mu1.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
/** The source from `start` to the first `end` after it. */
const block = (start: string, end: string) => {
  const i = js.indexOf(start);
  expect(i, start).toBeGreaterThanOrEqual(0);
  const j = js.indexOf(end, i + start.length);
  expect(j, end).toBeGreaterThan(i);
  return js.slice(i, j);
};
const count = (s: string) => js.split(s).length - 1;

describe('Tell the agent', () => {
  it('Message on a Members row is gated on the admin role and sits before More', () => {
    expect(js).toMatch(/const canTell = \(\) => S\.me\?\.role === 'admin'/);
    const row = block('const memberRow = ', '\n/*');
    expect(row).toMatch(/\$\{canTell\(\) \? `<button[^>]*data-tell="\$\{esc\(m\.agent_id\)\}"/);
    expect(row).toContain("${ic('chat')}");
    expect(row.indexOf('data-tell=')).toBeLessThan(row.indexOf('${tmgMemMore(m)}'));
    // Copy handoff stays desktop-only; Message shows at every width.
    expect(row).toMatch(/class="btn ic sm only-d" data-hand=/);
    expect(row).not.toMatch(/data-tell="[^"]*"[^>]*only-d|only-d" data-tell/);
  });

  it('the More menu of a member lists Message first, for admins', () => {
    const bind = block('function tmgBindMembers(t) {', '\n}\n');
    // Message is the first item of the openMenu array, present only when canTell() holds.
    expect(bind).toMatch(/openMenu\(\[\s*canTell\(\) \? \{ label: 'Message'[^}]*tellAgent\(b\.dataset\.tmgMem\b[^\n]*?\}\)\s*\}\s*: null,/);
  });

  it('one global [data-tell] handler opens the sheet', () => {
    expect(count("closest('[data-tell]')")).toBe(1);
    expect(js).toMatch(/(\w+) = \w+\.closest\('\[data-tell\]'\);\s*if \(\1\) \{\s*tellAgent\(\1\.dataset\.tell\b/);
  });

  it('the agent page and the sheet render and bind the same form', () => {
    const ses = block('VIEWS.ses = async (arg) => {', '\n};\n');
    // The card holds only the compose form; what it sends shows in the Inbox card (console-agent-cards.test.ts).
    expect(ses).toMatch(/card\('chat', 'Tell the agent', tellFormH\(a, \{ id: 'agTell' \}\), /);
    // The page binds its own card form, not the first [data-tell-form] in the document.
    expect(ses).toMatch(/bindTell\(\$\('#agTell'\), id, /);
    expect(ses).not.toMatch(/bindTell\(document\b/);
    const sheet = block('function tellAgent(agentId', '\n}\n');
    expect(sheet).toMatch(/kind = 'message'/);
    expect(sheet).toContain('if (!canTell()) return null;');
    expect(sheet).toMatch(/tellFormH\(a, \{[^}]*sheet: true/);
    expect(sheet).toContain('bindTell(sh, agentId, ');
    // The old inline form and its ids are gone.
    expect(js).not.toMatch(/sNote(Kind|Body|Keep|Go)/);
  });

  it('the form says the limit and how the agent confirms, and keeps a directive by default', () => {
    const form = block('const tellFormH = ', '\n};\n');
    expect(form).toContain('maxlength="4000"');
    expect(form).toMatch(/<input type="checkbox" data-tell-keep checked>/);
    expect(form).toMatch(/data-tell-keep-r\$\{kind === 'directive' \? '' : ' hidden'\}/);
    // The sheet hint says how the agent confirms, and the limit.
    const note = js.match(/const TELL_NOTE = '([^']*)';/);
    expect(note?.[1]).toMatch(/session_ack/);
    expect(form).toMatch(/\$\{esc\(TELL_NOTE\)\}[^<]*4,000/);
  });

  it('sends from one place: a kept directive to /directives, anything else as one notice', () => {
    expect(count("'/notices'")).toBe(1);
    expect(count("scope: { kind: 'agent'")).toBe(1);
    const bind = block('function bindTell(root, agentId', '\n}\n');
    // Keep ticked on a directive: one hub record scoped to this agent. Otherwise: a notice of the chosen kind.
    expect(bind).toMatch(/if \(nk === 'directive' && [^\n]*\[data-tell-keep\][^\n]*\.checked\) \{[^\n]*post\('\/directives', \{[^\n]*scope: \{ kind: 'agent', ref: agentId \}/);
    expect(bind).toMatch(/else \{[^\n]*post\('\/agents\/' \+ encodeURIComponent\(agentId\) \+ '\/notices', \{ kind: nk\b/);
    // Scoped binding: a passed form element is used as-is, otherwise the form inside the given root.
    expect(bind).toMatch(/root\?\.matches\?\.\('\[data-tell-form\]'\) \? root/);
  });
});
