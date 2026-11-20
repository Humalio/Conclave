/**
 * The `commit` tool of a Codex agent's local `conclave` server (docs/connector.md "Codex folders", docs/mcp.md).
 *
 * Codex keeps `.git` read-only inside its sandbox, even in the folder it runs in, so that hooks planted there never run
 * outside the sandbox. The agent's own `git add` and `git commit` stay refused. This tool is the one way it commits: the
 * connector runs git outside the sandbox, in the agent's own clone (its folder), and:
 *   - commits only the files the agent names, on the agent's own branch (never a branch a remote has);
 *   - turns hooks off for every git call (an empty hooks folder of the connector's own, `--no-verify`, no fsmonitor);
 *   - refuses any path in `.git` or `.codex`, the role file and the connector's other files, and any path outside the
 *     clone: `..`, an absolute path, or a link that leads out;
 *   - sets the author and committer to the agent's label from the hub, so the agent cannot choose the name;
 *   - never pushes, and has no way to.
 * Every argument is L2 (the model wrote it): each is checked before it reaches git, and git gets `--` and literal pathspecs.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { win32, posix } from 'node:path';
import { gitPath } from './entries.mjs';
import { pathKey } from './paths.mjs';
import { OVERRIDE } from './role.mjs';

export const TOOL_NAME = 'commit';
export const MAX_PATHS = 200;
export const MAX_MESSAGE = 5000;

/** The tool as tools/list shows it. */
export const TOOL = {
  name: TOOL_NAME,
  description: 'Commit files in this folder\'s git clone, on your own branch. Use it instead of git add and git commit, which the Codex sandbox refuses here. Name each file (not a folder); a file you deleted is committed as deleted. With `branch`, the commit goes on that branch, created from where you are when it is new; a branch a remote has (such as main) is refused. Hooks are off, the author is you, and nothing is pushed. Refused: anything in .git or .codex, the role file AGENTS.override.md, and any path outside this folder.',
  inputSchema: {
    type: 'object',
    properties: {
      paths: { type: 'array', items: { type: 'string', maxLength: 1024 }, minItems: 1, maxItems: MAX_PATHS, description: 'The files to commit, relative to this folder, for example "server/src/app.ts".' },
      message: { type: 'string', minLength: 1, maxLength: MAX_MESSAGE, description: 'The commit message.' },
      branch: { type: 'string', maxLength: 200, description: 'Your branch, for example "dev/attach-hint". Leave it out to commit on the branch you are on.' },
    },
    required: ['paths', 'message'],
    additionalProperties: false,
  },
  annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
};

class Refused extends Error {}
const refuse = (m) => { throw new Refused(m); };

/** A branch name git and a shell both take as a name: no option, no `..`, no hidden or `.lock` part. */
export const validBranch = (r) => typeof r === 'string' && r.length >= 1 && r.length <= 200 && /^[A-Za-z0-9._/-]+$/.test(r) && !r.startsWith('-') && !r.startsWith('/')
  && !r.endsWith('/') && !r.endsWith('.') && !r.endsWith('.lock') && !r.includes('..') && !r.includes('//') && r !== 'HEAD' && !r.split('/').some((c) => c.startsWith('.') || c.endsWith('.lock'));

/** Files in a clone that are the connector's or Codex's, never the project's (compared lower-cased, with / separators). */
const OWN_FILES = new Set(['.mcp.json', '.claude/settings.local.json', 'claude.local.md', '.agent-hub.json']);
/** Windows reads `.git.`, `.git ` and `GIT~1` as `.git`; compare a segment the way it does. */
const winName = (s) => s.replace(/[. ]+$/, '').toLowerCase();

/**
 * One path the agent named, as a clean repo-relative path with / separators, or a refusal. Checks the words only; where
 * the path really leads is `contained`'s job.
 */
export function cleanPath(p) {
  if (typeof p !== 'string' || !p.length || p.length > 1024) refuse('a path must be a non-empty string');
  if (/[\x00-\x1f\x7f]/.test(p)) refuse(`${JSON.stringify(p)}: a path may not hold control characters`);
  if (isAbsolute(p) || win32.isAbsolute(p) || posix.isAbsolute(p) || /^[A-Za-z]:/.test(p) || p.startsWith('\\\\') || p.startsWith('~')) refuse(`${p}: an absolute path is refused; name files relative to this folder`);
  if (p.includes(':')) refuse(`${p}: a path may not hold ":"`);
  if (/[*?[\]]/.test(p)) refuse(`${p}: name each file; patterns are not taken`);
  const segs = p.split(/[\\/]+/).filter((s) => s !== '' && s !== '.');
  if (!segs.length) refuse(`${p}: that is this folder itself; name the files`);
  if (segs.includes('..')) refuse(`${p}: ".." is refused; name files inside this folder`);
  for (const s of segs) {
    const w = winName(s);
    if (w === '.git' || /^git~\d+$/.test(w)) refuse(`${p}: nothing in .git can be committed`);
    if (w === '.codex' || /^codex~\d+$/.test(w)) refuse(`${p}: .codex is this agent's own config and is never committed`);
  }
  const rel = segs.join('/');
  if (winName(segs[segs.length - 1]) === OVERRIDE.toLowerCase()) refuse(`${p}: ${OVERRIDE} is your role file from the hub and is never committed`);
  if (OWN_FILES.has(segs.map(winName).join('/'))) refuse(`${p}: this file is the connector's, not the project's`);
  return rel;
}

