// What already worked before the harness existed, pinned end to end: a reply is streamed and
// stored, a risky command waits for a person, and a background task reports back.
import { test, before, after } from 'node:test'
import { strict as a } from 'node:assert'
import { startStack } from './stack.mjs'
import { fakeUpstream } from './fake-upstream.mjs'

let s, up
before(async () => { up = await fakeUpstream(); s = await startStack({ tools: true }) })
after(async () => { await s?.close(); await up?.close() })

test('a reply is streamed, stored, and the model saw the message', async () => {
  const bot = await s.agent(up, { name: 'Ann' })
  up.on(r => ({ text: `you said: ${r.lastUser}` }))
  const r = await s.chat({ agent: bot }, 'hello there')
  a.equal(r.error, null, JSON.stringify(r.error))
  a.equal(r.text, 'you said: hello there')
  const h = await s.history(bot, r.session)
  a.deepEqual(h.filter(m => m.role !== 'tool').map(m => [m.role, m.content]),
    [['user', 'hello there'], ['assistant', 'you said: hello there']])
})

test('a risky command waits for a person: approved runs, denied does not', async () => {
  const bot = await s.agent(up, { name: 'Ben' })
  up.on(r => r.toolResults.length ? { text: `result: ${r.toolResults[0].slice(0, 60)}` }
    : { tool: ['bash', { command: 'git push origin main' }] })

  const yes = await s.chat({ agent: bot }, 'push it', {
    onEvent: (ev, d) => ev === 'tool' && d.phase === 'ask' && s.api('POST', `/api/approvals/${d.id}`, { ok: true }) })
  a.ok(yes.events.some(e => e.ev === 'tool' && e.data.phase === 'ask'), 'a card was shown')
  a.match(yes.text, /result: ran: git push origin main/)

  const no = await s.chat({ agent: bot }, 'push it again', {
    onEvent: (ev, d) => ev === 'tool' && d.phase === 'ask' && s.api('POST', `/api/approvals/${d.id}`, { ok: false }) })
  a.match(no.text, /result: Refused by the user: git push origin main/)

  const plain = up.mark()
  up.on(r => r.toolResults.length ? { text: 'listed' } : { tool: ['bash', { command: 'ls -la' }] })
  const ls = await s.chat({ agent: bot }, 'list')
  a.ok(!ls.events.some(e => e.ev === 'tool' && e.data.phase === 'ask'), 'a harmless command asks nobody')
  a.equal(plain().length, 2)
})

test('a background task runs and the conversation is told when it is done', async () => {
  const bot = await s.agent(up, { name: 'Cat' })
  up.on(r => {
    if (r.system.includes('--- You are working on a background task ---'))
      return r.toolResults.length ? { tool: ['finish_task', { result: 'counted 7 files' }] }
        : { tool: ['bash', { command: 'ls | wc -l' }] }
    if (r.lastUser.includes('[Platform]')) return { text: 'The task says: counted 7 files.' }
    return r.toolResults.length ? { text: 'Started it.' } : { tool: ['start_task', { title: 'count files', brief: 'count the files in /work' }] }
  })
  const r = await s.chat({ agent: bot }, 'count my files in the background')
  a.equal(r.text, 'Started it.')
  await s.until(async () => (await s.history(bot, r.session))
    .some(m => m.role === 'assistant' && m.content === 'The task says: counted 7 files.'), { what: 'the wake-up reply' })
  const tasks = (await s.api('GET', `/api/tasks?kind=agent&id=${bot}`)).body
  a.equal(tasks[0].status, 'done')
  a.equal(tasks[0].result, 'counted 7 files')
})
