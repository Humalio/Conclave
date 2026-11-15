/**
 * The Early Echo vault (eval/vault/, docs/showcase.md §2) in its start-of-story state: eval/story/check-vault.mjs must
 * pass, and must catch the mistakes that would break the story (a stray reveal term, a dangling link, a banned word).
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repo = resolve(process.cwd(), '..');
const checker = join(repo, 'eval', 'story', 'check-vault.mjs');
const vault = join(repo, 'eval', 'vault');
const run = (dir: string) => {
  try { return { code: 0, out: execFileSync(process.execPath, [checker, dir], { encoding: 'utf8', stdio: 'pipe' }) }; }
  catch (e) { const x = e as { status: number; stdout: string; stderr: string }; return { code: x.status, out: x.stdout + x.stderr }; }
};

describe('Early Echo vault', () => {
  it('passes the vault checker', () => {
    const r = run(vault);
    expect(r.out).toMatch(/vault ok: 110 notes/);
    expect(r.code).toBe(0);
  });

  it('catches a stray reveal term, a dangling link and a banned word', () => {
    const dir = mkdtempSync(join(tmpdir(), 'early-echo-'));
    try {
      cpSync(vault, dir, { recursive: true });
      appendFileSync(join(dir, 'Signals Lab', 'Open questions.md'), '\nMaybe a substrate? See [[Echo model v2]] and [[Nowhere]]. A warp bubble.\n');
      const r = run(dir);
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/"substrate" may appear only under Classified/);
      expect(r.out).toMatch(/links \[\[Echo model v2\]\], which is only written later/);
      expect(r.out).toMatch(/link \[\[Nowhere\]\] does not resolve/);
      expect(r.out).toMatch(/banned word "warp"/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
