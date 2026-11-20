/**
 * A Codex agent's role file (docs/checkout.md §6 step 5, docs/connector.md "Codex folders"). Codex reads one of
 * `AGENTS.override.md` or `AGENTS.md` per folder, the override first. The connector writes the hub's text as
 * `AGENTS.override.md`, starting with its marker line, keeps it out of git (`.git/info/exclude`) and leaves a project's own
 * `AGENTS.md` exactly as it is; the override tells the agent to read that file as well.
 *
 * The agent can edit its own override, so `conclave check` reports one that is missing, edited (not the text the connector
 * recorded) or unmarked, and `conclave repair` writes the recorded text back. An unmarked override is someone else's file:
 * restore refuses rather than overwrite it. One written by the old `codex.mjs` (its own first line) is an old piece that
 * `conclave migrate` replaces.
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { entries, record } from './manifest.mjs';

export const OVERRIDE = 'AGENTS.override.md';
/** The first line of every override the connector writes. Nothing else counts as the connector's. */
export const OVERRIDE_MARKER = '<!-- conclave:role-file v1. Written by the Conclave connector on this PC; local only, never committed. -->';
/** The first line of an override the old codex.mjs wrote (agentsOverride there). */
const OLD_MARKER = /^<!-- Written by Conclave setup\.mjs /;
/**
 * What git must never see from a Codex folder: the role file, the Codex config, and the files the connector writes there
 * for itself at registration (its MCP entry, and `.claude/` for the approval and hook). A file the repo tracks stays tracked.
 */
export const CODEX_EXCLUDE = [OVERRIDE, '.codex/', '.claude/', '.mcp.json'];

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const firstLine = (t) => t.replace(/^﻿/, '').split(/\r?\n/, 1)[0];

/** The override's whole text: the marker, what the file is, then the hub's text (playbook and sections) unchanged. */
export function overrideText(instructions) {
  const body = String(instructions ?? '').replace(/\r\n/g, '\n').trim();
  return [
    OVERRIDE_MARKER,
    '# Your role in Conclave',
    '',
    'The Conclave connector wrote this file from the hub\'s text. It belongs to this PC and git ignores it here. Do not edit it: `conclave check` reports a change, and `conclave repair` puts the hub\'s text back.',
    '',
    '- **Read this folder\'s `AGENTS.md` as well, when there is one.** Codex loads only this file, not both, and that file holds the project\'s own conventions.',
    '- **Commit with the `commit` tool of the `conclave` server.** Name the files, the message and your branch. Your own `git commit` is refused here because the sandbox keeps `.git` read-only. Nothing is pushed.',
    '',
    ...(body ? [body, ''] : []),
  ].join('\n');
}

/** What is at `<folder>/AGENTS.override.md`: `absent`, `ours` (the marker), `old` (the old codex.mjs) or `unmarked`. */
export function overrideState(folder) {
  const p = join(folder, OVERRIDE);
  let st;
  try { st = lstatSync(p); } catch { return 'absent'; }
  if (!st.isFile()) return 'unmarked'; // a link or a folder is never the connector's
  const head = firstLine(readFileSync(p, 'utf8'));
  if (head === OVERRIDE_MARKER) return 'ours';
  return OLD_MARKER.test(head) ? 'old' : 'unmarked';
}

/** The body an old codex.mjs override carries (its hub text, after its own five header lines), for migrate. */
export function oldOverrideBody(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const start = lines[1]?.startsWith('# ') && /agent_hub/.test(lines[3] ?? '') ? 5 : 1;
  return lines.slice(start).join('\n');
}

/** Adds lines to the repo's own `.git/info/exclude` (a `.git` folder only: never a worktree's pointer file). */
export function excludeInRepo(folder, lines) {
  const gitDir = join(folder, '.git');
  let st;
  try { st = lstatSync(gitDir); } catch { return false; }
  if (!st.isDirectory()) return false;
  const ex = join(gitDir, 'info', 'exclude');
  mkdirSync(dirname(ex), { recursive: true });
  const cur = existsSync(ex) ? readFileSync(ex, 'utf8') : '';
  const have = new Set(cur.split(/\r?\n/));
  const add = lines.filter((l) => !have.has(l));
  if (add.length) writeFileSync(ex, (cur && !cur.endsWith('\n') ? cur + '\n' : cur) + add.join('\n') + '\n');
  return true;
}

/**
 * Writes the override (absent or ours only; the caller refuses the rest first), excludes it from the folder's repo and
 * records it with its text, so repair can write it back. `cx` is the manifest context ({home, claudeJson, folders}).
 * Only `conclave migrate` passes `replaceOld`, to replace the old codex.mjs override; an unmarked one is never replaced.
 */
export function writeOverride(home, folder, instructions, cx, { replaceOld = false } = {}) {
  const state = overrideState(folder);
  if (state !== 'absent' && state !== 'ours' && !(replaceOld && state === 'old')) throw new Error(`${OVERRIDE} here was not written by Conclave (${state}); it is left as it is`);
  const text = overrideText(instructions);
  const p = join(folder, OVERRIDE);
  writeFileSync(p, text);
  excludeInRepo(folder, CODEX_EXCLUDE);
  record(home, { kind: 'codex_role', target: p, folder, pointer: null, before: null, installed: { sha256: sha256(text), text } }, { ...cx, home });
  return p;
}

/** The connector's record of this folder's override, or null. */
export function recordedOverride(home, folder) {
  const p = join(folder, OVERRIDE).toLowerCase();
  return entries(home).find((e) => e.kind === 'codex_role' && String(e.target).toLowerCase() === p) ?? null;
}

/**
 * The role-file check of a Codex folder: null when the override is the text the connector recorded, else the reason:
 * `role_file_missing`, `role_file_unmarked` (not the connector's file, or an old one) or `role_file_edited`.
 */
export function roleFileProblem(home, folder) {
  const state = overrideState(folder);
  if (state === 'absent') return 'role_file_missing';
  if (state !== 'ours') return 'role_file_unmarked';
  const rec = recordedOverride(home, folder);
  const want = rec?.installed?.sha256;
  if (!want) return 'role_file_edited'; // marked, but the connector has no record of writing it
  return sha256(readFileSync(join(folder, OVERRIDE), 'utf8')) === want ? null : 'role_file_edited';
}

/** `conclave repair` for the role file: writes the recorded text back over a missing or edited override (never an unmarked one). */
export function repairOverride(home, folder, cx) {
  const problem = roleFileProblem(home, folder);
  if (!problem) return { action: null };
  if (problem === 'role_file_unmarked') return { asked: 'role_file_unmarked' };
  const rec = recordedOverride(home, folder);
  if (typeof rec?.installed?.text !== 'string') return { asked: problem };
  const p = join(folder, OVERRIDE);
  writeFileSync(p, rec.installed.text);
  excludeInRepo(folder, CODEX_EXCLUDE);
  record(home, { kind: 'codex_role', target: p, folder, pointer: null, before: null, installed: rec.installed }, { ...cx, home });
  return { action: 'role_file_rewritten' };
}
