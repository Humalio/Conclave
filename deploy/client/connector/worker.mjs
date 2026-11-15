/**
 * The connector service's worker (docs/connector.md "The connector service"): for every hub in the key file it checks in,
 * fetches PC actions on the pinned poll, runs the bridge's transfers with the app key, and looks for approved updates.
 * When a hub refuses the app key because it disconnected this PC, the worker finishes Disconnect this hub from this PC
 * (disconnect.mjs) on that tick and on the next ones until it is over, so an interrupted one resumes.
 * Once an hour, and only while the PC's user has opted in, it reads the usage of its registered worker sessions
 * (usage.mjs) and sends each hub its own days; while the user has not opted in, nothing is read.
 * `runSupervisor` is what the logon entry starts: it runs the worker as a child through the launcher and restarts it, so
 * an update or a crash comes back on the current build.
 */
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { readKeyFile, keyFilePath } from './keyfile.mjs';
import { manifestPath } from './manifest.mjs';
import { recordStarted, forgetStarted } from './processes.mjs';
import { connect, request, pinnedFetch } from './hubclient.mjs';
import { foldersOfHub } from './registry.mjs';
import { runCheck } from './check.mjs';
import { gitPath } from './entries.mjs';
import { readSettings, autoUpdateOn } from './settings.mjs';
import { runningAgents } from './run.mjs';
import { validateOrder, firstTime, ORDER_REASONS } from './orders.mjs';
import { updateTo, pickUpdate, updateLine, failedVersions } from './update.mjs';
import { confirm, launcherPath, readBuilds } from './builds.mjs';
import { platformId } from './release.mjs';
import { CONNECTOR_VERSION } from './version.mjs';
import { execDefault, servicePidPath } from './service.mjs';
import { atomicWrite, oneLine } from './paths.mjs';
import { runDisconnect } from './disconnect.mjs';
import { collectUsage, sendUsage, usageOptIn } from './usage.mjs';
import { runLoop as runBridge } from './transfers.mjs';

export const CHECK_IN_MS = 60_000;
export const UPDATE_CHECK_MS = 6 * 3600_000;
export const USAGE_MS = 3600_000;
/** Days sent: 30 on the first pass after the user opted in (or the worker started), then the last 3 (a day sent again replaces it). */
export const USAGE_FIRST_DAYS = 30, USAGE_DAYS = 3;
/** Exit code of a worker that installed an update and wants to start again on it. */
export const RESTART = 75;
/** Exit code of a worker that found no hub left (the key file gone, or empty) for EMPTY_TICKS check-ins in a row. */
export const NO_HUBS = 76;
export const EMPTY_TICKS = 3;

/** Appends to connector.log, only while the connector is installed (its manifest is there): never creates its folder again. */
export const logTo = (home) => (what) => { try { if (!existsSync(manifestPath(home))) return; appendFileSync(join(home, 'connector.log'), `${new Date().toISOString()} service ${oneLine(what)}\n`); } catch { /* best effort */ } };
const verOf = (text) => /(\d+\.\d+\.\d+(?:-[a-z0-9.]+)?)/.exec(String(text ?? ''))?.[1] ?? null;

/** Node, git and the clients on this PC: `{node, git, clients}`; a client whose version cannot be read is `null`. */
export function versionsOnPc(home, exec = execDefault, win = process.platform === 'win32') {
  const git = gitPath(home);
  const gitVer = git ? verOf(exec(git, ['--version']).stdout) : null;
  const clients = [];
  for (const [client, names] of [['claude_code', win ? ['claude.exe', 'claude.cmd'] : ['claude']], ['codex', win ? ['codex.exe', 'codex.cmd'] : ['codex']]]) {
    for (const n of names) {
      const r = exec(n, ['--version']);
      if (r.status === 0 || verOf(r.stdout)) { clients.push({ client, version: verOf(r.stdout) }); break; }
    }
  }
  return { node: process.versions.node, git: gitVer, clients };
}

