// A machine nobody uses goes to sleep (stopped, not removed), and the next use wakes it.
import { test, before, after } from 'node:test'
import { strict as a } from 'node:assert'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { startStack } from './stack.mjs'
import { fakeUpstream } from './fake-upstream.mjs'

let s, up
// 0.03 min = 1.8 s idle; the sweeper looks every 0.6 s.
before(async () => { up = await fakeUpstream(); s = await startStack({ tools: true, env: { AGENT_IDLE_STOP_MIN: '0.03' } }) })
after(async () => { await s?.close(); await up?.close() })

const calls = async () => (await readFile(join(s.work, 'docker.log'), 'utf8').catch(() => '')).split('\n')

test('an unused machine is stopped, and comes back on the next turn', async () => {
  const kim = await s.agent(up, { name: 'Kim' })
  up.on(r => r.toolResults.length ? { text: 'done' } : { tool: ['bash', { command: 'echo hi' }] })
  await s.chat({ agent: kim }, 'say hi')
  const box = (await calls()).find(l => l.startsWith('run '))?.match(/--name (\S+)/)?.[1]
  a.ok(box, 'a machine was made')
  await s.until(async () => (await calls()).includes(`stop -t 5 ${box}`), { what: 'the machine to go to sleep', timeout: 10_000 })
  a.ok(!(await calls()).includes(`rm -f ${box}`) || (await calls()).filter(l => l === `rm -f ${box}`).length <= 1,
    'stopped, not removed')
  // The fake docker logs the stop before the server, which prints its line once the stop returns: wait for it.
  await s.until(async () => /went to sleep/.test(s.log()), { what: 'the server to say so', timeout: 5_000 })

  const before = (await calls()).filter(l => l.startsWith('run ')).length
  await s.chat({ agent: kim }, 'say hi again')
  a.ok((await calls()).filter(l => l.startsWith('run ') || l.startsWith('start ')).length > before, 'woken for the next turn')
})
