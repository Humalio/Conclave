/**
 * Installing, checking and removing the key service (docs/connector.md, "Hardened isolation"). Installing needs an
 * administrator and is the operator's step; this module only builds it, and every system command goes through `exec`
 * so the tests run all of it on any platform without changing the PC.
 *
 * The install is a MIGRATION with a rollback: nothing the connector reads changes until the service holds every key and has
 * signed in with each of them through its relay. Any failure removes what was added and leaves the user's own key file
 * as it was, so every agent keeps working at Standard.
 *
 *   1. every agent can sign in now (a turn token is issued and revoked)      3. the service is created, started and pinged
 *   2. a backup of the key file goes into the vault folder (admin only)       4. the same check runs THROUGH the service's relay
 *   5. isolation.json is written, then the user's key file is removed
 */
import { join, resolve, win32, posix } from 'node:path';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, existsSync, readdirSync, readFileSync, writeFileSync, statSync, chownSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { readKeyFile, keyFilePath, restoreKeyFile, putHub, putAgentKey } from './keyfile.mjs';
import { masterPath } from './keystore.mjs';
import { readIsolation, writeMarker, markerPath, vaultPlace } from './isolation.mjs';
import { askVault } from './vaultclient.mjs';
import { connect, request } from './hubclient.mjs';
import { startVault } from './vault.mjs';

export const SERVICE_NAME = 'Conclave';
export const ACCOUNT = 'NT SERVICE\\Conclave';
export const LINUX_USER = 'conclave';
const q = (s) => `"${String(s).replace(/"/g, '\\"')}"`;

/** The C# source of the small Windows service host: node cannot speak the service protocol, so this starts it and stops it. */
export const HOST_SOURCE = `using System;
using System.Diagnostics;
using System.ServiceProcess;
public class ConclaveVaultHost : ServiceBase {
  Process p;
  public static void Main(string[] a) { ServiceBase.Run(new ConclaveVaultHost()); }
  protected override void OnStart(string[] a) {
    string[] c = Environment.GetCommandLineArgs();
    var si = new ProcessStartInfo(c[1]);
    var rest = new System.Text.StringBuilder();
    for (int i = 2; i < c.Length; i++) { if (rest.Length > 0) rest.Append(' '); rest.Append('"').Append(c[i].Replace("\\"", "\\\\\\"")).Append('"'); }
    si.Arguments = rest.ToString(); si.UseShellExecute = false; si.CreateNoWindow = true;
    si.EnvironmentVariables["CONCLAVE_KEY_STORE"] = "file";
    p = Process.Start(si);
    new System.Threading.Thread(() => { p.WaitForExit(); Environment.Exit(1); }).Start();
  }
  protected override void OnStop() { try { if (p != null && !p.HasExited) p.Kill(); } catch { } }
}
`;

/**
 * Everything one platform needs: the paths and the ordered commands that create, start, stop and remove the service.
 * Pure. \`platform\` is win32 or linux; macOS has no hardened level yet (\`null\`).
 */
