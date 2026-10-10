import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** Lowercase base32 (RFC 4648 alphabet, no padding). */
export function base32(buf: Uint8Array): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toLowerCase().replace(/[^a-z2-7]/g, '');
  let bits = 0, value = 0; const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export function randomToken(bytes: number): string { return base32(randomBytes(bytes)); }

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function hmacHex(key: string, data: string): string {
  return createHmac('sha256', key).update(data).digest('hex');
}

export function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex'), bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

// ── Admin passwords: scrypt ──
const N = 16384, R = 8, P = 1, LEN = 32;
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, LEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('hex')}$${hash.toString('hex')}`;
}
export function verifyPassword(password: string, stored: string): boolean {
  const [alg, n, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !n || !r || !p || !salt || !hash) return false;
  const got = scryptSync(password, Buffer.from(salt, 'hex'), hash.length / 2, { N: +n, r: +r, p: +p });
  return timingSafeEqual(got, Buffer.from(hash, 'hex'));
}

// ── TOTP (RFC 6238, SHA-1, 6 digits, 30 s) ──
export function totp(secretB32: string, atMs: number, stepOffset = 0): string {
  const counter = Math.floor(atMs / 1000 / 30) + stepOffset;
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', base32Decode(secretB32)).update(buf).digest();
  const off = mac[mac.length - 1]! & 0xf;
  const code = (mac.readUInt32BE(off) & 0x7fffffff) % 1_000_000;
  return code.toString().padStart(6, '0');
}
export function verifyTotp(secretB32: string, code: string, atMs: number): boolean {
  return [-1, 0, 1].some((o) => totp(secretB32, atMs, o) === code.trim());
}
