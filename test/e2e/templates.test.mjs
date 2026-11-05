// Templates: the shipped ones are listed, an agent made from one gets its skills, any agent exports to a
// file that imports back — never with its model.
import { test, before, after } from 'node:test'
import { strict as a } from 'node:assert'
import { startStack } from './stack.mjs'
import { fakeUpstream } from './fake-upstream.mjs'

let s, up
before(async () => { up = await fakeUpstream(); s = await startStack({ tools: true }) })
after(async () => { await s?.close(); await up?.close() })

test('shipped templates, an agent made from one, its skills shared or kept apart', async () => {
  const list = (await s.api('GET', '/api/templates')).body
  a.ok(list.agents.length >= 6 && list.skills.length >= 6)
  const researcher = list.agents.find(t => t.id === 'researcher')
  a.equal(researcher.name, 'Researcher')
  a.ok(researcher.skills.some(k => k.name === 'web-research' && /duckduckgo/i.test(k.body)))
  a.ok(!('model' in researcher))

  const p = (await s.api('GET', '/api/providers')).body[0] ?? (await s.api('POST', '/api/providers', { name: 'up', base_url: up.url })).body
  const make = async name => {
    const r = await s.api('POST', '/api/bots', { name, description: researcher.description, persona: researcher.persona,
      provider_id: p.id, model: 'fake', approval: researcher.approval, skills: researcher.skills, color: researcher.color })
    a.equal(r.status, 200, JSON.stringify(r.body))
    return r.body.id
  }
  const one = await make('Res One'), two = await make('Res Two')
  const skills = (await s.api('GET', '/api/skills')).body
  const web = skills.filter(k => k.name.startsWith('web-research'))
  a.equal(web.length, 1, 'the same skill is shared, not copied')
  a.deepEqual(web[0].agents.sort(), [one, two].sort())
  a.equal((await s.api('GET', '/api/bots')).body.find(b => b.id === one).color, researcher.color)

  // A template whose skill has the same name but other steps: kept apart under another name.
  const three = (await s.api('POST', '/api/bots', { name: 'Res Three', persona: 'p', provider_id: p.id, model: 'fake',
    skills: [{ name: 'web-research', description: 'mine', body: 'Different steps.' }] })).body.id
  const after = (await s.api('GET', '/api/skills')).body
  a.ok(after.some(k => k.name === 'web-research (2)' && k.agents.includes(three) && k.body === 'Different steps.'))
  a.ok(!after.find(k => k.name === 'web-research').agents.includes(three), 'someone else\'s skill left alone')
})

test('an agent exports to a template and imports back, without its model', async () => {
  const kim = await s.agent(up, { name: 'Kim', persona: 'You are Kim.' })
  await s.api('PATCH', `/api/bots/${kim}`, { setup: 'echo hi', goals: 'Watch the build', checkin_every: 240, approval: 'all' })
  await s.api('POST', '/api/skills', { name: 'kim-skill', description: 'When Kim needs it', body: 'Steps.', agents: [kim] })
  const doc = (await s.api('GET', `/api/bots/${kim}/template`)).body
  a.equal(doc.format, 'cirrayabot-agent')
  a.deepEqual([doc.name, doc.persona, doc.setup, doc.goals, doc.checkin_every, doc.approval], ['Kim', 'You are Kim.', 'echo hi', 'Watch the build', 240, 'all'])
  a.deepEqual(doc.skills.map(k => k.name), ['kim-skill'])
  a.ok(!JSON.stringify(doc).includes('"model"') && !JSON.stringify(doc).includes('provider_id'), 'no model, no upstream')

  const back = await s.api('POST', '/api/templates/check', { doc })
  a.equal(back.status, 200)
  a.equal(back.body.skills[0].body, 'Steps.')
  const bad = await s.api('POST', '/api/templates/check', { doc: { ...doc, checkin_every: 7 } })
  a.equal(bad.status, 400)
  a.match(bad.body.error, /checkin_every/)
  a.equal((await s.api('POST', '/api/templates/check', { doc: { hello: 1 } })).status, 400)
})
