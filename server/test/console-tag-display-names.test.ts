/**
 * Operator console: a picked tag shows by its display name (Project settings, Tags) in the Backlog breadcrumb, a team's Tasks
 * header and breadcrumb, and the "nothing tagged" empty states; a tag no project list names stays "#tag".
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const view = (head: string) => { const i = js.indexOf(head); expect(i, head).toBeGreaterThan(-1); return js.slice(i, js.indexOf('\n};\n', i)); };

describe('console: tag display names outside the toolbar', () => {
  it('names the tag in the Backlog breadcrumb', () => {
    const v = view('VIEWS.backlog = async');
    expect(v).toContain("here: { label: 'Backlog', meta: [pp ? 'Postponed' : '', tname, pname, tagLabel, ");
    expect(v).not.toContain("tag ? '#' + tag : ''");
  });

  it('names the tag in the Tasks header, breadcrumb and empty state', () => {
    const v = view('VIEWS.tasks = async');
    expect(v).toContain('<span class="tmeta">${tg ? `${esc(tgName(tg))} · ` : \'\'}');
    expect(v).toContain("here: { label: 'Tasks', meta: `${tg ? tgName(tg) + ' · ' : ''}");
    expect(v).toContain('`No task tagged ${esc(tgName(tg))}`');
    expect(v).not.toMatch(/#\$\{esc\(tg\)\}|'#' \+ tg \+/);
  });

  it('names the tag in Home\'s empty card', () => {
    expect(js).toContain("none('note', `Nothing tagged ${esc((S.bl?.tags || []).find((g) => g.tag === tag)?.name || '#' + tag)}`, false,");
  });
});
