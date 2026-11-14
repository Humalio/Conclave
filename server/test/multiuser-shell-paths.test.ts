/**
 * The member shell asks only for what a member may reach (docs/multi-user.md §7): every `api()`/`post()` call and every
 * export link in the member block of `public/app.js` names a route that is `self`/`public` or listed in MEMBER_READY,
 * so no UI path requests an admin-only route (the server then checks the grant of each room, folder or project).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROUTE_SCOPES, MEMBER_READY, MEMBER_LIVE } from '../src/admin/scopes.js';

const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const start = js.indexOf('const muLogo ='), end = js.indexOf('function muInit()');
const block = js.slice(start, end);

/** The top-level arguments of each call to `name(` in the block, cut at the closing paren. */
function callArgs(name: string): string[][] {
  const out: string[][] = [], re = new RegExp(`(?<![\\w.])${name}\\(`, 'g');
  for (let m; (m = re.exec(block)); ) {
    let i = m.index + m[0].length, depth = 0, quote = '', a = '';
    const all: string[] = [];
    for (; i < block.length; i++) {
      const c = block[i];
      if (quote) { a += c; if (c === '\\') { a += block[++i]; continue; } if (c === quote) quote = ''; else if (quote === '`' && c === '$' && block[i + 1] === '{') { /* kept literally */ } continue; }
      if (c === "'" || c === '"' || c === '`') { quote = c; a += c; continue; }
      if (c === '(' || c === '{' || c === '[') depth++;
      if (c === ')' || c === '}' || c === ']') { if (depth === 0) break; depth--; }
      if (c === ',' && depth === 0) { all.push(a.trim()); a = ''; continue; }
      a += c;
    }
    all.push(a.trim());
    out.push(all);
  }
  return out;
}
/** The first argument of each call to `name(`. */
const args = (name: string): string[] => callArgs(name).map((a) => a[0]);
/** An `api(path, method?, body?)` call's method: its second argument when that is a method literal, else GET. */
const methodOf = (a: string[]): string => /^['"`](GET|POST|PUT|PATCH|DELETE)['"`]$/.exec(a[1] ?? '')?.[1] ?? 'GET';

/** A call's path expression as route paths (`:p` for each id); `${kind}` of a proposal stands for apply and reject. */
function paths(expr: string): string[] {
  let s = expr
    .replace(/\$\{bpP\([^)]*\)\}|bpP\([^)]*\)|\bpp\b/g, '/projects/:p')
    .replace(/\bdp\b/g, '/decisions/:p')
    .replace(/\$\{NY_Q\}|\bNY_Q\b/g, '/needs-you?') // the Needs you list's path and its query
    .replace(/\$\{encodeURIComponent\((?:[^()]|\([^()]*\))*\)\}|encodeURIComponent\((?:[^()]|\([^()]*\))*\)/g, ':p')
    .replace(/['"`+\s]/g, '');
  s = s.replace(/[?(].*$/, ''); // a query, or a conditional query suffix
  return s.includes('${kind}') ? ['apply', 'reject'].map((k) => s.replace('${kind}', k)) : [s];
}

const ROUTES = Object.keys(ROUTE_SCOPES).map((k) => { const [method, pattern] = k.split(' '); return { key: k, method, re: new RegExp('^' + pattern.replace(/:[^/]+/g, '[^/]+') + '$') }; });
const route = (method: string, path: string) => ROUTES.find((r) => r.method === method && r.re.test(path))?.key;
const reachable = (key: string) => MEMBER_LIVE.has(ROUTE_SCOPES[key]) || MEMBER_READY.has(key);

describe('member shell: only member-ready routes', () => {
  const calls = [
    ...callArgs('api').map((a) => [methodOf(a), a[0]] as const),
    ...args('post').map((e) => ['POST', e] as const),
    // nyRead reads every page of a Needs you query (GET, following next_cursor).
    ...args('nyRead').map((e) => ['GET', e] as const),
    ...args('muExportBtn').map((e) => ['GET', e.replace(/^`\/api/, '`')] as const),
  ].flatMap(([m, e]) => paths(e).map((p) => ({ m, p: '/api' + p, e })));

  it('finds the member block and its calls', () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const got = new Set(calls.map((c) => `${c.m} ${c.p}`));
    for (const k of ['GET /api/conversations', 'GET /api/conversations/:p/messages', 'GET /api/vault/tree', 'GET /api/vault/preview', 'GET /api/graph/entities', 'GET /api/topology', 'GET /api/projects/:p/export.md', 'GET /api/conversations/:p/export'])
      expect(got, k).toContain(k);
  });

  it('every call names a route a member may reach', () => {
    const bad = calls.filter((c) => { const k = route(c.m, c.p); return !k || !reachable(k); }).map((c) => `${c.m} ${c.p}  <=  ${c.e}`);
    expect(bad).toEqual([]);
  });
});
