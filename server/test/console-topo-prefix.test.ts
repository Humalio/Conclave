/**
 * Topology node names (dashboard-ux.md, Topology): when every agent shown carries the same name prefix up to " · ", " - "
 * or ": " (such as "BIRAZ · "), the node's name and initials leave it out; the tooltip, the focus panel and the connection
 * list keep the full label. sharedPrefix is loaded from public/app.js in vm.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const at = js.indexOf('const sharedPrefix = '), end = js.indexOf('\n};\n', at) + 3;
const ctx: { sharedPrefix?: (l: string[]) => string } = {};
vm.createContext(ctx);
vm.runInContext(js.slice(at, end) + '\nthis.sharedPrefix = sharedPrefix;', ctx);
const sp = ctx.sharedPrefix!;

describe('the shared name prefix', () => {
  it('is found up to each separator when every label has it', () => {
    expect(sp(['BIRAZ · Coordinator', 'BIRAZ · Developer 1', 'BIRAZ · Code Reviewer'])).toBe('BIRAZ · ');
    expect(sp(['Lab - Writer', 'Lab - Reader'])).toBe('Lab - ');
    expect(sp(['Ops: Watcher', 'Ops: Pager'])).toBe('Ops: ');
  });
  it('is not stripped when one label lacks it or has another one', () => {
    expect(sp(['BIRAZ · Coordinator', 'Conclave · Coordinator'])).toBe('');
    expect(sp(['BIRAZ · Coordinator', 'Scout'])).toBe('');
    expect(sp(['BIRAZ Coordinator', 'BIRAZ Developer'])).toBe('');
  });
  it('stops at the first separator, and never leaves a name empty', () => {
    expect(sp(['A · B · C', 'A · B · D'])).toBe('A · ');
    expect(sp(['BIRAZ · ', 'BIRAZ · Developer'])).toBe('');
  });
  it('needs at least two labels', () => {
    expect(sp(['BIRAZ · Coordinator'])).toBe('');
    expect(sp([])).toBe('');
  });
});

describe('the topology draws the short name and keeps the full one elsewhere', () => {
  const parts = js.slice(js.indexOf('function egoNodeParts('), js.indexOf('\n}\n', js.indexOf('function egoNodeParts(')));
  it('sets each agent node\'s name from the shared prefix', () => {
    expect(js).toMatch(/pre = sharedPrefix\(ag\.map\(\(n\) => n\.label\)\);\n\s*for \(const n of ag\) n\.name = n\.label\.slice\(pre\.length\);/);
  });
  it('uses the name for the label and initials, and the full label in the tooltip', () => {
    expect(parts).toContain('initials(n.name)');
    expect(parts).toContain('trunc(n.name, G.narrow ? 12 : 18)');
    expect(parts).toMatch(/const tip = `\$\{n\.label\}/);
  });
  it('the side panel and Most active avatars use the short name too, and their titles keep the full one', () => {
    const lead = js.split('\n').find((l) => l.includes('const lead = (x) => (x.kind === \'agent\''))!;
    expect(lead).toContain('initials(x.name ?? x.label)');
    const rank = js.split('\n').find((l) => l.includes('initials(EGO.G?.nodes.get(aid)?.name ?? agLabel(aid))'));
    expect(rank).toBeDefined();
    expect(rank).toContain('title: agLabel(aid)');
    expect(js).not.toMatch(/initials\(x\.label\)/);
  });
});
