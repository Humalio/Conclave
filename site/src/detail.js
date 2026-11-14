// Extra detail for the landing-page drawings (vignettes, closing steps).
// gen-room.js calls these with its isometric helper `s` (class S); everything is flat colour + soft ink.
const INK = '#3d2b1f', TERRA = '#c4503a', CREAM = '#fbf2da', SHAD = '#5a3d28';
const f = n => Math.round(n * 10) / 10;
const sk = (st, sw) => st === 'none' ? ' stroke="none"' : ` stroke="${st}" stroke-width="${sw}"`;
const P = pts => pts.map(q => f(q[0]) + ',' + f(q[1])).join(' ');
const poly = (pts, fill, sw = 1, op, st = INK) => `<polygon points="${P(pts)}" fill="${fill}"${sk(st, sw)}${op != null ? ` fill-opacity="${op}"` : ''}/>`;
const line = (a, b, col = INK, sw = 1, op, ex = '') => `<line x1="${f(a[0])}" y1="${f(a[1])}" x2="${f(b[0])}" y2="${f(b[1])}" stroke="${col}" stroke-width="${sw}"${op != null ? ` stroke-opacity="${op}"` : ''}${ex ? ' ' + ex : ''}/>`;
const ell = (cx, cy, rx, ry, fill, sw = 1, op, st = INK) => `<ellipse cx="${f(cx)}" cy="${f(cy)}" rx="${f(rx)}" ry="${f(ry)}" fill="${fill}"${sk(st, sw)}${op != null ? ` fill-opacity="${op}"` : ''}/>`;
const circ = (cx, cy, r, fill, sw = 1, st = INK) => `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(r)}" fill="${fill}"${sk(st, sw)}/>`;
const path = (d, fill, sw = 1, st = INK, ex = '') => `<path d="${d}" fill="${fill}"${sk(st, sw)}${ex ? ' ' + ex : ''}/>`;
const lerp = (p, q, t) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
const shade = (s, pts, op = .16) => s.o.push(poly(pts, SHAD, 1, op, 'none'));

// ---------------------------------------------------------------- animals (local origin = seat centre)
const e = (cx, cy, rx, ry, fill, sw = 1.8) => ell(cx, cy, rx, ry, fill, sw);
const back = {
  bear() { const fur = '#8a5a2e'; return e(0, -12, 11.8, 12.6, fur) + circ(-8.4, -39.4, 3.7, fur, 1.8) + circ(8.4, -39.4, 3.7, fur, 1.8) + e(0, -33, 10.6, 9.2, fur) +
    path('M-10 -22.6Q0 -19.4 10 -22.6L9 -18Q0 -14.8 -9 -18Z', '#e0a93a', 1.6) + path('M-6 -20.4L-5.4 -16.6M-1 -19.8L-.8 -15.8M4 -20.2L4.6 -16.6', 'none', 1.4, TERRA); },
  rabbit() { const fur = '#f2e7cd'; return `<g transform="rotate(-9 -5 -42)">${e(-5, -47, 3.3, 9.6, fur)}</g><g transform="rotate(9 5 -42)">${e(5, -47, 3.3, 9.6, fur)}</g>` +
    e(0, -12, 10.6, 12, fur) + circ(0, -3.2, 3.6, CREAM, 1.6) + e(0, -33, 9.8, 8.6, fur) + path('M-10 -33C-10 -46 10 -46 10 -33', 'none', 3) + path('M-10 -33C-10 -46 10 -46 10 -33', 'none', 1.5, '#e0a93a') +
    `<rect x="-13.2" y="-36.4" width="5.4" height="7.6" rx="2.2" fill="${TERRA}" stroke="${INK}" stroke-width="1.6"/><rect x="7.8" y="-36.4" width="5.4" height="7.6" rx="2.2" fill="${TERRA}" stroke="${INK}" stroke-width="1.6"/>` +
    path('M-9 -18Q-18 -23 -21 -31', 'none', 6, INK) + path('M-9 -18Q-18 -23 -21 -31', 'none', 3.6, fur) + circ(-21, -31.4, 3, fur, 1.6); },
  owl() { const fur = '#a07aa5', dk = '#7a5480'; return e(0, -13, 11.6, 13, fur) + `<g transform="rotate(8 -10 -12)">${e(-10.6, -12, 3.6, 9, dk)}</g><g transform="rotate(-8 10 -12)">${e(10.6, -12, 3.6, 9, dk)}</g>` +
    path('M-4 -9l1.8 1.8l1.8 -1.8M1 -9l1.8 1.8l1.8 -1.8M-1.5 -4.5l1.8 1.8l1.8 -1.8', 'none', 1.2, dk) +
    poly([[-9.5, -37.5], [-10.5, -46.5], [-3.5, -40.5]], dk, 1.8) + poly([[9.5, -37.5], [10.5, -46.5], [3.5, -40.5]], dk, 1.8) + e(0, -33, 10.6, 9, fur) + path('M-3 -39Q0 -36 3 -39', 'none', 1.2, dk) +
    path('M9 -18Q18 -23 21 -31', 'none', 6, INK) + path('M9 -18Q18 -23 21 -31', 'none', 3.6, fur) + circ(21, -31.4, 3, dk, 1.6); },
  fox() { const fur = '#e07a3a'; return `<g transform="translate(15 -12) rotate(40)">${e(0, 0, 5.6, 11, fur)}${e(0, -8, 4.4, 3.6, CREAM)}</g>` + e(0, -12, 11, 12, fur) +
    poly([[-9.5, -37], [-9, -48.5], [-2.4, -40.5]], fur, 1.8) + poly([[9.5, -37], [9, -48.5], [2.4, -40.5]], fur, 1.8) + e(0, -33, 10.2, 8.8, fur) +
    path('M-9.6 -22Q0 -19 9.6 -22L8.6 -17Q0 -14 -8.6 -17Z', '#5b9ec9', 1.6); },
  raccoon() { const fur = '#a8a39a', dk = '#4a3a2f'; return `<g transform="translate(-15 -12) rotate(-40)">${e(0, 0, 5.6, 11, fur)}${[-7, 0, 7].map(y => ell(0, y, 5.3 * Math.sqrt(1 - (y / 11) * (y / 11)), 1.5, dk, 1, null, 'none')).join('')}</g>` +
    e(0, -12, 11, 12, fur) + poly([[-9.5, -37], [-9, -46], [-2.8, -40.5]], dk, 1.8) + poly([[9.5, -37], [9, -46], [2.8, -40.5]], dk, 1.8) + e(0, -33, 10.5, 8.8, fur) + ell(-9, -33.6, 1.5, 2.8, dk, 1, null, 'none') + ell(9, -33.6, 1.5, 2.8, dk, 1, null, 'none'); },
  tanuki() { const fur = '#a68a5a', dk = '#4a3a2f'; return `<g transform="translate(15 -9) rotate(35)">${e(0, 0, 6, 8.5, fur)}${ell(0, -6, 4.6, 3, dk, 1, null, 'none')}</g>` + e(0, -12, 11.4, 12.6, fur) +
    circ(-8.4, -39, 3.2, dk, 1.8) + circ(8.4, -39, 3.2, dk, 1.8) + e(0, -33, 10.6, 8.8, fur) + path('M-5 -41.6Q0 -50.6 5 -41.6Q0 -38.6 -5 -41.6Z', '#5f9a6a', 1.6); },
};
const front = {
  fox() { const fur = '#e07a3a'; return `<g transform="translate(15 -14) rotate(40)">${e(0, 0, 5.6, 11, fur)}${e(0, -8, 4.4, 3.8, CREAM)}</g>` + e(0, -12, 11, 12, fur) + ell(0, -9, 6.4, 8, CREAM, 1, null, 'none') +
    poly([[-9.5, -37], [-9, -48.5], [-2.4, -40.5]], fur, 1.8) + poly([[9.5, -37], [9, -48.5], [2.4, -40.5]], fur, 1.8) + e(0, -33, 10.2, 8.8, fur) +
    path('M-10 -33L-3.4 -26.2L0 -25L3.4 -26.2L10 -33Q0 -28.6 -10 -33Z', CREAM, 1.6) + circ(-3.8, -34.4, 1.2, INK, 1, 'none') + circ(3.8, -34.4, 1.2, INK, 1, 'none') + ell(0, -28.6, 1.6, 1.1, INK, 1, null, 'none') + path('M-9.6 -22Q0 -17 9.6 -22L8.6 -17Q0 -12 -8.6 -17Z', '#5b9ec9', 1.6); },
};
function animal(s, kind, view, cx, cy, z, sc = .5, rot = 0, flip = false) {
  const q = s.p(cx, cy, z), g = (view === 'front' ? front : back)[kind]();
  s.o.push(`<g transform="translate(${f(q[0])} ${f(q[1])}) rotate(${rot}) scale(${flip ? -sc : sc} ${sc})">${g}</g>`);
  return q;
}
function stool(s, cx, cy, r = 7) {
  const wd = ['#d5a560', '#c58d4a', '#a8743c'];
  shade(s, [s.p(cx - r - 2, cy - r, 0), s.p(cx + r + 2, cy - r, 0), s.p(cx + r + 2, cy + r + 2, 0), s.p(cx - r - 2, cy + r + 2, 0)], .12);
  [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([dx, dy]) => s.box(cx + dx * r * .55 - .8, cy + dy * r * .55 - .8, 0, 1.6, 1.6, 6.4, wd, .8));
  s.cyl(cx, cy, 6.2, r * .94, 1.2, ['#d5a560', '#a8743c'], .9);
  s.cyl(cx, cy, 7.4, r, 2.6, ['#86a96a', '#5a7d4b'], 1.1);
  s.ell(cx, cy, 10, r * .66, 'none', .7, '#476640');
  const q = s.p(cx, cy, 10); s.o.push(circ(q[0], q[1], 1, '#476640', 1, 'none'));
}
const SEAT = 10;

