// Telling the crew. The studio writes lines into the outbox (db: notifications); this module
// turns them into group messages on the platform:
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
}
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
        : { target: ev.goes_to, line: pick('rejected', lang, { shot: ev.shot, attempt: ev.attempt, route: ev.route, reason: ev.reason.slice(0, 600) }) }
    default: throw new Error(`unknown event ${ev.kind}`)
  }
}

/** One message out of several lines for the same target. A person's message is prefixed with @human. */
export function compose(target, lines, lang = 'en') {
  const body = lines.length === 1 ? lines[0] : lines.map(l => `- ${l}`).join('\n')
  return target === 'human' ? `${pick('human', lang)} ${body}` : body
}

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
        const wake = r.target === 'human' ? [] : (await db.q('select agent_id from crew where role = $1 order by agent_id', [r.target])).rows.map(x => x.agent_id)
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
  const timer = setInterval(flush, tickMs)
  timer.unref?.()
  return { flush, stop: () => clearInterval(timer) }
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
  a.equal(lineFor({ kind: 'round', shot: 'X', ok: 1, failed: 0 }, 'klingon').line.startsWith('Candidates'), true, 'unknown language → English')
  console.log('notify.mjs: all checks passed')
}
