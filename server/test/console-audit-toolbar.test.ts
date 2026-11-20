/**
 * Operator console, Auditing (docs/dashboard-ux.md, Auditing workspace): Audit, Calls, Files and Alerts share one toolbar
 * row (the search box with the active filters as chips, the tab's segment, Filters). The search is out of the Filters
 * sheet, and the filters change the list in place.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const line = (head: string) => { const i = js.indexOf(head); expect(i, head).toBeGreaterThan(-1); return js.slice(i, js.indexOf('\n', i)); };
const fn = (head: string) => { const i = js.indexOf(head); expect(i, head).toBeGreaterThan(-1); return js.slice(i, js.indexOf('\n}\n', i) + 2); };
const tab = (head: string) => { const i = js.indexOf(head); expect(i, head).toBeGreaterThan(-1); return js.slice(i, js.indexOf('\n}\n', i)); };

describe('console: Auditing toolbar', () => {
  it('builds one row: the search box with the chips, the segment, then Filters with the chip count', () => {
    const t = line('const auTools = ');
    expect(t).toContain('<div class="ltb">${chipSearch({ attrs: `id="${id}"`, label, value: F.q, chips, clear: \'data-au-clr\', more: `data-cs-filt="${more}"` })}${seg}${filterBtn(more, chips.length)}</div>');
    const chip = new Function(`${line('const auChip = ')}\nreturn auChip('sev', 'Critical', 'severity');`)();
    expect(chip).toEqual({ label: 'Critical', name: 'Remove the severity filter Critical', attrs: 'data-au-rm="sev"' });
  });

  it('wires the box in place: live search, chip removal, the ✕ clears every chip and the text', () => {
    const b = fn('function auBind(');
    expect(b).toContain('csrchSet(form, ch, `data-cs-filt="${more}"`); setFilterCount(more, ch.length); draw();');
    expect(b).toContain("form.onsubmit = (e) => { e.preventDefault(); set(q.value.trim().toLowerCase()); };");
    expect(b).toContain("if (rm) { F[rm.dataset.auRm] = ''; redraw(); q.focus(); } else if (e.target.closest('[data-au-clr]')) { clear(); q.value = ''; set(''); q.focus(); }");
  });

  it('uses the toolbar on all four tabs and takes the search out of every Filters sheet', () => {
    const tabs: [string, string, string][] = [['function auditAlerts(', 'alQ', 'alMore'], ['function auditCalls(', 'clQ', 'clMore'], ['function auditFiles(', 'fwQ', 'fwMore'], ['function auditEvents(', 'auQ', 'auMore']];
    for (const [h, q, more] of tabs) {
      const t = tab(h);
      expect(t, h).toContain(`auTools('${q}', `);
      expect(t, h).toContain(`auBind('${q}', '${more}', `);
      expect(t, h).not.toMatch(/vtools\(|type="search"|<span class="vlabel">Search<\/span>/);
      expect(t, h).toContain('>Clear filters</button>');
    }
  });

  it('keeps the segment and Filters on one line under the box on a phone', () => {
    const css = readFileSync(join(process.cwd(), 'public', 'style.css'), 'utf8');
    expect(css).toContain('#workspaceView:is([data-area=vault],[data-area=log]) .ltb>.seg{flex:1 1 0;min-width:0}');
    expect(css).toContain('#workspaceView:is([data-area=vault],[data-area=log]) .ltb>.btn{flex:none}');
  });

  it('shows each tab\'s filters as chips, never a default', () => {
    const al = new Function(`${line('const AL_SEV = ')}\nconst AL_F = { status: 'open', sev: '', q: 'x' };\n${line('const auChip = ')}\n${line('const alChips = ')}\nconst a = alChips(); AL_F.status = ''; AL_F.sev = 'critical'; return [a, alChips()];`)();
    expect(al[0]).toEqual([]);
    expect(al[1].map((c: { attrs: string }) => c.attrs)).toEqual(['data-au-rm="status"', 'data-au-rm="sev"']);
    expect(al[1][0].label).toBe('All states');
    const calls = tab('function auditCalls(');
    expect(calls).toContain("const chips = () => [F.who && auChip('who', whoLabel(F.who), 'agent or key'), F.tool && auChip('tool', F.tool, 'tool')].filter(Boolean);");
    expect(calls).toContain("selField('clT', 'Tool', [['', 'Any tool'], ...tools.map((t) => [t, t])], F.tool)");
    expect(calls).toContain('&& (!F.tool || i.tool === F.tool)');
    const files = tab('function auditFiles(');
    expect(files).toContain("F.op && !['update|patch', 'delete'].includes(F.op) && auChip('op'");
    const ev = tab('function auditEvents(');
    expect(ev).toContain("F.from && auChip('from', 'From ' + F.from, 'date'), F.to && auChip('to', 'To ' + F.to, 'date')");
  });
});

describe('console: Vault Activity toolbar', () => {
  it('uses the same row, with a kind the segment does not offer as a chip', () => {
    const t = fn('function vaultTimeline(');
    expect(t).toContain("const tools = auTools('vaQ', 'Search activity', VA_F, vaChips(), ");
    expect(t).toContain("</div>`, 'vaFilt');");
    const ch = new Function(`${line('const VA_KINDS = ')}\nconst VA_F = { kind: '', q: 'x' };\n${line('const auChip = ')}\n${line('const vaChips = ')}\nconst r = [vaChips()]; VA_F.kind = 'read'; r.push(vaChips()); VA_F.kind = 'denied'; r.push(vaChips()); return r;`)();
    expect(ch[0]).toEqual([]);
    expect(ch[1]).toEqual([]);
    expect(ch[2]).toEqual([{ label: 'Denied', name: 'Remove the kind filter Denied', attrs: 'data-au-rm="kind"' }]);
  });

  it('takes the search out of Filters and gives the Filters button its own id (vaMore is the file menu)', () => {
    const sh = fn('function openVaultFilters(');
    expect(sh).not.toMatch(/type="search"|id="vaQ"/);
    expect(sh).toContain("$('#vaClear', sh).onclick = () => { VA_F.kind = ''; $('#vaKind', sh).value = ''; redraw(); };");
    expect(js).toContain("const redraw = auBind('vaQ', 'vaFilt', VA_F, vaChips, vaultTimelineFilter, () => { if (vaChips().length) VA_F.kind = ''; });");
    expect(js).toContain("$('#vaFilt').onclick = (e) => openVaultFilters(e.currentTarget, redraw);");
    expect(js.match(/id="vaMore"/g)).toHaveLength(1);
  });
});
