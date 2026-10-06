// Markdown for file previews, in the browser (the web UI imports this file as it is) and checkable
// on its own:   node web/markdown.mjs
//
// Small on purpose: headings, paragraphs, lists, quotes, rules, fenced code, tables, and inline
// bold / italic / code / links. Everything is escaped first, links must be http(s), and no images
// are loaded — a preview must not fetch from wherever a document points.
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

export function renderMarkdown(src) {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n')
  const out = []
  let i = 0
  const isTableSep = l => /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(l) && l.includes('|')
  const cells = l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim())
  while (i < lines.length) {
    const l = lines[i]
    if (/^\s*```/.test(l)) {
      const body = []
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) body.push(lines[i])
      i++
      out.push(`<pre><code>${escHtml(body.join('\n'))}</code></pre>`)
    } else if (/^\s*$/.test(l)) i++
    else if (/^#{1,6}\s/.test(l)) {
      const n = /^#+/.exec(l)[0].length
      out.push(`<h${n}>${inline(l.slice(n).trim())}</h${n}>`); i++
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { out.push('<hr>'); i++ }
    else if (/^\s*>/.test(l)) {
      const body = []
      for (; i < lines.length && /^\s*>/.test(lines[i]); i++) body.push(lines[i].replace(/^\s*>\s?/, ''))
      out.push(`<blockquote>${renderMarkdown(body.join('\n'))}</blockquote>`)
    } else if (/^\s*([-*+]|\d+[.)])\s+/.test(l)) {
      const ordered = /^\s*\d/.test(l)
      const items = []
      for (; i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i]); i++) {
        const t = lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, '')
        const task = /^\[([ xX])\]\s+/.exec(t)
        items.push(`<li>${task ? `<input type="checkbox" disabled${task[1] !== ' ' ? ' checked' : ''}> ` : ''}${inline(task ? t.slice(task[0].length) : t)}</li>`)
      }
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`)
    } else if (l.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = cells(l)
      i += 2
      const rows = []
      for (; i < lines.length && lines[i].includes('|') && lines[i].trim(); i++) rows.push(cells(lines[i]))
      out.push(`<table><thead><tr>${head.map(c => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${
        rows.map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`)
    } else {
      const body = []
      for (; i < lines.length && lines[i].trim() && !/^\s*(```|#{1,6}\s|>|([-*+]|\d+[.)])\s+)/.test(lines[i]); i++) body.push(lines[i])
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
  console.log('markdown: all checks pass')
}