/** True when `real` (a real path) is inside the real path `root`. */
const inside = (root, real) => { const r = relative(root, real); return r !== '' && !r.startsWith('..') && !isAbsolute(r); };

/**
 * Where a clean path really leads: every part that exists must stay inside the clone, a link included (it is followed),
 * and what it leads to must not be in .git, .codex or the role file either. Returns 'file', 'gone' (not there: a deletion)
 * or refuses (a folder, or a path that leads out).
 */
export function contained(root, rel) {
  const parts = rel.split('/');
  let cur = root;
  for (let i = 0; i < parts.length; i++) {
    cur = join(cur, parts[i]);
    let st;
    try { st = lstatSync(cur); } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return 'gone'; refuse(`${rel}: cannot be read (${e.code})`); }
    if (st.isSymbolicLink()) { // a junction on Windows too
      let real;
      try { real = realpathSync.native(cur); } catch { refuse(`${rel}: is a link that leads nowhere`); }
      if (!inside(root, real)) refuse(`${rel}: leads outside this folder`);
      cleanPath(relative(root, real)); // the target obeys the same rules as a name
    }
  }
  let real;
  try { real = realpathSync.native(cur); } catch { refuse(`${rel}: is a link that leads nowhere`); }
  if (!inside(root, real)) refuse(`${rel}: leads outside this folder`);
  cleanPath(relative(root, real).split(sep).join('/'));
  if (statSync(cur).isDirectory()) refuse(`${rel}: is a folder; name the files in it`);
  return 'file';
}

/**
 * Why git would skip an untracked file: null (it would not), 'star' (only the `*` line of this clone's .git/info/exclude,
 * which setup writes), or a plain-words rule from the repo's .gitignore or the global excludes. Info/exclude has the lowest
 * rank but one, so a global rule hides behind a `*` there: the second query leaves info/exclude out.
 */
function ignoredBy(git, root, f) {
  const r = git(['check-ignore', '-v', '--no-index', '--', f], undefined, { GIT_LITERAL_PATHSPECS: '0' }); // check-ignore takes no literal pathspecs; the path holds no pattern (cleanPath)
  if (r.status === 1) return null;
  if (r.status !== 0) refuse(`${f}: git could not say whether it is ignored (${firstErr(r)})`);
  const m = /^(.+?):(\d+):(.*)$/.exec(String(r.stdout).split('\t')[0]);
  const [source, line, pattern] = m ? [m[1], m[2], m[3]] : ['', '', ''];
  if (pattern.startsWith('!')) return null;
  const src = source.split(String.fromCharCode(92)).join('/');
  if (!(/(^|\/)info\/exclude$/.test(src) && pattern === '*')) return `${pattern} in ${src || 'the global excludes'}${line ? ':' + line : ''}`;
  let glob = git(['config', '--path', '--get', 'core.excludesFile']).stdout.trim();
  if (!glob) { const x = process.env.XDG_CONFIG_HOME || join(process.env.HOME || process.env.USERPROFILE || '', '.config'); glob = join(x, 'git', 'ignore'); }
  const args = ['ls-files', '-o', '-i', '--exclude-per-directory=.gitignore'];
  if (existsSync(glob)) args.push(`--exclude-from=${glob}`);
  // The other lines of info/exclude: `*` is the last match, so check-ignore names it and hides the rest.
  const NL = String.fromCharCode(10);
  const exFile = join(root, '.git', 'info', 'exclude');
  const rest = existsSync(exFile) ? readFileSync(exFile, 'utf8').split(NL).map((l) => l.split(String.fromCharCode(13)).join(String())).filter((l) => l.trim() !== '*') : [];
  const tmp = mkdtempSync(join(tmpdir(), 'conclave-ex-'));
  try {
    if (rest.length) { writeFileSync(join(tmp, 'rest'), rest.join(NL) + NL); args.push(`--exclude-from=${join(tmp, 'rest')}`); }
    const o = git([...args, '--', f]);
    if (o.status !== 0) refuse(`${f}: git could not say whether it is ignored (${firstErr(o)})`);
    return o.stdout.trim() ? "the repo's .gitignore, its .git/info/exclude or the global excludes" : 'star';
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

/**
 * Git with hooks off and the agent's environment kept out. Used by the commit tool and by restore (which passes its own
 * timeout and, for its `:(icase)` pathspecs, GIT_LITERAL_PATHSPECS=0).
 */
export function safeGit(bin, dir, hooks, author, { timeout = 120_000 } = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k)));
  Object.assign(env, { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '', GIT_LITERAL_PATHSPECS: '1', GIT_OPTIONAL_LOCKS: '0' });
  if (author) Object.assign(env, { GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, GIT_COMMITTER_NAME: author.name, GIT_COMMITTER_EMAIL: author.email });
  const cfg = ['-c', `core.hooksPath=${hooks}`, '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', '-c', 'core.protectNTFS=true', '-c', 'core.protectHFS=true'];
  return (args, input, extraEnv) => spawnSync(bin, ['-C', dir, ...cfg, ...args], { encoding: 'utf8', timeout, env: extraEnv ? { ...env, ...extraEnv } : env, input, windowsHide: true });
}
const mkGit = safeGit;

