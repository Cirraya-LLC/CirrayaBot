// Teaching by demonstration: recording a person's steps in an agent's browser (the daemon is faked here; the real
// one is checked on its own), the steps described in the person's language, and the agent's model drafting a skill
// that nothing saves until the person does.
import { test, before, after } from 'node:test'
import { strict as a } from 'node:assert'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { startStack } from './stack.mjs'
import { fakeUpstream } from './fake-upstream.mjs'

let s, up
before(async () => { up = await fakeUpstream(); s = await startStack({ tools: true }) })
after(async () => { await s?.close(); await up?.close() })

const state = () => join(s.work, 'docker.log.containers')
const daemon = body => writeFile(state() + '.browser', JSON.stringify({ ok: true, url: 'https://shop.test/', title: 'Shop', ...body }))
const daemonCalls = async () => (await readFile(state() + '.browser-calls', 'utf8').catch(() => ''))
  .split('\n').filter(Boolean).map(l => JSON.parse(l))

const STEPS = [
  { kind: 'start', url: 'https://shop.test/', title: 'Shop' },
  { kind: 'click', what: { tag: 'input', label: 'Search', name: 'q' } },
  { kind: 'type', what: { tag: 'input', label: 'Search', name: 'q' }, text: 'blue mug' },
  { kind: 'key', key: 'Enter' },
  { kind: 'type', what: { tag: 'input', type: 'password', password: true, label: 'Password' }, secret: true, text: '' },
  { kind: 'click', what: { tag: 'button', type: 'submit', text: 'Sign in' } },
]
const DRAFT = '---\nname: Reorder a mug\ndescription: When the person wants the same mug again\n---\n1. Open https://shop.test/\n2. Search for the mug.'

test('record: start, a human action counted, stop hands back the steps described in the reader\'s language', async () => {
  const kim = await s.agent(up, { name: 'Kim' })
  await daemon({ recording: true })
  const on = await s.api('POST', `/api/browser/${kim}/record`, { on: true })
  a.equal(on.status, 200, JSON.stringify(on.body))
  a.equal(on.body.recording, true)
  a.deepEqual((await s.api('GET', `/api/browser/${kim}/record`)).body.recording, true)

  await s.api('POST', `/api/browser/${kim}/act`, { action: 'click_xy', x: 10, y: 20 })
  const calls = await daemonCalls()
  a.deepEqual(calls.map(c => c.action), ['record_start', 'click_xy'])
  a.equal(calls[1].human, true, 'a person\'s action is marked, so the daemon records it')

  await daemon({ steps: STEPS, seconds: 42 })
  const off = await s.api('POST', `/api/browser/${kim}/record`, { on: false }, { 'x-lang': 'zh-Hans' })
  a.equal(off.status, 200, JSON.stringify(off.body))
  a.equal(off.body.seconds, 42)
  a.equal(off.body.steps.length, 6)
  a.equal(off.body.lines[2], '3. 在「Search」输入框里输入了「blue mug」')
  a.equal(off.body.lines[4], '5. 在「Password」密码框里输入了密码（没有记录）')
  a.equal((await s.api('GET', `/api/browser/${kim}/record`)).body.recording, false)
})

test('stopping when nothing was recording says so', async () => {
  const lee = await s.agent(up, { name: 'Lee' })
  await daemon({ steps: [] })
  const r = await s.api('POST', `/api/browser/${lee}/record`, { on: false })
  a.equal(r.status, 400)
  a.match(r.body.error, /not being recorded/)
})

test('draft: the agent\'s own model writes the skill from the steps; a password never reaches it; nothing is saved', async () => {
  const max = await s.agent(up, { name: 'Max' })
  let asked = null
  up.on(r => { asked = r; return { text: '```markdown\n' + DRAFT + '\n```' } })
  const leaky = STEPS.map(x => x.secret ? { ...x, text: 'hunter2' } : x)     // a client that left the text in
  const r = await s.api('POST', `/api/teach/${max}`, { goal: 'Reorder the mug I always buy', steps: leaky })
  a.equal(r.status, 200, JSON.stringify(r.body))
  a.deepEqual(r.body, { name: 'Reorder a mug', description: 'When the person wants the same mug again',
    body: '1. Open https://shop.test/\n2. Search for the mug.', agents: [max] })
  a.match(asked.system, /never write one down/)
  a.match(asked.lastUser, /Reorder the mug I always buy/)
  a.match(asked.lastUser, /3\. Typed "blue mug" into the "Search" field/, 'the model reads the steps in English')
  a.ok(!JSON.stringify(asked).includes('hunter2'))
  a.equal(asked.tools.length, 0, 'a bare call, no tools')
  a.ok(!(await s.api('GET', '/api/skills')).body.some(k => k.name === 'Reorder a mug'), 'the person saves it, not this')
  const usage = (await s.api('GET', '/api/usage')).body
  a.ok(JSON.stringify(usage).includes(max), 'the call is counted like any other')
})

test('draft: no steps, or an answer that is not a skill, is refused', async () => {
  const ivy = await s.agent(up, { name: 'Ivy' })
  a.equal((await s.api('POST', `/api/teach/${ivy}`, { goal: 'x', steps: [] })).status, 400)
  a.equal((await s.api('POST', `/api/teach/${ivy}`, { goal: 'x', steps: 'nope' })).status, 400)
  up.on(() => ({ text: 'Sure, I can help with that!' }))
  const r = await s.api('POST', `/api/teach/${ivy}`, { goal: 'x', steps: STEPS })
  a.equal(r.status, 400)
  a.match(r.body.error, /did not answer with a skill/)
  a.equal((await s.api('POST', '/api/teach/nobody', { steps: STEPS })).status, 404)
})
