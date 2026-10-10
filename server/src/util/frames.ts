/**
 * Folder stream format "AHT1" (the same one the bridge program writes): a sequence of entries
 *   [u32 big-endian header length][header JSON {"p": "relative/path", "s": size}][s raw bytes]
 * terminated by a header length of 0. Paths use "/" and never start with "/" or contain "..".
 */
import { promises as fs } from 'node:fs';

export const FRAME_END = Buffer.alloc(4);
export function frameHeader(p: string, s: number): Buffer {
  const h = Buffer.from(JSON.stringify({ p, s }), 'utf8');
  const len = Buffer.alloc(4); len.writeUInt32BE(h.length);
  return Buffer.concat([len, h]);
}
export function safeRel(p: unknown): string | null {
  if (typeof p !== 'string' || p === '' || p.length > 500 || p.includes('\0') || p.includes('\\') || p.startsWith('/') || /^[a-zA-Z]:/.test(p)) return null;
  const parts = p.split('/');
  if (parts.some((s) => s === '' || s === '.' || s === '..')) return null;
  return parts.join('/');
}

/** Walk a framed file on disk. onFile gets the entry and where its bytes start. */
export async function parseFramedFile(file: string, onFile: (path: string, size: number, fh: fs.FileHandle, start: number) => Promise<void>): Promise<number> {
  const fh = await fs.open(file, 'r');
  try {
    const total = (await fh.stat()).size;
    let pos = 0, n = 0;
    const seen = new Set<string>();
    const lenBuf = Buffer.alloc(4);
    for (;;) {
      if (pos + 4 > total) throw new Error('truncated stream');
      if ((await fh.read(lenBuf, 0, 4, pos)).bytesRead !== 4) throw new Error('truncated stream');
      pos += 4;
      const hl = lenBuf.readUInt32BE(0);
      if (hl === 0) {
        if (pos !== total) throw new Error('unexpected bytes after stream terminator');
        return n;
      }
      if (hl > 4096 || pos + hl > total || n >= 100_000) throw new Error('bad entry header or too many entries');
      const hb = Buffer.alloc(hl);
      if ((await fh.read(hb, 0, hl, pos)).bytesRead !== hl) throw new Error('truncated entry header');
      pos += hl;
      const h = JSON.parse(hb.toString('utf8')) as { p?: unknown; s?: unknown };
      const rel = safeRel(h.p);
      if (!rel || seen.has(rel) || typeof h.s !== 'number' || !Number.isSafeInteger(h.s) || h.s < 0 || h.s > total - pos) throw new Error('bad entry');
      seen.add(rel);
      await onFile(rel, h.s, fh, pos);
      pos += h.s; n++;
    }
  } finally { await fh.close(); }
}

/** A virtual framed stream over entries whose bytes are fetched lazily (used to serve share downloads). */
export interface Segment { start: number; length: number; get: (from: number, to: number) => Promise<Buffer> }
export class VirtualStream {
  readonly segments: Segment[] = [];
  size = 0;
  add(length: number, get: (from: number, to: number) => Promise<Buffer>): void { this.segments.push({ start: this.size, length, get }); this.size += length; }
  addBuf(b: Buffer): void { this.add(b.length, async (f, t) => b.subarray(f, t)); }
  async read(offset: number, max: number): Promise<Buffer> {
    const out: Buffer[] = [];
    let want = Math.min(max, this.size - offset), pos = offset;
    for (const s of this.segments) {
      if (want <= 0) break;
      if (pos >= s.start + s.length) continue;
      const from = pos - s.start, to = Math.min(s.length, from + want);
      out.push(await s.get(from, to)); want -= to - from; pos += to - from;
    }
    return Buffer.concat(out);
  }
}
