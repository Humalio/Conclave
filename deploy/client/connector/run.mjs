/**
 * Which agents are running, from the connector's own process state only (review-v2 §4, usage row: "Liveness only from
 * the connector's own process state, otherwise Unknown"). Each `conclave mcp` process that signed in keeps one file,
 * run/<hub>/<agent>.json = {pid, label, agent_id, started_at, account}, and removes it when it ends. `account` is the
 * account variable the run was started with (CLAUDE_CONFIG_DIR, CODEX_HOME), kept on this PC only: a profile is reported for
 * a run that uses it, never for a chat opened by hand on the default account. A file whose process is gone is
 * deleted when read. Nothing is guessed from chat or session files.
 */
import { join } from 'node:path';
import { readdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readJson, atomicWrite, alive } from './paths.mjs';
import { LABEL_RE } from './keyfile.mjs';
import { foldersOfHub } from './registry.mjs';
import { runProfile, VARIABLE } from './profiles.mjs';
import { runningAs } from './processes.mjs';
import { WIN } from './paths.mjs';

const hubDir = (home, hubKey) => join(home, 'run', createHash('sha256').update(hubKey).digest('hex').slice(0, 24));
const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;

export { alive };

/**
 * Is the relay a run file names still running? Its id must still run the recorded program (and, where reading a command
 * line is cheap, not on Windows, the recorded script): a recycled id is not the relay. A file without the program (an older
 * connector's) falls back to the id alone.
 */
function relayRunning(r, check) {
  if (!alive(r.pid)) return false;
  if (typeof r.program !== 'string' || !r.program) return true;
  return check(r.pid, r.program, !WIN && typeof r.script === 'string' && r.script ? r.script : null);
}

/** The account variables this process was started with, `{claude, codex}`: a folder path each, or null. */
const accountOf = (env) => Object.fromEntries(Object.entries(VARIABLE).map(([k, v]) => [k, typeof env?.[v] === 'string' && env[v] ? env[v] : null]));

/** Marks this process as the running relay of `label` on that hub. Returns a function that removes the mark. */
export function markRunning(home, hubKey, label, agentId, pid = process.pid, env = process.env, program = process.execPath, script = process.argv[1] ?? null) {
  if (!LABEL_RE.test(String(label))) return () => {};
  const p = join(hubDir(home, hubKey), `${label}.json`);
  try { atomicWrite(p, JSON.stringify({ pid, program, script, label, agent_id: AGENT_ID_RE.test(String(agentId)) ? agentId : null, started_at: Date.now(), account: accountOf(env) }) + '\n'); } catch { return () => {}; }
  return () => { const r = readJson(p, null); if (r?.pid === pid) rmSync(p, { force: true }); };
}

/** The agent id the relay of `label` recorded on that hub when it signed in (while its file is there), or null. Reads only. */
export function agentIdOf(home, hubKey, label) {
  if (!LABEL_RE.test(String(label))) return null;
  const r = readJson(join(hubDir(home, hubKey), `${label}.json`), null);
  return typeof r?.agent_id === 'string' && AGENT_ID_RE.test(r.agent_id) ? r.agent_id : null;
}

/**
 * The agents of one hub whose relay is alive: `[{agent_id, state: 'open'}]`. A run that uses the account profile its agent is
 * bound to adds `profile` (the name only), or `profile_hidden: true` while its PC user hides the name. Stale files are removed.
 */
export function runningAgents(home, hubKey, check = runningAs) {
  const dir = hubDir(home, hubKey);
  let names = [];
  try { names = readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { return []; }
  let bindings = null;
  try { const [hubId, ca] = hubKey.split('@'); bindings = foldersOfHub(home, hubId, ca); } catch { bindings = []; }
  const out = new Map();
  for (const n of names) {
    const p = join(dir, n);
    const r = readJson(p, null);
    if (!r || !relayRunning(r, check)) { rmSync(p, { force: true }); continue; }
    if (typeof r.agent_id === 'string' && AGENT_ID_RE.test(r.agent_id)) {
      const p = typeof r.label === 'string' ? runProfile(home, bindings.find((b) => b.agent === r.label), r.account) : null;
      out.set(r.agent_id, { agent_id: r.agent_id, state: 'open', ...(p?.hidden ? { profile_hidden: true } : p ? { profile: p.name } : {}) });
    }
  }
  return [...out.values()];
}
