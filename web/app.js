import { lang, t, setLang, applyDom, LANG_NAMES } from './i18n.js'

const $ = s => document.querySelector(s)
const K = new URLSearchParams(location.search).get('k')
const api = p => K ? `${p}${p.includes('?') ? '&' : '?'}k=${K}` : p
// Every request carries the UI language so the server answers errors in it
const fetch = (url, o = {}) => window.fetch(url, { ...o, headers: { ...o.headers, 'X-Lang': lang } })

applyDom()
$('#lang').innerHTML = Object.entries(LANG_NAMES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')
$('#lang').value = lang
$('#lang').onchange = e => setLang(e.target.value)
const listJoin = xs => xs.join(t('common.sep'))
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]))

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
  const log = $('#log'); log.innerHTML = ''
  $('#hav').outerHTML = avatar(c).replace('class="av', 'id="hav" class="av')
  $('#htitle').textContent = c.name
  $('#hsub').textContent = c.kind === 'group'
    ? t('head.groupSub', { members: listJoin(c.members.map(id => bot(id)?.name ?? id)) })
    : (c.tag || '')
  $('#in').placeholder = t(c.kind === 'group' ? 'comp.toGroup' : 'comp.toAgent', { name: c.name })
  renderMembers(c)
  loadMemory(c)

  if (!await drawHistory(c, ticket)) return
  renderConvs(); $('#in').focus(); $('#send').disabled = busy
}

/** Fetch history and redraw it all. Returns false if the user has switched away. */
async function drawHistory(c, ticket) {
  const hist = await (await fetch(api(c.kind === 'group' ? `/api/groups/${c.id}/messages` : `/api/dm/${c.id}`))).json()
  if (ticket !== shown) return false                  // two quick clicks: the earlier one arrived late, drop it
  const log = $('#log'); log.innerHTML = ''
  for (const e of hist) {
    // 'User' is the speaker the server stores for the person in group logs (data, not UI text)
    if (c.kind === 'group') bubble(BOTS.find(b => b.name === e.speaker)?.id ?? null, e.role === 'user' || e.speaker === 'User').innerHTML = fmt(e.text)
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
            const label = d.name === 'bash' ? d.args.command
              : d.name === 'read_file' ? t('tool.read', { path: d.args.path })
              : d.name === 'write_file' ? t('tool.write', { path: d.args.path }) : d.name
            tools.set(key, toolLine(d.botId, label))
          } else {
            const el = tools.get(key)
            if (el) { el.classList.remove('run'); el.querySelector('pre').textContent = d.output ?? '' }
          }
        }
      }
    }
  } catch (e) { if (ticket === shown) note('⚠ ' + (e.message ?? e)) }
  busy = false; $('#send').disabled = false; input.focus()
  CONVS = await (await fetch(api('/api/conversations'))).json(); renderConvs()
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
  const def = PROVS.find(p => p.is_default)
  $('#bprov').innerHTML = `<option value="">${esc(def ? t('b.defaultProvNamed', { name: def.name }) : t('b.defaultProv'))}</option>` +
    PROVS.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')
  $('#bprov').value = PROVS.some(p => p.id === b?.provider_id) ? b.provider_id : ''
  // A new provider likely doesn't have the old model; restore it when switching back
  $('#bprov').onchange = () => loadModels($('#bprov').value,
    $('#bprov').value === (b?.provider_id ?? '') ? (b?.model ?? '') : '')
  loadModels($('#bprov').value, b?.model ?? '')
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
$('#newbot').onclick = () => editBot(null)
$('#bcancel').onclick = () => $('#bdlg').close()
$('#bsave').onclick = async () => {
  const body = { name:$('#bname').value.trim(), description:$('#bdesc').value.trim(), persona:$('#bpersona').value.trim(),
    provider_id:$('#bprov').value, model:chosenModel() }
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
})

async function loadProvs() {
  PROVS = await (await fetch(api('/api/providers'))).json()
  renderProvs()
}

