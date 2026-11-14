/**
 * The text filter the vault copy (docs/vault.md, 99 Conclave) and task reviews go through: https URLs lose their user part,
 * Conclave keys, third-party tokens and private key blocks become [redacted].
 */
import { secretPattern } from './audit.js';

const THIRD_PARTY: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g, /\bgithub_pat_[A-Za-z0-9_]{16,}/g, /\bglpat-[A-Za-z0-9_-]{16,}/g, /\bxox[bpae]-[A-Za-z0-9-]{8,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g, /\bAKIA[0-9A-Z]{16}\b/g,
];
const PEM = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g;
export function scrub(s: string): string {
  let x = s.replace(/\b(https?:\/\/)[^\s/@?#]+@/gi, '$1').replace(PEM, '[redacted]');
  for (const re of [secretPattern(), ...THIRD_PARTY]) x = x.replace(re, '[redacted]');
  return x;
}
