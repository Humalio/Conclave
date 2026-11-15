/* The console's Markdown renderer (public/md.js): what agents write in Blueprint bodies, task text, reports and feedback.
   Inputs follow the live ECHO Blueprint section 5 and a real task (bold labels, nested lists, intervals, Greek and maths signs). */
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { buildApp } from '../src/app.js';
import { testConfig } from './hub.js';
// @ts-expect-error plain JS module served to the browser, no type declarations
import { mdRender, mdInline, mdPlain, mdFrontmatter, mdSlug, mdVaultTarget } from '../public/md.js';

const r = (s: string): string => mdRender(s);
const flat = (s: string): string => r(s).replace(/\n/g, '');

describe('md.js block structure', () => {
  it('renders a status report: bold labels, paragraphs and bullet lists stay apart', () => {
    const body = '**Lead handover (11 Nov ~09:xx):** new Lead (session "ECHO · Lead") replaces the pilot Lead.\n\n**Doing:**\n- Project A: propose the next step (task_5hsjwqi6pq4hn4ml).\n- Project B: demo chain ready to run.\n\n**Blocked on Ben:**\n- Project A v0.3 fold to master ("Not yet").';
    expect(flat(body)).toBe('<p><strong>Lead handover (11 Nov ~09:xx):</strong> new Lead (session &quot;ECHO · Lead&quot;) replaces the pilot Lead.</p>'
      + '<p><strong>Doing:</strong></p><ul><li>Project A: propose the next step (task_5hsjwqi6pq4hn4ml).</li><li>Project B: demo chain ready to run.</li></ul>'
      + '<p><strong>Blocked on Ben:</strong></p><ul><li>Project A v0.3 fold to master (&quot;Not yet&quot;).</li></ul>');
  });

  it('keeps single newlines as line breaks and ends a list at an unindented line', () => {
    expect(flat('Follow-up to pick 8.\nDo:\n- one;\n- two.\nCoordinate files with MiniFactory.'))
      .toBe('<p>Follow-up to pick 8.<br>Do:</p><ul><li>one;</li><li>two.</li></ul><p>Coordinate files with MiniFactory.</p>');
    expect(flat('two spaces  \nand a backslash\\\nend')).toBe('<p>two spaces<br>and a backslash<br>end</p>');
  });

  it('nests lists by indentation, ordered inside unordered and back', () => {
    expect(flat('- Frames:\n  - Feeder 05\n  - Overviews\n- Tests\n   1. unit\n   2. e2e')).toBe(
      '<ul><li>Frames:<ul><li>Feeder 05</li><li>Overviews</li></ul></li><li>Tests<ol><li>unit</li><li>e2e</li></ol></li></ul>');
  });

  it('keeps one ordered list across blank lines and honours the start number', () => {
    expect(flat('1. fit\n\n2. check\n\n3. report')).toBe('<ol><li>fit</li><li>check</li><li>report</li></ol>');
    expect(flat('3. third\n4. fourth')).toBe('<ol start="3"><li>third</li><li>fourth</li></ol>');
    expect(flat('1. a\n- b')).toBe('<ol><li>a</li></ol><ul><li>b</li></ul>');
  });

  it('puts indented text and fenced code inside the list item', () => {
    expect(flat('- item\n  more of it\n\n  second paragraph\n- next')).toBe('<ul><li>item<br>more of it<p>second paragraph</p></li><li>next</li></ul>');
    expect(flat('1. run\n   ```sh\n   npm test\n   ```\n2. read')).toBe('<ol><li>run<pre class="md-code" data-lang="sh"><code>npm test</code></pre></li><li>read</li></ol>');
  });

  it('renders task checkboxes, headings, rules and quotes', () => {
    expect(flat('- [x] done\n- [ ] open')).toBe('<ul><li class="md-task"><input type="checkbox" disabled checked> done</li><li class="md-task"><input type="checkbox" disabled> open</li></ul>');
    expect(r('## Method\n### Using C#')).toBe('<h2 data-anchor="method">Method</h2>\n<h3 data-anchor="using-c">Using C#</h3>');
    expect(r('## Closed ##')).toBe('<h2 data-anchor="closed">Closed</h2>');
    expect(r('#5 is not a heading')).toBe('<p>#5 is not a heading</p>');
    expect(r('a\n\n---\n\nb')).toBe('<p>a</p>\n<hr>\n<p>b</p>');
    expect(flat('> **Note** one\n> two')).toBe('<blockquote><p><strong>Note</strong> one<br>two</p></blockquote>');
    expect(flat('> [!warning] Careful\n> text')).toBe('<div class="md-callout k-warning"><b>Careful</b><p>text</p></div>');
  });

  it('renders tables with alignment, escaped pipes, pipes in code and <br> cells', () => {
    const html = flat('| Metric | Value | Note |\n|:--|--:|:-:|\n| CP 95 % | [0.039, 0.068] | `a\\|b` |\n| rate | ≤ 0.07 | x<br>y |');
    expect(html).toContain('<th class="nw">Metric</th><th class="nw ar">Value</th><th class="nw ac">Note</th>');
    expect(html).toContain('<td class="nw ar">[0.039, 0.068]</td><td class="nw ac"><code>a|b</code></td>');
    expect(html).toContain('<td class="nw ac">x<br>y</td>');
    expect(flat('a \\| b | c\n--|--\n1 | 2')).toContain('<th class="nw">a | b</th><th class="nw">c</th>');
    // A header and separator with different column counts is not a table.
    expect(r('a | b\n---')).toBe('<p>a | b</p>\n<hr>');
  });

  it('keeps code fences verbatim and escaped', () => {
    expect(r('```js\nconst x = a < b; // **not bold** <script>\n```')).toBe('<pre class="md-code" data-lang="js"><code>const x = a &lt; b; // **not bold** &lt;script&gt;</code></pre>');
    expect(r('~~~~\n```\ninner\n```\n~~~~')).toBe('<pre class="md-code"><code>```\ninner\n```</code></pre>');
  });

  it('marks a mermaid block for drawing and keeps its code as the fallback', () => {
    expect(r('```mermaid\nflowchart LR\n  A --> B\n```')).toBe('<pre class="md-code md-mermaid" data-lang="mermaid"><code>flowchart LR\n  A --&gt; B</code></pre>');
    expect(r('```Mermaid title\ngraph TD\n```')).toContain('class="md-code md-mermaid"');
    expect(r('```mermaidx\ngraph TD\n```')).toBe('<pre class="md-code" data-lang="mermaidx"><code>graph TD</code></pre>');
    expect(r('```js\nmermaid\n```')).not.toContain('md-mermaid');
  });

  it('reads frontmatter only when it is key: value lines', () => {
    expect(mdFrontmatter('---\ntags: [a, b]\nstatus: draft\n---\nBody').props).toEqual([{ key: 'tags', values: ['a', 'b'] }, { key: 'status', values: ['draft'] }]);
    expect(r('---\nJust a sentence between rules.\n---\nBody')).toBe('<hr>\n<p>Just a sentence between rules.</p>\n<hr>\n<p>Body</p>');
  });
});

