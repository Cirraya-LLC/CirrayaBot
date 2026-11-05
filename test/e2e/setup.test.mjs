// A setup script: run as root on an agent's machine when the machine is new, again when the script
// changes, and on request — and how it went is kept with the agent.
import { test, before, after } from 'node:test'
import { strict as a } from 'node:assert'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { startStack } from './stack.mjs'
import { fakeUpstream } from './fake-upstream.mjs'

let s, up
before(async () => { up = await fakeUpstream(); s = await startStack({ tools: true }) })
after(async () => { await s?.close(); await up?.close() })

const setupRuns = async () => (await readFile(join(s.work, 'docker.log'), 'utf8').catch(() => ''))
  .split('\n').filter(l => /^exec -u 0 -e HOME=\/root \S+ bash -lc /.test(l))
const agentRow = async id => (await s.api('GET', '/api/bots')).body.find(b => b.id === id)
const say = async (agent, text) => { up.on(() => ({ text: 'ok' })); await s.chat({ agent }, text) }

test('runs on a new machine, not again until the script changes, and on request', async () => {
  const kim = await s.agent(up, { name: 'Kim' })
  a.equal((await s.api('PATCH', `/api/bots/${kim}`, { setup: 'apt-get install -y jq\r\necho ready' })).status, 200)
  let b = await agentRow(kim)
  a.equal(b.setup, 'apt-get install -y jq\necho ready', 'line endings normalised')
  a.equal(b.setup_state, null, 'not run until the machine is used')
  a.equal(b.machine, true)

  await say(kim, 'hello')
  a.equal((await setupRuns()).length, 1, 'ran once on the new machine')
  b = await agentRow(kim)
  a.equal(b.setup_state.code, 0)
  a.match(b.setup_state.tail, /ran: apt-get install -y jq/)
  a.equal(b.setup_state.stale, false)

  await say(kim, 'again')
  a.equal((await setupRuns()).length, 1, 'not again for the same script')

  await s.api('PATCH', `/api/bots/${kim}`, { setup: 'echo changed' })
  a.equal((await agentRow(kim)).setup_state.stale, true, 'the editor can say it changed')
  await say(kim, 'third')
  a.equal((await setupRuns()).length, 2, 'ran again after the change')
  a.equal((await agentRow(kim)).setup_state.stale, false)

  a.equal((await s.api('POST', `/api/bots/${kim}/setup`)).status, 202)
  await s.until(async () => (await setupRuns()).length === 3 && !(await agentRow(kim)).setup_running, { what: 'run now to finish' })

  // Removing the script forgets how it went.
  await s.api('PATCH', `/api/bots/${kim}`, { setup: '   ' })
  b = await agentRow(kim)
  a.equal(b.setup, '')
  a.equal(b.setup_state, null)
  a.equal((await s.api('POST', `/api/bots/${kim}/setup`)).status, 400, 'nothing to run')
})

test('a script that is too long is refused', async () => {
  const lee = await s.agent(up, { name: 'Lee' })
  const r = await s.api('PATCH', `/api/bots/${lee}`, { setup: 'x'.repeat(20_001) })
  a.equal(r.status, 400)
  a.match(r.body.error, /too long/)
})
