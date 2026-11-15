/**
 * Which agents are running, from the connector's own process state only (review-v2 §4, usage row: "Liveness only from
 * the connector's own process state, otherwise Unknown"). Each `conclave mcp` process that signed in keeps one file,
 * run/<hub>/<agent>.json = {pid, agent_id, started_at}, and removes it when it ends. A file whose process is gone is
 * deleted when read. Nothing is guessed from chat or session files.
 */
import { join } from 'node:path';
import { readdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readJson, atomicWrite } from './paths.mjs';
import { LABEL_RE } from './keyfile.mjs';

const hubDir = (home, hubKey) => join(home, 'run', createHash('sha256').update(hubKey).digest('hex').slice(0, 24));
const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;

/** True if a process with this id is alive (signal 0 only checks; EPERM means it exists under another user). */
export function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** Marks this process as the running relay of `label` on that hub. Returns a function that removes the mark. */
export function markRunning(home, hubKey, label, agentId, pid = process.pid) {
  if (!LABEL_RE.test(String(label))) return () => {};
  const p = join(hubDir(home, hubKey), `${label}.json`);
  try { atomicWrite(p, JSON.stringify({ pid, agent_id: AGENT_ID_RE.test(String(agentId)) ? agentId : null, started_at: Date.now() }) + '\n'); } catch { return () => {}; }
  return () => { const r = readJson(p, null); if (r?.pid === pid) rmSync(p, { force: true }); };
}

/** The agents of one hub whose relay is alive: `[{agent_id, state: 'open'}]`. Stale files are removed. */
export function runningAgents(home, hubKey) {
  const dir = hubDir(home, hubKey);
  let names = [];
  try { names = readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { return []; }
  const out = new Map();
  for (const n of names) {
    const p = join(dir, n);
    const r = readJson(p, null);
    if (!r || !alive(r.pid)) { rmSync(p, { force: true }); continue; }
    if (typeof r.agent_id === 'string' && AGENT_ID_RE.test(r.agent_id)) out.set(r.agent_id, { agent_id: r.agent_id, state: 'open' });
  }
  return [...out.values()];
}
