// Voice calls: a call's messages are marked so the transcript can fold them into one card, the agent
// is told it's speaking, and it can hang up (end_call) — its farewell is the end of its reply.
import { test, before, after } from 'node:test'
import { strict as a } from 'node:assert'
import { startStack } from './stack.mjs'
import { fakeUpstream } from './fake-upstream.mjs'

let s, up, bot
before(async () => {
  up = await fakeUpstream()
  s = await startStack()
  bot = await s.agent(up, { name: 'Cal' })
})
after(async () => { await s?.close(); await up?.close() })

const calls = h => h.filter(m => m.role === 'event' && m.event?.kind === 'call').map(m => m.event)

test('a call turn speaks briefly and can hang up; its start and end are marked once', async () => {
  const seen = up.mark()
  up.on(r => r.lastUser.includes('bye')
    ? (r.toolResults.length ? { text: 'unused' } : { tool: ['end_call', { farewell: 'Talk soon!', title: 'Quick check-in' }] })
    : { text: 'Hi, I can hear you.' })
  const first = await s.chat({ agent: bot }, 'hello there', { call: 'call-one-1' })
  a.equal(first.text, 'Hi, I can hear you.')
  const [req] = seen()
  a.match(req.system, /You are on a voice call/)
  a.ok(req.tools.includes('end_call'), 'it may hang up')

  const second = await s.chat({ agent: bot }, 'ok bye', { session: first.session, call: 'call-one-1' })
  a.equal(second.text, 'Talk soon!', 'the farewell is spoken as the end of the reply')
  a.deepEqual(second.events.find(e => e.ev === 'call_end')?.data, { title: 'Quick check-in' })
  a.equal(seen().length, 2, 'ending the call ends the turn: no further model call')

  const h = await s.history(bot, first.session)
  a.deepEqual(calls(h).map(e => [e.phase, e.call, e.title]), [['start', 'call-one-1', undefined], ['end', 'call-one-1', 'Quick check-in']])
  a.ok(h.findIndex(m => m.event?.phase === 'start') < h.findIndex(m => m.role === 'user'), 'marked before what was said')
  a.equal(h.filter(m => m.role === 'assistant').at(-1).content, 'Talk soon!')

  // the client hanging up afterwards changes nothing
  a.equal((await s.api('POST', '/api/calls/end', { session: first.session, call: 'call-one-1' })).status, 200)
  a.equal(calls(await s.history(bot, first.session)).length, 2)
})

test('the person hanging up marks the end; outside a call there is no call prompt or end_call', async () => {
  const seen = up.mark()
  up.on(() => ({ text: 'Sure.' }))
  const r = await s.chat({ agent: bot }, 'quick question', { session: 'new', call: 'call-two-2' })
  a.equal((await s.api('POST', '/api/calls/end', { session: r.session, call: 'call-two-2' })).status, 200)
  a.equal((await s.api('POST', '/api/calls/end', { session: r.session, call: 'call-nope-3' })).status, 404)
  a.deepEqual(calls(await s.history(bot, r.session)).map(e => e.phase), ['start', 'end'])

  const plain = await s.chat({ agent: bot }, 'typed message', { session: r.session })
  a.equal(plain.text, 'Sure.')
  const last = seen().at(-1)
  a.doesNotMatch(last.system, /voice call/)
  a.ok(!last.tools.includes('end_call'))
  a.ok(last.users.some(u => u.includes('[Platform] A voice call started')), 'the model can tell what was said in a call')
  a.ok(last.users.some(u => u.includes('[Platform] The voice call ended')))
})
