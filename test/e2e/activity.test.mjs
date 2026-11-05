// The activity page's data: what every agent is doing, what waits for a person (answerable from there),
// what is coming up, and what was run — across all conversations.
import { test, before, after } from 'node:test'
import { strict as a } from 'node:assert'
import { startStack } from './stack.mjs'
import { fakeUpstream } from './fake-upstream.mjs'

let s, up
before(async () => { up = await fakeUpstream(); s = await startStack({ tools: true }) })
after(async () => { await s?.close(); await up?.close() })

const activity = async () => (await s.api('GET', '/api/activity')).body

test('a card waiting in one conversation can be answered from the activity page', async () => {
  const kim = await s.agent(up, { name: 'Kim' })
  up.on(r => r.toolResults.length ? { text: `result: ${r.toolResults[0].slice(0, 60)}` } : { tool: ['bash', { command: 'git push origin main' }] })
  const turn = s.chat({ agent: kim }, 'push it')
  const waiting = await s.until(async () => (await activity()).asks.find(x => x.agent_id === kim), { what: 'the card to show up' })
  a.equal(waiting.subject, 'git push origin main')
  a.equal(waiting.who, 'Kim')
  a.equal(waiting.conv_name, 'Kim')
  const act = await activity()
  a.ok(act.runs.some(r => r.id === kim && r.who === 'Kim'), 'the turn shows as working')
  a.equal((await s.api('POST', `/api/approvals/${waiting.id}`, { ok: true })).status, 200)
  a.match((await turn).text, /ran: git push origin main/)
  const after = await activity()
  a.equal(after.asks.length, 0, 'answered: gone')
  const ran = after.actions.find(x => x.subject === 'git push origin main')
  a.ok(ran, 'what it ran is listed')
  a.deepEqual([ran.who, ran.conv_name, ran.kind], ['Kim', 'Kim', 'agent'])
})

test('tasks, their traces and scheduled tasks are listed; machines too', async () => {
  const lee = await s.agent(up, { name: 'Lee' })
  up.on(r => {
    if (r.system.includes('--- You are working on a background task ---'))
      return r.toolResults.length ? { tool: ['finish_task', { result: 'counted' }] } : { tool: ['bash', { command: 'ls | wc -l' }] }
    if (r.lastUser.includes('[Platform]')) return { text: 'noted' }
    return r.toolResults.length ? { text: 'Started it.' } : { tool: ['start_task', { title: 'count files', brief: 'count' }] }
  })
  await s.chat({ agent: lee }, 'count in the background')
  await s.until(async () => (await activity()).actions.some(x => x.task && x.subject === 'ls | wc -l'), { what: 'the task trace' })
  const made = await s.api('POST', '/api/routines', { name: 'morning digest', prompt: 'digest', target_kind: 'agent', target_id: lee,
    kind: 'daily', at_time: '09:00', tz: 'UTC' })
  a.equal(made.status, 200, JSON.stringify(made.body))
  const act = await activity()
  const r = act.routines.find(x => x.id === made.body.id)
  a.deepEqual([r.name, r.conv_name, r.running], ['morning digest', 'Lee', false])
  const m = act.machines.find(x => x.agent_id === lee)
  a.ok(m && ['awake', 'asleep', 'none'].includes(m.state))
})
