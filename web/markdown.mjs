// Markdown for agents' messages and file previews, in the browser (the web UI imports this file as it is)
// and checkable on its own:   node web/markdown.mjs
//
// Small on purpose: headings, paragraphs, lists, quotes, rules, fenced code, tables, and inline
// bold / italic / code / links. Everything is escaped first, links must be http(s), and no images
// are loaded — neither a preview nor an agent's message may fetch from wherever its text points.
// The Flutter client has the same reader (app/lib/data/markdown.dart): change both.
const escHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

function inline(s) {
  const codes = []
  let h = escHtml(s).replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`)
  h = h.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`)
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_, a, b) => `<strong>${a ?? b}</strong>`)
    .replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
  return h.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`)
}

const ITEM = /^(\s*)([-*+]|\d+[.)])\s+/

/**
 * `chat: true` is how a chat bubble wants it: a fenced block as `<pre class="cb">` with its language
 * on top (the bubble's own style), and an unfinished fence — a reply still streaming — runs to the end.
 */
export function renderMarkdown(src, opts = {}) {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n')
  const out = []
  let i = 0
  const isTableSep = l => /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(l) && l.includes('|')
  const tableAt = j => lines[j].includes('|') && j + 1 < lines.length && isTableSep(lines[j + 1])
  const cells = l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim())
  while (i < lines.length) {
    const l = lines[i]
    if (/^\s*```/.test(l)) {
      const lang = l.trim().slice(3).trim().split(/\s+/)[0]
      const body = []
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) body.push(lines[i])
      i++
      out.push(opts.chat
        ? `<pre class="cb">${lang ? `<b>${escHtml(lang)}</b>` : ''}<code>${escHtml(body.join('\n'))}</code></pre>`
        : `<pre><code>${escHtml(body.join('\n'))}</code></pre>`)
    } else if (/^\s*$/.test(l)) i++
    else if (/^#{1,6}\s/.test(l)) {
      const n = /^#+/.exec(l)[0].length
      out.push(`<h${n}>${inline(l.slice(n).trim())}</h${n}>`); i++
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { out.push('<hr>'); i++ }
    else if (/^\s*>/.test(l)) {
      const body = []
      for (; i < lines.length && /^\s*>/.test(lines[i]); i++) body.push(lines[i].replace(/^\s*>\s?/, ''))
      out.push(`<blockquote>${renderMarkdown(body.join('\n'), opts)}</blockquote>`)
    } else if (ITEM.test(l)) {
      const first = ITEM.exec(l)
      const ordered = /\d/.test(first[2])
      // Models write "1. …", a blank line, "2. …": each is a list of its own, so it keeps its number.
      const start = ordered ? parseInt(first[2], 10) : 1
      const items = []
      for (; i < lines.length && ITEM.test(lines[i]); i++) {
        const [whole, indent] = ITEM.exec(lines[i])
        const t = lines[i].slice(whole.length)
        const task = /^\[([ xX])\]\s+/.exec(t)
        // Nested items are drawn indented in the same list: two spaces (or a tab) a level, three at most.
        const level = Math.min(3, Math.floor(indent.replace(/\t/g, '  ').length / 2))
        items.push(`<li${level ? ` class="l${level}"` : ''}>${task ? `<input type="checkbox" disabled${task[1] !== ' ' ? ' checked' : ''}> ` : ''}${inline(task ? t.slice(task[0].length) : t)}</li>`)
      }
      out.push(ordered ? `<ol${start !== 1 ? ` start="${start}"` : ''}>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`)
    } else if (tableAt(i)) {
      const head = cells(l)
      i += 2
      const rows = []
      for (; i < lines.length && lines[i].includes('|') && lines[i].trim(); i++) rows.push(cells(lines[i]))
      out.push(`<table><thead><tr>${head.map(c => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${
        rows.map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`)
    } else {
      const body = []
      for (; i < lines.length && lines[i].trim() && !/^\s*(```|#{1,6}\s|>|([-*+]|\d+[.)])\s+)/.test(lines[i]) &&
        !(body.length && tableAt(i)); i++) body.push(lines[i])
      out.push(`<p>${body.map(inline).join('<br>')}</p>`)
    }
  }
  return out.join('\n')
}


// ---------- self-test ----------
if (typeof process !== 'undefined' && import.meta.url === `file://${process.argv[1]}`) {
  const a = (await import('node:assert/strict')).default
  const md = renderMarkdown('# Title\n\nSome **bold**, *it* and `<b>`.\n\n- [x] done\n- todo\n\n1. one\n2. two\n\n```\n<script>x</script>\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n> quote\n\n[ok](https://x.dev) [bad](javascript:alert(1)) ![img](http://evil/x.png)\n---')
  a.match(md, /<h1>Title<\/h1>/)
  a.match(md, /<strong>bold<\/strong>, <em>it<\/em> and <code>&lt;b&gt;<\/code>/)
  a.match(md, /<li><input type="checkbox" disabled checked> done<\/li>/)
  a.match(md, /<ol><li>one<\/li><li>two<\/li><\/ol>/)
  a.match(md, /<pre><code>&lt;script&gt;x&lt;\/script&gt;<\/code><\/pre>/)
  a.match(md, /<table><thead><tr><th>a<\/th><th>b<\/th><\/tr><\/thead><tbody><tr><td>1<\/td><td>2<\/td><\/tr>/)
  a.match(md, /<blockquote><p>quote<\/p><\/blockquote>/)
  a.match(md, /<a href="https:\/\/x.dev"/)
  a.ok(!/href="javascript/.test(md) && !/<img/.test(md) && !/<script/.test(md), 'no script, no javascript: link, no remote image')

  // As a chat bubble draws an agent's reply
  const chat = renderMarkdown('**查证与分析**\n- 阅读代码\n  - 嵌套一层\n- *“对比 A 和 B”*、*“查根因”*\n\n2. second\n\n3. third\n\nText before\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```bash\nls -la\n```\n\n```js\nstill streaming', { chat: true })
  a.match(chat, /^<p><strong>查证与分析<\/strong><\/p>\n<ul><li>阅读代码<\/li><li class="l1">嵌套一层<\/li>/, 'bold line, then a list right under it, nested item indented')
  a.match(chat, /<li><em>“对比 A 和 B”<\/em>、<em>“查根因”<\/em><\/li>/, 'italics between CJK punctuation')
  a.match(chat, /<ol start="2"><li>second<\/li><\/ol>\n<ol start="3"><li>third<\/li><\/ol>/, 'a numbered item after a blank line keeps its number')
  a.match(chat, /<p>Text before<\/p>\n<table>/, 'a table right under a paragraph is a table')
  a.match(chat, /<pre class="cb"><b>bash<\/b><code>ls -la<\/code><\/pre>/)
  a.match(chat, /<pre class="cb"><b>js<\/b><code>still streaming<\/code><\/pre>$/, 'an unfinished fence runs to the end')
  a.match(renderMarkdown('```\nx\n```'), /^<pre><code>x<\/code><\/pre>$/, 'previews keep their plain code blocks')
  console.log('markdown: all checks pass')
}
