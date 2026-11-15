/**
 * A conversation in the console shows where each message stands for the agents that receive it (docs/connector.md,
 * "Messages: delivery states"): Not delivered yet, Delivered, Shown to the session (reported by the PC) and Read. A direct
 * chat names one state, a group counts them; only an admin asks for the positions. The marking function is run from the
 * console source.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const start = js.indexOf('const RM_STATE = ');
const block = js.slice(start, js.indexOf('const rmDelPaint'));
// eslint-disable-next-line no-new-func
const make = (del: unknown) => new Function('RM_', 'esc', `${block}; return rmDelH;`)({ del }, (s: string) => s) as (m: object) => string;

const mem = (agent_id: string, delivered_seq: number, shown_seq: number | null, acked_seq: number) => ({ agent_id, delivered_seq, shown_seq, acked_seq });
const msg = (seq: number, from = 'sender') => ({ seq, from, redacted: false });

describe('delivery marks in a conversation', () => {
  it('names the four states for a direct chat, in the order a message goes through them', () => {
    const h = make([mem('sender', 0, null, 0), mem('worker', 5, 3, 1)]);
    expect(h(msg(6))).toContain('Not delivered yet');
    expect(h(msg(3))).toContain('Shown to the session (reported by the PC)');
    expect(h(msg(4))).toContain('Delivered');
    expect(h(msg(1))).toContain('Read');
  });
  it('a PC that has not reported shows nothing as shown, never a guess', () => {
    const h = make([mem('sender', 0, null, 0), mem('worker', 5, null, 0)]);
    expect(h(msg(5))).toContain('Delivered');
    expect(h(msg(5))).not.toContain('Shown');
  });
  it('counts the states in a group, and leaves out the sender, the hub and removed messages', () => {
    const h = make([mem('sender', 9, 9, 9), mem('a', 3, null, 3), mem('b', 3, 3, 0), mem('c', 0, null, 0)]);
    expect(h(msg(3))).toContain('1 read · 1 shown (reported by the PC) · 1 not delivered yet');
    expect(h(msg(3, 'hub'))).toBe('');
    expect(h({ seq: 3, from: 'sender', redacted: true })).toBe('');
    expect(make(null)(msg(3))).toBe('');
  });
  it('asks for the positions with a new message or every 15 s, not on every poll, and keeps the last good marks when a poll fails', () => {
    expect(js).toContain('if (fresh.length || Date.now() - (RM_.delAt || 0) > 15000) await rmDelLoad(id);');
    expect(js).toContain('catch { /* keep what is shown */ }');
    expect(js).not.toContain('RM_.del = d.members; } catch { RM_.del = null; }');
  });
  it('only an admin asks the hub for the positions, and the room redraws them on every poll', () => {
    expect(js).toContain("if (S.me?.role !== 'admin') return;");
    expect(js).toContain('`/conversations/${encodeURIComponent(id)}/delivery`');
    expect(js).toContain('rmDelPaint();');
  });
});
