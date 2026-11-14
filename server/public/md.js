/* Conclave console: the Markdown renderer for vault notes and agent-written prose (Blueprint bodies, task text, decisions,
   feedback, messages). A small renderer for the Obsidian- and GitHub-flavoured Markdown agents write: frontmatter, headings,
   paragraphs (a single newline is a line break), nested and ordered lists, tasks, tables, quotes and callouts, code, links,
   [[wikilinks]], ![[embeds]], #tags and backslash escapes.
   Safety: every piece of text is escaped before any markup is added; no raw HTML passes (a literal <br> is the one tag
   recognised, and it is re-created, not copied); only http(s) links, in-console #routes and vault notes get an href.
   Vault links (docs/vault.md, Links in notes): the renderer works out each target from the context `{ alias, from }` (the
   vault alias and the note that holds the link) and writes it as a pending `.md-wl.pend` span; app.js asks the hub which
   targets the viewer may see (POST /api/vault/links) and turns each into a link or an unavailable label. Without a vault
   context a vault link is an unavailable label. `links: false` (compact rows, which are buttons) shows every link as its label.
   Plain ES module without DOM access, so vitest imports it (server/test/md-render.test.ts); app.js imports it too. */

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ic = (n) => `<svg class="i "><use href="#i-${n}"/></svg>`;
export const isMarkdown = (path) => /\.(md|markdown)$/i.test(path);
/** The one tooltip of a vault link the viewer cannot open: the same for a missing, hidden or refused target. */
export const MD_UNAVAILABLE = 'Not available';

/* A heading's anchor: its text, lower case, with punctuation dropped and spaces as hyphens ("Next steps" and
   "next-steps" are the same anchor, as in Obsidian and GitHub). */
export const mdSlug = (s) => String(s ?? '').normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/[\s_-]+/g, '-');

/* A link's vault target: { link } (the target as written, %-escapes decoded, for the hub's one resolver) or { path }
   (#Heading: a heading in this note), with its anchor (without #), or null when it cannot point into the vault from
   here. kind is 'wiki' ([[...]]) or 'md' ([label](url)). The hub applies the rules (docs/vault.md, Links in notes):
   / from the vault root, ./ and ../ from the note's folder, anything else from the root, then the note's folder,
   then as the end of a path anywhere the viewer may look. */
export function mdVaultTarget(kind, raw, ctx = {}) {
  if (!ctx.alias) return null;
  const s = String(raw ?? '').trim(), h = s.indexOf('#');
  let target = h < 0 ? s : s.slice(0, h), anchor = h < 0 ? '' : s.slice(h + 1);
  if (kind === 'md') target = target.replace(/\?.*$/, '');
  // A markdown link escapes spaces as %20; a wiki link may too. A malformed %-escape is kept as written.
  if (kind === 'md' || /%[0-9A-Fa-f]{2}/.test(s)) { try { target = decodeURIComponent(target); anchor = decodeURIComponent(anchor); } catch { /* as written */ } }
  target = target.trim().replace(/\\/g, '/'); anchor = anchor.trim();
  if (!target) return ctx.from ? { path: ctx.from, anchor } : null; // #Heading: a heading in this note
  if (target.startsWith('.') && !ctx.from) return null; // a relative link needs a note to start from
  return { link: target, anchor };
}

/* A vault link waiting for the hub's answer; the label is plain text until then. */
function vaultPending(t, inner, ctx) {
  if (ctx.links === false) return inner;
  if (!t) return `<span class="md-wl miss" title="${MD_UNAVAILABLE}">${inner}</span>`;
  const a = t.anchor ? ` data-vl-a="${esc(t.anchor)}"` : '';
  return `<span class="md-wl pend" ${vlAttr(t)}${a}>${inner}</span>`;
}
// An embed (![[x.png]], ![](x.mp3)) names a vault file too: pending like a link, then a .md-embed that carries
// data-vault-embed once the hub says the reader may open it (docs/vault.md, Embeds). Outside a note, or as a label, it is the chip only.
function vaultEmbed(t, label, ctx) {
  const chip = `${ic('file')}${label}`;
  if (ctx.links === false) return `<span class="md-embed">${chip}</span>`;
  if (!t) return `<span class="md-embed miss" title="${MD_UNAVAILABLE}">${chip}</span>`;
  return `<span class="md-embed pend" data-vl-embed ${vlAttr(t)}>${chip}</span>`;
}
// The pending target: data-vl-p for an exact path (a heading in this note), data-vl-t for a link the hub resolves.
const vlAttr = (t) => (t.path ? `data-vl-p="${esc(t.path)}"` : `data-vl-t="${esc(t.link)}"`);
const ctxOf = (c) => (c && typeof c === 'object' ? c : {});