// ---------------------------------------------------------------- small props
function mug(s, x, y, z, col = TERRA, r = 2.2) {
  s.cyl(x, y, z, r, 4.2, [col, col === TERRA ? '#a8452f' : '#8a9470'], .9);
  s.ell(x, y, z + 4.2, r * .72, '#5a3d28', .6);
  const a = s.p(x + r, y, z + 2.2); s.o.push(path(`M${f(a[0])} ${f(a[1] - 1.6)}c4 -1 4 3.6 0 3`, 'none', 1.1));
}
function lamp(s, x, y, z, col = '#e0a93a') {
  s.cyl(x, y, z, 3, 1.2, ['#c58d4a', '#a8743c'], .9);
  const b = s.p(x, y, z + 1.2), m = s.p(x, y, z + 11), h = s.p(x + 2, y, z + 17);
  s.o.push(line(b, m, INK, 2.6) + line(b, m, '#c8ad78', 1.2) + line(m, h, INK, 2.6) + line(m, h, '#c8ad78', 1.2));
  s.o.push(poly([[h[0] - 7, h[1] + 3], [h[0] + 7, h[1] + 3], [h[0] + 3.5, h[1] - 5], [h[0] - 3.5, h[1] - 5]], col, 1.1) + ell(h[0], h[1] + 3, 7, 1.7, '#fff1b4', .9));
}
function duck(s, x, y, z) {
  const q = s.p(x, y, z);
  s.o.push(`<g transform="translate(${f(q[0])} ${f(q[1])})">${ell(1, 1, 5, 1.5, SHAD, 1, .22, 'none')}${path('M-4.4 -2.6C-4.4 1 5.4 1.4 5.8 -2.6C4.6 -5.4 1.8 -3.8 0 -4.8Z', '#f2c04a', 1)}${circ(-2.2, -6.4, 2.5, '#f2c04a', 1)}${poly([[-4.4, -7.4], [-7.4, -6], [-4.4, -5.2]], '#e5805c', .8)}${circ(-2.8, -7, .5, INK, 1, 'none')}</g>`);
}
function penguin(s, x, y, z) {
  const q = s.p(x, y, z);
  s.o.push(`<g transform="translate(${f(q[0])} ${f(q[1])})">${ell(0, 0, 6, 1.8, SHAD, 1, .22, 'none')}${poly([[-4.2, -.4], [-1, -.4], [-1, 1.4], [-4.8, 1.4]], '#e8a24a', .8)}${poly([[1, -.4], [4.2, -.4], [4.8, 1.4], [1, 1.4]], '#e8a24a', .8)}${ell(0, -6.4, 4.6, 6.2, '#3d3a40', 1.1)}${ell(0, -5.2, 2.9, 4.4, CREAM, .7)}${circ(-1.4, -10.4, .7, CREAM, 1, 'none')}${circ(1.4, -10.4, .7, CREAM, 1, 'none')}${poly([[-1.2, -9.2], [1.2, -9.2], [0, -7.6]], '#e8a24a', .7)}</g>`);
}
function steamless(s) { /* placeholder to keep API symmetrical */ }
function sticky(s, x, y, z, w, h, fill, wallPlane = 'y') {
  const f2 = wallPlane === 'y' ? s.qY.bind(s) : s.qX.bind(s);
  f2(x, y, z, w, h, fill, .7);
}
function headphones(s, x, y, z) {
  const q = s.p(x, y, z);
  s.o.push(`<g transform="translate(${f(q[0])} ${f(q[1])})">${path('M-5 -1C-5 -9 5 -9 5 -1', 'none', 2.6)}${path('M-5 -1C-5 -9 5 -9 5 -1', 'none', 1.2, '#e0a93a')}${ell(-5.2, -1, 2.2, 2.8, TERRA, 1)}${ell(5.2, -1, 2.2, 2.8, TERRA, 1)}</g>`);
}
function succulent(s, x, y, z) {
  const q = s.p(x, y, z);
  s.o.push(`<g transform="translate(${f(q[0])} ${f(q[1])})">${path('M-4 -6L4 -6L3 0L-3 0Z', '#c98350', 1)}${[[-40, 8], [0, 10], [40, 8], [-18, 9], [18, 9]].map(([r, l]) => path(`M0 0C3 ${-l * .3} 2 ${-l * .8} 0 ${-l}C-2 ${-l * .8} -3 ${-l * .3} 0 0Z`, '#5d7f45', .9, INK, `transform="translate(0 -6) rotate(${r})"`)).join('')}</g>`);
}
// flat dashed outline on the floor
function dashRect(s, x, y, w, d, z, col, sw = 1.2) {
  const pts = [s.p(x, y, z), s.p(x + w, y, z), s.p(x + w, y + d, z), s.p(x, y + d, z)];
  s.o.push(`<polygon points="${P(pts)}" fill="none" stroke="${col}" stroke-width="${sw}" stroke-dasharray="3 2.4"/>`);
}
function baseboards(s, W, D) {
  s.qY(0, 0, 0, W, 4, '#f6e7c0', .9); s.qY(0, 0, 4, W, 1.4, '#e8cf98', .8);
  s.qX(0, 0, 0, D, 4, '#e8cf98', .9); s.qX(0, 0, 4, D, 1.4, '#d8bc84', .8);
}
function clock(s, x, y, z, r = 5) {
  const c = s.p(x, y, z);
  const w = 1.2247 * s.k;
  s.o.push(`<g transform="translate(${f(c[0])} ${f(c[1])})">${circ(0, 0, r * 1.05, '#c8ad78', 1.1)}${circ(0, 0, r * .82, CREAM, .9)}${line([0, 0], [0, -r * .55], INK, 1.2)}${line([0, 0], [r * .4, r * .15], INK, 1)}${circ(0, 0, .8, TERRA, .6, 'none')}</g>`);
}

