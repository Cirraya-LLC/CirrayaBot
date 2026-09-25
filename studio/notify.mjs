// Telling people. Two outboxes:
//
//   orders (pipeline.mjs)  work for one crew member → delivered into THAT member's own chat
//                          (POST {APP_URL}/api/events/order), which runs their turn there and
//                          answers when it is over; the group gets one line saying who got what.
//                          After the turn the pipeline looks again: an order still not done is sent
//                          once more, then marked stuck and handed to a person.
//   notifications          lines for everyone (a person approved a take) or for a person (@human),
//                          written into the project's group; they wake nobody.
//
// Group lines go out as:
//
//   POST {APP_URL}/api/events/group/<project.notify_group>
//   Authorization: Bearer <STUDIO_EVENT_TOKEN>
//   {text, wake: [agent ids with the target role]}      → the platform @s the first one in the group
//
// Lines for the same (project, target) wait NOTIFY_QUIET_MS after the newest one and go as ONE
// message: a reviewer rejecting eight shots is one turn for the cinematographer, not eight.
// A line for a person ('human') wakes nobody — it is written to the group and waits for a person.
//
// The text is in the project's language (info.lang: en / zh-Hans / zh-Hant, default en): the crew
// reads it, and the crew speaks whatever the film is made in.
//
// Self-test: node studio/notify.mjs
// db is loaded lazily so the wording self-test runs without the pg package.
let dbm = null
const dbx = async () => (dbm ??= await import('./db.mjs'))

const T = {
  ready:    ['Candidates ready: {shot} — {ok} take(s){failed}. Review them (shot.sheet).',
             '候选已就绪：{shot}，{ok} 条{failed}。请审片（shot.sheet）。',
             '候選已就緒：{shot}，{ok} 條{failed}。請審片（shot.sheet）。'],
  failedN:  [', {n} failed', '，另有 {n} 条失败', '，另有 {n} 條失敗'],
  allFail:  ['Every take of {shot} failed ({n}): {errors}', '{shot} 的 {n} 条全部生成失败：{errors}', '{shot} 的 {n} 條全部生成失敗：{errors}'],
  rejected: ['{shot} rejected (#{attempt}, {route}): {reason}', '{shot} 被打回（第 {attempt} 次，{route}）：{reason}', '{shot} 被打回（第 {attempt} 次，{route}）：{reason}'],
  toHuman:  ['{shot} has been rejected {n} times and needs a person to decide. Reasons: {reasons}',
             '{shot} 已被打回 {n} 次，需要人来决定。三次理由：{reasons}',
             '{shot} 已被打回 {n} 次，需要人來決定。三次理由：{reasons}'],
  human:    ['@human', '@人类', '@人類'],
  approved: ['{shot} approved by a person (take #{pick}).', '{shot} 已由人工通过（第 {pick} 条）。', '{shot} 已由人工通過（第 {pick} 條）。'],
  byHuman:  [' (rejected by a person)', '（人工打回）', '（人工打回）'],
  stuck:    ['Work order #{id} ({subject}) for {role} is stuck after {n} tries: {why}',
             '工单 #{id}（{subject}，{role}）试了 {n} 次还没完成：{why}',
             '工單 #{id}（{subject}，{role}）試了 {n} 次還沒完成：{why}'],
  // A crew member's batch of orders, in their own chat.
  head:     ['[Studio work orders — {n}. The studio closes each one when it sees the work done; if you can\'t do one, say why in your reply.]',
             '〔片场工单 · {n} 项。片场看到活干完会自动关单；做不了的在回复里说明原因。〕',
             '〔片場工單 · {n} 項。片場看到活幹完會自動關單；做不了的在回覆裡說明原因。〕'],
  again:    [' (second time — the studio still doesn\'t see this done)', '（第二次——片场还没看到这件做完）', '（第二次——片場還沒看到這件做完）'],
  report:   ['📋 {agent}: {items}', '📋 工单 → {agent}：{items}', '📋 工單 → {agent}：{items}'],
}
const KIND = {
  breakdown: ['breakdown', '拆镜头', '拆鏡頭'], asset: ['references', '补参考图', '補參考圖'], prompt: ['prompt + generate', '写提示词并生成', '寫提示詞並生成'],
  fixprompt: ['fix the prompt', '改提示词', '改提示詞'], fixasset: ['fix references', '修参考图', '修參考圖'], replan: ['redesign', '重新设计', '重新設計'],
  review: ['review', '审片', '審片'],
}
const ROLE = { director: ['director', '导演', '導演'], art: ['art director', '美术', '美術'], cinematographer: ['cinematographer', '摄影', '攝影'], reviewer: ['reviewer', '审片', '審片'] }
const tr3 = (table, key, lang) => (table[key] ?? [key, key, key])[Math.max(0, LANGS.indexOf(lang))]
const LANGS = ['en', 'zh-Hans', 'zh-Hant']
const pick = (key, lang, vars = {}) => T[key][Math.max(0, LANGS.indexOf(lang))]
  .replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m))

