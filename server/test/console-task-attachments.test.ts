/**
 * Task attachments in the console (docs/dashboard-ux.md, task screen "Attachments"; design-guidelines "Mockups in the
 * locked frame"). The helpers are loaded from public/app.js in vm and their markup checked: thumbnails open the viewer,
 * before/after files pair, a mockup opens only as as=mockup in a sandboxed frame, SVG and other files are downloads,
 * older rounds fold, and a member's screens show the count and never a file. The routes are task-attachments-console.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const css = readFileSync(join(process.cwd(), 'public', 'style.css'), 'utf8').replace(/\r\n/g, '\n');
const html = readFileSync(join(process.cwd(), 'public', 'index.html'), 'utf8');
const slice = (from: string, to: string) => { const a = js.indexOf(from), b = js.indexOf(to, a); if (a < 0 || b < 0) throw new Error('missing ' + from); return js.slice(a, b); };
const line = (start: string) => slice(start, '\n');

const ctx: Record<string, any> = {};
vm.createContext(ctx);
vm.runInContext(
  [line('const esc = '), line('const plural = '), line('const MON = '), line('const dt = '), "const ic = (n) => `<svg class=\"i\"><use href=\"#i-${n}\"/></svg>`;",
    slice('const TA_IMG = ', 'VIEWS.task = async'), 'this.lib = { taFilesH, taBriefH, taRoundH, taRounds, taClip, taSize, taUrl, get G() { return TA_G; } };'].join('\n'),
  ctx,
);
const L = ctx.lib;
const f = (path: string, type: string, size = 2048) => ({ path, type, size });
const at = Date.UTC(2026, 10, 19, 13, 2);
const brief = { version: 2, created_at: at, added_by_label: 'Coordinator', total_bytes: 1468006, copied_from: null, removed_at: null,
  files: [f('sheet-1440-light.png', 'image/png', 421888), f('sheet-error-390-dark.png', 'image/png', 192512), f('rename-sheet.html', 'text/html', 47104)] };

describe('the brief', () => {
  it('heads the set with who added it, the version, when, and the size', () => {
    const h = L.taBriefH({ id: 'task_1', attachments: { brief, rounds: [] } }, true);
    expect(h).toContain('<b>Attachments · from the brief</b>');
    expect(h).toMatch(/Coordinator · v2 · 19 Nov \d\d:02 · 3 files, 1\.4 MB/);
    expect(h).toContain('id="taAttach"');
    expect(h).toContain('accept="image/png,image/jpeg,image/gif,image/webp,text/html,.html"');
    expect(L.taBriefH({ id: 'task_1', attachments: { brief, rounds: [] } }, false)).not.toContain('taAttach');
  });
  it('shows images as thumbnails that open the viewer, from the byte route', () => {
    const h = L.taFilesH('task_1', 'brief', brief);
    expect(h.match(/class="ta-th"/g)).toHaveLength(2);
    expect(h).toContain(`src="${L.taUrl('task_1', 'brief', 2, 'sheet-1440-light.png').replace(/&/g, '&amp;')}"`);
    expect(L.taUrl('task 1', 'brief', 2, 'a b/c.png')).toBe('/api/tasks/task%201/attachments/brief/file?path=a%20b%2Fc.png&v=2');
    expect(h).toContain('<em>· 412 KB</em>');
    const gi = L.G.length - 1;
    expect(h).toContain(`data-ta-view="${gi}|1"`);
    expect(L.G[gi].map((x: { name: string }) => x.name)).toEqual(['sheet-1440-light.png', 'sheet-error-390-dark.png']);
  });
  it('shows a mockup as a card whose preview and new tab ask for as=mockup, and downloads the plain URL', () => {
    const h = L.taFilesH('task_1', 'brief', brief);
    expect(h).toContain('<small>Mockup · 46 KB · shown without scripts</small>');
    const mock = L.taUrl('task_1', 'brief', 2, 'rename-sheet.html', 'mockup');
    expect(mock).toMatch(/&as=mockup$/);
    expect(h).toContain(`data-ta-frame="${mock.replace(/&/g, '&amp;')}"`);
    expect(h).toMatch(/<a class="btn sm" href="[^"]*as=mockup" target="_blank" rel="noopener">/);
    expect(h).toContain(`href="${L.taUrl('task_1', 'brief', 2, 'rename-sheet.html').replace(/&/g, '&amp;')}" download="rename-sheet.html"`);
    // No mockup is ever drawn inline: it is not an <img>, and the page holds no frame until Preview.
    expect(h).not.toMatch(/<iframe|<img[^>]*rename-sheet/);
  });
  it('opens the locked frame sandboxed, with no scripts and no referrer, 260 px high', () => {
    const fr = slice('function taFrame(', '\nconst taB64');
    expect(fr).toContain('<iframe sandbox=""');
    expect(fr).toContain('referrerpolicy="no-referrer" loading="lazy"');
    expect(fr).toContain('locked preview: no scripts, no network');
    expect(fr).not.toMatch(/allow-/);
    expect(css).toContain('.ta-frame iframe{display:block;width:100%;height:260px;');
    expect(js.match(/<iframe/g)).toHaveLength(1);
  });
  it('lists other files, SVG included, as downloads with why they are not shown', () => {
    const h = L.taFilesH('t', 'brief', { ...brief, files: [f('test-output.txt', 'text/plain', 12288), f('diagram.svg', 'text/plain', 900)] });
    expect(h).toContain('<small>12 KB · not shown inline</small>');
    expect(h).toContain('<small>900 B · SVG is download only</small>');
    expect(h.match(/download="/g)).toHaveLength(2);
    expect(h).not.toContain('<img');
  });
  it('says when a set was removed or copied', () => {
    const gone = L.taBriefH({ id: 't', attachments: { brief: { ...brief, files: [], removed_at: at }, rounds: [] } }, true);
    expect(gone).toContain('Removed by the administrator on 19 Nov.');
    expect(gone).not.toContain('taAttach');
    const copied = L.taBriefH({ id: 't', attachments: { brief: { ...brief, copied_from: { name: 'rename screenshots', version: 3 } }, rounds: [] } }, false);
    expect(copied).toContain('Copied from the share "rename screenshots", version 3. That share and who can read it are unchanged.');
  });
  it('offers Attach on an empty brief for the operator only', () => {
    expect(L.taBriefH({ id: 't', attachments: { brief: null, rounds: [] } }, true)).toContain('PNG, JPEG, GIF, WebP or HTML, 1 MB at a time.');
    expect(L.taBriefH({ id: 't', attachments: { brief: null, rounds: [] } }, false)).toBe('');
  });

  it('wraps the hint on a phone, since .meta alone stays on one line', () => {
    expect(L.taBriefH({ id: 't', attachments: { brief: null, rounds: [] } }, true)).toContain('<span class="ta-ht"><b>Attachments</b><span class="meta">');
    expect(css).toMatch(/^\.meta\{[^}]*white-space:nowrap/m);
    expect(css).toMatch(/^\.ta-ht \.meta\{[^}]*white-space:normal/m);
  });
});

describe('review rounds', () => {
  const r2 = { version: 2, created_at: at, added_by_label: 'Developer 2', total_bytes: 900000, copied_from: null, removed_at: null,
    files: [f('after-settings-1440.png', 'image/png'), f('before-settings-1440.png', 'image/png'), f('error-390-dark.png', 'image/png'), f('room-renamed.png', 'image/png')] };
  it('pairs before- and after- files, labelled, and strips the rest', () => {
    const h = L.taRoundH({ id: 't' }, r2, true);
    expect(h).toContain('<div class="ta-rh">4 screenshots · 879 KB</div>');
    const pair = h.slice(h.indexOf('<div class="ta-pair">'), h.indexOf('<div class="ta-strip">'));
    expect(pair.indexOf('Before')).toBeLessThan(pair.indexOf('After'));
    expect(pair).toContain('before-settings-1440.png');
    expect(pair).toContain('after-settings-1440.png');
    const strip = h.slice(h.indexOf('<div class="ta-strip">'));
    expect(strip).toContain('error-390-dark.png');
    expect(strip).not.toContain('settings-1440');
  });
  it('folds an older round to a line, and leaves an unpaired before- in the strip', () => {
    const h = L.taRoundH({ id: 't' }, { ...r2, files: [f('before-x.png', 'image/png'), f('notes.txt', 'text/plain')] }, false);
    expect(h).toMatch(/^<details class="ta-fold"><summary><span>2 files · 879 KB<\/span><span class="ta-show">Show<\/span><\/summary>/);
    expect(h).not.toContain('ta-pair');
    expect(L.taRoundH({ id: 't' }, { ...r2, removed_at: at }, true)).toBe('<p class="ta-gone">Removed by the administrator on 19 Nov.</p>');
  });
  it('gives each submission version to the round handed in with it', () => {
    const rounds = [{ at: 1000 }, { at: 50_000 }, { at: 90_000 }];
    const m = L.taRounds(rounds, [{ version: 1, created_at: 999 }, { version: 2, created_at: 89_990 }]);
    expect([...m.keys()]).toEqual([0, 2]);
    expect(m.get(2).version).toBe(2);
  });
  it('is wired into the task screen: beside the summary, the newest round open', () => {
    const v = slice('VIEWS.task = async', '\nVIEWS.tstatus');
    expect(v).toContain('TA_G = [];');
    expect(v).toContain('taRounds(rounds, k.attachments?.rounds)');
    expect(v).toContain('taRoundH(k, av, r === lastR)');
    expect(v).toContain('<div class="ta-rb"><div class="ta-rs">${body}</div>${att}</div>');
    expect(v).toContain('${inShort}${taBrief}<section');
    expect(css).toContain('@media (min-width:1180px){.ta-rb{grid-template-columns:minmax(0,1fr) minmax(0,1fr);');
    // A cancelled or discarded task no longer offers its old "Attached share · Open" row.
    expect(v).toContain("const share = k.share_id && !['cancelled', 'discarded'].includes(k.status) ? kv('Attached share'");
  });
});

describe('the viewer and Attach', () => {
  it('steps with Previous, Next and the arrow keys, downloads, and shows the pixel size', () => {
    const v = slice('function taViewer(', '\n/* Preview opens');
    for (const s of ['id="taPrev">Previous', 'id="taNext">Next', 'id="taDl"', 'data-sheet-close>Close', "e.key === 'ArrowLeft'", 'img.naturalWidth} × ${img.naturalHeight}', 'd.download = f.name']) expect(v).toContain(s);
    expect(css).toContain('.sheet.ta-view{width:min(960px,');
  });
  it('sends at most 1 MB a time with the task\'s version, and only the operator gets it', () => {
    const u = slice('async function taUpload(', '\nVIEWS.task');
    expect(u).toContain('if (total > TA_INLINE) throw new Error(');
    expect(u).toContain("{ files, version: k.version }");
    expect(js).toContain('const TA_INLINE = 1048576;');
    expect(slice('VIEWS.task = async', '\nVIEWS.tstatus')).toContain("const canAttach = !!k.attachments && S.me?.role === 'admin' && !['done', 'cancelled', 'discarded'].includes(k.status);");
  });
});

describe('the count elsewhere', () => {
  it('draws a paperclip and the count on a board card, nothing at zero', () => {
    expect(L.taClip(0)).toBe('');
    const c = L.taClip(7);
    expect(c).toContain('href="#i-clip"');
    expect(c).toContain('<span aria-hidden="true">7</span><span class="sr">7 attachments</span>');
    expect(L.taClip(7, true)).toContain('<span>7 attachments</span>');
    expect(html).toContain('<symbol id="i-clip"');
    expect(slice('function taskCard(', '\nfunction boardHtml')).toContain('${taClip(k.attachments)}');
    expect(slice('function taskRow(', '\nconst memberRow')).toContain('taClip(k.attachments)');
  });
  it('shows a member the count with who sees the files, never a thumbnail or a link', () => {
    const card = slice('function muBoardCard(', '\n/* One team');
    expect(card).toContain('${taClip(k.attachments)}');
    // The phone board's rows and the project's Ongoing and Done lists carry it too.
    expect(slice('function muBoardCard(', '\nconst muBoardCardHtml')).toContain("trail: taClip(k.attachments), chev: true, attrs: { 'data-mu-task': k.id }");
    expect(js).toContain(".filter(Boolean).join(' · '), trail: taClip(k.attachments) });");
    const sheet = slice('async function muTask(', '\nconst MU_PAGES');
    expect(sheet).toContain('${taClip(k.attachments, true)}<span class="meta">Attachments are visible to the team and the operator only.</span>');
    // The member shell never builds a byte-route URL or a thumbnail.
    const mu = slice('const MU_CAP = 8;', '\nconst MU_PAGES');
    expect(mu).not.toMatch(/taUrl|taFilesH|data-ta-view|attachments\//);
  });
});
