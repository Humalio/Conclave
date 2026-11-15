/**
 * The private git (docs/onboarding.md, "Private git"; review v2 §7). On Windows, when no git is found, setup OFFERS to
 * install a private copy into the connector's own folder: no admin rights, no change to the system or to the user's git
 * settings. It is MinGit at the version and SHA-256 pinned here, in the connector's signed release; any other file is
 * refused. Its `usr\bin\sh.exe` (GNU bash) is copied to `usr\bin\bash.exe`, because Claude Code only takes a shell whose
 * name says bash (proof: git-gate). Claude Code reads its Git Bash path only from the environment it starts with, so
 * setup sets `CLAUDE_CODE_GIT_BASH_PATH` in the user's environment, and only when no Git for Windows is installed.
 * Every change is a manifest entry, for uninstall. A git the user installs is always preferred.
 *
 * Downloading, unpacking and the environment are passed in (`io`), so tests never download or touch the registry.
 */
import https from 'node:https';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, copyFileSync, readFileSync, createWriteStream, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { gitPath } from './entries.mjs';
import { record, USER_ENV_TARGET } from './manifest.mjs';
import { WIN } from './paths.mjs';

export const MINGIT = Object.freeze({
  version: '2.56.1',
  file: 'MinGit-2.56.1-64-bit.zip',
  url: 'https://github.com/git-for-windows/git/releases/download/v2.56.1.windows.1/MinGit-2.56.1-64-bit.zip',
  sha256: '4a92850b6e917da4fd010669b614b55dccf5b0ec333a534cc4be4700dfefdafd',
});
export const GIT_OFFER = 'Git is missing. Install a private copy for Conclave only (about 50 MB, no admin rights)?';
export const CODEX_GIT = 'Git for Windows is still needed for Codex: install it from https://git-scm.com/download/win, then choose Retry.';
export const GIT_INSTALL_HINT = {
  darwin: 'Git is missing. Install it with: xcode-select --install',
  linux: 'Git is missing. Install it with your package manager, for example: sudo apt install git',
  win32: 'Git is missing. Install Git for Windows from https://git-scm.com/download/win',
};
const BASH_VAR = 'CLAUDE_CODE_GIT_BASH_PATH';

export const privateGitDir = (home) => join(home, 'git');
export const privateBash = (home) => join(home, 'git', 'usr', 'bin', 'bash.exe');
const sha256File = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

/** Git for Windows as Claude Code finds it, without the private copy: the variable, then the two standard places. */
export function gitForWindows(env = process.env, exists = existsSync) {
  if (env[BASH_VAR] && exists(env[BASH_VAR]) && !String(env[BASH_VAR]).toLowerCase().includes('conclave')) return env[BASH_VAR];
  for (const base of [env.ProgramFiles ?? 'C:\\Program Files', env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)']) {
    const p = join(base, 'Git', 'bin', 'bash.exe');
    if (exists(p)) return p;
  }
  return null;
}

/**
 * What setup says about git: `{state: 'ok', path}` (a git is there, the user's first), `{state: 'offer', line}` (Windows,
 * missing: ask), or `{state: 'missing', line}` (macOS and Linux: the install command). `codex` adds the Codex line.
 */
export function gitState(home, { env = process.env, win = WIN, os = process.platform, codex = false } = {}) {
  const user = gitPath(join(home, '.no-private'), env, win); // the user's own git on PATH, ignoring the private copy
  const own = existsSync(win ? join(privateGitDir(home), 'cmd', 'git.exe') : join(privateGitDir(home), 'bin', 'git')) ? gitPath(home, env, win) : null;
  const path = user ?? own;
  if (path) return { state: 'ok', path, private: !user, ...(codex && win && !user && !gitForWindows(env) ? { codex: CODEX_GIT } : {}) };
  if (!win) return { state: 'missing', line: GIT_INSTALL_HINT[os] ?? GIT_INSTALL_HINT.linux };
  return { state: 'offer', line: GIT_OFFER, ...(codex ? { codex: CODEX_GIT } : {}) };
}