/** The line for an event. Pure, so the wording is tested without a database. */
export function lineFor(ev, lang = 'en') {
  switch (ev.kind) {
    case 'round':
      return ev.ok > 0
        ? { target: 'reviewer', line: pick('ready', lang, { shot: ev.shot, ok: ev.ok, failed: ev.failed ? pick('failedN', lang, { n: ev.failed }) : '' }) }
        : { target: 'cinematographer', line: pick('allFail', lang, { shot: ev.shot, n: ev.failed, errors: [...new Set(ev.errors ?? [])].join('; ').slice(0, 400) }) }
    case 'reject':
      return ev.goes_to === 'human'
        ? { target: 'human', line: pick('toHuman', lang, { shot: ev.shot, n: ev.attempt,
          reasons: ev.reasons.map((r, i) => `${i + 1}) ${r}`).join(' ').slice(0, 1500) }) }
        : { target: ev.goes_to, line: pick('rejected', lang, { shot: ev.shot, attempt: ev.attempt, route: ev.route, reason: ev.reason.slice(0, 600) })
            + (ev.by === 'human' ? pick('byHuman', lang) : '') }
    // 'crew': written into the group for everyone to read, waking nobody.
    case 'approved': return { target: 'crew', line: pick('approved', lang, { shot: ev.shot, pick: ev.pick }) }
    case 'stuck': return { target: 'human', line: pick('stuck', lang, { id: ev.id, subject: ev.subject, role: tr3(ROLE, ev.role, lang), n: ev.n, why: String(ev.why).slice(0, 300) }) }
    default: throw new Error(`unknown event ${ev.kind}`)
  }
}

/** One message out of several lines for the same target. A person's message is prefixed with @human. */
export function compose(target, lines, lang = 'en') {
  const body = lines.length === 1 ? lines[0] : lines.map(l => `- ${l}`).join('\n')
  return target === 'human' ? `${pick('human', lang)} ${body}` : body
}

/** A crew member's batch: the header, then one line per order, numbered by its id. */
export function composeOrders(orders, lang = 'en') {
  return [pick('head', lang, { n: orders.length }),
    ...orders.map(o => `#${o.id} ${o.body}${o.attempts ? pick('again', lang) : ''}`)].join('\n\n')
}
/** The group's one line about it. {agent} is filled in by the platform, which knows the name. */
export const reportLine = (orders, lang = 'en') => pick('report', lang, {
  agent: '{agent}', items: orders.map(o => lang === 'en' || !LANGS.includes(lang) ? `${o.subject} (${tr3(KIND, o.kind, lang)})` : `${o.subject}（${tr3(KIND, o.kind, lang)}）`)
    .join(lang === 'en' || !LANGS.includes(lang) ? ', ' : '、').slice(0, 600) })

