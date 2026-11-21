// Two cases the first run did not cover: a key revoked in the middle of a write burst, and restricted folders with 20 parallel requesters.
import fs from 'node:fs';
import { Agent, api, out, cfg, RUN } from './lib.mjs';

const R = []; const rec = (id, name, pass, ev) => { R.push({ id, name, pass, ev }); console.log((pass ? 'PASS ' : 'FAIL ') + id + ' ' + name + ' :: ' + JSON.stringify(ev).slice(0, 450)); };
const P = `/vault/Stress/${RUN}/c8/`;
const secrets = JSON.parse(fs.readFileSync(cfg.secrets, 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 8.1 a key revoked in the middle of a burst: nothing is acknowledged after the revoke has returned, and every acknowledged write is intact.
{
  const a = new Agent('vs-rev'); await a.login();
  const credId = secrets.agents['vs-rev'].cred;
  const acks = []; let stop = false; let revokedAt = null; let afterRevokeAcks = 0;
  const worker = async (k) => {
    for (let i = 0; i < 200 && !stop; i++) {
      const p = P + `rev/k${k}-${i}.md`; const content = `rev ${k} ${i} ` + 'r'.repeat(500);
      const started = Date.now();
      const r = await a.call('file_create', { path: p, content });
      if (!r.err) { acks.push({ p, content, started }); if (revokedAt && started > revokedAt) afterRevokeAcks++; }
    }
  };
  const burst = Promise.all([0, 1, 2, 3].map(worker));
  await sleep(1500);
  const rv = await api('POST', `/api/keys/${credId}/revoke`, {});
  revokedAt = Date.now();
  await sleep(1500); stop = true; await burst;
  const reader = new Agent('vs-w1'); await reader.login();
  let missing = 0, differ = 0;
  for (const x of acks) { const r = await reader.call('file_read', { path: x.p }); if (r.err) missing++; else if (r.data?.content !== x.content) differ++; }
  const late = await a.call('file_create', { path: P + 'rev/after.md', content: 'x' });
  rec('8.1', 'key revoked mid burst: no write starts after the revoke is acknowledged, acknowledged writes intact, the key stays refused',
    rv.s === 200 && afterRevokeAcks === 0 && missing === 0 && differ === 0 && late.err,
    { revokeStatus: rv.s, acknowledged: acks.length, ackedAfterRevoke: afterRevokeAcks, missing, differ, newCallRefused: late.err, sample: late.text.slice(0, 80) });
}

// 8.2 restricted folders with 20 parallel requesters.
{
  const w = new Agent('vs-w1'); await w.login();
  await w.call('file_create', { path: `/vault/Stress/Open/a-${RUN}.md`, content: 'open' });
  await w.call('file_create', { path: '/vault/Stress/Open/Secret/s.md', content: 'topsecretword' });
  await w.call('file_create', { path: '/vault/Stress/Closed/c.md', content: 'closed' });
  const names = []; for (let n = 9; n <= 20; n++) names.push('vs-p' + n);
  const reqs = []; for (let i = 0; i < 20; i++) { const a = new Agent(names[i % names.length]); await a.login(); reqs.push(a); }
  const wrong = []; const leaks = []; let allowedOk = 0, allowedBad = 0;
  await Promise.all(reqs.map(async (a, k) => {
    for (let i = 0; i < 10; i++) {
      const op = await a.call('file_create', { path: `/vault/Stress/Open/${RUN}-p${k}-${i}.md`, content: 'ok' });
      op.err ? allowedBad++ : allowedOk++;
      const res = await Promise.all([
        a.call('file_create', { path: `/vault/Stress/Open/Secret/${RUN}-p${k}-${i}.md`, content: 'x' }),
        a.call('file_read', { path: '/vault/Stress/Open/Secret/s.md' }),
        a.call('file_create', { path: `/vault/Stress/Closed/${RUN}-p${k}-${i}.md`, content: 'x' }),
        a.call('file_read', { path: '/vault/Stress/Closed/c.md' }),
        a.call('file_update', { path: '/vault/Stress/Open/Secret/s.md', content: 'hacked', base_revision: 'absent' }),
      ]);
      res.forEach((r, j) => { if (!r.err) wrong.push(`${k}/${i}/${j}`); });
      const l = await a.call('file_list', { path: '/vault/Stress/Open' }); const s = await a.call('file_search', { query: 'topsecretword', path: '/vault/Stress' });
      if (/Secret/.test(l.text) || /s\.md|topsecretword/.test(s.text)) leaks.push(`${k}/${i}`);
    }
  }));
  const after = await w.call('file_read', { path: '/vault/Stress/Open/Secret/s.md' });
  rec('8.2', '20 parallel restricted requesters: allowed writes succeed, denied ones never do, nothing leaks into list or search',
    wrong.length === 0 && leaks.length === 0 && allowedBad === 0 && after.data?.content === 'topsecretword',
    { requesters: reqs.length, allowedOk, allowedBad, deniedButAllowed: wrong.slice(0, 5), leaks: leaks.slice(0, 5), secretUnchanged: after.data?.content === 'topsecretword' });
}
out('c8.json', R);