// Placeholders hold finished HTML while the rest of the text is escaped and marked up; NUL never occurs in agent text.
const HOLD_RE = /\u0000(\d+)\u0000/g;
// A code span: an opening run of backticks that no (unescaped) backslash precedes.
const CODE_RE = /(?<=(?:^|[^\\])(?:\\\\)*)(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g;
// A [[...]] or [...] that only holds numbers is an interval or a matrix ("[[0.1, 0.2], [0.3, 0.4]]"), never a link.
const NUMERIC = /^[\s\d.,;:+\-−–eE%×*/^()[\]]+$/u;
const W = '\\p{L}\\p{N}_'; // a word character, in any script (σ_b, μ_0 are not emphasis)
/* Maths (docs/design-guidelines.md, Maths), Pandoc's rule. Display: $$…$$. Inline: $…$ on one line, where the opening $ has
   a non-space right after it and the closing $ a non-space right before it and no digit after it, so "$5 and $10" stays
   text and "$2^n$" is maths. Neither opens on an escaped \$. Code spans are held aside before, so code is never maths. */
const MATH_D = /(?<=(?:^|[^\\])(?:\\\\)*)\$\$((?:\\[\s\S]|[^$\\]|\$(?!\$))+?)\$\$/g;
const MATH_I = /(?<=(?:^|[^\\$])(?:\\\\)*)\$(?=[^\s$])((?:\\[^\n]|[^$\\\n])*?[^\s\\])\$(?![\d$])/g;
/* LaTeX's own delimiters, as papers written in LaTeX use them. \(…\) is inline maths when a matching \) closes it in the same
   paragraph (no blank line between); otherwise it stays an escaped bracket. An escaped \\( never opens. \[…\] is display maths
   only as a block that starts a line and ends one (mdRender below): inside a sentence "\[1\]" is how Markdown writes literal
   brackets, and converters write citations that way. */
const MATH_PI = /(?<=(?:^|[^\\])(?:\\\\)*)\\\(((?:\\[^)\n]|[^\\\n]|\n(?![ \t]*\n))+?)\\\)/g;
const MATH_PDB = /^ {0,3}\\\[((?:\\[^\]\n]|[^\\\n]|\n(?![ \t]*\n))+?)\\\][ \t]*$/gm;
const MATH_AT = [MATH_D, MATH_I, MATH_PI].map((re) => new RegExp(re.source, 'y'));
const MATH_SHOW = { $: ['$', '$'], $$: ['$$', '$$'], '\\(': ['\\(', '\\)'], '\\[': ['\\[', '\\]'] };
/* A formula as an escaped element holding its source: app.js draws it with KaTeX, and a formula that cannot be drawn keeps it,
   in the delimiters it was written with. Nothing inside is Markdown. Its line breaks are &#10;, so a paragraph's <br>s never
   land inside it. */
const mathH = (tex, display, tag = 'span', form = display ? '$$' : '$') => {
  const [o, c] = MATH_SHOW[form], nl = (t) => esc(t).replace(/\n/g, '&#10;');
  return `<${tag} class="md-math${display ? ' md-math-d' : ''}" data-tex="${nl(tex)}">${nl(o + tex + c)}</${tag}>`;
};

