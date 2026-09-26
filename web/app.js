import { lang, t, setLang, applyDom, LANG_NAMES } from './i18n.js'

const $ = s => document.querySelector(s)
const K = new URLSearchParams(location.search).get('k')
const api = p => K ? `${p}${p.includes('?') ? '&' : '?'}k=${K}` : p
// Every request carries the UI language so the server answers errors in it
const fetch = (url, o = {}) => window.fetch(url, { ...o, headers: { ...o.headers, 'X-Lang': lang } })
// URLs that can't carry headers (<img> streams, WebSocket) get it as a query param
const withLang = u => `${u}${u.includes('?') ? '&' : '?'}lang=${encodeURIComponent(lang)}`

applyDom()
$('#bwimg').alt = t('bw.alt')
$('#lang').innerHTML = Object.entries(LANG_NAMES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')
$('#lang').value = lang
$('#lang').onchange = e => setLang(e.target.value)
const listJoin = xs => xs.join(t('common.sep'))
const quote = s => t('common.quote', { s })
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]))

// ═══ Appearance: system / light / dark ═══
// The <head> script has already applied the stored choice; this only keeps it
// in sync afterwards. "system" stays live — the listener flips the attribute
// when the OS does, with no reload.
const media = matchMedia('(prefers-color-scheme: light)')
const readTheme = () => { try { return localStorage.getItem('ma_theme') || 'system' } catch { return 'system' } }
const paintTheme = () => {
  const choice = readTheme()
  document.documentElement.dataset.theme = choice === 'system' ? (media.matches ? 'light' : 'dark') : choice
}
media.addEventListener('change', paintTheme)
$('#theme').innerHTML = ['system', 'light', 'dark']
  .map(v => `<option value="${v}">${esc(t('theme.' + v))}</option>`).join('')
$('#theme').value = readTheme()
$('#theme').onchange = e => {
  try { localStorage.setItem('ma_theme', e.target.value) } catch {}
  paintTheme()
}

// ═══ Collapsing the sidebar ═══
// Collapsed it is still the conversation list: same avatars, same recency
// order. Names come back on hover or focus, from one floating tip — the list
// scrolls, so a tip inside a row would be clipped by it.
const railOn = () => document.documentElement.classList.contains('rail')
function setRail(on) {
  document.documentElement.classList.toggle('rail', on)
  try { localStorage.setItem('ma_rail', on ? '1' : '0') } catch {}
  $('#collapseicon').textContent = on ? '\u00bb' : '\u00ab'
  const label = t(on ? 'side.expand' : 'side.collapse')
  $('#collapse').querySelector('span').textContent = label
  $('#collapse').dataset.tip = label
  hideTip()
}
$('#collapse').onclick = () => setRail(!railOn())
$('#railnew').onclick = () => $('#newconv').click()
// A search box you cannot type in is a dead control, so the rail's magnifier
// opens the sidebar and puts the cursor in the real one.
$('#railsearch').onclick = () => { setRail(false); $('#q').focus() }
document.addEventListener('keydown', e => {
  // Not while the Agent's browser is open: there Ctrl+B belongs to their page.
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.key.toLowerCase() !== 'b') return
  if (!$('#bwfull').hidden) return
  e.preventDefault(); setRail(!railOn())
})

const tip = $('#tip')
const hideTip = () => { tip.hidden = true }
function showTip(el) {
  const text = el.dataset.tip || (el.dataset.tipKey ? t(el.dataset.tipKey) : '')
  if (!text || !railOn()) return
  const r = el.getBoundingClientRect()
  tip.textContent = text
  tip.style.top = `${r.top + r.height / 2}px`
  tip.style.left = `${r.right + 8}px`
  tip.hidden = false
}
for (const ev of ['mouseover', 'focusin']) $('aside').addEventListener(ev, e => {
  const el = e.target.closest?.('[data-tip],[data-tip-key]')
  el ? showTip(el) : hideTip()
})
for (const ev of ['mouseleave', 'focusout']) $('aside').addEventListener(ev, hideTip)
window.addEventListener('blur', hideTip)

// Paints the toggle's icon and label for the state the <head> script restored.
setRail(railOn())

let BOTS = [], CONVS = [], cur = null, busy = false, filter = ''
const bot = id => BOTS.find(b => b.id === id)

// Times like an IM: time of day for today, weekday within a week, date otherwise
const hm = d => d.toLocaleTimeString(lang, { hour:'2-digit', minute:'2-digit' })
function when(ms) {
  if (!ms) return ''
  const d = new Date(ms), now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) return hm(d)
  const days = Math.round((now - d) / 86400000)
  if (days < 7) return d.toLocaleDateString(lang, { weekday:'short' })
  return d.toLocaleDateString(lang, { month:'numeric', day:'numeric' })
}

// Colors go into a style attribute: only #RRGGBB passes, anything else becomes grey.
// The server validates too; a color with a quote in it would be executable HTML.
const errText = async r => { const s = await r.text(); try { return JSON.parse(s).error ?? s } catch { return s } }
const col = c => (/^#[0-9a-fA-F]{6}$/.test(c ?? '') ? c : '#555')

// Group avatar = stacked member avatars + "+N", like Grok Bot
function avatar(c, cls = 'av') {
  if (c.kind === 'group') {
    const cs = (c.colors ?? []).slice(0, 3)
    const stack = cs.map((color, i) =>
      `<i style="background:${col(color)};left:${i * 9}px;top:${i % 2 ? 12 : 0}px"></i>`).join('')
    const more = (c.members?.length ?? 0) > 3 ? `<span class="more">+${c.members.length - 3}</span>` : ''
    return `<div class="${cls} stack">${stack}${more}</div>`
  }
  const b = bot(c.id) ?? {}
  return `<div class="${cls}" style="background:${col(c.color ?? b.color)}">${esc((c.name ?? '?').slice(0,1))}</div>`
}

// ═══ Left column ═══
function renderConvs() {
  const box = $('#convs'); box.innerHTML = ''
  const list = CONVS.filter(c => !filter ||
    (c.name + c.tag + c.preview).toLowerCase().includes(filter.toLowerCase()))
  if (!list.length) { box.innerHTML = `<div style="padding:14px;color:var(--dim2);font-size:12.5px">${esc(t('side.noMatch'))}</div>`; return }
  for (const c of list) {
    const on = cur && cur.kind === c.kind && cur.id === c.id
    const el = document.createElement('div')
    el.className = 'conv' + (on ? ' on' : '')
    // Reachable by keyboard, and collapsed the name is all there is to go on.
    el.tabIndex = 0
    el.setAttribute('role', 'button')
    el.dataset.tip = c.name
    el.innerHTML = `${avatar(c)}
      <div class="cbody">
        <div class="crow">
          <span class="cname">${esc(c.name)}</span>
          ${c.tag ? `<span class="tag">${esc(c.tag.length > 14 ? c.tag.slice(0,13) + '…' : c.tag)}</span>` : ''}
          <span class="ctime">${when(c.at)}</span>
        </div>
        <div class="cprev">${esc(c.preview) || `<span style="color:var(--dim2)">${esc(t('side.noMessages'))}</span>`}</div>
      </div>`
    el.onclick = () => openConv(c)
    el.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openConv(c) } }
    box.appendChild(el)
  }
}

$('#q').oninput = e => { filter = e.target.value; renderConvs() }

// ═══ Opening a conversation ═══
// +1 on every open. Anything async (late history, a still-streaming reply) whose ticket
// doesn't match belongs to a conversation no longer on screen and must not be drawn.
let shown = 0

async function openConv(c) {
  wsLeave()
  const ticket = ++shown
  cur = { kind: c.kind, id: c.id }
  const log = $('#log'); log.innerHTML = ''
  $('#hav').outerHTML = avatar(c).replace('class="av', 'id="hav" class="av')
  $('#htitle').textContent = c.name
  $('#hsub').textContent = c.kind === 'group'
    ? t('head.groupSub', { members: listJoin(c.members.map(id => bot(id)?.name ?? id)) })
    : (c.tag || '')
  $('#in').placeholder = t(c.kind === 'group' ? 'comp.toGroup' : 'comp.toAgent', { name: c.name })
  renderMembers(c)
  renderSpend(c)
  loadMemory(c)
  loadRoutines()
  loadBotSkills()
  loadBrowsers()

  if (!await drawHistory(c, ticket)) return
  renderConvs(); $('#in').focus(); $('#send').disabled = busy
}

/** Fetch history and redraw it all. Returns false if the user has switched away. */
async function drawHistory(c, ticket) {
  const hist = await (await fetch(api(c.kind === 'group' ? `/api/groups/${c.id}/messages` : `/api/dm/${c.id}`))).json()
  if (ticket !== shown) return false                  // two quick clicks: the earlier one arrived late, drop it
  const log = $('#log'); log.innerHTML = ''
  for (const e of hist) {
    if (e.role === 'tool') {
      finishTool(toolLine(BOTS.find(b => b.name === e.speaker)?.id ?? c.id, toolLabel(e.name, e.args)), e.output)
      continue
    }
    // 'User' is the speaker the server stores for the person in group logs, 'Studio' the studio's notices
    // (both data, not UI text). A Studio notice is a user-role row but not something *you* said.
    if (c.kind === 'group' && e.speaker === 'Studio') bubble(null, false, t('st.speaker')).innerHTML = fmt(e.text)
    else if (c.kind === 'group') bubble(BOTS.find(b => b.name === e.speaker)?.id ?? null, e.role === 'user' || e.speaker === 'User').innerHTML = fmt(e.text)
    // In a DM, a user-role row from "Studio" is a work order the studio sent this crew member.
    else if (e.speaker === 'Studio') bubble(null, false, t('st.speaker')).innerHTML = fmt(e.content)
    else bubble(c.id, e.role === 'user').innerHTML = fmt(e.content)
  }
  if (!log.children.length) empty(c)
  log.scrollTop = log.scrollHeight
  return true
}

function empty(c) {
  $('#log').innerHTML = c.kind === 'group'
    ? `<div class="empty"><h2>${esc(c.name)}</h2><p>${esc(t('empty.groupMembers', { members: listJoin(c.members.map(id => bot(id)?.name ?? id)) }))}</p>
       <p>${esc(t('empty.groupHow'))}</p></div>`
    : `<div class="empty"><h2>${esc(c.name)}</h2><p>${esc(c.tag)}</p>
       <p>${esc(t('empty.agentRecall'))}</p></div>`
}

// ═══ Right column: members ═══
function renderMembers(c) {
  const box = $('#members'); box.innerHTML = ''
  const ids = c.kind === 'group' ? c.members : [c.id]
  for (const id of ids) {
    const b = bot(id); if (!b) continue
    const el = document.createElement('div')
    el.className = 'mem'
    el.innerHTML = `<div class="av" style="background:${col(b.color)}">${esc(b.name.slice(0,1))}</div>
      <span>${esc(b.name)}</span>${c.kind === 'group' && c.lead === id ? `<span class="lead">${esc(t('s2.lead'))}</span>` : ''}${c.kind === 'group' && ids.length > 2 ? `<span class="x" title="${esc(t('s2.remove'))}">×</span>` : ''}`
    el.querySelector('.x')?.addEventListener('click', async ev => {
      ev.stopPropagation()
      await patchGroup(c.id, { members: ids.filter(x => x !== id) })
    })
    el.onclick = ev => { if (!ev.target.classList.contains('x')) editBot(b) }
    box.appendChild(el)
  }
  $('#addmem').style.display = c.kind === 'group' ? '' : 'none'
}

$('#htoggle').onclick = () => $('#side2').classList.toggle('hide')

// ═══ Messages ═══
// Highlight identifiers, and turn @name into a pill with the avatar
function fmt(text) {
  let h = esc(text)
  // Fenced blocks first, otherwise later rules would chew their contents
  h = h.replace(/```(\w*)\n([\s\S]*?)```/g, (_, cl, body) =>
    `<pre class="cb">${cl ? `<b>${cl}</b>` : ''}${body.replace(/\n$/, '')}</pre>`)
  h = h.replace(/`([^`\n]{1,80})`/g, (_, c) => `<code>${c}</code>`)
  for (const b of [...BOTS].sort((x, y) => y.name.length - x.name.length)) {
    const re = new RegExp(`@\\s*${b.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g')
    h = h.replace(re, `<span class="at"><i style="background:${col(b.color)}"></i>${esc(b.name)}</span>`)
  }
  return h
}

function bubble(botId, mine, label = '') {
  const log = $('#log')
  if (log.querySelector('.empty')) log.innerHTML = ''
  const b = bot(botId)
  const el = document.createElement('div')
  el.className = 'msg' + (mine ? ' me' : '')
  el.innerHTML = `<div class="mav" style="background:${mine ? '#5b8cff' : col(b?.color)}">${
    mine ? esc(t('msg.you')) : esc((b?.name ?? label).slice(0,1) || '?')}</div>
    <div class="mwrap"><div class="mname" style="color:${b ? col(b.color) : 'var(--dim)'}">${esc(b?.name ?? label)}</div>
    <div class="bub"></div></div>`
  log.appendChild(el); log.scrollTop = log.scrollHeight
  return el.querySelector('.bub')
}

function toolLabel(name, args = {}) {
  return name === 'bash' ? args.command
    : name === 'read_file' ? t('tool.read', { path: args.path })
    : name === 'write_file' ? t('tool.write', { path: args.path })
    : name === 'browser' ? browserLabel(args) : name
}

/**
 * The card is waiting for a person. The buttons only answer; whether the command then runs is the
 * server's business, so a stale click (the stream already gone) just says so instead of pretending.
 */
function askOn(el, id) {
  if (el.querySelector('.ask')) return
  const box = document.createElement('div')
  box.className = 'ask'
  box.innerHTML = `<span>${esc(t('ap.asks'))}</span>
    <button class="btn" data-ok="0">${esc(t('ap.deny'))}</button>
    <button class="btn pri" data-ok="1">${esc(t('ap.approve'))}</button>`
  box.onclick = async e => {
    const b = e.target.closest('button'); if (!b) return
    box.querySelectorAll('button').forEach(x => x.disabled = true)
    const r = await fetch(api(`/api/approvals/${id}`), { method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({ ok: b.dataset.ok === '1' }) })
    if (!r.ok) { box.textContent = t('ap.gone'); return }
    box.textContent = b.dataset.ok === '1' ? t('ap.approved') : t('ap.denied')
  }
  el.appendChild(box)
  el.scrollIntoView({ block: 'nearest' })
}

/** Fill in a card once its command has finished. Screenshots only exist in the live stream. */
function finishTool(el, output, image) {
  el.classList.remove('run'); el.querySelector('pre').textContent = output ?? ''
  if (image?.startsWith('data:image/')) {
    const img = document.createElement('img'); img.src = image; img.alt = t('tool.screenshot')
    img.onclick = () => window.open().document.write(`<img src="${image}" style="max-width:100%">`)
    el.appendChild(img)
  }
}

function toolLine(botId, label) {
  const log = $('#log')
  if (log.querySelector('.empty')) log.innerHTML = ''
  const b = bot(botId)
  const el = document.createElement('div')
  el.className = 'tool run'
  el.innerHTML = `<div class="th"><i style="background:${col(b?.color)}"></i>${esc(b?.name ?? '')} ${esc(t('tool.exec'))} <code></code></div><pre></pre>`
  el.querySelector('code').textContent = label
  log.appendChild(el); log.scrollTop = log.scrollHeight
  return el
}

function note(text) {
  const log = $('#log')
  if (log.querySelector('.empty')) log.innerHTML = ''
  const el = document.createElement('div'); el.className = 'note'; el.textContent = text
  log.appendChild(el); log.scrollTop = log.scrollHeight
}

const input = $('#in')
input.oninput = () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 170) + 'px' }
input.onkeydown = e => {
  if (mentionKey(e)) return
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send() }
}

// ═══ @ autocomplete: typing @ in a group lists members; ↑↓ to pick, Enter / Tab to insert ═══
let mOpts = [], mSel = 0
function mentionQuery() {
  const m = input.value.slice(0, input.selectionStart).match(/@([^\s@]*)$/)
  return m ? m[1].toLowerCase() : null
}
function renderMention() {
  const box = $('#mention'), q = mentionQuery()
  const c = CONVS.find(x => x.kind === 'group' && x.id === cur?.id)
  mOpts = q === null || !c ? [] : c.members.map(bot).filter(b => b && b.name.toLowerCase().includes(q))
  if (!mOpts.length) { box.classList.add('hide'); return }
  mSel = Math.min(mSel, mOpts.length - 1)
  box.innerHTML = mOpts.map((b, i) => `<div class="${i === mSel ? 'on' : ''}" data-i="${i}">${avatar({ id: b.id, name: b.name })}
    <span>${esc(b.name)}</span><small>${esc(b.description ?? '')}</small></div>`).join('')
  box.classList.remove('hide')
}
function pickMention(b) {
  const pos = input.selectionStart, head = input.value.slice(0, pos).replace(/@[^\s@]*$/, `@${b.name} `)
  input.value = head + input.value.slice(pos)
  input.setSelectionRange(head.length, head.length); input.focus()
  $('#mention').classList.add('hide'); mOpts = []
}
function mentionKey(e) {
  if (!mOpts.length || $('#mention').classList.contains('hide')) return false
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    mSel = (mSel + (e.key === 'ArrowDown' ? 1 : -1) + mOpts.length) % mOpts.length; renderMention()
  } else if (e.key === 'Enter' || e.key === 'Tab') pickMention(mOpts[mSel])
  else if (e.key === 'Escape') { $('#mention').classList.add('hide'); mOpts = [] }
  else return false
  e.preventDefault(); return true
}
input.addEventListener('input', () => { mSel = 0; renderMention() })
input.addEventListener('click', renderMention)
input.addEventListener('blur', () => setTimeout(() => $('#mention').classList.add('hide'), 150))
$('#mention').onmousedown = e => { const d = e.target.closest('[data-i]'); if (d) { e.preventDefault(); pickMention(mOpts[+d.dataset.i]) } }
$('#send').onclick = send

async function send() {
  const text = input.value.trim()
  if (!text || !cur || busy) return
  input.value = ''; input.style.height = 'auto'
  bubble(null, true).innerHTML = fmt(text)
  busy = true; $('#send').disabled = true
  const ticket = shown, target = cur
  const bubs = new Map(), tools = new Map()
  try {
    const res = await fetch(api('/api/chat'), { method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({ target: cur.kind === 'group' ? { type:'group', id:cur.id } : { type:'agent', id:cur.id }, text }) })
    if (!res.ok) throw new Error((await errText(res)).slice(0, 300))
    const rd = res.body.getReader(), dec = new TextDecoder()
    let buf = ''
    for (;;) {
      const { done, value } = await rd.read(); if (done) break
      buf += dec.decode(value, { stream:true })
      const parts = buf.split('\n\n'); buf = parts.pop() ?? ''
      for (const part of parts) {
        const ev = part.match(/^event: (.+)$/m)?.[1]
        const d = JSON.parse(part.match(/^data: (.+)$/m)?.[1] ?? '{}')
        // user switched away: keep reading (the server finishes the turn) but don't draw
        if (ticket !== shown) continue
        // Create the bubble on the first delta: tool calls often arrive right after start, and
        // an early bubble would put the answer above its own evidence.
        if (ev === 'start') bubs.delete(d.botId)
        else if (ev === 'delta') {
          let s = bubs.get(d.botId)
          if (!s) { s = { el: bubble(d.botId, false), raw: '' }; bubs.set(d.botId, s) }
          s.raw += d.text; s.el.innerHTML = fmt(s.raw); $('#log').scrollTop = $('#log').scrollHeight
        }
        else if (ev === 'error') { (bubs.get(d.botId)?.el ?? bubble(d.botId, false)).textContent = '⚠ ' + d.message }
        else if (ev === 'note') note(d.text)
        else if (ev === 'handoff') note(`${bot(d.from)?.name ?? d.from} → @${bot(d.to)?.name ?? d.to}`)
        else if (ev === 'tool') {
          if (d.phase === 'retry') {
            // the failed attempt may have streamed half a sentence; the retry repeats it all
            bubs.get(d.botId)?.el.closest('.msg')?.remove(); bubs.delete(d.botId)
            note(t('note.retry', { name: bot(d.botId)?.name ?? '', reason: d.reason })); continue
          }
          if (d.phase === 'trim') { note(t('note.trim', { n: d.dropped })); continue }
          const key = `${d.botId}:${d.name}:${JSON.stringify(d.args)}`
          if (d.phase === 'run') {
            // Close the current bubble when a tool starts; later text gets a new one, otherwise
            // "say → run → say" merges into one bubble above the command.
            bubs.delete(d.botId)
            tools.set(key, toolLine(d.botId, toolLabel(d.name, d.args)))
          } else if (d.phase === 'ask') {
            const el = tools.get(key)
            if (el) askOn(el, d.id)
          } else if (d.phase === 'answered') {
            tools.get(key)?.querySelector('.ask')?.remove()
          } else {
            const el = tools.get(key)
            if (el) finishTool(el, d.output, d.image)
          }
        }
      }
    }
  } catch (e) { if (ticket === shown) note('⚠ ' + (e.message ?? e)) }
  busy = false; $('#send').disabled = false; input.focus()
  CONVS = await (await fetch(api('/api/conversations'))).json(); renderConvs()
  loadUsage()                                         // the turn just cost something; show it
  // switched away and back mid-reply: the screen shows pre-reply history, reload it
  if (ticket !== shown && cur?.kind === target.kind && cur?.id === target.id) {
    const c = CONVS.find(x => x.kind === cur.kind && x.id === cur.id); if (c) openConv(c)
  }
}

// ═══ Groups ═══
let gEditing = null
$('#newconv').onclick = () => openGroupDlg(null)
function openGroupDlg(g) {
  gEditing = g
  $('#gtitle').textContent = g ? t('common.editNamed', { name: g.name }) : t('g.new')
  $('#gname').value = g?.name ?? ''
  $('#gsave').textContent = t(g ? 'common.save' : 'g.create')
  $('#gdel').style.display = g ? '' : 'none'
  $('#gmembers').innerHTML = BOTS.map(b => `<label class="pick">
      <input type="checkbox" value="${b.id}" ${g?.members?.includes(b.id) ? 'checked' : ''}>
      <div class="av" style="background:${col(b.color)}">${esc(b.name.slice(0,1))}</div>
      <span>${esc(b.name)}</span><small>${esc(b.description)}</small></label>`).join('')
  // The lead must be a checked member; redraw on change, keeping the choice if still valid
  const fillLead = keep => {
    const ids = [...$('#gmembers').querySelectorAll('input:checked')].map(i => i.value)
    $('#glead').innerHTML = `<option value="">${esc(t('g.noLead'))}</option>` +
      ids.map(id => `<option value="${esc(id)}">${esc(bot(id)?.name ?? id)}</option>`).join('')
    $('#glead').value = ids.includes(keep) ? keep : ''
  }
  $('#gmembers').onchange = () => fillLead($('#glead').value)
  fillLead(g?.lead ?? '')
  $('#gshared').checked = g?.shared_machine === true
  $('#gdlg').showModal()
}
$('#gcancel').onclick = () => $('#gdlg').close()
$('#gsave').onclick = async () => {
  const name = $('#gname').value.trim()
  const members = [...$('#gmembers').querySelectorAll('input:checked')].map(i => i.value)
  if (!name || members.length < 2) { alert(t('g.invalid')); return }
  const lead = $('#glead').value, shared_machine = $('#gshared').checked
  if (gEditing) { if (!await patchGroup(gEditing.id, { name, members, lead, shared_machine })) return }
  else {
    const r = await fetch(api('/api/groups'), { method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({ name, members, lead, shared_machine }) })
    if (!r.ok) { alert(await errText(r)); return }
    const g = await r.json()
    await reload(); const c = CONVS.find(x => x.id === g.id); if (c) openConv(c)
  }
  $('#gdlg').close()
}
$('#gdel').onclick = async () => {
  if (!gEditing || !confirm(t('g.confirmDisband', { name: gEditing.name }))) return
  await fetch(api(`/api/groups/${gEditing.id}`), { method:'DELETE' })
  $('#gdlg').close(); cur = null; await reloadAndReopen()
}
async function patchGroup(id, patch) {
  const r = await fetch(api(`/api/groups/${id}`), { method:'PATCH', headers:{'content-type':'application/json'},
    body: JSON.stringify(patch) })
  if (!r.ok) { alert(await errText(r)); return false }
  await reload()
  const c = CONVS.find(x => x.id === id); if (c) openConv(c)
  return true
}

/** After an edit/delete: redraw header, members and history; if the open one is gone, switch to the first. */
async function reloadAndReopen() {
  await reload()
  const c = (cur && CONVS.find(x => x.kind === cur.kind && x.id === cur.id)) ?? CONVS[0]
  if (c) openConv(c)
  else { cur = null; $('#log').innerHTML = ''; $('#htitle').textContent = t('head.pick'); $('#hsub').textContent = '' }
}
$('#addmem').onclick = () => {
  const c = CONVS.find(x => x.kind === 'group' && x.id === cur?.id)
  if (c) openGroupDlg({ id:c.id, name:c.name, members:c.members, lead:c.lead })
}
$('#hedit').onclick = () => {
  if (!cur) return
  if (cur.kind === 'group') $('#addmem').click()
  else editBot(bot(cur.id))
}

// ═══ Agent ═══
let bEditing = null
function editBot(b) {
  bEditing = b
  $('#btitle').textContent = b ? t('b.edit', { name: b.name }) : t('b.new')
  $('#bname').value = b?.name ?? ''
  $('#bdesc').value = b?.description ?? ''
  $('#bpersona').value = b?.persona ?? ''
  // Where its turns run. The CLIs are offered only when the cli module is on; an agent already on one
  // keeps showing it either way, so opening the editor never quietly moves it back.
  const rts = ['', ...CLIS.enabled ? CLIS.runtimes.map(r => r.id) : []]
  if (b?.runtime && !rts.includes(b.runtime)) rts.push(b.runtime)
  $('#bruntime').innerHTML = rts.map(r => `<option value="${esc(r)}">${esc(r ? t('rt.on', { name: CLI_NAMES[r] ?? r }) : t('rt.loop'))}</option>`).join('')
  $('#bruntime').value = b?.runtime ?? ''
  $('#bruntime').onchange = () => showRuntime(b)
  const def = PROVS.find(p => p.is_default)
  $('#bprov').innerHTML = `<option value="">${esc(def ? t('b.defaultProvNamed', { name: def.name }) : t('b.defaultProv'))}</option>` +
    PROVS.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')
  $('#bprov').value = PROVS.some(p => p.id === b?.provider_id) ? b.provider_id : ''
  // A new provider likely doesn't have the old model; restore it when switching back
  $('#bprov').onchange = () => loadModels($('#bprov').value,
    $('#bprov').value === (b?.provider_id ?? '') ? (b?.model ?? '') : '')
  showRuntime(b, true)
  $('#beffort').innerHTML = ['', 'low', 'medium', 'high']
    .map(e => `<option value="${e}">${esc(t(e ? `b.effort${e[0].toUpperCase()}${e.slice(1)}` : 'b.effortNone'))}</option>`).join('')
  $('#beffort').value = ['low', 'medium', 'high'].includes(b?.effort) ? b.effort : ''
  $('#bapproval').innerHTML = ['', 'off', 'match', 'all']
    .map(m => `<option value="${m}">${esc(t(m ? `b.approval${m[0].toUpperCase()}${m.slice(1)}` : 'b.approvalDefault'))}</option>`).join('')
  $('#bapproval').value = ['off', 'match', 'all'].includes(b?.approval) ? b.approval : ''
  $('#bsteps').value = b?.max_steps ?? ''
  $('#bcap').value = dollars(b?.daily_cap_micro)
  // A cap only means something when the upstream has prices; say so rather than let it look guarded.
  const u = b && spendOf(b.id)
  $('#bcaphint').textContent = u && !u.priced ? t('sp.unpricedWhy')
    : USAGE.default_cap_micro != null ? t('sp.capDefault', { cap: money(USAGE.default_cap_micro) }) : ''
  $('#bdel').style.display = b ? '' : 'none'
  $('#bdlg').showModal()
}
// Models come from the provider's /models; fall back to a text box when it gives no list,
// otherwise Agents on that provider couldn't pick a model at all.
let modelsSeq = 0
async function loadModels(providerId, current) {
  const seq = ++modelsSeq
  const sel = $('#bmodel'), box = $('#bmodelx')
  sel.hidden = false; box.hidden = true
  sel.innerHTML = `<option value="">${esc(t('b.loadingModels'))}</option>`; sel.disabled = true
  const r = await fetch(api('/api/providers/models'), { method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({ id: providerId }) }).then(x => x.json()).catch(() => ({ models: [] }))
  if (seq !== modelsSeq) return                  // provider changed meanwhile; this answer is stale
  const models = r.models ?? []
  if (!models.length) { sel.hidden = true; box.hidden = false; box.value = current; return }
  // Show a saved model even if the provider dropped it; never silently switch to the first
  const list = current && !models.includes(current) ? [current, ...models] : models
  sel.innerHTML = list.map(m => `<option value="${esc(m)}">${esc(m)}${models.includes(m) ? '' : esc(t('b.unlisted'))}</option>`).join('')
  // New Agents default to the model others already use on this provider, not the alphabetically first
  sel.value = current || r.suggested || models[0]; sel.disabled = false
}
const chosenModel = () => ($('#bmodel').hidden ? $('#bmodelx').value : $('#bmodel').value).trim()

// ═══ Coding CLIs as a runtime (web/cli.mjs) ═══
const CLI_NAMES = { claude: 'Claude Code', codex: 'Codex', grok: 'Grok Build' }
let CLIS = { enabled: false, runtimes: [] }
async function loadClis() {
  CLIS = await fetch(api('/api/cli')).then(r => r.json()).catch(() => ({ enabled: false, runtimes: [] }))
  return CLIS
}
/** On a CLI there is no upstream to pick and the model is free text, empty = the account's default. */
function showRuntime(b, first = false) {
  const rt = $('#bruntime').value
  $('#bprov').hidden = !!rt
  if (rt) {
    ++modelsSeq
    $('#bmodel').hidden = true; $('#bmodelx').hidden = false
    $('#bmodelx').placeholder = t('rt.modelPh')
    $('#bmodelx').value = first || rt === (b?.runtime ?? '') ? (b?.model ?? '') : ''
    const st = CLIS.runtimes.find(r => r.id === rt)
    $('#brthint').hidden = false
    $('#brthint').textContent = !CLIS.enabled ? t('rt.off')
      : st?.loggedIn ? t('rt.hint', { name: CLI_NAMES[rt] }) : t('rt.hintLogin', { name: CLI_NAMES[rt] })
  } else {
    $('#brthint').hidden = true
    $('#bmodelx').placeholder = t('b.modelPh')
    loadModels($('#bprov').value, first || !(b?.runtime) ? (b?.model ?? '') : '')
  }
}

// The accounts section of the upstreams dialog: each CLI, signed in or not, and its sign-in flow.
const clFlows = {}          // runtime → { id, timer } of a running sign-in
function renderClis() {
  const box = $('#clist')
  if (!CLIS.enabled) { box.innerHTML = `<small class="rhint">${esc(t('rt.off'))}</small>`; return }
  box.innerHTML = CLIS.runtimes.map(r => `<div class="clrow" data-rt="${esc(r.id)}">
    <div class="clhead"><span class="clname">${esc(r.name)}</span>
      <span class="clst ${r.loggedIn ? 'ok' : ''}">${esc(!r.running ? t('cl.down') : r.loggedIn ? t('cl.in') : t('cl.out'))}</span>
      ${r.agents?.length ? `<small class="clst">${esc(t('cl.used', { names: r.agents.join(', ') }))}</small>` : ''}
      <span class="clbtns">
        <button class="btn" data-act="login">${esc(t(r.loggedIn ? 'cl.again' : 'cl.login'))}</button>
        ${r.loggedIn ? `<button class="btn" data-act="logout">${esc(t('cl.logout'))}</button>` : ''}
      </span></div>
    <div class="clflow" hidden></div></div>`).join('')
  box.querySelectorAll('.clrow').forEach(row => {
    const rt = row.dataset.rt
    row.querySelector('[data-act=login]').onclick = () => clLogin(rt, row)
    const out = row.querySelector('[data-act=logout]')
    if (out) out.onclick = async () => {
      if (!confirm(t('cl.confirmLogout', { name: CLI_NAMES[rt] }))) return
      await fetch(api('/api/cli/logout'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runtime: rt }) })
      await loadClis(); renderClis()
    }
  })
}
async function clLogin(rt, row) {
  clearInterval(clFlows[rt]?.timer)
  const flow = row.querySelector('.clflow')
  flow.hidden = false; flow.textContent = t('cl.starting')
  const r = await fetch(api('/api/cli/login'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runtime: rt }) })
  if (!r.ok) { flow.textContent = await errText(r); return }
  const v = await r.json()
  clFlows[rt] = { id: v.id }
  let pasted = false
  const draw = v => {
    if (v.state !== 'running') {
      clearInterval(clFlows[rt]?.timer)
      flow.innerHTML = `<div>${esc(t(v.state === 'done' ? 'cl.done' : v.state === 'cancelled' ? 'cl.cancelled' : 'cl.failed'))}</div>` +
        (v.state === 'failed' ? `<pre>${esc(v.output ?? '')}</pre>` : '')
      if (v.state === 'done') loadClis().then(renderClis)
      return
    }
    // Keep what the person is typing: redraw only the parts that change.
    if (!flow.querySelector('.clwait')) {
      flow.innerHTML = `<div class="clwait"></div><div class="clcodebox"></div>
        <div class="clpaste" hidden><div class="prow"><input type="text" class="clin" placeholder="${esc(t('cl.pastePh'))}" autocomplete="off">
          <button class="btn pri" data-act="send">${esc(t('cl.send'))}</button></div></div>
        <div class="prow"><button class="btn" data-act="cancel">${esc(t('common.cancel'))}</button></div>`
      flow.querySelector('[data-act=cancel]').onclick = async () => {
        await fetch(api(`/api/cli/login/${clFlows[rt].id}`), { method: 'DELETE' }); poll()
      }
      flow.querySelector('[data-act=send]').onclick = async () => {
        const text = flow.querySelector('.clin').value.trim()
        if (!text) return
        const s = await fetch(api(`/api/cli/login/${clFlows[rt].id}/input`), { method: 'POST',
          headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) })
        if (!s.ok) { alert(await errText(s)); return }
        pasted = true; flow.querySelector('.clin').value = ''; poll()
      }
    }
    flow.querySelector('.clwait').innerHTML = v.url
      ? `${esc(t(v.needsPaste ? 'cl.openPaste' : 'cl.open'))}<br><a href="${esc(v.url)}" target="_blank" rel="noopener">${esc(v.url)}</a>`
      : esc(t('cl.starting'))
    flow.querySelector('.clcodebox').innerHTML = v.code ? `${esc(t('cl.code'))}<div class="clcode">${esc(v.code)}</div>` : ''
    flow.querySelector('.clpaste').hidden = !v.needsPaste || pasted
  }
  const poll = async () => {
    const x = await fetch(api(`/api/cli/login/${clFlows[rt].id}`)).then(r => r.ok ? r.json() : { state: 'failed', output: '' })
    draw(x)
  }
  draw(v)
  clFlows[rt].timer = setInterval(poll, 2000)
}
$('#pdlg').addEventListener('close', () => { for (const f of Object.values(clFlows)) clearInterval(f.timer) })
$('#newbot').onclick = () => editBot(null)
$('#bcancel').onclick = () => $('#bdlg').close()
$('#bsave').onclick = async () => {
  const cap = toMicro($('#bcap').value)
  if (cap === false) { alert(t('sp.capBad')); return }
  const body = { name:$('#bname').value.trim(), description:$('#bdesc').value.trim(), persona:$('#bpersona').value.trim(),
    provider_id:$('#bprov').value, model:chosenModel(), effort:$('#beffort').value, approval:$('#bapproval').value,
    max_steps: $('#bsteps').value.trim() === '' ? null : Number($('#bsteps').value),
    daily_cap_micro: cap === '' ? null : cap }
  if (!body.name || !body.persona) { alert(t('b.needName')); return }
  body.runtime = $('#bruntime').value
  if (body.runtime) delete body.provider_id
  if (!body.model && !body.runtime) { alert(t('b.needModel')); return }
  const r = bEditing
    ? await fetch(api(`/api/bots/${bEditing.id}`), { method:'PATCH', headers:{'content-type':'application/json'}, body:JSON.stringify(body) })
    : await fetch(api('/api/bots'), { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body) })
  if (!r.ok) { alert(await errText(r)); return }
  $('#bdlg').close(); await reloadAndReopen()
}
$('#bdel').onclick = async () => {
  if (!bEditing || !confirm(t('b.confirmDelete', { name: bEditing.name }))) return
  await fetch(api(`/api/bots/${bEditing.id}`), { method:'DELETE' })
  $('#bdlg').close(); if (cur?.kind === 'agent' && cur.id === bEditing.id) cur = null
  await reloadAndReopen()
}

// ═══ Model providers ═══
// The one thing that must be configured first, so this screen answers: which one is in use,
// does it connect, and what's the context window.
let PROVS = [], pEditing = null

const ctxMode = () => document.querySelector('input[name=pctx]:checked').value
function setCtxMode(mode, tokens) {
  document.querySelector(`input[name=pctx][value=${mode}]`).checked = true
  $('#pctxn').disabled = mode === 'auto'
  if (tokens) $('#pctxn').value = tokens
}
for (const r of document.querySelectorAll('input[name=pctx]'))
  r.onchange = () => { $('#pctxn').disabled = ctxMode() === 'auto' }

const hint = (s, cls = '') => { $('#phint').className = 'phint ' + cls; $('#phint').textContent = s }

function renderProvs() {
  const box = $('#plist'); box.innerHTML = ''
  if (!PROVS.length) {
    box.innerHTML = `<div style="padding:10px 2px;color:var(--dim2);font-size:12.5px">${esc(t('p.empty'))}</div>`
    return
  }
  for (const p of PROVS) {
    const el = document.createElement('div')
    el.className = 'pitem' + (p.is_default ? ' def' : '') + (pEditing?.id === p.id ? ' on' : '')
    el.innerHTML = `<span class="dot" title="${esc(t(p.is_default ? 'p.inUse' : 'p.makeDefault'))}"></span>
      <div class="pn"><b>${esc(p.name)}</b>
      <small>${PROTO[p.protocol] ?? 'Chat'} · ${p.auto_context ? esc(t('p.auto')) : `${(p.context_tokens / 1000).toFixed(0)}k`} · ${esc(p.base_url)}</small></div>`
    el.querySelector('.dot').onclick = async ev => {
      ev.stopPropagation()
      if (p.is_default) return
      await fetch(api(`/api/providers/${p.id}/default`), { method: 'POST' })
      await loadProvs()
    }
    el.onclick = () => fillProv(p)
    box.appendChild(el)
  }
}

const PROTO = { chat: 'Chat', responses: 'Responses', messages: 'Messages' }

function fillProv(p) {
  pEditing = p
  $('#ptitle').textContent = p ? t('common.editNamed', { name: p.name }) : t('p.add')
  $('#pname').value = p?.name ?? ''
  $('#purl').value = p?.base_url ?? ''
  $('#pproto').value = p?.protocol ?? 'chat'
  $('#pkey').value = ''
  $('#pkey').placeholder = p?.key_hint ? t('p.keySaved', { hint: p.key_hint }) : 'API Key'
  $('#ppin').value = dollars(p?.price_in_micro)
  $('#ppout').value = dollars(p?.price_out_micro)
  setCtxMode(p ? (p.auto_context ? 'auto' : 'manual') : 'auto', p?.context_tokens ?? '')
  $('#pdel').style.display = p && PROVS.length > 1 ? '' : 'none'
  hint(p ? (p.auto_context ? p.ctx_source : t('p.ctxTokens', { n: p.context_tokens, src: p.ctx_source })) : '')
  renderProvs()
}

const provBody = () => ({
  id: pEditing?.id, name: $('#pname').value.trim(), base_url: $('#purl').value.trim(),
  protocol: $('#pproto').value,
  api_key: $('#pkey').value,
  auto_context: ctxMode() === 'auto', context_tokens: Number($('#pctxn').value) || undefined,
  // '' means "not known" and is stored as null — never as a price of zero
  price_in_micro: toMicro($('#ppin').value), price_out_micro: toMicro($('#ppout').value),
})

async function loadProvs() {
  PROVS = await (await fetch(api('/api/providers'))).json()
  renderProvs()
}

$('#prov').onclick = async () => { await loadProvs(); fillProv(PROVS.find(p => p.is_default) ?? null)
  $('#pdefcap').value = dollars(USAGE.default_cap_micro); await loadPolicy(); await loadEffort()
  $('#clist').innerHTML = ''; loadClis().then(renderClis); $('#pdlg').showModal() }

async function loadEffort() {
  const r = await (await fetch(api('/api/settings/effort'))).json().catch(() => null)
  if (!r) return
  $('#pdefeff').innerHTML = ['', ...(r.levels ?? ['low', 'medium', 'high'])]
    .map(e => `<option value="${e}">${esc(t(e ? `b.effort${e[0].toUpperCase()}${e.slice(1)}` : 'ef.none'))}</option>`).join('')
  $('#pdefeff').value = r.effort ?? ''
}
$('#peffsave').onclick = async () => {
  const r = await fetch(api('/api/settings/effort'), { method:'PUT', headers:{'content-type':'application/json'},
    body: JSON.stringify({ effort: $('#pdefeff').value }) })
  if (!r.ok) { hint((await r.json()).error, 'bad'); return }
  hint(t('ef.saved'), 'good')
}

async function loadPolicy() {
  const pol = await (await fetch(api('/api/approvals/policy'))).json().catch(() => null)
  if (!pol) return
  $('#apmode').innerHTML = (pol.modes ?? ['off', 'match', 'all'])
    .map(m => `<option value="${m}">${esc(t(`ap.mode${m[0].toUpperCase()}${m.slice(1)}`))}</option>`).join('')
  $('#apmode').value = pol.mode
  $('#appat').value = (pol.patterns ?? []).join('\n')
}
$('#apsave').onclick = async () => {
  const r = await fetch(api('/api/approvals/policy'), { method:'PUT', headers:{'content-type':'application/json'},
    body: JSON.stringify({ mode: $('#apmode').value, patterns: $('#appat').value.split('\n') }) })
  if (!r.ok) { hint((await r.json()).error, 'bad'); return }
  hint(t('ap.saved'), 'good')
}
$('#pcapsave').onclick = async () => {
  const micro = toMicro($('#pdefcap').value)
  if (micro === false) { hint(t('sp.capBad'), 'bad'); return }
  const r = await fetch(api('/api/usage/cap'), { method:'PUT', headers:{'content-type':'application/json'},
    body: JSON.stringify({ daily_cap_micro: micro === '' ? null : micro }) })
  if (!r.ok) { hint((await r.json()).error, 'bad'); return }
  await loadUsage()
  hint(t('sp.defaultCap') + ': ' + (micro === '' ? t('sp.noCap') : money(micro)), 'good')
}
$('#pclose').onclick = () => $('#pdlg').close()
$('#pnew').onclick = () => fillProv(null)

// Really calls the provider, so misconfiguration shows here and not later as a silent Agent.
$('#ptest').onclick = async () => {
  hint(t('p.connecting'))
  const r = await (await fetch(api('/api/providers/test'), { method:'POST',
    headers:{'content-type':'application/json'}, body: JSON.stringify(provBody()) })).json()
  hint(r.ok ? t('p.ok', { ms: r.ms, models: r.models, model: r.model, reply: r.reply }) : t('p.fail', { error: r.error }), r.ok ? 'good' : 'bad')
}

$('#psave').onclick = async () => {
  const b = provBody()
  if (!b.name || !b.base_url) { hint(t('p.needFields'), 'bad'); return }
  if (b.price_in_micro === false || b.price_out_micro === false) { hint(t('sp.priceBad'), 'bad'); return }
  hint(t('common.saving'))
  const r = pEditing
    ? await fetch(api(`/api/providers/${pEditing.id}`), { method:'PATCH', headers:{'content-type':'application/json'}, body: JSON.stringify(b) })
    : await fetch(api('/api/providers'), { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(b) })
  const j = await r.json()
  if (!r.ok) { hint(j.error ?? t('p.saveFailed'), 'bad'); return }
  await loadProvs(); fillProv(PROVS.find(p => p.id === j.id) ?? null)
  await loadUsage()
  hint(t('p.saved', { info: j.auto_context ? j.ctx_source : t('p.ctxShort', { n: j.context_tokens }) }), 'good')
}

$('#pdel').onclick = async () => {
  if (!pEditing || !confirm(t('p.confirmDelete', { name: pEditing.name }))) return
  const r = await fetch(api(`/api/providers/${pEditing.id}`), { method:'DELETE' })
  if (!r.ok) { hint((await r.json()).error, 'bad'); return }
  await loadProvs(); fillProv(PROVS.find(p => p.is_default) ?? null)
}

// ═══ Spend ═══
// Money is micro-dollars over the wire (1 dollar = 1e6) so it stays an integer; only the
// display divides. Small amounts need four decimals or every conversation reads as $0.00.
let USAGE = { agents: [], day: null, month: null, default_cap_micro: null }
const money = m => m == null ? '—' : '$' + (m / 1e6).toFixed(Math.abs(m) < 10000 ? 4 : 2)
const dollars = m => m == null ? '' : String(m / 1e6)
// '' = leave as is (platform default / unknown); a number = micro-dollars; false = not a number
const toMicro = v => {
  const x = String(v ?? '').trim()
  if (!x) return ''
  const n = Number(x)
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1e6) : false
}
const tokens = n => n >= 10000 ? Math.round(n / 1000) + 'k' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n)
const spendOf = id => USAGE.agents.find(a => a.id === id)

async function loadUsage() {
  USAGE = await fetch(api('/api/usage')).then(r => r.json()).catch(() => USAGE)
  const spent = t('sp.footer', { day: money(USAGE.day?.cost_micro ?? 0), month: money(USAGE.month?.cost_micro ?? 0) })
  $('#spendfoot').firstElementChild.nextElementSibling.textContent = spent
  $('#spendfoot').dataset.tip = spent   // collapsed, the figure only shows in the tip
  if (cur) renderSpend(cur)
}

/** Per agent in the open conversation: what it spent, and whether a cap can hold it at all. */
function renderSpend(c) {
  // `cur` is only {kind,id}; the members live on the conversation row.
  const full = CONVS.find(x => x.kind === c.kind && x.id === c.id) ?? c
  const box = $('#spend'); box.innerHTML = ''
  for (const id of full.kind === 'group' ? (full.members ?? []) : [full.id]) {
    const u = spendOf(id); if (!u) continue
    const cap = u.cap_micro == null ? t('sp.noCap')
      : t(u.own_cap ? 'sp.cap' : 'sp.capDefault', { cap: money(u.cap_micro) })
    const el = document.createElement('div')
    el.className = 'spd'
    el.innerHTML = `${full.kind === 'group' ? `<b>${esc(u.name)}</b> · ` : ''}` +
      `${esc(t('sp.today'))} <b>${esc(money(u.day.cost_micro))}</b> · ${esc(t('sp.month'))} <b>${esc(money(u.month.cost_micro))}</b>` +
      `<br>${esc(t('sp.tokens', { n: tokens(u.month.tokens) }))} · ${esc(cap)}` +
      (u.priced ? '' : `<br><span class="w">${esc(t('sp.unpricedWhy'))}</span>`)
    box.appendChild(el)
  }
}

// ═══ Memory: the Agent's own in a DM, the group's in a group ═══
const memPath = c => `/api/memory/${c.kind === 'group' ? 'group' : 'agent'}/${c.id}`
// The Agent's self-notes are a second, separate box below it: he writes them, a human may edit
// them, and there is no such thing for a group — only a person writes a group's memory.
const selfPath = c => `/api/memory/agent/${c.id}/self`
const stillOpen = c => cur?.kind === c.kind && cur.id === c.id
async function loadMemory(c) {
  $('#memtitle').textContent = c.kind === 'group'
    ? t('mem.groupTitle', { name: c.name }) : t('mem.agentTitle', { name: c.name })
  $('#mem').placeholder = t(c.kind === 'group' ? 'mem.groupPh' : 'mem.agentPh')
  $('#mem').value = ''; $('#mstat').textContent = ''
  $('#smemta').value = ''; $('#smstat').textContent = ''
  $('#smem').style.display = c.kind === 'group' ? 'none' : ''
  $('#smemtitle').textContent = t('smem.title', { name: c.name })
  const r = await fetch(api(memPath(c))).catch(() => null)
  if (r?.ok && stillOpen(c)) $('#mem').value = (await r.json()).text
  if (c.kind === 'group') return
  const s = await fetch(api(selfPath(c))).catch(() => null)
  if (s?.ok && stillOpen(c)) $('#smemta').value = (await s.json()).text
}
$('#cadd').onclick = () => { $('#side2').classList.remove('hide'); $('#mem').focus() }
const saveMem = async (path, box, stat) => {
  $(stat).textContent = t('common.saving')
  const r = await fetch(api(path), { method:'PUT', headers:{'content-type':'application/json'},
    body: JSON.stringify({ text: $(box).value }) }).catch(() => null)
  if (!r?.ok) { $(stat).textContent = t('mem.failed', { msg: r ? await errText(r) : t('mem.offline') }); return }
  $(stat).textContent = t('mem.saved', { time: new Date().toLocaleTimeString(lang) })
  setTimeout(() => $(stat).textContent = '', 4000)
}
$('#msave').onclick = () => cur && saveMem(memPath(cur), '#mem', '#mstat')
$('#smsave').onclick = () => cur && cur.kind !== 'group' && saveMem(selfPath(cur), '#smemta', '#smstat')

// ═══ Chat history import / export (current conversation) ═══
const xPath = (op, c) => `/api/${op}/${c.kind === 'group' ? 'group' : 'dm'}/${c.id}`
$('#xexp').onclick = async () => {
  if (!cur) return
  const r = await fetch(api(xPath('export', cur)))
  if (!r.ok) { alert(await errText(r)); return }
  const doc = await r.json()
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' }))
  a.download = `${doc.name}-${new Date().toISOString().slice(0, 10)}.json`
  a.click(); URL.revokeObjectURL(a.href)
}
$('#ximp').onclick = () => { if (cur) $('#xfile').click() }
$('#xfile').onchange = async () => {
  const f = $('#xfile').files[0]; $('#xfile').value = ''
  if (!f || !cur) return
  let doc
  try { doc = JSON.parse(await f.text()) } catch { alert(t('x.notJson')); return }
  const n = Array.isArray(doc.messages) ? doc.messages.length : 0
  const where = $('#htitle').textContent
  let replace = false
  if (!confirm(t('x.append', { n, where }))) {
    if (!confirm(t('x.replace', { n, where }))) return
    replace = true
  }
  const r = await fetch(api(xPath('import', cur)), { method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({ doc, replace }) })
  if (!r.ok) { alert(await errText(r)); return }
  await reloadAndReopen()
}

// Browser actions in plain words: "Open example.com" reads better than {"action":"open",...}
function browserLabel(a) {
  const target = a.index != null ? `#${a.index}` : a.text ? quote(a.text) : ''
  const label = {
    open: () => t('ba.open', { url: a.url ?? '' }), read: () => t('ba.read'), screenshot: () => t('tool.screenshot'),
    back: () => t('ba.back'), click: () => t('ba.click', { target }),
    type: () => t('ba.type', { index: a.index ?? '?', text: quote(a.text ?? '') }) + (a.submit ? t('ba.enter') : ''),
    press: () => t('ba.press', { key: a.key ?? '' }), scroll: () => t('ba.scroll'), eval: () => t('ba.eval'),
  }[a.action]
  return t('ba.prefix') + (label ? label() : a.action)
}

// ═══ Agent browser: watch + take over ═══
// The view is MJPEG from Chromium's screencast, which <img> plays natively. With no browser open the
// server answers 204 and the image fails; retry every few seconds (it shows up once they open one).
const bwStream = id => withLang(api(`/api/browser/${id}/stream`)) + `&t=${Date.now()}`
let bwTimers = []
function loadBrowsers() {
  bwTimers.forEach(clearTimeout); bwTimers = []
  const box = $('#bws'); box.innerHTML = ''
  const c = cur; if (!c) return
  // cur is only {kind,id}; members live on the conversation-list entry
  const ids = c.kind === 'group' ? (CONVS.find(x => x.kind === 'group' && x.id === c.id)?.members ?? []) : [c.id]
  for (const id of ids) {
    const b = bot(id); if (!b) continue
    const el = document.createElement('div')
    const show = () => {
      el.className = 'bw'
      el.innerHTML = `<img alt="${esc(t('bw.altNamed', { name: b.name }))}"><small>${c.kind === 'group' ? esc(b.name) + ' · ' : ''}${esc(t('bw.takeOver'))}</small>`
      const img = el.querySelector('img')
      img.onerror = () => { if (cur !== c) return; off(); bwTimers.push(setTimeout(show, 5000)) }
      img.src = bwStream(id)
      el.onclick = () => openBrowser(b)
    }
    const off = () => {
      if (c.kind === 'group') { el.className = ''; el.innerHTML = ''; return }   // in groups, only list open browsers
      el.className = 'bwoff'; el.innerHTML = `${esc(t('bw.notOpen'))} <button class="btn">${esc(t('bw.open'))}</button>`
      el.querySelector('button').onclick = e => { e.stopPropagation(); openBrowser(b) }
    }
    show(); box.appendChild(el)
  }
}

// ⚠️ Chrome keeps naturalWidth at 0 while playing MJPEG, so it can't tell "is there a picture".
// Only onerror (no browser → 204) means reconnect.
// Full screen: direct control. Mouse move/down/up/wheel, keys and typed text all go over one
// WebSocket; the picture comes from the stream.
// Keyboard: clicking the view focuses an invisible textarea — IMEs only type into real inputs —
// and committed text is taken from it and sent; non-text keys (Enter, arrows, Backspace, Ctrl/⌘ combos) go as key events.
let bwBot = null, bwOff = false, bwWs = null, bwComposing = false
const bwNoteDefault = () => bwBot ? t('bw.note', { name: bwBot.name }) : ''
function openBrowser(b) {
  bwBot = b; bwOff = false
  $('#bwname').textContent = t('bw.altNamed', { name: b.name })
  $('#bwnote').textContent = bwNoteDefault()
  $('#bwimg').src = bwStream(b.id)
  $('#bwimg').onerror = () => { bwOff = true; $('#bwnote').textContent = t('bw.offNote') }
  $('#bwfull').hidden = false
  bwConnect()
}
function bwConnect() {
  if (!bwBot || bwWs) return
  const u = new URL(withLang(api(`/api/browser/${bwBot.id}/input`)), location.href)
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
  const ws = new WebSocket(u); bwWs = ws
  ws.onclose = () => { if (bwWs === ws) bwWs = null }
}
function closeBrowser() {
  $('#bwfull').hidden = true; $('#bwimg').removeAttribute('src')   // stop the stream so frames don't keep arriving in the background
  bwWs?.close(); bwWs = null
  bwBot = null; loadBrowsers()
}
function bwSend(e) {
  if (bwWs?.readyState === 1) bwWs.send(JSON.stringify(e))
  else if (e.t === 'down') bwAct({ action:'click_xy', x:e.x, y:e.y })     // no channel: at least clicks still work
}
async function bwAct(action) {
  if (!bwBot) return
  const r = await fetch(api(`/api/browser/${bwBot.id}/act`), { method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify(action) }).then(r => r.json()).catch(e => ({ ok:false, error:String(e) }))
  if (!r.ok) { $('#bwnote').textContent = r.error; return }
  if (r.url && document.activeElement !== $('#bwurl')) $('#bwurl').value = r.url
  // went from closed to open: stream and input channel exist only now, reconnect
  if (bwOff) { bwOff = false; $('#bwimg').src = bwStream(bwBot.id); $('#bwnote').textContent = bwNoteDefault() }
  bwConnect()
}
$('#bwback').onclick = closeBrowser
$('#bwnav').onclick = () => bwAct({ action:'back' })
$('#bwreload').onclick = () => bwAct({ action:'reload' })
$('#bwurl').onkeydown = e => { if (e.key === 'Enter' && e.target.value.trim()) bwAct({ action:'open', url:e.target.value.trim() }) }

// Mouse
const bwAt = e => { const r = $('#bwimg').getBoundingClientRect()
  return { x: Math.max(0, Math.min(1280, (e.clientX - r.left) / r.width * 1280)), y: Math.max(0, Math.min(800, (e.clientY - r.top) / r.height * 800)) } }
const bwBtn = b => ['left', 'middle', 'right'][b] ?? 'left'
let bwMoveT = null, bwMoveE = null
$('#bwimg').onmousemove = e => { bwMoveE = e; bwMoveT ??= setTimeout(() => { bwMoveT = null; bwSend({ t:'move', ...bwAt(bwMoveE) }) }, 30) }
$('#bwimg').onmousedown = e => {
  e.preventDefault()
  bwSend({ t:'down', ...bwAt(e), button:bwBtn(e.button), count:e.detail || 1 })
  $('#bwime').focus()                       // clicking into the page hands it the keyboard
}
$('#bwimg').onmouseup = e => bwSend({ t:'up', ...bwAt(e), button:bwBtn(e.button), count:e.detail || 1 })
$('#bwimg').oncontextmenu = e => e.preventDefault()
$('#bwimg').onwheel = e => { e.preventDefault(); bwSend({ t:'wheel', ...bwAt(e), dx:e.deltaX, dy:e.deltaY }) }

// Keyboard
const BW_KEYS = new Set(['Enter', 'Backspace', 'Delete', 'Tab', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
  'Home', 'End', 'PageUp', 'PageDown', 'Shift', 'Control', 'Alt'])
const bwKeyName = e => {
  if (e.key === 'Meta') return 'Control'                          // ⌘ is Ctrl in their (Linux) browser
  if (BW_KEYS.has(e.key)) return e.key
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.length === 1) return e.key.toLowerCase()   // shortcut
  return null                                                     // plain typing: left to the textarea / IME
}
const ime = $('#bwime')
ime.onfocus = () => $('#bwbox').classList.add('typing')
ime.onblur = () => $('#bwbox').classList.remove('typing')
ime.onkeydown = e => {
  if (e.isComposing || bwComposing) return                        // while the IME composes, Enter/Backspace belong to it
  const k = bwKeyName(e); if (!k) return
  e.preventDefault(); bwSend({ t:'keydown', key:k })
}
ime.onkeyup = e => { if (bwComposing) return; const k = bwKeyName(e); if (k) { e.preventDefault(); bwSend({ t:'keyup', key:k }) } }
ime.addEventListener('compositionstart', () => { bwComposing = true })
ime.addEventListener('compositionend', () => { bwComposing = false; bwFlushIme() })
ime.addEventListener('input', () => { if (!bwComposing) bwFlushIme() })
function bwFlushIme() { if (ime.value) { bwSend({ t:'text', text:ime.value }); ime.value = '' } }
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#bwfull').hidden && document.activeElement !== ime && document.activeElement?.tagName !== 'INPUT') closeBrowser() })

// ═══ Skill library ═══
let SKILLS = [], kEditing = null
async function loadSkills() {
  SKILLS = await fetch(api('/api/skills')).then(r => r.json()).catch(() => [])
}
// Source: human-written is unmarked; Agent-saved is marked, since skills change how they work later
const skillSource = k => k.source?.startsWith('agent:') ? t('k.selfSaved', { name: bot(k.source.slice(6))?.name ?? k.source.slice(6) }) : ''
function renderSkills() {
  const box = $('#klist'); box.innerHTML = ''
  if (!SKILLS.length) { box.innerHTML = `<div style="padding:10px 2px;color:var(--dim2);font-size:12.5px">${esc(t('k.empty'))}</div>`; return }
  for (const k of SKILLS) {
    const el = document.createElement('div')
    el.className = 'pitem' + (kEditing?.id === k.id ? ' on' : '')
    const who = listJoin(k.agents.map(id => bot(id)?.name ?? id)) || t('k.nobody')
    const src = skillSource(k)
    el.innerHTML = `<div class="pn"><b>${esc(k.name)}${src ? ` <span class="st" style="font-size:10.5px;font-weight:400;color:var(--dim)">· ${esc(src)}</span>` : ''}</b>
      <small>${esc(k.description)} · ${esc(who)}</small></div>`
    el.onclick = () => fillSkill(k)
    box.appendChild(el)
  }
}
function fillSkill(k, preselect = []) {
  kEditing = k
  $('#ktitle').textContent = k ? t('common.editNamed', { name: k.name }) : t('k.write')
  $('#kname').value = k?.name ?? ''
  $('#kdesc').value = k?.description ?? ''
  $('#kbody').value = k?.body ?? ''
  const on = new Set(k?.agents ?? preselect)
  $('#kagents').innerHTML = BOTS.map(b => `<label><input type="checkbox" value="${esc(b.id)}" ${on.has(b.id) ? 'checked' : ''}>${esc(b.name)}</label>`).join('')
  const src = k && skillSource(k)
  $('#ksrc').textContent = src ? t('k.srcNote', { src }) : ''
  $('#kdel').style.display = $('#kexp').style.display = k ? '' : 'none'
  renderSkills()
}
async function openSkills(k = null, preselect = []) {
  await loadSkills()
  fillSkill(k ? SKILLS.find(x => x.id === k.id) ?? null : null, preselect)
  $('#kdlg').showModal()
}
const skillBody = () => ({ name: $('#kname').value.trim(), description: $('#kdesc').value.trim(), body: $('#kbody').value,
  agents: [...document.querySelectorAll('#kagents input:checked')].map(i => i.value) })
$('#skills').onclick = () => openSkills()
$('#knew').onclick = () => fillSkill(null)
$('#kclose').onclick = () => { $('#kdlg').close(); loadBotSkills() }
$('#ksave').onclick = async () => {
  const r = kEditing
    ? await fetch(api(`/api/skills/${kEditing.id}`), { method:'PATCH', headers:{'content-type':'application/json'}, body: JSON.stringify(skillBody()) })
    : await fetch(api('/api/skills'), { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(skillBody()) })
  if (!r.ok) { alert(await errText(r)); return }
  const k = await r.json(); await loadSkills(); fillSkill(SKILLS.find(x => x.id === k.id) ?? null)
}
$('#kdel').onclick = async () => {
  if (!kEditing || !confirm(t('k.confirmDelete', { name: kEditing.name }))) return
  await fetch(api(`/api/skills/${kEditing.id}`), { method:'DELETE' })
  await loadSkills(); fillSkill(null)
}
$('#kexp').onclick = async () => {
  if (!kEditing) return
  const text = await fetch(api(`/api/skills/${kEditing.id}/export`)).then(r => r.text())
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }))
  a.download = `${kEditing.name}.SKILL.md`; a.click(); URL.revokeObjectURL(a.href)
}
$('#kimp').onclick = () => $('#kfile').click()
$('#kfile').onchange = async e => {
  const f = e.target.files[0]; e.target.value = ''
  if (!f) return
  const r = await fetch(api('/api/skills/import'), { method:'POST', headers:{'content-type':'application/json'},
    // no name in the file: use the file name minus .md / .SKILL.md
    body: JSON.stringify({ text: await f.text(), name: f.name.replace(/(\.SKILL)?\.md$/i, ''),
      agents: [...document.querySelectorAll('#kagents input:checked')].map(i => i.value) }) })
  if (!r.ok) { alert(await errText(r)); return }
  const k = await r.json(); await loadSkills(); fillSkill(SKILLS.find(x => x.id === k.id) ?? null)
}

// Right column: this Agent's skills. Hidden in groups — skills belong to people, not groups
async function loadBotSkills() {
  const c = cur
  $('#s2skills').style.display = c?.kind === 'agent' ? '' : 'none'
  if (c?.kind !== 'agent') return
  await loadSkills()
  if (cur !== c) return
  const box = $('#bskills'); box.innerHTML = ''
  for (const k of SKILLS.filter(k => k.agents.includes(c.id))) {
    const el = document.createElement('div'); el.className = 'rt'
    const src = skillSource(k)
    el.innerHTML = `<b>${esc(k.name)}${src ? ` <span class="st">${esc(src)}</span>` : ''}</b><small>${esc(k.description)}</small>`
    el.onclick = () => openSkills(k)
    box.appendChild(el)
  }
}
$('#addsk').onclick = () => openSkills(null, cur ? [cur.id] : [])

// ═══ The film studio: the workbench ═══
// With the studio configured the product opens here, on a project: its shot board, the script cut
// into scenes, the bible (characters and locations, and locking them) and the project's settings.
// The crew's chats stay in the list below the project; opening one leaves the workbench.
// A person can review here (the boss, 2026-09-25): pick a take and approve it, or reject with a
// reason and a route. The studio tells the crew exactly as when the reviewer does it. Generating
// is not here — prompts and takes are the crew's work.
const ROLES = ['director', 'art', 'cinematographer', 'reviewer']
const STATUSES = ['planned', 'prompted', 'generating', 'review', 'rejected', 'approved', 'locked']
const STATUS_COL = { planned: 'var(--dim2)', prompted: 'var(--chipink)', generating: 'var(--warn)', review: 'var(--accent)',
  rejected: 'var(--bad)', approved: 'var(--ok)', locked: 'var(--ok)' }
const stCall = async (action, args = {}) => {
  const r = await fetch(api('/api/studio/call'), { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ action, args }) })
  if (!r.ok) throw new Error(await errText(r))
  return r.json()
}
const fileUrl = id => api(`/api/studio/file/${encodeURIComponent(id)}`)
const WS = { on: false, projects: [], project: null, view: null, shot: null, scene: '', episode: '', ep: null, board: null, sig: '' }
const EP_STAGES = ['draft', 'breakdown', 'breakdown_review', 'production', 'final_review', 'done']
const EP_COL = { draft: 'var(--dim2)', breakdown: 'var(--chipink)', breakdown_review: 'var(--warn)', production: 'var(--accent)',
  final_review: 'var(--warn)', done: 'var(--ok)' }
let wsTicket = 0
const wsBody = () => $('#wsb')
// Who did it, as a person reads it: the platform's names for agents, "a person" for the human actor.
const actorName = a => a === 'human' ? t('ws.person') : String(a ?? '').startsWith('agent:') ? (bot(a.slice(6))?.name ?? a.slice(6))
  : a === 'studio' ? t('st.speaker') : (a || '—')
const stamp = d => (d ? new Date(d).toLocaleString(lang, { month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit' }) : '')
const openImage = id => window.open(fileUrl(id), '_blank', 'noopener')

/** Is the studio here? Shows the project block and loads the projects. */
async function wsInit() {
  const st = await fetch(api('/api/studio/status')).then(r => r.json()).catch(() => ({ enabled: false }))
  WS.on = !!st.enabled
  $('#proj').hidden = !WS.on
  $('#convhead').hidden = !WS.on
  if (!WS.on) return false
  await wsProjects()
  return true
}

async function wsProjects(select = null) {
  try { WS.projects = await stCall('project.list') } catch { WS.projects = [] }
  let saved = null
  try { saved = localStorage.getItem('ma_project') } catch {}
  const want = select ?? WS.project ?? saved
  WS.project = WS.projects.some(p => p.id === want) ? want : WS.projects[0]?.id ?? null
  $('#wsproj').innerHTML = (WS.projects.length
    ? WS.projects.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')
    : `<option value="">${esc(t('ws.noProject'))}</option>`) + `<option value="+">${esc(t('ws.newProject'))}</option>`
  $('#wsproj').value = WS.project ?? ''
}
$('#wsproj').onchange = e => {
  if (e.target.value === '+') { e.target.value = WS.project ?? ''; wsNewProject(); return }
  WS.project = e.target.value
  try { localStorage.setItem('ma_project', WS.project) } catch {}
  WS.scene = ''; WS.episode = ''
  wsShow(!WS.view || WS.view === 'shot' ? 'board' : WS.view)
}
async function wsNewProject() {
  const pid = prompt(t('st.newIdPrompt'))?.trim(); if (!pid) return
  const name = prompt(t('st.newNamePrompt'), pid)?.trim(); if (!name) return
  try { await stCall('project.create', { id: pid, name, info: { lang: lang === 'en' ? 'en' : lang } }) }
  catch (e) { alert(e.message); return }
  await wsProjects(pid)
  try { localStorage.setItem('ma_project', pid) } catch {}
  wsShow('settings')
}
for (const b of document.querySelectorAll('#proj [data-view]')) b.onclick = () => wsShow(b.dataset.view)

/** Into the workbench. The chat's current conversation is let go, so the list shows none selected. */
async function wsShow(view, arg = null) {
  const ticket = ++wsTicket
  WS.view = view; WS.shot = view === 'shot' ? arg : null
  if (view === 'episode') WS.ep = arg
  cur = null; renderConvs()
  $('main').classList.add('ws-on'); document.body.classList.add('ws-mode')
  const nav = view === 'shot' ? 'board' : view === 'episode' ? 'episodes' : view
  for (const b of document.querySelectorAll('#proj [data-view]')) b.classList.toggle('on', b.dataset.view === nav)
  if (!WS.project) return wsNoProject()
  try {
    if (view === 'board') await wsBoard(ticket)
    else if (view === 'shot') await wsShot(ticket, arg)
    else if (view === 'episodes' || view === 'script') await wsEpisodes(ticket)
    else if (view === 'episode') await wsEpisode(ticket, arg)
    else if (view === 'bible') await wsBible(ticket)
    else await wsSettings(ticket)
  } catch (e) {
    if (ticket !== wsTicket) return
    wsBody().innerHTML = `<div class="wempty"><p>⚠ ${esc(e.message ?? e)}</p></div>`
  }
}
function wsLeave() {
  if (!WS.view) return
  ++wsTicket
  WS.view = null
  $('main').classList.remove('ws-on'); document.body.classList.remove('ws-mode')
  for (const b of document.querySelectorAll('#proj [data-view]')) b.classList.remove('on')
}

function wsHead(title, sub = '', { back = false, quota = null, backTo = 'board' } = {}) {
  const p = WS.projects.find(x => x.id === WS.project)
  $('#wsh').innerHTML = `${back ? `<button class="btn back">${esc(t(backTo === 'episodes' ? 'ws.backEpisodes' : 'ws.back'))}</button>` : ''}
    <div style="min-width:0"><div class="t">${esc(title)}</div><small>${esc(sub || p?.name || '')}</small></div>
    ${quota ? `<div class="quota${quota.used >= quota.per_hour ? ' w' : ''}" title="${esc(t('ws.quotaTip'))}">${esc(t('ws.quota', quota))}</div>` : ''}`
  $('#wsh .back')?.addEventListener('click', () => wsShow(backTo, backTo === 'episode' ? WS.ep : null))
}

function wsNoProject() {
  wsHead(t('ws.title'), ' ')
  wsBody().innerHTML = `<div class="wempty"><h2>${esc(t('ws.welcome'))}</h2><p>${esc(t('ws.welcomeText'))}</p>
    <button class="btn pri">${esc(t('ws.newProject'))}</button></div>`
  wsBody().querySelector('button').onclick = wsNewProject
}

// ─── Board: every shot of the film, one column per state ───
async function wsBoard(ticket) {
  const b = await stCall('project.board', { project: WS.project, ...WS.episode ? { episode: WS.episode } : {} })
    .catch(e => { if (!WS.episode) throw e; WS.episode = ''; return stCall('project.board', { project: WS.project }) })
  if (ticket !== wsTicket) return
  WS.board = b
  wsBoardRender()
}
function wsBoardRender() {
  const b = WS.board
  wsHead(t('ws.board'), `${b.project.name} · ${b.ratio}`, { quota: b.quota })
  const box = wsBody(), keep = [box.scrollLeft, box.scrollTop]
  box.innerHTML = ''
  if (!b.seedance_ready) box.insertAdjacentHTML('beforeend', `<p class="lead" style="color:var(--warn)">${esc(t('ws.noSeedance'))}</p>`)
  // Who has work right now (the pipeline's orders), and which episode the board shows.
  const stuck = b.orders.reduce((n, o) => n + o.stuck, 0)
  if (b.orders.length) box.insertAdjacentHTML('beforeend', `<p class="lead"${stuck ? ' style="color:var(--warn)"' : ''}>${esc(t('ws.ordersNow', {
    list: b.orders.map(o => `${t(o.role === 'human' ? 'ws.you' : `st.role.${o.role}`)} ${o.n}`).join(' · ') }))}${stuck ? esc(t('ws.ordersStuck', { n: stuck })) : ''}</p>`)
  if (b.episodes.length) {
    const eps = document.createElement('div'); eps.className = 'chips'
    eps.innerHTML = [['', t('ws.allEpisodes')], ...b.episodes.map(e => [e.code, `${e.code}${e.title ? ` · ${e.title}` : ''} · ${t(`ws.ep.${e.stage}`)}`])]
      .map(([c, label]) => `<button class="chip${WS.episode === c ? ' on' : ''}" data-e="${esc(c)}">${esc(label)}</button>`).join('')
    eps.onclick = async e => { const c = e.target.closest('.chip'); if (!c) return; WS.episode = c.dataset.e; WS.scene = ''; wsShow('board') }
    box.appendChild(eps)
  }
  if (!b.shots.length) {
    box.insertAdjacentHTML('beforeend', `<div class="wempty"><h2>${esc(t('ws.noShots'))}</h2>
      <p>${esc(t(b.scenes.length ? 'ws.noShotsYet' : 'ws.noScenes'))}</p><button class="btn pri">${esc(t('ws.goScript'))}</button></div>`)
    box.querySelector('.wempty button').onclick = () => wsShow('episodes')
    return
  }
  if (WS.scene && !b.scenes.some(s => s.code === WS.scene)) WS.scene = ''
  const chips = document.createElement('div'); chips.className = 'chips'
  chips.innerHTML = [['', t('ws.allScenes')], ...b.scenes.map(s => [s.code, `${s.code}${s.title ? ` · ${s.title}` : ''}`])]
    .map(([c, label]) => `<button class="chip${WS.scene === c ? ' on' : ''}" data-c="${esc(c)}">${esc(label)}</button>`).join('')
  chips.onclick = e => { const c = e.target.closest('.chip'); if (c) { WS.scene = c.dataset.c; wsBoardRender() } }
  box.appendChild(chips)
  const kan = document.createElement('div'); kan.className = 'kanban'
  for (const st of STATUSES) {
    const shots = b.shots.filter(s => s.status === st && (!WS.scene || s.scene === WS.scene))
    const col = document.createElement('div'); col.className = 'kcol'
    col.innerHTML = `<h5><i style="background:${STATUS_COL[st]}"></i>${esc(t(`ws.st.${st}`))}<span>${shots.length}</span></h5>${shots.length ? '' : '<div class="none">—</div>'}`
    for (const s of shots) {
      const c = document.createElement('button'); c.className = 'card'
      c.innerHTML = `${s.thumb ? `<img src="${fileUrl(s.thumb)}" alt="" loading="lazy">` : ''}
        <div class="top2"><span class="code mono">${esc(s.code)}</span>${s.priority === 'hero' ? `<span class="badge hero">${esc(t('ws.hero'))}</span>` : ''}${
          s.pending ? `<span class="badge">${esc(t('ws.pending', { n: s.pending }))}</span>` : ''}</div>
        ${s.story_beat ? `<div class="beat">${esc(s.story_beat)}</div>` : ''}
        <div class="meta">${s.duration_s ? `<span>${esc(t('ws.secs', { n: s.duration_s }))}</span>` : ''}${
          s.candidates ? `<span>${esc(t('ws.takes', { n: s.candidates }))}</span>` : ''}${
          s.rejections ? `<span style="color:var(--bad)">${esc(t('ws.rejections', { n: s.rejections, max: b.rejects_to_human }))}</span>` : ''}${
          s.picked ? `<span style="color:var(--ok)">${esc(t('ws.pickedN', { n: s.picked }))}</span>` : ''}</div>`
      c.onclick = () => wsShow('shot', s.code)
      col.appendChild(c)
    }
    kan.appendChild(col)
  }
  box.appendChild(kan)
  ;[box.scrollLeft, box.scrollTop] = keep
}

// ─── One shot: what it is, its takes, and the decision ───
const shotSig = d => JSON.stringify([d.status, d.candidates.length, d.reviews.length, d.sheets.length, d.generations.map(g => g.status)])
async function wsShot(ticket, code) {
  const d = await stCall('shot.detail', { project: WS.project, shot: code })
  if (ticket !== wsTicket) return
  if (!WS.board) WS.board = await stCall('project.board', { project: WS.project }).catch(() => null)
  if (ticket !== wsTicket) return
  WS.sig = shotSig(d)
  wsShotRender(d)
}
const DEF_KEYS = ['story_beat', 'duration_s', 'shot_size', 'angle', 'camera_move', 'characters', 'location', 'light', 'continuity']
function defValue(k, v) {
  if (k === 'characters') return (v ?? []).map(c => [c.name, c.look && `(${c.look})`, c.expr, c.action].filter(Boolean).join(' ')).join('\n')
  if (k === 'continuity') return [v?.in_from && `${t('ws.def.in')} ${v.in_from}`, v?.out_to && `${t('ws.def.out')} ${v.out_to}`].filter(Boolean).join('\n')
  if (k === 'duration_s') return t('ws.secs', { n: v })
  return typeof v === 'object' ? JSON.stringify(v) : String(v)
}
function wsShotRender(d) {
  const sceneLine = `${d.scene?.code ?? ''}${d.scene?.title ? ` · ${d.scene.title}` : ''}`
  wsHead(d.code, sceneLine, { back: true, quota: WS.board?.quota })
  const box = wsBody(); box.innerHTML = ''
  box.insertAdjacentHTML('beforeend', `<div class="rowb" style="margin-bottom:16px">
    <span class="badge" style="color:${STATUS_COL[d.status]}">● ${esc(t(`ws.st.${d.status}`))}</span>
    ${d.priority === 'hero' ? `<span class="badge hero">${esc(t('ws.hero'))}</span>` : ''}
    ${d.rejections ? `<span class="badge bad">${esc(t('ws.rejections', { n: d.rejections, max: d.rejects_to_human }))}</span>` : ''}
    ${d.picked ? `<span class="badge ok">${esc(t('ws.pickedN', { n: d.picked }))}</span>` : ''}</div>`)

  // The decision, when there is one to make. A rejected shot is a person's too: after the third
  // rejection it waits for one, and even before, a person may take a take the crew turned down.
  if (d.status === 'review') box.appendChild(reviewBar(d))
  if (d.status === 'rejected') box.appendChild(decideBar(d))

  // Takes, newest round first.
  const sec = document.createElement('div'); sec.className = 'sec'
  sec.innerHTML = `<h4>${esc(t('ws.candidates'))} <small>${esc(t('ws.candidatesHint'))}</small></h4>`
  if (!d.candidates.length) sec.insertAdjacentHTML('beforeend', `<p class="lead">${esc(t(d.status === 'generating' ? 'ws.generatingNow' : 'ws.noTakes'))}</p>`)
  const rounds = [...new Set(d.candidates.map(c => c.round))].reverse()
  for (const r of rounds) {
    const takes = d.candidates.filter(c => c.round === r)
    sec.insertAdjacentHTML('beforeend', `<div class="rhint" style="margin:8px 0 6px">${esc(t('ws.round', {
      model: takes[0].model, v: takes[0].prompt_version ?? '—', at: stamp(takes[0].created_at) }))}</div>`)
    const grid = document.createElement('div'); grid.className = WS.board?.ratio === '9:16' || WS.board?.ratio === '3:4' ? 'cands v' : 'cands'
    for (const c of takes) {
      const el = document.createElement('div'); el.className = 'cand' + (d.picked === c.n ? ' picked' : '')
      el.innerHTML = `<video controls preload="metadata" playsinline ${c.frame ? `poster="${fileUrl(c.frame)}"` : ''} src="${fileUrl(c.asset_id)}"></video>
        <div class="row"><b class="mono">#${c.n}</b>${c.duration_ms ? `<span>${esc(t('ws.secs', { n: (c.duration_ms / 1000).toFixed(1) }))}</span>` : ''}${
          c.width ? `<span>${c.width}×${c.height}</span>` : ''}${c.trim_to ? `<span title="${esc(t('ws.trimTip'))}">${esc(t('ws.trim', { n: c.trim_to }))}</span>` : ''}${
          d.picked === c.n ? `<span class="badge ok">${esc(t('ws.picked'))}</span>` : ''}${
          `<a class="dl" href="${fileUrl(c.asset_id)}" download="${esc(d.code)}-${c.n}.mp4">${esc(t('ws.download'))}</a>`}${
          d.status === 'review' || d.status === 'rejected' ? `<button class="btn pri">${esc(t('ws.approveThis'))}</button>` : ''}</div>`
      el.querySelector('button')?.addEventListener('click', () => wsApprove(d, c.n))
      // 1080p / 4K takes are 10-bit HEVC, which many browsers can't decode: show the last frame and
      // say so, rather than a black box that looks like a broken take.
      el.querySelector('video').addEventListener('error', e => {
        const box = document.createElement('div'); box.className = 'noplay'
        box.innerHTML = `${c.frame ? `<img src="${fileUrl(c.frame)}" alt="">` : ''}<small>${esc(t('ws.cantPlay'))}</small>`
        e.target.replaceWith(box)
      })
      grid.appendChild(el)
    }
    sec.appendChild(grid)
  }
  box.appendChild(sec)

  // The contact sheet the reviewer (or you) made.
  if (d.sheets.length) {
    const sh = document.createElement('div'); sh.className = 'sec sheet'
    sh.innerHTML = `<h4>${esc(t('ws.sheet'))} <small>${esc(stamp(d.sheets[0].created_at))}</small></h4>
      <img src="${fileUrl(d.sheets[0].id)}" alt="${esc(t('ws.sheet'))}" loading="lazy">`
    sh.querySelector('img').onclick = () => openImage(d.sheets[0].id)
    box.appendChild(sh)
  }

  // What is said in it, and how it will be heard.
  if (d.def?.dialogue?.length) {
    const ls = document.createElement('div'); ls.className = 'sec'
    ls.innerHTML = `<h4>${esc(t('ws.dialogue'))} <small>${esc(t('ws.dialogueHint'))}</small></h4>${linesHtml(d.def.dialogue)}`
    box.appendChild(ls)
  }

  // What the shot is.
  const def = d.def ?? {}
  const rows = DEF_KEYS.filter(k => def[k] != null && def[k] !== '' && !(Array.isArray(def[k]) && !def[k].length))
  const dsec = document.createElement('div'); dsec.className = 'sec'
  dsec.innerHTML = `<h4>${esc(t('ws.definition'))}</h4><dl class="kv">${rows.map(k =>
    `<dt>${esc(t(`ws.def.${k}`))}</dt><dd>${esc(defValue(k, def[k]))}</dd>`).join('')}</dl>
    <details style="margin-top:8px"><summary class="rhint" style="cursor:pointer">${esc(t('ws.rawJson'))}</summary>
    <pre class="rhint mono" style="white-space:pre-wrap">${esc(JSON.stringify(def, null, 2))}</pre></details>`
  box.appendChild(dsec)

  // Every prompt version, newest first.
  const psec = document.createElement('div'); psec.className = 'sec'
  psec.innerHTML = `<h4>${esc(t('ws.prompts'))} <small>${esc(t('ws.promptsHint'))}</small></h4>` +
    (d.prompts.length ? '' : `<p class="lead">${esc(t('ws.noPrompt'))}</p>`)
  for (const [i, p] of d.prompts.entries()) {
    const v = document.createElement('div'); v.className = 'ver' + (i === 0 ? ' now' : '')
    v.innerHTML = `<div class="who">v${p.version} · ${esc(actorName(p.created_by))} · ${esc(stamp(p.created_at))}${p.note ? ` · ${esc(p.note)}` : ''}</div>
      <pre></pre>${p.refs?.length ? `<div class="thumbs" style="margin-top:6px">${p.refs.map(id => `<img src="${fileUrl(id)}" alt="" loading="lazy" data-id="${esc(id)}">`).join('')}</div>` : ''}`
    v.querySelector('pre').textContent = p.text
    v.querySelectorAll('img[data-id]').forEach(img => { img.onclick = () => openImage(img.dataset.id) })
    psec.appendChild(v)
  }
  box.appendChild(psec)

  // The review history.
  if (d.reviews.length) {
    const rsec = document.createElement('div'); rsec.className = 'sec'
    rsec.innerHTML = `<h4>${esc(t('ws.reviews'))}</h4>`
    for (const r of [...d.reviews].reverse()) {
      const el = document.createElement('div'); el.className = `rev ${r.verdict}`
      el.innerHTML = `<div class="who">${esc(actorName(r.reviewer))} · ${esc(stamp(r.created_at))}</div><b></b><div class="txt"></div>`
      el.querySelector('b').textContent = r.verdict === 'approve' ? t('ws.approvedN', { n: r.pick })
        : t('ws.rejectedN', { n: r.attempt, route: t(`ws.route.${r.route}`) })
      el.querySelector('.txt').textContent = [r.reason, r.note].filter(Boolean).join('\n')
      rsec.appendChild(el)
    }
    box.appendChild(rsec)
  }

  // Every generation, including the failures and why.
  if (d.generations.length) {
    const gsec = document.createElement('details'); gsec.className = 'sec'
    gsec.innerHTML = `<summary style="cursor:pointer;font-size:13px;font-weight:600">${esc(t('ws.generations', { n: d.generations.length }))}</summary>
      <table class="gens" style="margin-top:8px"><tr><th>${esc(t('ws.g.status'))}</th><th>${esc(t('ws.g.model'))}</th><th>${esc(t('ws.g.prompt'))}</th><th>${esc(t('ws.g.by'))}</th><th>${esc(t('ws.g.at'))}</th><th></th></tr>
      ${d.generations.map(g => `<tr><td>${esc(t(`ws.gs.${g.status}`))}</td><td class="mono">${esc(g.model)}</td><td>v${g.prompt_version ?? '—'}</td>
        <td>${esc(actorName(g.requested_by))}</td><td>${esc(stamp(g.created_at))}${g.duration_ms ? ` · ${Math.round(g.duration_ms / 1000)}s` : ''}</td>
        <td class="err">${esc(g.error)}</td></tr>`).join('')}</table>`
    box.appendChild(gsec)
  }
}

/** The bar above the takes when a shot waits for a verdict: make a sheet, or reject. Approving is per take. */
function reviewBar(d) {
  const bar = document.createElement('div'); bar.className = 'sec'
  bar.innerHTML = `<div class="rform" style="border-color:var(--accent)"><b>${esc(t('ws.reviewTitle'))}</b>
    <p class="rhint" style="margin:6px 0 10px">${esc(t('ws.reviewHint'))}</p>
    <div class="rowb"><button class="btn" data-a="sheet">${esc(t('ws.makeSheet'))}</button>
    <button class="btn" data-a="reject" style="color:var(--bad)">${esc(t('ws.reject'))}</button></div></div>`
  bar.querySelector('[data-a=sheet]').onclick = async e => {
    e.target.disabled = true; e.target.textContent = t('ws.making')
    try { await stCall('shot.sheet', { project: WS.project, shot: d.code }); await wsShow('shot', d.code) }
    catch (err) { alert(err.message); e.target.disabled = false; e.target.textContent = t('ws.makeSheet') }
  }
  bar.querySelector('[data-a=reject]').onclick = () => {
    if (bar.querySelector('.rjf')) return
    const next = d.rejections + 1
    const f = document.createElement('div'); f.className = 'rform rjf'
    f.innerHTML = `<b>${esc(t('ws.rejectTitle', { shot: d.code }))}</b>
      <p class="rhint" style="margin:6px 0 10px;${next >= d.rejects_to_human ? 'color:var(--warn)' : ''}">${esc(t(next >= d.rejects_to_human ? 'ws.rejectLast' : 'ws.rejectNth', { n: next, max: d.rejects_to_human }))}</p>
      <textarea class="fi" placeholder="${esc(t('ws.reasonPh'))}"></textarea>
      <select class="fi">${['prompt', 'asset', 'plan'].map(r => `<option value="${r}">${esc(t(`ws.route.${r}`))}</option>`).join('')}</select>
      <div class="rowb"><button class="btn" data-a="cancel">${esc(t('common.cancel'))}</button>
      <button class="btn pri" data-a="send">${esc(t('ws.rejectSend'))}</button></div>`
    f.querySelector('[data-a=cancel]').onclick = () => f.remove()
    f.querySelector('[data-a=send]').onclick = async () => {
      const reason = f.querySelector('textarea').value.trim()
      if (reason.length < 15) { alert(t('ws.reasonShort')); return }
      try {
        await stCall('shot.reject', { project: WS.project, shot: d.code, reason, route: f.querySelector('select').value })
        await wsShow('shot', d.code)
      } catch (e) { alert(e.message) }
    }
    bar.appendChild(f)
    f.querySelector('textarea').focus()
  }
  return bar
}
/** A rejected shot: a person hands it back to the crew with a note, or takes one of its takes (above). */
function decideBar(d) {
  const mine = d.rejections >= d.rejects_to_human
  const bar = document.createElement('div'); bar.className = 'sec'
  bar.innerHTML = `<div class="rform" style="border-color:${mine ? 'var(--warn)' : 'var(--line)'}"><b>${esc(t(mine ? 'ws.decideYours' : 'ws.decideCrew', { n: d.rejections }))}</b>
    <p class="rhint" style="margin:6px 0 10px">${esc(t(mine ? 'ws.decideYoursHint' : 'ws.decideCrewHint'))}</p>
    ${mine ? `<textarea class="fi" placeholder="${esc(t('ws.reopenPh'))}"></textarea>
    <select class="fi">${['prompt', 'asset', 'plan'].map(r => `<option value="${r}">${esc(t(`ws.route.${r}`))}</option>`).join('')}</select>
    <div class="rowb"><button class="btn pri">${esc(t('ws.reopen'))}</button></div>` : ''}</div>`
  bar.querySelector('button')?.addEventListener('click', async () => {
    const note = bar.querySelector('textarea').value.trim()
    if (note.length < 5) { alert(t('ws.reviseNeed')); return }
    try { await stCall('shot.reopen', { project: WS.project, shot: d.code, route: bar.querySelector('select').value, note }); wsShow('shot', d.code) }
    catch (e) { alert(e.message) }
  })
  return bar
}
async function wsApprove(d, n) {
  if (!confirm(t('ws.confirmApprove', { shot: d.code, n }))) return
  try { await stCall('shot.approve', { project: WS.project, shot: d.code, pick: n }); await wsShow('shot', d.code) }
  catch (e) { alert(e.message) }
}

// ─── Episodes: the series, one episode at a time, each moving through the pipeline ───
// A person writes an episode's script and starts it; the director breaks it down; a person
// checks the breakdown; the crew makes it, each told by work orders; the studio cuts it once every
// shot is approved; a person watches the cut and approves it. The two decisions are here.
const epBadge = st => `<span class="badge" style="color:${EP_COL[st]}">● ${esc(t(`ws.ep.${st}`))}</span>`
async function wsEpisodes(ticket) {
  const [eps, scenes] = await Promise.all([stCall('episode.list', { project: WS.project }), stCall('scene.list', { project: WS.project })])
  if (ticket !== wsTicket) return
  wsHead(t('ws.episodes'))
  const box = wsBody(); box.innerHTML = `<p class="lead">${esc(t('ws.episodesLead'))}</p>`
  const add = document.createElement('details'); add.className = 'scr'
  add.open = !eps.length
  add.innerHTML = `<summary><b>＋ ${esc(t('ws.addEpisode'))}</b></summary>
    <div class="brow"><input class="fi mono" placeholder="${esc(t('ws.epCodePh'))}" style="max-width:120px" value="E${String(eps.length + 1).padStart(2, '0')}">
      <input class="fi" placeholder="${esc(t('ws.epTitlePh'))}"></div>
    <input class="fi" placeholder="${esc(t('ws.epLoglinePh'))}">
    <textarea class="fi" style="min-height:200px" placeholder="${esc(t('ws.epScriptPh'))}"></textarea>
    <div class="rowb"><button class="btn pri">${esc(t('ws.addEpisode'))}</button></div>`
  add.querySelector('.btn.pri').onclick = async () => {
    const [code, title, logline] = [...add.querySelectorAll('input')].map(i => i.value.trim())
    const script = add.querySelector('textarea').value.trim()
    if (!code) { alert(t('ws.epNeed')); return }
    try { await stCall('episode.add', { project: WS.project, code, title, logline, script }); wsShow('episode', code) }
    catch (e) { alert(e.message) }
  }
  box.appendChild(add)
  const list = document.createElement('div'); list.className = 'eplist'
  for (const e of eps) {
    const el = document.createElement('button'); el.className = 'epcard'
    el.innerHTML = `<div class="rowb"><b class="mono">${esc(e.code)}</b><span>${esc(e.title)}</span>${epBadge(e.stage)}</div>
      ${e.logline ? `<div class="rhint" style="margin:6px 0 0">${esc(e.logline)}</div>` : ''}
      <div class="meta">${e.scenes ? `<span>${esc(t('ws.epScenes', { n: e.scenes }))}</span>` : ''}${
        e.shots ? `<span>${esc(t('ws.sceneShots', { ok: e.approved, n: e.shots }))}</span>` : ''}</div>`
    el.onclick = () => wsShow('episode', e.code)
    list.appendChild(el)
  }
  box.appendChild(list)
  // Scenes from before episodes existed: still here, outside the pipeline.
  const loose = scenes.filter(sc => !sc.episode)
  if (loose.length) {
    box.insertAdjacentHTML('beforeend', `<div class="sec"><h4>${esc(t('ws.looseScenes'))}</h4><small class="rhint">${esc(t('ws.looseHint'))}</small></div>`)
    for (const sc of loose) box.appendChild(sceneItem(sc, () => wsShow('episodes')))
  }
}

/** One scene, opened on demand: its text as written, its shots (with their dialogue), editing and locking. */
function sceneItem(sc, refresh, { dialogue = false } = {}) {
  const el = document.createElement('details'); el.className = 'scr'
  el.innerHTML = `<summary><b class="mono">${esc(sc.code)}</b><span>${esc(sc.title)}</span>
    <span class="badge" style="margin-left:auto">${esc(t('ws.sceneShots', { ok: sc.approved, n: sc.shots }))}</span>
    ${sc.locked ? `<span class="badge ok">${esc(t('ws.sceneLocked'))}</span>` : ''}</summary><div class="body"></div>`
  el.ontoggle = async () => {
    if (!el.open || el.dataset.loaded) return
    el.dataset.loaded = '1'
    const full = await stCall('scene.show', { project: WS.project, scene: sc.code }).catch(e => ({ error: e.message }))
    const body = el.querySelector('.body')
    if (full.error) { body.textContent = full.error; return }
    // In a breakdown review a person reads the plan, lines included; later the chips are enough.
    const plan = dialogue && full.shots.length ? await Promise.all(full.shots.map(x => stCall('shot.detail', { project: WS.project, shot: x.code }).catch(() => null))) : []
    body.innerHTML = `<pre></pre>
      ${plan.length ? `<div class="planl">${plan.filter(Boolean).map(d => `<div class="pl"><button class="chip" data-shot="${esc(d.code)}"><span style="color:${STATUS_COL[d.status]}">●</span> ${esc(d.code)}</button>
        <span class="rhint" style="margin:0">${esc([d.def?.duration_s && t('ws.secs', { n: d.def.duration_s }), d.def?.shot_size, d.def?.story_beat].filter(Boolean).join(' · '))}</span>
        ${linesHtml(d.def?.dialogue)}</div>`).join('')}</div>`
      : full.shots.length ? `<div class="chips" style="margin:12px 0 4px">${full.shots.map(s =>
        `<button class="chip" data-shot="${esc(s.code)}" title="${esc(s.story_beat ?? '')}"><span style="color:${STATUS_COL[s.status]}">●</span> ${esc(s.code)}</button>`).join('')}</div>` : `<p class="rhint" style="margin-top:10px">${esc(t('ws.sceneNoShots'))}</p>`}
      <div class="rowb" style="margin-top:10px">${sc.locked ? '' : `<button class="btn" data-a="edit">${esc(t('ws.editScript'))}</button>`}
      ${!sc.locked && sc.shots && sc.approved === sc.shots ? `<button class="btn pri" data-a="lock">${esc(t('ws.lockScene'))}</button>` : ''}</div>`
    body.querySelector('pre').textContent = full.script
    body.querySelectorAll('[data-shot]').forEach(b => { b.onclick = () => wsShow('shot', b.dataset.shot) })
    body.querySelector('[data-a=lock]')?.addEventListener('click', async () => {
      if (!confirm(t('ws.confirmLockScene', { code: sc.code }))) return
      try { await stCall('shot.lock', { project: WS.project, scene: sc.code }); refresh() } catch (e) { alert(e.message) }
    })
    body.querySelector('[data-a=edit]')?.addEventListener('click', () => {
      body.innerHTML = `<input class="fi" value="${esc(sc.title)}"><textarea class="fi" style="min-height:220px"></textarea>
        <div class="rowb"><button class="btn" data-a="cancel">${esc(t('common.cancel'))}</button><button class="btn pri" data-a="save">${esc(t('common.save'))}</button></div>`
      body.querySelector('textarea').value = full.script
      body.querySelector('[data-a=cancel]').onclick = refresh
      body.querySelector('[data-a=save]').onclick = async () => {
        try {
          await stCall('scene.edit', { project: WS.project, scene: sc.code, title: body.querySelector('input').value.trim(), script: body.querySelector('textarea').value })
          refresh()
        } catch (e) { alert(e.message) }
      }
    })
  }
  return el
}

/** A shot's lines, as a person reads them: who, how it is heard, what. */
function linesHtml(lines) {
  if (!lines?.length) return ''
  return `<div class="lines">${lines.map(l => `<div class="ln"><span class="lk ${esc(l.kind)}">${esc(t(`ws.line.${l.kind}`))}</span>${
    l.speaker ? `<b>${esc(l.speaker)}</b>` : ''}<span>${esc(l.text)}</span></div>`).join('')}</div>`
}

async function wsEpisode(ticket, code) {
  const e = await stCall('episode.show', { project: WS.project, episode: code })
  if (ticket !== wsTicket) return
  WS.sig = epSig(e)
  wsEpisodeRender(e)
}
const epSig = e => JSON.stringify([e.stage, e.rev, e.cut?.id, e.cut?.status, e.orders.map(o => [o.id, o.status]), e.scenes.map(s => [s.shots, s.approved])])
function wsEpisodeRender(e) {
  wsHead(`${e.code}${e.title ? ` · ${e.title}` : ''}`, `${WS.projects.find(x => x.id === WS.project)?.name ?? ''} · ${e.ratio}`, { back: true, backTo: 'episodes' })
  const box = wsBody(); box.innerHTML = ''
  const refresh = () => wsShow('episode', e.code)
  const shots = e.scenes.reduce((n, s) => n + s.shots, 0), ok = e.scenes.reduce((n, s) => n + s.approved, 0)
  // Where it is in the pipeline, as a row of steps.
  box.insertAdjacentHTML('beforeend', `<div class="steps">${EP_STAGES.map(st => `<span class="${st === e.stage ? 'on' : EP_STAGES.indexOf(st) < EP_STAGES.indexOf(e.stage) ? 'past' : ''}">${esc(t(`ws.ep.${st}`))}</span>`).join('<i>›</i>')}</div>`)

  // The gate for this stage: what a person does here, if anything.
  const gate = document.createElement('div'); gate.className = 'sec'
  const act = async (fn, btn) => { btn.disabled = true; try { await fn(); refresh() } catch (err) { alert(err.message); btn.disabled = false } }
  if (e.stage === 'draft') {
    gate.innerHTML = `<div class="rform"><b>${esc(t('ws.gateDraft'))}</b><p class="rhint" style="margin:6px 0 10px">${esc(t(e.script.trim() ? 'ws.gateDraftHint' : 'ws.gateNoScript'))}</p>
      <div class="rowb"><button class="btn pri"${e.script.trim() ? '' : ' disabled'}>${esc(t('ws.startEpisode'))}</button></div></div>`
    gate.querySelector('button').onclick = ev => act(() => stCall('episode.start', { project: WS.project, episode: e.code }), ev.target)
  } else if (e.stage === 'breakdown') {
    gate.innerHTML = `<div class="rform"><b>${esc(t('ws.gateBreakdown'))}</b><p class="rhint" style="margin:6px 0 0">${esc(t('ws.gateBreakdownHint'))}</p>
      ${e.note ? `<p class="rhint" style="margin:6px 0 0">${esc(t('ws.lastNote', { note: e.note }))}</p>` : ''}</div>`
  } else if (e.stage === 'breakdown_review') {
    gate.innerHTML = `<div class="rform" style="border-color:var(--warn)"><b>${esc(t('ws.gateReview', { scenes: e.scenes.length, shots }))}</b>
      <p class="rhint" style="margin:6px 0 10px">${esc(t('ws.gateReviewHint'))}</p>
      <textarea class="fi" placeholder="${esc(t('ws.revisePh'))}"></textarea>
      <div class="rowb"><button class="btn" data-a="revise">${esc(t('ws.sendBack'))}</button><button class="btn pri" data-a="ok">${esc(t('ws.approveBreakdown'))}</button></div></div>`
    gate.querySelector('[data-a=ok]').onclick = ev => act(() => stCall('episode.review', { project: WS.project, episode: e.code, decision: 'approve' }), ev.target)
    gate.querySelector('[data-a=revise]').onclick = ev => {
      const note = gate.querySelector('textarea').value.trim()
      if (note.length < 5) { alert(t('ws.reviseNeed')); gate.querySelector('textarea').focus(); return }
      act(() => stCall('episode.review', { project: WS.project, episode: e.code, decision: 'revise', note }), ev.target)
    }
  } else if (e.stage === 'production') {
    gate.innerHTML = `<div class="rform"><b>${esc(t('ws.gateProduction', { ok, n: shots }))}</b><p class="rhint" style="margin:6px 0 10px">${esc(t('ws.gateProductionHint'))}</p>
      <div class="rowb"><button class="btn">${esc(t('ws.openBoard'))}</button></div></div>`
    gate.querySelector('button').onclick = () => { WS.episode = e.code; wsShow('board') }
  }
  if (gate.innerHTML) box.appendChild(gate)

  // The cut: made by the studio once every shot is approved.
  if (e.cut) {
    const c = e.cut, cs = document.createElement('div'); cs.className = 'sec'
    const notes = (c.log ?? []).map(l => t(`ws.cutLog.${l.code}`, { n: l.lines ?? '', shot: l.shot ?? '', error: l.error ?? '' }))
    cs.innerHTML = `<h4>${esc(t('ws.cut'))} <small>${esc(t(`ws.cut.${c.status}`))}${c.finished_at ? ` · ${esc(stamp(c.finished_at))}` : ''}${c.duration_ms ? ` · ${esc(t('ws.secs', { n: Math.round(c.duration_ms / 100) / 10 }))}` : ''}</small></h4>
      ${c.status === 'done' ? `<div class="cutv"><video controls preload="metadata" playsinline style="aspect-ratio:${e.ratio.replace(':', '/')}" src="${fileUrl(c.video_asset_id)}"></video></div>
        <div class="rowb" style="margin-top:8px"><a class="dl" href="${fileUrl(c.video_asset_id)}" download="${esc(e.code)}.mp4">${esc(t('ws.downloadMp4'))}</a>
        ${c.srt_asset_id ? `<a class="dl" href="${fileUrl(c.srt_asset_id)}" download="${esc(e.code)}.srt">${esc(t('ws.downloadSrt'))}</a>` : ''}</div>` : ''}
      ${c.status === 'failed' ? `<p class="rhint" style="color:var(--bad)">${esc(c.error)}</p>` : ''}
      ${notes.length ? `<p class="rhint" style="color:var(--warn)">${notes.map(esc).join('<br>')}</p>` : ''}
      ${e.stage === 'final_review' ? `<div class="rform" style="border-color:var(--warn);margin-top:10px"><b>${esc(t('ws.gateFinal'))}</b>
        <p class="rhint" style="margin:6px 0 10px">${esc(t('ws.gateFinalHint'))}</p>
        <div class="rowb"><button class="btn" data-a="recut">${esc(t('ws.recut'))}</button><button class="btn pri" data-a="ok">${esc(t('ws.approveEpisode'))}</button></div></div>`
      : ['done', 'production'].includes(e.stage) && c.status !== 'running' && c.status !== 'queued' && ok === shots && shots ? `<div class="rowb" style="margin-top:8px"><button class="btn" data-a="recut">${esc(t('ws.recut'))}</button></div>` : ''}`
    cs.querySelector('[data-a=ok]')?.addEventListener('click', ev => act(() => stCall('episode.review', { project: WS.project, episode: e.code, decision: 'approve' }), ev.target))
    cs.querySelector('[data-a=recut]')?.addEventListener('click', ev => act(() => stCall('episode.assemble', { project: WS.project, episode: e.code }), ev.target))
    box.appendChild(cs)
  }

  // Who has what right now.
  if (e.orders.length) {
    const os = document.createElement('div'); os.className = 'sec'
    os.innerHTML = `<h4>${esc(t('ws.orders'))} <small>${esc(t('ws.ordersHint'))}</small></h4>${e.orders.map(o => `<div class="ord ${esc(o.status)}">
      <span class="mono">#${o.id}</span><b>${esc(o.role === 'human' ? t('ws.you') : o.agent_id ? (bot(o.agent_id)?.name ?? o.agent_id) : t(`st.role.${o.role}`))}</b>
      <span>${esc(t(`ws.ok.${o.kind}`))} · ${esc(o.subject)}${o.status === 'stuck' && o.error ? `<br><small>${esc(o.error)}</small>` : ''}</span>
      <span class="badge${o.status === 'stuck' ? ' bad' : ''}" style="margin-left:auto">${esc(t(`ws.os.${o.status}`))}</span></div>`).join('')}`
    box.appendChild(os)
  }

  // The script, as the person wrote it; editable until production starts.
  const sc = document.createElement('div'); sc.className = 'sec'
  sc.innerHTML = `<h4>${esc(t('ws.epScript'))}</h4>${e.logline ? `<p class="rhint">${esc(e.logline)}</p>` : ''}<pre class="script"></pre>
    <div class="rowb"><button class="btn">${esc(t('ws.editScript'))}</button></div>`
  sc.querySelector('pre').textContent = e.script || t('ws.noScriptYet')
  sc.querySelector('button').onclick = () => {
    sc.innerHTML = `<h4>${esc(t('ws.epScript'))}</h4><input class="fi" placeholder="${esc(t('ws.epTitlePh'))}"><input class="fi" placeholder="${esc(t('ws.epLoglinePh'))}">
      <textarea class="fi" style="min-height:260px"></textarea>
      <small class="rhint">${esc(t(['draft', 'breakdown'].includes(e.stage) ? 'ws.scriptEditHint' : 'ws.scriptEditLate'))}</small>
      <div class="rowb"><button class="btn" data-a="cancel">${esc(t('common.cancel'))}</button><button class="btn pri" data-a="save">${esc(t('common.save'))}</button></div>`
    const [ti, lo] = sc.querySelectorAll('input'); ti.value = e.title; lo.value = e.logline
    sc.querySelector('textarea').value = e.script
    sc.querySelector('[data-a=cancel]').onclick = refresh
    sc.querySelector('[data-a=save]').onclick = async () => {
      try { await stCall('episode.edit', { project: WS.project, episode: e.code, title: ti.value.trim(), logline: lo.value.trim(), script: sc.querySelector('textarea').value }); refresh() }
      catch (err) { alert(err.message) }
    }
  }
  box.appendChild(sc)

  // Its scenes and shots — with the lines while a person is checking the breakdown.
  if (e.scenes.length) {
    box.insertAdjacentHTML('beforeend', `<div class="sec"><h4>${esc(t('ws.epScenesTitle'))}</h4></div>`)
    for (const s of e.scenes) {
      const el = sceneItem(s, refresh, { dialogue: true })
      if (e.stage === 'breakdown_review' && e.scenes.length <= 6) { el.open = true; el.ontoggle() }
      box.appendChild(el)
    }
  }
}

// ─── Bible: characters (and their looks) and locations, and locking them as final ───
async function wsBible(ticket) {
  const [chars, locs] = await Promise.all([stCall('char.list', { project: WS.project }), stCall('loc.list', { project: WS.project })])
  if (ticket !== wsTicket) return
  wsHead(t('ws.bible'))
  const box = wsBody(); box.innerHTML = `<p class="lead">${esc(t('ws.bibleLead'))}</p>`
  if (!chars.length && !locs.length) { box.insertAdjacentHTML('beforeend', `<p class="lead">${esc(t('st.nothingYet'))}</p>`); return }
  const item = (grid, label, status, onToggle, refs) => {
    const el = document.createElement('div'); el.className = 'bitem'
    el.innerHTML = `<div class="rowb"><b>${esc(label)}</b><span class="badge${status === 'locked' ? ' ok' : ''}">${esc(t(status === 'locked' ? 'st.locked' : 'st.draft'))}</span>
      <button class="btn" style="margin-left:auto">${esc(t(status === 'locked' ? 'st.unlock' : 'st.lock'))}</button></div><div class="thumbs"></div>`
    el.querySelector('button').onclick = async () => {
      if (status !== 'locked' && !confirm(t('st.confirmLock', { name: label }))) return
      try { await onToggle(status !== 'locked'); wsShow('bible') } catch (e) { alert(e.message) }
    }
    // You lock what you have looked at: the references it would freeze, beside the button.
    stCall(refs[0], { project: WS.project, ...refs[1], limit: 6 }).then(r => {
      if (ticket !== wsTicket) return
      el.querySelector('.thumbs').innerHTML = (r.refs ?? []).map(a =>
        `<img src="${fileUrl(a.id)}" alt="${esc(a.tags.join(' '))}" title="${esc(a.tags.join(' '))}" data-id="${esc(a.id)}" loading="lazy">`).join('')
        || `<small class="rhint" style="margin:0">${esc(t('st.noRefs'))}</small>`
      el.querySelectorAll('img[data-id]').forEach(img => { img.onclick = () => openImage(img.dataset.id) })
    }).catch(() => {})
    grid.appendChild(el)
  }
  const section = (title, fill) => {
    const s = document.createElement('div'); s.className = 'sec'
    s.innerHTML = `<h4>${esc(title)}</h4><div class="bible"></div>`
    fill(s.querySelector('.bible')); box.appendChild(s)
  }
  if (chars.length) section(t('ws.characters'), grid => {
    for (const c of chars) {
      item(grid, c.name, c.status, lock => stCall(lock ? 'char.lock' : 'char.unlock', { project: WS.project, name: c.name }), ['char.refs', { name: c.name }])
      // Their voice, for the lines spoken off camera: settable on a locked character too.
      const v = typeof c.voice === 'string' ? { voice: c.voice } : c.voice ?? {}
      const vb = document.createElement('div'); vb.className = 'voice rowb'
      vb.innerHTML = `<span class="rhint" style="margin:0">🎙 ${esc(t('ws.voiceOf', { name: c.name }))}</span>
        <input class="fi mono" style="max-width:130px;margin:0" placeholder="${esc(t('ws.voicePh'))}"><input class="fi" style="margin:0" placeholder="${esc(t('ws.voiceHowPh'))}">
        <button class="btn">${esc(t('common.save'))}</button>`
      const [vi, vh] = vb.querySelectorAll('input'); vi.value = v.voice ?? ''; vh.value = v.instructions ?? ''
      vb.querySelector('button').onclick = async () => {
        if (!vi.value.trim()) { vi.focus(); return }
        try { await stCall('char.voice', { project: WS.project, name: c.name, voice: vi.value.trim(), instructions: vh.value.trim() }); vb.querySelector('button').textContent = t('key.saved') }
        catch (e) { alert(e.message) }
      }
      grid.appendChild(vb)
      for (const l of c.looks) item(grid, `${c.name} / ${l.name}`, l.status,
        lock => stCall(lock ? 'char.lock' : 'char.unlock', { project: WS.project, name: c.name, look: l.name }), ['char.refs', { name: c.name, look: l.name }])
    }
  })
  if (locs.length) section(t('ws.locations'), grid => {
    for (const l of locs) item(grid, l.name, l.status, lock => stCall(lock ? 'loc.lock' : 'loc.unlock', { project: WS.project, name: l.name }), ['loc.refs', { name: l.name }])
  })
}

// ─── Settings: the project itself and who is on the crew ───
async function wsSettings(ticket) {
  if (!WS.project) return wsNoProject()
  const [info, crew] = await Promise.all([stCall('project.info', { project: WS.project }), stCall('crew.list')])
  if (ticket !== wsTicket) return
  wsHead(t('ws.settings'))
  const box = wsBody()
  const { lang: plang = 'en', ratio: pratio = '16:9', narrator = null, bgm = null, ...rest } = info.info ?? {}
  const nv = typeof narrator === 'string' ? { voice: narrator } : narrator ?? {}
  const groups = CONVS.filter(c => c.kind === 'group')
  box.innerHTML = `<div style="max-width:720px">
    <div class="sec"><h4>${esc(t('st.projectSec'))} <small class="mono">${esc(info.id)}</small></h4>
      <input class="fi" id="stname" placeholder="${esc(t('st.namePh'))}">
      <div class="brow"><select class="fi" id="stlang" title="${esc(t('st.langTitle'))}">${['en', 'zh-Hans', 'zh-Hant'].map(l => `<option value="${l}">${esc(t(`st.lang.${l}`))}</option>`).join('')}</select>
        <select class="fi" id="stgroup" title="${esc(t('st.groupTitle'))}"><option value="">${esc(t('st.noGroup'))}</option>${groups.map(g => `<option value="${esc(g.id)}">${esc(g.name)}</option>`).join('')}</select></div>
      <small class="rhint">${esc(t('st.groupHint'))}</small>
      <div class="brow"><select class="fi" id="stratio" title="${esc(t('st.ratioTitle'))}">${['9:16', '16:9', '3:4', '1:1'].map(r => `<option value="${r}">${esc(t('st.ratio', { r }))}</option>`).join('')}</select>
        <input class="fi mono" id="stnarr" placeholder="${esc(t('st.narratorPh'))}"><input class="fi" id="stnarrhow" placeholder="${esc(t('ws.voiceHowPh'))}"></div>
      <small class="rhint">${esc(t('st.narratorHint'))}</small>
      <div class="brow" id="stbgm"><span class="rhint" style="margin:0;white-space:nowrap">♪ ${esc(t('st.bgm'))}</span>
        <span class="rhint" style="margin:0;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(bgm ? bgm.name || t('st.bgmSet') : t('st.bgmNone'))}</span>
        <select class="fi" style="max-width:130px;margin:0"${bgm ? '' : ' disabled'}>${['low', 'medium', 'high'].map(l => `<option value="${l}">${esc(t(`st.bgm.${l}`))}</option>`).join('')}</select>
        <label class="btn" style="white-space:nowrap">${esc(t(bgm ? 'st.bgmReplace' : 'st.bgmUpload'))}<input type="file" accept="audio/mpeg,audio/wav,audio/mp4,.mp3,.wav,.m4a" hidden></label>
        ${bgm ? `<button class="btn" data-a="clear" style="color:var(--bad);white-space:nowrap">${esc(t('st.bgmRemove'))}</button>` : ''}</div>
      <small class="rhint">${esc(t('st.bgmHint'))}</small>
      <textarea class="fi mono" id="stinfo" rows="6" spellcheck="false" placeholder="${esc(t('st.infoPh'))}"></textarea>
      <small class="rhint">${esc(t('st.infoHint'))}</small>
      <div class="rowb"><button class="btn pri" id="stsave">${esc(t('common.save'))}</button><button class="btn" id="stnew">${esc(t('ws.newProject'))}</button></div></div>
    <div class="sec"><h4>${esc(t('st.crewSec'))}</h4><small class="rhint">${esc(t('st.crewHint'))}</small><div id="stcrew"></div></div></div>`
  $('#stname').value = info.name
  $('#stlang').value = ['en', 'zh-Hans', 'zh-Hant'].includes(plang) ? plang : 'en'
  $('#stgroup').value = groups.some(g => g.id === info.notify_group) ? info.notify_group : ''
  $('#stinfo').value = Object.keys(rest).length ? JSON.stringify(rest, null, 2) : ''
  $('#stratio').value = ['9:16', '16:9', '3:4', '1:1'].includes(pratio) ? pratio : '16:9'
  $('#stnarr').value = nv.voice ?? ''; $('#stnarrhow').value = nv.instructions ?? ''
  // Background music is saved at once, like the crew roles: a file isn't something to lose to a missed Save.
  const bgmBox = $('#stbgm'), bgmLevel = bgmBox.querySelector('select')
  bgmLevel.value = bgm?.level ?? 'medium'
  const setBgm = async args => {
    try { await stCall('project.bgm', { project: WS.project, ...args }); wsShow('settings') } catch (e) { alert(e.message) }
  }
  bgmLevel.onchange = () => setBgm({ level: bgmLevel.value })
  bgmBox.querySelector('[data-a=clear]')?.addEventListener('click', () => { if (confirm(t('st.bgmConfirmRemove'))) setBgm({ clear: true }) })
  bgmBox.querySelector('input[type=file]').onchange = async e => {
    const f = e.target.files?.[0]; if (!f) return
    if (f.size > 30 * 1024 * 1024) { alert(t('st.bgmTooBig')); return }
    const b64 = await new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.onerror = no; r.readAsDataURL(f) })
    bgmBox.querySelector('label').textContent = t('st.bgmUploading')
    setBgm({ data_b64: b64, name: f.name, level: bgmLevel.value })
  }
  $('#stnew').onclick = wsNewProject
  $('#stsave').onclick = async () => {
    let extra = {}
    if ($('#stinfo').value.trim()) {
      try { extra = JSON.parse($('#stinfo').value) } catch { alert(t('st.infoBad')); return }
      if (!extra || typeof extra !== 'object' || Array.isArray(extra)) { alert(t('st.infoBad')); return }
    }
    try {
      const narr = $('#stnarr').value.trim() ? { voice: $('#stnarr').value.trim(), instructions: $('#stnarrhow').value.trim() } : undefined
      await stCall('project.edit', { project: WS.project, name: $('#stname').value.trim(), notify_group: $('#stgroup').value,
        info: { ...extra, lang: $('#stlang').value, ratio: $('#stratio').value, ...narr ? { narrator: narr } : {}, ...bgm ? { bgm } : {} } })
      await wsProjects(WS.project); wsShow('settings')
    } catch (e) { alert(e.message) }
  }
  // One role per crew member, saved as soon as it is picked.
  const roleOf = new Map(crew.map(c => [c.agent_id, c.role]))
  for (const b of BOTS) {
    const row = document.createElement('div'); row.className = 'mem'; row.style.padding = '6px 0'
    row.innerHTML = `<div class="av" style="background:${col(b.color)}">${esc(b.name.slice(0, 1))}</div><span style="flex:1;min-width:0">${esc(b.name)}</span>
      <select class="fi" style="width:200px;margin:0">${['', ...ROLES].map(r => `<option value="${r}">${esc(t(r ? `st.role.${r}` : 'st.role.none'))}</option>`).join('')}</select>`
    const s = row.querySelector('select'); s.value = roleOf.get(b.id) ?? ''
    s.onchange = async () => {
      try { await stCall('crew.set', { agent_id: b.id, role: s.value || null }) }
      catch (e) { alert(e.message); s.value = roleOf.get(b.id) ?? '' }
    }
    $('#stcrew').appendChild(row)
  }
}

/** Called by the 15-second poll: keep the board current, and a shot's page when something changed. */
async function wsPoll() {
  if (!WS.view || document.hidden) return
  if (WS.view === 'board') return wsBoard(wsTicket).catch(() => {})
  if (WS.view === 'episode') {
    // Not while a cut is playing or a note is being written.
    if ([...document.querySelectorAll('#wsb video')].some(v => !v.paused) || [...document.querySelectorAll('#wsb textarea')].some(x => x.value.trim())) return
    const ticket = wsTicket
    const e = await stCall('episode.show', { project: WS.project, episode: WS.ep }).catch(() => null)
    if (!e || ticket !== wsTicket || epSig(e) === WS.sig) return
    WS.sig = epSig(e); return wsEpisodeRender(e)
  }
  if (WS.view !== 'shot') return
  // Never under someone: not while a take is playing or a rejection is being written.
  if ([...document.querySelectorAll('#wsb video')].some(v => !v.paused) || document.querySelector('#wsb .rjf')) return
  const ticket = wsTicket
  const d = await stCall('shot.detail', { project: WS.project, shot: WS.shot }).catch(() => null)
  if (!d || ticket !== wsTicket || shotSig(d) === WS.sig) return
  WS.sig = shotSig(d); wsShotRender(d)
}

// ═══ Keys ═══
// The studio's model keys, kept in the studio (keys.* actions). Chat models are upstreams (⚙), not keys. A saved
// key never comes back to the browser, only its last four characters, so a key box always starts
// empty: typing replaces the key, leaving it empty keeps it. Other fields show only what was set
// here; the .env / default value is the placeholder, so saving never copies .env into the panel.
const KEY_FIELDS = { seedance: ['base_url', 'api_key'], gpt_image: ['base_url', 'api_key', 'model'], comfy: ['url'], tts: ['base_url', 'api_key', 'model'] }
async function openKeys() {
  const st = await fetch(api('/api/studio/status')).then(r => r.json())
    .then(j => (j.enabled ? stCall('keys.get') : null)).catch(() => null)
  const box = $('#keylist'); box.innerHTML = ''
  if (st) for (const k of st) box.appendChild(keyCard(k.name, k))
  else box.insertAdjacentHTML('beforeend', `<div class="psplit"></div><small class="rhint">${esc(t('key.studioOff'))}</small>`)
  if (!$('#keydlg').open) $('#keydlg').showModal()
}
function keyCard(name, k, warn = '') {
  const el = document.createElement('div'); el.dataset.name = name
  const f = k.fields
  const label = x => t(x === 'base_url' ? 'key.baseUrl' : x === 'url' ? 'key.url' : 'key.model')
  el.innerHTML = `<div class="psplit"></div><h4 style="margin-bottom:6px">${esc(t(`key.${name}`))}</h4>
    <small class="rhint">${esc(t(`key.${name}Hint`))}</small>
    ${warn ? `<small class="rhint" style="color:var(--warn)">${esc(warn)}</small>` : ''}
    ${KEY_FIELDS[name].map(x => x === 'api_key'
      ? `<input type="password" data-f="api_key" autocomplete="new-password" placeholder="${esc(f.api_key?.hint ? t('key.keepPh', { hint: f.api_key.hint }) : t('key.apiKey'))}">`
      : `<input type="text" data-f="${x}" autocomplete="off" title="${esc(label(x))}" placeholder="${esc(f[x]?.value && f[x].source !== 'panel' ? t('key.fromPh', { label: label(x), value: f[x].value, src: t(`key.src.${f[x].source}`) }) : label(x))}">`).join('')}
    ${f.api_key ? `<small class="rhint">${esc(f.api_key.hint ? t('key.keyState', { hint: f.api_key.hint, src: t(`key.src.${f.api_key.source}`) }) : t('key.noKey'))}</small>` : ''}
    <div class="prow" style="justify-content:flex-end;flex-wrap:nowrap">
      ${f.api_key?.source === 'panel' ? `<button class="btn kclear" style="margin-right:auto;color:var(--bad)">${esc(t('key.clear'))}</button>` : ''}
      <button class="btn ktest">${esc(t('key.test'))}</button>
      <button class="btn pri ksave">${esc(t('common.save'))}</button>
    </div>
    <small class="rhint kres" style="white-space:pre-line"></small>`
  for (const i of el.querySelectorAll('[data-f]')) if (i.dataset.f !== 'api_key' && f[i.dataset.f]?.source === 'panel') i.value = f[i.dataset.f].value
  const initial = () => [...el.querySelectorAll('[data-f]')].map(i => i.value).join('\n')
  const start = initial()
  const values = () => Object.fromEntries([...el.querySelectorAll('[data-f]')].map(i => [i.dataset.f, i.value.trim()]))
  const put = body => stCall('keys.set', { name, values: body.values ?? {}, clear: body.clear ? ['api_key'] : [] })
  const note = async (text, ok) => {
    await openKeys()                                    // re-read: the card shows what is stored now
    const r = $(`#keylist [data-name="${name}"] .kres`)
    if (r) { r.textContent = text; r.style.color = ok == null ? '' : ok ? 'var(--ok)' : 'var(--bad)' }
  }
  const save = () => put({ values: values() })
  el.querySelector('.ksave').onclick = async () => {
    try { await save(); await note(t('key.saved'), null) } catch (e) { alert(e.message) }
  }
  el.querySelector('.kclear')?.addEventListener('click', async () => {
    if (!confirm(t('key.confirmClear'))) return
    try { await put({ clear: true }); await note('', null) } catch (e) { alert(e.message) }
  })
  // Test what is saved — and save first when the form was changed, since that is what people mean.
  el.querySelector('.ktest').onclick = async () => {
    const res = el.querySelector('.kres'); res.style.color = ''; res.textContent = t('key.testing')
    try {
      if (initial() !== start) await save()
      const r = await stCall('keys.test', { name })
      const said = t(`key.t.${r.code}`, r.vars ?? {})
      await note(said === `key.t.${r.code}` ? r.message : said, r.ok)
    } catch (e) { res.textContent = e.message; res.style.color = 'var(--bad)' }
  }
  return el
}
$('#keysbtn').onclick = () => openKeys().catch(e => alert(e.message))
$('#keyclose').onclick = () => $('#keydlg').close()

// ═══ Scheduled tasks ═══
// Weekday names from Intl; 2024-01-07 was a Sunday, so index 0 = Sunday
const WD = [0, 1, 2, 3, 4, 5, 6].map(d => new Date(2024, 0, 7 + d).toLocaleDateString(lang, { weekday:'short' }))
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone
let RTS = []
function schedText(r) {
  const tz = r.tz && r.tz !== TZ ? t('r.tz', { tz: r.tz }) : ''
  if (r.kind === 'interval') return r.every_minutes % 60 === 0 ? t('r.everyHours', { n: r.every_minutes / 60 }) : t('r.everyMinutes', { n: r.every_minutes })
  if (r.kind === 'once') return t('r.onceAt', { when: new Date(r.run_at).toLocaleString(lang, { month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit' }) }) + tz
  const d = r.weekdays ?? []
  const days = !d.length ? t('r.daily') : d.join() === '1,2,3,4,5' ? t('r.weekdays') : d.join() === '0,6' ? t('r.weekends') : t('r.weekly', { days: listJoin(d.map(x => WD[x])) })
  return `${days} ${r.at_time}${tz}`
}
function rtState(r) {
  if (r.running) return `<span class="st run">${esc(t('r.running'))}</span>`
  if (r.last_status === 'failed') return `<span class="st bad" title="${esc(r.last_error)}">${esc(t('r.lastFailed'))}</span>`
  if (r.last_status === 'capped') return `<span class="st" title="${esc(r.last_error)}">${esc(t('r.lastCapped'))}</span>`
  if (!r.enabled) return `<span class="st">${esc(t('r.paused'))}</span>`
  return ''
}
async function loadRoutines() {
  const c = cur; if (!c) return
  const list = await fetch(api(`/api/routines?kind=${c.kind}&id=${c.id}`)).then(r => r.json()).catch(() => [])
  if (cur !== c) return
  RTS = list
  const box = $('#routines'); box.innerHTML = ''
  for (const r of list) {
    const el = document.createElement('div')
    el.className = 'rt' + (r.enabled ? '' : ' off')
    const next = r.enabled && r.next_run_at ? t('r.next', { when: when(r.next_run_at) + (new Date(r.next_run_at).toDateString() === new Date().toDateString() ? '' : ' ' + hm(new Date(r.next_run_at))) }) : ''
    el.innerHTML = `<b>${esc(r.name)} ${rtState(r)}</b><small>${esc(schedText(r))}${next}</small>`
    el.onclick = () => editRoutine(r)
    box.appendChild(el)
  }
}

let rEditing = null
$('#rwd').innerHTML = [1, 2, 3, 4, 5, 6, 0].map(d => `<label><input type="checkbox" value="${d}">${esc(WD[d])}</label>`).join('')
const showKind = () => document.querySelectorAll('#rsched>div').forEach(d => { d.hidden = d.dataset.k !== $('#rkind').value })
$('#rkind').onchange = showKind
const localInput = ms => { const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000); return d.toISOString().slice(0, 16) }

function editRoutine(r) {
  if (!cur) return
  rEditing = r
  const c = CONVS.find(x => x.kind === cur.kind && x.id === cur.id)
  $('#rtitle').textContent = r ? t('common.editNamed', { name: r.name }) : t('r.new')
  $('#rwho').textContent = t('r.who', { name: c?.name ?? '' }) + (cur.kind === 'group' ? t('r.whoGroup') : '') + t('r.whoCost')
  $('#rname').value = r?.name ?? ''
  $('#rprompt').value = r?.prompt ?? ''
  $('#rkind').value = r?.kind ?? 'daily'
  $('#rtime').value = r?.at_time || '09:00'
  document.querySelectorAll('#rwd input').forEach(i => { i.checked = (r?.weekdays ?? []).includes(+i.value) })
  $('#revery').value = r?.every_minutes || 60
  $('#rat').value = localInput(r?.run_at ?? Date.now() + 3600_000)
  $('#ron').checked = r?.enabled ?? true
  $('#rstat').textContent = !r ? '' : r.last_run_at
    ? t('r.lastRun', { time: new Date(r.last_run_at).toLocaleString(lang), result: r.last_status === 'failed' ? t('r.failedWith', { err: r.last_error }) : t('r.ok') })
    : t('r.never')
  $('#rdel').style.display = $('#rrun').style.display = r ? '' : 'none'
  showKind()
  $('#rdlg').showModal()
}
$('#addrt').onclick = () => editRoutine(null)
$('#rcancel').onclick = () => $('#rdlg').close()
$('#rsave').onclick = async () => {
  const body = { name: $('#rname').value.trim(), prompt: $('#rprompt').value.trim(), kind: $('#rkind').value,
    target_kind: cur.kind, target_id: cur.id, tz: rEditing?.tz || TZ, enabled: $('#ron').checked,
    at_time: $('#rtime').value, every_minutes: Number($('#revery').value),
    weekdays: [...document.querySelectorAll('#rwd input:checked')].map(i => +i.value),
    run_at: $('#rat').value ? new Date($('#rat').value).getTime() : null }
  const r = rEditing
    ? await fetch(api(`/api/routines/${rEditing.id}`), { method:'PATCH', headers:{'content-type':'application/json'}, body: JSON.stringify(body) })
    : await fetch(api('/api/routines'), { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body) })
  if (!r.ok) { alert(await errText(r)); return }
  $('#rdlg').close(); loadRoutines()
}
$('#rdel').onclick = async () => {
  if (!rEditing || !confirm(t('r.confirmDelete', { name: rEditing.name }))) return
  await fetch(api(`/api/routines/${rEditing.id}`), { method:'DELETE' })
  $('#rdlg').close(); loadRoutines()
}
$('#rrun').onclick = async () => {
  if (!rEditing) return
  const r = await fetch(api(`/api/routines/${rEditing.id}/run`), { method:'POST' })
  if (!r.ok) { alert(await errText(r)); return }
  $('#rdlg').close(); loadRoutines()
}

// Scheduled tasks write into conversations unattended, so poll: left previews, task status,
// and redraw the open conversation on new messages. Not while busy — a reply is streaming.
setInterval(async () => {
  if (busy || document.hidden || $('dialog[open]')) return
  wsPoll()
  const before = cur && CONVS.find(x => x.kind === cur.kind && x.id === cur.id)?.at
  CONVS = await fetch(api('/api/conversations')).then(r => r.json()).catch(() => CONVS)
  renderConvs()
  loadRoutines()
  loadUsage()
  const now = cur && CONVS.find(x => x.kind === cur.kind && x.id === cur.id)
  if (now && now.at !== before && !busy) drawHistory(now, shown)
}, 15_000)

async function reload() {
  ;[BOTS, CONVS] = await Promise.all([
    (await fetch(api('/api/bots'))).json(),
    (await fetch(api('/api/conversations'))).json(),
  ])
  renderConvs()
  await loadUsage()
}

;(async () => {
  try {
    await reload()
    loadClis()
    // A film studio opens on its project; without the studio configured it is the chat as before.
    if (await wsInit()) wsShow('board')
    else if (CONVS.length) openConv(CONVS[0])
    await loadProvs()
    if (!PROVS.length) { fillProv(null); $('#pdlg').showModal()
      hint(t('p.first')) }
  } catch (e) { note(t('err.backend', { msg: e.message ?? e })) }
})()
