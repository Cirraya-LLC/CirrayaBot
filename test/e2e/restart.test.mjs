// A conversation turn at work survives the server being killed: after the restart it carries on from
// its last saved step, told that the server restarted, without the person sending anything again.
import { test, before, after } from 'node:test'
import { strict as a } from 'node:assert'
import { startStack } from './stack.mjs'
import { fakeUpstream } from './fake-upstream.mjs'

let s, up
before(async () => { up = await fakeUpstream(); s = await startStack({ tools: true }) })
after(async () => { await s?.close(); await up?.close() })

const RESTARTED = /The server restarted while you were working on this turn/
const sessionOf = async bot => (await s.api('GET', `/api/sessions?kind=agent&id=${bot}`)).body[0].id
const answered = (bot, session, text) => s.until(async () =>
  (await s.history(bot, session)).some(m => m.role === 'assistant' && m.content === text), { what: `the answer "${text}"`, timeout: 20_000 })

test('killed between steps: the turn carries on from where it was', async () => {
  const bot = await s.agent(up, { name: 'Ula' })
  const seen = up.mark()
  up.on(r => {
    if (r.users.some(u => RESTARTED.test(u))) return { text: 'carried on: built it' }
    if (!r.toolResults.length) return { tool: ['bash', { command: 'make build' }] }
    return { text: 'never sent', wait: 60_000 }                // the second step hangs; the server dies meanwhile
  })
  s.chat({ agent: bot }, 'build it').catch(() => {})
  await s.until(() => seen().length >= 2, { what: 'the second step' })
  const session = await sessionOf(bot)
  await s.restart()                                           // SIGKILL: no chance to clean up
  await answered(bot, session, 'carried on: built it')
  const resumed = seen().find(r => r.users.some(u => RESTARTED.test(u)))
  a.ok(resumed, 'the model was told the server restarted')
  a.ok(resumed.messages.some(m => m.role === 'tool' && /ran: make build/.test(m.content)), 'with what it had already done')
  a.equal(resumed.users.filter(u => u === 'build it').length, 1, 'the message is not repeated')
  const rows = await s.history(bot, session)
  a.equal(rows.filter(m => m.role === 'user').length, 1)
  a.equal(rows.filter(m => m.role === 'tool').length, 1, 'the command card is not doubled')
})

test('killed during its first model call: it starts over with the history', async () => {
  const bot = await s.agent(up, { name: 'Vic' })
  const seen = up.mark()
  up.on(r => r.users.some(u => RESTARTED.test(u)) ? { text: 'answered after the restart' } : { text: 'never', wait: 60_000 })
  s.chat({ agent: bot }, 'what time is it').catch(() => {})
  await s.until(() => seen().length >= 1, { what: 'the first model call' })
  const session = await sessionOf(bot)
  await s.restart()
  await answered(bot, session, 'answered after the restart')
  const resumed = seen().at(-1)
  a.equal(resumed.users[0], 'what time is it')
})

test('a turn that finished leaves nothing to pick up', async () => {
  const bot = await s.agent(up, { name: 'Wes' })
  up.on(() => ({ text: 'done' }))
  await s.chat({ agent: bot }, 'hi')
  const seen = up.mark()
  await s.restart()
  await new Promise(t => setTimeout(t, 800))
  a.equal(seen().length, 0, 'no model call after the restart')
})
