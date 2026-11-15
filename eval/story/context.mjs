// The story context every step receives: the operator, the lab's /onboard client, one seat per agent, shared state,
// assertions and disk access to the vault (for edits made outside the hub).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Admin, Onboard, Pc, sleep } from './lib.mjs';

export class StoryError extends Error {}
/** A step returns this when it could not run on this hub (for example the restart on a hub the runner does not control): its rows then do not count. */
export const SKIPPED = Symbol('skipped');
export const fail = (msg) => { throw new StoryError(msg); };

/** One agent at its PC: calls carry its session token; every call is recorded. */
class Seat {
  constructor(ctx, label) { this.ctx = ctx; this.label = label; this.token = null; }
  get pc() { return this.ctx.pcFor(this.label); }
  async call(tool, args = {}) {
    const pc = this.pc;
    if (!pc) fail(`${this.label} has no PC connection`);
    const r = await pc.tool(tool, { ...(this.token ? { session_token: this.token } : {}), ...args });
    this.ctx.rec.tool(tool, r.ok ? 'ok' : `refused:${r.code}`);
    return r;
  }
  /** Expect success; returns the structured result. */
  async ok(tool, args) {
    const r = await this.call(tool, args);
    if (!r.ok) fail(`${this.label} ${tool} was refused (${r.code}): ${r.text.slice(0, 300)}`);
    return r.data;
  }
  /** Expect a refusal with one of the codes (string, array or RegExp on code+text); returns the result. */
  async no(tool, args, want = 'denied') {
    const r = await this.call(tool, args);
    if (r.ok) fail(`${this.label} ${tool} should have been refused (${want}) but succeeded`);
    const match = want instanceof RegExp ? want.test(`${r.code} ${r.text}`) : [].concat(want).includes(r.code);
    if (!match) fail(`${this.label} ${tool}: expected ${want}, got ${r.code}: ${r.text.slice(0, 300)}`);
    return r;
  }
}

export class Context {
  constructor({ hub, rec, signal, log }) {
    this.hub = hub; this.rec = rec; this.signal = signal; this.log = log;
    this.op = new Admin(hub.base, rec);
    this.ob = new Onboard(hub.base, rec);
    this.S = {};              // story state: ids, revisions, secrets (in memory only)
    this.agents = {};         // label -> agent row
    this.teams = {};          // key -> team row
    this.keys = {};           // label -> { id, secret }
    this.pcs = {};            // key -> { pc, appKey, appKeyId, conn }
    this.seatPc = {};         // label -> pc key
    this.seats = {};
  }
  A(label) { const a = this.agents[label]; if (!a) fail(`unknown agent ${label}`); return a.id; }
  T(key) { const t = this.teams[key]; if (!t) fail(`unknown team ${key}`); return t.id; }
  as(label) { return (this.seats[label] ??= new Seat(this, label)); }
  pcFor(label) { return this.pcs[this.seatPc[label]]?.conn; }
  async connectPc(key) { const p = this.pcs[key]; await p.conn?.close(); p.conn = await new Pc(this.hub.base, key, p.appKey, this.rec).connect(); return p.conn; }
  async login(label) {
    const seat = this.as(label);
    seat.token = null;
    const d = await seat.ok('session_login', { session_key: this.keys[label].secret });
    seat.token = d.session_token;
    return d;
  }
  expect(cond, msg) { if (!cond) fail(msg); }
  eq(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) fail(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
  sleep(ms) { return sleep(ms, this.signal); }
  /** Poll fn until it returns truthy, at most timeout ms. */
  async until(fn, { timeout = 10000, every = 250, what = 'condition' } = {}) {
    const end = Date.now() + timeout;
    for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) fail(`timed out waiting for ${what}`); await this.sleep(every); }
  }
  /** An exact quote (plain prose, no markup) from the section with this anchor, for graph claims. */
  quoteIn(text, anchor, len = 48) {
    const slug = (h) => h.toLowerCase().replace(/[`*_~]/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-') || 'section';
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    let inSec = false;
    for (const l of lines) {
      const h = /^#{1,6}\s+(.+?)\s*$/.exec(l);
      if (h) { inSec = slug(h[1]) === anchor; continue; }
      if (!inSec) continue;
      const m = /[A-Za-z][A-Za-z0-9 ,.'’()%-]{15,}/.exec(l);
      if (m) return m[0].slice(0, len).trim();
    }
    fail(`no quotable prose in section #${anchor}`);
  }
  /** Read and write the vault on disk, as an editor outside the hub would. */
  disk = {
    read: (rel) => readFileSync(join(this.hub.vaultDir, rel), 'utf8').replace(/\r\n/g, '\n'),
    write: (rel, text) => { const p = join(this.hub.vaultDir, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); },
  };
}
