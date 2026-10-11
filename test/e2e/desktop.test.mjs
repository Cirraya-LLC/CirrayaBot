// The desktop and the file browser need a real container to do anything (checked on the test box,
// CLAUDE.md 2.38); here: what is offered and what is refused.
import { test, before, after } from 'node:test'
import { strict as a } from 'node:assert'
import { startStack } from './stack.mjs'
import { fakeUpstream } from './fake-upstream.mjs'

let s, up, bot
before(async () => { up = await fakeUpstream(); s = await startStack({ tools: true }); bot = await s.agent(up, { name: 'Dee' }) })
after(async () => { await s?.close(); await up?.close() })

test('an agent with a machine is offered the desktop', async () => {
  const seen = up.mark()
  up.on(() => ({ text: 'ok' }))
  await s.chat({ agent: bot }, 'hi')
  a.ok(seen()[0].tools.includes('computer'))
  a.match(seen()[0].system, /a desktop \(the computer tool, DISPLAY=:1\)/)
})

test('a person may only start the desktop or open a terminal; unknown agents are refused', async () => {
  a.equal((await s.api('POST', `/api/desktop/${bot}/act`, { action: 'rm -rf' })).status, 400)
  a.equal((await s.api('POST', '/api/desktop/nobody/act', { action: 'start' })).status, 404)
  a.equal((await s.api('GET', '/api/bots/nobody/files?path=/work')).status, 404)
})