/** The check-in body for one hub section (docs/connector.md "The connector's report"). */
export function report(home, hubKey, pc) {
  const s = readSettings(home);
  return { version: CONNECTOR_VERSION, platform: platformId(), node: pc.node, git: pc.git, clients: pc.clients, ...s, agents: runningAgents(home, hubKey) };
}

/** The rows a `check` order reports: one per agent folder of that hub, then the connector's own. At most 40. */
export async function checkRows(home, section, claudeJson) {
  const rows = [];
  for (const b of foldersOfHub(home, section.hub_id, section.ca_sha256).slice(0, 36)) {
    const r = await runCheck(home, b.path, { claudeJson });
    rows.push({ name: `Agent ${b.agent}`, ok: r.ok, detail: r.line.slice(0, 200) });
  }
  rows.push({ name: 'Connector', ok: true, detail: `Version ${CONNECTOR_VERSION} on ${platformId()}.` });
  rows.push({ name: 'Updates', ok: true, detail: autoUpdateOn(home) ? 'Updates to approved versions are on.' : 'Updates are turned off on this PC by its user.' });
  const rb = readBuilds(home).rolled_back;
  if (rb) rows.push({ name: 'Rollback', ok: false, detail: `Version ${rb} did not start, so this PC went back to the previous verified build.` });
  return rows;
}

/**
 * One worker: resolves `'restart'` after an update, `'no_hubs'` once no hub is left for EMPTY_TICKS check-ins in a row
 * (after an uninstall or the last hub's disconnect), or `'stopped'` when `signal` aborts. `deps` replaces the clock, the
 * interval, the update, the disconnect, the usage interval (`usageMs`) and the exec for tests.
 */