// ---------------------------------------------------------------- UI shown on a laptop screen quad
function screenUI(s, kind, x, yy, z, w, h) {
  const q = (u0, u1, v0, v1, fill, sw = .5, st = 'none') => s.o.push(poly([s.p(x + w * u0, yy, z + h * v0), s.p(x + w * u1, yy, z + h * v0), s.p(x + w * u1, yy, z + h * v1), s.p(x + w * u0, yy, z + h * v1)], fill, sw, null, st));
  const ln = (u0, u1, v, col = INK, sw = .9, op = .7) => s.o.push(line(s.p(x + w * u0, yy, z + h * v), s.p(x + w * u1, yy, z + h * v), col, sw, op));
  if (kind === 0) { // Windows: blue desktop, taskbar, start logo, one window
    q(0, 1, 0, 1, '#5b9ec9'); q(0, 1, 0, .14, '#2f3f55');
    q(.04, .08, .03, .06, '#7ec0e8'); q(.09, .13, .03, .06, '#7ec0e8'); q(.16, .3, .03, .07, '#fbf2da');
    q(.34, .92, .26, .86, '#fbf2da', .6, INK); q(.34, .92, .74, .86, '#2f6fb0');
    ln(.4, .85, .62, INK, .9); ln(.4, .78, .5); ln(.4, .82, .38);
    q(.06, .2, .72, .86, '#7ec0e8'); q(.06, .2, .5, .64, '#e0a93a');
  } else if (kind === 1) { // Linux: dark terminal, green prompt
    q(0, 1, 0, 1, '#2d3a36'); q(0, 1, .86, 1, '#46535a');
    circ; s.o.push(circ(...s.p(x + w * .06, yy, z + h * .93), .9, '#e5805c', .5, 'none') + circ(...s.p(x + w * .12, yy, z + h * .93), .9, '#e0a93a', .5, 'none') + circ(...s.p(x + w * .18, yy, z + h * .93), .9, '#7ec08a', .5, 'none'));
    ln(.06, .5, .72, '#7ec08a', 1.1, 1); ln(.06, .8, .58, '#d6e8d0', 1, .7); ln(.06, .4, .44, '#d6e8d0', 1, .7); ln(.06, .62, .3, '#e0a93a', 1, .9);
    q(.06, .1, .12, .22, '#7ec08a');
  } else { // macOS: menu bar, dock, a window with traffic lights
    q(0, 1, 0, 1, '#e8d9f0'); q(0, 1, .9, 1, '#fbf2da'); q(.2, .8, 0, .12, '#fbf2da', .5, INK);
    [.26, .34, .42, .5, .58, .66, .74].forEach((u, i) => q(u - .03, u + .03, .02, .1, ['#e5805c', '#e0a93a', '#7ec08a', '#5b9ec9', '#8a5a8c', '#c4503a', '#a9d2de'][i], .4));
    q(.18, .86, .24, .82, '#fbf2da', .6, INK); s.o.push(circ(...s.p(x + w * .23, yy, z + h * .77), .8, '#e5805c', .4, 'none') + circ(...s.p(x + w * .28, yy, z + h * .77), .8, '#e0a93a', .4, 'none') + circ(...s.p(x + w * .33, yy, z + h * .77), .8, '#7ec08a', .4, 'none'));
    ln(.24, .8, .6, INK, .9); ln(.24, .7, .48); ln(.24, .76, .36);
  }
}

