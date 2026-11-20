// Onboarding with the connector (docs/onboarding.md, "With the Conclave connector"; docs/connector.md, "Pairing"):
// pairing checks the hub's CA before the code leaves the PC; a known hub with another CA needs confirmation; the local
// screen answers only its own token, Host and Origin on loopback; setup files, waits, picks up into keys.json, builds and
// registers each folder, confirms, resumes, and retries one agent; the private git is an offer that refuses any other file.
// Everything runs against stub HTTPS hubs with throwaway certificates, in temporary folders.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testCa } from '../../server/test/test-ca.mjs';
import { pair, checkHub, normalizeCheck, PAIR_LINES } from './connector/pairing.mjs';
import { readKeyFile } from './connector/keyfile.mjs';
import { startScreen } from './connector/screen.mjs';
import { fileRequest, advance as advanceRaw, agentRows, retryAgent, loadSetup, openWays, pending } from './connector/onboard.mjs';
import { installPrivateGit, gitState, GIT_OFFER, CODEX_GIT, MINGIT } from './connector/git.mjs';
import { entries } from './connector/manifest.mjs';
import { resolveFolder } from './connector/registry.mjs';
import { OVERRIDE_MARKER, overrideState, roleFileProblem } from './connector/role.mjs';
import { trustStatus } from './connector/trust.mjs';
import { runCheck } from './connector/check.mjs';
import { commitFiles } from './connector/commit.mjs';
import { pendingList, approvePickup } from './connector/approvals.mjs';
process.env.CONCLAVE_KEY_STORE = 'file';
/** Setup as the PC's user drives it: when a key pickup waits for the click on the screen, click it and go on. */
async function advance(home, hubKey, o) {
  const r = await advanceRaw(home, hubKey, o);
  if (!r.pickup_click) return r;
  for (const k of pendingList(home).pickups) approvePickup(home, k.key);
  return advanceRaw(home, hubKey, o);
}
import { spawnSync } from 'node:child_process';

const CODE = 'cnv_enrol_' + 'a'.repeat(26);
const APP_KEY = 'ah_app_aaaabbbbcccc_' + 'x'.repeat(30);
const tmp = (p) => mkdtempSync(join(tmpdir(), `cnob-${p}-`));
const check16 = (sha) => sha.slice(0, 16).match(/.{4}/g).join(' ');

/** A stub hub: the routes pairing and setup use, with a log of what it was sent. */
function stubHub(pki, { hubId = 'hub-aaaabbbbcccc' } = {}) {
  const st = { codes: [], request: null, state: 'submitted', confirmed: null, connected: new Set(), pickups: 0, origin: '' };
  const agents = [
    { agent_id: 'agt_coord', label: 'Coordinator', role: 'coordinator', team_role: 'coordinator', session_var: 'CONCLAVE_T_COORDINATOR_SESSION_KEY', folder: 'coordinator', instructions: '# You are the coordinator\n' },
    { agent_id: 'agt_dev', label: 'Developer 1', role: 'developer', team_role: 'worker', session_var: 'CONCLAVE_T_DEVELOPER_1_SESSION_KEY', folder: 'developer-1', instructions: '# You are a developer\n' },
  ];
  const server = https.createServer({ key: pki.leafKey, cert: pki.leafPem }, (req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null, u = new URL(req.url, 'https://x');
      const json = (status, j) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
      const authed = req.headers.authorization === `Bearer ${APP_KEY}`;
      if (u.pathname === '/onboard/ca.crt') { res.writeHead(200, { 'content-type': 'application/x-pem-file' }); return res.end(pki.caPem); }
      if (u.pathname === '/connector/v1/hub') return json(200, { hub_id: hubId, origin: st.origin });
      if (u.pathname === '/connector/v1/pair') {
        st.codes.push(body.pairing_code);
        if (body.pairing_code !== CODE || st.codes.length > 1 && st.codes.slice(0, -1).includes(CODE)) return json(401, { error: 'invalid_pairing_code', message: 'This pairing code is not valid, has expired or was already used. Make a new code in the console.' });
        return json(200, { app_key: APP_KEY, hub: { id: hubId, origin: st.origin }, pc: { id: 'pc_1', name: 'grants-laptop' } });
      }
      if (!authed) return json(401, { error: 'unauthorized', message: 'no key' });
      if (u.pathname === '/onboard/requests' && req.method === 'POST') { st.request = body; return json(200, { request_id: 'obr_1', state: 'submitted', version: 1, kind: 'new_team' }); }
      if (u.pathname === '/onboard/requests/obr_1') return json(200, { state: st.state, version: 2, team_name: 'Grants', project: 'Atlas', agents: agents.map(({ instructions, ...a }) => a) });
      if (u.pathname === '/onboard/pickup') { st.pickups++; return json(200, { pickup_id: `opk_${st.pickups}`, team: { id: 'team_1', name: 'Grants' }, agents: agents.map((a) => ({ ...a, secret: `ah_ses_${a.agent_id.slice(4).padEnd(12, 'z')}_secret` })) }); }
      if (u.pathname === '/onboard/pickup/confirm') { st.confirmed = body; st.state = 'collected'; return json(200, { request_id: 'obr_1', state: 'collected', team_status: 'active', started: true }); }
      if (u.pathname === '/connector/v1/setup') return json(200, { steps: [], agents: agents.map((a) => ({ agent_id: a.agent_id, label: a.label, state: st.connected.has(a.agent_id) ? 'connected' : 'ready_to_open' })) });
      json(404, { error: 'not_found' });
    });
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => { st.origin = `https://127.0.0.1:${server.address().port}`; ok({ server, st, origin: st.origin }); }));
}

