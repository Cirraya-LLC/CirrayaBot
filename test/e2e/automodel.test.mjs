// Auto model mode: a turn starts on the agent's light model and moves up to its main one when the light one asks,
// gets stuck, can't read an image, or fails — and stays there for the rest of the turn. Manual mode is as before.
import { test, before, after } from 'node:test'
import { strict as a } from 'node:assert'
import { startStack } from './stack.mjs'
import { fakeUpstream } from './fake-upstream.mjs'

let s, up
before(async () => { up = await fakeUpstream({ models: [{ id: 'fake' }, { id: 'light' }] }); s = await startStack({ tools: true }) })
after(async () => { await s?.close(); await up?.close() })

/** An agent whose main model is `fake` and light model `light` on the same upstream. */
async function agent(name, extra = {}) {
  const id = await s.agent(up, { name })
  const p = (await s.api('GET', '/api/bots')).body.find(b => b.id === id)
  const r = await s.api('PATCH', `/api/bots/${id}`, { task_model: { provider_id: p.provider_id, model: 'light' }, ...extra })
  a.equal(r.status, 200, JSON.stringify(r.body))
  return id
}
const history = async id => (await s.api('GET', `/api/dm/${id}`)).body
const notes = r => r.events.filter(e => e.ev === 'tool' && e.data.phase === 'retry').map(e => e.data.reason)
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

test('by default (auto) a turn starts on the light model, and the reply says which model wrote it', async () => {
  const kim = await agent('Kim')
  const seen = []
  up.on(r => { seen.push([r.model, r.tools.includes('use_stronger_model')]); return { text: 'hi from light' } })
  const r = await s.chat({ agent: kim }, 'hello')
  a.equal(r.text, 'hi from light')
  a.deepEqual(seen, [['light', true]], 'on the light model, with the way up offered')
  const reply = (await history(kim)).findLast(m => m.role === 'assistant')
  a.equal(reply.model, 'light')
  a.deepEqual((await s.api('GET', '/api/settings/model-mode')).body, { mode: 'auto', modes: ['auto', 'manual'] })
})

test('the light model asks for more: the rest of the turn is on the main one', async () => {
  const lee = await agent('Lee')
  const models = []
  up.on(r => {
    models.push(r.model)
    if (r.model === 'light') return { tool: ['use_stronger_model', { reason: 'this bug is subtle' }] }
    return r.toolResults.some(x => x.includes('--- exit')) ? { text: 'done on main' } : { tool: ['bash', { command: 'echo hi' }] }
  })
  const r = await s.chat({ agent: lee }, 'fix the bug')
  a.deepEqual(models, ['light', 'fake', 'fake'])
  a.ok(notes(r).some(n => /asked for more/.test(n) && /fake/.test(n)), JSON.stringify(notes(r)))
  a.equal((await history(lee)).findLast(m => m.role === 'assistant').model, 'fake')
})

test('three failing commands in a row on the light model: up to the main one', async () => {
  const max = await agent('Max')
  const models = []
  up.on(r => {
    models.push(r.model)
    if (r.model === 'light') return { tool: ['bash', { command: 'make FAIL_EXIT' }] }
    return { text: 'sorted it on main' }
  })
  const r = await s.chat({ agent: max }, 'build it')
  a.deepEqual(models, ['light', 'light', 'light', 'fake'])
  a.ok(notes(r).some(n => /kept hitting failures/.test(n)))
  a.equal(r.text, 'sorted it on main')
})

test('a light model that can\'t read images hands the turn up instead of throwing the image away', async () => {
  const ivy = await agent('Ivy')
  const f = await fetch(`${s.url}/api/files?kind=agent&id=${ivy}&name=dot.png`, { method: 'POST',
    headers: { cookie: `ma_token=${s.token}`, 'content-type': 'image/png' }, body: PNG }).then(x => x.json())
  const got = []
  up.on(r => {
    const image = r.messages.some(m => Array.isArray(m.content) && m.content.some(p => p.type === 'image_url'))
    got.push([r.model, image])
    if (r.model === 'light' && image) return { status: 400, error: 'image input is not supported by this model' }
    return { text: 'a single dot' }
  })
  const r = await s.chat({ agent: ivy }, 'what is this?', { files: [f.id] })
  a.deepEqual(got, [['light', true], ['fake', true]], 'the main model got the image')
  a.ok(notes(r).some(n => /can't read images/.test(n)))
})

test('the light model failing hands the turn to the main one (the backups after it)', async () => {
  const joe = await agent('Joe')
  const models = []
  up.on(r => { models.push(r.model); return r.model === 'light' ? { status: 503, error: 'overloaded' } : { text: 'main here' } })
  const r = await s.chat({ agent: joe }, 'hi')
  a.equal(r.text, 'main here')
  a.equal(models.filter(m => m === 'light').length, 3, 'its retries first')
  a.equal(models.at(-1), 'fake')
})

test('manual: conversations on the main model, nothing offered to move up; the platform default can be manual too', async () => {
  const pat = await agent('Pat', { model_mode: 'manual' })
  const seen = []
  up.on(r => { seen.push([r.model, r.tools.includes('use_stronger_model')]); return { text: 'ok' } })
  await s.chat({ agent: pat }, 'hi')
  a.deepEqual(seen, [['fake', false]])
  a.equal((await s.api('PATCH', `/api/bots/${pat}`, { model_mode: 'sometimes' })).status, 400)

  a.equal((await s.api('PUT', '/api/settings/model-mode', { mode: 'manual' })).status, 200)
  const sam = await agent('Sam')
  seen.length = 0
  await s.chat({ agent: sam }, 'hi')
  a.deepEqual(seen, [['fake', false]], 'follows the platform')
  await s.api('PUT', '/api/settings/model-mode', { mode: 'auto' })
})

test('without a light model, auto is just the main model', async () => {
  const una = await s.agent(up, { name: 'Una' })
  const seen = []
  up.on(r => { seen.push([r.model, r.tools.includes('use_stronger_model')]); return { text: 'ok' } })
  await s.chat({ agent: una }, 'hi')
  a.deepEqual(seen, [['fake', false]])
})

test('a background task in auto mode can move up too', async () => {
  const zoe = await agent('Zoe')
  const taskModels = []
  up.on(r => {
    if (r.system.includes('--- You are working on a background task ---')) {
      taskModels.push(r.model)
      if (r.model === 'light') return { tool: ['use_stronger_model', { reason: 'needs care' }] }
      return { tool: ['finish_task', { result: `done on ${r.model}` }] }
    }
    if (r.lastUser.includes('[Platform]')) return { text: 'noted' }
    return r.toolResults.length ? { text: 'Started.' } : { tool: ['start_task', { title: 'dig', brief: 'dig in' }] }
  })
  await s.chat({ agent: zoe }, 'go')
  await s.until(async () => (await s.api('GET', `/api/tasks?kind=agent&id=${zoe}`)).body[0]?.status === 'done', { what: 'the task' })
  a.deepEqual(taskModels, ['light', 'fake'])
  a.equal((await s.api('GET', `/api/tasks?kind=agent&id=${zoe}`)).body[0].result, 'done on fake')
})
