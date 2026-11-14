/* Maths in Markdown (docs/design-guidelines.md, Maths): md.js marks formulas with Pandoc's $ rule and keeps their source;
   the hub serves Mermaid's own KaTeX; the console draws them with trust off and limits on. */
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp, katexFiles } from '../src/app.js';
import { testConfig } from './hub.js';
// @ts-expect-error plain JS module served to the browser, no type declarations
import { mdRender, mdInline, mdPlain } from '../public/md.js';

const inl = (s: string): string => mdInline(s);
const span = (tex: string): string => `<span class="md-math" data-tex="${tex}">$${tex}$</span>`;

describe('md.js: where $ is maths (Pandoc rule)', () => {
  it('$2^n$ is maths, and $5 and $10 stays text', () => {
    expect(inl('grows as $2^n$')).toBe(`grows as ${span('2^n')}`);
    expect(inl('$5 and $10')).toBe('$5 and $10');
    expect(inl('Price $5, total $10.')).toBe('Price $5, total $10.');
    expect(inl('x $ y $ z')).toBe('x $ y $ z'); // a space after the opening or before the closing $
    expect(inl('$x$5')).toBe('$x$5'); // a digit after the closing $
    expect(inl('the $x$-axis')).toBe(`the ${span('x')}-axis`);
  });

  it('\\$ is a literal dollar sign and never opens or closes a formula', () => {
    expect(inl('costs \\$5 and $x$')).toBe(`costs $5 and ${span('x')}`);
    expect(inl('\\$x\\$ stays')).toBe('$x$ stays');
    expect(inl('$a \\$ b$')).toBe(span('a \\$ b'));
  });

  it('nothing inside a formula is Markdown: underscores, backslashes, links and code marks stay', () => {
    expect(inl('$a_i + b_j$ and _em_')).toBe(`${span('a_i + b_j')} and <em>em</em>`);
    expect(inl('$\\frac{1}{2}$ and $\\alpha_{i}^{*}$')).toBe(`${span('\\frac{1}{2}')} and ${span('\\alpha_{i}^{*}')}`);
    expect(mdInline('[[note]] and $[[1,2]]$ and $[a](b)$', { alias: 'v', from: '/v/a.md' }))
      .toBe('<span class="md-wl pend" data-vl-t="note">note</span> and ' + span('[[1,2]]') + ' and ' + span('[a](b)'));
    expect(inl('$**b**$')).toBe(span('**b**'));
  });

  it('code is never maths', () => {
    expect(inl('run `$x$` now')).toBe('run <code>$x$</code> now');
    expect(mdRender('```\n$$x$$\n```')).toBe('<pre class="md-code"><code>$$x$$</code></pre>');
  });

  it('a formula is escaped: its source is text, never HTML', () => {
    const h = inl('$<img src=x onerror=alert(1)>$');
    expect(h).toBe(span('&lt;img src=x onerror=alert(1)&gt;'));
    expect(h).not.toContain('<img');
    expect(inl('$"x" & \'y\'$')).toBe(span('&quot;x&quot; &amp; &#39;y&#39;'));
  });

  it('a | inside a formula does not split a table cell', () => {
    expect(mdRender('| a | b |\n|---|---|\n| $|x|$ | 2 |').replace(/\n/g, ''))
      .toBe(`<div class="tscroll"><table class="md-table"><thead><tr><th class="nw">a</th><th class="nw">b</th></tr></thead><tbody><tr><td class="nw">${span('|x|')}</td><td class="nw">2</td></tr></tbody></table></div>`);
  });

  it('display maths: $$ on its own lines is a block; $$…$$ inside a sentence is a display span', () => {
    expect(mdRender('Text\n\n$$\n\\sum_{i=1}^n i\n$$\n\nafter')).toBe('<p>Text</p>\n<div class="md-math md-math-d" data-tex="\\sum_{i=1}^n i">$$\\sum_{i=1}^n i$$</div>\n<p>after</p>');
    expect(mdRender('$$ \\int_0^1 f $$')).toBe('<div class="md-math md-math-d" data-tex="\\int_0^1 f">$$\\int_0^1 f$$</div>');
    expect(mdRender('Before\n$$a\nb$$\nafter')).toBe('<p>Before</p>\n<div class="md-math md-math-d" data-tex="a&#10;b">$$a&#10;b$$</div>\n<p>after</p>');
    // A display span across lines of a paragraph: the paragraph's <br>s never land inside the formula.
    expect(mdRender('so $$a\nb$$ holds')).toBe('<p>so <span class="md-math md-math-d" data-tex="a&#10;b">$$a&#10;b$$</span> holds</p>');
    expect(inl('so $$E=mc^2$$ holds')).toBe('so <span class="md-math md-math-d" data-tex="E=mc^2">$$E=mc^2$$</span> holds');
    // Unclosed, or a blank line before the close: text, never a block that swallows the page.
    expect(mdRender('$$\nx\n\ny $$ z')).toBe('<p>$$<br>\nx</p>\n<p>y $$ z</p>');
  });

  it('\\(…\\) is inline maths, only when a \\) closes it in the same paragraph', () => {
    const pi = (tex: string): string => `<span class="md-math" data-tex="${tex}">\\(${tex}\\)</span>`;
    expect(inl('grows as \\(2^n\\) and \\( a_i + b_j \\)')).toBe(`grows as ${pi('2^n')} and ${pi('a_i + b_j')}`);
    expect(inl('\\(\\frac{1}{2}\\) and \\(\\left( x \\right)\\)')).toBe(`${pi('\\frac{1}{2}')} and ${pi('\\left( x \\right)')}`);
    expect(inl('an escaped \\(bracket alone')).toBe('an escaped (bracket alone'); // unclosed: the usual escaped bracket
    expect(inl('\\\\(x\\)')).toBe('\\(x)'); // \\( is a backslash and a bracket, never an opening
    expect(inl('\\(<b>\\)')).toBe(pi('&lt;b&gt;'));
    expect(mdRender('\\(x\n\ny\\)')).toBe('<p>(x</p>\n<p>y)</p>'); // a blank line between: text
    expect(mdRender('| a |\n|---|\n| \\(|x|\\) |').replace(/\n/g, '')).toContain(`<td class="nw">${pi('|x|')}</td>`);
  });

  it('\\[…\\] is display maths as a block on its own lines; inside a sentence it stays literal brackets', () => {
    const pd = (tex: string, tag = 'span'): string => `<${tag} class="md-math md-math-d" data-tex="${tex}">\\[${tex}\\]</${tag}>`;
    expect(mdRender('Text\n\n\\[\n\\sum_{i=1}^n i\n\\]\n\nafter')).toBe(`<p>Text</p>\n${pd('\\sum_{i=1}^n i', 'div')}\n<p>after</p>`);
    expect(mdRender('\\[ E = mc^2 \\]')).toBe(pd('E = mc^2', 'div'));
    expect(mdRender('Before\n\\[a\nb\\]\nafter')).toBe(`<p>Before</p>\n${pd('a&#10;b', 'div')}\n<p>after</p>`);
    expect(mdRender('\\[\nx\n\ny')).toBe('<p>[<br>\nx</p>\n<p>y</p>'); // unclosed: text
    // Inside a sentence, \[…\] is Markdown's literal brackets (converters write citations as \[1\]).
    expect(inl('see \\[1\\] and \\[x\\](y)')).toBe('see [1] and [x](y)');
    expect(mdRender('\\[1\\] Smith, 2020.')).toBe('<p>[1] Smith, 2020.</p>');
  });

  it('mdPlain shows the source without the $ signs', () => {
    expect(mdPlain('Grows as \\(2^n\\), so\n\\[\\sum_i x_i\\]\nsee \\[1\\]')).toBe('Grows as 2^n, so \\sum_i x_i see [1]');
    expect(mdPlain('Grows as $2^n$ and $a_i$, **b**')).toBe('Grows as 2^n and a_i, b');
    expect(mdPlain('Sum $$\\sum_i x_i$$ costs \\$5')).toBe('Sum \\sum_i x_i costs $5');
    expect(mdPlain('$5 and $10')).toBe('$5 and $10');
  });
});