/** Someone in the middle: TLS with their own certificate, passing every request on to the real hub. */
function mitm(pki, target, { serveCa }) {
  const seen = [];
  const server = https.createServer({ key: pki.leafKey, cert: pki.leafPem }, (req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      seen.push({ path: req.url, body: raw });
      if (req.url === '/onboard/ca.crt') { res.writeHead(200); return res.end(serveCa); }
      const up = https.request(`${target}${req.url}`, { method: req.method, headers: req.headers, rejectUnauthorized: false }, (ur) => { res.writeHead(ur.statusCode, ur.headers); ur.pipe(res); });
      up.end(raw);
    });
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ server, seen, origin: `https://127.0.0.1:${server.address().port}` })));
}

describe('pairing checks the hub before it sends the code', () => {
  let hubPki, hub, evilPki;
  before(async () => { hubPki = testCa('Conclave hub CA'); evilPki = testCa('Someone else'); hub = await stubHub(hubPki); });
  after(() => hub.server.close());

  test('the hub check takes the short form or the full fingerprint, nothing else', () => {
    assert.equal(normalizeCheck('AB12 cd34 EF56 7890'), 'ab12cd34ef567890');
    assert.equal(normalizeCheck('a'.repeat(64)), 'a'.repeat(64));
    assert.equal(normalizeCheck('ab12'), null);
    assert.equal(normalizeCheck('zz12 cd34 ef56 7890'), null);
  });

  test('a proxy with another CA never receives the code', async () => {
    const m = await mitm(evilPki, hub.origin, { serveCa: evilPki.caPem });
    const home = tmp('mitm');
    const r = await pair(home, { origin: m.origin, check: check16(hubPki.caSha256), code: CODE });
    assert.deepEqual(r, { ok: false, reason: 'ca_mismatch' });
    assert.equal(PAIR_LINES.ca_mismatch.startsWith('This is not the hub you were given: its certificate does not match'), true);
    assert.ok(m.seen.every((x) => !x.body.includes(CODE)));
    assert.deepEqual(m.seen.map((x) => x.path), ['/onboard/ca.crt']);
    assert.equal(hub.st.codes.length, 0);
    m.server.close();
  });

  test('a proxy that serves the real CA but its own certificate is refused by TLS, and never receives the code', async () => {
    const m = await mitm(evilPki, hub.origin, { serveCa: hubPki.caPem });
    const home = tmp('mitm2');
    const r = await pair(home, { origin: m.origin, check: check16(hubPki.caSha256), code: CODE });
    assert.deepEqual(r, { ok: false, reason: 'tls_refused' });
    assert.ok(m.seen.every((x) => !x.body.includes(CODE)));
    assert.equal(hub.st.codes.length, 0);
    assert.equal(readKeyFile(home).data.hubs && Object.keys(readKeyFile(home).data.hubs).length, 0);
    m.server.close();
  });

  test('a matching CA pairs once and keeps the app key only in keys.json', async () => {
    const home = tmp('pair');
    const r = await pair(home, { origin: hub.origin, check: check16(hubPki.caSha256), code: CODE });
    assert.equal(r.ok, true);
    assert.deepEqual(r.pc, { id: 'pc_1', name: 'grants-laptop' });
    assert.ok(!JSON.stringify(r).includes(APP_KEY));
    const s = readKeyFile(home).data.hubs[r.hubKey];
    assert.equal(s.app_key, APP_KEY);
    assert.equal(s.ca_sha256, hubPki.caSha256);
    assert.equal(s.hub_id, 'hub-aaaabbbbcccc');
    const again = await pair(tmp('pair2'), { origin: hub.origin, check: check16(hubPki.caSha256), code: CODE });
    assert.deepEqual(again, { ok: false, reason: 'code_refused' });
  });

  test('a malformed code or check is refused before anything is sent', async () => {
    const before = hub.st.codes.length;
    assert.deepEqual(await pair(tmp('bad'), { origin: hub.origin, check: check16(hubPki.caSha256), code: 'hello' }), { ok: false, reason: 'bad_code' });
    assert.deepEqual(await pair(tmp('bad'), { origin: hub.origin, check: 'nope', code: CODE }), { ok: false, reason: 'bad_check' });
    assert.deepEqual(await pair(tmp('bad'), { origin: hub.origin.replace('https', 'http'), check: check16(hubPki.caSha256), code: CODE }), { ok: false, reason: 'not_https' });
    assert.equal(hub.st.codes.length, before);
  });

  test('a hub that serves two certificates is refused before anything is sent', async () => {
    const sent = hub.st.codes.length;
    const m = await mitm(evilPki, hub.origin, { serveCa: hubPki.caPem + evilPki.caPem });
    const r = await pair(tmp('bundle'), { origin: m.origin, check: check16(hubPki.caSha256), code: CODE });
    assert.deepEqual(r, { ok: false, reason: 'ca_bundle' });
    assert.ok(PAIR_LINES.ca_bundle);
    assert.deepEqual(m.seen.map((x) => x.path), ['/onboard/ca.crt']);
    assert.equal(hub.st.codes.length, sent);
    m.server.close();
  });

  test('only one certificate is ever pinned: a key-file entry holding a second one is refused, so a server of that CA is not trusted', async () => {
    const { caFingerprint, singleCaPem, findHub, putHub } = await import('./connector/keyfile.mjs');
    const { connect, request } = await import('./connector/hubclient.mjs');
    const bundle = hubPki.caPem + evilPki.caPem;
    assert.equal(caFingerprint(bundle), null);
    assert.equal(singleCaPem(bundle), null);
    assert.equal(caFingerprint(hubPki.caPem), hubPki.caSha256);
    assert.throws(() => putHub(tmp('put'), { hubId: 'hub-aaaabbbbcccc', origin: hub.origin, caPem: bundle, appKey: 'k' }), /exactly one/);
    // A section written before this check: the first certificate's fingerprint, both certificates in the text.
    const evil = await stubHub(evilPki);
    const section = { hub_id: 'hub-aaaabbbbcccc', origin: evil.origin, ca_sha256: hubPki.caSha256, ca_pem: bundle, app_key: 'k', agents: {} };
    assert.deepEqual(connect(section), { ok: false, reason: 'ca_bundle' });
    assert.deepEqual(findHub({ hubs: { [`hub-aaaabbbbcccc@${hubPki.caSha256}`]: section } }, 'hub-aaaabbbbcccc', hubPki.caSha256), { ok: false, reason: 'ca_bundle' });
    // Pinned to the hub's one certificate, the other CA's server is refused by TLS.
    const one = connect({ ...section, ca_pem: hubPki.caPem });
    assert.equal(one.ok, true);
    await assert.rejects(request(one.hub, 'GET', '/connector/v1/hub', { timeoutMs: 5000 }), (e) => e.reason === 'tls_refused');
    evil.server.close();
  });

  test('the key file stores the certificate itself, not the text around it', async () => {
    const { putHub } = await import('./connector/keyfile.mjs');
    const home = tmp('canon');
    const k = putHub(home, { hubId: 'hub-aaaabbbbcccc', origin: hub.origin, caPem: `a note before
${hubPki.caPem}
and after
`, appKey: 'k' });
    const s = readKeyFile(home).data.hubs[k];
    assert.ok(!s.ca_pem.includes('note') && !s.ca_pem.includes('after'));
    assert.equal(s.ca_sha256, hubPki.caSha256);
  });

  test('a known hub whose CA changed needs the user to confirm', async () => {
    const home = tmp('known');
    assert.equal((await pair(home, { origin: hub.origin, check: check16(hubPki.caSha256), code: CODE })).ok, false); // the stub's code is spent; seed the section directly
    const { putHub } = await import('./connector/keyfile.mjs');
    putHub(home, { hubId: 'hub-aaaabbbbcccc', origin: hub.origin, caPem: evilPki.caPem, appKey: 'old' });
    const r = await checkHub(home, { origin: hub.origin, check: check16(hubPki.caSha256) });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'ca_changed');
    const ok = await checkHub(home, { origin: hub.origin, check: check16(hubPki.caSha256) }, { confirmChange: true });
    assert.equal(ok.ok, true);
  });
});

