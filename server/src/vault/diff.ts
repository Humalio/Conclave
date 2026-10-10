/** Small dependency-free line diff (Myers O(ND)) and unified-diff output. */

type Op = { t: ' ' | '-' | '+'; line: string };

function splitLines(s: string): string[] {
  if (s === '') return [];
  const parts = s.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/** Edit script between two line arrays. Falls back to replace-all when the inputs are far apart. */
export function diffLines(a: string[], b: string[], maxD = 4000): Op[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf), B = b.slice(pre, b.length - suf);
  const mid = myers(A, B, maxD);
  return [...a.slice(0, pre).map((line): Op => ({ t: ' ', line })), ...mid, ...a.slice(a.length - suf).map((line): Op => ({ t: ' ', line }))];
}

function myers(A: string[], B: string[], maxD: number): Op[] {
  const n = A.length, m = B.length;
  if (n === 0) return B.map((line) => ({ t: '+', line }));
  if (m === 0) return A.map((line) => ({ t: '-', line }));
  const max = Math.min(n + m, maxD);
  const off = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!) ? v[off + k + 1]! : v[off + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && A[x] === B[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) { found = d; break; }
    }
  }
  if (found < 0) return [...A.map((line): Op => ({ t: '-', line })), ...B.map((line): Op => ({ t: '+', line }))];
  const out: Op[] = [];
  let x = n, y = m;
  for (let d = found; d > 0; d--) {
    const vv = trace[d]!; // state before step d
    const k = x - y;
    const prevK = k === -d || (k !== d && vv[off + k - 1]! < vv[off + k + 1]!) ? k + 1 : k - 1;
    const prevX = vv[off + prevK]!, prevY = prevX - prevK;
    const ins = prevK === k + 1;
    const stepX = ins ? prevX : prevX + 1, stepY = ins ? prevY + 1 : prevY;
    while (x > stepX && y > stepY) { out.push({ t: ' ', line: A[x - 1]! }); x--; y--; }
    if (ins) out.push({ t: '+', line: B[y - 1]! }); else out.push({ t: '-', line: A[x - 1]! });
    x = prevX; y = prevY;
  }
  while (x > 0 && y > 0) { out.push({ t: ' ', line: A[x - 1]! }); x--; y--; }
  return out.reverse();
}

/** Unified diff of two texts. Returns '' when they are equal. */
export function unifiedDiff(oldText: string, newText: string, oldLabel: string, newLabel: string, context = 3): string {
  if (oldText === newText) return '';
  const ops = diffLines(splitLines(oldText), splitLines(newText));
  const changed: number[] = [];
  ops.forEach((o, i) => { if (o.t !== ' ') changed.push(i); });
  if (changed.length === 0) return '';
  // group changes into hunks
  const hunks: [number, number][] = [];
  for (const i of changed) {
    const s = Math.max(0, i - context), e = Math.min(ops.length, i + context + 1);
    const last = hunks[hunks.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e); else hunks.push([s, e]);
  }
  const out = [`--- ${oldLabel}`, `+++ ${newLabel}`];
  for (const [s, e] of hunks) {
    let oldStart = 1, newStart = 1;
    for (let i = 0; i < s; i++) { if (ops[i]!.t !== '+') oldStart++; if (ops[i]!.t !== '-') newStart++; }
    const slice = ops.slice(s, e);
    const oldLen = slice.filter((o) => o.t !== '+').length, newLen = slice.filter((o) => o.t !== '-').length;
    out.push(`@@ -${oldLen === 0 ? oldStart - 1 : oldStart},${oldLen} +${newLen === 0 ? newStart - 1 : newStart},${newLen} @@`);
    for (const o of slice) out.push(o.t + o.line);
  }
  return out.join('\n') + '\n';
}