describe('KaTeX is Mermaid\'s own copy, served by the hub', () => {
  it('resolves KaTeX through Mermaid, the same copy Mermaid uses; this fails if that resolution breaks', () => {
    const k = katexFiles();
    expect(k).not.toBeNull();
    const viaMermaid = createRequire(createRequire(import.meta.url).resolve('mermaid/package.json'));
    expect(k!.version).toBe(JSON.parse(readFileSync(viaMermaid.resolve('katex/package.json'), 'utf8')).version);
    expect(k!.fonts.has('KaTeX_Main-Regular.woff2')).toBe(true);
    expect([...k!.fonts].every((n) => /^KaTeX_[A-Za-z0-9]+-[A-Za-z]+\.(woff2|woff|ttf)$/.test(n))).toBe(true);
  });

  it('serves the script, the stylesheet with its font paths, and only KaTeX\'s own font names', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ah-math-'));
    mkdirSync(join(dir, 'vault'));
    const app = await buildApp(testConfig(dir));
    try {
      const get = (url: string) => app.fastify.inject({ method: 'GET', url });
      const js = await get('/vendor/katex.min.js');
      expect(js.statusCode).toBe(200);
      expect(js.headers['content-type']).toMatch(/^text\/javascript/);
      expect(js.body).toContain('renderToString');
      const css = await get('/vendor/katex.min.css');
      expect(css.statusCode).toBe(200);
      expect(css.headers['content-type']).toMatch(/^text\/css/);
      expect(css.body).toContain('url(katex/fonts/KaTeX_Main-Regular.woff2)');
      expect(css.body).not.toMatch(/url\(fonts\//);
      const font = await get('/vendor/katex/fonts/KaTeX_Main-Regular.woff2');
      expect(font.statusCode).toBe(200);
      expect(font.headers['content-type']).toBe('font/woff2');
      for (const bad of ['..%2F..%2Fpackage.json', '..%2Fkatex.min.js', 'KaTeX_Main-Regular.woff2.map', 'evil.woff2', '%2E%2E', 'KaTeX_Main-Regular.WOFF2']) {
        expect((await get('/vendor/katex/fonts/' + bad)).statusCode, bad).toBe(404);
      }
      expect((await get('/vendor/katex/../package.json')).statusCode).not.toBe(200);
    } finally { await app.close(); }
  });

  it('the console loads it lazily from the hub with trust off, errors kept and limits set', () => {
    const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8');
    expect(js).toContain("s.src = '/vendor/katex.min.js'");
    expect(js).toContain("l.href = '/vendor/katex.min.css'");
    expect(js).not.toMatch(/https?:\/\/[^'"]*katex/i);
    const opts = /const KTX_OPTS = \{([^}]*)\}/.exec(js)?.[1] ?? '';
    expect(opts).toMatch(/trust: false/);
    expect(opts).toMatch(/throwOnError: false/);
    expect(opts).toMatch(/maxExpand: \d+/);
    expect(opts).toMatch(/maxSize: \d+/);
    expect(js).toMatch(/mmdDraw\(\); ktxDraw\(\);/); // drawn on every screen, the vault viewers included
    expect(js).toContain("['ref', 'info-tip', 'md-math']"); // Blueprint code marks skip formulas
  });

  it('with the console\'s options, KaTeX draws $2^n$, marks a malformed formula as an error, and makes no link', async () => {
    const k = katexFiles()!;
    const katex = (await import('file:///' + join(k.dist, 'katex.mjs').replace(/\\/g, '/'))).default;
    const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8');
    const opts = Function(`return {${/const KTX_OPTS = \{([^}]*)\}/.exec(js)![1]}}`)();
    expect(katex.renderToString('2^n', opts)).toContain('class="katex"');
    expect(katex.renderToString('a_i + b_j', opts)).not.toContain('katex-error');
    expect(katex.renderToString('\\frac{1}{', opts)).toContain('katex-error'); // the console keeps the source instead
    const link = katex.renderToString('\\href{javascript:alert(1)}{x} \\url{https://x.example}', opts);
    expect(link).not.toContain('<a ');
    expect(link).not.toMatch(/href=/); // the source stays only as escaped text in the MathML annotation
    const drawn = katex.renderToString('\\htmlClass{x}{y} \\htmlStyle{color:red}{z}', opts).split('katex-html')[1];
    expect(drawn).not.toMatch(/class="x"|color:red/); // trust off: no class or style from the formula in what is drawn
    // A macro bomb stops at the expansion limit instead of hanging the page.
    const bomb = '\\def\\a{\\b\\b}\\def\\b{\\c\\c}\\def\\c{\\d\\d}\\def\\d{\\e\\e}\\def\\e{\\f\\f}\\def\\f{\\g\\g}\\def\\g{\\h\\h}\\def\\h{\\i\\i}\\def\\i{xx}\\a\\a\\a';
    expect(katex.renderToString(bomb, opts)).toContain('katex-error');
  });
});
