// A call that changes something outside is not made twice because the server restarted mid-turn:
// the resumed turn gets what it returned, or "outcome unknown — check first" if it never finished.
import { test, before, after } from 'node:test'
import { strict as a } from 'node:assert'
import { createServer } from 'node:https'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startStack } from './stack.mjs'
import { fakeUpstream } from './fake-upstream.mjs'
import { callKey } from '../../web/effects.mjs'

// An API that takes a while to answer a charge, so the server can be killed while it is in flight.
let api, apiUrl, s, up
const charges = []
before(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ma-cert-'))
  const cert = join(dir, 'c.pem')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'k.pem'), '-out', cert,
    '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' })
  api = createServer({ key: readFileSync(join(dir, 'k.pem')), cert: readFileSync(cert) }, (req, res) => {
    charges.push({ method: req.method, key: req.headers['idempotency-key'] ?? null })
    setTimeout(() => { res.writeHead(200); res.end('charged') }, charges.length === 1 ? 3000 : 10)
  })
  await new Promise(ok => api.listen(0, '127.0.0.1', ok))
  apiUrl = `https://localhost:${api.address().port}`
  up = await fakeUpstream()
  s = await startStack({ tools: true, env: { HTTP_REQUEST_ALLOW: apiUrl, NODE_EXTRA_CA_CERTS: cert } })
  // nothing waits for a person here
  await s.api('PUT', '/api/approvals/policy', { mode: 'off' })
})
after(async () => { await s?.close(); await up?.close(); api?.close() })

const charge = () => ['http_request', { method: 'POST', url: `${apiUrl}/charge` }]

test('a request in flight when the server dies is not sent again; asked again after checking, it goes out with the same key', async () => {
  const bot = await s.agent(up, { name: 'Pay' })
  up.on(r => {
    const results = r.messages.filter(m => m.role === 'tool').map(m => m.content)
    if (!results.length) return { tool: charge() }
    if (results.length === 1 && /may or may not have finished/.test(results[0])) return { tool: charge() }  // checked; try again
    return { text: 'all done' }
  })
  const first = s.chat({ agent: bot }, 'charge the card').catch(() => null)
  await s.until(() => charges.length === 1, { what: 'the charge in flight' })
  await s.restart()
  await first
  const session = (await s.api('GET', `/api/sessions?kind=agent&id=${bot}`)).body[0].id
  await s.until(async () => (await s.history(bot, session)).some(m => m.role === 'assistant' && m.content === 'all done'),
    { timeout: 20_000, what: 'the resumed turn finished' })
  const told = up.requests.flatMap(r => r.messages.filter(m => m.role === 'tool').map(m => m.content))
  a.ok(told.some(t => /POST .*\/charge\) was started before the server restarted and may or may not have finished/.test(t)),
    'the resumed turn was told the outcome is unknown, not given a second charge')
  a.equal(charges.length, 2, 'one charge before the restart, one deliberate retry after checking — not three')
  a.ok(charges[0].key && charges[0].key === charges[1].key, 'the retry carried the same Idempotency-Key')
  a.equal((await s.sql(`select count(*)::int as n from effects where run = $1`, [`front:${session}`]))[0].n, 0,
    'a turn that ended normally leaves no log behind')
})

test('a call that finished before the restart answers from the log; in a later turn it runs again', async () => {
  const bot = await s.agent(up, { name: 'Ops' })
  up.on(r => r.toolResults.length ? { text: `result: ${r.toolResults[0]}` }
    : /deploy/.test(r.lastUser) ? { tool: ['bash', { command: 'deploy --prod' }] } : { text: 'hi' })
  const hello = await s.chat({ agent: bot }, 'hello')
  const run = `front:${hello.session}`
  // As if a turn of this session had run it, and the server died before that step was saved.
  await s.sql(`insert into effects (run, call_key, name, boot, status, result, idem) values ($1, $2, 'bash', 'an-earlier-process', 'done', 'deployed v42', 'k')`,
    [run, callKey('bash', { command: 'deploy --prod' })])
  const again = await s.chat({ agent: bot }, 'deploy it', { session: hello.session })
  a.match(again.text, /deploy --prod\) already ran before the server restarted[\s\S]*deployed v42/)
  const later = await s.chat({ agent: bot }, 'deploy it once more', { session: hello.session })
  a.match(later.text, /ran: .*deploy --prod/, 'the log was used once; a call made again afterwards runs')
})