// ---------------------------------------------------------------- vignette 1 rooms
// kind: 0 Windows (owl), 1 Linux (rabbit), 2 macOS (bear)
function roomWalls(s, kind, deskX) {
  const W = 96, D = 96;
  baseboards(s, W, D);
  // window on the back wall (clear of the laptop)
  const wx = [66, 8, 64][kind];
  const sky = ['#a9d2de', '#4a5a78', '#c8e4ee'][kind];
  s.qY(wx - 2, 0, 20, 28, 32, '#f1dfb5', 1.1); s.qY(wx, 0, 22, 24, 28, sky, .9);
  const gp = (u, v) => s.p(wx + u, 0, 22 + v);
  if (kind === 1) { s.o.push(circ(...gp(17, 21), 3.4, '#fff1b4', .8) + circ(...gp(5, 22), .6, CREAM, 1, 'none') + circ(...gp(10, 16), .6, CREAM, 1, 'none') + circ(...gp(21, 12), .6, CREAM, 1, 'none')); }
  s.o.push(poly([gp(0, 0), gp(24, 0), gp(24, 9), gp(17, 12), gp(10, 8), gp(0, 11)], kind === 1 ? '#3f5a50' : '#8fb577', .9));
  if (kind !== 1) s.o.push(poly([gp(2, 22), gp(10, 22), gp(8, 25), gp(4, 25)], '#fff', .6, .9, 'none'));
  s.o.push(line(gp(12, 0), gp(12, 28), INK, 1.3) + line(gp(0, 14), gp(24, 14), INK, 1.3));
  s.box(wx - 3.5, 0, 18.5, 31, 4, 1.6, ['#f7e8c4', '#e6cf9c', '#c8ad78'], .9);
  if (kind !== 1) { s.qY(wx - 3, 0.2, 20, 4.5, 30, kind === 0 ? '#e5805c' : '#e8c887', .9); s.qY(wx + 22.5, 0.2, 20, 4.5, 30, kind === 0 ? '#e5805c' : '#e8c887', .9); }
  else s.qY(wx - 3, 0.2, 49, 31, 3, '#a8743c', .9);
  // left wall pieces
  if (kind === 0) { // poster with window logo
    s.qX(0, 44, 24, 26, 22, '#fbf2da', 1);
    [[48, 36], [58, 36], [48, 29], [58, 29]].forEach(([y, z]) => s.qX(0, y, z, 8, 6.4, '#5b9ec9', .6));
    s.qX(0, 36, 22, 4, 10, '#fff1b4', .7);
  } else if (kind === 1) { // book/rack shelf
    s.box(0, 30, 34, 5, 34, 1.6, ['#d5a560', '#a8743c', '#c58d4a'], .9);
    [[33, '#5f9a6a', 9], [36.4, '#d9944f', 11], [40, '#5b9ec9', 8], [43, '#c4503a', 10], [46.4, '#e0a93a', 9], [50, '#8a5a8c', 11], [54, '#f1e0b8', 8]].forEach(([y, c, hh]) => s.qX(0.4, y, 35.6, 3, hh, c, .7));
    penguin(s, 3, 60, 35.6);
  } else { // framed prints
    s.qX(0, 38, 28, 16, 20, '#c98350', .9); s.qX(0, 39.6, 29.6, 12.8, 16.8, '#d9e4bf', .7); s.qX(0, 39.6, 29.6, 12.8, 6, '#8fb577', .6);
    s.qX(0, 58, 32, 12, 14, '#c98350', .9); s.qX(0, 59.4, 33.4, 9.2, 11.2, '#e8cf98', .7);
    const c = s.p(0, 64, 40); s.o.push(circ(c[0], c[1], 2.6, TERRA, .7));
  }
  if (kind === 0) clock(s, 36, 0, 52, 5);
}
function roomFloor(s, kind, deskX) {
  dashRect(s, 27, 37, 46, 40, 0, ['#fff1c8', '#e6a574', '#fff1c8'][kind]);
  shade(s, [s.p(deskX - 2, 4, 0), s.p(deskX + 50, 4, 0), s.p(deskX + 55, 30, 0), s.p(deskX + 3, 30, 0)], .13);
  if (kind === 1) { // server tower
    const wd = ['#5d6a72', '#46535a', '#3a464c'];
    s.box(80, 4, 0, 12, 14, 30, wd, 1.1);
    for (let i = 0; i < 4; i++) { s.qY(81.4, 18, 4 + i * 6.4, 9.2, 4, '#6d7d86', .6); const q = s.p(88, 18, 6 + i * 6.4); s.o.push(circ(q[0], q[1], .8, i % 2 ? '#7ec08a' : '#e0a93a', .3, 'none')); }
  }
  if (kind === 2) { // floor lamp + small stack of books
    s.box(78, 30, 0, 6, 5, 2.6, ['#f1e0b8', '#e8cf98', '#c8ad78'], .8); s.box(78.4, 30.4, 2.6, 5.2, 4.2, 2.4, ['#5b9ec9', '#4a86b0', '#3a6f96'], .8);
  }
}
function roomDesk(s, kind, deskX) {
  const z = 16.4;
  // screen UI over the existing teal lines
  const w = 23.4, h = 16.9, i = 1.95, yy = 9.56, z0 = z + 1.82;
  screenUI(s, kind, deskX + 6 + i, yy + .02, z0 + i, w - 2 * i, h - 2 * i);
  if (kind === 0) { lamp(s, deskX + 40, 7, z); mug(s, deskX + 4, 18, z, '#5b9ec9'); }
  if (kind === 1) { penguin(s, deskX + 38, 8, z); mug(s, deskX + 4, 19, z, '#8a9470'); duck(s, deskX + 30, 20, z); }
  if (kind === 2) { headphones(s, deskX + 40, 9, z); mug(s, deskX + 5, 19, z, TERRA); succulent(s, deskX + 42, 19, z); }
}
function roomSeat(s, kind, deskX) {
  const cx = deskX + 15.5, cy = 32;
  stool(s, cx, cy, 7.2);
  animal(s, ['owl', 'rabbit', 'bear'][kind], 'back', cx, cy, SEAT, .82);
}

