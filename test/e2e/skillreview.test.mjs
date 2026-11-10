// Keeping skills in order: uses counted, unused ones suggested for archiving, the light model's merges and clearer
// descriptions suggested — and nothing changes until a person applies one. Archived skills leave the prompt.
import { test, before, after } from 'node:test'
import { strict as a } from 'node:assert'
import { startStack } from './stack.mjs'
import { fakeUpstream } from './fake-upstream.mjs'

let s, up
before(async () => { up = await fakeUpstream(); s = await startStack({ tools: true }) })
after(async () => { await s?.close(); await up?.close() })

const skill = async (agent, name, description, body) =>
  (await s.api('POST', '/api/skills', { name, description, body, agents: [agent] })).body
const named = async () => Object.fromEntries((await s.api('GET', '/api/skills')).body.map(k => [k.name, k]))

test('uses counted; a review suggests, a person applies or dismisses', async () => {
  const kim = await s.agent(up, { name: 'Kim' })
  const deploy = await skill(kim, 'Deploy', 'When deploying', '1. Build\n2. Push the image\n3. Restart the service')
  const release = await skill(kim, 'Release', 'When releasing', '1. Build\n2. Push the image\n3. Restart')
  const report = await skill(kim, 'Report', 'stuff', 'Write the weekly report from the tracker.')
  const old = await skill(kim, 'Old habit', 'When filing expenses', 'Use the old expenses form.')
  await s.sql(`update skills set created_at = now() - interval '40 days' where id = $1`, [old.id])

  // A read counts as a use.
  up.on(r => r.toolResults.length ? { text: 'done' } : { tool: ['read_skill', { name: 'Deploy' }] })
  await s.chat({ agent: kim }, 'deploy it', { session: 'new' })
  a.equal((await named()).Deploy.uses, 1)
  a.ok((await named()).Deploy.used_at)

  // The review: the model sees the skills with their use, and its suggestions are checked.
  let seen = ''
  up.on(r => {
    seen = r.users.at(-1)
    return { text: JSON.stringify({ suggestions: [
      { kind: 'merge', skills: [deploy.id, release.id], name: 'Deploy', description: 'When deploying or releasing',
        body: '1. Build\n2. Push the image\n3. Restart the service', why: 'Same steps twice' },
      { kind: 'describe', skill: report.id, description: 'When the user asks for the weekly report', why: '"stuff" says nothing' },
      { kind: 'archive', skill: 'k-nonexistent', why: 'unknown' },
    ] }) }
  })
  const r = await s.api('POST', '/api/skills/review', { agent: kim })
  a.equal(r.status, 200, JSON.stringify(r.body))
  a.equal(r.body.added, 3)
  a.match(seen, /### \[\w+\] Deploy\nWhen to use it: When deploying\nUsage: used 1 time, last \d{4}-/)
  a.match(seen, /Old habit\nWhen to use it: When filing expenses\nUsage: never used/)
  const sug = r.body.suggestions
  a.deepEqual(sug.map(x => x.kind).sort(), ['archive', 'describe', 'merge'])
  const byKind = Object.fromEntries(sug.map(x => [x.kind, x]))
  a.match(byKind.archive.why, /Never used, added 40 days ago/)
  a.deepEqual(byKind.merge.skills.map(k => k.name).sort(), ['Deploy', 'Release'])
  a.equal(byKind.merge.agent_name, 'Kim')
  a.equal((await named()).Report.description, 'stuff', 'nothing changed by suggesting')

  // Reviewing again doesn't suggest the same things twice.
  a.equal((await s.api('POST', '/api/skills/review', { agent: kim })).body.added, 0)

  // Apply the merge: Deploy takes the merged text, Release is archived and leaves the prompt.
  const applied = await s.api('POST', `/api/skills/suggestions/${byKind.merge.id}`, { action: 'apply' })
  a.equal(applied.status, 200, JSON.stringify(applied.body))
  const after1 = await named()
  a.equal(after1.Deploy.description, 'When deploying or releasing')
  a.equal(after1.Deploy.source, 'human')
  a.ok(after1.Release.archived_at, 'archived, still in the library')
  up.on(() => ({ text: 'ok' }))
  await s.chat({ agent: kim }, 'hi', { session: 'new' })
  const system = up.requests.at(-1).system
  a.ok(system.includes('Deploy') && !system.includes('Release:') && !/\bRelease\b.*When releasing/.test(system), 'an archived skill is not offered')

  // Apply the description with the person's own wording; dismiss the archive suggestion.
  a.equal((await s.api('POST', `/api/skills/suggestions/${byKind.describe.id}`, { action: 'apply', draft: { description: 'Weekly report requests' } })).status, 200)
  a.equal((await named()).Report.description, 'Weekly report requests')
  a.equal((await s.api('POST', `/api/skills/suggestions/${byKind.archive.id}`, { action: 'dismiss' })).status, 200)
  a.equal((await s.api('GET', '/api/skills/suggestions')).body.length, 0)
  a.equal((await s.api('POST', '/api/skills/review', { agent: kim })).body.added, 0, 'a dismissed one is not suggested again')
  a.equal((await s.api('POST', `/api/skills/suggestions/${byKind.archive.id}`, { action: 'apply' })).status, 404)

  // Restore by hand.
  a.equal((await s.api('POST', `/api/skills/${release.id}/archive`, { archived: false })).body.archived_at, null)
})

test('a suggestion goes stale when its skill is edited; a failed model still leaves the rules\' suggestions', async () => {
  const lee = await s.agent(up, { name: 'Lee' })
  const x = await skill(lee, 'Alpha', 'When alpha', 'Do alpha carefully, step by step.')
  const y = await skill(lee, 'Beta', 'When beta', 'Do beta carefully, step by step.')
  await s.sql(`update skills set created_at = now() - interval '35 days' where id = $1`, [y.id])
  up.on(() => ({ text: JSON.stringify({ suggestions: [{ kind: 'describe', skill: x.id, description: 'When the alpha job comes up', why: 'clearer' }] }) }))
  const r = (await s.api('POST', '/api/skills/review', { agent: lee })).body
  const d = r.suggestions.find(z => z.kind === 'describe' && z.agent_name === 'Lee')
  await s.api('PATCH', `/api/skills/${x.id}`, { body: 'Do alpha differently now.' })
  const stale = await s.api('POST', `/api/skills/suggestions/${d.id}`, { action: 'apply' })
  a.equal(stale.status, 409)
  a.match(stale.body.error, /changed or gone/)

  // The model fails: the unused rule still makes its suggestion, and the reason is said.
  await s.sql(`delete from skill_suggestions where agent_id = $1`, [lee])
  up.on(() => ({ status: 500, error: 'down' }))
  const failed = (await s.api('POST', '/api/skills/review', { agent: lee })).body
  a.equal(failed.added, 1)
  a.ok(failed.problem)
  a.ok(failed.suggestions.some(z => z.kind === 'archive' && z.skills[0].name === 'Beta'))

  // Archiving by hand removes open suggestions about it; deleting the agent removes its suggestions.
  a.equal((await s.api('POST', `/api/skills/${y.id}/archive`, {})).status, 200)
  a.equal((await s.api('GET', '/api/skills/suggestions')).body.filter(z => z.agent_name === 'Lee').length, 0)
})

test('the agent saving a skill it had archived brings it back; weekly review is a setting', async () => {
  const max = await s.agent(up, { name: 'Max' })
  up.on(r => r.toolResults.length ? { text: 'saved' } : { tool: ['save_skill', { name: 'Tidy desk', description: 'When the desk is messy', body: 'Sort the files.' }] })
  await s.chat({ agent: max }, 'save it', { session: 'new' })
  const k = (await named())['Tidy desk']
  await s.api('POST', `/api/skills/${k.id}/archive`, {})
  await s.chat({ agent: max }, 'save it again', { session: 'new' })
  a.equal((await named())['Tidy desk'].archived_at, null)

  a.deepEqual((await s.api('GET', '/api/settings/skills')).body, { review_weekly: false })
  a.deepEqual((await s.api('PUT', '/api/settings/skills', { review_weekly: true })).body, { review_weekly: true })
})
