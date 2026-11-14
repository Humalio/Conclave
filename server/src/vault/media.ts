/**
 * Vault media (docs/vault.md, "Media and attachments"): the content type a file may be shown inline with, read from its
 * first bytes, and the one byte range a request may ask for. Pure functions; the route is in admin/vaultApi.ts.
 */

/** Bytes a sniff needs: the longest signature below, the Ogg codec header at offset 28. */
export const SNIFF_BYTES = 64;
/** The most one answer sends; a longer or open-ended range ends here and the player asks for the rest. */
export const MAX_RANGE_BYTES = 8 * 1024 * 1024;

const ascii = (b: Uint8Array, at: number, s: string) => b.length >= at + s.length && [...s].every((c, i) => b[at + i] === c.charCodeAt(0));

/**
 * The inline type of a recognized raster image or supported audio file, from its bytes, else null (served only as an
 * attachment). The name is never consulted: an HTML or SVG file named .png is null.
 */
export function sniffInline(b: Uint8Array): { mime: string; kind: 'image' | 'audio' } | null {
  const img = (mime: string) => ({ mime, kind: 'image' as const }), aud = (mime: string) => ({ mime, kind: 'audio' as const });
  if (b.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((x, i) => b[i] === x)) return img('image/png');
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return img('image/jpeg');
  if (ascii(b, 0, 'GIF87a') || ascii(b, 0, 'GIF89a')) return img('image/gif');
  if (ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP')) return img('image/webp');
  if (ascii(b, 0, 'RIFF') && ascii(b, 8, 'WAVE')) return aud('audio/wav');
  if (ascii(b, 0, 'fLaC')) return aud('audio/flac');
  // Ogg: audio only when the first page carries a Vorbis or Opus header (Theora and other video stay attachments).
  if (ascii(b, 0, 'OggS')) return ascii(b, 28, '\x01vorbis') || ascii(b, 28, 'OpusHead') ? aud('audio/ogg') : null;
  // MP4 family: only the audio brands; mp42, isom and the rest may hold video.
  if (ascii(b, 4, 'ftyp')) return ascii(b, 8, 'M4A ') || ascii(b, 8, 'M4B ') ? aud('audio/mp4') : null;
  if (ascii(b, 0, 'ID3') && b.length >= 10 && b[3]! < 0xff) return aud('audio/mpeg');
  // A bare MPEG audio frame: sync, Layer III, a bitrate and sample rate that are not reserved.
  if (b.length >= 4 && b[0] === 0xff && (b[1]! & 0xe0) === 0xe0 && (b[1]! & 0x18) !== 0x08 && (b[1]! & 0x06) === 0x02
    && (b[2]! & 0xf0) !== 0xf0 && (b[2]! & 0x0c) !== 0x0c) return aud('audio/mpeg');
  return null;
}

/**
 * The one range a Range header asks for, against a file of `size` bytes (RFC 9110 §14). `none`: serve the whole file
 * (no header, a malformed one, or several ranges); `unsatisfiable`: 416. A satisfiable range is capped at `cap` bytes.
 */
export function parseRange(header: string | undefined, size: number, cap = MAX_RANGE_BYTES): { kind: 'none' } | { kind: 'unsatisfiable' } | { kind: 'range'; start: number; end: number } {
  if (!header) return { kind: 'none' };
  const m = /^\s*bytes\s*=\s*(\d{0,15})\s*-\s*(\d{0,15})\s*$/i.exec(header);
  if (!m || (m[1] === '' && m[2] === '')) return { kind: 'none' };
  let start: number, end: number;
  if (m[1] === '') {
    const n = Number(m[2]);
    if (n === 0 || size === 0) return { kind: 'unsatisfiable' };
    start = Math.max(0, size - n); end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Number(m[2]);
    if (m[2] !== '' && end < start) return { kind: 'none' };
    if (start >= size) return { kind: 'unsatisfiable' };
    end = Math.min(end, size - 1);
  }
  return { kind: 'range', start, end: Math.min(end, start + cap - 1) };
}

/** A Content-Disposition value with the file's name: an ASCII fallback and the UTF-8 form (RFC 6266). */
export function disposition(type: 'inline' | 'attachment', name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]|["\\%]/g, '_');
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())}`;
}
