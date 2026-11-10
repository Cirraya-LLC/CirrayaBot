// An agent searching what was said before: its own DM's other sessions and the groups it is in — never another
// agent's DM or a group it isn't in, never the session it is reading now. read_history shows the exchange around a hit.
import { test, before, after } from 'node:test'
import { strict as a } from 'node:assert'
import { startStack } from './stack.mjs'
import { fakeUpstream } from './fake-upstream.mjs'

let s, up
before(async () => { up = await fakeUpstream(); s = await startStack({ tools: true }) })
after(async () => { await s?.close(); await up?.close() })

/** Say something in a conversation and get a fixed answer back. */
async function say(target, text, answer, session = 'new') {
  up.on(() => ({ text: answer }))
  const r = await s.chat(target, text, { session })
  a.equal(r.status, 200)
  return r.session
}
const idOf = async (agent, session, text) =>
  (await s.api('GET', `/api/dm/${agent}?session=${session}`)).body.find(m => m.content === text)?.id

test('an agent finds its own other sessions and its groups, and reads around a hit', async () => {
  const kim = await s.agent(up, { name: 'Kim' }), lee = await s.agent(up, { name: 'Lee' }), max = await s.agent(up, { name: 'Max' })
  const old = await say({ agent: kim }, 'For releases, use the blue deploy script in /work/ship.sh', 'Noted: the blue deploy script.')
  await say({ agent: lee }, 'My private deploy notes: the red script', 'OK.')
  const ops = (await s.api('POST', '/api/groups', { name: 'Ops', members: [kim, lee], lead: kim })).body
  const other = (await s.api('POST', '/api/groups', { name: 'Other', members: [lee, max], lead: lee })).body
  await say({ group: ops.id }, 'We deploy on Friday at noon', 'Friday at noon it is.')
  await say({ group: other.id }, 'Kim must not see this deploy plan', 'Sure.')
  const leeLine = await idOf(lee, (await s.api('GET', `/api/sessions?kind=agent&id=${lee}`)).body[0].id, 'My private deploy notes: the red script')
  a.ok(leeLine, 'Lee\'s message id')

  const results = []
  up.on(r => {
    const n = r.toolResults.length
    results.splice(0, results.length, ...r.toolResults)
    if (n === 0) return { tool: ['search_history', { query: 'deploy' }] }
    if (n === 1) return { tool: ['search_history', { query: 'blue "deploy script"' }] }
    if (n === 2) return { tool: ['read_history', { message_id: Number(r.toolResults[1].match(/\[#(\d+)\]/)[1]) }] }
    if (n === 3) return { tool: ['read_history', { message_id: leeLine }] }
    if (n === 4) return { tool: ['search_history', { query: '   ' }] }
    return { text: 'done' }
  })
  const now = await s.chat({ agent: kim }, 'What did we say about the deploy?', { session: 'new' })
  a.equal(now.status, 200)
  a.ok(up.requests.at(-1).tools.includes('search_history') && up.requests.at(-1).tools.includes('read_history'))
  const [all, phrase, around, foreign, empty] = results

  a.match(all, /^3 found for "deploy", newest first \(now: /)
  a.match(all, /group "Ops" · session "We deploy on Friday at noon" · User: We deploy on Friday/, 'its group')
  a.match(all, /your DM with the user · session "For releases[^"]*" · User: For releases, use the blue deploy script/)
  a.match(all, /Kim: Noted: the blue deploy script/, 'its own replies, by name')
  a.ok(!/red script|must not see/.test(all), 'not another agent\'s DM, not a group it isn\'t in')
  a.ok(!/What did we say/.test(all), 'not the session it is reading now')
  a.match(phrase, /^2 found for "blue "deploy script""/, 'every word, the phrase together')

  a.match(around, /» \[#\d+\] .* Kim:\nNoted: the blue deploy script\./, 'the newest hit, marked')
  a.match(around, /\[#\d+\] .* User:\nFor releases, use the blue deploy script/, 'and the line before it')
  a.match(around, /session "For releases, use the blue deploy script/, 'named by its first message')
  a.match(foreign, /^There is no message #\d+ in your conversations\./)
  a.equal(empty, 'Give some words to search for.')

  // The calls show as cards in the transcript.
  const rows = (await s.api('GET', `/api/dm/${kim}?session=${now.session}`)).body.filter(m => m.role === 'tool').map(m => m.name)
  a.deepEqual(rows, ['search_history', 'search_history', 'read_history', 'read_history', 'search_history'])
  a.ok(old)
})

test('leaving a group takes its history out of reach', async () => {
  const ann = await s.agent(up, { name: 'Ann' }), bo = await s.agent(up, { name: 'Bo' }), cy = await s.agent(up, { name: 'Cy' })
  const g = (await s.api('POST', '/api/groups', { name: 'Team', members: [ann, bo], lead: ann })).body
  await say({ group: g.id }, 'The launch code word is heron', 'Got it.')
  const search = async () => {
    let out = ''
    up.on(r => r.toolResults.length ? (out = r.toolResults[0], { text: 'ok' }) : { tool: ['search_history', { query: 'heron' }] })
    await s.chat({ agent: bo }, 'code word?', { session: 'new' })
    return out
  }
  a.match(await search(), /^1 found/)
  await s.api('PATCH', `/api/groups/${g.id}`, { members: [ann, cy] })
  a.match(await search(), /^Nothing found for "heron"/)
})
