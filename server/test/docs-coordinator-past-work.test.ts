/**
 * Coordinator guidance (docs/mcp.md, Review and completion settings): work done before the hub is recorded in the
 * Blueprint as the item's status with evidence, never as tasks opened only to mark it done.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const mcp = readFileSync(join(process.cwd(), '..', 'docs', 'mcp.md'), 'utf8').replace(/\r\n/g, '\n');

describe('docs: coordinators record past work in the Blueprint', () => {
  it('says so in the coordinator guidance, with the status, the evidence and who recorded it', () => {
    const at = mcp.indexOf('**Review and completion settings.**'), end = mcp.indexOf('## Tool inventory');
    expect(at).toBeGreaterThan(-1);
    const part = mcp.slice(at, end);
    expect(part).toContain("Record work done before the hub in the Blueprint, as the item's status (Built or Verified) with evidence, not as tasks.");
    expect(part).toContain('"done before the hub: commit abc123"');
    expect(part).toContain("the item's change log shows who recorded it");
  });
});
