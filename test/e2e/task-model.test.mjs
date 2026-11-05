// A background model: an agent's tasks run on the model picked for them, the agent's own model takes
// over when that one fails, and a task that asks for the agent's own model gets it.
import { test, before, after } from 'node:test'
import { strict as a } from 'node:assert'
import { startStack } from './stack.mjs'
import { fakeUpstream } from './fake-upstream.mjs'

let s, up
before(async () => { up = await fakeUpstream({ models: [{ id: 'fake' }, { id: 'light' }] }); s = await startStack({ tools: true }) })
after(async () => { await s?.close(); await up?.close() })

const IN_TASK = '--- You are working on a background task ---'
/** One turn that hands out a task; resolves when the task has reported. Returns which models the task's calls used. */
async function handOut(bot, { mainModel = false, light = null } = {}) {
  const used = []
  up.on(r => {
    if (r.system.includes(IN_TASK)) {
      used.push(r.model)
      if (r.model === 'light' && light) return light
      return { tool: ['finish_task', { result: `done on ${r.model}` }] }
    }
    if (r.lastUser.includes('[Platform]')) return { text: 'noted' }
    return r.toolResults.length ? { text: 'Started it.' }
      : { tool: ['start_task', { title: 'sum it up', brief: 'summarise', ...mainModel ? { main_model: true } : {} }] }
  })
  const r = await s.chat({ agent: bot }, 'do it in the background')
  await s.until(async () => { const ts = (await s.api('GET', `/api/tasks?kind=agent&id=${bot}`)).body
    return ts.length && ts.every(t => !['queued', 'running'].includes(t.status)) }, { what: 'the task to finish' })
  const task = (await s.api('GET', `/api/tasks?kind=agent&id=${bot}`)).body[0]
  return { used, task, front: r }
}

test('tasks run on the background model; the conversation stays on the agent\'s own', async () => {
  const bot = await s.agent(up, { name: 'Kim' })
  const p = (await s.api('GET', '/api/bots')).body.find(b => b.id === bot)
  a.equal((await s.api('PATCH', `/api/bots/${bot}`, { task_model: { provider_id: p.provider_id, model: 'light' } })).status, 200)
  a.deepEqual((await s.api('GET', '/api/bots')).body.find(b => b.id === bot).task_model, { provider_id: p.provider_id, model: 'light' })

  const { used, task } = await handOut(bot)
  a.deepEqual(used, ['light'])
  a.equal(task.result, 'done on light')
})

test('a task that asks for the agent\'s own model gets it', async () => {
  const bot = await s.agent(up, { name: 'Lee' })
  const p = (await s.api('GET', '/api/bots')).body.find(b => b.id === bot)
  await s.api('PATCH', `/api/bots/${bot}`, { task_model: { provider_id: p.provider_id, model: 'light' } })
  const { used, task } = await handOut(bot, { mainModel: true })
  a.deepEqual(used, ['fake'])
  a.equal(task.result, 'done on fake')
})

test('when the background model fails, the agent\'s own model carries the task on', async () => {
  const bot = await s.agent(up, { name: 'Max' })
  const p = (await s.api('GET', '/api/bots')).body.find(b => b.id === bot)
  await s.api('PATCH', `/api/bots/${bot}`, { task_model: { provider_id: p.provider_id, model: 'light' } })
  const { used, task } = await handOut(bot, { light: { status: 503, error: 'overloaded' } })
  a.deepEqual(used.filter(m => m === 'light').length, 3, 'its retries first')
  a.equal(used.at(-1), 'fake')
  a.equal(task.result, 'done on fake')
})

test('the same model as the agent\'s own, or none, means no background model', async () => {
  const bot = await s.agent(up, { name: 'Ned' })
  const p = (await s.api('GET', '/api/bots')).body.find(b => b.id === bot)
  await s.api('PATCH', `/api/bots/${bot}`, { task_model: { provider_id: p.provider_id, model: 'fake' } })
  a.equal((await s.api('GET', '/api/bots')).body.find(b => b.id === bot).task_model, null)
  await s.api('PATCH', `/api/bots/${bot}`, { task_model: { provider_id: p.provider_id, model: 'light' } })
  await s.api('PATCH', `/api/bots/${bot}`, { task_model: null })
  a.equal((await s.api('GET', '/api/bots')).body.find(b => b.id === bot).task_model, null)
  a.equal((await s.api('PATCH', `/api/bots/${bot}`, { task_model: { provider_id: 'nope', model: 'x' } })).status, 400)
})