/** Queue a line. Never throws: a lost notice is logged, and the shot's state is still in the studio. */
export async function enqueue(projectId, ev) {
  const db = await dbx()
  try {
    const p = await db.getProject(projectId)
    const { target, line } = lineFor(ev, p?.info?.lang)
    await db.q('insert into notifications (project_id, target, line) values ($1,$2,$3)', [projectId, target, line])
  } catch (e) { console.error(`notify: couldn't queue ${ev.kind} for ${ev.shot}: ${e.message}`) }
}

export function startNotifier({ quietMs = Number(process.env.NOTIFY_QUIET_MS || 15_000), tickMs = 3000 } = {}) {
  const app = String(process.env.APP_URL || '').replace(/\/+$/, '')
  const token = process.env.STUDIO_EVENT_TOKEN || ''
  let busy = false

  async function flush() {
    if (busy) return
    busy = true
    const db = await dbx()
    try {
      // Groups whose newest line is older than the quiet period.
      const { rows } = await db.q(`
        select project_id, target, array_agg(id order by id) as ids, array_agg(line order by id) as lines
          from notifications where sent_at is null
         group by project_id, target
        having max(created_at) < now() - ($1::int * interval '1 millisecond')`, [quietMs])
      for (const r of rows) {
        const p = await db.getProject(r.project_id)
        const done = (error = '') => db.q(`update notifications set sent_at = now(), error = $2 where id = any($1)`, [r.ids, error])
        // Without a group there is nobody to tell. Marked, not kept: a group set next week must
        // not receive last week's "candidates ready" as if it were news.
        if (!p?.notify_group) { await done('project has no notify_group'); await db.audit('studio', 'notify.skipped', r.project_id, false, 'no notify_group'); continue }
        if (!app || !token) { await done('APP_URL / STUDIO_EVENT_TOKEN not set'); continue }
        const wake = r.target === 'human' || r.target === 'crew' ? [] : (await db.q('select agent_id from crew where role = $1 order by agent_id', [r.target])).rows.map(x => x.agent_id)
        try {
          const res = await fetch(`${app}/api/events/group/${encodeURIComponent(p.notify_group)}`, {
            method: 'POST', signal: AbortSignal.timeout(15_000),
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify({ text: compose(r.target, r.lines, p.info?.lang), wake }),
          })
          if (res.ok) { await done(); continue }
          const why = `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`
          // 4xx won't get better by retrying (wrong group, wrong token): record it and stop.
          if (res.status >= 400 && res.status < 500) { await done(why); console.error(`notify: ${p.id} → ${p.notify_group}: ${why}`); continue }
          throw new Error(why)
        } catch (e) {
          await db.q('update notifications set attempts = attempts + 1, error = $2 where id = any($1)', [r.ids, String(e.message).slice(0, 300)])
          console.error(`notify: ${p.id} → ${p.notify_group} failed, will retry: ${e.message}`)
        }
      }
    } catch (e) { console.error('notify: flush failed:', e.message) }
    finally { busy = false }
  }
  // ---- work orders ----
  const MAX_TRIES = Number(process.env.ORDER_TRIES || 2)
  const inflight = new Set()   // 'project:role' being delivered right now

  async function deliverOrders() {
    const db = await dbx()
    const { plan } = await import('./pipeline.mjs')
    const { rows } = await db.q(`
      select project_id, role, array_agg(id order by id) as ids from orders where status = 'open'
       group by project_id, role having max(created_at) < now() - ($1::int * interval '1 millisecond')`, [quietMs])
    for (const r of rows) {
      const slot = `${r.project_id}:${r.role}`
      if (inflight.has(slot)) continue
      const p = await db.getProject(r.project_id)
      const lang = p?.info?.lang
      const orders = (await db.q(`select * from orders where id = any($1) and status = 'open' order by id`, [r.ids])).rows
      if (!orders.length) continue
      // For a person: a line in the group. The order closes when the pipeline sees it done.
      if (r.role === 'human') {
        if (p?.notify_group && app && token) {
          const ok = await postGroup(p.notify_group, compose('human', orders.map(o => o.body), lang)).catch(e => (console.error(`orders: ${e.message}`), false))
          if (!ok) continue
        }
        await db.q(`update orders set status = 'sent', sent_at = now(), attempts = attempts + 1 where id = any($1)`, [orders.map(o => o.id)])
        continue
      }
      // Roles are the studio's, not per film, so there may be several directors. The platform picks
      // the one in this project's group; failing that, whoever works in this project; then anyone.
      const candidates = (await db.q(`select c.agent_id from crew c left join actor_project ap on ap.actor = 'agent:' || c.agent_id
          where c.role = $1 order by (ap.project_id = $2) desc nulls last, c.agent_id`, [r.role, r.project_id])).rows.map(x => x.agent_id)
      if (!candidates.length || !app || !token) {
        const why = !candidates.length ? `nobody on the crew is ${r.role}` : 'APP_URL / STUDIO_EVENT_TOKEN not set'
        await db.q(`update orders set status = 'stuck', error = $2 where id = any($1)`, [orders.map(o => o.id), why])
        for (const o of orders) await enqueue(r.project_id, { kind: 'stuck', id: o.id, subject: o.subject, role: o.role, n: 0, why })
        continue
      }
      await db.q(`update orders set status = 'sent', sent_at = now(), attempts = attempts + 1 where id = any($1)`, [orders.map(o => o.id)])
      inflight.add(slot)
      let agent = candidates[0]
      // Not awaited: a turn can take minutes, and other people's orders must not wait for it.
      ;(async () => {
        let error = ''
        try {
          const res = await fetch(`${app}/api/events/order`, {
            method: 'POST', signal: AbortSignal.timeout(Number(process.env.ORDER_TURN_MS || 45 * 60_000)),
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify({ candidates, text: composeOrders(orders, lang), group: p?.notify_group || '', report: reportLine(orders, lang) }),
          })
          const j = await res.json().catch(() => ({}))
          if (j.agent) {
            agent = j.agent
            await db.q('update orders set agent_id = $2 where id = any($1)', [orders.map(o => o.id), agent])
          }
          if (!res.ok || j.ok === false) error = String(j.error ?? `HTTP ${res.status}`)
        } catch (e) { error = e.message }
        // What does the studio see now? Whatever is still open after the turn is tried again, then stuck.
        await plan(r.project_id).catch(e => console.error(`orders: replanning ${r.project_id}: ${e.message}`))
        const left = (await db.q(`select * from orders where id = any($1) and status = 'sent'`, [orders.map(o => o.id)])).rows
        for (const o of left) {
          if (o.attempts >= MAX_TRIES) {
            const why = error || 'the turn ended without the work showing up in the studio'
            await db.q(`update orders set status = 'stuck', error = $2 where id = $1`, [o.id, why.slice(0, 300)])
            await enqueue(r.project_id, { kind: 'stuck', id: o.id, subject: o.subject, role: o.role, n: o.attempts, why })
          } else await db.q(`update orders set status = 'open', error = $2, created_at = now() - interval '1 hour' where id = $1`, [o.id, error.slice(0, 300)])
        }
        if (error) console.error(`orders: ${agent} (${r.role}) in ${r.project_id}: ${error}`)
      })().catch(e => console.error('orders: delivery failed:', e.message)).finally(() => inflight.delete(slot))
    }
  }

  async function postGroup(group, text) {
    const res = await fetch(`${app}/api/events/group/${encodeURIComponent(group)}`, {
      method: 'POST', signal: AbortSignal.timeout(15_000),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ text, wake: [] }),
    })
    if (!res.ok) throw new Error(`group ${group}: HTTP ${res.status}`)
    return true
  }

  let obusy = false
  const tick = async () => {
    await flush()
    if (obusy) return
    obusy = true
    try { await deliverOrders() } catch (e) { console.error('orders: tick failed:', e.message) } finally { obusy = false }
  }
  const timer = setInterval(tick, tickMs)
  timer.unref?.()
  return { flush: tick, stop: () => clearInterval(timer), inflight }
}

