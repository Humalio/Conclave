import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorize, canReach, type Rule } from '../src/policy/engine.js';
import { LeakGuard } from '../src/guard/leakGuard.js';
import { Vault, VaultError } from '../src/vault/vault.js';

let n = 0;
const R = (effect: 'allow' | 'deny', actions: string[], resource: string): Rule => ({ id: `r${++n}`, effect, actions, resource });

describe('policy engine', () => {
  it('denies by default', () => {
    expect(authorize([], [], 'fs.read', 'path:/vault/a.md').allowed).toBe(false);
    expect(authorize([R('allow', ['fs.read'], 'path:/vault/a/**')], [], 'fs.list', 'path:/vault/a/x.md').allowed).toBe(false);
  });
  it('deny wins over allow regardless of order', () => {
    const allow = R('allow', ['fs.read'], 'path:/vault/**'), deny = R('deny', ['fs.read'], 'path:/vault/Private/**');
    for (const rules of [[allow, deny], [deny, allow]]) {
      expect(authorize(rules, [], 'fs.read', 'path:/vault/Private/x.md').allowed).toBe(false);
      expect(authorize(rules, [], 'fs.read', 'path:/vault/Public/x.md').allowed).toBe(true);
    }
  });
  it('matches * inside a segment and ** across segments', () => {
    const rules = [R('allow', ['fs.read'], 'path:/vault/Projects/*/notes/**')];
    expect(authorize(rules, [], 'fs.read', 'path:/vault/Projects/a/notes/x/y.md').allowed).toBe(true);
    expect(authorize(rules, [], 'fs.read', 'path:/vault/Projects/a/b/notes/x.md').allowed).toBe(false);
    expect(authorize([R('allow', ['fs.read'], 'path:/vault/a/**')], [], 'fs.read', 'path:/vault/a').allowed).toBe(true);
    expect(authorize([R('allow', ['fs.read'], 'path:/vault/a/**')], [], 'fs.read', 'path:/vault/ab/x').allowed).toBe(false);
  });
  it('app key cap restricts; empty cap means no cap', () => {
    const rules = [R('allow', ['fs.read'], 'path:/vault/**')];
    const cap = [R('allow', ['fs.read'], 'path:/vault/Public/**')];
    expect(authorize(rules, cap, 'fs.read', 'path:/vault/Public/a.md').allowed).toBe(true);
    const d = authorize(rules, cap, 'fs.read', 'path:/vault/Private/a.md');
    expect(d.allowed).toBe(false); expect(d.source).toBe('app_key_cap');
    expect(authorize(rules, [], 'fs.read', 'path:/vault/Private/a.md').allowed).toBe(true);
  });
  it('canReach lists parents of granted folders but not siblings or denied subtrees', () => {
    const rules = [R('allow', ['fs.list'], 'path:/vault/Projects/A/**'), R('deny', ['fs.list'], 'path:/vault/Projects/A/Secret/**')];
    expect(canReach(rules, [], 'fs.list', '/vault')).toBe(true);
    expect(canReach(rules, [], 'fs.list', '/vault/Projects')).toBe(true);
    expect(canReach(rules, [], 'fs.list', '/vault/Other')).toBe(false);
    expect(canReach(rules, [], 'fs.list', '/vault/Projects/A/Secret')).toBe(false);
  });
  it('property: adding a deny rule never grants more', () => {
    const seg = fc.constantFrom('a', 'b', 'c', '*', '**');
    const pat = fc.array(seg, { minLength: 1, maxLength: 4 }).map((s) => `path:/vault/${s.join('/')}`);
    const concrete = fc.array(fc.constantFrom('a', 'b', 'c'), { minLength: 0, maxLength: 4 }).map((s) => `path:/${['vault', ...s].join('/')}`);
    const act = fc.constantFrom('fs.read', 'fs.list', 'fs.update');
    const rule = fc.record({ effect: fc.constantFrom('allow' as const, 'deny' as const), actions: fc.array(act, { minLength: 1, maxLength: 2 }), resource: pat })
      .map((r) => ({ ...r, id: `p${++n}` }));
    fc.assert(fc.property(fc.array(rule, { maxLength: 6 }), fc.array(rule, { maxLength: 3 }), pat, fc.array(act, { minLength: 1, maxLength: 2 }), concrete, act, (base, cap, denyRes, denyActs, res, a) => {
      const extra: Rule = { id: 'x', effect: 'deny', actions: denyActs, resource: denyRes };
      const before = authorize(base, cap, a, res).allowed, after = authorize([...base, extra], cap, a, res).allowed;
      return !(after && !before);
    }));
  });
});

