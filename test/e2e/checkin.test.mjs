// Check-ins: an agent works on its own toward the person's goals, read-only, and reports into a
// session of its own only when there is something new.
import { test, before, after } from 'node:test'
import { strict as a } from 'node:assert'
import { startStack } from './stack.mjs'
import { fakeUpstream } from './fake-upstream.mjs'

let s, up
before(async () => { up = await fakeUpstream(); s = await startStack({ tools: true, env: { CHECKIN_TICK_MS: '500' } }) })
after(async () => { await s?.close(); await up?.close() })

const agentRow = async id => (await s.api('GET', '/api/bots')).body.find(b => b.id === id)
const IN_CHECKIN = 'one of your regular check-ins'

test('goals and a schedule; a check-in is read-only and its report lands in its own session', async () => {
  const kim = await s.agent(up, { name: 'Kim' })
  a.equal((await s.api('POST', `/api/bots/${kim}/checkin`)).status, 400, 'no goals yet')
  a.equal((await s.api('PATCH', `/api/bots/${kim}`, { goals: 'Keep an eye on the nightly build.', checkin_every: 60 })).status, 200)
  let b = await agentRow(kim)
  a.equal(b.checkin_every, 60)
  const due = new Date(b.checkin_next_at).getTime()
  a.ok(due > Date.now() + 55 * 60_000 && due < Date.now() + 61 * 60_000, 'the first one in an hour')
  const sessions = (await s.api('GET', `/api/sessions?kind=agent&id=${kim}`)).body
  a.equal(sessions.find(x => x.id === b.checkin_session)?.title, 'Check-ins')
  a.equal((await s.api('PATCH', `/api/bots/${kim}`, { checkin_every: 45 })).status, 400, 'only the offered frequencies')

  let refused = null
  up.on(r => {
    if (!r.lastUser.includes(IN_CHECKIN) && !r.toolResults.length) return { text: 'hm' }
    if (!r.toolResults.length) return { tool: ['bash', { command: 'git push origin main' }] }
    refused = r.toolResults[0]
    return { tool: ['finish_task', { result: 'The nightly build is red since 02:10.' }] }
  })
  const started = await s.api('POST', `/api/bots/${kim}/checkin`)
  a.equal(started.status, 202)
  await s.until(async () => (await agentRow(kim)).checkin_last?.status === 'reported', { what: 'the report' })
  a.match(refused, /a check-in is read-only/)
  const rows = await s.history(kim, b.checkin_session)
  a.equal(rows.filter(m => m.role === 'assistant').at(-1)?.content, 'The nightly build is red since 02:10.')
  const tasks = (await s.api('GET', `/api/tasks?kind=agent&id=${kim}`)).body
  a.ok(tasks.some(t => t.title === 'Check-in' && t.status === 'done'), 'shows among its background tasks')

  // The next one sees the last report, and says nothing when nothing is new.
  let brief = ''
  up.on(r => { brief = r.lastUser; return { tool: ['finish_task', { result: 'NOTHING_NEW' }] } })
  const before = rows.length
  await s.api('POST', `/api/bots/${kim}/checkin`)
  await s.until(async () => (await agentRow(kim)).checkin_last?.status === 'nothing', { what: 'the quiet check-in' })
  a.match(brief, /The nightly build is red since 02:10\./)
  a.equal((await s.history(kim, b.checkin_session)).length, before, 'nothing posted')

  const act = (await s.api('GET', '/api/activity')).body
  a.ok(act.checkins.some(c => c.agent_id === kim && c.who === 'Kim'), 'listed as coming up')
})

test('a due check-in runs on its own, and books the next one', async () => {
  const lee = await s.agent(up, { name: 'Lee' })
  await s.api('PATCH', `/api/bots/${lee}`, { goals: 'Watch the inbox folder.', checkin_every: 240 })
  up.on(() => ({ tool: ['finish_task', { result: 'Two new files in the inbox.' }] }))
  await s.sql(`update agents set checkin_next_at = now() - interval '1 minute' where id = '${lee}'`)
  await s.until(async () => (await agentRow(lee)).checkin_last?.status === 'reported', { what: 'the due check-in' })
  const next = new Date((await agentRow(lee)).checkin_next_at).getTime()
  a.ok(next > Date.now() + 230 * 60_000, 'the next one is four hours on')
  // Off: nothing more is booked.
  await s.api('PATCH', `/api/bots/${lee}`, { checkin_every: 0 })
  a.equal((await agentRow(lee)).checkin_next_at, null)
})
