// A throwaway CA and server certificate for tests (minimal DER, no openssl needed). Shared by the hub's vitest files
// and the connector's node:test files. Never used outside tests.
import { generateKeyPairSync, randomBytes, sign, X509Certificate } from 'node:crypto';

const len = (n) => (n < 128 ? Buffer.from([n]) : (() => { const b = []; for (let x = n; x > 0; x >>= 8) b.unshift(x & 0xff); return Buffer.from([0x80 | b.length, ...b]); })());
const tlv = (tag, ...parts) => { const body = Buffer.concat(parts); return Buffer.concat([Buffer.from([tag]), len(body.length), body]); };
const seq = (...p) => tlv(0x30, ...p);
const oid = (s) => { const [a, b, ...r] = s.split('.').map(Number); const out = [40 * a + b]; for (const n of r) { const t = []; let x = n; do { t.unshift(x & 0x7f); x >>= 7; } while (x); out.push(...t.map((v, i) => (i < t.length - 1 ? v | 0x80 : v))); } return tlv(0x06, Buffer.from(out)); };
const name = (cn) => seq(tlv(0x31, seq(oid('2.5.4.3'), tlv(0x0c, Buffer.from(cn)))));
const utc = (d) => tlv(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z'));
const ext = (id, critical, der) => seq(oid(id), ...(critical ? [tlv(0x01, Buffer.from([0xff]))] : []), tlv(0x04, der));
const ECDSA_SHA256 = seq(oid('1.2.840.10045.4.3.2'));

function cert(o) {
  const exts = o.ca
    ? [ext('2.5.29.19', true, seq(tlv(0x01, Buffer.from([0xff])))), ext('2.5.29.15', true, tlv(0x03, Buffer.from([0x01, 0x06])))]
    : [ext('2.5.29.19', false, seq()), ext('2.5.29.15', true, tlv(0x03, Buffer.from([0x07, 0x80]))),
      ext('2.5.29.17', false, seq(tlv(0x87, Buffer.from([127, 0, 0, 1])), tlv(0x82, Buffer.from('localhost'))))];
  const now = Date.now();
  const tbs = seq(tlv(0xa0, tlv(0x02, Buffer.from([2]))), tlv(0x02, Buffer.concat([Buffer.from([1]), randomBytes(8)])), ECDSA_SHA256, name(o.issuer),
    seq(utc(new Date(now - 86_400_000)), utc(new Date(now + 30 * 86_400_000))), name(o.subject), o.pub.export({ type: 'spki', format: 'der' }), tlv(0xa3, seq(...exts)));
  const der = seq(tbs, ECDSA_SHA256, tlv(0x03, Buffer.concat([Buffer.from([0]), sign('sha256', tbs, o.signer)])));
  return `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
}

/** A CA, a leaf for 127.0.0.1 and localhost signed by it, the leaf's key, and the CA's SHA-256 (lowercase hex). */
export function testCa(cn = 'Conclave test CA') {
  const ca = generateKeyPairSync('ec', { namedCurve: 'P-256' }), leaf = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const caPem = cert({ subject: cn, issuer: cn, pub: ca.publicKey, signer: ca.privateKey, ca: true });
  const leafPem = cert({ subject: '127.0.0.1', issuer: cn, pub: leaf.publicKey, signer: ca.privateKey, ca: false });
  return { caPem, leafPem, leafKey: leaf.privateKey.export({ type: 'pkcs8', format: 'pem' }), caSha256: new X509Certificate(caPem).fingerprint256.replace(/:/g, '').toLowerCase() };
}