// ---------------------------------------------------------------- vignette 2
function personFigure(s, x, y, z, sc = 1) { // "you": a small seated-from-behind human, flat style
  const q = s.p(x, y, z), k = s.k * sc;
  const g = `<ellipse cx="0" cy="1" rx="11" ry="4.6" fill="${SHAD}" fill-opacity=".2"/>` +
    path('M-7 0L-6 -6L6 -6L7 0Z', '#5b6a73', 1.2) + path('M-9 -6C-9 -16 -6 -22 0 -22C6 -22 9 -16 9 -6Z', TERRA, 1.3) + path('M-9 -12C-12 -9 -11 -4 -8 -3', 'none', 3.4) + path('M-9 -12C-12 -9 -11 -4 -8 -3', 'none', 1.8, TERRA) +
    path('M9 -12C12 -9 11 -4 8 -3', 'none', 3.4) + path('M9 -12C12 -9 11 -4 8 -3', 'none', 1.8, TERRA) +
    rect(-2.4, -25, 4.8, 4, '#e5a98a') + circ(0, -30, 6.2, '#e5a98a', 1.3) + path('M-6.6 -30C-6.8 -37 6.8 -37 6.6 -30C4 -33 -4 -33 -6.6 -30Z', '#5a3d28', 1.1);
  s.o.push(`<g transform="translate(${f(q[0])} ${f(q[1])}) scale(${f(k)})">${g}</g>`);
  return [q[0], q[1] - 30 * k];
}
const rect = (x, y, w, h, fill) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" stroke="${INK}" stroke-width="1"/>`;



// ---------------------------------------------------------------- shelves: varied books, leaning, flat stacks, small objects
function shelfBooks(s, m, u, w, z0, ch, rnd, COLS) {
  let b = u + 4; const end = u + w - 4, hasObj = rnd() < .8;
  const stackAt = end - 20 - rnd() * 6;
  while (b < end - 6) {
    if (hasObj && b > stackAt) break;
    const bw = 3 + rnd() * 2.8, bh = ch * (.5 + rnd() * .42), lean = rnd() < .16 ? 2.6 : 0, c = COLS[Math.floor(rnd() * COLS.length)];
    s.o.push(poly([m(b, z0), m(b + bw, z0), m(b + bw + lean, z0 + bh), m(b + lean, z0 + bh)], c, .9));
    s.o.push(line(m(b + lean * .2, z0 + bh * .8), m(b + bw + lean * .2, z0 + bh * .8), '#fff7dc', .7, .6));
    s.o.push(line(m(b + lean * .1, z0 + bh * .2), m(b + bw + lean * .1, z0 + bh * .2), INK, .6, .35));
    b += bw + (lean ? 3 : .4);
  }
  if (hasObj) { // two flat books and a small object
    const y0 = b + 1;
    [['#c4503a', 0, 15], ['#f1e0b8', 2.4, 13], ['#5b9ec9', 4.8, 14]].slice(0, rnd() < .5 ? 2 : 3).forEach(([c, z, l]) => {
      s.o.push(poly([m(y0, z0 + z), m(y0 + l, z0 + z), m(y0 + l, z0 + z + 2.4), m(y0, z0 + z + 2.4)], c, .8));
      s.o.push(line(m(y0 + 1, z0 + z + 1.2), m(y0 + l - 1, z0 + z + 1.2), '#fff7dc', .6, .6));
    });
    const c = m(y0 + 22, z0 + .5), k = rnd();
    if (c[0] && y0 + 26 < u + w - 1) {
      if (k < .5) s.o.push(circ(c[0], c[1] - 5, 4.6, '#a9d2de', .9) + ell(c[0], c[1] - 5, 1.8, 4.6, 'none', .6, null, INK) + poly([[c[0] - 3, c[1]], [c[0] + 3, c[1]], [c[0] + 1.6, c[1] - 1.6], [c[0] - 1.6, c[1] - 1.6]], '#8a5a8c', .8));
      else s.o.push(path(`M${f(c[0] - 3.4)} ${f(c[1])}L${f(c[0] - 3)} ${f(c[1] - 7)}L${f(c[0] + 3)} ${f(c[1] - 7)}L${f(c[0] + 3.4)} ${f(c[1])}Z`, '#c98350', .9) + circ(c[0], c[1] - 9.4, 3, '#5d7f45', .8) + circ(c[0] + 2, c[1] - 11, 1.6, '#86a468', .6));
    }
  }
}
function lockRivets(s, m, u, w, z0, ch) {
  [[u + 4, z0 + .6], [u + w - 4, z0 + .6], [u + 4, z0 + ch - .4], [u + w - 4, z0 + ch - .4]].forEach(([a, z]) => { const q = m(a, z); s.o.push(circ(q[0], q[1], .9, '#a8743c', .5, 'none')); });
  s.o.push(line(m(u + 3, z0 + ch * .5), m(u + w - 3, z0 + ch * .5), '#a8743c', 1.1, .8));
}
function ladder(s, x, z1) {
  const r = [x, x + 7]; r.forEach(xx => s.o.push(line(s.p(xx, 11, 0), s.p(xx, 3, z1), INK, 3.4) + line(s.p(xx, 11, 0), s.p(xx, 3, z1), '#c58d4a', 1.8)));
  for (let i = 1; i < 8; i++) { const t = i / 8, y = 11 - 8 * t, z = z1 * t; s.o.push(line(s.p(x, y, z), s.p(x + 7, y, z), INK, 2.4) + line(s.p(x, y, z), s.p(x + 7, y, z), '#d5a560', 1)); }
}
function curtains(s, x, z, w, h, col, y = .2) {
  s.qY(x, y, z, 5, h, col, .9); s.qY(x + w - 5, y, z, 5, h, col, .9);
  [1.7, 3.4].forEach(d => { s.o.push(line(s.p(x + d, y, z + 1), s.p(x + d, y, z + h - 1), '#c4583c', .7, .7)); s.o.push(line(s.p(x + w - 5 + d, y, z + 1), s.p(x + w - 5 + d, y, z + h - 1), '#c4583c', .7, .7)); });
  s.o.push(line(s.p(x - 2, y, z + h + 1.6), s.p(x + w + 2, y, z + h + 1.6), INK, 2.2) + line(s.p(x - 2, y, z + h + 1.6), s.p(x + w + 2, y, z + h + 1.6), '#c8ad78', 1));
}
// sleeping tabby (same as the hero), local origin on the cushion
function cat(s, x, y, z, sc = .5) {
  const q = s.p(x, y, z), fur = '#e3a560', dk = '#b9722f', lt = '#f6dcae';
  const ee = (cx, cy, rx, ry, fill, sw = 1.3) => ell(cx, cy, rx, ry, fill, sw);
  const g = path('M15 -3C28 -2 31 -12 22 -16C17 -18 13 -15 15 -12', 'none', 6.4, INK, 'stroke-linecap="round"') + path('M15 -3C28 -2 31 -12 22 -16C17 -18 13 -15 15 -12', 'none', 4.2, fur, 'stroke-linecap="round"') +
    path('M22 -2.6l.6 -3.4M27 -6l-3 -2.4M28 -11.4l-3.6 .2', 'none', 1.4, dk) + ee(3, -8, 17, 9.5, fur) + path('M-12 -3.2C-4 0 8 0 17 -3', 'none', 3, lt) +
    path('M-2 -16.6q1.8 4.4 .2 8M4 -17.4q2 5 .4 9.4M10 -16.4q2.2 4.4 .6 8.4', 'none', 1.7, dk) + ee(-19, -2.6, 4.2, 2.4, lt, 1.1) + ee(-11.5, -2, 4.2, 2.4, lt, 1.1) +
    path('M-21.5 -13.6L-21.6 -22L-16 -17Z', fur, 1.2) + path('M-13.6 -17L-8.4 -22L-8 -13.6Z', fur, 1.2) + ee(-15, -10, 8.4, 7, fur) + ee(-15, -6.4, 4.6, 2.4, lt, 1) +
    path('M-20 -10.4q2 1.8 4 0M-14 -10.4q2 1.8 4 0', 'none', 1.1) + path('M-16.4 -8.2h2.8l-1.4 1.6Z', '#d9787a', 0, 'none');
  s.o.push(`<g transform="translate(${f(q[0])} ${f(q[1])}) scale(${sc})">${g}</g>`);
}
function plankSlab(s, n = 6) { // plank lines on the closing-illustration slab
  for (let i = 1; i < n; i++) { s.o.push(line(s.p(0, i * 64 / n, 6), s.p(64, i * 64 / n, 6), '#b07a3c', .9, .45)); }
  for (let i = 0; i < 9; i++) { const y = (i % n) * 64 / n + 4; s.o.push(line(s.p(8 + i * 6, y, 6), s.p(8 + i * 6, y + 6, 6), '#b07a3c', .7, .4)); }
}
function star(s, x, y, z, r = 3) { const q = s.p(x, y, z); s.o.push(`<path d="M${f(q[0])} ${f(q[1] - r)}Q${f(q[0])} ${f(q[1])} ${f(q[0] + r)} ${f(q[1])}Q${f(q[0])} ${f(q[1])} ${f(q[0])} ${f(q[1] + r)}Q${f(q[0])} ${f(q[1])} ${f(q[0] - r)} ${f(q[1])}Q${f(q[0])} ${f(q[1])} ${f(q[0])} ${f(q[1] - r)}Z" fill="#fff1c8" stroke="none"/>`); }