const KEY = 'ah_ses_abcdefghijkl_abcdefghijklmnopqrstuvwxyz234567';
describe('leak guard', () => {
  const g = new LeakGuard({ knownKeyIds: () => ['mnopqrstuvwx'] });
  const hit = (v: unknown) => g.scan(v) !== null;
  it('catches a plain key, also nested', () => {
    expect(hit({ text: `here: ${KEY}` })).toBe(true);
    expect(hit({ a: [{ b: KEY }] })).toBe(true);
  });
  it('catches spaced, split, case-changed and zero-width forms', () => {
    expect(hit('ah _ ses _ abcdefghijkl _ abcdefghijklmnopqrstuvwxyz234567')).toBe(true);
    expect(hit('AH_SES_ABCDEFGHIJKL_ABCDEFGHIJKLMNOPQRSTUVWXYZ234567')).toBe(true);
    expect(hit('ah_ses_abcdef\u200bghijkl_abcdefghijklmnopqrstuvwxyz234567')).toBe(true);
    expect(hit({ part1: 'ah_ses_abcdefghijkl_abcdefghijklmnop', part2: 'qrstuvwxyz234567' })).toBe(true);
  });
  it('catches base64 and hex encodings', () => {
    expect(hit(Buffer.from(KEY).toString('base64'))).toBe(true);
    expect(hit(Buffer.from(KEY).toString('base64url'))).toBe(true);
    expect(hit(Buffer.from(KEY).toString('hex'))).toBe(true);
  });
  it('catches a known key id on its own', () => { expect(hit('please use mnopqrstuvwx for that')).toBe(true); });
  it('ignores the skipped top-level fields', () => {
    expect(g.scan({ session_key: KEY, q: 'hello' }, new Set(['session_key']))).toBeNull();
  });
  it('has no false positives on normal text or documentation mentions', () => {
    expect(hit('Meeting notes about the Q3 roadmap. Call session_login with your key, then session_describe.')).toBe(false);
    expect(hit('keys look like ah_ses_… and ah_app_… in the docs')).toBe(false);
    expect(hit('ah_ses_<keyid>_<secret> is the format')).toBe(false);
    expect(hit('The path /vault/Projects/Alpha/notes.md and https://example.com/a/b?c=d')).toBe(false);
    expect(hit('Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor.')).toBe(false);
  });
});

describe('vault confinement', () => {
  const root = mkdtempSync(join(tmpdir(), 'vault-'));
  mkdirSync(join(root, 'Notes'), { recursive: true });
  mkdirSync(join(root, '.obsidian'));
  writeFileSync(join(root, 'Notes', 'a.md'), 'hello');
  writeFileSync(join(root, '.obsidian', 'app.json'), '{}');
  const outside = mkdtempSync(join(tmpdir(), 'outside-'));
  writeFileSync(join(outside, 'secret.txt'), 'top secret');
  const v = new Vault(root, 'vault');
  const code = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as VaultError).code; } return null; };
  it('rejects .., absolute paths, drive letters and wrong alias', () => {
    expect(code(() => v.normalise('/vault/../etc/passwd'))).toBe('invalid_path');
    expect(code(() => v.normalise('/vault/Notes/../../x'))).toBe('invalid_path');
    expect(code(() => v.normalise('C:\\Windows\\win.ini'))).toBe('invalid_path');
    expect(code(() => v.normalise('/vault/C:/Windows'))).toBe('invalid_path');
    expect(code(() => v.normalise('/etc/passwd'))).toBe('invalid_path');
    expect(code(() => v.normalise('/vault/a\u0000b'))).toBe('invalid_path');
  });
  it('treats hidden folders as denied, never as not found', () => {
    expect(code(() => v.normalise('/vault/.obsidian/app.json'))).toBe('denied');
    expect(code(() => v.normalise('/vault/shares/x'))).toBe('denied');
  });
  it('reads a normal file and lists without hidden entries', async () => {
    expect((await v.read(['Notes', 'a.md'])).content).toBe('hello');
    expect((await v.list([])).map((e) => e.name)).toEqual(['Notes']);
  });
  it('does not follow a symlink out of the vault (skipped if symlinks cannot be created)', async (ctx) => {
    try { symlinkSync(outside, join(root, 'link'), 'junction'); } catch { ctx.skip(); return; }
    await expect(v.read(['link', 'secret.txt'])).rejects.toMatchObject({ code: 'denied' });
    expect((await v.list([])).map((e) => e.name)).not.toContain('link');
  });
});

describe('RateLimit persistence', () => {
  it('survives reopening the database', async () => {
    const { mkdtempSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
    const { openDb } = await import('../src/db/db.js'); const { RateLimit } = await import('../src/db/rateLimit.js');
    const file = join(mkdtempSync(join(tmpdir(), 'rl-')), 'x.db');
    const now = Date.now();
    let db = openDb(file);
    let rl = new RateLimit(db, 10, 600_000);
    for (let i = 0; i < 10; i++) rl.fail('app1', 'login_fail', now);
    expect(rl.blocked('app1', 'login_fail', now).blocked).toBe(true);
    db.close();
    db = openDb(file); rl = new RateLimit(db, 10, 600_000);
    expect(rl.blocked('app1', 'login_fail', now + 1000).blocked).toBe(true);
    expect(rl.blocked('app2', 'login_fail', now + 1000).blocked).toBe(false);
    expect(rl.blocked('app1', 'login_fail', now + 11 * 60_000).blocked).toBe(false);
    db.close();
  });
});
