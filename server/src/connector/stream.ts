/**
 * The hub's push stream to a connector (docs/connector.md, "The push stream"): Server-Sent Events that only say "orders
 * waiting". The orders stay the record; the connector fetches them after every connect and every event, so a dropped stream
 * loses nothing. One stream per PC (so per hub and installation); a second replaces the first. A PC's access ending
 * (key suspended or revoked, Disconnect, lockdown) closes its stream at once.
 */
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';

export const HEARTBEAT_MS = 20_000;
/** At most this many stream opens per PC per minute; more are refused with 429. */
export const OPENS_PER_MIN = 6;
export const LONG_POLL_MAX_S = 25;

interface Open { res: ServerResponse; installation: string; address: string; credential: string | null; timer: NodeJS.Timeout }

export class Streams {
  private open = new Map<string, Open>();
  private opens = new Map<string, number[]>();
  private em = new EventEmitter();
  /** Called when a stream replaced another from a different installation or address (the console alerts). */
  onReplaced?: (pc: string, was: { installation: string; address: string }, now: { installation: string; address: string }) => void;
  /** Whether the PC may still hold a stream (not suspended, not locked down); asked at every heartbeat as a backstop. */
  allowed?: (pc: string) => boolean;
  constructor(private now: () => number = Date.now, private heartbeatMs = HEARTBEAT_MS) { this.em.setMaxListeners(0); }

  /** Refused (false) when this PC opened too many streams in the last minute. */
  admit(pc: string): boolean {
    const t = this.now(), recent = (this.opens.get(pc) ?? []).filter((x) => t - x < 60_000);
    if (recent.length >= OPENS_PER_MIN) { this.opens.set(pc, recent); return false; }
    recent.push(t); this.opens.set(pc, recent);
    return true;
  }
  /** Takes over the response: sends the headers and the first event, then a comment line every heartbeat. */
  attach(pc: string, res: ServerResponse, who: { installation: string; address: string; credential: string | null }): void {
    const old = this.open.get(pc);
    if (old) {
      if (old.installation !== who.installation || old.address !== who.address) this.onReplaced?.(pc, { installation: old.installation, address: old.address }, who);
      this.close(pc, 'replaced');
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write(': conclave stream\nretry: 5000\n\nevent: orders\ndata: {}\n\n'); // the connector fetches whatever waits at once
    const timer = setInterval(() => {
      if (this.allowed && !this.allowed(pc)) { this.close(pc, 'access_ended'); return; }
      try { res.write(': hb\n\n'); } catch { this.drop(pc, res); }
    }, this.heartbeatMs);
    timer.unref?.();
    const entry: Open = { res, installation: who.installation, address: who.address, credential: who.credential, timer };
    this.open.set(pc, entry);
    res.on('close', () => this.drop(pc, res));
  }
  private drop(pc: string, res: ServerResponse): void {
    const e = this.open.get(pc);
    if (e && e.res === res) { clearInterval(e.timer); this.open.delete(pc); }
  }
  /** Ends the PC's stream (and any long poll waiting for it). */
  close(pc: string, _why: string): void {
    const e = this.open.get(pc);
    if (!e) return;
    clearInterval(e.timer); this.open.delete(pc);
    try { e.res.end(); } catch { /* already gone */ }
    this.em.emit(`close:${pc}`);
  }
  /** A credential (an app key) stopped working: its PC's stream goes if it was opened with it. */
  closeCredential(credentialId: string): void {
    for (const [pc, e] of [...this.open]) if (e.credential === credentialId) this.close(pc, 'key_ended');
  }
  has(pc: string): boolean { return this.open.has(pc); }
  /** "Orders waiting" for this PC: to its stream and to a long poll. */
  signal(pc: string): void {
    const e = this.open.get(pc);
    if (e) { try { e.res.write('event: orders\ndata: {}\n\n'); } catch { this.drop(pc, e.res); } }
    this.em.emit(`orders:${pc}`);
  }
  /** Vault sync: a reader of this PC has a change in its scope. No paths, only the reader's id. */
  hint(pc: string, readerId: string): void {
    const e = this.open.get(pc);
    if (e) { try { e.res.write(`event: vault_changed\ndata: ${JSON.stringify({ reader: readerId })}\n\n`); } catch { this.drop(pc, e.res); } }
  }
  /** Waits until orders are signalled for the PC, the hub closes access, or the time runs out. */
  wait(pc: string, ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = () => { clearTimeout(t); this.em.off(`orders:${pc}`, done); this.em.off(`close:${pc}`, done); signal?.removeEventListener('abort', done); resolve(); };
      const t = setTimeout(done, ms);
      this.em.once(`orders:${pc}`, done); this.em.once(`close:${pc}`, done);
      signal?.addEventListener('abort', done, { once: true });
    });
  }
}
