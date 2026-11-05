// Helpers: a background task on a machine of its own, beside the agent's other tasks — several at once,
// up to a limit; the agent's desk read-only, a scratch /work outside it, /work/out copied back, the machine
// removed when the run ends. Containers are faked; what is asserted is what docker was asked to do.
import { test, before, after } from 'node:test'
import { strict as a } from 'node:assert'
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { startStack } from './stack.mjs'
import { fakeUpstream } from './fake-upstream.mjs'

let s, up
before(async () => { up = await fakeUpstream(); s = await startStack({ tools: true, env: { AGENT_HELPERS_MAX: '2' } }) })
after(async () => { await s?.close(); await up?.close() })

const calls = async () => (await readFile(join(s.work, 'docker.log'), 'utf8').catch(() => '')).split('\n')
const IN_HELPER = '--- A machine of your own for this task ---'
const IN_TASK = '--- You are working on a background task ---'
const tasksOf = async bot => (await s.api('GET', `/api/tasks?kind=agent&id=${bot}`)).body
const settled = async bot => { const ts = await tasksOf(bot); return ts.length && ts.every(t => !['queued', 'running'].includes(t.status)) }

/** The front hands out `n` tasks in one step; each task's first model call waits `hold` ms. Returns the most that ran at once. */
async function handOut(bot, n, { helper = true, hold = 600 } = {}) {
  let now = 0, most = 0
  const systems = []
  up.on(async r => {
    if (r.system.includes(IN_TASK)) {
      if (r.toolResults.length) return { tool: ['finish_task', { result: 'done' }] }
      systems.push(r.system)
      now++; most = Math.max(most, now)
      await new Promise(t => setTimeout(t, hold))
      now--
      return { tool: ['bash', { command: 'ls /desk' }] }
    }
    if (r.lastUser.includes('[Platform]')) return { text: 'noted' }
    return r.toolResults.length ? { text: 'Started them.' }
      : { tools: Array.from({ length: n }, (_, i) => ['start_task', { title: `part ${i + 1}`, brief: `look into part ${i + 1}`, ...helper ? { helper: true } : {} }]) }
  })
  const front = await s.chat({ agent: bot }, 'look into these at once')
  await s.until(() => settled(bot), { what: 'the tasks to finish', timeout: 20_000 })
  return { most, systems, front }
}

test('helpers run side by side, each on its own machine, up to the limit; the machine goes when it is done', async () => {
  const kim = await s.agent(up, { name: 'Kim' })
  const { most, systems } = await handOut(kim, 3)
  a.equal(most, 2, 'two at once (AGENT_HELPERS_MAX=2), the third waits for a free one')
  const told = up.requests.filter(r => !r.system.includes(IN_TASK)).flatMap(r => r.toolResults)
  a.ok(told.some(x => /on a machine of its own/.test(x)), 'the front is told')
  a.ok(told.some(x => /waiting for one of 2 helper machines/.test(x)), 'and that the third waits for a free one')
  const ts = await tasksOf(kim)
  a.equal(ts.length, 3)
  a.ok(ts.every(t => t.status === 'done' && t.helper === true))

  const log = await calls()
  for (const t of ts) {
    const run = log.find(l => l.startsWith('run ') && l.includes(`-helper-${t.id} `))
    a.ok(run, `a machine was made for task #${t.id}`)
    a.ok(run.includes(`-v ${join(s.work, 'helpers', kim, String(t.id))}:/work`), 'its /work is a folder of its own, outside the desk')
    a.ok(run.includes(`-v ${join(s.work, 'agents', kim)}:/desk:ro`), 'the desk, read-only')
    a.ok(run.includes('--cap-drop ALL') && run.includes('--user 1000:1000'), 'the same rules as the agent\'s own machine')
    a.ok(log.some(l => l === `rm -f ${run.match(/--name (\S+)/)[1]}`), 'removed once the task is done')
    a.ok(!existsSync(join(s.work, 'helpers', kim, String(t.id))), 'and its folder')
  }
  a.ok(systems.every(x => x.includes(IN_HELPER) && x.includes('/desk')), 'each knows where it is')
  a.ok(systems.some(x => x.includes(`/work/helpers/${ts[0].id}`)), 'and where /work/out goes')
})

test('without helper, an agent\'s tasks still queue one at a time on its own machine', async () => {
  const lee = await s.agent(up, { name: 'Lee' })
  const { most, systems } = await handOut(lee, 2, { helper: false, hold: 300 })
  a.equal(most, 1)
  a.ok(systems.every(x => !x.includes(IN_HELPER)))
  a.ok(!(await calls()).some(l => l.startsWith('run ') && l.includes(`-helper-`) && l.includes(`/agents/${lee}:`)))
})

test('what a helper leaves in /work/out is copied to /work/helpers/<task> on the agent\'s machine', async () => {
  const max = await s.agent(up, { name: 'Max' })
  await writeFile(join(s.work, 'docker.log.containers.helper-out'), '1234\n')
  try { await handOut(max, 1, { hold: 50 }) } finally { await writeFile(join(s.work, 'docker.log.containers.helper-out'), '') }
  const [t] = await tasksOf(max)
  a.match(t.result, new RegExp(`now at /work/helpers/${t.id} on Max's machine`))
  const log = await calls()
  a.ok(log.some(l => l.includes(`-helper-${t.id} tar -C /work/out -cf - .`)), 'packed in the helper')
  a.ok(log.some(l => l.startsWith('exec -i ') && l.includes(`-agent-${max} sh -c`) && l.endsWith(`/work/helpers/${t.id}`)),
    'unpacked inside the agent\'s own machine, not through the host path of its desk')
})

test('the helper option is offered to the front thread (tools are on here)', async () => {
  const ivy = await s.agent(up, { name: 'Ivy' })
  let body = null
  up.on(r => { body ??= r.body; return { text: 'hi' } })
  await s.chat({ agent: ivy }, 'hello')
  const start = body.tools.find(t => t.function.name === 'start_task')
  a.match(start.function.parameters.properties.helper.description, /fresh machine of its own/)
})

test('a helper waiting for the person keeps its folder (not its machine); stopping it clears the folder', async () => {
  const joe = await s.agent(up, { name: 'Joe' })
  up.on(r => {
    if (r.system.includes(IN_TASK)) return { tool: ['ask_user', { question: 'Which account?' }] }
    if (r.lastUser.includes('[Platform]')) return { text: 'It asks which account.' }
    return r.toolResults.length ? { text: 'Started.' } : { tool: ['start_task', { title: 'check', brief: 'check the account', helper: true }] }
  })
  await s.chat({ agent: joe }, 'check it')
  await s.until(async () => (await tasksOf(joe))[0]?.status === 'waiting', { what: 'the helper to ask' })
  const [t] = await tasksOf(joe)
  const dir = join(s.work, 'helpers', joe, String(t.id))
  await s.until(async () => (await calls()).some(l => l.startsWith('rm -f ') && l.endsWith(`-helper-${t.id}`)), { what: 'its machine to go' })
  a.ok(existsSync(dir), 'the folder stays for when it carries on')
  a.equal((await s.api('POST', `/api/tasks/${t.id}/stop`)).status, 200)
  await s.until(async () => !existsSync(dir), { what: 'the folder to be cleared', timeout: 5_000 })
})
