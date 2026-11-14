#!/usr/bin/env node
// Write the vault copy (99 Conclave/) of a checkout that ended before the copy existed, from its saved JSON
// (GET /api/checkouts/:id, saved while the handouts still held their text). docs/vault.md, "The hub's folder".
//
//   node scripts/mirror-import-checkout.mjs --hub http://127.0.0.1:8099 [--env ../.dev/hub.env] <checkout.json>
//
// Credentials: ADMIN_USERNAME, ADMIN_PASSWORD and ADMIN_TOTP in the environment, or --env <file> with the first two.
// Never printed. Plain HTTP is refused except to this machine. The hub writes the pages; this script only sends the file.
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
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
  const file = positional[0] ?? die('Name the saved checkout: mirror-import-checkout.mjs --hub <url> <checkout.json>');
  const u = new URL(hub);
  if (u.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) die('Use https for a hub that is not on this machine.');
  let saved;
  try { saved = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { die(`${file} is not a JSON file: ${e.message}`); }

  const env = { ...process.env };
  if (opt('env')) for (const l of readFileSync(opt('env'), 'utf8').split(/\r?\n/)) { const i = l.indexOf('='); if (i > 0 && !env[l.slice(0, i)]) env[l.slice(0, i)] = l.slice(i + 1); }
  if (!env.ADMIN_USERNAME || !env.ADMIN_PASSWORD) die('Set ADMIN_USERNAME and ADMIN_PASSWORD (or pass --env <file>).');

  const login = await call('POST', '/api/login', { username: env.ADMIN_USERNAME, password: env.ADMIN_PASSWORD, ...(env.ADMIN_TOTP ? { totp: env.ADMIN_TOTP } : {}) });
  csrf = login.csrf;
  const r = await call('POST', '/api/vault/mirror/import', saved);
  console.log(`Wrote ${r.pages.length} page${r.pages.length === 1 ? '' : 's'} for ${r.checkout}:`);
  for (const p of r.pages) console.log(`  ${p}`);
}

try { await main(); } catch (e) { if (!(e instanceof Stop)) throw e; console.error(e.message); process.exitCode = 1; }