export async function runWorker({ home, signal, log = logTo(home), claudeJson, deps = {} }) {
  const exec = deps.exec ?? execDefault;
  const update = deps.updateTo ?? updateTo;
  const disconnect = deps.disconnect ?? runDisconnect;
  const usageEvery = deps.usageMs ?? USAGE_MS;
  let usageAt = 0, backfilled = false;

  /** Reads usage once for every hub and sends each hub only its own days, over its pinned connection with its app key. */
  async function reportUsage(hubs) {
    if (!usageOptIn(home)) { backfilled = false; return; }
    const days = backfilled ? USAGE_DAYS : USAGE_FIRST_DAYS;
    let failed = false;
    const u = await collectUsage(home, { days });
    for (const h of u.hubs) {
      const section = Object.values(hubs).find((x) => x && x.hub_id === h.hub_id && x.ca_sha256 === h.ca_sha256);
      if (!section) continue;
      const c = connect(section);
      if (!c.ok) continue;
      const auth = { Authorization: `Bearer ${section.app_key}` };
      const post = async (path, body) => {
        const r = await request(c.hub, 'POST', path, { body, headers: auth });
        if (r.status !== 200) throw new Error(`the hub answered ${r.status}`);
      };
      try { const sent = await sendUsage(home, h, post); if (sent.length) log(`hub ${h.hub_id}: usage sent for ${sent.length} day(s)`); }
      catch (e) { log(`hub ${h.hub_id}: usage not sent (${e.reason ?? e.message})`); failed = true; } // the next hubs still get theirs
    }
    if (!failed) backfilled = true; // a hub that missed its 30 days gets them on the next pass
  }
  const interval = deps.intervalMs ?? CHECK_IN_MS;
  const bridges = new Map();
  let pc = versionsOnPc(home, exec), pcAt = Date.now(), lastUpdateCheck = 0, confirmed = false, restart = false;
  const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); signal?.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true }); });

  const result = (hub, auth, id, state, res) => request(hub, 'POST', `/connector/v1/orders/${id}/result`, { body: { state, result: res }, headers: auth }).catch((e) => log(`order ${id}: the result could not be sent (${e.reason})`));

  async function tryUpdate(hub, auth, version) {
    const a = await request(hub, 'GET', '/connector/v1/versions/approved', { headers: auth });
    const approved = a.status === 200 && Array.isArray(a.json?.versions) ? a.json.versions : [];
    const want = version ?? pickUpdate(approved, CONNECTOR_VERSION, failedVersions(home));
    if (!want) return null;
    const u = await update(home, { version: want, approved });
    log(u.ok ? `updated to ${want}; restarting on it` : `update to ${want} refused: ${u.reason}`);
    if (u.ok) restart = true;
    return u;
  }

  async function orders(hubKey, section, hub, auth) {
    const r = await request(hub, 'GET', '/connector/v1/orders', { headers: auth });
    if (r.status !== 200 || !Array.isArray(r.json?.orders)) return;
    for (const raw of r.json.orders) {
      if (typeof raw?.id !== 'string' || !/^pca_[A-Za-z0-9_-]{1,80}$/.test(raw.id)) { log('an order without a valid id was ignored'); continue; }
      if (!firstTime(home, hubKey, raw.id)) { log(`order ${raw.id} was seen before; nothing done`); continue; }
      const v = validateOrder(raw);
      if (!v.ok) { log(`order ${raw.id} refused: ${v.reason}`); await result(hub, auth, raw.id, 'failed', { reason: ORDER_REASONS[v.reason] }); continue; }
      const { kind, payload } = v.order;
      if (kind === 'check') await result(hub, auth, raw.id, 'done', { checks: await checkRows(home, section, claudeJson) });
      else if (kind === 'update') {
        if (!autoUpdateOn(home)) { await result(hub, auth, raw.id, 'failed', { reason: ORDER_REASONS.auto_update_off }); continue; }
        const u = await tryUpdate(hub, auth, payload.version).catch((e) => ({ ok: false, reason: e.reason ?? 'download_failed' }));
        await result(hub, auth, raw.id, u?.ok ? 'done' : 'failed', u?.ok ? null : { reason: updateLine(u?.reason) });
      } else if (kind === 'restore') await result(hub, auth, raw.id, 'failed', { reason: ORDER_REASONS.restore_not_built });
      else await result(hub, auth, raw.id, 'failed', { reason: ORDER_REASONS.disconnect_elsewhere });
    }
  }

  async function tick(hubKey, section) {
    const c = connect(section);
    if (!c.ok) { log(`hub ${section.hub_id}: not contacted (${c.reason})`); return; }
    const hub = c.hub, auth = { Authorization: `Bearer ${section.app_key}` };
    let r;
    try { r = await request(hub, 'POST', '/connector/v1/check-in', { body: report(home, hubKey, pc), headers: auth }); } catch (e) { log(`hub ${section.hub_id}: check-in failed (${e.reason})`); return; }
    if (r.status === 401) {
      bridges.get(hubKey)?.abort(); bridges.delete(hubKey);
      if (r.json?.error !== 'disconnected') { log(`hub ${section.hub_id}: the app key was refused (PC suspended or key revoked)`); return; }
      log(`hub ${section.hub_id}: this hub disconnected this PC; finishing the disconnect`);
      const d = await disconnect(home, { hubId: section.hub_id, caSha256: section.ca_sha256 }, { claudeJson }).catch((e) => ({ state: 'resume_later', error: e.message }));
      log(`hub ${section.hub_id}: disconnect ${d.state === 'resume_later' ? 'not finished; tried again at the next check-in' : d.state}`);
      return;
    }
    if (r.status !== 200) { log(`hub ${section.hub_id}: check-in answered ${r.status}`); return; }
    if (!confirmed) { confirmed = true; if (confirm(home)) log(`version ${CONNECTOR_VERSION} confirmed after its first check-in`); }
    if (!bridges.has(hubKey) && !deps.noBridge) {
      const ac = new AbortController();
      signal?.addEventListener('abort', () => ac.abort(), { once: true });
      bridges.set(hubKey, ac);
      runBridge({ hub: hub.origin, key: section.app_key, signal: ac.signal, fetch: pinnedFetch(hub), log: (...a) => log(`transfers ${section.hub_id}: ${a.join(' ')}`) })
        .catch((e) => log(`transfers ${section.hub_id} stopped: ${e.message}`)).finally(() => { if (bridges.get(hubKey) === ac) bridges.delete(hubKey); });
    }
    if (r.json?.orders > 0) await orders(hubKey, section, hub, auth).catch((e) => log(`hub ${section.hub_id}: orders failed (${e.reason ?? e.message})`));
    if (!restart && autoUpdateOn(home) && Date.now() - lastUpdateCheck > UPDATE_CHECK_MS) {
      lastUpdateCheck = Date.now();
      await tryUpdate(hub, auth, null).catch((e) => log(`update check failed (${e.reason ?? e.message})`));
    }
  }

  log(`worker ${CONNECTOR_VERSION} started`);
  let empty = 0, noHubs = false;
  while (!signal?.aborted && !restart) {
    if (Date.now() - pcAt > 3600_000) { pc = versionsOnPc(home, exec); pcAt = Date.now(); }
    const kf = readKeyFile(home);
    if (!existsSync(keyFilePath(home)) || (kf.ok && !Object.keys(kf.data.hubs).length)) {
      if (++empty >= (deps.emptyTicks ?? EMPTY_TICKS)) { noHubs = true; break; }
    } else empty = 0;
    if (!kf.ok) log(`the key file cannot be used (${kf.reason})`);
    else {
      for (const [k, s] of Object.entries(kf.data.hubs)) { if (signal?.aborted || restart) break; await tick(k, s); }
      if (!signal?.aborted && !restart && Date.now() - usageAt >= usageEvery) {
        usageAt = Date.now();
        await reportUsage(kf.data.hubs).catch((e) => log(`usage could not be read (${e.message})`));
      }
    }
    if (!restart) await sleep(interval);
  }
  for (const ac of bridges.values()) ac.abort();
  if (noHubs) log('no hub is left on this PC; the worker stops');
  return restart ? 'restart' : noHubs ? 'no_hubs' : 'stopped';
}