$('#prov').onclick = async () => { await loadProvs(); fillProv(PROVS.find(p => p.is_default) ?? null); $('#pdlg').showModal() }
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
  hint(t('common.saving'))
  const r = pEditing
    ? await fetch(api(`/api/providers/${pEditing.id}`), { method:'PATCH', headers:{'content-type':'application/json'}, body: JSON.stringify(b) })
    : await fetch(api('/api/providers'), { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(b) })
  const j = await r.json()
  if (!r.ok) { hint(j.error ?? t('p.saveFailed'), 'bad'); return }
  await loadProvs(); fillProv(PROVS.find(p => p.id === j.id) ?? null)
  hint(t('p.saved', { info: j.auto_context ? j.ctx_source : t('p.ctxShort', { n: j.context_tokens }) }), 'good')
}

$('#pdel').onclick = async () => {
  if (!pEditing || !confirm(t('p.confirmDelete', { name: pEditing.name }))) return
  const r = await fetch(api(`/api/providers/${pEditing.id}`), { method:'DELETE' })
  if (!r.ok) { hint((await r.json()).error, 'bad'); return }
  await loadProvs(); fillProv(PROVS.find(p => p.is_default) ?? null)
}

// ═══ Memory: the Agent's own in a DM, the group's in a group ═══
const memPath = c => `/api/memory/${c.kind === 'group' ? 'group' : 'agent'}/${c.id}`
async function loadMemory(c) {
  $('#memtitle').textContent = c.kind === 'group'
    ? t('mem.groupTitle', { name: c.name }) : t('mem.agentTitle', { name: c.name })
  $('#mem').placeholder = t(c.kind === 'group' ? 'mem.groupPh' : 'mem.agentPh')
  $('#mem').value = ''; $('#mstat').textContent = ''
  const r = await fetch(api(memPath(c))).catch(() => null)
  if (r?.ok && cur?.kind === c.kind && cur.id === c.id) $('#mem').value = (await r.json()).text
}
$('#cadd').onclick = () => { $('#side2').classList.remove('hide'); $('#mem').focus() }
$('#msave').onclick = async () => {
  if (!cur) return
  $('#mstat').textContent = t('common.saving')
  const r = await fetch(api(memPath(cur)), { method:'PUT', headers:{'content-type':'application/json'},
    body: JSON.stringify({ text: $('#mem').value }) }).catch(() => null)
  if (!r?.ok) { $('#mstat').textContent = t('mem.failed', { msg: r ? await errText(r) : t('mem.offline') }); return }
  $('#mstat').textContent = t('mem.saved', { time: new Date().toLocaleTimeString(lang) })
  setTimeout(() => $('#mstat').textContent = '', 4000)
}

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

// Two people can have the same server open, so look again every so often: left previews,
// and the open conversation's history when something new landed in it.
// Not while busy — a reply is streaming and a redraw would wipe the tool cards.
setInterval(async () => {
  if (busy || document.hidden || $('dialog[open]')) return
  const before = cur && CONVS.find(x => x.kind === cur.kind && x.id === cur.id)?.at
  CONVS = await fetch(api('/api/conversations')).then(r => r.json()).catch(() => CONVS)
  renderConvs()
  const now = cur && CONVS.find(x => x.kind === cur.kind && x.id === cur.id)
  if (now && now.at !== before && !busy) drawHistory(now, shown)
}, 15_000)

async function reload() {
  ;[BOTS, CONVS] = await Promise.all([
    (await fetch(api('/api/bots'))).json(),
    (await fetch(api('/api/conversations'))).json(),
  ])
  renderConvs()
}

;(async () => {
  try {
    await reload()
    if (CONVS.length) openConv(CONVS[0])
    await loadProvs()
    if (!PROVS.length) { fillProv(null); $('#pdlg').showModal()
      hint(t('p.first')) }
  } catch (e) { note(t('err.backend', { msg: e.message ?? e })) }
})()