// ---------- self-test ----------
if (import.meta.url === `file://${process.argv[1]}`) {
  const a = await import('node:assert/strict')
  a.deepEqual(lineFor({ kind: 'round', shot: 'S01-SH001', ok: 3, failed: 0 }, 'zh-Hans'),
    { target: 'reviewer', line: '候选已就绪：S01-SH001，3 条。请审片（shot.sheet）。' })
  a.equal(lineFor({ kind: 'round', shot: 'X', ok: 2, failed: 1 }).line, 'Candidates ready: X — 2 take(s), 1 failed. Review them (shot.sheet).')
  const all = lineFor({ kind: 'round', shot: 'X', ok: 0, failed: 2, errors: ['blocked', 'blocked'] }, 'zh-Hans')
  a.equal(all.target, 'cinematographer', 'nothing to review → back to whoever writes the prompt')
  a.equal(all.line, 'X 的 2 条全部生成失败：blocked')
  a.deepEqual(lineFor({ kind: 'reject', shot: 'X', attempt: 1, route: 'asset', goes_to: 'art', reason: 'hair is brown' }),
    { target: 'art', line: 'X rejected (#1, asset): hair is brown' })
  const h = lineFor({ kind: 'reject', shot: 'X', attempt: 3, goes_to: 'human', reasons: ['a', 'b', 'c'] }, 'zh-Hans')
  a.equal(h.target, 'human'); a.equal(h.line, 'X 已被打回 3 次，需要人来决定。三次理由：1) a 2) b 3) c')
  a.equal(compose('human', [h.line], 'zh-Hans'), `@人类 ${h.line}`)
  a.equal(compose('reviewer', ['one']), 'one')
  a.equal(compose('cinematographer', ['one', 'two']), '- one\n- two', 'several lines, one message')
  a.deepEqual(lineFor({ kind: 'approved', shot: 'X', pick: 2 }, 'zh-Hans'), { target: 'crew', line: 'X 已由人工通过（第 2 条）。' })
  a.equal(compose('crew', ['one']), 'one', 'a notice for everyone: no @')
  a.equal(lineFor({ kind: 'reject', shot: 'X', attempt: 1, route: 'prompt', goes_to: 'cinematographer', reason: 'r', by: 'human' }).line,
    'X rejected (#1, prompt): r (rejected by a person)')
  a.equal(lineFor({ kind: 'round', shot: 'X', ok: 1, failed: 0 }, 'klingon').line.startsWith('Candidates'), true, 'unknown language → English')
  // Work orders: one message per crew member, numbered by order id; the group gets one line.
  const os = [{ id: 12, kind: 'prompt', subject: 'S01-SH002', body: 'do A', attempts: 0 }, { id: 13, kind: 'fixprompt', subject: 'S01-SH003', body: 'do B', attempts: 1 }]
  a.equal(composeOrders(os, 'zh-Hans'), '〔片场工单 · 2 项。片场看到活干完会自动关单；做不了的在回复里说明原因。〕\n\n#12 do A\n\n#13 do B（第二次——片场还没看到这件做完）')
  a.equal(reportLine(os, 'zh-Hans'), '📋 工单 → {agent}：S01-SH002（写提示词并生成）、S01-SH003（改提示词）')
  a.equal(reportLine(os), '📋 {agent}: S01-SH002 (prompt + generate), S01-SH003 (fix the prompt)')
  a.deepEqual(lineFor({ kind: 'stuck', id: 5, subject: 'E01', role: 'director', n: 2, why: 'no model' }, 'zh-Hans'),
    { target: 'human', line: '工单 #5（E01，导演）试了 2 次还没完成：no model' })
  console.log('notify.mjs: all checks passed')
}
