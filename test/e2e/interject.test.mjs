// Interjecting: a message sent while the agent is at work reaches it at its next step, instead of
// waiting for the whole turn to end.
import { test, before, after } from 'node:test'
import { strict as a } from 'node:assert'
import { startStack } from './stack.mjs'
import { fakeUpstream } from './fake-upstream.mjs'

let s, up
before(async () => { up = await fakeUpstream(); s = await startStack({ tools: true }) })
after(async () => { await s?.close(); await up?.close() })

const notes = r => r.events.filter(e => e.ev === 'note').map(e => e.data.text)

test('a message sent mid-turn reaches the model at its next step', async () => {
  const bot = await s.agent(up, { name: 'Ivy' })
  const seen = up.mark()
  up.on(r => {
    if (r.users.some(u => u.includes('also count the lines'))) return { text: 'counted files, and the lines too' }
    // the first step is slow, so there is time to interject while the turn is at work
    return r.toolResults.length ? { text: 'counted files', wait: 300 } : { tool: ['bash', { command: 'ls | wc -l' }], wait: 400 }
  })
  const first = s.chat({ agent: bot }, 'count the files')
  await s.until(() => seen().length >= 1, { what: 'the first model call' })
  const session = (await s.api('GET', `/api/sessions?kind=agent&id=${bot}`)).body[0].id
  const extra = await s.chat({ agent: bot }, 'also count the lines', { session, interject: true })
  a.deepEqual(notes(extra), ['Passed on — it sees this at its next step'])
  const r = await first
  a.equal(r.text, 'counted files, and the lines too')
  a.ok(r.events.some(e => e.ev === 'tool' && e.data.phase === 'interject'), 'the stream says when it was taken in')
  const calls = seen()
  a.equal(calls.length, 2, 'taken in at the next step — not a turn of its own after this one')
  a.equal(calls[1].lastUser, 'also count the lines')
  a.ok(calls[1].toolResults.length === 0 && calls[1].messages.some(m => m.role === 'tool'), 'the tool result is still in the history')
})

test('a message that arrives while the answer is being written gets answered in the same turn', async () => {
  const bot = await s.agent(up, { name: 'Jo' })
  const seen = up.mark()
  up.on(r => r.lastUser === 'and in French?' ? { text: 'Bonjour' } : { text: 'Hello', wait: 400 })
  const first = s.chat({ agent: bot }, 'say hello')
  await s.until(() => seen().length >= 1, { what: 'the first model call' })
  const session = (await s.api('GET', `/api/sessions?kind=agent&id=${bot}`)).body[0].id
  await s.chat({ agent: bot }, 'and in French?', { session, interject: true })
  const r = await first
  a.equal(r.text, 'HelloBonjour', 'both answers streamed in the one turn')
  const rows = (await s.history(bot, session)).map(m => [m.role, m.content])
  a.deepEqual(rows, [['user', 'say hello'], ['user', 'and in French?'], ['assistant', 'Hello'], ['assistant', 'Bonjour']],
    'the first answer is kept as it was written, not lost behind the second')
})

test('too late for the turn: it is answered in a turn of its own', async () => {
  const bot = await s.agent(up, { name: 'Kit' })
  up.on(r => ({ text: `re: ${r.lastUser}` }))
  const first = await s.chat({ agent: bot }, 'one')
  const extra = await s.chat({ agent: bot }, 'two', { session: first.session, interject: true })
  a.deepEqual(notes(extra), ['It had just finished — answering this in a turn of its own'])
  await s.until(async () => (await s.history(bot, first.session)).some(m => m.role === 'assistant' && m.content === 're: two'),
    { what: 'the follow-up answer' })
})

test('Stop drops what was sent along with the turn', async () => {
  const bot = await s.agent(up, { name: 'Lou' })
  const seen = up.mark()
  up.on(() => ({ text: 'slow', wait: 800 }))
  const first = s.chat({ agent: bot }, 'go slowly')
  await s.until(() => seen().length >= 1, { what: 'the first model call' })
  const session = (await s.api('GET', `/api/sessions?kind=agent&id=${bot}`)).body[0].id
  await s.chat({ agent: bot }, 'never mind this', { session, interject: true })
  a.equal((await s.api('POST', '/api/runs/stop', { session })).status, 200)
  await first
  await new Promise(t => setTimeout(t, 1200))
  a.equal(seen().length, 1, 'no turn was started for the dropped message')
  const rows = await s.history(bot, session)
  a.ok(!rows.some(m => m.role === 'assistant' && m.content === 'slow'))
})