describe('md.js inline', () => {
  const i = (s: string): string => mdInline(s);
  it('marks bold labels and emphasis, not snake_case, subscripts or spaced operators', () => {
    expect(i('**Result:** fits')).toBe('<strong>Result:</strong> fits');
    expect(i('*em* and _em_ and __strong__')).toBe('<em>em</em> and <em>em</em> and <strong>strong</strong>');
    expect(i('task_5hsjwqi6pq4hn4ml and dec_gqso4khajscgbbxz')).toBe('task_5hsjwqi6pq4hn4ml and dec_gqso4khajscgbbxz');
    expect(i('σ_b and μ_0, λ_max')).toBe('σ_b and μ_0, λ_max');
    expect(i('2 * 3 * 4, a ** b ** c, x == y and z == w, ~ 3 ~')).toBe('2 * 3 * 4, a ** b ** c, x == y and z == w, ~ 3 ~');
    expect(i('~~gone~~ ==hit==')).toBe('<del>gone</del> <mark>hit</mark>');
  });

  it('passes ≤ ≥ ± × and Greek letters through unchanged', () => {
    expect(i('rate ≤ 0.07, ≥ 0.03 ± 0.01, 3 × 4, α β γ Δ Ω')).toBe('rate ≤ 0.07, ≥ 0.03 ± 0.01, 3 × 4, α β γ Δ Ω');
    expect(i('M >= 2 && x < 1')).toBe('M &gt;= 2 &amp;&amp; x &lt; 1');
  });

  it('leaves bracketed intervals and matrices as text', () => {
    expect(i('CP 95 % [0.039, 0.068]')).toBe('CP 95 % [0.039, 0.068]');
    expect(i('CI [0.039, 0.068](n = 12) and [0.1, 0.2](3)')).toBe('CI [0.039, 0.068](n = 12) and [0.1, 0.2](3)');
    expect(i('[[0.1, 0.2], [0.3, 0.4]] and [[1, 2]]')).toBe('[[0.1, 0.2], [0.3, 0.4]] and [[1, 2]]');
  });

  it('renders code spans, including backticks inside double ones, before anything else', () => {
    expect(i('`n = 412` and ``a `tick` b`` and `**x**`')).toBe('<code>n = 412</code> and <code>a `tick` b</code> and <code>**x**</code>');
    expect(i('`<b>&`')).toBe('<code>&lt;b&gt;&amp;</code>');
  });

  it('honours backslash escapes', () => {
    expect(i('\\*not em\\*, \\_no\\_, \\# no tag, \\[x\\](y), back\\\\slash')).toBe('*not em*, _no_, # no tag, [x](y), back\\slash');
    // An escaped backtick never opens a code span; after an escaped backslash one does.
    expect(i('\\`not code\\`')).toBe('`not code`');
    expect(i('\\\\`code`')).toBe('\\<code>code</code>');
  });

  it('trims unbalanced closing parentheses from a bare URL in linear time', () => {
    const t = Date.now(), html = i(`https://e.org/a${')'.repeat(20000)}`);
    expect(html.startsWith('<a href="https://e.org/a" ')).toBe(true);
    expect(Date.now() - t).toBeLessThan(500);
  });

  it('links http(s), in-console #routes and vault notes only', () => {
    expect(i('[docs](https://example.org/a_b_(c))')).toBe('<a href="https://example.org/a_b_(c)" target="_blank" rel="noopener noreferrer">docs</a>');
    expect(i('see https://example.org/x_y_z.')).toBe('see <a href="https://example.org/x_y_z" target="_blank" rel="noopener noreferrer">https://example.org/x_y_z</a>.');
    expect(i('(https://example.org/q)')).toBe('(<a href="https://example.org/q" target="_blank" rel="noopener noreferrer">https://example.org/q</a>)');
    expect(i('<https://example.org/auto>')).toBe('<a href="https://example.org/auto" target="_blank" rel="noopener noreferrer">https://example.org/auto</a>');
    expect(i('[task](#task/task_x)')).toBe('<a href="#task/task_x">task</a>');
    expect(i('[**bold** `id`](https://e.org)')).toBe('<a href="https://e.org" target="_blank" rel="noopener noreferrer"><strong>bold</strong> <code>id</code></a>');
    expect(i('[js](javascript:alert(1)) [m](mailto:a@b.c) [d](data:text/html,x)')).toBe('js m d');
    // Without a vault context a vault link is an unavailable label; with one it waits for the hub's answer.
    expect(i('[plan](notes/plan.md)')).toBe('<span class="md-wl miss" title="Not available">plan</span>');
    expect(mdInline('[plan](notes/plan.md) [[Plan|the plan]]', V))
      .toBe('<span class="md-wl pend" data-vl-t="notes/plan.md">plan</span> <span class="md-wl pend" data-vl-t="Plan">the plan</span>');
  });

  it('escapes raw HTML and attribute breakouts', () => {
    expect(i('<img src=x onerror=alert(1)><script>x</script>')).toBe('&lt;img src=x onerror=alert(1)&gt;&lt;script&gt;x&lt;/script&gt;');
    expect(i('[x](https://e.org/"onmouseover="alert(1))')).not.toMatch(/href="[^"]*"on/);
    expect(i('[[a"><img src=x>]]')).toBe('<span class="md-wl miss" title="Not available">a&quot;&gt;&lt;img src=x&gt;</span>');
    // A target that tries to break out of its data attribute stays inside it.
    expect(mdInline('[[a" onmouseover="x]] [b](c"onclick="y)', V).replace(/"[^"]*"/g, '""')).not.toMatch(/<[^>]*\s(onmouseover|onclick)=/);
  });
});

/* Vault links (docs/vault.md, Links in notes): what the renderer works out before the hub checks visibility. */
const V = { alias: 'vault', from: '/vault/Projects/X/Notes/today.md' };
describe('md.js vault links', () => {
  it('writes vault embeds as pending chips the console resolves, and the rest as plain chips', () => {
    expect(mdInline('![[x.png]]', V)).toContain('<span class="md-embed pend" data-vl-embed data-vl-t="x.png">');
    expect(mdInline('![song](media/x.mp3)', V)).toContain('class="md-embed pend" data-vl-embed data-vl-t="media/x.mp3"');
    expect(mdInline('![a](/Shared/a.png)', V)).toContain('data-vl-t="/Shared/a.png"');
    // A relative embed outside a note: unavailable at once. A web or other-scheme URL, or a label context: a chip with no target.
    expect(mdInline('![a](./a.png)', { alias: 'vault' })).toContain('<span class="md-embed miss" title="Not available">');
    for (const s of ['![a](https://example.org/a.png)', '![a](javascript:alert(1))', '![a](data:image/png;base64,x)']) {
      const h = mdInline(s, V);
      expect(h).toContain('<span class="md-embed">');
      expect(h).not.toMatch(/data-vl|data-vault-embed|<a\s|href="(?!#i-)/);
    }
    expect(mdInline('![[x.png]]', { ...V, links: false })).toBe(mdInline('![[x.png]]', { links: false }));
    expect(mdInline('![[x.png]]', { ...V, links: false })).not.toContain('data-vl');
    // The name is escaped inside the chip and in the attribute.
    const bad = mdInline('![[a"><img src=x onerror=1>.png]]', V);
    expect(bad).not.toContain('<img');
    expect(bad.replace(/"[^"]*"/g, '""')).not.toMatch(/<[^>]*\sonerror=/);
  });
  it('sends every link form to the hub as written, and only a relative link outside a note is unavailable at once', () => {
    // The hub's one resolver applies the rules (server/src/vault/links.ts); the renderer only reads the target.
    const t = (s: string) => /data-vl-t="([^"]*)"/.exec(mdInline(s, V))?.[1] ?? null;
    expect(t('[x](/Folder/Note.md)')).toBe('/Folder/Note.md');
    expect(t('[x](Folder/Note.md)')).toBe('Folder/Note.md');
    expect(t('[[Folder/Note]]')).toBe('Folder/Note');
    expect(t('[x](../Note.md)')).toBe('../Note.md');
    expect(t('[[Note]]')).toBe('Note');
    expect(t('[x](/vault/Folder/Note.md)')).toBe('/vault/Folder/Note.md');
    // Spaces: escaped as %20, between <...>, or as written (a path that ends in .md), in markdown and wiki links.
    for (const s of ['[x](Folder/My%20Note.md)', '[x](<Folder/My Note.md>)', '[x](Folder/My Note.md)', '[[Folder/My Note]]', '[[Folder/My%20Note]]']) expect(t(s)).toMatch(/^Folder\/My Note(\.md)?$/);
    expect(mdInline('[x](Folder/My Note.md#Next steps)', V)).toBe('<span class="md-wl pend" data-vl-t="Folder/My Note.md" data-vl-a="Next steps">x</span>');
    // Prose in brackets with spaces is still text.
    expect(mdInline('[a](n = 12) and [0.1, 0.2] (n = 3)', V)).toBe('[a](n = 12) and [0.1, 0.2] (n = 3)');
    expect(mdVaultTarget('md', './plan.md', { alias: 'vault' })).toBeNull();
    expect(mdVaultTarget('md', 'plan.md', {})).toBeNull();
  });

  it('keeps fragment anchors and decodes link URLs', () => {
    expect(mdVaultTarget('md', '../Plan%20B.md#Next%20steps', V)).toEqual({ link: '../Plan B.md', anchor: 'Next steps' });
    expect(mdVaultTarget('md', 'plan.md?x=1#Goal', V)).toEqual({ link: 'plan.md', anchor: 'Goal' });
    expect(mdVaultTarget('wiki', 'Plan#Risks', V)).toEqual({ link: 'Plan', anchor: 'Risks' });
    expect(mdVaultTarget('wiki', 'Folder/Plan', V)).toEqual({ link: 'Folder/Plan', anchor: '' });
    expect(mdVaultTarget('wiki', '#Risks', V)).toEqual({ path: V.from, anchor: 'Risks' });
    expect(mdVaultTarget('wiki', 'Plan', {})).toBeNull();
    expect(mdInline('[[Plan#Risks|risks]] [up](../Plan.md#Goal)', V))
      .toBe('<span class="md-wl pend" data-vl-t="Plan" data-vl-a="Risks">risks</span> <span class="md-wl pend" data-vl-t="../Plan.md" data-vl-a="Goal">up</span>');
    // Without a label, a heading link reads as Obsidian shows it.
    expect(mdInline('[[Plan#Risks]] [[#Risks]]', V)).toBe('<span class="md-wl pend" data-vl-t="Plan" data-vl-a="Risks">Plan &gt; Risks</span> <span class="md-wl pend" data-vl-p="/vault/Projects/X/Notes/today.md" data-vl-a="Risks">Risks</span>');
  });

  it('treats #Heading as a heading of the note, and #type/arg as a console route', () => {
    expect(mdInline('[see](#Results)', V)).toBe(`<span class="md-wl pend" data-vl-p="${V.from}" data-vl-a="Results">see</span>`);
    expect(mdInline('[task](#task/task_x)', V)).toBe('<a href="#task/task_x">task</a>');
    expect(mdInline('[see](#Results)')).toBe('<a href="#Results">see</a>');
  });

  it('gives headings an anchor that matches Obsidian and GitHub style fragments', () => {
    expect(mdSlug('Next steps!')).toBe('next-steps');
    expect(mdSlug('next-steps')).toBe('next-steps');
    expect(mdSlug('Ação · 2')).toBe('ação-2');
    expect(mdRender('## **Next** steps', V)).toBe('<h2 data-anchor="next-steps"><strong>Next</strong> steps</h2>');
    expect(mdRender('## "><img>', V)).toBe('<h2 data-anchor="img">&quot;&gt;&lt;img&gt;</h2>');
  });

  it('shows every link as its label on a compact row', () => {
    expect(mdInline('**Done** [docs](https://e.org) [[Plan]] [t](#task/x) `id`', { links: false })).toBe('<strong>Done</strong> docs Plan t <code>id</code>');
  });

  it('renders Markdown acceptance criteria as a document, with no script scheme', () => {
    const html = mdRender('The **operator** sees:\n- the `key`\n- [a link](javascript:alert(1))', V).replace(/\n/g, '');
    expect(html).toBe('<p>The <strong>operator</strong> sees:</p><ul><li>the <code>key</code></li><li>a link</li></ul>');
  });
});

describe('md.js safety under arbitrary input', () => {
  const alphabet = fc.constantFrom('<', '>', '"', "'", '&', '`', '*', '_', '[', ']', '(', ')', '|', '\\', '#', '-', '!', ':', '\n', ' ', 'a', '1', 'javascript:', 'https://x.y/', 'script', 'on', '=', '<br>', '\u0000');
  it('never emits a tag or attribute it did not build', () => {
    fc.assert(fc.property(fc.array(alphabet, { maxLength: 80 }).map((a) => a.join('')), fc.boolean(), (s, inNote) => {
      // With and without a vault context (a note's links become pending spans with data attributes).
      const html = mdRender(s, inNote ? V : undefined);
      // Every tag is one the renderer makes; every href is http(s), a #route or the vault "#".
      for (const [, tag] of html.matchAll(/<\/?([a-zA-Z0-9]+)/g)) expect(['p', 'br', 'strong', 'em', 'del', 'mark', 'code', 'pre', 'a', 'span', 'svg', 'use', 'ul', 'ol', 'li', 'input', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'blockquote', 'div', 'b', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'dl', 'dt', 'dd']).toContain(tag);
      for (const [, href] of html.matchAll(/ href="([^"]*)"/g)) expect(href).toMatch(/^(https?:\/\/|#)/);
      // No event handler attribute: every " in the output delimits an attribute value (text quotes are &quot;), so the
      // values (a link's target, kept in data-vl-*) are dropped before looking at the attribute names.
      expect(html.replace(/"[^"]*"/g, '""')).not.toMatch(/<[^>]*\son\w+=/i);
      expect(html).not.toContain('\u0000');
    }), { numRuns: 400 });
  });
});

describe('mdPlain (one-line previews)', () => {
  it('drops marks, link targets, list markers and escapes', () => {
    expect(mdPlain('**Lead handover (11 Nov ~09:xx):** new Lead `x` [docs](https://e.org) [[Plan|the plan]] σ_b \\*')).toBe('Lead handover (11 Nov ~09:xx): new Lead x docs the plan σ_b *');
    expect(mdPlain('**Doing:**\n- one\n- two\n\n1. three')).toBe('Doing: one two three');
    expect(mdPlain('CP 95 % [0.039, 0.068] and [[0.1, 0.2]]')).toBe('CP 95 % [0.039, 0.068] and [[0.1, 0.2]]');
    expect(mdPlain('## Title\n```js\ncode\n```')).toBe('Title code');
    // Escaped marks and code spans keep their characters: nothing in them is stripped as emphasis.
    expect(mdPlain('\\*not em\\* and \\_x\\_')).toBe('*not em* and _x_');
    expect(mdPlain('run `a **b** _c_` now')).toBe('run a **b** _c_ now');
  });
});

describe('md.js is served with the console', () => {
  it('serves /md.js as JavaScript and app.js imports it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ah-md-'));
    mkdirSync(join(dir, 'vault'));
    const app = await buildApp(testConfig(dir));
    try {
      const res = await app.fastify.inject({ method: 'GET', url: '/md.js' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/^text\/javascript/);
      expect(res.body).toBe(readFileSync(join(process.cwd(), 'public', 'md.js'), 'utf8'));
    } finally { await app.close(); }
    expect(readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8')).toMatch(/^import \{[^}]*\bmdRender\b[^}]*\} from '\.\/md\.js';/m);
  });

  it('serves its own copy of the Mermaid library, never a CDN', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ah-md-'));
    mkdirSync(join(dir, 'vault'));
    const app = await buildApp(testConfig(dir));
    try {
      const res = await app.fastify.inject({ method: 'GET', url: '/vendor/mermaid.min.js' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/^text\/javascript/);
      expect(res.body.length).toBeGreaterThan(100_000);
    } finally { await app.close(); }
    const js = readFileSync(join(process.cwd(), 'public', 'app.js'), 'utf8');
    expect(js).toContain("s.src = '/vendor/mermaid.min.js'");
    expect(js).toContain("securityLevel: 'strict'");
    expect(js).not.toMatch(/https?:\/\/[^'"]*mermaid/);
  });

  it('pins Mermaid 12, whose KaTeX has no known audit findings', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
    expect(pkg.dependencies.mermaid).toMatch(/^12\.\d+\.\d+$/); // exact: a dependency change is the operator's call
    const req = createRequire(import.meta.url);
    const mermaidPkg = req.resolve('mermaid/package.json');
    expect(JSON.parse(readFileSync(mermaidPkg, 'utf8')).version).toBe(pkg.dependencies.mermaid);
    // Mermaid 11 pulled KaTeX 0.16, flagged by npm audit; the fix is KaTeX 0.18 or later.
    const katex = JSON.parse(readFileSync(createRequire(mermaidPkg).resolve('katex/package.json'), 'utf8')).version.split('.').map(Number);
    expect(katex[0] > 0 || katex[1]! >= 18).toBe(true);
  });
});
