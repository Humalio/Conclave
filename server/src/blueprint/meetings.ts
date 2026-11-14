/**
 * The note an item came from, and the Meetings view (docs/blueprint.md §2.7, §9). An item's `source` field that resolves
 * to a vault note names the meeting, review or demo it came from. Resolution is the Sources resolver's, per viewer, so a
 * note the viewer can't read answers `missing` and is left out here with its items: nothing is counted that the viewer
 * could not open.
 */
import { open } from 'node:fs/promises';
import type { Db } from '../db/db.js';
import type { Vault } from '../vault/vault.js';
import type { Sources, Source, Viewer } from './sources.js';
import { citedSources } from './plain.js';

export interface Note { path: string; title: string; date: string | null }
export interface MeetingItem { key: string; kind: string; title: string; status: string | null; team_id: string | null }
export interface Meeting extends Note { items: MeetingItem[] }

const DAY = /(\d{4}-\d{2}-\d{2})/;
const isNote = (p: string) => /\.md$/i.test(p);
/** The texts of an item's `source` field, split as citedSources splits it. */
export const sourceTexts = (fields: Record<string, unknown> | null): string[] =>
  typeof fields?.['source'] === 'string' ? citedSources({ body: null, fields: { source: fields['source'] } }) : [];

/** A real calendar day as YYYY-MM-DD, else null. */
function day(v: unknown): string | null {
  const m = String(v ?? '').match(DAY);
  if (!m) return null;
  const d = new Date(`${m[1]}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== m[1] ? null : m[1]!;
}

/** The frontmatter keys of a note, read from its first 8 KB only. */
async function frontmatter(real: string): Promise<Record<string, string>> {
  const fh = await open(real, 'r');
  try {
    const buf = Buffer.alloc(8192);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const text = buf.subarray(0, bytesRead).toString('utf8').replace(/^﻿/, '');
    const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/);
    const out: Record<string, string> = {};
    if (!m) return out;
    for (const line of m[1]!.split(/\r?\n/)) {
      const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
      if (kv) out[kv[1]!.toLowerCase()] = kv[2]!.trim().replace(/^["']|["']$/g, '');
    }
    return out;
  } finally { await fh.close(); }
}

export class Meetings {
  constructor(private readonly db: Db, private readonly vault: Vault, private readonly sources: Sources) {}

  /** A resolved note's title and date: frontmatter `title` and `date`, else from its file name. */
  async note(path: string): Promise<Note> {
    const rel = path.replace(/^\/+/, '').split('/').slice(1);
    const name = (rel.at(-1) ?? '').replace(/\.[A-Za-z0-9]{1,8}$/, '');
    let fm: Record<string, string> = {};
    try { fm = await frontmatter(await this.vault.resolve(rel)); } catch { /* unreadable: the name still gives title and date */ }
    const date = day(fm['date']) ?? day(name);
    const bare = name.replace(/^\d{4}-\d{2}-\d{2}[\s_-]*/, '').trim();
    return { path, title: (fm['title'] || bare || name).slice(0, 200), date };
  }

  /** The note an item came from, among its already resolved sources: the first `source` text that is a vault note. */
  async from(fields: Record<string, unknown> | null, resolved: Source[]): Promise<Note | null> {
    const texts = new Set(sourceTexts(fields));
    const hit = resolved.find((s) => texts.has(s.text) && s.where === 'vault' && s.path && isNote(s.path));
    return hit?.path ? this.note(hit.path) : null;
  }

  /** Every vault note that live items cite in `source`, for this viewer, newest first (undated last), each with its items. */
  async list(projectId: string, opts: { team?: string } = {}, viewer?: Viewer): Promise<Meeting[]> {
    const where = ['project_id=?', 'deleted_at IS NULL', 'archived=0', "kind<>'report'", "json_extract(fields, '$.source') IS NOT NULL"];
    const args: string[] = [projectId];
    if (opts.team === 'project') where.push('team_id IS NULL');
    else if (opts.team) { where.push('team_id=?'); args.push(opts.team); }
    const rows = this.db.prepare(`SELECT key, kind, title, status, team_id, fields FROM bp_items WHERE ${where.join(' AND ')} ORDER BY key`).all(...args) as unknown as
      (MeetingItem & { fields: string })[];
    const byPath = new Map<string, MeetingItem[]>();
    for (const r of rows) {
      let f: Record<string, unknown> | null = null;
      try { f = JSON.parse(r.fields); } catch { continue; }
      const texts = sourceTexts(f);
      if (!texts.length) continue;
      const seen = new Set<string>();
      for (const s of await this.sources.resolve(projectId, r.team_id, texts, viewer)) {
        if (s.where !== 'vault' || !s.path || !isNote(s.path) || seen.has(s.path)) continue;
        seen.add(s.path);
        const L = byPath.get(s.path) ?? [];
        L.push({ key: r.key, kind: r.kind, title: r.title, status: r.status, team_id: r.team_id });
        byPath.set(s.path, L);
      }
    }
    const out: Meeting[] = [];
    for (const [path, items] of byPath) out.push({ ...(await this.note(path)), items });
    return out.sort((a, b) => (a.date && b.date ? b.date.localeCompare(a.date) : a.date ? -1 : b.date ? 1 : 0) || a.title.localeCompare(b.title));
  }
}
