// Tidying an agent's own notes: one call to its model, the result kept to the caps, undoable once;
// a nightly setting; a bad answer leaves the notes alone.
import { test, before, after } from 'node:test'
import { strict as a } from 'node:assert'
import { startStack } from './stack.mjs'
import { fakeUpstream } from './fake-upstream.mjs'

let s, up
before(async () => { up = await fakeUpstream(); s = await startStack() })
after(async () => { await s?.close(); await up?.close() })

const NOTES = ['Deploys go through ./start.sh', 'deploys go through ./start.sh', 'The box is test-01', 'The box is test-02 now'].join('\n')

test('tidy rewrites the notes with the agent\'s model, and undo takes it back', async () => {
  const kim = await s.agent(up, { name: 'Kim' })
  await s.api('PUT', `/api/memory/agent/${kim}/self`, { text: NOTES })
  let asked = null
  up.on(r => { asked = r; return { text: '- Deploys go through ./start.sh\n- The box is test-02 now' } })
  const r = await s.api('POST', `/api/memory/agent/${kim}/self/tidy`)
  a.equal(r.status, 200, JSON.stringify(r.body))
  a.equal(r.body.changed, true)
  a.equal(r.body.text, 'Deploys go through ./start.sh\nThe box is test-02 now')
  a.match(asked.system, /never add anything that is not in the notes/)
  a.equal(asked.lastUser, NOTES, 'the notes go in as they are')
  a.equal(asked.tools.length, 0, 'a bare call, no tools')
  a.equal((await s.api('GET', `/api/memory/agent/${kim}/self`)).body.text, r.body.text)

  const u = await s.api('POST', `/api/memory/agent/${kim}/self/undo`)
  a.equal(u.status, 200)
  a.equal((await s.api('GET', `/api/memory/agent/${kim}/self`)).body.text, NOTES)
  a.equal((await s.api('POST', `/api/memory/agent/${kim}/self/undo`)).status, 409, 'only once')
})

test('an answer that lost most of the notes is not used', async () => {
  const lee = await s.agent(up, { name: 'Lee' })
  const many = Array.from({ length: 12 }, (_, i) => `fact number ${i}`).join('\n')
  await s.api('PUT', `/api/memory/agent/${lee}/self`, { text: many })
  up.on(() => ({ text: 'The user likes facts.' }))
  const r = await s.api('POST', `/api/memory/agent/${lee}/self/tidy`)
  a.equal(r.status, 400)
  a.match(r.body.error, /left as they were/)
  a.equal((await s.api('GET', `/api/memory/agent/${lee}/self`)).body.text, many)
})

test('editing the notes by hand drops the undo; one line has nothing to tidy', async () => {
  const max = await s.agent(up, { name: 'Max' })
  await s.api('PUT', `/api/memory/agent/${max}/self`, { text: NOTES })
  up.on(() => ({ text: 'Deploys go through ./start.sh\nThe box is test-02 now' }))
  await s.api('POST', `/api/memory/agent/${max}/self/tidy`)
  await s.api('PUT', `/api/memory/agent/${max}/self`, { text: 'one fact' })
  a.equal((await s.api('POST', `/api/memory/agent/${max}/self/undo`)).status, 409)
  const calls = up.mark()
  const r = await s.api('POST', `/api/memory/agent/${max}/self/tidy`)
  a.deepEqual([r.status, r.body.changed, calls().length], [200, false, 0])
})

test('the nightly setting is saved', async () => {
  a.deepEqual((await s.api('GET', '/api/settings/memory')).body, { tidy_nightly: false })
  a.deepEqual((await s.api('PUT', '/api/settings/memory', { tidy_nightly: true })).body, { tidy_nightly: true })
  a.deepEqual((await s.api('GET', '/api/settings/memory')).body, { tidy_nightly: true })
})
