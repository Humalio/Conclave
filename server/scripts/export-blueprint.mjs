#!/usr/bin/env node
// Write a project's generated Blueprint export (GET /api/projects/:id/export.md) into the repo (docs/blueprint/README.md).
//
//   node scripts/export-blueprint.mjs --hub http://127.0.0.1:8099 --project CNV --export ../docs/blueprint/conclave.md [--env ../.dev/hub.env]
//
// Credentials: ADMIN_USERNAME, ADMIN_PASSWORD and ADMIN_TOTP in the environment, or --env <file> with the first two.
// Never printed. Plain HTTP is refused except to this machine.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)), repo = resolve(here, '..', '..');
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
// Errors end the run through process.exitCode, never process.exit: on Windows, exiting with a fetch socket still open trips a libuv assertion.
class Stop extends Error {}
const die = (msg) => { throw new Stop(msg); };
let hub = '', cookie = '', csrf = '';
async function call(method, path, body) {
  const res = await fetch(hub + path, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(method === 'GET' ? {} : csrf ? { 'x-csrf-token': csrf } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const set = res.headers.getSetCookie?.() ?? [];
  if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
  const text = await res.text();
  if (!res.ok) { let m = text; try { const j = JSON.parse(text); m = `${j.error ?? res.status}: ${j.message ?? text}`; } catch { /* plain */ } die(`${method} ${path} → ${res.status} ${m}`); }
  return res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text;
}

async function main() {
  hub = (opt('hub') ?? die('Name the hub: --hub http://127.0.0.1:8099')).replace(/\/+$/, '');
  const key = opt('project') ?? die('Name the project key: --project CNV');
  const exportTo = opt('export') ?? die('Name the file to write: --export ../docs/blueprint/conclave.md');
  const u = new URL(hub);
  if (u.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) die('Use https for a hub that is not on this machine.');

  const env = { ...process.env };
  if (opt('env')) for (const l of readFileSync(opt('env'), 'utf8').split(/\r?\n/)) { const i = l.indexOf('='); if (i > 0 && !env[l.slice(0, i)]) env[l.slice(0, i)] = l.slice(i + 1); }
  if (!env.ADMIN_USERNAME || !env.ADMIN_PASSWORD) die('Set ADMIN_USERNAME and ADMIN_PASSWORD (or pass --env <file>).');

  const login = await call('POST', '/api/login', { username: env.ADMIN_USERNAME, password: env.ADMIN_PASSWORD, ...(env.ADMIN_TOTP ? { totp: env.ADMIN_TOTP } : {}) });
  csrf = login.csrf;
  const project = (await call('GET', '/api/projects?limit=100')).projects.find((p) => p.key === key);
  if (!project) die(`No project ${key} on this hub.`);
  const md = await call('GET', `/api/projects/${project.id}/export.md`);
  // Imported bodies keep their links relative to docs/; point them there from wherever the export is written.
  const up = relative(dirname(resolve(exportTo)), join(repo, 'docs')).replace(/\\/g, '/');
  const fixed = up ? md.replace(/\]\((?![a-z]+:|#|\/)([^)\s]+)\)/gi, (_, p) => `](${up}/${p})`) : md;
  writeFileSync(exportTo, fixed);
  console.log(`Wrote the export of ${key} to ${exportTo}.`);
}

try { await main(); } catch (e) { if (!(e instanceof Stop)) throw e; console.error(e.message); process.exitCode = 1; }
