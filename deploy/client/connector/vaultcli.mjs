/**
 * The helper behind a synchronous call to the key service (isolation.mjs `vaultCallSync`): reads `{op, payload}` from standard
 * input, asks the service at the address in argv[2], and prints its answer. No key is ever in an argument.
 */
import { askVault } from './vaultclient.mjs';

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', async () => {
  let q = null;
  try { q = JSON.parse(raw); } catch { /* answered below */ }
  const a = q && typeof q.op === 'string' ? await askVault(process.argv[2], q.op, q.payload) : { ok: false, reason: 'bad_request' };
  process.stdout.write(JSON.stringify(a));
});