front.tanuki = function () { const fur = '#a68a5a', dk = '#4a3a2f', light = '#f1e0b8';
  return `<g transform="translate(15 -10) rotate(35)">${e(0, 0, 6, 8.5, fur)}${ell(0, -6, 4.6, 3, dk, 1, null, 'none')}</g>` + e(0, -12, 11.4, 12.6, fur) + ell(0, -9.5, 7.6, 9, light, 1, null, 'none') +
    circ(-8.4, -39, 3.2, dk, 1.8) + circ(8.4, -39, 3.2, dk, 1.8) + e(0, -33, 10.6, 8.8, fur) +
    `<g transform="rotate(-24 -4.2 -33.5)">${ell(-4.2, -33.5, 2.8, 3.6, dk, 1, null, 'none')}</g><g transform="rotate(24 4.2 -33.5)">${ell(4.2, -33.5, 2.8, 3.6, dk, 1, null, 'none')}</g>` +
    circ(-4.2, -33.8, .9, CREAM, 1, 'none') + circ(4.2, -33.8, .9, CREAM, 1, 'none') + ell(0, -29.4, 5, 3.4, '#e5c590', 1, null, 'none') + ell(0, -30.6, 1.6, 1.1, INK, 1, null, 'none') +
    path('M-5 -41.6Q0 -50.6 5 -41.6Q0 -38.6 -5 -41.6Z', '#5f9a6a', 1.6) + ell(-7, -3, 3.3, 2.2, dk, 1.4) + ell(7, -3, 3.3, 2.2, dk, 1.4); };
