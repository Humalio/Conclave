/**
 * The connector's logon service, installed and removed as the user with no admin rights (docs/connector.md "The connector
 * service", proof 8). One entry per installation, named after a short hash of the connector's folder:
 *
 * - Windows: a scheduled task with an At log on trigger for the current user, made with Register-ScheduledTask. It
 *   starts `conhost.exe --headless`, so no window opens. `schtasks /sc onlogon` is refused without admin (proof 8).
 *   The trigger repeats every minute while the user is logged on, which starts a service that died again.
 * - macOS: a LaunchAgent in ~/Library/LaunchAgents, loaded into the user's GUI session.
 * - Linux: a systemd user unit; where the user has no systemd session, an XDG autostart file.
 *
 * Every system command goes through `exec`, so tests can check them on any platform. Nothing here needs a key.
 */
import { join, dirname, posix, win32 } from 'node:path';
import { homedir as osHome } from 'node:os';
import { spawnSync, spawn } from 'node:child_process';
import { existsSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { atomicWrite, pathKey, readJson } from './paths.mjs';
import { alive } from './run.mjs';
import { lockHolder, killTree } from './processes.mjs';

export const serviceId = (home) => createHash('sha256').update(pathKey(home)).digest('hex').slice(0, 8);
const POWERSHELL = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const CONHOST = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'conhost.exe');
const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const sysq = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
// A path setting such as WorkingDirectory= takes the rest of the line as it is: no quotes (systemd refuses a quoted one as
// not absolute), only `%` doubled so it is not read as a specifier. Spaces need nothing.
const syspath = (s) => String(s).replace(/%/g, '%%');
const deskq = (s) => `"${String(s).replace(/[\\"`$]/g, (c) => `\\${c}`)}"`;

/** Where the entry lives on each platform (`target` is what the manifest records), and its name. */
export function servicePlace(home, { platform = process.platform, userHome = osHome(), systemd = true } = {}) {
  const id = serviceId(home);
  if (platform === 'win32') return { kind: 'scheduled_task', name: `Conclave connector ${id}`, target: `task:\\Conclave connector ${id}` };
  if (platform === 'darwin') { const label = `com.conclave.connector.${id}`; return { kind: 'launch_agent', name: label, target: join(userHome, 'Library', 'LaunchAgents', `${label}.plist`) }; }
  if (systemd) return { kind: 'systemd_user', name: `conclave-connector-${id}.service`, target: join(userHome, '.config', 'systemd', 'user', `conclave-connector-${id}.service`) };
  return { kind: 'xdg_autostart', name: `conclave-connector-${id}.desktop`, target: join(userHome, '.config', 'autostart', `conclave-connector-${id}.desktop`) };
}

/** Every place the manifest may record a service entry at, for this installation. */
export const serviceTargets = (home, o = {}) => [...new Set([servicePlace(home, { ...o, systemd: true }).target, servicePlace(home, { ...o, systemd: false }).target])];

