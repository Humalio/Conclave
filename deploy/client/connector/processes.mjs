/**
 * The processes the connector started, and nothing else (review-v2 §4, Disconnect: "Only processes the connector started
 * are ended"). Whatever the connector launches (the service's worker, a transfer, a woken turn) is recorded here with its
 * pid, its program, the script it runs (when it runs one) and the hub it works for. Uninstall and Disconnect end only
 * recorded processes, and only while that pid still runs the recorded program with the recorded script, so a recycled
 * pid (even one that now runs the user's own Node script), the user's own Claude Code or Codex, or another hub's work is
 * never touched. A record whose process is gone is simply dropped.
 */
import { join, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readFileSync, readlinkSync, realpathSync, existsSync } from 'node:fs';
import { readJson, atomicWrite, WIN } from './paths.mjs';

export const processesPath = (home) => join(home, 'processes.json');
const load = (home) => { const j = readJson(processesPath(home), { version: 1, processes: [] }); return j && j.version === 1 && Array.isArray(j.processes) ? j : { version: 1, processes: [] }; };
const save = (home, j) => atomicWrite(processesPath(home), JSON.stringify(j, null, 2) + '\n');

/**
 * Records a process the connector just started. `hubKey` is null for work that belongs to no single hub. `script` is
 * the absolute path of the script the program was given (a Node worker's launcher); a process is then only ever taken
 * for this one while its command line still names that script.
 */
export function recordStarted(home, { pid, image, script = null, hubKey = null, what }) {
  if (!Number.isInteger(pid) || pid <= 0 || typeof image !== 'string' || !image) throw new Error('a pid and the program path are required');
  if (script !== null && (typeof script !== 'string' || !script)) throw new Error('the script, when given, is a path');
  const j = load(home);
  j.processes = [...j.processes.filter((p) => p.pid !== pid), { pid, image, ...(script ? { script } : {}), hub_key: hubKey, what: String(what ?? ''), started_at: new Date().toISOString() }];
  save(home, j);
}

/** Drops a record (the process ended normally). */
export function forgetStarted(home, pid) {
  const j = load(home);
  const n = j.processes.filter((p) => p.pid !== pid);
  if (n.length !== j.processes.length) { j.processes = n; save(home, j); }
}

const realOr = (p) => { try { return realpathSync(p); } catch { return p; } };

/** Does a command line, as one string, name `script` as a whole argument (bare or quoted)? Case is ignored on Windows. */
export function namesScript(cmdline, script, win = WIN) {
  const fold = (x) => (win ? x.toLowerCase() : x);
  const line = fold(String(cmdline ?? '')), want = fold(script);
  for (let at = line.indexOf(want); at !== -1; at = line.indexOf(want, at + 1)) {
    const before = at === 0 ? ' ' : line[at - 1], after = line[at + want.length] ?? ' ';
    if (/[\s"']/.test(before) && /[\s"']/.test(after)) return true;
  }
  return false;
}

/** The command line of `pid` on Windows, read from CIM (tasklist does not show it), or null. */
function windowsCommandLine(pid) {
  const ps = `[Console]::OutputEncoding=[Text.Encoding]::UTF8; $p = Get-CimInstance Win32_Process -Filter 'ProcessId=${Number(pid)}'; if ($p) { $p.CommandLine }`;
  const exe = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const r = spawnSync(exe, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, shell: false, timeout: 30_000 });
  const out = r.status === 0 ? String(r.stdout || '').trim() : '';
  return out || null;
}

/**
 * Is `pid` a running process whose program is `image` and, when `script` is given, whose command line names that
 * script? A recycled pid running something else, or the same program with another script, is not. Anything that cannot
 * be confirmed counts as not ours, so it is never ended.
 */
export function runningAs(pid, image, script = null) {
  if (!pid) return false;
  if (WIN) {
    const r = spawnSync(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tasklist.exe'), ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, shell: false });
    if (!String(r.stdout || '').toLowerCase().includes(`"${basename(image).toLowerCase()}","${pid}"`)) return false;
    return !script || namesScript(windowsCommandLine(pid), script, true);
  }
  try { process.kill(pid, 0); } catch { return false; }
  return programIs(pid, image) && (!script || scriptIs(pid, script));
}

/** Linux: any argument after the program is the script (exact or the same file). Elsewhere: ps's full command line. */
function scriptIs(pid, script) {
  if (existsSync('/proc/self')) {
    try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').slice(1).some((a) => a && (a === script || realOr(a) === realOr(script))); } catch { return false; }
  }
  const r = spawnSync('/bin/ps', ['-ww', '-p', String(pid), '-o', 'args='], { encoding: 'utf8', shell: false });
  return r.status === 0 && namesScript(String(r.stdout || '').trim(), script, false);
}

function programIs(pid, image) {
  if (existsSync('/proc/self')) {
    // Linux: the program's own path first. Its comm is not enough: Node 24 names its main thread "MainThread".
    try { if (readlinkSync(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, '') === realOr(image)) return true; } catch { /* another user's process */ }
    try { const argv0 = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')[0]; if (argv0 && (argv0 === image || realOr(argv0) === realOr(image))) return true; } catch { /* gone */ }
    try { return readFileSync(`/proc/${pid}/comm`, 'utf8').trim() === basename(image).slice(0, 15); } catch { return false; }
  }
  // Without /proc, ps names the program; if nothing can confirm it, the process is treated as not ours (never ended).
  const r = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8', shell: false });
  const comm = r.status === 0 ? String(r.stdout || '').trim() : '';
  return !!comm && basename(comm) === basename(image);
}

/** Ends a process and the processes it started. */
export function killTree(pid) {
  if (WIN) spawnSync(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true, shell: false });
  else { try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } }
}

/**
 * Ends the recorded processes in a scope: `{kind: 'hub', hubKey}` (that hub's only) or `{kind: 'all'}`. `deps` lets
 * tests replace `runningAs` and `killTree`. Returns `{ended, gone}`: pids ended, and records dropped because their
 * process had already gone (or the pid now runs another program, which is left alone).
 */
export function stopStarted(home, scope, deps = {}) {
  const alive = deps.runningAs ?? runningAs, kill = deps.killTree ?? killTree;
  const j = load(home);
  const inScope = (p) => scope.kind === 'all' || p.hub_key === scope.hubKey;
  const ended = [], gone = [];
  for (const p of j.processes.filter(inScope)) {
    if (p.pid === process.pid) continue; // the run doing the removal (the service, say) is never ended by it
    if (alive(p.pid, p.image, p.script ?? null)) { kill(p.pid); ended.push(p.pid); } else gone.push(p.pid);
  }
  j.processes = j.processes.filter((p) => !inScope(p));
  save(home, j);
  return { ended, gone };
}
