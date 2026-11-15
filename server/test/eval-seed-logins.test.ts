/**
 * The dev seed's test logins (docs/getting-started.md, Local design review hub): `npm run dev:seed` never prints the
 * collaborators' generated passwords. It writes them to members.env beside .dev/hub.env (git-ignored, owner-only) and
 * prints only where; scripts that sign in as a member read the file with readLogins.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = resolve(process.cwd(), '..');
const run = () => import(pathToFileURL(join(repo, 'eval', 'run.mjs')).href) as Promise<any>;
const users = [
  { username: 'lena', password: 'pw-lena-test' },
  { username: 'omar', setup_url: 'http://127.0.0.1:8099/#setup/tok-test' },
  { username: 'mira', note: 'existed; password unchanged' },
];

describe('the seed writes test logins to a file', () => {
  it('writes one line per member with a login, behind a header, and reads them back', async () => {
    const { writeLogins, readLogins, LOGINS_FILE } = await run();
    const dir = mkdtempSync(join(tmpdir(), 'seed-logins-'));
    try {
      const file = writeLogins(dir, users);
      expect(file).toBe(join(dir, LOGINS_FILE));
      const text = readFileSync(file, 'utf8');
      expect(text.split('\n')[0]).toMatch(/^# .*Never print/);
      expect(text).not.toContain('mira');
      expect(readLogins(dir)).toEqual({ lena: 'pw-lena-test', 'omar.setup_url': 'http://127.0.0.1:8099/#setup/tok-test' });
      if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('tightens an existing file to owner-only and replaces its content', async () => {
    const { writeLogins, readLogins } = await run();
    const dir = mkdtempSync(join(tmpdir(), 'seed-logins-'));
    try {
      writeFileSync(join(dir, 'members.env'), 'old=stale\n', { mode: 0o644 });
      writeLogins(dir, users.slice(0, 1));
      expect(readLogins(dir)).toEqual({ lena: 'pw-lena-test' });
      if (process.platform !== 'win32') expect(statSync(join(dir, 'members.env')).mode & 0o777).toBe(0o600);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('says to seed first when there is no file', async () => {
    const { readLogins } = await run();
    const dir = mkdtempSync(join(tmpdir(), 'seed-logins-'));
    try { expect(() => readLogins(dir)).toThrow(/seed the local hub first/); } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('the command line prints where the logins went, never a password or setup link', () => {
    const src = readFileSync(join(repo, 'eval', 'run.mjs'), 'utf8').replace(/\r\n/g, '\n');
    const cli = src.slice(src.indexOf('  if (r.seed) {'), src.indexOf('const g = r.seed.graph;'));
    expect(cli).toContain("writeLogins(r.hub?.root ?? join(REPO, '.dev'), r.seed.users)");
    expect(cli).toContain('not shown here');
    expect(cli).not.toMatch(/\$\{u\.password|\$\{u\.setup_url/);
    // .dev/ (hub.env and members.env) stays out of git.
    expect(readFileSync(join(repo, '.gitignore'), 'utf8')).toMatch(/^\/\.dev\/$/m);
  });
});
