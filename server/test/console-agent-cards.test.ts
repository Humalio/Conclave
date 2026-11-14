/**
 * Agent page card order as data (console-systems NAVAGENTS-4, §4.5 F, D-31; SPEC-AGENT-01 and 02): the overview of
 * `#ses/<agent>|overview` is built from AG_CARDS. Desktop: column 1 Role, Team playbooks, Directives; column 2 Tell the
 * agent, Inbox, then Status. Below 1180 px one column in `narrow` order (Status, Tell the agent, Inbox, Role, Team
 * playbooks, Directives), drawn in that DOM order so Tab and screen readers follow it. The Inbox lists the hub's
 * notices with sender, subject, time and acknowledgement state; a long playbook folds under an accessible button.
 * Static checks on the console source, like console-tell.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const css = readFileSync(join(process.cwd(), 'public', 'style.css'), 'utf8').replace(/\r\n/g, '\n');
/** The source from `start` to the first `end` after it. */
const block = (src: string, start: string, end: string) => {
  const i = src.indexOf(start);
  expect(i, start).toBeGreaterThanOrEqual(0);
  const j = src.indexOf(end, i + start.length);
  expect(j, end).toBeGreaterThan(i);
  return src.slice(i, j);
};
const overview = () => block(js, '    overview: () => {', '\n    keys: () => ({');
const sesView = () => block(js, 'VIEWS.ses = async (arg) => {', '\nconst SETUP = {};');
/** The AG_CARDS entries in declaration order. */
const cards = () => [...block(overview(), 'const AG_CARDS = [', '\n      ];').matchAll(/\{ key: '(\w+)', col: (\d), narrow: (\d+), html: /g)]
  .map(([, key, col, narrow]) => ({ key, col: Number(col), narrow: Number(narrow) }));

/** Evaluate the module-level agLay helper with a stub card list, to check the DOM order it draws. */
const agLay = (() => {
  const src = block(js, 'const agLay = ', '\nfunction agRelayout()');
  // eslint-disable-next-line no-new-func
  return new Function('AG_NARROW', `const agLay = ${src.slice('const agLay = '.length)}; return agLay;`)({ matches: false }) as (c: unknown[], n?: boolean) => string;
})();

describe('Agent page cards', () => {
  it('AG_CARDS declares the desktop columns: Role, Team playbooks, Directives; Tell the agent, Inbox, Status', () => {
    const c = cards();
    expect(c.filter((x) => x.col === 1).map((x) => x.key)).toEqual(['role', 'playbooks', 'directives']);
    expect(c.filter((x) => x.col === 2).map((x) => x.key)).toEqual(['tell', 'inbox', 'status']);
    expect(c).toHaveLength(6);
  });

  it('the single-column order is Status, Tell the agent, Inbox, Role, Team playbooks, Directives', () => {
    const c = cards();
    expect([...c].sort((a, b) => a.narrow - b.narrow).map((x) => x.key)).toEqual(['status', 'tell', 'inbox', 'role', 'playbooks', 'directives']);
    expect(new Set(c.map((x) => x.narrow)).size).toBe(c.length);
  });

  it('the overview renders only through agLay, each card once', () => {
    const o = overview();
    expect(o).toContain('b: agLay(AG_CARDS),');
    // No hand-ordered template and no per-card order class.
    expect(o).not.toContain('class="ag-col"');
    expect(o).not.toContain('ag-n');
  });

  it('agLay draws the DOM in the order shown: columns on desktop, the narrow sequence below 1180 px', () => {
    const stub = cards().map((c) => ({ ...c, html: (attrs: string) => `<section ${attrs}></section>` }));
    const order = (h: string) => [...h.matchAll(/data-agc="(\w+)"/g)].map((m) => m[1]);
    const wide = agLay(stub, false), narrow = agLay(stub, true);
    expect(order(wide)).toEqual(['role', 'playbooks', 'directives', 'tell', 'inbox', 'status']);
    expect(wide.split('class="ag-col"').length - 1).toBe(2);
    expect(order(narrow)).toEqual(['status', 'tell', 'inbox', 'role', 'playbooks', 'directives']);
    expect(narrow).toContain('class="ag-cols is-one"');
    expect(narrow).not.toContain('class="ag-col"');
    // Each card carries what agRelayout needs to move it back.
    expect(narrow).toContain('data-agc="inbox" data-i="4" data-col="2" data-narrow="3"');
  });

  it('crossing 1180 px moves the cards and keeps focus; nothing reorders with CSS order', () => {
    expect(js).toContain("const AG_NARROW = matchMedia('(max-width:1179.98px)');");
    expect(js).toContain("AG_NARROW.addEventListener('change', agRelayout);");
    const r = block(js, 'function agRelayout()', '\nAG_NARROW.addEventListener');
    expect(r).toContain("by('narrow')");
    expect(r).toContain("by('i')");
    expect(r).toContain('focus.focus({ preventScroll: true })');
    expect(css).toContain('.ag-cols.is-one{display:flex;flex-direction:column;align-items:stretch}');
    expect(css).not.toMatch(/\.ag-n\d\{order:/);
    expect(css).not.toContain('.ag-col{display:contents}');
  });

  it('Status is a normal card with a header; no kvc status card remains', () => {
    const o = overview();
    expect(o).toMatch(/const status = card\('pulse', 'Status', `<div class="ag-kvs">/);
    expect(o).toContain("<div class=\"ag-kvs\">${kv('State', ");
    expect(o).toContain("{ key: 'status', col: 2, narrow: 1, html: status }");
    expect(o).not.toContain('kvc');
    expect(js).not.toMatch(/class="agc kvc"/);
    expect(css).not.toMatch(/\.agc\.kvc/);
  });
});

describe('Agent page Inbox (SPEC-AGENT-01)', () => {
  it('Tell the agent stays the compose action and lists no notices of its own', () => {
    const tell = block(overview(), "{ key: 'tell',", "\n        { key: 'inbox',");
    expect(tell).toContain("tellFormH(a, { id: 'agTell' })");
    expect(tell).not.toContain('noteRow');
    expect(tell).not.toContain('From the hub');
    expect(sesView()).toContain("bindTell($('#agTell'), id,");
  });

  it('the Inbox shows every notice with sender, subject, time and acknowledgement state', () => {
    const o = overview();
    const inbox = block(o, "{ key: 'inbox',", "\n        { key: 'status',");
    expect(inbox).toContain("card('note', 'Inbox'");
    expect(inbox).toContain('d.notices.map(noteRow)');
    expect(inbox).toContain('No notices yet.');
    const nr = block(o, 'const noteRow = ', '\n      const inPending');
    // Sender, with a screen-reader "From": the admin who sent a Message or Directive (You for the viewer, Operator when
    // the hub did not record who), Hub for the rest.
    expect(nr).toContain('<span class="tag txt nt-from"><span class="sr">From </span>${esc(ntFrom(n))}</span>');
    expect(o).toContain("const ntFrom = (n) => (n.kind !== 'directive' && n.kind !== 'message' ? 'Hub' : !n.sent_by ? 'Operator' : n.sent_by.id === d.viewer_id ? 'You' : n.sent_by.name || 'Operator');");
    // One shared screen-reader class, not a copy per component.
    expect(css).toContain('\n.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}');
    expect(css).not.toContain('.nt-sr');
    // Subject: the notice kind's label, with a readable fallback for kinds without one.
    expect(nr).toContain("NK[n.kind] || [cap(n.kind.replace(/_/g, ' ')), 'note']");
    // Time: elapsed in the list, the full date in the title, machine-readable datetime.
    expect(nr).toMatch(/<time class="nt-t" datetime="\$\{new Date\(n\.created_at\)\.toISOString\(\)\}" title="\$\{esc\(dt\(n\.created_at\)\)\}">/);
    // The text is escaped.
    expect(nr).toContain('<div class="nt-b">${esc(n.body)}</div>');
    // State: No longer needed when settled before delivery, checked first, so confirming a later notice does not turn it
    // into Confirmed; else Confirmed up to the agent's acknowledged seq, else Delivered once shown inline, else Pending.
    expect(o).toContain("const ntState = (n) => (n.current === 0 ? ['No longer needed', 'idle', 'off'] : n.seq <= acked ? ['Confirmed', 'ok', 'check'] : n.delivered_at ? ['Delivered', '', 'eye'] : ['Pending', '', 'clock']);");
    // Delivered but not yet confirmed still counts as pending in the header.
    expect(o).toContain("const inPending = d.notices.filter((n) => ['Pending', 'Delivered'].includes(ntState(n)[0])).length;");
  });

  it('a long Inbox shows six notices and a Show all button with aria-expanded', () => {
    const o = overview();
    expect(o).toContain('const IN_N = 6;');
    expect(o).toContain("i >= IN_N ? ' nt-more' : ''");
    expect(o).toContain('data-inbox-all aria-expanded="false" aria-controls="agInbox">Show all ${d.notices.length}</button>');
    expect(css).toContain('.nts:not(.all)>.nt-more{display:none}');
    const h = block(sesView(), "on('[data-inbox-all]'", '\n');
    expect(h).toContain("b.setAttribute('aria-expanded', String(all))");
  });

  it('opening the page sends no acknowledgement: the agent page makes no notice-confirming call', () => {
    const v = sesView();
    expect(v).not.toMatch(/session_ack|\/ack\b|notices\/ack|acked_seq['"]?\s*:/);
    // The only notice write on the page is Tell the agent's send (bindTell), not part of rendering or opening a card.
    expect(v).not.toContain("'/notices'");
  });
});

describe('Agent page team playbooks (SPEC-AGENT-02)', () => {
  it('a long playbook folds under a real button with aria-expanded and aria-controls', () => {
    const pb = block(overview(), "{ key: 'playbooks',", "\n        { key: 'directives',");
    expect(pb).toContain('<article class="md task-md clamp" id="agPb${i}">${mdDoc(p.playbook)}</article>');
    expect(pb).toContain('<button type="button" class="btn ghost sm" data-clamp aria-expanded="false" aria-controls="agPb${i}">Show the full playbook</button>');
  });

  it('a short playbook shows in full with no control; expanding shows the whole text', () => {
    const h = block(sesView(), "$$('[data-clamp]').forEach((b) => {", '\n      });');
    expect(h).toContain("const m = $('#' + b.getAttribute('aria-controls'));");
    expect(h).toContain("if (m.scrollHeight <= m.clientHeight + 1) { b.hidden = true; m.classList.add('open'); return; }");
    expect(h).toContain("b.setAttribute('aria-expanded', String(open)); b.textContent = open ? 'Show less' : 'Show the full playbook';");
    // The folded height is about ten lines, and an open playbook has no height limit at all.
    expect(css).toContain('.pbk .md.clamp:not(.open){max-height:calc(var(--s5) * 10)}');
    expect(css).toContain('.md.clamp.open{max-height:none}');
    expect(css).toContain('.md.clamp.open::after{display:none}');
  });
});