/**
 * The logon entry's process. It records its pid (so `service remove` can stop it), runs `launcher service worker` as a
 * child, and starts it again after it exits: at once after an update, otherwise after a pause that grows to a minute
 * while the worker keeps failing quickly.
 */
export async function runSupervisor({ home, log = logTo(home), node = process.execPath, signal }) {
  atomicWrite(servicePidPath(home), JSON.stringify({ pid: process.pid, started_at: Date.now() }) + '\n');
  let child = null, stopping = false, fails = 0;
  const stop = () => { stopping = true; child?.kill(); };
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(s, stop);
  signal?.addEventListener('abort', stop, { once: true });
  log('service started');
  while (!stopping) {
    const t0 = Date.now();
    const code = await new Promise((res) => {
      const script = launcherPath(home);
      child = spawn(node, [script, 'service', 'worker'], { cwd: home, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, CONCLAVE_HOME: home, HOME: process.env.HOME ?? homedir() } });
      const out = (d) => { for (const l of String(d).split(/\r?\n/)) if (l.trim()) log(l); };
      // Recorded, so an uninstall or a disconnect (stopStarted) ends the worker too, not only this supervisor.
      const pid = child.pid;
      if (pid) recordStarted(home, { pid, image: node, script, what: 'service worker' });
      child.stdout.on('data', out); child.stderr.on('data', out);
      child.on('exit', (c) => { if (pid) forgetStarted(home, pid); res(c ?? 1); });
      child.on('error', () => res(1));
    });
    child = null;
    if (stopping) break;
    if (code === RESTART) { fails = 0; continue; }
    // No hub left and the connector removed (its launcher is gone): nothing to supervise any more.
    if (code === NO_HUBS && !existsSync(launcherPath(home))) break;
    fails = Date.now() - t0 < 30_000 ? fails + 1 : 0;
    const wait = Math.min(60_000, 2000 * 2 ** Math.min(fails, 5));
    log(`worker exited (${code}); starting again in ${wait / 1000} s`);
    await new Promise((r) => setTimeout(r, wait));
  }
  log('service stopped');
  rmSync(servicePidPath(home), { force: true });
}