/** Downloads a public file over https to `dest`, following up to 5 https redirects (GitHub's release storage). */
export function download(url, dest, { maxBytes = 200 * 1024 * 1024, timeoutMs = 120_000 } = {}) {
  return new Promise((res, rej) => {
    const go = (u, left) => {
      if (!u.startsWith('https://')) return rej(new Error('only https downloads'));
      const req = https.get(u, { timeout: timeoutMs }, (r) => {
        if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) { r.resume(); return left ? go(new URL(r.headers.location, u).href, left - 1) : rej(new Error('too many redirects')); }
        if (r.statusCode !== 200) { r.resume(); return rej(new Error(`HTTP ${r.statusCode}`)); }
        let n = 0;
        const out = createWriteStream(dest);
        r.on('data', (c) => { n += c.length; if (n > maxBytes) r.destroy(new Error('too large')); });
        r.on('error', (e) => { out.destroy(); rej(e); });
        out.on('error', rej);
        out.on('finish', () => res());
        r.pipe(out);
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', rej);
    };
    go(url, 5);
  });
}

/** Windows' own tar (bsdtar) unpacks a zip; by absolute path, never one found on PATH. */
export function unzip(zip, dir) {
  const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  mkdirSync(dir, { recursive: true });
  execFileSync(tar, ['-xf', zip, '-C', dir], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 300_000 });
}

/** The user's environment (HKCU\Environment) through setx, which also tells running programs that it changed. */
export const userEnv = {
  get(name) {
    try {
      const out = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      return /REG_(?:EXPAND_)?SZ\s+(.*)$/m.exec(out)?.[1]?.trim() ?? null;
    } catch { return null; }
  },
  set(name, value) { execFileSync('setx', [name, value], { stdio: ['ignore', 'ignore', 'pipe'] }); },
  /** Removes the variable (uninstall, when there was none before setup set it). */
  unset(name) { execFileSync('reg', ['delete', 'HKCU\\Environment', '/v', name, '/f'], { stdio: ['ignore', 'ignore', 'pipe'] }); },
};

/**
 * Installs the private git after the user said yes. `io` = {download, unzip, env, userEnv} for tests.
 * `{ok: true, git, bash, bashVar: 'set' | 'not_needed'}` or `{ok: false, reason}`: `hash_mismatch` (the file is not the
 * pinned MinGit: it is deleted and nothing is unpacked), `download_failed`, `unpack_failed`, `bash_copy_failed`.
 */
export async function installPrivateGit(home, { io = {}, claudeJson } = {}) {
  const dl = io.download ?? download, uz = io.unzip ?? unzip, env = io.env ?? process.env, ue = io.userEnv ?? userEnv;
  const pin = io.pin ?? MINGIT; // tests only: a fake archive with its own hash; the release always uses MINGIT
  const tmp = join(home, 'tmp');
  mkdirSync(tmp, { recursive: true });
  const zip = join(tmp, pin.file);
  try { await dl(pin.url, zip); } catch { rmSync(zip, { force: true }); return { ok: false, reason: 'download_failed' }; }
  if (!existsSync(zip) || sha256File(zip) !== pin.sha256) { rmSync(zip, { force: true }); return { ok: false, reason: 'hash_mismatch' }; }
  const fresh = join(tmp, 'git.new');
  rmSync(fresh, { recursive: true, force: true });
  try { uz(zip, fresh); } catch { rmSync(fresh, { recursive: true, force: true }); return { ok: false, reason: 'unpack_failed' }; }
  rmSync(zip, { force: true });
  const sh = join(fresh, 'usr', 'bin', 'sh.exe'), bash = join(fresh, 'usr', 'bin', 'bash.exe');
  try {
    copyFileSync(sh, bash);
    if (sha256File(sh) !== sha256File(bash)) throw new Error('copy differs');
  } catch { rmSync(fresh, { recursive: true, force: true }); return { ok: false, reason: 'bash_copy_failed' }; }
  const dir = privateGitDir(home);
  rmSync(dir, { recursive: true, force: true });
  renameSync(fresh, dir);
  const cx = { home, claudeJson, folders: [] };
  record(home, { kind: 'portable_git', target: dir, pointer: null, before: null, installed: { version: pin.version, sha256: pin.sha256 } }, cx);
  let bashVar = 'not_needed';
  if (!gitForWindows(env)) {
    const before = ue.get(BASH_VAR);
    ue.set(BASH_VAR, privateBash(home));
    record(home, { kind: 'user_env', target: USER_ENV_TARGET, pointer: BASH_VAR, before, installed: privateBash(home) }, cx);
    bashVar = 'set';
  }
  return { ok: true, git: join(dir, 'cmd', 'git.exe'), bash: privateBash(home), bashVar };
}
