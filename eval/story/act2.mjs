// Act 2: research — files, graph, shares and reviews, feedback, a channel transfer (docs/showcase.md §4).
import { createHash } from 'node:crypto';
import { movePlans, writePlan, bpKey } from './plans.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const s = (id, title, run, opts = {}) => ({ id, title, run, ...opts });
const V = '/vault';
const sha = (b) => createHash('sha256').update(b).digest('hex');

const ECHO_V2 = `---
owner: Signals Lab
status: draft
depends_on: ["[[Echo model v1]]", "[[Echo geometry]]", "[[Lead time vs transmit power]]"]
tags: [echo-model, m1]
---
# Echo model v2

## Changes from v1

The ring geometry is unchanged. The power law is refitted to calibration sweeps CS-1 to CS-46 with the raw coupler record, not the summary log.

## Operating power

The operating power for the qualification captures is P 0.33, which gives margin over the P 0.30 cap.

## Open items

Echo 47 still sits off the curve at the 0.25 drive. This model does not explain it.
`;

export default [
  s('2.1', 'Imani reads her folder and searches the vault', async (c) => {
    const I = c.as('Imani');
    await I.ok('file_list', { path: `${V}/Signals Lab` });
    const r = await I.ok('file_read', { path: `${V}/Signals Lab/Echo geometry.md` });
    c.expect((r.content ?? '').includes('# Echo geometry'), 'the note reads');
    await I.ok('file_stat', { path: `${V}/Signals Lab/Echo geometry.md` });
    await I.ok('file_search', { query: 'transmit power' });
    const hits = JSON.stringify(await I.ok('file_search', { query: 'second timestamp', limit: 50 }));
    c.expect(hits.includes('Timekeepers/Second timestamp.md') && hits.includes('Whiteboard, 14 March'), 'the search finds the Timekeepers note and the whiteboard');
    c.expect(!hits.includes('/Classified/'), 'no Classified note in the results');
  }, { rows: ['trust-boundaries'] }),

  s('2.2', 'Imani opts in to her impact check and writes Echo model v2', async (c) => {
    await c.as('Imani').ok('graph_editor_optin', { enabled: true });
    c.S.fieldV2 = await c.as('Imani').ok('file_create', { path: `${V}/Signals Lab/Echo model v2.md`, content: ECHO_V2 });
  }),

  s('2.3', 'Imani patches the note; Teodor updates it on the current base', async (c) => {
    const p = await c.as('Imani').ok('file_patch', { path: `${V}/Signals Lab/Echo model v2.md`, base_revision: c.S.fieldV2.revision, edits: [{ old: 'which gives margin over the P 0.30 cap.', new: 'which gives margin over the P 0.30 cap. Block B of CAP-014 runs there.' }] });
    const r = await c.as('Teodor').ok('file_read', { path: `${V}/Signals Lab/Echo model v2.md` });
    c.eq(r.revision, p.revision, 'Teodor reads the patched revision');
    c.S.fieldV2 = await c.as('Teodor').ok('file_update', { path: `${V}/Signals Lab/Echo model v2.md`, base_revision: r.revision, content: r.content.replace('This model does not explain it.', 'This model does not explain it. Teodor: readback fault, see my notebook.') });
  }),

  s('2.4', 'Dario renames the dish draft and deletes his scratch note', async (c) => {
    const D = c.as('Dario');
    const st = await D.ok('file_stat', { path: `${V}/Relay Engineering/Dish draft.md` });
    await D.ok('file_rename', { from: `${V}/Relay Engineering/Dish draft.md`, to: `${V}/Relay Engineering/Dish array design notes.md`, base_revision: st.revision });
    const sc = await D.ok('file_stat', { path: `${V}/Relay Engineering/scratch.md` });
    await D.ok('file_delete', { path: `${V}/Relay Engineering/scratch.md`, base_revision: sc.revision });
    c.S.scratchRev = sc.revision;
  }),

  s('2.5', 'Quentin takes an indexing job; one claim with a bad quote is rejected', async (c) => {
    const Q = c.as('Quentin');
    let item;
    await c.until(async () => {
      const w = await Q.ok('work_next', { wait_seconds: 0 });
      if (w.item?.kind === 'knowledge_job') return (item = w.item);
      if (w.item?.item_id) await Q.ok('work_ack', { item_id: w.item.item_id });
      return null;
    }, { timeout: 20000, every: 500, what: 'a knowledge job for the curator' });
    const path = item.input.path, sec = item.input.sections.find((x) => x.text?.length > 40) ?? item.input.sections[0];
    const text = c.disk.read(path.replace(/^\/vault\//, ''));
    const quote = c.quoteIn(text, sec.anchor);
    const sub = await Q.ok('graph_job_submit', { job_id: item.job_id, payload: {
      entities: [{ name: 'Dish array', type: 'component' }],
      claims: [
        { subject: 'Dish array', predicate: 'described_in', object_text: path, text: `Described in ${path}.`, anchor: sec.anchor, quote, confidence: 0.8 },
        { subject: 'Dish array', predicate: 'survives', object_text: 'everything', text: 'It survives everything.', anchor: sec.anchor, quote: 'this sentence is not in the note', confidence: 0.9 },
      ],
      note_summary: `Indexed by the curator: ${path}.`,
    } });
    c.expect(sub.verdict === 'partial' && (sub.rejected ?? []).length === 1, `one claim rejected (got ${sub.verdict}, ${JSON.stringify(sub.rejected)})`);
    await Q.ok('work_ack', { item_id: item.item_id });
  }, { beat: 2000, rows: ['knowledge'] }),

  s('2.6', 'Quentin adds claims, a summary and a relation by hand', async (c) => {
    const Q = c.as('Quentin');
    const spec = `${V}/Theories/Firmware 7.md`, budget = `${V}/Relay Engineering/Power budget.md`;
    const t1 = c.disk.read('Theories/Firmware 7.md'), t2 = c.disk.read('Relay Engineering/Power budget.md');
    const up1 = await Q.ok('graph_upsert', { path: spec, payload: { entities: [{ name: 'Firmware 7', type: 'explanation' }, { name: 'Receiver front end', type: 'component' }], claims: [
      { subject: 'Firmware 7', predicate: 'qualified_for', object_text: 'R4 pending CAP-014', text: 'Firmware 7 as the explanation for R4 rests on CAP-014.', anchor: 'qualification-status', quote: c.quoteIn(t1, 'qualification-status'), confidence: 0.85 },
      { subject: 'Receiver front end', predicate: 'runs', object: 'Firmware 7', text: 'Every receiver front end runs Firmware 7.', anchor: 'scope', quote: c.quoteIn(t1, 'scope'), confidence: 0.9 },
    ] } });
    c.expect(up1.accepted_claims >= 1, `claims accepted (${JSON.stringify(up1).slice(0, 200)})`);
    await Q.ok('graph_upsert', { path: budget, payload: { entities: [{ name: 'Capacitor bank', type: 'component' }], claims: [
      { subject: 'Capacitor bank', predicate: 'feeds', object_text: 'dish array', text: 'The capacitor bank feeds the burst.', anchor: 'the-burst-in-energy', quote: c.quoteIn(t2, 'the-burst-in-energy'), confidence: 0.8 },
    ] } });
    await Q.ok('graph_summary_write', { path: spec, text: 'Firmware 7 is the official explanation: a stale clock register stamps replies 0.71 s early. Its qualification for R4 waits on CAP-014. The front end peaks near 2.2–2.4 GHz.' });
    const q = await Q.ok('graph_query', { entity: 'Firmware 7' });
    c.S.hc7Claims = (q.claims ?? []).map((x) => x.id);
    await Q.ok('graph_link', { src: 'Receiver front end', dst: 'Firmware 7', kind: 'runs', claim_ids: c.S.hc7Claims.slice(0, 1) });
  }, { rows: ['knowledge'] }),

  s('2.7', 'Lusa asks the graph about the dish', async (c) => {
    const L = c.as('Lusa');
    await L.ok('graph_related', { path: `${V}/Relay Engineering/Dish array design.md` });
    const q = await L.ok('graph_query', { entity: 'Firmware 7' });
    c.expect(!JSON.stringify(q).includes('/Classified/'), 'no Classified source is disclosed');
    await L.ok('graph_context', { question: 'What limits the transmit power?' });
    await L.ok('graph_summary', { scope: 'note', ref: `${V}/Theories/Firmware 7.md` });
  }, { rows: ['trust-boundaries'] }),

  s('2.8', 'Hesper shares the dish panel drafts with her team', async (c) => {
    const r = await c.as('Hesper').ok('share_create', { name: 'Dish panel drafts', description: 'Receiver panel layout for the Firmware 7 patch, for review.', with: [`team:${c.T('mh')}`] });
    c.S.share = r.share_id ?? r.share?.id;
    const files = [{ path: 'plates.md', content: '# Dish panel drafts\n\n## Layout\n\nTwenty-four receiver panels, 44 mm wall.\n\n## Joints\n\nForty-eight flexure brackets.\n\n## Open\n\nBracket boss radius.\n' }];
    const u = await c.as('Hesper').ok('share_upload', { share_id: c.S.share, files, final: true });
    c.S.shareV = u.version ?? 1;
  }),

  s('2.9', 'Hollis reads the share and comments on a line', async (c) => {
    const H = c.as('Hollis');
    await H.ok('share_list', {});
    await H.ok('share_info', { share_id: c.S.share });
    await H.ok('share_read', { share_id: c.S.share, version: 1, path: 'plates.md' });
    await H.ok('share_comment', { share_id: c.S.share, version: 1, path: 'plates.md', line: 5, body: 'State the wall thickness tolerance.' });
  }),

  s('2.10', 'Halden suggests a change as a diff', async (c) => {
    const patch = '--- a/plates.md\n+++ b/plates.md\n@@ -9,1 +9,1 @@\n-Forty-eight flexure brackets.\n+Forty-eight flexure brackets, titanium.\n';
    const r = await c.as('Halden').ok('share_suggest', { share_id: c.S.share, version: 1, patch, note: 'Name the bracket material.' });
    c.S.suggestion = r.suggestion_id ?? r.feedback_id ?? r.id;
  }),

  s('2.11', 'Hesper applies the feedback in version 2', async (c) => {
    const H = c.as('Hesper');
    const fb = await H.ok('share_feedback', { share_id: c.S.share });
    const items = fb.feedback ?? fb.items ?? [];
    c.expect(items.length >= 2, `the comment and the suggestion are there (${items.length})`);
    await H.ok('share_upload', { share_id: c.S.share, final: true, files: [{ path: 'plates.md', content: '# Dish panel drafts\n\n## Layout\n\nTwenty-four receiver panels, 44 mm wall, ±0.3 mm.\n\n## Joints\n\nForty-eight flexure brackets, titanium.\n\n## Open\n\nBracket boss radius.\n' }] });
    await H.ok('share_diff', { share_id: c.S.share, from_version: 1, to_version: 2 });
    for (const f of items) await H.ok('share_resolve', { feedback_id: f.id ?? f.feedback_id, status: 'applied', note: 'In version 2.' });
  }),

  s('2.12', 'Hollis downloads version 2', async (c) => {
    const d = await c.as('Hollis').ok('share_download', { share_id: c.S.share, version: 2 });
    c.expect(JSON.stringify(d).includes('titanium'), 'version 2 arrives inline');
  }),

  s('2.13', 'The operator adopts the rule Petra suggested for her team', async (c) => {
    // A report is a suggestion to the reporter's team, not a directive in force (docs/directives.md#suggestions-from-agents).
    const reps = (await c.op.get('/api/directive-reports')).reports ?? [];
    const rep = reps.find((x) => /echo-hours/.test(x.title));
    c.expect(rep && rep.status === 'open' && rep.category === 'sources' && rep.agent_label === 'Petra' && rep.team_id, 'the reported rule waits as an open suggestion to her team, with its proposed category');
    const ds = (await c.op.get('/api/directives')).directives ?? [];
    c.expect(!ds.some((x) => /echo-hours/.test(x.title)), 'nothing is in force before the operator adopts it');
    c.expect((await c.op.get('/api/directives/unreviewed-count')).suggestions >= 1, 'Home counts the waiting suggestion');
    // Petra sent no text, so the operator writes it from her summary.
    const r = await c.op.post(`/api/directive-reports/${rep.id}/adopt`, { body: rep.summary });
    c.eq(r.report.status, 'adopted', 'Adopt decides the suggestion');
    c.eq(r.directive.category, 'sources', 'the new directive keeps the proposed category');
    c.expect(r.directive.scope_kind === 'team' && r.directive.scope_ref === rep.team_id, 'Adopt makes it a directive for her team');
    // An adopted suggestion is reviewed already: Keep as is on its review card changes nothing.
    const k = await c.op.post(`/api/directives/${r.directive.id}/review`, {});
    c.expect(k.directive.reviewed_at && k.directive.category === 'sources' && k.directive.version === r.directive.version, 'Keep as is leaves the adopted directive as it is');
  }, { rows: ['directives-categories'] }),

  s('2.14', 'Vesna submits, Halden asks for changes, then approves; Hesper closes', async (c) => {
    const J = c.as('Vesna'), N = c.as('Halden'), id = c.S.t.alloy.id;
    await J.ok('task_start', { task_id: id });
    await J.ok('task_progress', { task_id: id, note: 'Layout drafted, sharing for review.', until: Date.now() + 2 * 3600_000 });
    // Vesna hands in files of her own (Hesper's share is Hesper's: only its author may copy it into a task).
    const v1 = (await J.ok('task_submit', { task_id: id, summary: 'Plate layout v1 attached.', attachments: [{ path: 'plates.md', content: '# Plate layout v1\n\nTwenty-four receiver panels, 44 mm wall.\n' }] })).task.version;
    await N.ok('task_review', { task_id: id, decision: 'request_changes', comments: 'Name the bracket material and the wall tolerance.', version: v1 });
    await J.ok('task_start', { task_id: id });
    const v2 = (await J.ok('task_submit', { task_id: id, summary: 'Version 2: titanium brackets, ±0.3 mm wall.', attachments: [{ path: 'plates.md', content: '# Plate layout v2\n\nTitanium brackets, wall 44 mm ±0.3 mm.\n' }] })).task.version;
    await N.ok('task_review', { task_id: id, decision: 'approve', comments: 'Both points answered.', version: v2 });
    await c.as('Hesper').ok('task_complete', { task_id: id, summary: 'Plate layout accepted.' });
  }, { beat: 2500, rows: ['teams'] }),

  s('2.15', 'Workers cannot review their own work or close, block or cancel tasks', async (c) => {
    const t = (await c.as('Hesper').ok('task_create', { team_id: c.T('mh'), title: 'Dish mount loads', description: 'Mount loads at frame 41 during a send.', refs: ['AN-R5', 'AN-M3'].map(bpKey) })).task;
    await c.as('Hesper').ok('task_assign', { task_id: t.id, agent_id: c.A('Vesna'), reviewer: c.A('Halden') });
    c.S.t.waist = t;
    const J = c.as('Vesna');
    await J.ok('task_start', { task_id: t.id });
    const sv = (await J.ok('task_submit', { task_id: t.id, summary: 'Loads tabulated.' })).task.version;
    await J.no('task_review', { task_id: t.id, decision: 'approve', comments: 'Looks fine to me.', version: sv });
    for (const [tool, args] of [['task_complete', {}], ['task_block', { reason: 'waiting' }], ['task_cancel', { reason: 'not needed' }]]) {
      const r = await J.no(tool, { task_id: t.id, ...args });
      c.expect(/coordinator/i.test(r.text), `${tool} names the coordinator role: ${r.text.slice(0, 160)}`);
    }
  }, { rows: ['teams'] }),

  s('2.16', 'Rafi searches the feedback, then files a limitation', async (c) => {
    const f = await c.as('Rafi').ok('feedback_find', { query: 'patch multi-line' });
    c.expect(!(f.reports ?? []).length, 'nothing filed yet');
    const r = await c.as('Rafi').ok('feedback_file', { kind: 'limitation', tool: 'file_patch', error_code: 'patch_failed', title: 'file_patch cannot match text across a table row break', severity: 'costly',
      tried: 'Patched a table row in the Firmware 7 file with an edit spanning two lines.', happened: 'patch_failed: the old text was not found.', workaround: 'Rewrote the whole file with file_update.' });
    c.S.report = r.report_id;
  }),

  s('2.17', 'Teodor hits the same thing; Lusa backs it; Rafi reads it', async (c) => {
    const r = await c.as('Teodor').ok('feedback_file', { kind: 'limitation', tool: 'file_patch', error_code: 'patch_failed', title: 'file_patch cannot match text across a table row break', severity: 'costly', tried: 'Patched a two-line table cell in the echo model.' });
    c.expect(r.outcome === 'merged' || r.status === 'merged' || r.merged === true || r.report_id === c.S.report, `the second filing merges (${JSON.stringify(r).slice(0, 160)})`);
    await c.as('Lusa').ok('feedback_add', { report_id: c.S.report, kind: 'plus_one' });
    const d = await c.as('Rafi').ok('feedback_read', { report_id: c.S.report });
    c.expect((d.report?.backers ?? d.backers ?? 3) >= 3, 'three backers');
  }, { rows: ['feedback'] }),

  s('2.18', 'The operator triages the report', async (c) => {
    await c.op.get('/api/feedback');
    await c.op.post(`/api/feedback/${c.S.report}/status`, { status: 'accepted', note: 'Reproduced on a two-line table cell.', guidance: 'Patch one line at a time until this is fixed.' });
  }, { rows: ['feedback'] }),

  s('2.18b', 'The operator assigns the report to Lusa; acknowledging the notice is not reading it; she finds it and reads it as hers', async (c) => {
    const d = await c.op.post(`/api/feedback/${c.S.report}/assign`, { agent_id: c.A('Lusa'), note: 'You hit it on the power budget table: check whether patching one line at a time is enough.' });
    c.eq(d.assignee?.agent_id, c.A('Lusa'), 'the report is assigned to Lusa');
    const L = c.as('Lusa');
    const seqs = ((await L.ok('session_whoami')).notices ?? []).map((n) => n.seq);
    if (seqs.length) await L.ok('session_ack', { notice_seq: Math.max(...seqs) });
    c.eq((await c.op.get(`/api/feedback/${c.S.report}`)).assignee?.read_at ?? null, null, 'a bulk session_ack does not mark it read: the console says "not read yet"');
    c.eq((await L.ok('session_whoami')).unread_assigned_feedback, 1, 'session_whoami counts one unread assigned report');
    const f = await L.ok('feedback_find', { assigned: 'me' });
    c.eq((f.reports ?? []).map((r) => r.id), [c.S.report], 'Lusa finds exactly her assigned report');
    c.eq(f.reports?.[0]?.assignment?.read, false, 'feedback_find marks it not read yet');
    const r = await L.ok('feedback_read', { report_id: c.S.report });
    c.expect(r.report?.assigned_to_you === true && !('tried' in (r.detail ?? {})), 'assigned to her, without the filer’s private account');
    c.expect(typeof (await c.op.get(`/api/feedback/${c.S.report}`)).assignee?.read_at === 'number', 'her feedback_read marks it read: the console says "read <time>"');
    c.eq(((await c.as('Rafi').ok('feedback_find', { assigned: 'me' })).reports ?? []).length, 0, 'nothing is assigned to Rafi');
  }, { rows: ['feedback'] }),

  s('2.19', 'Mirela offers Teodor a 200 KB extract of the echo-47 recording', async (c) => {
    const bin = readFileSync(join(c.hub.vaultDir, 'Assets', 'recordings', 'live-listen-03.bin')).subarray(0, 200 * 1024);
    c.S.extract = bin;
    const r = await c.as('Mirela').ok('channel_open', { to: `agent:${c.A('Teodor')}`, purpose: 'Echo-47 raw extract for the echo model', size: bin.length, sha256: sha(bin) });
    c.S.ch = r.channel_id ?? r.channel?.id;
  }, { rows: ['transfers'] }),

  s('2.20', 'Teodor sees the offer in his queue and accepts it', async (c) => {
    const T = c.as('Teodor');
    let offer = null;
    for (let i = 0; i < 15 && !offer; i++) {
      const w = await T.ok('work_next', { wait_seconds: 0 });
      if (!w.item) break;
      if (w.item.kind === 'channel_offer') offer = w.item;
      await T.ok('work_ack', { item_id: w.item.item_id });
    }
    c.expect(offer, 'the offer arrives through work_next');
    await T.ok('channel_list', {});
    await T.ok('channel_accept', { channel_id: c.S.ch });
  }, { rows: ['transfers'] }),

  s('2.21', 'Chunks flow with backpressure; the hash is verified', async (c) => {
    const M = c.as('Mirela'), T = c.as('Teodor'), buf = c.S.extract, size = 40 * 1024;
    const chunks = []; for (let o = 0; o < buf.length; o += size) chunks.push(buf.subarray(o, o + size));
    let waited = false, seq = 0;
    const got = [];
    while (seq < chunks.length) {
      const r = await M.ok('channel_send', { channel_id: c.S.ch, seq, data: chunks[seq].toString('base64'), final: seq === chunks.length - 1 });
      if (r.status === 'wait' || r.wait) { waited = true; const rc = await T.ok('channel_receive', { channel_id: c.S.ch, wait_seconds: 0 }); got.push(...(rc.chunks ?? [])); continue; }
      seq++;
    }
    let done = false;
    for (let i = 0; i < 20 && !done; i++) { const rc = await T.ok('channel_receive', { channel_id: c.S.ch, wait_seconds: 1 }); got.push(...(rc.chunks ?? [])); done = !!rc.final; if (rc.final) c.S.recvSha = rc.sha256; }
    c.expect(waited, 'the sender had to wait at least once');
    c.eq(String(c.S.recvSha).replace(/^sha256:/, ''), sha(buf), 'the verified sha256');
    const st = await T.ok('channel_status', { channel_id: c.S.ch });
    c.expect(/done/.test(JSON.stringify(st)), 'the channel is done');
  }, { beat: 2500, rows: ['transfers'] }),

  s('2.22', 'A second offer is closed by the receiver', async (c) => {
    const r = await c.as('Mirela').ok('channel_open', { to: `agent:${c.A('Teodor')}`, purpose: 'The rest of the recording', size: 1024, sha256: sha(Buffer.alloc(1024)) });
    const id = r.channel_id ?? r.channel?.id;
    await c.as('Teodor').ok('channel_close', { channel_id: id, reason: 'Not needed: I will download the whole file.' });
    const st = await c.as('Mirela').ok('channel_status', { channel_id: id });
    c.expect(/closed/.test(JSON.stringify(st)), 'Mirela sees it closed');
  }, { rows: ['transfers'] }),

  s('2.23', 'Teodor downloads the whole recording inline', async (c) => {
    const T = c.as('Teodor');
    const r = await T.ok('file_download', { path: `${V}/Assets/recordings/live-listen-03.bin` });
    const id = r.channel_id ?? r.channel?.id;
    c.expect(id, `file_download opens an inline channel (${JSON.stringify(r).slice(0, 160)})`);
    let fin = null;
    for (let i = 0; i < 40 && !fin; i++) { const rc = await T.ok('channel_receive', { channel_id: id, wait_seconds: 1 }); if (rc.final) fin = rc; }
    const whole = readFileSync(join(c.hub.vaultDir, 'Assets', 'recordings', 'live-listen-03.bin'));
    c.eq(String(fin?.sha256).replace(/^sha256:/, ''), sha(whole), 'the downloaded file matches');
  }, { rows: ['transfers'] }),

  s('2.24', 'Plans move; Orla reports to her stakeholders', async (c) => {
    await writePlan(c, 'int', 'Saoirse', { requirements: [{ key: 'R2', status: 'unclear', evidence: 'Echo model v2 drafted; echo 47 unexplained.' }] });
    await movePlans(c, 2); // every team's plan moves with Act 2 (plans.mjs)
    await c.as('Orla').ok('bp_report', { team_id: c.T('fp'), health: 'at_risk', done: ['Echo model v2 drafted at P 0.33 operating power'], next: ['Explain echo 47 with the Timekeepers'], blockers: ['Echo 47 is still off the curve'], refs: ['FR-SL-02'] });
  }),

  s('2.25', 'Saoirse works in the case blueprint; Wynn proposes, then withdraws', async (c) => {
    // The team plan lives in the project blueprint (docs/blueprint.md §5); the bp_* tools read and write it.
    const S = c.as('Saoirse'), W = c.as('Wynn'), team = c.T('int');
    const r = await S.ok('bp_read', { team_id: team, kinds: ['fr', 'milestone'] });
    c.expect(r.items.some((i) => i.key === 'FR-CC-02' && i.status === 'draft'), 'the Case Command part holds the plan (FR-CC-02, unclear, is a draft FR)');
    const w = await S.ok('bp_write', { team_id: team, version: r.project.version, reason: 'Echo 47 is open.', ops: [
      { op: 'upsert', kind: 'risk', key: 'RK-*', title: 'Echo 47 stays unexplained', team_id: team, fields: { likelihood: 'medium', impact: 'high', owner: 'Saoirse' } },
    ] });
    c.eq(w.status, 'applied', 'a risk in her own part applies at once');
    await S.no('bp_write', { team_id: team, version: w.version, ops: [{ op: 'upsert', kind: 'hypothesis', key: 'H1', title: 'x', parent_key: 'L1', team_id: team }] }, /invalid_argument.*A hypothesis key is H-<line>-nn, e\.g\. H-L1-02 \(or H-L1-\* for the next number\)/);
    const p = await W.ok('bp_write', { team_id: team, version: w.version, ops: [{ op: 'upsert', kind: 'issue', key: 'I*', title: 'Echo model v2 needs the raw extract', team_id: team }] });
    c.eq(p.status, 'proposed', 'a member\'s issue is a proposal for the operator');
    await W.no('bp_write', { team_id: team, version: w.version, ops: [{ op: 'upsert', kind: 'report', key: 'SR-*', title: 'x', team_id: team, fields: { health: 'on_track' } }] }, 'denied');
    const mine = await W.ok('bp_proposals', { team_id: team, status: 'open' });
    c.expect(mine.proposals.some((x) => x.id === p.proposal_id), 'Wynn sees his open proposal');
    await W.ok('bp_proposals', { withdraw: p.proposal_id });
    const rep = await S.ok('bp_report', { team_id: team, health: 'at_risk', done: ['FR-CC-02 unclear: echo model v2 drafted'], next: ['Explain echo 47 with the Timekeepers'], blockers: ['Echo 47 off the curve'], refs: ['R2'].map(bpKey) });
    c.expect(/^SR-\d{3}$/.test(rep.key), `the report is a blueprint item (${rep.key})`);
    await S.no('bp_report', { team_id: team, health: 'on_track', done: ['Nothing new'] }, 'rate_limited');
  }, { rows: ['blueprint'] }),

  s('2.26', 'The operator works in the blueprint: summary, proposals on Home, a paper and its outline, a report request', async (c) => {
    // The admin API of docs/blueprint.md §6. Every answer names its project.
    const op = c.op, S = c.as('Saoirse'), W = c.as('Wynn'), team = c.T('int');
    const list = await op.get('/api/projects?limit=100');
    const prj = list.projects.find((p) => p.teams.some((t) => t.id === team));
    c.expect(prj, 'Case Command\'s project is listed with its teams');
    const P = prj.id;
    const sum = await op.get(`/api/projects/${P}/summary?team=${team}`);
    c.eq(sum.health?.health, 'at_risk', 'the card shows the newest report\'s health');
    const risks = await op.get(`/api/projects/${P}/blueprint?team=${team}&kind=risk&detail=full`);
    const rk = risks.items.find((i) => i.title === 'Echo 47 stays unexplained');
    c.expect(rk, 'Saoirse\'s risk is in her part');
    const one = await op.get(`/api/projects/${P}/items/${rk.key}`);
    c.eq(one.project.id, P, 'an item names its project');
    await op.get(`/api/projects/${P}/items/${rk.key}/history?limit=5`);
    // Wynn proposes twice; Home lists both; the operator applies one and rejects the other.
    const v0 = (await S.ok('bp_read', { team_id: team, kinds: ['issue'] })).project.version;
    const a = await W.ok('bp_write', { team_id: team, version: v0, ops: [{ op: 'upsert', kind: 'issue', key: 'I*', title: 'Echo model v2 needs the raw extract', team_id: team }] });
    const b = await W.ok('bp_write', { team_id: team, version: v0, ops: [{ op: 'upsert', kind: 'issue', key: 'I*', title: 'Echo 47 needs a second look', team_id: team }] });
    const home = await op.get('/api/blueprint/attention');
    c.expect([a.proposal_id, b.proposal_id].every((id) => home.items.some((i) => i.kind === 'bp_proposal' && i.id === id)), 'Home lists both open proposals');
    const open = await op.get(`/api/projects/${P}/proposals?status=open`);
    c.expect(open.proposals.length >= 2, 'the Proposals tab lists them');
    c.eq((await op.post(`/api/proposals/${a.proposal_id}/apply`, { note: 'Yes, track it.' })).proposal.status, 'applied', 'the first is applied');
    c.eq((await op.post(`/api/proposals/${b.proposal_id}/reject`, { note: 'Same as the first.' })).proposal.status, 'rejected', 'the second is rejected');
    // The operator opens a paper on Case Command's line of work and frames one claim on FR-CC-02.
    const v1 = (await S.ok('bp_read', { team_id: team, kinds: ['fr'] })).project.version;
    const w = await op.post(`/api/projects/${P}/ops`, { version: v1, ops: [
      { op: 'upsert', kind: 'paper', key: 'PAP-*', title: 'An echo model for the dish', team_id: team, fields: { venue: 'Case review', type: 'report' }, body: 'What the echo model explains, and what echo 47 leaves open.' },
    ] });
    const pap = w.keys['PAP-*'];
    const w2 = await op.post(`/api/projects/${P}/ops`, { version: w.version, ops: [
      { op: 'upsert', kind: 'claim', key: `${pap}/C*`, parent_key: pap, title: 'Echo model v2 fits the calibration sweeps', fields: { part: 'results' } },
    ] });
    const claim = w2.keys[`${pap}/C*`];
    const w3 = await op.post(`/api/projects/${P}/ops`, { version: w2.version, ops: [{ op: 'link', from: 'FR-CC-02', to: claim, rel: 'evidence' }] });
    c.eq(w3.support_changed[0]?.now, 'weak', 'FR-CC-02 is still a draft, so the claim is weakly supported');
    const outline = await op.raw('GET', `/api/projects/${P}/export.md?paper=${pap}`);
    c.expect(outline.status === 200 && outline.json.raw.includes(`${claim} · weak`), 'the outline lists the claim and its support');
    const full = await op.raw('GET', `/api/projects/${P}/export.md`);
    c.expect(full.json.raw.includes('edit in the hub'), 'the export says where to edit');
    // A project of its own for the echo-model research, paused until it starts; the team keeps its part where it is.
    const fm = await op.post('/api/projects', { key: 'EMR', name: 'Echo model research', kind: 'research' });
    await op.patch(`/api/projects/${fm.project.id}`, { status: 'paused' });
    const track = (await S.ok('bp_read', { team_id: team, kinds: ['module', 'line'] })).items.filter((i) => i.team_id === team).map((i) => i.key);
    const own = await op.put(`/api/teams/${team}/project`, { project_id: P, owns: [...track, pap] });
    c.eq(own.moved_from, null, 'the team stays in its project');
    // The operator asks the project for a report; Saoirse escalates; Home shows it, Work in motion shows the request.
    await op.post(`/api/projects/${P}/report-request`, { note: 'Before the case review' });
    const asked = (await op.get(`/api/projects/${P}/summary`)).report_requests ?? [];
    c.expect(asked.some((r) => r.team.id === team && r.scope === 'project'), 'each running team of the project is asked for its own part');
    const rep = await S.ok('bp_report', { team_id: team, health: 'at_risk', done: [`${claim} framed`], next: ['Explain echo 47'], blockers: ['Echo 47 off the curve'], escalate: true, refs: ['R2'].map(bpKey) });
    c.expect(rep.requested, 'her report answers the request');
    const left = (await op.get(`/api/projects/${P}/summary`)).report_requests ?? [];
    c.expect(!left.some((r) => r.team.id === team) && left.length === asked.length - asked.filter((r) => r.team.id === team).length, 'it answers for her team only; the other teams still owe theirs');
    const home2 = await op.get('/api/blueprint/attention');
    c.expect(home2.items.some((i) => i.kind === 'bp_escalation' && i.team?.id === team), 'Home shows the escalation');
    const feed = await op.get('/api/work/recent?limit=50');
    c.expect(feed.events.some((e) => e.kind === 'plan' && e.plan.event === 'review_request' && e.project?.id === P), 'Work in motion shows the report request');
  }, { rows: ['blueprint-admin'] }),

  s('2.27', 'The operator tightens a blueprint limit in Settings, then resets it', async (c) => {
    const op = c.op, S = c.as('Saoirse'), team = c.T('int');
    const g = await op.get('/api/settings/blueprint');
    c.eq(g.limits.ops_per_write, 50, 'the default is 50 ops per write');
    await op.put('/api/settings/blueprint', { limits: { ops_per_write: 2 } });
    const v = (await S.ok('bp_read', { team_id: team, kinds: ['term'] })).project.version;
    await S.no('bp_write', { team_id: team, version: v, ops: [1, 2, 3].map((i) => ({ op: 'upsert', kind: 'risk', key: 'RK-*', title: `Limit check ${i}`, team_id: team })) }, 'invalid_argument');
    const r = await op.put('/api/settings/blueprint', { limits: { ops_per_write: null } });
    c.eq(r.limits.ops_per_write, 50, 'reset to the default');
    // Conflicts are per item (F-24): a write elsewhere since the version Saoirse read does not get in her way; a write on her item does.
    const mine = await S.ok('bp_write', { team_id: team, version: v, ops: [{ op: 'upsert', kind: 'risk', key: 'RK-*', title: 'Lead ratio misread', team_id: team }] });
    const rk = mine.keys['RK-*'], P = (await S.ok('bp_read', { team_id: team, keys: [rk] })).project.id;
    const op2 = await op.post(`/api/projects/${P}/ops`, { version: mine.version, ops: [{ op: 'upsert', kind: 'risk', key: rk, title: 'Lead ratio misread in the capture logs' }] });
    c.expect(op2.version > mine.version, 'the operator write moved the version');
    const late = await S.no('bp_write', { team_id: team, version: mine.version, ops: [{ op: 'upsert', kind: 'risk', key: rk, title: 'Lead ratio misread (mine)' }] }, 'conflict');
    c.expect(new RegExp(`${rk}.*current version ${op2.version}`).test(late.text), `the conflict names the item and the current version: ${late.text.slice(0, 160)}`);
    await S.ok('bp_write', { team_id: team, version: mine.version, ops: [{ op: 'upsert', kind: 'risk', key: 'RK-*', title: 'Capture logs lack the lead ratio', team_id: team }] });
  }, { rows: ['blueprint-admin'] }),

  s('2.28', 'Saoirse searches the blueprint with bp_read q; each item says who wrote it and how far to trust it', async (c) => {
    const S = c.as('Saoirse'), team = c.T('int');
    // bp_read (F-22, F-23): q finds words, and each item says who wrote it and how far to trust it.
    const found = await S.ok('bp_read', { team_id: team, scope: 'project', q: 'lead ratio' });
    c.expect(found.items.length > 0 && found.items.every((i) => i.updated_by && ['L0', 'L1', 'L2'].includes(i.trust)), 'bp_read q finds the risk, with updated_by and trust on each item');
  }, { rows: ['blueprint-admin'] }),

  s('2.29', 'The operator starts over Saoirse\'s part: she rewrites it and submits once; sent back, then cancelled to the snapshot', async (c) => {
    // Start over (docs/blueprint.md §4, §6): a re-plan of one team's part, ending in a cancel so the case is as it was.
    const op = c.op, S = c.as('Saoirse'), W = c.as('Wynn'), team = c.T('int');
    const P = (await S.ok('bp_read', { team_id: team })).project.id;
    const before = (await S.ok('bp_read', { team_id: team, kinds: ['fr', 'milestone'] })).items.filter((i) => i.team_id === team);
    const start = await op.post(`/api/projects/${P}/replan`, { team_id: team, kinds: ['fr', 'milestone'], note: 'Rebuild the requirements before the case review' });
    const R = start.replan.id;
    c.eq(start.reset.length, before.length, `the part's requirements and milestones are in the re-plan (${start.reset.length})`);
    c.eq(await op.refused('POST', `/api/projects/${P}/replan`, {}), 'invalid_state', 'a project-wide re-plan waits while a part has one open');
    const read = await S.ok('bp_read', { team_id: team, kinds: ['fr'] });
    c.expect(read.replan?.id === R && read.items.filter((i) => i.team_id === team).every((i) => i.status === 'draft' && i.replan === R), 'bp_read shows the re-plan and its marked items, back to draft');
    const fr = read.items.find((i) => i.team_id === team && i.kind === 'fr');
    const w = await S.ok('bp_write', { team_id: team, version: read.project.version, ops: [{ op: 'upsert', kind: 'fr', key: fr.key, title: `${fr.title} (rebuilt)` }] });
    c.eq(w.status, 'applied', 'the coordinator rewrites a marked item without a proposal');
    await W.no('bp_proposals', { team_id: team, action: 'submit_replan' }, 'denied');
    const sub = await S.ok('bp_proposals', { team_id: team, action: 'submit_replan', reason: 'One requirement rewritten' });
    c.eq(sub.diff.changed.includes(fr.key), true, 'the submission is a before/after diff');
    const list = await op.get(`/api/projects/${P}/replans`);
    c.expect(list.open[0]?.id === R && list.open[0].diff.changed.some((d) => d.key === fr.key && d.was.title === fr.title), 'the operator reads the before/after against the snapshot');
    const one = await op.get(`/api/replans/${R}`);
    c.eq(one.replan.proposal.id, sub.proposal_id, 'the re-plan names its pending submission');
    const snap = await op.raw('GET', `/api/replans/${R}/snapshot.md`);
    c.expect(snap.status === 200 && snap.json.raw.includes(fr.title), 'the snapshot downloads as the export it saved');
    await op.post(`/api/proposals/${sub.proposal_id}/reject`, { note: 'Keep the original wording' });
    c.eq((await op.get(`/api/replans/${R}`)).replan.status, 'open', 'sent back, the re-plan stays open');
    const filed = await op.post(`/api/replans/${R}/submit`, { note: 'Filed by the operator to compare' });
    c.eq(filed.proposal.type, 'replan', 'the operator can file the review itself');
    const cancel = await op.post(`/api/replans/${R}/cancel`, { note: 'Not before the review' });
    c.expect(cancel.restored.includes(fr.key), 'the cancel restores the rewritten item');
    const after = (await S.ok('bp_read', { team_id: team, kinds: ['fr', 'milestone'] })).items.filter((i) => i.team_id === team);
    c.expect(after.every((i) => { const b = before.find((x) => x.key === i.key); return b && b.status === i.status && b.title === i.title && !i.replan; }) && after.length === before.length, 'every item is back as it was');
  }, { rows: ['blueprint-admin'] }),
];