/** An empty hooks folder of this process's own, made once, for git calls that have no connector home to hand (restore). */
let noHooksDir = null;
export function noHooks() {
  if (!noHooksDir || !existsSync(noHooksDir) || readdirSync(noHooksDir).length) noHooksDir = mkdtempSync(join(tmpdir(), 'conclave-no-hooks-'));
  return noHooksDir;
}

/**
 * Settings in a clone's own .git/config that make git run a program, which the connector's git calls cannot switch off
 * from the command line: an include (unread here, so anything), filters, diff and merge drivers, ssh and proxy commands,
 * credential helpers, the ext protocol, upload-pack programs. Hooks and fsmonitor are switched off on every call instead.
 * Returns the first such setting's name, or null. Reads the file with git (`--no-includes`), which runs nothing.
 */
const RUNS_PROGRAM = [/^include\./, /^includeif\./, /^filter\..+\.(clean|smudge|process)$/, /^diff\..+\.(textconv|command)$/, /^merge\..+\.driver$/,
  /^core\.(sshcommand|gitproxy|askpass|pager|editor|alternaterefscommand)$/, /^credential\.(.+\.)?helper$/, /^protocol\.ext\.allow$/,
  /^remote\..+\.(uploadpack|receivepack)$/, /^uploadpack\.packobjectshook$/, /^sequence\.editor$/, /^ssh\.variant$/];
export function unsafeRepoConfig(bin, gitDir) {
  const f = join(gitDir, 'config');
  if (!existsSync(f)) return null;
  const r = spawnSync(bin, ['config', '--file', f, '--no-includes', '--null', '--list'], { encoding: 'utf8', timeout: 30_000, cwd: tmpdir(), windowsHide: true,
    env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k))) });
  if (r.status !== 0) return 'the clone\'s .git/config could not be read';
  for (const entry of r.stdout.split('\0').filter(Boolean)) {
    const name = entry.split('\n')[0].toLowerCase();
    if (RUNS_PROGRAM.some((re) => re.test(name))) return name;
  }
  return null;
}
const firstErr = (r) => (String(r.stderr || r.stdout || r.error?.message || '').split(/\r?\n/).map((l) => l.replace(/^(fatal|error|hint): /, '').trim()).find(Boolean) ?? `git exit ${r.status}`).slice(0, 300);

/** The connector's own empty hooks folder, emptied again before each commit. */
function emptyHooks(home) {
  const d = join(home, 'no-hooks');
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  if (readdirSync(d).length) refuse('the connector could not prepare its empty hooks folder');
  return d;
}

/**
 * Commits `paths` in the clone at `folder`. `author` is {name, email} from the hub. Resolves {ok: true, commit, branch,
 * created, files} or {ok: false, reason}: the reason is one plain line for the agent.
 */