/* Emphasis, strike, highlight and #tags on text that is already escaped. */
function marks(s) {
  return s
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
    .replace(new RegExp(`(?<![${W}])__(?=\\S)([\\s\\S]*?\\S)__(?![${W}])`, 'gu'), '<strong>$1</strong>')
    .replace(new RegExp(`(?<![${W}*])\\*(?=[^\\s*])(.*?[^\\s*])\\*(?![${W}*])`, 'gu'), '<em>$1</em>')
    .replace(new RegExp(`(?<![${W}])_(?=[^\\s_])(.*?[^\\s_])_(?![${W}])`, 'gu'), '<em>$1</em>')
    .replace(/~~(?=\S)(.*?\S)~~/g, '<del>$1</del>')
    .replace(/==(?=\S)(.*?\S)==/g, '<mark>$1</mark>')
    .replace(/(^|\s)#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu, '$1<span class="md-tag">#$2</span>');
}

/* One line (or a paragraph joined with \n) of inline Markdown to HTML. ctx: { alias, from, links } (see the header). */
export function mdInline(text, context) {
  const ctx = ctxOf(context), noLinks = ctx.links === false;
  const keep = [], hold = (html) => `\u0000${keep.push(html) - 1}\u0000`;
  const extLink = (url, inner) => (noLinks ? inner : `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${inner}</a>`);
  let s = String(text ?? '').replace(/\u0000/g, '');
  // Code spans first: nothing inside them is Markdown. A run of n backticks closes on the next run of exactly n;
  // an escaped backtick (\`) never opens one.
  s = s.replace(CODE_RE, (_, _t, c) => hold(`<code>${esc(/^ .*\S.* $/s.test(c) ? c.slice(1, -1) : c)}</code>`));
  // Maths next, before escapes, links and marks: a_i keeps its underscore and \alpha its backslash.
  s = s.replace(MATH_D, (m, t) => (t.trim() ? hold(mathH(t.trim(), true)) : m)).replace(MATH_I, (_, t) => hold(mathH(t, false)))
    .replace(MATH_PI, (m, t) => (t.trim() ? hold(mathH(t.trim(), false, 'span', '\\(')) : m));
  // Backslash escapes: the next ASCII punctuation character is literal. A backslash at the end of a line is a hard break.
  s = s.replace(/\\\n/g, () => hold('<br>\n')).replace(/\\([!-/:-@[-`{-~])/g, (_, c) => hold(esc(c)));
  // A literal <br> (common in table cells) is a line break; every other tag stays text.
  s = s.replace(/<br\s*\/?>/gi, () => hold('<br>'));
  s = s.replace(/<(https?:\/\/[^\s<>]+)>/gi, (_, u) => hold(extLink(u, esc(u))));
  s = s.replace(/!\[\[([^\]]+)\]\]/g, (m, t) => (NUMERIC.test(t) ? m : hold(vaultEmbed(mdVaultTarget('wiki', t.split('|')[0], ctx), esc(t.split('|')[0]), ctx))));
  s = s.replace(/\[\[([^\]]+)\]\]/g, (m, t) => {
    if (NUMERIC.test(t)) return m;
    // Without a label, [[Note#Heading]] reads "Note > Heading", as in Obsidian.
    const [target, alias] = t.split('|'), label = esc((alias || target.replace(/\s*#\s*/, ' > ').replace(/^ > /, '')).trim());
    return hold(vaultPending(mdVaultTarget('wiki', target, ctx), label, ctx));
  });
  // [label](url "title"): the url has no spaces (or sits in <...>), so "[0.039, 0.068] (n = 12)" and "[a](n = 12)" stay text.
  // A note path with unescaped spaces, as Obsidian accepts, is a link too: one that ends in .md, with or without #Heading.
  const LINK = /(!?)\[((?:[^\][]|\[[^\][]*\])+)\]\((?:<([^<>\n]*)>|([^()\s]*(?:\([^()\s]*\)[^()\s]*)*)|([^()<>\n"]*?[^\s()<>"]\.md(?:#[^()<>\n"]*)?))(?:\s+"[^"\n]*")?\)/gi;
  s = s.replace(LINK, (m, bang, label, u1, u2, u3) => {
    const url = (u1 ?? u2 ?? u3 ?? '').trim();
    if (!url || NUMERIC.test(label) && !/^(https?:|#)/i.test(url)) return m;
    if (bang) return hold(/^[a-z][\w+.-]*:/i.test(url) || url.startsWith('#') ? `<span class="md-embed">${ic('file')}${esc(label || url)}</span>` : vaultEmbed(mdVaultTarget('md', url, ctx), esc(label || url), ctx));
    const inner = marks(esc(label));
    if (/^https?:\/\//i.test(url)) return hold(extLink(url, inner));
    // In a note, #Heading is a heading of the note; elsewhere a # link is a console route (#task/…, #blueprint/…).
    if (url.startsWith('#') && !(ctx.from && !url.includes('/'))) return hold(noLinks ? inner : `<a href="${esc(url)}">${inner}</a>`);
    if (/^[a-z][\w+.-]*:/i.test(url)) return hold(inner); // javascript:, data:, mailto: and every other scheme: the label only
    // A vault link: relative to the note, or from the vault root (docs/vault.md, Links in notes).
    return hold(vaultPending(mdVaultTarget('md', url, ctx), inner, ctx));
  });
  // Bare URLs, without the sentence's closing punctuation or an unbalanced closing parenthesis.
  s = s.replace(/\bhttps?:\/\/[^\s<>"\u0000`]+/g, (u) => {
    let tail = '', open = (u.match(/\(/g) || []).length, close = (u.match(/\)/g) || []).length;
    for (;;) {
      const last = u.at(-1);
      if (/[.,;:!?'*_~\]]/.test(last) || (last === ')' && open < close)) { if (last === ')') close--; tail = last + tail; u = u.slice(0, -1); } else break;
    }
    return hold(extLink(u, esc(u))) + tail;
  });
  s = marks(esc(s));
  const restore = (t) => t.replace(HOLD_RE, (_, i) => restore(keep[+i]));
  return restore(s);
}

/* YAML frontmatter as properties; only when the block really is key: value lines. */
export function mdFrontmatter(src) {
  const m = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(src); if (!m) return { props: [], body: src };
  const props = []; let cur = null;
  for (const line of m[1].split('\n')) {
    const kv = /^([\w .-]+):\s*(.*)$/.exec(line), item = /^\s+-\s+(.*)$/.exec(line);
    if (kv) { cur = { key: kv[1].trim(), values: [] }; props.push(cur); const v = kv[2].trim(); if (v.startsWith('[') && v.endsWith(']')) cur.values.push(...v.slice(1, -1).split(',').map((x) => x.trim()).filter(Boolean)); else if (v) cur.values.push(v); }
    else if (item && cur) cur.values.push(item[1].trim());
    else if (line.trim() && !line.trim().startsWith('#')) return { props: [], body: src }; // not frontmatter: a rule, text, a rule
  }
  if (!props.length) return { props: [], body: src };
  for (const p of props) p.values = p.values.map((v) => v.replace(/^["']|["']$/g, ''));
  return { props, body: src.slice(m[0].length) };
}

const FENCE = /^(\s*)(`{3,}|~{3,})\s*([\w+#.-]*)/;
const LI = /^(\s*)([-*+]|(\d{1,9})[.)])(?:[ \t]+(.*)|[ \t]*$)/;
const HR = /^ {0,3}([-*_])([ \t]*\1){2,}[ \t]*$/;
const indentOf = (l) => /^\s*/.exec(l)[0].replace(/\t/g, '    ').length;
// Table cells: split on pipes that are neither escaped nor inside a code span.
function cells(l) {
  const out = []; let cur = '', tick = 0;
  const t = l.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === '\\' && t[i + 1] === '|') { cur += tick ? '|' : '\\|'; i++; continue; }
    if (c === '`') { let n = 1; while (t[i + n] === '`') n++; tick = tick === n ? 0 : tick || n; cur += '`'.repeat(n); i += n - 1; continue; }
    if ((c === '$' || c === '\\' && t[i + 1] === '(') && !tick) { // a formula is one piece: a | inside it never splits the cell
      const m = MATH_AT.map((re) => { re.lastIndex = i; return re.exec(t); }).find(Boolean);
      if (m) { cur += m[0]; i += m[0].length - 1; continue; }
    }
    if (c === '|' && !tick) { out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  out.push(cur.trim());
  return out;
}
const SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/* A Markdown document (or agent text) to HTML. */
export function mdRender(src, context) {
  const ctx = ctxOf(context);
  const { props, body } = mdFrontmatter(String(src ?? '').replace(/\r\n?/g, '\n'));
  const lines = body.split('\n'), out = [], inl = (t) => mdInline(t, ctx);
  // Paragraph lines keep their breaks (Obsidian and GitHub comments show a single newline as a new line).
  const lineBreaks = (L) => inl(L.map((l) => l.trim()).join('\n')).replace(/(<br>)?\n/g, '<br>\n');
  // A ```mermaid block keeps its code (the fallback) and is marked md-mermaid: app.js draws it as a diagram.
  const code = (lang, L) => `<pre class="md-code${/^mermaid$/i.test(String(lang ?? '').trim().split(/\s/)[0]) ? ' md-mermaid' : ''}"${lang ? ` data-lang="${esc(lang)}"` : ''}><code>${esc(L.join('\n'))}</code></pre>`;
  // Reads a fenced block starting at lines[i]; returns [html, index of the closing line].
  const fenced = (i, f) => {
    const L = [], ind = f[1].length, close = new RegExp(`^\\s*${f[2][0] === '`' ? '`' : '~'}{${f[2].length},}\\s*$`);
    while (++i < lines.length && !close.test(lines[i])) L.push(lines[i].replace(new RegExp(`^ {0,${ind}}`), ''));
    return [code(f[3], L), i];
  };
  let para = [];
  const flush = () => { if (para.length) { out.push(`<p>${lineBreaks(para)}</p>`); para = []; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^ {0,3}(`{3,}|~{3,})/.test(line) && FENCE.exec(line);
    if (fence) { flush(); const [h, j] = fenced(i, fence); out.push(h); i = j; continue; }
    if (!line.trim()) { flush(); continue; }
    // Display maths: a line that starts with $$ (or \[), closed on it or on a later line that ends with $$ (or \]), with no
    // blank line between.
    const dm = /^ {0,3}(\$\$|\\\[)(.*)$/.exec(line);
    if (dm) {
      const close = dm[1] === '$$' ? '$$' : '\\]', end = (l) => l.trimEnd().endsWith(close);
      let tex = null, j = i;
      if (end(dm[2]) && dm[2].trimEnd().length >= close.length) tex = dm[2].trimEnd().slice(0, -close.length);
      else if (!dm[2].includes(close)) {
        const L = [dm[2]];
        while (++j < lines.length && lines[j].trim() && !end(lines[j])) L.push(lines[j]);
        if (j < lines.length && end(lines[j])) { L.push(lines[j].trimEnd().slice(0, -close.length)); tex = L.join('\n'); }
      }
      if (tex !== null && tex.trim() && !tex.includes(close)) { flush(); out.push(mathH(tex.trim(), true, 'div', dm[1])); i = j; continue; }
    }
    const h =/^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
    // data-anchor, not id: a note's headings never clash with the console's own ids (#Heading links scroll to it).
    if (h) { flush(); const slug = mdSlug(mdPlain(h[2])); out.push(`<h${h[1].length}${slug ? ` data-anchor="${esc(slug)}"` : ''}>${inl(h[2])}</h${h[1].length}>`); continue; }
    if (HR.test(line)) { flush(); out.push('<hr>'); continue; }
    if (/^\s*>/.test(line)) {
      flush(); const q = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''));
      i--;
      const call = /^\[!(\w+)\][+-]?\s*(.*)$/.exec(q[0] || '');
      const inner = mdRender(call ? q.slice(1).join('\n') : q.join('\n'), ctx);
      out.push(call ? `<div class="md-callout k-${esc(call[1].toLowerCase())}"><b>${inl(call[2] || call[1])}</b>${inner}</div>` : `<blockquote>${inner}</blockquote>`); continue;
    }
    if (line.includes('|') && i + 1 < lines.length && SEP.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const head = cells(line), sep = cells(lines[i + 1]);
      if (sep.length === head.length && (head.length > 1 || line.includes('|'))) {
        flush(); const rows = []; i += 2;
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
        i--;
        const al = sep.map((c) => (/^:-+:$/.test(c) ? ' ac' : /^-+:$/.test(c) ? ' ar' : ''));
        // Short cells (dates, names, numbers) never wrap mid-word; long ones wrap at a minimum width, and the table scrolls inside its own box.
        const td = (tag, c, j) => { const cls = (c.length <= 24 ? 'nw' : '') + al[j]; return `<${tag}${cls.trim() ? ` class="${cls.trim()}"` : ''}>${inl(c)}</${tag}>`; };
        out.push(`<div class="tscroll"><table class="md-table"><thead><tr>${head.map((c, j) => td('th', c, j)).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${head.map((_, j) => td('td', r[j] ?? '', j)).join('')}</tr>`).join('')}</tbody></table></div>`);
        continue;
      }
    }
    if (LI.test(line) && !HR.test(line)) { flush(); i = list(i); continue; }
    para.push(line);
  }
  flush();

  // A list, nested by indentation; blank lines between items keep one list (so "1." "2." "3." do not all read 1.).
  function list(i) {
    const stack = []; // { depth, tag, content } — content: the column where the item's text starts
    let item = null; // lines of the current item's text, not yet written
    const writeItem = () => { if (item) { out.push(item.task ? `<li class="md-task"><input type="checkbox" disabled${item.task[1] !== ' ' ? ' checked' : ''}> ${lineBreaks(item.text)}` : `<li>${lineBreaks(item.text)}`); item = null; } };
    let blank = false;
    for (; i < lines.length; i++) {
      const l = lines[i];
      if (!l.trim()) { blank = true; continue; }
      const m = HR.test(l) ? null : LI.exec(l), ind = indentOf(l);
      if (m) {
        const depth = ind, tag = m[3] !== undefined ? 'ol' : 'ul', text = m[4] ?? '';
        if (blank && stack.length && depth < stack[0].depth) break;
        writeItem();
        while (stack.length && depth < stack.at(-1).depth) out.push(`</li></${stack.pop().tag}>`);
        const top = stack.at(-1);
        if (top && depth === top.depth && tag !== top.tag) { out.push(`</li></${stack.pop().tag}>`); }
        const now = stack.at(-1);
        if (!now || depth > now.depth) { out.push(`<${tag}${tag === 'ol' && +m[3] !== 1 ? ` start="${+m[3]}"` : ''}>`); stack.push({ depth, tag, content: depth + m[2].length + 1 }); }
        else { out.push('</li>'); now.content = depth + m[2].length + 1; }
        const task = /^\[([ xX])\][ \t]+(.*)$/.exec(text);
        item = { text: [task ? task[2] : text], task };
        blank = false; continue;
      }
      const f = FENCE.exec(l);
      if (stack.length && ind >= 2 && f) { writeItem(); const [h, j] = fenced(i, f); out.push(h); i = j; blank = false; continue; }
      // Text indented under an item belongs to it: a new line, or after a blank line a new paragraph inside the item.
      if (stack.length && ind >= 2) {
        if (blank) { writeItem(); out.push(`<p>${lineBreaks([l])}</p>`); }
        else if (item) item.text.push(l);
        else out.push(`<br>${lineBreaks([l])}`);
        blank = false; continue;
      }
      // An unindented line ends the list: agents write "- last item\nNext sentence." and mean a new paragraph.
      break;
    }
    writeItem();
    while (stack.length) out.push(`</li></${stack.pop().tag}>`);
    return i - 1;
  }

  const propsH = props.length ? `<dl class="md-props">${props.map((p) => `<dt>${esc(p.key)}</dt><dd>${p.values.map((v) => `<span class="tag">${inl(v)}</span>`).join('') || '—'}</dd>`).join('')}</dl>` : '';
  return propsH + out.join('\n');
}

/* Markdown to plain text, for one-line previews (row meta, titles): marks, link targets and escapes dropped. The caller escapes it. */
export function mdPlain(src) {
  // Code spans and escaped characters are held aside first, so the mark stripping below never touches them.
  const keep = [], hold = (t) => `\u0000${keep.push(t) - 1}\u0000`;
  return String(src ?? '').replace(/\u0000/g, '').replace(/\r\n?/g, '\n')
    .replace(/^ {0,3}(`{3,}|~{3,}).*$/gm, '')
    .replace(/^\s*(#{1,6}[ \t]+|>\s?|[-*+][ \t]+\[[ xX]\][ \t]+|[-*+][ \t]+|\d{1,9}[.)][ \t]+)/gm, '')
    .replace(/^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/gm, '')
    .replace(CODE_RE, (_, _t, c) => hold(c))
    .replace(MATH_D, (m, t) => (t.trim() ? hold(t.trim()) : m)).replace(MATH_I, (_, t) => hold(t)) // a formula: its source, without the $
    .replace(MATH_PDB, (m, t) => (t.trim() ? hold(t.trim()) : m)).replace(MATH_PI, (m, t) => (t.trim() ? hold(t.trim()) : m)) // or \( \)
    .replace(/\\([!-/:-@[-`{-~])/g, (_, c) => hold(c))
    .replace(/!?\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (m, t, a) => (NUMERIC.test(t) ? m : a || t))
    .replace(/!?\[((?:[^\][]|\[[^\][]*\])+)\]\((?:<[^<>\n]*>|[^()\s]*(?:\([^()\s]*\)[^()\s]*)*)(?:\s+"[^"\n]*")?\)/g, '$1')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '$1')
    .replace(new RegExp(`(?<![${W}])__(?=\\S)([\\s\\S]*?\\S)__(?![${W}])`, 'gu'), '$1')
    .replace(new RegExp(`(?<![${W}*])\\*(?=[^\\s*])(.*?[^\\s*])\\*(?![${W}*])`, 'gu'), '$1')
    .replace(new RegExp(`(?<![${W}])_(?=[^\\s_])(.*?[^\\s_])_(?![${W}])`, 'gu'), '$1')
    .replace(/~~(?=\S)(.*?\S)~~/g, '$1').replace(/==(?=\S)(.*?\S)==/g, '$1')
    .replace(HOLD_RE, (_, i) => keep[+i])
    .replace(/\s+/g, ' ').trim();
}
