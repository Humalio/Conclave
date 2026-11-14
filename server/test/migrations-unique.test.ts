/**
 * The migration runner keys each file on its 4-digit prefix (Number(f.slice(0, 4))) and schema_migrations.version is a
 * primary key, so two files with the same prefix would stop the hub from starting. Migration numbers are fixed per
 * task (docs/proposals/console-systems.md, D-32); this test catches a collision before it reaches a hub.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'db', 'migrations');

/** Prefixes that more than one migration file uses, with the files. Same filter as the runner (db.ts migrate). */
export function duplicatePrefixes(files: readonly string[]): Record<string, string[]> {
  const by = new Map<number, string[]>();
  for (const f of files.filter((x) => /^\d{4}_.+\.sql$/.test(x))) {
    const v = Number(f.slice(0, 4));
    by.set(v, [...(by.get(v) ?? []), f]);
  }
  return Object.fromEntries([...by].filter(([, l]) => l.length > 1).map(([v, l]) => [String(v).padStart(4, '0'), l.sort()]));
}

describe('migration file numbers', () => {
  it('no two migration files share a 4-digit prefix', () => {
    expect(duplicatePrefixes(readdirSync(MIGRATIONS))).toEqual({});
  });

  it('the check finds a duplicate prefix', () => {
    expect(duplicatePrefixes(['0105_a.sql', '0106_b.sql', '0106_c.sql', '0107_d.sql', 'README.md'])).toEqual({ '0106': ['0106_b.sql', '0106_c.sql'] });
    expect(duplicatePrefixes(['0106_b.sql', '0107_d.sql'])).toEqual({});
  });
});