export function commitFiles({ home, folder, paths, message, branch = null, author, gitBin }) {
  try {
    if (!author?.name) refuse('the connector does not know this agent\'s name yet; try again in a moment');
    if (!Array.isArray(paths) || !paths.length) refuse('name at least one file in paths');
    if (paths.length > MAX_PATHS) refuse(`at most ${MAX_PATHS} files in one commit`);
    if (typeof message !== 'string' || !message.trim()) refuse('a commit message is needed');
    if (message.length > MAX_MESSAGE || message.includes('\0')) refuse(`the message must be at most ${MAX_MESSAGE} characters, with no NUL`);
    if (branch !== null && branch !== undefined && !validBranch(branch)) refuse(`${JSON.stringify(branch)} is not a branch name this tool takes (letters, digits, . _ / -; no leading -, no ..)`);
    const files = [...new Set(paths.map(cleanPath))];

    let root;
    try { root = realpathSync.native(folder); } catch { refuse('this folder is not there any more'); }
    let gd;
    try { gd = lstatSync(join(root, '.git')); } catch { refuse('this folder is not a git clone'); }
    if (!gd.isDirectory()) refuse('this folder is a git worktree or a linked repo, not its own clone; commit is refused');
    const bin = gitBin ?? gitPath(home) ?? 'git';
    const git = mkGit(bin, root, emptyHooks(home), { name: author.name, email: author.email });
    const top = git(['rev-parse', '--show-toplevel']);
    if (top.status !== 0) refuse(`this folder is not a git clone (${firstErr(top)})`);
    let topReal;
    try { topReal = realpathSync.native(top.stdout.trim()); } catch { topReal = top.stdout.trim(); }
    if (pathKey(topReal) !== pathKey(root)) refuse('this folder is not the top of its own clone');

    const kinds = files.map((f) => [f, contained(root, f)]);
    for (const [f, k] of kinds) if (k === 'gone' && git(['ls-files', '--error-unmatch', '--', f]).status !== 0) refuse(`${f}: there is no such file, and git does not track it`);

    // The branch: the one checked out, or the one named (switched to, or created from here, keeping the changes).
    const cur = git(['symbolic-ref', '-q', '--short', 'HEAD']);
    const current = cur.status === 0 ? cur.stdout.trim() : null;
    const target = branch ?? current;
    if (!target) refuse('this clone is on no branch; pass branch with a name of your own');
    if (!validBranch(target)) refuse(`you are on ${JSON.stringify(target)}, which this tool does not take; pass branch with a name of your own`);
    const remotes = git(['for-each-ref', '--format=%(refname)', 'refs/remotes']).stdout.split(/\r?\n/).filter(Boolean);
    const shared = remotes.find((r) => r.split('/').slice(3).join('/') === target);
    const upstream = git(['config', '--get', `branch.${target}.remote`]).stdout.trim();
    if (shared || upstream) refuse(`${target} is a shared branch (${shared ? shared.replace(/^refs\/remotes\//, '') : `it tracks ${upstream}`}); commit on a branch of your own: pass branch, for example "dev/<topic>"`);
    let created = false;
    if (target !== current) {
      const exists = git(['rev-parse', '--verify', '-q', `refs/heads/${target}`]).status === 0;
      const sw = exists ? git(['checkout', '-q', target, '--']) : git(['checkout', '-q', '-b', target]);
      if (sw.status !== 0) refuse(`could not switch to ${target}: ${firstErr(sw)}`);
      created = !exists;
    }

    // A folder set up from scratch lists `*` in .git/info/exclude, which would make git skip a new file. Only that line is
    // overridden (--force); a file the repo's .gitignore or the global excludes hide (a .env, a key file) is refused.
    const plain = [], forced = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (kinds[i][1] === 'gone' || git(['ls-files', '--error-unmatch', '--', f]).status === 0) { plain.push(f); continue; }
      const why = ignoredBy(git, root, f);
      if (why === 'star') forced.push(f);
      else if (why) refuse(`${f}: is ignored by ${why}, so it is not committed; ask the PC's user if it should be`);
      else plain.push(f);
    }
    for (const [list, force] of [[plain, false], [forced, true]]) {
      if (!list.length) continue;
      const add = git(['add', '-A', ...(force ? ['-f'] : []), '--', ...list]);
      if (add.status !== 0) refuse(`git add: ${firstErr(add)}`);
    }
    const c = git(['commit', '-q', '--no-verify', '--no-edit', '--only', '-F', '-', '--', ...files], message.replace(/\r\n/g, '\n'));
    if (c.status !== 0) refuse(/nothing (added )?to commit|no changes added/i.test(`${c.stdout}${c.stderr}`) ? 'nothing to commit: those files have no changes' : `git commit: ${firstErr(c)}`);
    const head = git(['rev-parse', 'HEAD']).stdout.trim();
    return { ok: true, commit: head, branch: target, created, files };
  } catch (e) {
    if (e instanceof Refused) return { ok: false, reason: e.message };
    return { ok: false, reason: `the commit failed: ${String(e?.message ?? e).slice(0, 200)}` };
  }
}

/** The tools/call answer for a commit result. */
export function commitAnswer(r) {
  if (!r.ok) return { content: [{ type: 'text', text: `Not committed: ${r.reason}` }], structuredContent: { committed: false, reason: r.reason }, isError: true };
  const text = `Committed ${r.commit.slice(0, 12)} on ${r.branch}${r.created ? ' (a new branch)' : ''}: ${r.files.length} file${r.files.length === 1 ? '' : 's'}. Nothing was pushed.`;
  return { content: [{ type: 'text', text }], structuredContent: { committed: true, commit: r.commit, branch: r.branch, created: r.created, files: r.files, pushed: false } };
}
