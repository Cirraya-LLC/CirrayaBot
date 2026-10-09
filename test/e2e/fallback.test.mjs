// Backup models: when an agent's own model keeps failing, the turn carries on with the next one the
// person picked for it — and only for failures a different model could fix.
import { test, before, after } from 'node:test'
import { strict as a } from 'node:assert'
import { startStack } from './stack.mjs'
import { fakeUpstream } from './fake-upstream.mjs'

let s, main, backup
before(async () => {
  main = await fakeUpstream({ name: 'main' })
  backup = await fakeUpstream({ name: 'backup', models: [{ id: 'spare' }] })
  s = await startStack()
})
after(async () => { await s?.close(); await main?.close(); await backup?.close() })

async function withBackup(name) {
  const bot = await s.agent(main, { name })
  const providers = (await s.api('GET', '/api/providers')).body
  const b = providers.find(p => p.base_url === backup.url) ?? (await s.api('POST', '/api/providers', { name: 'backup', base_url: backup.url })).body
  const r = await s.api('PATCH', `/api/bots/${bot}`, { fallbacks: [{ provider_id: b.id, model: 'spare' }] })
  a.equal(r.status, 200, JSON.stringify(r.body))
  return { bot, backupId: b.id }
}

test('a model that keeps failing hands the turn to the backup, and says so', async () => {
  const { bot } = await withBackup('Fay')
  main.on(() => ({ status: 503, error: 'overloaded' }))
  backup.on(r => ({ text: `backup here (${r.model}), you said ${r.lastUser}` }))
  const tried = main.mark(), spared = backup.mark()
  const r = await s.chat({ agent: bot }, 'hello')
  a.equal(r.error, null, JSON.stringify(r.error))
  a.equal(r.text, 'backup here (spare), you said hello')
  a.equal(tried().length, 3, 'the main model got its retries first')
  a.equal(spared().length, 1)
  const note = r.events.find(e => e.ev === 'tool' && e.data.phase === 'retry' && /backup model spare/.test(e.data.reason))
  a.ok(note, 'the switch is shown in the conversation')
  // The next turn starts from the agent's own model again.
  main.on(() => ({ text: 'main is back' }))
  a.equal((await s.chat({ agent: bot }, 'again')).text, 'main is back')
})

test('the rest of a turn stays on the backup, tool calls included', async () => {
  const { bot } = await withBackup('Gus')
  main.on(() => ({ streamError: 'upstream request failed' }))
  backup.on(r => r.toolResults.length ? { text: 'done after the tool' } : { tool: ['update_plan', { plan: [{ step: 'x', status: 'completed' }] }] })
  const tried = main.mark()
  const r = await s.chat({ agent: bot }, 'go')
  a.equal(r.text, 'done after the tool')
  a.equal(tried().length, 3, 'once switched, the main model is not asked again within the turn')
})

test('a request the upstream rejects as malformed is not retried on the backup', async () => {
  const { bot } = await withBackup('Hal')
  main.on(() => ({ status: 400, error: 'bad request: messages too long' }))
  const spared = backup.mark()
  const r = await s.chat({ agent: bot }, 'hello')
  a.match(r.error?.message ?? '', /400/)
  a.equal(spared().length, 0)
})

test('an upstream that is down altogether falls back at once', async () => {
  const dead = await fakeUpstream({ name: 'dead' })
  const bot = await s.agent(dead, { name: 'Ida' })
  await dead.close()                        // connection refused from here on
  const b = (await s.api('GET', '/api/providers')).body.find(p => p.base_url === backup.url)
  a.equal((await s.api('PATCH', `/api/bots/${bot}`, { fallbacks: [{ provider_id: b.id, model: 'spare' }] })).status, 200)
  backup.on(() => ({ text: 'still here' }))
  const r = await s.chat({ agent: bot }, 'hi')
  a.equal(r.text, 'still here', JSON.stringify(r.error))
})

test('backup models are checked when saved, and keep their upstream from being deleted', async () => {
  const { bot, backupId } = await withBackup('Joe')
  const mainId = (await s.api('GET', '/api/providers')).body.find(p => p.base_url === main.url).id
  const bad = async fallbacks => (await s.api('PATCH', `/api/bots/${bot}`, { fallbacks })).status
  a.equal(await bad([{ provider_id: mainId, model: 'fake' }]), 400, 'the main model itself is not a backup')
  a.equal(await bad([{ provider_id: backupId, model: '' }]), 400, 'a backup needs a model')
  a.equal(await bad([{ provider_id: backupId, model: 'spare' }, { provider_id: backupId, model: 'spare' }]), 400, 'no duplicates')
  a.equal(await bad([1, 2, 3, 4].map(i => ({ provider_id: backupId, model: `m${i}` }))), 400, 'at most three')
  a.equal(await bad([{ provider_id: 'nope', model: 'x' }]), 400, 'the upstream must exist')
  const del = await s.api('DELETE', `/api/providers/${backupId}`)
  a.equal(del.status, 409, 'in use as a backup')
  a.match(del.body.error, /Joe/)
  const got = (await s.api('GET', '/api/bots')).body.find(x => x.id === bot)
  a.deepEqual(got.fallbacks, [{ provider_id: backupId, model: 'spare' }])
})
