/**
 * Vault media in the console (docs/vault.md, "Media and attachments"; design guidelines §5 Media player): one player,
 * filled from the one byte path, in the operator's file view, the member's file page, folder rows and note embeds.
 * Static checks on the console source, like console-tell.test.ts; the route itself is covered by vault-media.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const css = readFileSync(join(process.cwd(), 'public', 'style.css'), 'utf8');
const block = (start: string, end: string) => {
  const i = js.indexOf(start);
  expect(i, start).toBeGreaterThanOrEqual(0);
  const j = js.indexOf(end, i + start.length);
  expect(j, end).toBeGreaterThan(i);
  return js.slice(i, j);
};

describe('vault media player', () => {
  it('reads originals only through /api/vault/media, after a HEAD that authorizes and names the revision', () => {
    expect(js.match(/\/api\/vault\/media/g)).toHaveLength(1);
    const fill = block('async function mediaFill(', '\nfunction mediaScan');
    expect(fill).toMatch(/fetch\(mediaUrl\(path\), \{ method: 'HEAD', credentials: 'same-origin' \}\)/);
    expect(fill).toContain("r.headers.get('etag')");
    expect(fill).toMatch(/mediaUrl\(path, rev \? \{ rev \} : \{\}\)/);
    // Inline only for what the hub served as an image or audio type; anything else is a Download.
    expect(fill).toMatch(/!type\.startsWith\('image\/'\) && !type\.startsWith\('audio\/'\)\) return mediaFail\(el, '[^']+', path, rev\)/);
    expect(fill).not.toMatch(/<video|<iframe|<object|<embed/);
    // A refused later range stops the player with a reason.
    expect(fill).toMatch(/addEventListener\('error', \(\) => mediaFail\(/);
  });

  it('explains an unavailable player, and offers Download only where an attachment is allowed', () => {
    expect(js).toContain("403: 'Playing or downloading the original needs export permission on this folder.'");
    const fill = block('async function mediaFill(', '\nfunction mediaScan');
    // A refusal (403, 404, 409, 413) is a reason without a Download button.
    expect(fill).toMatch(/if \(!r \|\| !r\.ok\) \{[^\n]*return mediaFail\(el, r \? MEDIA_WHY\[r\.status\] \|\| '[^']+' : '[^']+'\); \}/);
    expect(block('function mediaFail(', '\n}')).toContain('el.dataset.vmFallback');
    expect(js).toMatch(/download\(mediaUrl\(dl\.dataset\.vmDl, \{ as: 'attachment'/);
  });

  it('is the same player in file views, folder rows and note embeds', () => {
    // Operator file view and member file page: no text preview means the player (or Download).
    expect(js).toContain(": preview ? mediaH(state.path) : none('file', 'No preview')");
    expect(block('async file(path) {', '\n  },')).toContain(': mediaH(f.path);');
    // Folder rows: the operator's and the member's, wrapped with the separate Play button.
    expect(block("VIEWS.vault = async", "const fo = rows.filter")).toContain('return media ? mediaRow(html, item.path) : html;');
    expect(block('async vault(path) {', '\n  },')).toContain('return media ? mediaRow(html, f.path) : html;');
    // Note embeds that md.js resolved to a visible file.
    const scan = block('function mediaScan(', '\n}');
    expect(scan).toContain("$$('[data-vault-embed]:not([data-vmedia])')");
    expect(scan).toContain('e.dataset.vmFallback = e.innerHTML');
  });

  it('keeps Play a separate, labelled control and the folder filter whole', () => {
    const r = block('const mediaRow = ', '\n');
    expect(r).toMatch(/^const mediaRow = \(rowHtml, path\) => `<div class="vm-item">\$\{rowHtml\}<button type="button" class="vm-play"/);
    expect(r).toContain('aria-expanded="false"');
    expect(r).toContain("aria-label=\"${esc('Play ' + path.split('/').pop())}\"");
    expect(js).toContain("$$('.vault-item').map((r) => r.closest('.vm-item') || r)");
    expect(css).toMatch(/\.vm-play::before\{content:'';position:absolute;inset:-6px\}/);
    expect(css).toMatch(/\.vm-item>\.lrow\{border-top:1px solid var\(--line\)\}/);
  });
});