// laptop seen side-on: lid at the low-x end (screen faces +x, visible) or at the high-x end (lid back visible)
function laptopSide(s, x, y, z, lidFacesPlusX) {
  s.box(x, y, z, 12, 18, 1.4, ['#f2e7cd', '#d6c7a2', '#b8a984'], 1.1);
  if (lidFacesPlusX) {
    s.box(x, y + 1, z + 1.4, 1.4, 16, 13, ['#d6c7a2', '#d6c7a2', '#b8a984'], 1.1);
    s.qX(x + 1.4, y + 2.4, z + 2.8, 13.2, 10.2, '#a8ded4', .8);
    [[.75, .7], [.55, .5], [.35, .62]].forEach(([v, w]) => s.o.push(line(s.p(x + 1.4, y + 4, z + 2.8 + 10.2 * v), s.p(x + 1.4, y + 4 + 9.6 * w, z + 2.8 + 10.2 * v), '#3f8f8a', 1.3)));
  } else {
    s.box(x + 10.6, y + 1, z + 1.4, 1.4, 16, 13, ['#d6c7a2', '#d6c7a2', '#c8b88c'], 1.1);
    s.qX(x + 12, y + 5, z + 5, 5, 5, '#f4b7a9', .7); s.o.push(circ(...s.p(x + 12, y + 12, z + 9), 1.9, CREAM, .7));
  }
}
function tv(s, x, y, z) { // small retro TV on a low stand, screen facing +y
  s.box(x, y, z, 22, 12, 1.6, ['#d5a560', '#a8743c', '#c58d4a'], 1.1);
  [[1.5, 1.5], [18, 1.5], [1.5, 8.5], [18, 8.5]].forEach(([a, b]) => s.box(x + a, y + b, z - 7, 2, 2, 7, ['#d5a560', '#a8743c', '#c58d4a'], .8));
  const zz = z + 1.6;
  s.box(x + 1, y + 1, zz, 20, 10, 15, ['#c58d4a', '#a8743c', '#8a5a2e'], 1.3);
  s.qY(x + 2.6, y + 11, zz + 2, 12.6, 11, '#a8ded4', 1);
  s.o.push(poly([s.p(x + 3.4, y + 11, zz + 6), s.p(x + 7, y + 11, zz + 10.4), s.p(x + 10.6, y + 11, zz + 6.4), s.p(x + 13.6, y + 11, zz + 9.4), s.p(x + 13.6, y + 11, zz + 3.6), s.p(x + 3.4, y + 11, zz + 3.6)], '#7ec08a', .7));
  s.o.push(circ(...s.p(x + 11.6, y + 11, zz + 11), 1.2, '#fff1b4', .5, 'none'));
  s.o.push(line(s.p(x + 2.6, y + 11, zz + 13), s.p(x + 15.2, y + 11, zz + 13), '#fff', .9, .6));
  [[17, 12], [17, 6.5]].forEach(([a, v]) => s.o.push(circ(...s.p(x + a, y + 11, zz + v), 1.5, '#e0a93a', .8)));
  const t = s.p(x + 11, y + 6, zz + 15);
  s.o.push(line(t, [t[0] - 12, t[1] - 16], INK, 1.2) + line(t, [t[0] + 10, t[1] - 17], INK, 1.2) + circ(t[0], t[1], 1.6, '#c8ad78', .8));
}
// awake tabby lounging in the armchair, head turned left (toward the TV), remote in one paw
function catAwake(s, x, y, z, sc = .8) {
  const q = s.p(x, y, z), fur = '#e3a560', dk = '#b9722f', lt = '#f6dcae';
  const g = path('M16 -4C30 0 33 -9 26 -13', 'none', 6.4, INK, 'stroke-linecap="round"') + path('M16 -4C30 0 33 -9 26 -13', 'none', 4.2, fur, 'stroke-linecap="round"') + path('M24 -1.6l1 -3M29.6 -4.6l-3 -2.4', 'none', 1.4, dk) +
    `<g transform="rotate(-18 2 -10)">${e(2, -10, 15, 10.5, fur, 1.4)}</g>` + path('M-6 -9C-2 -6 8 -6 12 -10', 'none', 3, lt) +
    path('M2 -20q1.8 4 .2 8M8 -19.6q2 4.4 .4 8.6M14 -17q2 3.6 .6 7.2', 'none', 1.7, dk) + e(10, -3, 7, 3.4, fur, 1.2) + e(-8, -3, 4.2, 2.4, lt, 1.1) +
    path('M-21 -16.6L-21.6 -26L-15.6 -20.6Z', fur, 1.3) + path('M-12.4 -21L-6.8 -26.4L-5.4 -17Z', fur, 1.3) +
    e(-13.5, -14.4, 9, 7.6, fur, 1.4) + e(-15.6, -9.8, 4.6, 2.5, lt, 1) + path('M-14 -21.4v2.6M-17.6 -21l.8 2M-10.6 -21.6l-.6 2.2', 'none', 1.3, dk) +
    ell(-18.4, -15.2, 2.3, 2.7, CREAM, 1.1) + ell(-11.2, -15.4, 2.3, 2.7, CREAM, 1.1) + circ(-19.4, -15, 1.3, INK, 1, 'none') + circ(-12.2, -15.2, 1.3, INK, 1, 'none') +
    path('M-17.4 -11.4h2.8l-1.4 1.6Z', '#d9787a', 0, 'none') + path('M-22 -11l-6 -1.6M-22 -9.8l-6 .8M-9.4 -11.6l5 -1.2', 'none', .8, INK) +
    e(-2, -5.6, 5, 2.6, lt, 1.1) + `<g transform="rotate(-24 -1 -8)"><rect x="-6" y="-11.4" width="9.6" height="3.4" rx=".8" fill="#46535a" stroke="${INK}" stroke-width="1"/><circle cx="-3.6" cy="-9.7" r=".7" fill="${TERRA}"/><circle cx="-1.2" cy="-9.7" r=".7" fill="#e0a93a"/></g>`;
  s.o.push(`<g transform="translate(${f(q[0])} ${f(q[1])}) scale(${sc})">${g}</g>`);
}