describe('the local screen', () => {
  let s, home;
  const get = (path, headers = {}) => fetch(`http://127.0.0.1:${s.port}${path}`, { headers, redirect: 'manual' });
  before(async () => { home = tmp('screen'); s = await startScreen(home, { claudeJson: join(home, 'claude.json'), io: { pair: async () => ({ ok: true, pc: { name: 'pc' } }) } }); });
  after(() => s.close());

  test('listens on loopback only, and the token works once', async () => {
    assert.equal(s.server.address().address, '127.0.0.1');
    const t = new URL(s.url).searchParams.get('t');
    assert.equal((await get('/?t=wrong')).status, 403);
    const r = await get(`/?t=${t}`);
    assert.equal(r.status, 303);
    const cookie = r.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly; SameSite=Strict/);
    assert.equal((await get(`/?t=${t}`)).status, 403);
    const page = await get('/', { cookie: cookie.split(';')[0] });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Pair this PC with your Conclave hub/);
    assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
    assert.equal((await get('/')).status, 403); // no cookie
    s.cookie = cookie.split(';')[0];
  });

  test('refuses another Host and a POST from another origin', async () => {
    const http = await import('node:http');
    const hostReq = await new Promise((ok) => http.get({ host: '127.0.0.1', port: s.port, path: '/', headers: { host: 'evil.test', cookie: s.cookie } }, (r) => { r.resume(); ok(r.statusCode); }));
    assert.equal(hostReq, 421);
    const post = (origin) => fetch(`http://127.0.0.1:${s.port}/pair`, { method: 'POST', redirect: 'manual', headers: { cookie: s.cookie, 'content-type': 'application/x-www-form-urlencoded', ...(origin ? { origin } : {}) }, body: `origin=https%3A%2F%2Fh&check=x&code=${CODE}` });
    assert.equal((await post(null)).status, 403);
    assert.equal((await post('https://evil.test')).status, 403);
    const ok = await post(`http://127.0.0.1:${s.port}`);
    assert.equal(ok.status, 303);
    const after = await (await get('/', { cookie: s.cookie })).text();
    assert.ok(!after.includes(CODE), 'the code is never shown back');
  });

  test('stops on its own when idle', async () => {
    const quiet = await startScreen(tmp('idle'), { idleMs: 50 });
    await quiet.closed;
    await assert.rejects(fetch(quiet.url));
  });
});

