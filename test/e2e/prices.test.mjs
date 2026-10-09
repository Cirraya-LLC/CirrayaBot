// Prices come from the person's own upstream: what its /models lists for the exact model, else what
// was typed on the upstream, else nothing. Nothing is built in.
import { test, before, after } from 'node:test'
import { strict as a } from 'node:assert'
import { startStack } from './stack.mjs'
import { fakeUpstream } from './fake-upstream.mjs'

let s, listed, plain
before(async () => {
  // $3 / $15 per million for "priced"; "fake-pro" priced too, to show a near match doesn't count
  listed = await fakeUpstream({ name: 'listed', models: [
    { id: 'priced', context_length: 64000, pricing: { prompt: '0.000003', completion: '0.000015' } },
    { id: 'fake-pro', pricing: { prompt: '0.00001', completion: '0.00001' } },
    { id: 'fake' },
  ] })
  plain = await fakeUpstream({ name: 'plain', models: [{ id: 'fake' }] })
  s = await startStack()
})
after(async () => { await s?.close(); await listed?.close(); await plain?.close() })

const usage = { prompt_tokens: 1000, completion_tokens: 500 }
const spendOf = async id => (await s.api('GET', '/api/usage')).body.agents.find(x => x.id === id)

test('a price the upstream lists for the model is used, per model', async () => {
  const bot = await s.agent(listed, { name: 'Pia', model: 'priced' })
  listed.on(() => ({ text: 'ok', usage }))
  await s.chat({ agent: bot }, 'hi')
  // 1000 × $3/M + 500 × $15/M = $0.0105
  const u = await s.until(async () => { const x = await spendOf(bot); return x?.month.calls === 1 && x }, { what: 'the usage row' })
  a.equal(u.month.cost_micro, 10_500)
  a.equal(u.priced, true)
  a.equal(u.price_source, 'upstream')
  a.deepEqual([u.price_in_micro, u.price_out_micro], [3_000_000, 15_000_000])
})

test('a near match is not a price; the model with none stays unpriced', async () => {
  const bot = await s.agent(listed, { name: 'Quin', model: 'fake' })
  listed.on(() => ({ text: 'ok', usage }))
  await s.chat({ agent: bot }, 'hi')
  const u = await s.until(async () => { const x = await spendOf(bot); return x?.month.calls === 1 && x }, { what: 'the usage row' })
  a.equal(u.month.cost_micro, null, '"fake-pro" has a price; "fake" does not borrow it')
  a.equal(u.month.unpriced, 1)
  a.equal(u.priced, false)
})

test('prices typed on the upstream are the fallback', async () => {
  const bot = await s.agent(plain, { name: 'Ray' })
  const p = (await s.api('GET', '/api/providers')).body.find(x => x.base_url === plain.url)
  a.equal((await s.api('PATCH', `/api/providers/${p.id}`, { price_in_micro: 1_000_000, price_out_micro: 2_000_000 })).status, 200)
  plain.on(() => ({ text: 'ok', usage }))
  await s.chat({ agent: bot }, 'hi')
  const u = await s.until(async () => { const x = await spendOf(bot); return x?.month.calls === 1 && x }, { what: 'the usage row' })
  a.equal(u.month.cost_micro, 2_000)          // 1000 × $1/M + 500 × $2/M
  a.equal(u.price_source, 'manual')
})

test('the daily cap holds on a listed price', async () => {
  const bot = await s.agent(listed, { name: 'Sid', model: 'priced', daily_cap_micro: 5_000 })
  listed.on(() => ({ text: 'ok', usage }))
  const first = await s.chat({ agent: bot }, 'one')
  a.equal(first.error, null)
  await s.until(async () => (await spendOf(bot))?.day.calls === 1, { what: 'the first call to be counted' })
  const second = await s.chat({ agent: bot }, 'two')
  a.equal(second.error?.capped, true, JSON.stringify(second.error))
})