/** The file or script each platform needs, and the commands that install, remove and query it. Pure. */
export function serviceSpec(home, { platform = process.platform, node = process.execPath, userHome = osHome(), uid = process.getuid?.() ?? 0, systemd = true } = {}) {
  const place = servicePlace(home, { platform, userHome, systemd });
  // The launcher path in the platform's own form (this also keeps the generated files right when built elsewhere).
  const launcher = (platform === 'win32' ? win32 : posix).join(home, 'conclave.mjs');
  if (platform === 'win32') {
    const args = `--headless "${node}" "${launcher}" service run`;
    const me = '([System.Security.Principal.WindowsIdentity]::GetCurrent().Name)';
    const register = [
      "$ErrorActionPreference = 'Stop'",
      `$a = New-ScheduledTaskAction -Execute ${psq(CONHOST)} -Argument ${psq(args)} -WorkingDirectory ${psq(home)}`,
      `$t = New-ScheduledTaskTrigger -AtLogOn -User ${me}`,
      // A logon trigger's repetition only starts at the next logon, so a second, time trigger repeats from the moment the task is
      // registered (once, every REVIVE_INTERVAL_MIN, no end). It brings a killed service back without a logon.
      `$t.Repetition = (New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes ${REVIVE_INTERVAL_MIN})).Repetition`,
      `$r = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes ${REVIVE_INTERVAL_MIN})`,
      `$p = New-ScheduledTaskPrincipal -UserId ${me} -LogonType Interactive -RunLevel Limited`,
      // Restart-on-failure covers a start that fails; a service that dies later comes back through the repeating trigger above.
      `$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount ${RESTART_COUNT} -RestartInterval (New-TimeSpan -Minutes ${RESTART_INTERVAL_MIN})`,
      `Register-ScheduledTask -TaskName ${psq(place.name)} -TaskPath '\\' -Action $a -Trigger @($t, $r) -Principal $p -Settings $s -Description 'Conclave connector: checks in with the hub, runs transfers and approved updates.' -Force | Out-Null`,
    ];
    const install = [...register, `Start-ScheduledTask -TaskName ${psq(place.name)} -TaskPath '\\'`].join('; ');
    const remove = [
      `$t = Get-ScheduledTask -TaskName ${psq(place.name)} -TaskPath '\\' -ErrorAction SilentlyContinue`,
      `if ($t) { Stop-ScheduledTask -TaskName ${psq(place.name)} -TaskPath '\\' -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName ${psq(place.name)} -TaskPath '\\' -Confirm:$false }`,
    ].join('; ');
    const status = `$t = Get-ScheduledTask -TaskName ${psq(place.name)} -TaskPath '\\' -ErrorAction SilentlyContinue; if ($t) { [string]$t.State } else { 'absent' }`;
    const ps = (s) => [POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(s, 'utf16le').toString('base64')], s];
    return { place, file: null, install: [ps(install)], register: ps(register.join('; ')), remove: [ps(remove)], status: ps(status) };
  }
  if (platform === 'darwin') {
    const file = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(place.name)}</string>
  <key>ProgramArguments</key>
  <array><string>${xml(node)}</string><string>${xml(launcher)}</string><string>service</string><string>run</string></array>
  <key>WorkingDirectory</key><string>${xml(home)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
`;
    const dom = `gui/${uid}`;
    return { place, file, install: [['launchctl', ['bootout', `${dom}/${place.name}`], null, true], ['launchctl', ['bootstrap', dom, place.target]]], remove: [['launchctl', ['bootout', `${dom}/${place.name}`], null, true]], status: ['launchctl', ['print', `${dom}/${place.name}`]] };
  }
  if (systemd) {
    const file = `[Unit]
Description=Conclave connector (checks in with the hub, runs transfers and approved updates)

[Service]
ExecStart=${sysq(node)} ${sysq(launcher)} service run
WorkingDirectory=${syspath(home)}
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`;
    return { place, file, install: [['systemctl', ['--user', 'daemon-reload']], ['systemctl', ['--user', 'enable', '--now', place.name]]], remove: [['systemctl', ['--user', 'disable', '--now', place.name], null, true]], after_remove: [['systemctl', ['--user', 'daemon-reload'], null, true]], status: ['systemctl', ['--user', 'is-active', place.name]] };
  }
  const file = `[Desktop Entry]
Type=Application
Name=Conclave connector
Comment=Checks in with the hub, runs transfers and approved updates
Exec=${deskq(node)} ${deskq(launcher)} service run
NoDisplay=true
X-GNOME-Autostart-enabled=true
`;
  return { place, file, install: [], remove: [], status: null, start_now: [node, [launcher, 'service', 'run']] };
}

/** The default `exec`: runs a command with no shell, 60 s at most. */
export const execDefault = (cmd, args) => { const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 60_000, windowsHide: true }); return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error ? String(r.error.message) : '') }; };

/** True if this Linux user has a systemd user session. */
export const hasSystemd = (exec = execDefault) => exec('systemctl', ['--user', 'show-environment']).status === 0;

/** How often, and how many times, Task Scheduler starts a Windows service again after it failed (the shortest interval it allows is a minute). */
export const RESTART_COUNT = 999, RESTART_INTERVAL_MIN = 1;
/**
 * How often the logon trigger fires again while the user stays logged on. This is what brings back a service that
 * died: Task Scheduler's restart-on-failure does not fire for it, because `conhost.exe --headless` ends with 0 when node
 * is killed, and a repetition does not depend on any exit code. While the service runs, the repeat is a no-op
 * (`-MultipleInstances IgnoreNew`, and the supervisor's own lock stops a second one at once). After `service remove`
 * the task is gone; after a logoff an interactive task does not run.
 */
export const REVIVE_INTERVAL_MIN = 1;

/** The supervisor's lock (its process id and start time), so a second one stops and `remove` can stop the one running. */
export const servicePidPath = (home) => join(home, 'run', 'service.json');
/** The worker's lock: one worker per installation (worker.mjs). */
export const workerLockPath = (home) => join(home, 'run', 'worker.json');

/** Installs (or replaces) the logon entry and starts it. `{ok, place}` or `{ok: false, reason, detail}`. */
export function installService(home, o = {}) {
  const exec = o.exec ?? execDefault;
  const platform = o.platform ?? process.platform;
  const systemd = platform === 'linux' ? (o.systemd ?? hasSystemd(exec)) : true;
  const spec = serviceSpec(home, { ...o, platform, systemd });
  if (spec.file !== null) atomicWrite(spec.place.target, spec.file);
  for (const [cmd, args, , optional] of spec.install) {
    const r = exec(cmd, args);
    if (r.status !== 0 && !optional) return { ok: false, reason: 'service_install_failed', detail: firstLine(r.stderr || r.stdout), place: spec.place };
  }
  if (spec.start_now && !o.noStart) (o.spawnDetached ?? spawnDetached)(...spec.start_now);
  if (spec.register) markDefinition(home, spec);
  return { ok: true, place: spec.place };
}

export const REFRESH_RETRY_MS = 3600_000;
const definitionPath = (home) => join(home, 'run', 'service-task.json');
const definitionHash = (spec) => createHash('sha256').update(spec.register[2]).digest('hex');
function markDefinition(home, spec) { try { mkdirSync(dirname(definitionPath(home)), { recursive: true }); writeFileSync(definitionPath(home), JSON.stringify({ sha256: definitionHash(spec) })); } catch { /* the next start tries again */ } }

/**
 * Windows: when the registered task is not the one this build makes (an update leaves the old task in place), registers the
 * current one without starting or stopping anything. `{changed}`, plus `error` if it could not. Other platforms, and a PC
 * with no service: no change.
 */
export function refreshService(home, o = {}) {
  const platform = o.platform ?? process.platform;
  if (platform !== 'win32') return { changed: false };
  const spec = serviceSpec(home, { ...o, platform });
  const sha = definitionHash(spec), mark = readJson(definitionPath(home), null), now = (o.now ?? Date.now)();
  if (mark?.sha256 === sha) return { changed: false };
  // A registration that failed is not tried again for an hour: each minute's revive runs this, and it must cost nothing.
  if (mark?.failed_sha256 === sha && now - (mark.failed_at ?? 0) < REFRESH_RETRY_MS) return { changed: false };
  if (!serviceStatus(home, o).installed) return { changed: false };
  const exec = o.exec ?? execDefault;
  const r = exec(spec.register[0], spec.register[1]);
  if (r.status !== 0) {
    const error = firstLine(r.stderr || r.stdout) || 'the task could not be registered';
    try { mkdirSync(dirname(definitionPath(home)), { recursive: true }); writeFileSync(definitionPath(home), JSON.stringify({ failed_sha256: sha, failed_at: now, error })); } catch { /* tried again at the next start */ }
    return { changed: false, error };
  }
  markDefinition(home, spec);
  return { changed: true };
}

/** Removes the logon entry and stops the service it started. Safe when nothing is installed. */
export function removeService(home, o = {}) {
  const exec = o.exec ?? execDefault;
  const platform = o.platform ?? process.platform;
  const removed = [];
  for (const systemd of platform === 'linux' ? [true, false] : [true]) {
    const spec = serviceSpec(home, { ...o, platform, systemd });
    if (platform === 'linux' && systemd && !existsSync(spec.place.target)) continue;
    for (const [cmd, args] of spec.remove) exec(cmd, args);
    if (spec.file !== null && existsSync(spec.place.target)) { rmSync(spec.place.target, { force: true }); }
    for (const [cmd, args] of spec.after_remove ?? []) exec(cmd, args);
    removed.push(spec.place);
  }
  // The supervisor first, so it does not start the worker again, then the worker it recorded; each only while the lock
  // still names that very process (same id and start time), never a process that reused the id.
  // The supervisor gets a plain stop (its own tree may include the process calling this); the worker's tree is ended.
  // A lock is removed only once its holder is gone or was ended here, so `noKill` never frees a live worker's lock.
  for (const [p, stop] of [[servicePidPath(home), (pid) => { try { process.kill(pid); } catch { /* already gone */ } }], [workerLockPath(home), o.killTree ?? killTree]]) {
    const h = lockHolder(p, o.lockDeps);
    if (h && h.pid !== process.pid && !o.noKill) stop(h.pid);
    if (!h || (h.pid !== process.pid && !o.noKill)) rmSync(p, { force: true });
  }
  return { ok: true, removed };
}

/** `installed` / `absent`, and whether the service's supervisor is running now. */
export function serviceStatus(home, o = {}) {
  const exec = o.exec ?? execDefault;
  const platform = o.platform ?? process.platform;
  const s = readJson(servicePidPath(home), null);
  const running = !!(s && alive(s.pid));
  for (const systemd of platform === 'linux' ? [true, false] : [true]) {
    const spec = serviceSpec(home, { ...o, platform, systemd });
    if (platform === 'win32') {
      const r = exec(spec.status[0], spec.status[1]);
      const st = firstLine(r.stdout);
      return { installed: r.status === 0 && st !== '' && st !== 'absent', state: st || null, running, place: spec.place };
    }
    if (existsSync(spec.place.target)) return { installed: true, state: null, running, place: spec.place };
  }
  return { installed: false, state: null, running, place: servicePlace(home, { ...o, platform }) };
}

function spawnDetached(cmd, args) { spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref(); }
const firstLine = (s) => String(s ?? '').split(/\r?\n/).map((l) => l.trim()).find(Boolean)?.slice(0, 200) ?? '';
export const readServiceFile = (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } };
