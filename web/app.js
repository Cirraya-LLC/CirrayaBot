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
const setTheme = v => {
  try { localStorage.setItem('ma_theme', v) } catch {}
  paintTheme()
}

// ═══ One small menu: the + button, appearance, language ═══
// Opens above an anchor in the sidebar's footer, below one at the top.
// Closes on a pick, a click elsewhere, Esc, or a scroll/resize.
const menu = $('#menu')
let menuFrom = null
function closeMenu() {
  if (menu.hidden) return
  menu.hidden = true
  menuFrom?.setAttribute('aria-expanded', 'false')
  menuFrom = null
}
function openMenu(anchor, items) {
  if (menuFrom === anchor) return closeMenu()
  closeMenu()
  hideTip()
  menu.innerHTML = ''
  for (const it of items) {
    const b = document.createElement('button')
    b.setAttribute('role', it.checked === undefined ? 'menuitem' : 'menuitemradio')
    if (it.checked !== undefined) b.setAttribute('aria-checked', String(it.checked))
    b.innerHTML = `${it.checked !== undefined ? `<i>${it.checked ? '\u2713' : ''}</i>` : ''}<span>${esc(it.label)}</span>`
    b.onclick = () => { closeMenu(); it.on() }
    menu.append(b)
  }
  menu.hidden = false
  const r = anchor.getBoundingClientRect(), up = !!anchor.closest('.foot')
  menu.style.left = `${Math.max(8, Math.min(r.left, innerWidth - menu.offsetWidth - 8))}px`
  menu.style.top = up ? `${r.top - menu.offsetHeight - 6}px` : `${r.bottom + 6}px`
  menuFrom = anchor
  anchor.setAttribute('aria-expanded', 'true')
  ;(menu.querySelector('[aria-checked="true"]') ?? menu.firstElementChild)?.focus()
}
document.addEventListener('mousedown', e => {
  if (!menu.hidden && !menu.contains(e.target) && !menuFrom?.contains(e.target)) closeMenu()
})
menu.addEventListener('keydown', e => {
  const items = [...menu.children], i = items.indexOf(document.activeElement)
  if (e.key === 'Escape') { e.preventDefault(); const a = menuFrom; closeMenu(); a?.focus() }
  else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
  } else if (e.key === 'Tab') closeMenu()
})
for (const ev of ['resize', 'blur']) window.addEventListener(ev, closeMenu)
$('#themebtn').onclick = e => openMenu(e.currentTarget, ['system', 'light', 'dark']
  .map(v => ({ label: t('theme.' + v), checked: readTheme() === v, on: () => setTheme(v) })))
$('#langbtn').onclick = e => openMenu(e.currentTarget, Object.entries(LANG_NAMES)
  .map(([k, v]) => ({ label: v, checked: lang === k, on: () => setLang(k) })))

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
  $('#collapse').dataset.tip = label
  $('#collapse').setAttribute('aria-label', label)
  closeMenu()
  hideTip()
}
$('#collapse').onclick = () => setRail(!railOn())
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
// The footer is icons only, so its names show whether or not the sidebar is
// collapsed — above the icon, since the row sits at the bottom of the window.
function showTip(el) {
  const text = el.dataset.tip || (el.dataset.tipKey ? t(el.dataset.tipKey) : '')
  const foot = !!el.closest('.foot')
  if (!text || !(foot || railOn()) || !menu.hidden) return
  const r = el.getBoundingClientRect()
  tip.textContent = text
  tip.hidden = false
  if (foot) {
    tip.style.transform = 'none'
    tip.style.top = `${r.top - tip.offsetHeight - 6}px`
    tip.style.left = `${Math.max(8, Math.min(r.left, innerWidth - tip.offsetWidth - 8))}px`
  } else {
    tip.style.transform = ''
    tip.style.top = `${r.top + r.height / 2}px`
    tip.style.left = `${r.right + 8}px`
  }
}
for (const ev of ['mouseover', 'focusin']) $('aside').addEventListener(ev, e => {
  const el = e.target.closest?.('[data-tip],[data-tip-key]')
  el ? showTip(el) : hideTip()
})
for (const ev of ['mouseleave', 'focusout']) $('aside').addEventListener(ev, hideTip)
window.addEventListener('blur', hideTip)

// Paints the toggle's icon and label for the state the <head> script restored.
setRail(railOn())

// ═══ Resizing the two sidebars ═══
// Drag the inner edge; double-click it (or Home on the keyboard) for the default.
// The chat in the middle always keeps MIN_CENTRE, so widening one side never
// squeezes it away. The preference is kept as dragged; the window only clamps
// what is shown, so shrinking the window and growing it back restores it.
const MIN_CENTRE = 380
const SIDES = {
  gripL: { v: '--wide', key: 'ma_wide', def: 308, min: 220, max: 480, el: () => $('aside'), other: () => sideWidth('gripR') },
  gripR: { v: '--side2', key: 'ma_side2', def: 290, min: 240, max: 520, el: () => $('#side2'), other: () => sideWidth('gripL') },
}
const wanted = {}
function sideWidth(id) {
  const s = SIDES[id], el = s.el()
  if (id === 'gripL' && railOn()) return 72
  if (id === 'gripR' && el.classList.contains('hide')) return 0
  return parseFloat(getComputedStyle(document.documentElement).getPropertyValue(s.v)) || s.def
}
function setSide(id, px, save) {
  const s = SIDES[id]
  const room = innerWidth - s.other() - MIN_CENTRE
  const w = Math.round(Math.max(s.min, Math.min(s.max, room, px)))
  document.documentElement.style.setProperty(s.v, `${w}px`)
  $(`#${id}`).setAttribute('aria-valuenow', w)
  if (save) {
    wanted[id] = px
    try { px === s.def ? localStorage.removeItem(s.key) : localStorage.setItem(s.key, String(w)) } catch {}
  }
}
for (const [id, s] of Object.entries(SIDES)) {
  const grip = $(`#${id}`)
  try { wanted[id] = +localStorage.getItem(s.key) || s.def } catch { wanted[id] = s.def }
  grip.setAttribute('aria-valuemin', s.min)
  grip.setAttribute('aria-valuemax', s.max)
  grip.addEventListener('pointerdown', e => {
    if (e.button !== 0) return
    e.preventDefault()
    grip.setPointerCapture(e.pointerId)
    grip.classList.add('on')
    document.documentElement.classList.add('resizing')
    hideTip()
    const edge = id === 'gripL' ? s.el().getBoundingClientRect().left : s.el().getBoundingClientRect().right
    const move = ev => setSide(id, id === 'gripL' ? ev.clientX - edge : edge - ev.clientX, false)
    const up = ev => {
      grip.removeEventListener('pointermove', move)
      grip.removeEventListener('pointerup', up)
      grip.removeEventListener('pointercancel', up)
      grip.classList.remove('on')
      document.documentElement.classList.remove('resizing')
      setSide(id, sideWidth(id), true)
    }
    grip.addEventListener('pointermove', move)
    grip.addEventListener('pointerup', up)
    grip.addEventListener('pointercancel', up)
  })
  grip.addEventListener('dblclick', () => setSide(id, s.def, true))
  grip.addEventListener('keydown', e => {
    const step = e.shiftKey ? 48 : 16, dir = id === 'gripL' ? 1 : -1
    const d = { ArrowRight: step * dir, ArrowLeft: -step * dir }[e.key]
    if (d) setSide(id, sideWidth(id) + d, true)
    else if (e.key === 'Home') setSide(id, s.def, true)
    else return
    e.preventDefault()
  })
}
const fitSides = () => { for (const id of Object.keys(SIDES)) setSide(id, wanted[id], false) }
window.addEventListener('resize', fitSides)
fitSides()

let BOTS = [], CONVS = [], cur = null, busy = false, filter = ''
// Messages still being worked on, from /api/runs. In auto mode a run outlives the page that started it.
let RUNS = [], streaming = null      // streaming: the conversation this page is streaming a reply for
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
          ${running(c) ? `<span class="cwork" title="${esc(t('run.working'))}"></span>` : ''}<span class="ctime">${when(c.at)}</span>
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
  const ticket = ++shown
  cur = { kind: c.kind, id: c.id }
  closeSessions()
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
  TASKS = []; taskSig = ''; openTask = null; renderTasks()

  await loadSessions(c)
  if (ticket !== shown) return
  // Back to the session this conversation was last left on (a fresh "New session" included);
  // otherwise the most recent one.
  const key = convKey(c)
  curSession = lastSession.has(key) && (lastSession.get(key) === null || SESSIONS.some(x => x.id === lastSession.get(key)))
    ? lastSession.get(key) : SESSIONS[0]?.id ?? null
  paintSession()

  // Tasks before history: an event card needs to know whether its task is still waiting on a reply
  await loadTasks()
  if (!await drawHistory(c, ticket)) return
  renderConvs(); $('#in').focus(); sendMode(); paintRun()
}

/** Fetch history and redraw it all. Returns false if the user has switched away. */
async function drawHistory(c, ticket) {
  // No session yet ("New session", or a conversation nobody has spoken in): nothing to fetch
  const hist = curSession == null ? [] : await (await fetch(api(
    `${c.kind === 'group' ? `/api/groups/${c.id}/messages` : `/api/dm/${c.id}`}?session=${encodeURIComponent(curSession)}`))).json()
  if (ticket !== shown) return false                  // two quick clicks: the earlier one arrived late, drop it
  const log = $('#log'); log.innerHTML = ''
  for (const e of hist) {
    let el
    if (e.role === 'event') el = eventCard(e.event ?? {})
    else if (e.role === 'tool') {
      el = toolLine(BOTS.find(b => b.name === e.speaker)?.id ?? c.id, toolLabel(e.name, e.args))
      finishTool(el, e.output)
    // 'User' is the speaker the server stores for the person in group logs (data, not UI text)
    } else if (c.kind === 'group') {
      (el = bubble(BOTS.find(b => b.name === e.speaker)?.id ?? null, e.role === 'user' || e.speaker === 'User')).innerHTML = fmt(e.text)
    } else (el = bubble(c.id, e.role === 'user')).innerHTML = fmt(e.content)
    // A search hit jumps to its message by this id
    ;(el.closest('.msg') ?? el).dataset.mid = e.id
  }
  if (!log.children.length) empty(c)
  log.scrollTop = log.scrollHeight
  return true
}

function empty(c) {
  // A fresh session in a conversation that already has others: say plainly that it starts over
  const fresh = curSession == null && SESSIONS.length ? `<p>${esc(t('ses.draft'))}</p>` : ''
  $('#log').innerHTML = c.kind === 'group'
    ? `<div class="empty"><h2>${esc(c.name)}</h2><p>${esc(t('empty.groupMembers', { members: listJoin(c.members.map(id => bot(id)?.name ?? id)) }))}</p>
       <p>${esc(t('empty.groupHow'))}</p>${fresh}</div>`
    : `<div class="empty"><h2>${esc(c.name)}</h2><p>${esc(c.tag)}</p>
       <p>${esc(t('empty.agentRecall'))}</p>${fresh}</div>`
}

// ═══ Sessions ═══
// A conversation holds several sessions; the model only sees the one on screen. null = a new
// session that exists only here until its first message (so an unused one leaves nothing behind).
let SESSIONS = [], curSession = null
const lastSession = new Map()       // conversation → the session it was left on
const convKey = c => `${c.kind}:${c.id}`
const sesTitle = x => x?.title || t('ses.untitled')

async function loadSessions(c) {
  const r = await fetch(api(`/api/sessions?kind=${c.kind}&id=${encodeURIComponent(c.id)}`)).catch(() => null)
  SESSIONS = r?.ok ? await r.json() : []
}
function paintSession() {
  for (const id of ['#sesbtn', '#sesnew', '#sesfind']) $(id).hidden = !cur
  $('#sesname').textContent = sesTitle(SESSIONS.find(x => x.id === curSession))
  if (!$('#sespanel').hidden && !$('#sesq').value.trim()) renderSessions()
}

/** Show another session of the open conversation, optionally landing on one message. */
async function switchSession(id, jumpTo = null) {
  if (!cur) return
  const c = CONVS.find(x => x.kind === cur.kind && x.id === cur.id); if (!c) return
  const ticket = ++shown
  curSession = id; lastSession.set(convKey(c), id)
  paintSession()
  if (!await drawHistory(c, ticket)) return
  if (jumpTo == null) { $('#in').focus(); return }
  const el = $('#log').querySelector(`[data-mid="${jumpTo}"]`)
  if (!el) { note(t('ses.tooOld', { n: 300 })); return }
  el.scrollIntoView({ block: 'center' })
  el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash')
}

function newSession() {
  if (!cur || curSession === null) { $('#in').focus(); return }
  switchSession(null)
}

// The panel: sessions when the box is empty, matching messages from every session when not.
const panel = $('#sespanel')
function openSessions(focusSearch = false) {
  if (!cur) return
  const r = $('#sesbtn').getBoundingClientRect()
  panel.hidden = false
  panel.style.top = `${r.bottom + 6}px`
  panel.style.left = `${Math.max(8, Math.min(r.right - panel.offsetWidth, innerWidth - panel.offsetWidth - 8))}px`
  $('#sesbtn').setAttribute('aria-expanded', 'true')
  $('#sesq').value = ''; renderSessions()
  ;(focusSearch ? $('#sesq') : panel.querySelector('.sprow.on') ?? $('#sesq')).focus()
}
function closeSessions() {
  if (panel.hidden) return
  panel.hidden = true; $('#sesbtn').setAttribute('aria-expanded', 'false')
}
$('#sesbtn').onclick = () => (panel.hidden ? openSessions() : closeSessions())
$('#sesfind').onclick = () => openSessions(true)
$('#sesnew').onclick = () => { closeSessions(); newSession() }
document.addEventListener('mousedown', e => {
  if (!panel.hidden && !panel.contains(e.target) && !e.target.closest('#sesbtn,#sesfind')) closeSessions()
})
panel.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !e.target.classList.contains('ren')) { e.preventDefault(); closeSessions(); $('#sesbtn').focus() }
  if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !e.target.classList.contains('ren')) {
    const rows = [$('#sesq'), ...panel.querySelectorAll('.sprow,.hit')]
    const i = rows.indexOf(document.activeElement)
    rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus()
    e.preventDefault()
  }
})
addEventListener('resize', closeSessions)

function renderSessions() {
  const box = $('#seslist'); box.innerHTML = ''
  const head = document.createElement('div'); head.className = 'sphead'; head.textContent = t('ses.list')
  box.appendChild(head)
  const add = document.createElement('div')
  add.className = 'sprow newrow' + (curSession === null ? ' on' : ''); add.tabIndex = 0
  add.innerHTML = `<span class="st"><b>＋ ${esc(t('ses.new'))}</b></span>`
  add.onclick = () => { closeSessions(); newSession() }
  add.onkeydown = e => { if (e.key === 'Enter') add.onclick() }
  box.appendChild(add)
  for (const x of SESSIONS) {
    const row = document.createElement('div')
    row.className = 'sprow' + (x.id === curSession ? ' on' : ''); row.tabIndex = 0
    row.innerHTML = `<span class="st"><b></b><small>${esc(t('ses.count', { n: x.count, when: when(x.updated_at) }))}</small></span>
      <button class="sb ren-b" title="${esc(t('ses.rename'))}" aria-label="${esc(t('ses.rename'))}">✎</button>
      <button class="sb del" title="${esc(t('ses.delete'))}" aria-label="${esc(t('ses.delete'))}">🗑</button>`
    row.querySelector('b').textContent = sesTitle(x)
    const go = () => { closeSessions(); if (x.id !== curSession) switchSession(x.id); else $('#in').focus() }
    row.onclick = e => { if (!e.target.closest('button,input')) go() }
    row.onkeydown = e => { if (e.key === 'Enter' && e.target === row) go()
      if (e.key === 'F2' && e.target === row) rename(row, x); if (e.key === 'Delete' && e.target === row) remove(x) }
    row.querySelector('.ren-b').onclick = () => rename(row, x)
    row.querySelector('.del').onclick = () => remove(x)
    box.appendChild(row)
  }
}

function rename(row, x) {
  const st = row.querySelector('.st')
  const inp = document.createElement('input'); inp.className = 'ren'; inp.maxLength = 80
  inp.value = x.named ? x.title : ''; inp.placeholder = sesTitle(x)
  st.replaceWith(inp); inp.focus(); inp.select()
  let done = false
  const finish = async save => {
    if (done) return; done = true
    if (save && inp.value.trim() !== (x.named ? x.title : '')) {
      const r = await fetch(api(`/api/sessions/${x.id}`), { method:'PATCH', headers:{'content-type':'application/json'},
        body: JSON.stringify({ title: inp.value }) })
      if (!r.ok) alert(await errText(r))
      if (cur) await loadSessions(cur)
    }
    paintSession(); renderSessions()
    panel.querySelector(`.sprow:nth-child(${[...SESSIONS].findIndex(s => s.id === x.id) + 3})`)?.focus()
  }
  inp.onkeydown = e => { if (e.key === 'Enter') finish(true); if (e.key === 'Escape') { e.stopPropagation(); finish(false) } }
  inp.onblur = () => finish(true)
}

async function remove(x) {
  if (!confirm(t('ses.confirmDelete', { name: sesTitle(x), n: x.count }))) return
  const r = await fetch(api(`/api/sessions/${x.id}`), { method:'DELETE' })
  if (!r.ok) { alert(await errText(r)); return }
  const c = cur
  await loadSessions(c)
  if (x.id === curSession) switchSession(SESSIONS[0]?.id ?? null)
  else paintSession()
  renderSessions()
  CONVS = await (await fetch(api('/api/conversations'))).json(); renderConvs()
}

// Search every session of this conversation. Debounced; an answer to an older query is dropped.
let sq = 0, sqTimer = null
$('#sesq').oninput = () => {
  clearTimeout(sqTimer)
  const q = $('#sesq').value.trim()
  if (!q) { sq++; renderSessions(); return }
  sqTimer = setTimeout(async () => {
    const mine = ++sq, c = cur
    const r = await fetch(api(`/api/search?q=${encodeURIComponent(q)}&kind=${c.kind}&id=${encodeURIComponent(c.id)}`)).catch(() => null)
    const hits = r?.ok ? await r.json() : []
    if (mine !== sq || panel.hidden) return
    renderHits(q, hits)
  }, 180)
}

function renderHits(q, hits) {
  const box = $('#seslist'); box.innerHTML = ''
  if (!hits.length) { box.innerHTML = `<div class="spnone">${esc(t('ses.noHits', { q }))}</div>`; return }
  const mark = s => {
    const lo = s.toLowerCase(), k = q.toLowerCase(); let out = '', i = 0, j
    while ((j = lo.indexOf(k, i)) >= 0) { out += esc(s.slice(i, j)) + `<mark>${esc(s.slice(j, j + k.length))}</mark>`; i = j + k.length }
    return out + esc(s.slice(i))
  }
  let last = null
  for (const h of hits) {
    if (h.session !== last) {
      last = h.session
      const head = document.createElement('div'); head.className = 'sphead'
      head.textContent = sesTitle(SESSIONS.find(x => x.id === h.session)); box.appendChild(head)
    }
    const el = document.createElement('button'); el.className = 'hit'
    el.innerHTML = `<small>${esc(h.role === 'user' ? t('msg.you') : h.speaker || bot(h.conv)?.name || '')} · ${esc(when(h.at))}</small>${mark(h.snippet)}`
    el.onclick = () => { closeSessions(); switchSession(h.session, h.id) }
    box.appendChild(el)
  }
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

function bubble(botId, mine) {
  const log = $('#log')
  if (log.querySelector('.empty')) log.innerHTML = ''
  const b = bot(botId)
  const el = document.createElement('div')
  el.className = 'msg' + (mine ? ' me' : '')
  el.innerHTML = `<div class="mav" style="background:${mine ? '#5b8cff' : col(b?.color)}">${
    mine ? esc(t('msg.you')) : esc(b?.name?.slice(0,1) ?? '?')}</div>
    <div class="mwrap"><div class="mname" style="color:${b ? col(b.color) : 'var(--dim)'}">${esc(b?.name ?? '')}</div>
    <div class="bub"></div></div>`
  log.appendChild(el); log.scrollTop = log.scrollHeight
  return el.querySelector('.bub')
}

function toolLabel(name, args = {}) {
  if (name === 'update_plan') {
    const plan = Array.isArray(args.plan) ? args.plan : []
    return t('tool.plan', { done: plan.filter(x => x?.status === 'completed').length, n: plan.length })
  }
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
$('#send').onclick = () => busy ? stopRun(streaming) : send()

// ═══ Runs: still working, and Stop ═══
const running = c => c && RUNS.some(r => r.kind === c.kind && r.id === c.id)

/** The send button is Stop while this page is streaming a reply. */
function sendMode() {
  const b = $('#send')
  b.classList.toggle('stop', busy)
  b.textContent = busy ? '■' : '↑'
  b.title = busy ? t('run.stopTitle') : ''
  b.disabled = busy ? false : !cur
}

async function stopRun(c = cur) {
  if (!c) return
  await fetch(api('/api/runs/stop'), { method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({ kind: c.kind, id: c.id }) }).catch(() => {})
  await loadRuns()
}
$('#runstop').onclick = () => stopRun()

/**
 * The bar above the composer: this conversation is being worked on, but not by a stream on this
 * page (it was started elsewhere, or before this page was opened/reloaded). History is redrawn
 * while it runs, so the work shows up as it lands.
 */
function paintRun() {
  const r = !busy && cur && RUNS.find(x => x.kind === cur.kind && x.id === cur.id)
  $('#runbar').hidden = !r
  if (!r) return
  const who = bot(r.speaker)?.name ?? ''
  $('#runtxt').textContent = t('run.bg', { who, min: Math.max(0, Math.round((Date.now() - r.started_at) / 60000)) })
}

let runTimer = null
async function loadRuns() {
  const was = running(cur)
  RUNS = await fetch(api('/api/runs')).then(r => r.ok ? r.json() : RUNS).catch(() => RUNS)
  renderConvs(); paintRun()
  // Follow a run in the open conversation closely; when it ends, one last redraw shows the answer
  const now = running(cur)
  if (cur && !busy && (now || was)) {
    const before = CONVS.find(x => x.kind === cur.kind && x.id === cur.id)?.at
    CONVS = await fetch(api('/api/conversations')).then(r => r.json()).catch(() => CONVS)
    renderConvs()
    const c = CONVS.find(x => x.kind === cur.kind && x.id === cur.id)
    // Tool calls don't move the list's timestamp, so while it runs redraw every tick — unless the
    // person has scrolled up to read, which a redraw would yank them away from.
    const log = $('#log'), reading = log.scrollHeight - log.scrollTop - log.clientHeight > 80
    if (c && (!now || (!reading || c.at !== before))) { if (!now) { await loadSessions(c); paintSession() } drawHistory(c, shown) }
  }
  clearTimeout(runTimer)
  if (RUNS.length) runTimer = setTimeout(loadRuns, 4000)
}

async function send() {
  const text = input.value.trim()
  if (!text || !cur || busy) return
  input.value = ''; input.style.height = 'auto'
  bubble(null, true).innerHTML = fmt(text)
  const ticket = shown, target = cur
  busy = true; streaming = target; sendMode(); paintRun()
  const bubs = new Map(), tools = new Map()
  try {
    const res = await fetch(api('/api/chat'), { method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({ target: cur.kind === 'group' ? { type:'group', id:cur.id } : { type:'agent', id:cur.id }, text,
        session: curSession ?? 'new' }) })
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
        // The session this went into — a new one's id, the first time. Remembered even if the
        // person switched away, so coming back lands on the conversation they just had.
        if (ev === 'session') {
          lastSession.set(convKey(target), d.id)
          if (ticket === shown) { curSession = d.id; loadSessions(target).then(paintSession) }
          continue
        }
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
        else if (ev === 'tool') {
          if (d.phase === 'retry') {
            // the failed attempt may have streamed half a sentence; the retry repeats it all
            bubs.get(d.botId)?.el.closest('.msg')?.remove(); bubs.delete(d.botId)
            note(t('note.retry', { name: bot(d.botId)?.name ?? '', reason: d.reason })); continue
          }
          if (d.phase === 'trim') { note(t('note.trim', { n: d.dropped })); continue }
          if (d.phase === 'nudge') { bubs.delete(d.botId); note(t('note.nudge', { n: d.open })); continue }
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
  busy = false; streaming = null; sendMode(); input.focus()
  loadRuns(); loadTasks()
  CONVS = await (await fetch(api('/api/conversations'))).json(); renderConvs()
  loadUsage()                                         // the turn just cost something; show it
  if (cur?.kind === target.kind && cur?.id === target.id) { await loadSessions(cur); paintSession() }
  // switched away and back mid-reply: the screen shows pre-reply history, reload it
  if (ticket !== shown && cur?.kind === target.kind && cur?.id === target.id) {
    const c = CONVS.find(x => x.kind === cur.kind && x.id === cur.id); if (c) openConv(c)
  }
}

// ═══ Groups ═══
let gEditing = null
const newMenu = e => openMenu(e.currentTarget, [
  { label: t('side.newAgent'), on: () => editBot(null) },
  { label: t('side.newGroup'), on: () => openGroupDlg(null) },
])
$('#newconv').onclick = newMenu
$('#railnew').onclick = newMenu
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
  $('#gdlg').showModal()
}
$('#gcancel').onclick = () => $('#gdlg').close()
$('#gsave').onclick = async () => {
  const name = $('#gname').value.trim()
  const members = [...$('#gmembers').querySelectorAll('input:checked')].map(i => i.value)
  if (!name || members.length < 2) { alert(t('g.invalid')); return }
  const lead = $('#glead').value
  if (gEditing) { if (!await patchGroup(gEditing.id, { name, members, lead })) return }
  else {
    const r = await fetch(api('/api/groups'), { method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({ name, members, lead }) })
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
  if (c) await openConv(c)
  else { cur = null; $('#log').innerHTML = ''; $('#htitle').textContent = t('head.pick'); $('#hsub').textContent = ''; paintSession() }
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
  const def = PROVS.find(p => p.is_default)
  $('#bprov').innerHTML = `<option value="">${esc(def ? t('b.defaultProvNamed', { name: def.name }) : t('b.defaultProv'))}</option>` +
    PROVS.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')
  $('#bprov').value = PROVS.some(p => p.id === b?.provider_id) ? b.provider_id : ''
  // A new provider likely doesn't have the old model; restore it when switching back
  $('#bprov').onchange = () => loadModels($('#bprov').value,
    $('#bprov').value === (b?.provider_id ?? '') ? (b?.model ?? '') : '')
  loadModels($('#bprov').value, b?.model ?? '')
  $('#beffort').innerHTML = ['', 'low', 'medium', 'high']
    .map(e => `<option value="${e}">${esc(t(e ? `b.effort${e[0].toUpperCase()}${e.slice(1)}` : 'b.effortNone'))}</option>`).join('')
  $('#beffort').value = ['low', 'medium', 'high'].includes(b?.effort) ? b.effort : ''
  $('#bapproval').innerHTML = ['', 'off', 'match', 'all']
    .map(m => `<option value="${m}">${esc(t(m ? `b.approval${m[0].toUpperCase()}${m.slice(1)}` : 'b.approvalDefault'))}</option>`).join('')
  $('#bapproval').value = ['off', 'match', 'all'].includes(b?.approval) ? b.approval : ''
  $('#bauto').innerHTML = ['', 'auto', 'manual']
    .map(m => `<option value="${m}">${esc(t(m ? `b.auto${m[0].toUpperCase()}${m.slice(1)}` : 'b.autoDefault'))}</option>`).join('')
  $('#bauto').value = ['auto', 'manual'].includes(b?.autonomy) ? b.autonomy : ''
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
$('#bcancel').onclick = () => $('#bdlg').close()
$('#bsave').onclick = async () => {
  const cap = toMicro($('#bcap').value)
  if (cap === false) { alert(t('sp.capBad')); return }
  const body = { name:$('#bname').value.trim(), description:$('#bdesc').value.trim(), persona:$('#bpersona').value.trim(),
    provider_id:$('#bprov').value, model:chosenModel(), effort:$('#beffort').value, approval:$('#bapproval').value, autonomy:$('#bauto').value,
    daily_cap_micro: cap === '' ? null : cap }
  if (!body.name || !body.persona) { alert(t('b.needName')); return }
  if (!body.model) { alert(t('b.needModel')); return }
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
  $('#pdefcap').value = dollars(USAGE.default_cap_micro); await loadPolicy(); await loadEffort(); await loadAutonomy(); $('#pdlg').showModal() }

async function loadAutonomy() {
  const r = await (await fetch(api('/api/settings/autonomy'))).json().catch(() => null)
  if (!r) return
  $('#pdefauto').innerHTML = (r.modes ?? ['auto', 'manual']).map(m => `<option value="${m}">${esc(t(`au.${m}`))}</option>`).join('')
  $('#pdefauto').value = r.autonomy ?? 'auto'
}
$('#pautosave').onclick = async () => {
  const r = await fetch(api('/api/settings/autonomy'), { method:'PUT', headers:{'content-type':'application/json'},
    body: JSON.stringify({ autonomy: $('#pdefauto').value }) })
  if (!r.ok) { hint((await r.json()).error, 'bad'); return }
  hint(t('au.saved'), 'good')
}

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
  // Today's figure in the row; today and the month in its tip.
  $('#spendfoot').textContent = money(USAGE.day?.cost_micro ?? 0)
  $('#spendfoot').dataset.tip = t('sp.footer', { day: money(USAGE.day?.cost_micro ?? 0), month: money(USAGE.month?.cost_micro ?? 0) })
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
  if (curSession == null) { alert(t('x.nothing')); return }
  const r = await fetch(api(`${xPath('export', cur)}?session=${encodeURIComponent(curSession)}`))
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
  // Always into a session of its own, so there is nothing to ask: it can't overwrite or mix with anything
  const r = await fetch(api(xPath('import', cur)), { method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({ doc }) })
  if (!r.ok) { alert(await errText(r)); return }
  const { imported, session } = await r.json()
  lastSession.set(convKey(cur), session)
  await reloadAndReopen()
  note(t('x.imported', { n: imported }))
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

// ═══ Scheduled tasks ═══
// Weekday names from Intl; 2024-01-07 was a Sunday, so index 0 = Sunday
// ═══ Background tasks ═══
// Work a conversation handed out. They run on their own and report back into the conversation as
// event cards; this list is where to see them all, answer one, approve one, or stop one.
let TASKS = [], taskSig = '', openTask = null, taskTimer = null
const OPEN_ST = ['queued', 'running', 'waiting']
const taskOf = id => TASKS.find(x => x.id === Number(id))

async function loadTasks() {
  const c = cur; if (!c) return
  const list = await fetch(api(`/api/tasks?kind=${c.kind}&id=${c.id}`)).then(r => r.ok ? r.json() : null).catch(() => null)
  if (cur !== c || !list) return
  const sig = convKey(c) + '|' + list.map(x => `${x.id}:${x.status}:${x.updated_at}`).join()
  const moved = taskSig && sig !== taskSig && taskSig.startsWith(convKey(c) + '|')
  TASKS = list; taskSig = sig
  renderTasks()
  // A task moved: its card may have landed in the transcript, and the front thread may be waking
  // to tell about it. Redraw unless a reply is streaming here or the person has scrolled up to read.
  if (moved && !busy) {
    const log = $('#log'), reading = log.scrollHeight - log.scrollTop - log.clientHeight > 80
    const conv = CONVS.find(x => x.kind === c.kind && x.id === c.id)
    if (conv && !reading) drawHistory(conv, shown)
    loadRuns()
  }
  clearTimeout(taskTimer)
  if (list.some(x => OPEN_ST.includes(x.status))) taskTimer = setTimeout(loadTasks, 4000)
}

const stPill = s => `<span class="st ${s === 'waiting' ? 'warn' : s === 'failed' ? 'bad' : OPEN_ST.includes(s) ? 'run' : ''}">${esc(t('tk.st.' + s))}</span>`

function renderTasks() {
  const box = $('#tasks'); if (!box) return
  if (!TASKS.length) { box.innerHTML = `<small class="tknone">${esc(t('tk.none'))}</small>`; return }
  box.innerHTML = ''
  for (const x of TASKS) {
    const el = document.createElement('div')
    el.className = 'tk' + (openTask === x.id ? ' on' : '')
    const who = bot(x.agent_id)?.name ?? x.agent_id
    el.innerHTML = `<div class="tkh" tabindex="0" role="button"><b>${stPill(x.status)} <span>#${x.id}</span> ${esc(x.title)}</b>
      <small>${esc(who)} · ${esc(when(x.created_at))}</small></div>`
    const head = el.querySelector('.tkh')
    head.onclick = () => { openTask = openTask === x.id ? null : x.id; renderTasks() }
    head.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); head.click() } }
    if (openTask === x.id) el.appendChild(taskDetail(x))
    box.appendChild(el)
  }
}

function taskDetail(x) {
  const d = document.createElement('div'); d.className = 'tkd'
  const by = x.by_agent && x.by_agent !== x.agent_id ? bot(x.by_agent)?.name : ''
  if (by) d.insertAdjacentHTML('beforeend', `<small>${esc(t('tk.by', { name: by }))}</small>`)
  if (x.brief) d.insertAdjacentHTML('beforeend', `<small class="lbl">${esc(t('tk.brief'))}</small><pre>${esc(x.brief)}</pre>`)
  if (x.status === 'waiting' && x.question) d.appendChild(replyBox(x))
  if (x.status === 'waiting' && x.approval) {
    const a = document.createElement('div')
    a.innerHTML = `<small class="lbl">${esc(t('tk.wantsRun', { name: bot(x.agent_id)?.name ?? '' }))}</small><code></code>`
    a.querySelector('code').textContent = x.approval.subject
    d.appendChild(a); askOn(a, x.approval.id)
  }
  if (x.result) d.insertAdjacentHTML('beforeend', `<small class="lbl">${esc(t('tk.result'))}</small><pre>${esc(x.result)}</pre>`)
  // What it ran: fetched only when someone opens it
  const tr = document.createElement('details')
  tr.innerHTML = `<summary>${esc(t('tk.trace', { n: '…' }))}</summary><div class="trc"></div>`
  tr.ontoggle = async () => {
    if (!tr.open) return
    const full = await fetch(api(`/api/tasks/${x.id}`)).then(r => r.json()).catch(() => null)
    const steps = full?.trace ?? []
    tr.querySelector('summary').textContent = t('tk.trace', { n: steps.length })
    tr.querySelector('.trc').innerHTML = steps.map(st => `<div><code></code><pre></pre></div>`).join('')
    tr.querySelectorAll('.trc>div').forEach((el, i) => {
      el.querySelector('code').textContent = toolLabel(steps[i].name, steps[i].args)
      el.querySelector('pre').textContent = steps[i].output ?? ''
    })
  }
  d.appendChild(tr)
  if (OPEN_ST.includes(x.status)) {
    const b = document.createElement('button'); b.className = 'btn'; b.textContent = t('tk.stop')
    b.onclick = async () => { b.disabled = true; await fetch(api(`/api/tasks/${x.id}/stop`), { method:'POST' }); loadTasks() }
    d.appendChild(b)
  }
  return d
}

/** Answer a task's question. The answer goes to the task only — not into the conversation, so a password stays out of it. */
function replyBox(x) {
  const f = document.createElement('form'); f.className = 'tkr'
  f.innerHTML = `<small class="lbl"></small><div class="q"></div><div class="row"><input autocomplete="off"><button class="btn pri"></button></div>`
  f.querySelector('.lbl').textContent = t('tk.asks', { name: bot(x.agent_id)?.name ?? '' })
  f.querySelector('.q').textContent = x.question
  f.querySelector('input').placeholder = t('tk.replyPh')
  f.querySelector('button').textContent = t('tk.send')
  f.onsubmit = async e => {
    e.preventDefault()
    const text = f.querySelector('input').value.trim(); if (!text) return
    f.querySelectorAll('input,button').forEach(el => el.disabled = true)
    const r = await fetch(api(`/api/tasks/${x.id}/answer`), { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ text }) })
    f.innerHTML = `<small>${esc(r.ok ? t('tk.sent') : await errText(r))}</small>`
    loadTasks()
  }
  return f
}

/** One piece of task news in the transcript. A question or an approval still open is answerable right here. */
function eventCard(e) {
  const log = $('#log')
  if (log.querySelector('.empty')) log.innerHTML = ''
  const b = bot(e.agent_id), name = b?.name ?? e.agent ?? ''
  const v = { id: e.task, name, title: e.title ?? '', by: e.by ?? '' }
  const head = e.kind === 'stopped' ? t(e.by ? 'ev.stoppedBy' : 'ev.stopped', v)
    : ['asked', 'approval', 'done', 'failed', 'answered'].includes(e.kind) ? t('ev.' + e.kind, v) : `#${e.task}`
  const el = document.createElement('div')
  el.className = 'tev ' + (e.kind ?? '')
  el.innerHTML = `<div class="th"><i style="background:${col(b?.color)}"></i><span></span></div>`
  el.querySelector('span').textContent = head
  const x = taskOf(e.task)
  if (e.kind === 'asked') {
    // Only the newest question of a task still waiting gets a reply box; older ones just say what was asked
    if (x?.status === 'waiting' && x.question === e.text) el.appendChild(replyBox(x))
    else el.insertAdjacentHTML('beforeend', `<div class="q"></div><small>${esc(t('ev.over'))}</small>`), el.querySelector('.q').textContent = e.text
  } else if (e.kind === 'approval') {
    el.insertAdjacentHTML('beforeend', '<code></code>'); el.querySelector('code').textContent = e.text
    if (x?.status === 'waiting' && x.approval?.id === e.approval) askOn(el, e.approval)
  } else if (e.kind === 'done' || e.kind === 'failed') {
    el.insertAdjacentHTML('beforeend', '<pre></pre>'); el.querySelector('pre').textContent = e.text
  }
  el.onclick = ev => { if (ev.target.closest('form,button,input')) return; openTask = Number(e.task); renderTasks(); $('#tasks').scrollIntoView({ block: 'nearest' }) }
  log.appendChild(el)
  return el
}

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
  const before = cur && CONVS.find(x => x.kind === cur.kind && x.id === cur.id)?.at
  CONVS = await fetch(api('/api/conversations')).then(r => r.json()).catch(() => CONVS)
  renderConvs()
  loadRoutines()
  loadUsage()
  if (!RUNS.length) loadRuns()                      // started elsewhere (another tab, a scheduled task)
  const now = cur && CONVS.find(x => x.kind === cur.kind && x.id === cur.id)
  if (now && now.at !== before && !busy) {
    await loadSessions(now); paintSession()          // a scheduled task may have written into a session of its own
    drawHistory(now, shown)
  }
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
    if (CONVS.length) openConv(CONVS[0])
    loadRuns()
    await loadProvs()
    if (!PROVS.length) { fillProv(null); $('#pdlg').showModal()
      hint(t('p.first')) }
  } catch (e) { note(t('err.backend', { msg: e.message ?? e })) }
})()