export function vaultSpec(home, { platform = process.platform, node = process.execPath, place = vaultPlace(home, { platform }) } = {}) {
  if (platform !== 'win32' && platform !== 'linux') return null;
  const p = platform === 'win32' ? win32 : posix;
  const script = p.join(place.app, 'conclave.mjs');
  const run = [script, 'vault', 'run', '--vault', place.dir, '--view', place.view, '--address', place.address];
  if (platform === 'win32') {
    const exe = win32.join(place.app, 'ConclaveVault.exe');
    const grant = (d, extra = []) => ['icacls', [d, '/inheritance:r', '/grant:r', `${ACCOUNT}:(OI)(CI)F`, 'NT AUTHORITY\\SYSTEM:(OI)(CI)F', 'BUILTIN\\Administrators:(OI)(CI)F', ...extra]];
    const compile = ['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      `Add-Type -TypeDefinition (Get-Content -Raw -LiteralPath ${q(win32.join(place.app, 'host.cs')).replace(/"/g, "'")}) -ReferencedAssemblies System.ServiceProcess -OutputAssembly ${q(exe).replace(/"/g, "'")} -OutputType ConsoleApplication`]];
    return {
      platform, place, exe, script, account: ACCOUNT, hostSource: HOST_SOURCE,
      create: [
        ['compile the service host', ...compile],
        ['create the service', 'sc.exe', ['create', SERVICE_NAME, 'binPath=', `${q(exe)} ${q(node)} ${run.map(q).join(' ')}`, 'obj=', ACCOUNT, 'start=', 'delayed-auto', 'DisplayName=', 'Conclave key service']],
        ['let the service account use its own security identifier', 'sc.exe', ['sidtype', SERVICE_NAME, 'unrestricted']],
      ],
      secure: [
        ['limit the vault folder to the service, SYSTEM and administrators', ...grant(place.dir)],
        ['let this PC read the public key view', ...grant(win32.dirname(place.view), ['BUILTIN\\Users:(OI)(CI)R'])],
        ['let the service run its copy of the connector, which nobody else may change', 'icacls', [place.app, '/inheritance:r', '/grant:r', `${ACCOUNT}:(OI)(CI)RX`, 'BUILTIN\\Users:(OI)(CI)RX', 'NT AUTHORITY\\SYSTEM:(OI)(CI)F', 'BUILTIN\\Administrators:(OI)(CI)F']],
      ],
      files: [],
      start: [['start the service', 'sc.exe', ['start', SERVICE_NAME]]],
      stop: [['stop the service', 'sc.exe', ['stop', SERVICE_NAME]]],
      remove: [['stop the service', 'sc.exe', ['stop', SERVICE_NAME]], ['delete the service', 'sc.exe', ['delete', SERVICE_NAME]]],
      query: ['sc.exe', ['query', SERVICE_NAME]],
    };
  }
  const unit = `conclave-vault-${place.id}.service`, unitPath = `/etc/systemd/system/${unit}`;
  const unitText = `[Unit]\nDescription=Conclave key service\nAfter=network.target\n\n[Service]\nUser=${LINUX_USER}\nGroup=${LINUX_USER}\nEnvironment=CONCLAVE_KEY_STORE=file\nRuntimeDirectory=conclave\nRuntimeDirectoryMode=0755\nExecStart=${node} ${run.join(' ')}\nRestart=on-failure\nNoNewPrivileges=true\nProtectHome=true\nProtectSystem=strict\nReadWritePaths=${place.root}\n\n[Install]\nWantedBy=multi-user.target\n`;
  return {
    platform, place, script, account: LINUX_USER, unit, unitPath, unitText,
    create: [
      ['create the system user', 'sh', ['-c', `id ${LINUX_USER} >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin ${LINUX_USER}`]],
    ],
    files: [{ path: unitPath, text: unitText }],
    secure: [
      ['limit the vault folder to the service user', 'chown', ['-R', `${LINUX_USER}:${LINUX_USER}`, place.dir, posix.dirname(place.view)]],
      ['make the vault folder private', 'chmod', ['0700', place.dir]],
      ['let this PC read the public key view', 'chmod', ['0755', posix.dirname(place.view)]],
      ['let the service run its copy of the connector, which nobody else may change', 'chown', ['-R', 'root:root', place.app]],
      ['reload the service list', 'systemctl', ['daemon-reload']],
    ],
    start: [['start the service', 'systemctl', ['enable', '--now', unit]]],
    stop: [['stop the service', 'systemctl', ['stop', unit]]],
    remove: [['stop the service', 'systemctl', ['disable', '--now', unit]]],
    afterRemove: [['reload the service list', 'systemctl', ['daemon-reload']]],
    query: ['systemctl', ['is-active', unit]],
  };
}

/**
 * The folder of the PC user whose keys these are, when the command runs elevated. `--home` and CONCLAVE_HOME win; under sudo
 * (SUDO_USER) it is that user's own ~/.config/conclave, not root's; otherwise the home of whoever runs it. On Windows an
 * elevation by another administrator account cannot be told apart, so it needs `--home` (the error says so).
 * `o`: `flag` (--home), `env`, `platform`, `passwd` (user to home folder; tests replace it).
 */
export function serviceHome(o = {}) {
  const env = o.env ?? process.env, platform = o.platform ?? process.platform;
  if (o.flag) return { home: resolve(o.flag), source: '--home' };
  if (env.CONCLAVE_HOME) return { home: resolve(env.CONCLAVE_HOME), source: 'CONCLAVE_HOME' };
  if (platform !== 'win32' && env.SUDO_USER && env.SUDO_USER !== 'root') {
    const h = (o.passwd ?? passwdHome)(env.SUDO_USER);
    if (h) return { home: join(h, '.config', 'conclave'), source: 'SUDO_USER' };
  }
  return { home: join(homedir(), '.config', 'conclave'), source: 'this account' };
}
function passwdHome(user) {
  const r = spawnSync('getent', ['passwd', user], { encoding: 'utf8' });
  const h = r.status === 0 ? String(r.stdout).split(':')[5] : '';
  return h || null;
}
/**
 * Gives what an elevated run wrote in the PC user's folder back to that user (POSIX: chown to the owner of the folder), so
 * the user's own connector can read and rewrite it. `o.chown` and `o.owner` ({uid, gid}) are replaced in tests. Returns the paths it changed.
 */
export function handBack(home, o = {}) {
  if ((o.platform ?? process.platform) === 'win32') return [];
  const st = o.owner ?? statSync(home), chown = o.chown ?? chownSync, done = [];
  for (const p of [home, keyFilePath(home), masterPath(home), markerPath(home)]) {
    if (!existsSync(p)) continue;
    const s = statSync(p);
    if (s.uid !== st.uid || s.gid !== st.gid) { chown(p, st.uid, st.gid); done.push(p); }
  }
  return done;
}

/** What `conclave install-service` says for each reason it can stop with (the operator reads these). */
export const VAULT_LINES = {
  needs_admin: 'Installing the key service needs administrator rights: open a terminal as administrator (Windows) or use sudo (Linux), then run the command again. Nothing was changed.',
  platform_unsupported: 'Hardened isolation is for Windows and Linux; this PC stays at Standard.',
  already_hardened: 'This PC already runs Hardened isolation.',
  not_paired: 'This PC is not paired with a hub yet (for this account), so there are no keys to protect. Run elevated as another account? Say whose keys: conclave install-service --home <the PC user .config/conclave folder>.',
  agent_cannot_sign_in: 'An agent cannot sign in with its key right now, so the keys were not moved. Fix that first (conclave check --probe).',
  service_not_created: 'The key service could not be created.',
  folder_not_secured: 'The key service folder could not be limited to the service account.',
  service_not_started: 'The key service could not be started.',
  service_not_answering: 'The key service started but did not answer in time.',
  service_view_unavailable: 'The key service did not give its public key view.',
  relay_sign_in_failed: 'An agent could not sign in through the key service, so the keys were not moved.',
  old_key_file_remains: 'The old key file could not be removed, so Hardened was not switched on.',
  keys_not_restored: 'The keys could not be put back into your own key file, so the key service was kept.',
  vault_unreadable: 'The key service folder could not be read. A backup of your key file is in its backup folder.',
  vault_unavailable: 'The key service is not running.',
};

/** Default command runner. Replaced in tests. */
export const sys = {
  exec: (cmd, args, opts = {}) => { const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 120_000, ...opts }); return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }; },
  isAdmin(platform = process.platform) {
    if (platform === 'win32') return spawnSync('net.exe', ['session'], { windowsHide: true, stdio: 'ignore' }).status === 0;
    return process.getuid?.() === 0;
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One sign-in check per agent of a key-file view or file: a turn token is issued and revoked at once. Resolves `{ok}` or `{ok: false, reason, label}`. */
export async function signInAll(data) {
  for (const [hubKey, s] of Object.entries(data.hubs ?? {})) {
    const c = connect(s);
    if (!c.ok) return { ok: false, reason: c.reason, hubKey };
    for (const [label, a] of Object.entries(s.agents ?? {})) {
      const auth = { Authorization: `Bearer ${s.app_key}` };
      let r;
      try { r = await request(c.hub, 'POST', '/connector/v1/turn-tokens', { body: { session_key: a.session_key, run: `r-${randomBytes(6).toString('hex')}` }, headers: auth }); } catch (e) { return { ok: false, reason: e.reason ?? 'hub_unreachable', label }; }
      if (r.status !== 200 || typeof r.json?.token !== 'string') return { ok: false, reason: 'login_refused', label };
      await request(c.hub, 'POST', '/connector/v1/turn-tokens/revoke', { body: { token: r.json.token, reason: 'turn_ended' }, headers: auth }).catch(() => {});
    }
  }
  return { ok: true };
}

/** Runs a list of `[label, cmd, args]`; stops at the first failure: `{ok: false, step, detail}`. */
function runAll(list, exec) {
  for (const [label, cmd, args] of list) {
    const r = exec(cmd, args);
    if (r.status !== 0) return { ok: false, step: label, detail: String(r.stderr || r.stdout || '').trim().split(/\r?\n/)[0].slice(0, 200) };
  }
  return { ok: true };
}

/** Copies the connector's own code where the service runs it from (nobody but an administrator may change it there). */
function copyApp(spec, appSource) {
  mkdirSync(spec.place.app, { recursive: true });
  cpSync(appSource, spec.place.app, { recursive: true, filter: (s) => !/[\\/](?:node_modules|\.git|test|fixtures)(?:[\\/]|$)/.test(s) && !/\.test\.mjs$/.test(s) });
  if (spec.hostSource) writeFileSync(join(spec.place.app, 'host.cs'), spec.hostSource);
}

/**
 * Installs the key service and moves the keys into it, or changes nothing. `o`: `platform`, `node`, `appSource` (the
 * folder holding conclave.mjs and connector/), `place` (tests use temporary folders), `exec`, `isAdmin`, `waitMs`, `start`
 * (tests start the service in-process). Resolves `{ok: true, agents}` or `{ok: false, reason, step?, detail?, rolled_back}`.
 */
export async function installVault(home, o = {}) {
  const platform = o.platform ?? process.platform, exec = o.exec ?? sys.exec;
  const spec = vaultSpec(home, { platform, node: o.node, place: o.place });
  if (!spec) return { ok: false, reason: 'platform_unsupported' };
  if (!(o.isAdmin ?? sys.isAdmin)(platform)) return { ok: false, reason: 'needs_admin' };
  if (readIsolation(home).level === 'hardened') return { ok: false, reason: 'already_hardened' };
  const kf = readKeyFile(home);
  if (!kf.ok) return { ok: false, reason: kf.reason };
  const hubs = Object.entries(kf.data.hubs);
  if (!hubs.length) return { ok: false, reason: 'not_paired' };
  const before = await (o.signInAll ?? signInAll)(kf.data);
  if (!before.ok) return { ok: false, reason: 'agent_cannot_sign_in', detail: before.label ?? before.hubKey ?? before.reason };
  const place = spec.place;
  let service = false;
  const rollback = async (why) => {
    try { rmSync(markerPath(home), { force: true }); } catch { /* nothing was written */ }
    if (service) { runAll(spec.remove, exec); if (spec.afterRemove) runAll(spec.afterRemove, exec); }
    for (const d of [place.root]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
    return { ...why, ok: false, rolled_back: true };
  };
  try {
    mkdirSync(place.dir, { recursive: true }); mkdirSync(join(place.view, '..'), { recursive: true });
    copyApp(spec, o.appSource);
    service = true;
    const made = runAll(spec.create, exec);
    if (!made.ok) return await rollback({ reason: 'service_not_created', ...made });
    for (const f of spec.files) (o.writeFile ?? writeFileSync)(f.path, f.text);
    // The keys go into the vault with the vault's own secret (a file in the folder only the service and administrators open).
    const env = process.env.CONCLAVE_KEY_STORE; process.env.CONCLAVE_KEY_STORE = 'file';
    try {
      for (const [, s] of hubs) {
        const k = putHub(place.dir, { hubId: s.hub_id, origin: s.origin, caPem: s.ca_pem, appKey: s.app_key });
        for (const [label, a] of Object.entries(s.agents ?? {})) putAgentKey(place.dir, k, label, a.session_key);
      }
      // A backup the user cannot read: the user-level file and its secret, inside the vault folder.
      const bk = join(place.dir, 'backup'); mkdirSync(bk, { recursive: true });
      cpSync(keyFilePath(home), join(bk, 'keys.json')); if (existsSync(masterPath(home))) cpSync(masterPath(home), join(bk, 'keys.master'));
    } finally { if (env === undefined) delete process.env.CONCLAVE_KEY_STORE; else process.env.CONCLAVE_KEY_STORE = env; }
    const sec = runAll(spec.secure, exec);
    if (!sec.ok) return await rollback({ reason: 'folder_not_secured', ...sec });
    if (o.start) await o.start(spec); else { const st = runAll(spec.start, exec); if (!st.ok) return await rollback({ reason: 'service_not_started', ...st }); }
    let ping = { ok: false };
    for (let i = 0; i < (o.pings ?? 40) && !ping.ok; i++) { ping = await askVault(place.address, 'ping', {}); if (!ping.ok) await sleep(o.waitMs ?? 500); }
    if (!ping.ok) return await rollback({ reason: 'service_not_answering' });
    const v = await askVault(place.address, 'view', {});
    if (!v.ok) return await rollback({ reason: 'service_view_unavailable' });
    const through = await (o.signInAll ?? signInAll)(v.view);
    if (!through.ok) return await rollback({ reason: 'relay_sign_in_failed', detail: through.label ?? through.reason });
    writeMarker(home, { address: place.address, view: place.view, vault: place.dir });
    handBack(home, o); // an elevated run wrote the marker: it belongs to the PC user
    try { rmSync(keyFilePath(home), { force: true }); rmSync(masterPath(home), { force: true }); } catch { return await rollback({ reason: 'old_key_file_remains' }); }
    if (existsSync(keyFilePath(home))) return await rollback({ reason: 'old_key_file_remains' });
    return { ok: true, agents: hubs.reduce((n, [, s]) => n + Object.keys(s.agents ?? {}).length, 0), hubs: hubs.length };
  } catch (e) {
    return await rollback({ reason: e.reason ?? 'install_failed', detail: String(e.message).slice(0, 200) });
  }
}

/**
 * Switches Hardened off: the service's keys go back into the user's own encrypted key file, which is read back and compared
 * before anything is removed; then the marker, the service and the vault folder go. Runs as an administrator (the vault is not
 * the user's to read). Resolves `{ok: true, hubs, agents}` or `{ok: false, reason, rolled_back, backup?}`.
 */
export async function uninstallVault(home, o = {}) {
  const platform = o.platform ?? process.platform, exec = o.exec ?? sys.exec;
  const iso = readIsolation(home);
  if (iso.level !== 'hardened') return { ok: true, already: true, hubs: 0, agents: 0 };
  const spec = vaultSpec(home, { platform, node: o.node, place: o.place });
  if (!spec) return { ok: false, reason: 'platform_unsupported' };
  if (!(o.isAdmin ?? sys.isAdmin)(platform)) return { ok: false, reason: 'needs_admin' };
  const dir = iso.vault ?? spec.place.dir;
  const env = process.env.CONCLAVE_KEY_STORE; process.env.CONCLAVE_KEY_STORE = 'file';
  let kf;
  try { kf = readKeyFile(dir); } finally { if (env === undefined) delete process.env.CONCLAVE_KEY_STORE; else process.env.CONCLAVE_KEY_STORE = env; }
  if (!kf.ok) return { ok: false, reason: 'vault_unreadable', rolled_back: true, backup: join(dir, 'backup') };
  const marker = readFileSync(markerPath(home), 'utf8');
  restoreKeyFile(home, kf.data); // the user's own store (standard); the marker is still on, so nothing reads this yet
  rmSync(markerPath(home), { force: true });
  try { handBack(home, o); } catch { /* the readback below tells whether the file is usable */ }
  const back = readKeyFile(home);
  const same = back.ok && JSON.stringify(back.data) === JSON.stringify(kf.data);
  if (!same) { writeFileSync(markerPath(home), marker); try { rmSync(keyFilePath(home), { force: true }); rmSync(masterPath(home), { force: true }); } catch { /* the vault still has them */ } return { ok: false, reason: 'keys_not_restored', rolled_back: true }; }
  const gone = runAll(spec.remove, exec);
  if (spec.afterRemove) runAll(spec.afterRemove, exec);
  if (spec.platform === 'linux') runAll([['remove the system user', 'sh', ['-c', `userdel ${LINUX_USER} 2>/dev/null || true`]]], exec);
  try { rmSync(spec.place.root, { recursive: true, force: true }); } catch { /* best effort */ }
  const agents = Object.values(kf.data.hubs).reduce((n, s) => n + Object.keys(s.agents ?? {}).length, 0);
  return { ok: true, hubs: Object.keys(kf.data.hubs).length, agents, service_removed: gone.ok };
}

/**
 * Proof G6(a) on this PC (`conclave check --hardened`): what a process of the PC user can reach. The vault folder must refuse
 * it, the public view must hold no key, and the service must answer. Returns `{ok, steps}`. `fsx` is replaced in tests.
 */
export async function g6aProbe(home, { fsx = { readdirSync, readFileSync } } = {}) {
  const iso = readIsolation(home), steps = [];
  if (iso.level !== 'hardened') return { ok: false, steps: [{ step: 'this PC runs at Standard isolation: the key store opens for any process of this user (G6(a) is expected to fail here)', ok: false }] };
  const add = (step, ok) => steps.push({ step, ok });
  let denied = true;
  for (const f of ['', 'keys.json', 'keys.master']) {
    try { if (f) fsx.readFileSync(join(iso.vault ?? '', f)); else fsx.readdirSync(iso.vault ?? ''); denied = false; } catch (e) { if (e.code !== 'EACCES' && e.code !== 'EPERM') denied = false; }
  }
  add('the vault folder, its key file and its secret refuse this user', denied);
  let clean = false;
  try { const t = fsx.readFileSync(iso.view ?? '', 'utf8'); clean = !/\bah_(?:ses|app|brg|dsc|set|key)_/.test(t); } catch { clean = false; }
  add('the public key view holds placeholders only', clean);
  const ping = await askVault(iso.address ?? '', 'ping', {});
  add('the key service answers', ping.ok === true);
  return { ok: steps.every((s) => s.ok), steps };
}

export { startVault };
