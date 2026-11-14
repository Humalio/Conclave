/**
 * Operator console, users without setup links: "Grant access" creates a user and shows the generated password once,
 * "Reset password" replaces "New setup link", both Account pages change the signed-in user's password, a non-admin user
 * reads as "Collaborator", and a team held by a checkout shows in the Home attention list.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n'); // a Windows checkout has CRLF
const css = readFileSync(join(process.cwd(), 'public', 'style.css'), 'utf8');
const fn = (name: string) => { const i = js.indexOf(`function ${name}(`); expect(i, name).toBeGreaterThan(-1); return js.slice(i, js.indexOf('\n}\n', i)); };

describe('console: users without setup links', () => {
  it('has no setup page, setup-link call or setup route left', () => {
    expect(js).not.toMatch(/#setup\//);
    expect(js).not.toMatch(/['`]\/setup\//);
    expect(js).not.toContain('setup-link');
    expect(js).not.toContain('function muSetup');
    expect(js).not.toContain('muBoot');
    expect(js).toContain("api('/me').then(enter, () => showLogin());");
  });

  it('keeps the two-factor gate right after sign-in', () => {
    expect(js).toMatch(/async function enter\(me\) \{\s*if \(me\.setup_needed \|\| me\.role !== 'admin'\) return muEnter\(me\);/);
    expect(fn('muEnter')).toContain('if (me.setup_needed) return muEnrol(me);');
  });

  it('grants access and shows the generated password once, never storing it', () => {
    const add = fn('usAddSheet');
    expect(add).toContain("title: 'Grant access'");
    expect(add).toContain("post('/users'");
    expect(add).toContain('usPwSheet(r.password, r.user');
    const once = fn('usPwSheet');
    expect(once).toContain('codeBox(pw, true)');
    expect(once).toContain('Shown once. Hand it to ${esc(muName(u))}; they can change it in Account.');
    for (const f of [add, once]) { expect(f).not.toMatch(/localStorage|sessionStorage|location\.hash|history\./); expect(f).not.toMatch(/toast\([^)]*pw/); }
  });

  it('resets a password from the user page and shows the new one once', () => {
    expect(js).toContain('/reset-password`');
    expect(js).toContain("usPwSheet(r.password, u, 'New password')");
    expect(js).not.toContain('New setup link');
  });

  it('lets every signed-in user change their password on Account', () => {
    const w = fn('pwWire');
    expect(w).toContain("post('/me/password', { current: cur, new: n1 })");
    expect(w).toContain('PW_MIN');
    expect(w).toContain('toLowerCase().includes');
    expect(w).toContain('er.message'); // the server's message (wrong password, rules, demo guard) is shown as is
    expect(w).toContain('Other sessions were signed out.');
    expect(js.match(/pwWire\(me\.username\)/g)?.length).toBe(2); // admin Account and the collaborator's #m/account
    expect(css).toContain('.pw-form{');
  });

  it('on a demo hub hides Change password for the .env operator, as /api/me says, with one muted line', () => {
    expect(js).toContain("me.password_locked ? pwLocked() : pwCard(me.username, 'pcard')");
    expect(js).toContain('<p class="hint">Set in .env on a demo hub. Replay signs in with it.</p>');
  });

  it('shows the date a password was set', () => {
    expect(js).toContain('const pwAt = u.password_changed_at || null;');
    expect(js).toContain("kv('Password set', esc(dt(pwAt)))");
  });

  it('names only the teams of the current project in its Needs you', () => {
    expect(fn('muNeedsCard')).toContain("(MU.me.deciding_now || []).filter((tid) => !pid || muProjOf(tid)?.id === pid)");
  });

  it('calls a non-admin user a Collaborator and names the button Grant access', () => {
    expect(js).toContain("[['member', 'Collaborator'], ['admin', 'Admin']]");
    expect(js).not.toMatch(/\? pill\('Admin', 'acc'\) : 'Member'/);
    expect(js).not.toContain('Add user');
    expect(js).not.toContain("'Member · external partner'");
  });

  it('lists a team paused for checkout in the attention list, linking to its checkout', () => {
    const u = fn('urgent');
    expect(u).toContain('if (coHeld(t) && !coWait.has(t.id))');
    expect(u).toContain('data-co-open=');
    // One row per checkout step that waits on the operator (needs_operator): Needs you rows from the hub, each opening the
    // checkout, and a team they cover is not listed again as paused.
    expect(u).toContain("ny.filter((r) => r.kind === 'checkout')");
    expect(readFileSync(join(process.cwd(), 'src', 'admin', 'needsYou.ts'), 'utf8')).toMatch(/for \(const x of c\.needs_operator\)/);
    expect(fn('nyOpenAttr')).toContain("case 'checkout': return `data-co-open=");
  });

  it('gives the overdue checkout alert an Open checkout action', () => {
    expect(fn('urgent')).toContain("a.type === 'checkout_overdue'");
  });
});