// vignette 1: direct owl -> rabbit send, plus a shared vault linked (dotted) to all three rooms
function v1Links(s, A, B, C, tagL, SC) {
  const bz = (t, p0, c, p2) => [(1 - t) * (1 - t) * p0[0] + 2 * t * (1 - t) * c[0] + t * t * p2[0], (1 - t) * (1 - t) * p0[1] + 2 * t * (1 - t) * c[1] + t * t * p2[1]];
  // --- the shared vault (a safe with an obsidian crystal), drawn first so the links sit on top
  const v = new SC(345, 232, 1.1);
  shade(v, [v.p(-2, 27, 0), v.p(28, 27, 0), v.p(34, 33, 0), v.p(4, 33, 0)], .0);
  v.o.push(ell(345, 262, 36, 11, SHAD, 1, .16, 'none'));
  const bl = ['#cfe3e8', '#a9c4cc', '#8fb4bf'];
  v.box(0, 0, 0, 26, 26, 28, bl, 1.4);
  v.qY(3, 26, 3, 20, 22, '#b9d3d9', 1.1);
  v.qY(5, 26, 5, 16, 18, '#a9c4cc', .9);
  const dial = v.p(11, 26, 14);
  v.o.push(circ(dial[0], dial[1], 5.4, '#e0a93a', 1.2) + circ(dial[0], dial[1], 2.4, '#fff1b4', .9) + line([dial[0], dial[1]], [dial[0] + 3.4, dial[1] - 2.6], INK, 1.2));
  [[5, 5], [21, 5], [5, 21], [21, 21]].forEach(([a, z]) => { const q = v.p(a, 26, z); v.o.push(circ(q[0], q[1], .9, '#8fb4bf', .6)); });
  const hd = v.p(20, 26, 14); v.o.push(line([hd[0] - 1, hd[1] - 5], [hd[0] - 1, hd[1] + 5], INK, 3) + line([hd[0] - 1, hd[1] - 5], [hd[0] - 1, hd[1] + 5], '#e0a93a', 1.4));
  [8, 12, 16, 20].forEach(z => v.o.push(line(v.p(26, 6, z), v.p(26, 20, z), INK, .8, .45)));
  // obsidian crystal floating above the safe
  const g = v.p(13, 13, 28), gx = g[0], gy = g[1] - 26;
  v.o.push(ell(gx, g[1] - 1, 9, 3.2, SHAD, 1, .2, 'none'));
  const T = [gx, gy - 17], Lp = [gx - 10, gy - 4], Rp = [gx + 10, gy - 4], Mp = [gx + 1, gy - 2], Bp = [gx, gy + 13];
  v.o.push(poly([T, Lp, Mp], '#d2b0d4', 1.3) + poly([T, Mp, Rp], '#9a6a9d', 1.3) + poly([Lp, Mp, Bp], '#a97bab', 1.3) + poly([Mp, Rp, Bp], '#7b4f7d', 1.3) + line([gx - 4, gy - 10], [gx - 3, gy - 5], '#e3c9e5', 1, .9));
  [[gx + 16, gy - 12, 3], [gx - 15, gy - 14, 2.4]].forEach(([x, y, r]) => v.o.push(path(`M${f(x)} ${f(y - r)}Q${f(x)} ${f(y)} ${f(x + r)} ${f(y)}Q${f(x)} ${f(y)} ${f(x)} ${f(y + r)}Q${f(x)} ${f(y)} ${f(x - r)} ${f(y)}Q${f(x)} ${f(y)} ${f(x)} ${f(y - r)}Z`, '#fff1c8', 0, 'none')));
  s.o.push(v.o.join(''));
  // --- dotted vault links (thin), each ends on a small crystal-coloured pin
  const vl = [[[324, 226], [292, 196], [252, 168]], [[368, 236], [404, 238], [440, 212]], [[332, 258], [316, 292], [306, 322]]];
  vl.forEach(([a, c, b]) => {
    s.o.push(`<path d="M${a[0]} ${a[1]}Q${c[0]} ${c[1]} ${b[0]} ${b[1]}" fill="none" stroke="${INK}" stroke-width="1.6" stroke-dasharray="1 5.5"/>`);
    s.o.push(circ(b[0], b[1], 3.4, '#a97bab', 1));
  });
  // --- the direct send: solid arrowed path from the owl's paw to the rabbit's paw
  const P0 = [208, 91], C1 = [360, 8], P2 = [504, 147];
  s.o.push(`<path d="M${P0[0]} ${P0[1]}Q${C1[0]} ${C1[1]} ${P2[0]} ${P2[1]}" fill="none" stroke="${INK}" stroke-width="4.8"/><path d="M${P0[0]} ${P0[1]}Q${C1[0]} ${C1[1]} ${P2[0]} ${P2[1]}" fill="none" stroke="${TERRA}" stroke-width="2.6"/>`);
  const tg = [P2[0] - C1[0], P2[1] - C1[1]], tl = Math.hypot(tg[0], tg[1]), dx = tg[0] / tl, dy = tg[1] / tl, px = -dy, py = dx;
  const tip = [P2[0] + dx * 6, P2[1] + dy * 6];
  s.o.push(poly([tip, [tip[0] - dx * 15 + px * 7, tip[1] - dy * 15 + py * 7], [tip[0] - dx * 15 - px * 7, tip[1] - dy * 15 - py * 7]], TERRA, 1.3));
  // motion marks behind the file
  [.2, .28, .36].forEach((t, i) => { const a = bz(t, P0, C1, P2), b = bz(t - .04, P0, C1, P2), o = (i - 1) * 6; s.o.push(line([a[0] + px * o, a[1] + py * o], [b[0] + px * o, b[1] + py * o], INK, 1.5, .7)); });
  const m = bz(.52, P0, C1, P2);
  s.o.push(`<g transform="translate(${f(m[0] - 11)} ${f(m[1] - 15)}) rotate(-8)"><path d="M0 0H15L22 7V29H0Z" fill="#fbf2da" stroke="${INK}" stroke-width="1.3"/><path d="M15 0V7H22" fill="#e8cf98" stroke="${INK}" stroke-width="1"/><line x1="4" y1="13" x2="18" y2="13" stroke="${INK}" stroke-opacity=".5"/><line x1="4" y1="18" x2="18" y2="18" stroke="${INK}" stroke-opacity=".5"/><line x1="4" y1="23" x2="12" y2="23" stroke="${INK}" stroke-opacity=".5"/></g>`);
  s.o.push(tagL(296, 4, 'results.csv', m[0], m[1] - 15, { col: TERRA }));
  s.o.push(tagL(392, 292, 'shared vault', 365, 250));
}

module.exports = { v1Links, laptopSide, tv, catAwake, sticky, shelfBooks, lockRivets, ladder, curtains, cat, plankSlab, star, animal, stool, mug, lamp, duck, penguin, headphones, succulent, dashRect, baseboards, clock, screenUI, roomWalls, roomFloor, roomDesk, roomSeat, personFigure, shade, poly, line, ell, circ, path, lerp, INK, TERRA, CREAM, SHAD, SEAT, back, front, f, P, rect };