describe('setup with the connector', () => {
  let hubPki, hub, home, hubKey, claudeJson, root;
  const opts = () => ({ claudeJson, gitBin: null, node: process.execPath, connector: join(home, 'conclave.mjs') });
  before(async () => {
    hubPki = testCa('Setup hub CA');
    hub = await stubHub(hubPki);
    home = tmp('setup'); root = tmp('root');
    claudeJson = join(home, 'claude.json');
    writeFileSync(join(home, 'conclave.mjs'), '// launcher\n');
    hubKey = (await pair(home, { origin: hub.origin, check: check16(hubPki.caSha256), code: CODE })).hubKey;
  });
  after(() => hub.server.close());
  const request = { kind: 'new_team', project: { name: 'Atlas', existing: false }, team: { name: 'Grants', goal: 'Keep the grant calendar.' },
    roles: [{ name: 'coordinator', team_role: 'coordinator', count: 1, job: 'Plans.' }, { name: 'developer', team_role: 'worker', count: 1, job: 'Builds.' }],
    prompt: 'a small team', client: { app: 'claude-code', os: 'windows' } };

  test('checks the request with the hub\'s rules, then files it', async () => {
    const bad = await fileRequest(home, hubKey, { ...request, roles: [] }, { check: true });
    assert.equal(bad.ok, false);
    assert.ok(bad.problems.length > 0);
    const chk = await fileRequest(home, hubKey, request, { check: true });
    assert.equal(chk.ok, true);
    assert.equal(hub.st.request, null, '--check sends nothing');
    const r = await fileRequest(home, hubKey, request, { root });
    assert.equal(r.request_id, 'obr_1');
    assert.equal(hub.st.request.team.name, 'Grants');
    assert.equal(pending(home, 'hub-aaaabbbbcccc'), true);
  });

  test('waits for approval, and the screen can be closed meanwhile (state is on disk)', async () => {
    assert.equal((await advance(home, hubKey, opts())).phase, 'waiting');
    const rows = await agentRows(home, hubKey);
    assert.deepEqual(rows.agents.map((a) => a.state), ['ready_to_open', 'ready_to_open']); // the stub's timeline; nothing built yet
    assert.equal(loadSetup(home, 'hub-aaaabbbbcccc').request.state, 'submitted');
  });

  test('after approval: keys into keys.json, folders built and registered, one agent failing, then resumed and retried', async () => {
    hub.st.state = 'approved';
    // The developer's folder path is taken by a file: that agent fails, the other is set up.
    const devDir = join(root, 'Atlas', 'developer-1');
    mkdirSync(join(root, 'Atlas'), { recursive: true });
    writeFileSync(devDir, 'not a folder');
    // At standard isolation the key pickup waits for the PC user's click on the screen: nothing is picked up before it.
    const waiting = await advanceRaw(home, hubKey, opts());
    assert.deepEqual([waiting.phase, waiting.pickup_click, hub.st.pickups], ['waiting', true, 0]);
    assert.equal(pendingList(home).pickups.length, 1);
    const r = await advance(home, hubKey, opts());
    assert.equal(r.phase, 'set_up');
    assert.deepEqual(r.built, ['coordinator']);
    assert.equal(r.failed[0].label, 'developer-1');
    assert.deepEqual(hub.st.confirmed, { pickup_id: 'opk_1', written: ['CONCLAVE_T_COORDINATOR_SESSION_KEY', 'CONCLAVE_T_DEVELOPER_1_SESSION_KEY'], transport: 'https' });
    const sec = readKeyFile(home).data.hubs[hubKey];
    assert.deepEqual(Object.keys(sec.agents).sort(), ['coordinator', 'developer-1']);
    const state = readFileSync(join(home, 'onboarding', 'hub-aaaabbbbcccc.json'), 'utf8');
    assert.ok(!state.includes('_secret') && !state.includes(APP_KEY), 'no secret in the state file');
    const coord = join(root, 'Atlas', 'coordinator');
    assert.ok(existsSync(join(coord, '.mcp.json')));
    assert.equal(readFileSync(join(coord, 'CLAUDE.md'), 'utf8'), '# You are the coordinator\n');
    assert.equal(existsSync(join(coord, 'AGENTS.override.md')), false, 'a Claude Code agent gets no Codex role file');
    assert.equal(resolveFolder(home, coord).binding.provider, undefined, 'and its folder is not marked Codex (no commit tool)');
    assert.deepEqual([resolveFolder(home, coord).binding.team, resolveFolder(home, coord).binding.team_name], ['team_1', 'Grants'], 'the team from the pickup is recorded, for Bind team');
    assert.ok(entries(home).some((e) => e.kind === 'instructions' && e.target === join(coord, 'CLAUDE.md') && e.installed?.sha256 === createHash('sha256').update('# You are the coordinator\n').digest('hex')), 'recorded with the hash of what setup wrote, so uninstall can tell an edit');
    const ck = await runCheck(home, coord, opts());
    assert.equal(ck.ok, true, 'check is clean right after setup: ' + ck.line);
    let rows = await agentRows(home, hubKey);
    assert.deepEqual(rows.agents.map((a) => [a.label, a.state]), [['coordinator', 'ready_to_open'], ['developer-1', 'failed']]);
    assert.ok(rows.agents[1].error);
    assert.match(rows.agents[0].open.terminal, /claude /);
    assert.match(rows.agents[0].open.codex, /^codex -C /);
    // Continue setup again (after a restart) does not pick up again.
    await advance(home, hubKey, opts());
    assert.equal(hub.st.pickups, 1);
    // Retry the one agent once its folder is free.
    rmSync(devDir);
    assert.deepEqual(retryAgent(home, hubKey, 'developer-1', opts()), { ok: true });
    hub.st.connected.add('agt_coord');
    rows = await agentRows(home, hubKey);
    assert.deepEqual(rows.agents.map((a) => [a.label, a.state]), [['coordinator', 'connected'], ['developer-1', 'ready_to_open']]);
    assert.equal(pending(home, 'hub-aaaabbbbcccc'), false);
  });

  test('the open commands quote the folder for each shell', () => {
    const w = openWays('C:\\Users\\a b\\Conclave\\x', { label: 'x', role: 'dev' }, 'T', true);
    assert.match(w.terminal, /^cd "C:\\Users\\a b\\Conclave\\x"; claude "/);
    assert.match(w.desktop.line, /start a new Code session in this folder/);
    const p = openWays("/home/a'b/x", { label: 'x', role: 'dev' }, 'T', false);
    assert.match(p.terminal, /^cd '\/home\/a'\\''b\/x' && claude '/);
  });
});

const hasGit = spawnSync('git', ['--version']).status === 0;

describe('setup with the connector, for Codex agents (the layout a restored Codex agent gets)', () => {
  let hubPki, hub, home, hubKey, claudeJson, root;
  const opts = () => ({ claudeJson, gitBin: hasGit ? 'git' : null, node: process.execPath, connector: join(home, 'conclave.mjs') });
  before(async () => {
    hubPki = testCa('Codex setup hub CA');
    hub = await stubHub(hubPki);
    home = tmp('cxsetup'); root = tmp('cxroot');
    claudeJson = join(home, 'claude.json');
    writeFileSync(join(home, 'conclave.mjs'), '// launcher\n');
    hubKey = (await pair(home, { origin: hub.origin, check: check16(hubPki.caSha256), code: CODE })).hubKey;
  });
  after(() => hub.server.close());
  const request = { kind: 'new_team', project: { name: 'Atlas', existing: false }, team: { name: 'Grants', goal: 'Keep the grant calendar.' },
    roles: [{ name: 'coordinator', team_role: 'coordinator', count: 1, job: 'Plans.' }, { name: 'developer', team_role: 'worker', count: 1, job: 'Builds.' }],
    prompt: 'a small team', client: { app: 'codex', os: 'windows' } };

  test('an override from someone else stops that agent before anything is written; the other gets the marked override, excluded, a Codex binding, and an AGENTS.md left as it is', async () => {
    assert.equal((await fileRequest(home, hubKey, request, { root })).request_id, 'obr_1');
    hub.st.state = 'approved';
    const coord = join(root, 'Atlas', 'coordinator'), dev = join(root, 'Atlas', 'developer-1');
    mkdirSync(coord, { recursive: true }); mkdirSync(dev, { recursive: true });
    writeFileSync(join(coord, 'AGENTS.md'), 'project conventions\n'); // the project's own file: never touched
    writeFileSync(join(dev, 'AGENTS.override.md'), 'my own rules\n'); // not the connector's: never overwritten
    const r = await advance(home, hubKey, opts());
    assert.equal(r.phase, 'set_up');
    assert.deepEqual(r.built, ['coordinator']);
    assert.equal(r.failed[0].label, 'developer-1');
    assert.match(r.failed[0].error, /AGENTS\.override\.md that Conclave did not write/);
    assert.equal(readFileSync(join(dev, 'AGENTS.override.md'), 'utf8'), 'my own rules\n');
    assert.equal(existsSync(join(dev, '.mcp.json')), false, 'nothing was written into the refused folder');
    assert.equal(resolveFolder(home, dev).ok, false, 'and it was not registered');

    assert.equal(readFileSync(join(coord, 'AGENTS.md'), 'utf8'), 'project conventions\n', 'the AGENTS.md there is left as it is');
    assert.equal(overrideState(coord), 'ours');
    const role = readFileSync(join(coord, 'AGENTS.override.md'), 'utf8');
    assert.equal(role.split('\n')[0], OVERRIDE_MARKER);
    assert.match(role, /`commit` tool of the `conclave` server/);
    assert.match(role, /# You are the coordinator\n/);
    assert.ok(entries(home).some((e) => e.kind === 'codex_role' && e.target === join(coord, 'AGENTS.override.md')), 'recorded, so repair can write it back');
    assert.ok(!entries(home).some((e) => e.kind === 'codex_instructions'), 'setup no longer writes an AGENTS.md of its own');
    assert.ok(existsSync(join(coord, '.codex', 'config.toml')));
    const b = resolveFolder(home, coord);
    assert.equal(b.binding.provider, 'codex', 'the folder is marked Codex, so its local server offers the commit tool');
    assert.equal(roleFileProblem(home, coord), null, 'check finds the role file as the connector wrote it');
    const ck = await runCheck(home, coord, opts());
    assert.equal(ck.ok, true, 'check is clean right after setup: ' + ck.line);
    assert.notEqual(trustStatus(claudeJson, coord, b.binding).reason, 'folder_changed', 'and the folder settings as recorded');
    if (hasGit) {
      const ex = readFileSync(join(coord, '.git', 'info', 'exclude'), 'utf8').split(/\r?\n/);
      for (const line of ['*', 'AGENTS.override.md', '.codex/', '.claude/', '.mcp.json']) assert.ok(ex.includes(line), `${line} is excluded`);
      const st = spawnSync('git', ['-C', coord, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' });
      assert.equal(st.stdout.trim(), '');
      // A new file in this scratch-built folder (excluded by *) is committed through the connector; the refusals hold.
      const author = { name: 'Conclave Coordinator', email: 'coordinator@agents.conclave.invalid' };
      writeFileSync(join(coord, 'notes.txt'), 'new file\n');
      const c = commitFiles({ home, folder: coord, paths: ['notes.txt'], message: 'Add notes', author });
      assert.equal(c.ok, true, c.reason);
      const tree = spawnSync('git', ['-C', coord, 'ls-tree', '-r', '--name-only', 'HEAD'], { encoding: 'utf8' }).stdout.split(/\r?\n/);
      assert.deepEqual(tree.filter(Boolean), ['notes.txt']);
      assert.equal(spawnSync('git', ['-C', coord, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' }).stdout.trim(), '', 'a hand-run git status stays clean');
      for (const bad of ['AGENTS.override.md', '.codex/config.toml', '.git/config', '.mcp.json', '../x.txt', join(root, 'x.txt')]) {
        assert.equal(commitFiles({ home, folder: coord, paths: [bad], message: 'no', author }).ok, false, bad + ' stays refused');
      }
      const ls = spawnSync('git', ['-C', coord, 'ls-tree', '-r', '--name-only', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
      assert.equal(ls, 'notes.txt');
    }

    // Once the folder is free, Retry sets the developer up the same way.
    rmSync(join(dev, 'AGENTS.override.md'));
    assert.deepEqual(retryAgent(home, hubKey, 'developer-1', opts()), { ok: true });
    assert.equal(overrideState(dev), 'ours');
    assert.equal(existsSync(join(dev, 'AGENTS.md')), false);
    assert.equal(resolveFolder(home, dev).binding.provider, 'codex');
    // A second build over the connector's own override is fine (it is rewritten, never refused).
    assert.deepEqual(retryAgent(home, hubKey, 'developer-1', opts()), { ok: true });
  });
});

describe('the private git', () => {
  const fakeZip = Buffer.from('fake mingit archive');
  const pin = { ...MINGIT, sha256: createHash('sha256').update(fakeZip).digest('hex') };
  const io = (env, sets) => ({ pin, env, download: async (_u, dest) => writeFileSync(dest, fakeZip),
    unzip: (_z, dir) => { mkdirSync(join(dir, 'usr', 'bin'), { recursive: true }); mkdirSync(join(dir, 'cmd'), { recursive: true }); writeFileSync(join(dir, 'usr', 'bin', 'sh.exe'), 'bash'); writeFileSync(join(dir, 'cmd', 'git.exe'), 'git'); },
    userEnv: { get: () => null, set: (k, v) => sets.push([k, v]) } });

  test('is offered on Windows when no git is found, and says the install command elsewhere', () => {
    const home = tmp('gs');
    assert.deepEqual(gitState(home, { env: { PATH: '' }, win: true }), { state: 'offer', line: GIT_OFFER });
    assert.equal(gitState(home, { env: { PATH: '' }, win: true, codex: true }).codex, CODEX_GIT);
    assert.equal(gitState(home, { env: { PATH: '' }, win: false, os: 'darwin' }).state, 'missing');
  });

  test('refuses a file that is not the pinned MinGit, and unpacks nothing', async () => {
    const home = tmp('gbad'), sets = [];
    const r = await installPrivateGit(home, { io: { ...io({ PATH: '' }, sets), pin: MINGIT }, claudeJson: join(home, 'c.json') });
    assert.deepEqual(r, { ok: false, reason: 'hash_mismatch' });
    assert.equal(existsSync(join(home, 'git')), false);
    assert.equal(existsSync(join(home, 'tmp', MINGIT.file)), false);
    assert.deepEqual(sets, []);
  });

  test('installs, copies bash, sets the Git Bash variable only without Git for Windows, all in the manifest', async () => {
    const home = tmp('gok'), sets = [];
    const r = await installPrivateGit(home, { io: io({ PATH: '', ProgramFiles: join(home, 'none'), 'ProgramFiles(x86)': join(home, 'none') }, sets), claudeJson: join(home, 'c.json') });
    assert.equal(r.ok, true);
    assert.equal(r.bashVar, 'set');
    assert.equal(readFileSync(join(home, 'git', 'usr', 'bin', 'bash.exe'), 'utf8'), 'bash');
    assert.deepEqual(sets, [['CLAUDE_CODE_GIT_BASH_PATH', join(home, 'git', 'usr', 'bin', 'bash.exe')]]);
    assert.deepEqual(entries(home).map((e) => e.kind).sort(), ['portable_git', 'user_env']);
    const pf = tmp('pf'); mkdirSync(join(pf, 'Git', 'bin'), { recursive: true }); writeFileSync(join(pf, 'Git', 'bin', 'bash.exe'), '');
    const home2 = tmp('gok2'), sets2 = [];
    const r2 = await installPrivateGit(home2, { io: io({ PATH: '', ProgramFiles: pf }, sets2), claudeJson: join(home2, 'c.json') });
    assert.equal(r2.bashVar, 'not_needed');
    assert.deepEqual(sets2, []);
  });
});

describe('the signed installer (throwaway test key only)', async () => {
  const { generateKeyPairSync, sign: edSign } = await import('node:crypto');
  const { execFileSync } = await import('node:child_process');
  const { packBundle, releaseNames, keyIdOf, sha256, MANIFEST_FORMAT, platformId, buildInstaller } = await import('./connector/release.mjs');
  const { releaseFiles } = await import('./connector/builds.mjs');
  const { install, checkRelease } = await import('./install.mjs');
  const REPO = join(import.meta.dirname, '..', '..');
  const keyPair = () => { const { privateKey, publicKey } = generateKeyPairSync('ed25519'); const der = publicKey.export({ format: 'der', type: 'spki' }).toString('base64'); return { priv: privateKey, entry: { id: keyIdOf(der), public_key: der } }; };
  const K = keyPair(), OTHER = keyPair();
  const files = releaseFiles(REPO);
  /** A release folder with the three files, signed by `key`; `tamper` changes one thing after signing. */
  const release = (version, { key = K, tamper, as } = {}) => {
    const n = releaseNames(as ?? version), dir = tmp('rel');
    const bundle = packBundle(files);
    const manifest = { format: MANIFEST_FORMAT, version, platforms: [platformId()], bundle: { name: releaseNames(version).bundle, sha256: sha256(bundle), size: bundle.length }, key_id: key.entry.id, rollover: null, created_at: new Date().toISOString() };
    const text = JSON.stringify(manifest, null, 2) + '\n';
    const sig = edSign(null, Buffer.from(text), key.priv).toString('base64');
    writeFileSync(join(dir, n.manifest), tamper === 'manifest' ? text.replace('"format"', '"format" ') : text);
    if (tamper !== 'unsigned') writeFileSync(join(dir, n.signature), sig + '\n');
    const b = Buffer.from(bundle); if (tamper === 'bundle') b[b.length - 10] ^= 0xff;
    writeFileSync(join(dir, n.bundle), b);
    return dir;
  };
  const embed = (version) => ({ version, release_base: 'https://github.com/example/Conclave/releases/download', keys: [K.entry] });
  const quiet = { service: false, screen: false, out: () => {} };

  test('the built installer checks the release with no hub and installs the build', () => {
    const dir = release('9.1.0'), home = tmp('inst');
    const file = join(dir, releaseNames('9.1.0').installer);
    writeFileSync(file, buildInstaller(readFileSync(join(import.meta.dirname, 'install.mjs'), 'utf8'), embed('9.1.0')));
    const out = execFileSync(process.execPath, [file, '--from', dir, '--no-service', '--no-screen'], { env: { ...process.env, CONCLAVE_HOME: home }, encoding: 'utf8' });
    assert.match(out, new RegExp(`signed by the Conclave release key ${K.entry.id}`));
    const b = JSON.parse(readFileSync(join(home, 'app', 'builds.json'), 'utf8'));
    assert.equal(b.current, '9.1.0');
    assert.equal(b.builds['9.1.0'].verified, true);
    assert.ok(existsSync(join(home, 'conclave.mjs')));
    assert.ok(existsSync(join(home, 'app', '9.1.0', 'deploy', 'client', 'connector', 'pairing.mjs')));
    assert.equal(existsSync(join(home, 'tmp', 'install-9.1.0-' + process.pid)), false);
  });

  for (const [what, opts, reason] of [['an unsigned release', { tamper: 'unsigned' }, 'unsigned'], ['a changed manifest', { tamper: 'manifest' }, 'bad_signature'], ['a changed bundle', { tamper: 'bundle' }, 'bundle_mismatch'], ['a release signed by another key', { key: OTHER }, 'unknown_key']]) {
    test(`refuses ${what} and installs nothing`, async () => {
      const home = tmp('ref');
      const r = await install({ embed: embed('9.1.0'), from: release('9.1.0', opts), home, ...quiet });
      assert.deepEqual(r, { ok: false, reason });
      assert.equal(existsSync(join(home, 'app')), false);
    });
  }

  test('refuses another version than its own, and an older one over a newer build', async () => {
    assert.deepEqual(await install({ embed: embed('9.1.0'), from: release('9.2.0', { as: '9.1.0' }), home: tmp('v'), ...quiet }), { ok: false, reason: 'version_mismatch' });
    const home = tmp('down');
    assert.equal((await install({ embed: embed('9.2.0'), from: release('9.2.0'), home, ...quiet })).ok, true);
    assert.deepEqual(await install({ embed: embed('9.1.0'), from: release('9.1.0'), home, ...quiet }), { ok: false, reason: 'downgrade' });
    assert.equal(JSON.parse(readFileSync(join(home, 'app', 'builds.json'), 'utf8')).current, '9.2.0');
  });

  test('the template without keys refuses, and buildInstaller needs a valid key', () => {
    assert.deepEqual(checkRelease({ manifestText: '{}', signature: 'x', bundle: Buffer.alloc(0) }, null), { ok: false, reason: 'not_built' });
    const tpl = readFileSync(join(import.meta.dirname, 'install.mjs'), 'utf8');
    assert.throws(() => buildInstaller(tpl, { version: '9.1.0', release_base: null, keys: [] }));
    assert.throws(() => buildInstaller('no marker', embed('9.1.0')));
  });
});
