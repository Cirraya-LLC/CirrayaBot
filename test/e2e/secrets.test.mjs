// Secrets: an agent uses a credential by name and its model never sees the value — not in a request
// to the model, not in a tool result, not in the stored transcript, not in the database in the clear.
import { test, before, after } from 'node:test'
import { strict as a } from 'node:assert'
import { createServer } from 'node:https'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { startStack } from './stack.mjs'
import { fakeUpstream } from './fake-upstream.mjs'

const pg = createRequire(new URL('../../web/package.json', import.meta.url))('pg')
const VALUE = 'ghp_TopSecretValue_42'

// An API on this machine, over https with a certificate made here and trusted by the server only.
// It answers with the headers it got — exactly the kind of echo that must not reach the model.
let api, apiUrl, certFile, s, up
const got = []
before(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ma-cert-'))
  certFile = join(dir, 'c.pem')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'k.pem'), '-out', certFile,
    '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' })
  api = createServer({ key: readFileSync(join(dir, 'k.pem')), cert: readFileSync(certFile) }, (req, res) => {
    got.push({ method: req.method, url: req.url, auth: req.headers.authorization ?? null })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ you_sent: req.headers.authorization ?? null, path: req.url }))
  })
  await new Promise(ok => api.listen(0, '127.0.0.1', ok))
  apiUrl = `https://localhost:${api.address().port}`
  up = await fakeUpstream()
  // The API is on this machine, which is exactly what http_request refuses — unless the operator says so.
  s = await startStack({ tools: true, env: { HTTP_REQUEST_ALLOW: apiUrl, NODE_EXTRA_CA_CERTS: certFile } })
})
after(async () => { await s?.close(); await up?.close(); api?.close() })

const allModelTraffic = () => JSON.stringify(up.requests.map(r => r.body))
const card = (r, phase) => r.events.find(e => e.ev === 'tool' && e.data.phase === phase)?.data

test('a secret added by the person is used by name, and never shown to the model', async () => {
  const bot = await s.agent(up, { name: 'Sec' })
  const add = await s.api('POST', `/api/bots/${bot}/secrets`, { name: 'API_TOKEN', origin: apiUrl, value: VALUE })
  a.equal(add.status, 200, JSON.stringify(add.body))
  a.equal(add.body.value_enc, undefined)
  const list = (await s.api('GET', `/api/bots/${bot}/secrets`)).body
  a.deepEqual(list.map(x => [x.name, x.kind, x.origin, x.header]), [['API_TOKEN', 'header', apiUrl, 'Authorization']])
  a.ok(!JSON.stringify(list).includes(VALUE))

  let sys = ''
  up.on(r => {
    sys = r.system
    return r.toolResults.length ? { text: `api said: ${r.toolResults[0]}` }
      : { tool: ['http_request', { url: `${apiUrl}/user`, secret: 'API_TOKEN' }] }
  })
  const r = await s.chat({ agent: bot }, 'who am I on the API?')
  a.equal(got.at(-1).auth, `Bearer ${VALUE}`, 'the API got the credential')
  a.match(r.text, /\[secret API_TOKEN\]/, 'the echo was masked before the model read it')
  a.match(sys, /API_TOKEN: sent as the Authorization header to https:\/\/localhost/)
  a.ok(!allModelTraffic().includes(VALUE), 'the value never went to the model')
  const rows = await s.history(bot, r.session)
  a.ok(!JSON.stringify(rows).includes(VALUE), 'nor into the stored transcript')

  const c = new pg.Client({ connectionString: s.db }); await c.connect()
  const enc = (await c.query('select value_enc from secrets where name = $1', ['API_TOKEN'])).rows[0].value_enc
  await c.end()
  a.ok(enc && !enc.includes(VALUE) && !Buffer.from(enc, 'base64').toString('latin1').includes(VALUE), 'sealed at rest')
})

test('a secret goes only to its own site; internal addresses are refused', async () => {
  const bot = await s.agent(up, { name: 'Leak' })
  await s.api('POST', `/api/bots/${bot}/secrets`, { name: 'API_TOKEN', origin: apiUrl, value: VALUE })
  const before = got.length
  const tryOnce = async args => {
    up.on(r => r.toolResults.length ? { text: r.toolResults[0] } : { tool: ['http_request', args] })
    return (await s.chat({ agent: bot }, 'go')).text
  }
  a.match(await tryOnce({ url: 'https://example.com/steal', secret: 'API_TOKEN' }), /may only be sent to https:\/\/localhost/)
  a.match(await tryOnce({ url: `https://127.0.0.1:${api.address().port}/x` }), /internal address/)
  a.match(await tryOnce({ url: 'https://169.254.169.254/latest/meta-data/' }), /internal address/)
  a.match(await tryOnce({ url: `http://localhost:${api.address().port}/` }), /only https/)
  a.match(await tryOnce({ url: `${apiUrl}/x`, secret: 'NOPE' }), /no secret called "NOPE"/)
  a.equal(got.length, before, 'none of these reached anything')
})

test('the agent asks for a credential on a card; the value goes straight into the store', async () => {
  const bot = await s.agent(up, { name: 'Ask' })
  up.on(r => {
    if (r.toolResults.length) return { text: `result: ${r.toolResults.at(-1)}` }
    return { tool: ['request_secret', { name: 'SVC_KEY', purpose: 'to read your issues', origin: apiUrl }] }
  })
  const r = await s.chat({ agent: bot }, 'read my issues', {
    onEvent: (ev, d) => ev === 'tool' && d.phase === 'secret' && s.api('POST', `/api/secrets/requests/${d.id}`, { value: VALUE }) })
  const asked = card(r, 'secret')
  a.deepEqual([asked.name, asked.origin, asked.purpose], ['SVC_KEY', apiUrl, 'to read your issues'])
  a.match(r.text, /Saved as SVC_KEY/)
  a.equal(card(r, 'secret_done').ok, true)
  a.deepEqual((await s.api('GET', `/api/bots/${bot}/secrets`)).body.map(x => x.name), ['SVC_KEY'])
  a.ok(!allModelTraffic().includes(VALUE))

  const no = await s.chat({ agent: bot }, 'again', {
    onEvent: (ev, d) => ev === 'tool' && d.phase === 'secret' && s.api('POST', `/api/secrets/requests/${d.id}`, { decline: true }) })
  a.match(no.text, /did not give it/)
})

test('whatever a command prints of a secret is masked', async () => {
  const bot = await s.agent(up, { name: 'Echo' })
  await s.api('POST', `/api/bots/${bot}/secrets`, { name: 'API_TOKEN', origin: apiUrl, value: VALUE })
  // The fake container echoes the command — as if a script had printed the token.
  up.on(r => r.toolResults.length ? { text: r.toolResults[0] } : { tool: ['bash', { command: `echo ${VALUE}` }] })
  const r = await s.chat({ agent: bot }, 'print it')
  a.ok(!r.text.includes(VALUE) && r.text.includes('[secret API_TOKEN]'), r.text)
})

test('checked on the way in; a background task has no request_secret; deleting works', async () => {
  const bot = await s.agent(up, { name: 'Chk' })
  const bad = async b => (await s.api('POST', `/api/bots/${bot}/secrets`, b))
  const plain = await bad({ name: 'K', origin: 'http://insecure.example', value: 'v' })
  a.equal(plain.status, 400); a.match(plain.body.error, /https site/)
  a.equal((await bad({ name: '9x', origin: apiUrl, value: 'v' })).status, 400)
  a.equal((await bad({ name: 'K', origin: apiUrl })).status, 400)
  const ok = (await bad({ name: 'K', origin: apiUrl, value: 'v', kind: 'login' })).body
  a.equal((await s.api('DELETE', `/api/bots/${bot}/secrets/${ok.id}`)).status, 200)
  a.equal((await s.api('DELETE', `/api/bots/${bot}/secrets/${ok.id}`)).status, 404)

  let taskTools = null
  up.on(r => {
    if (r.system.includes('--- You are working on a background task ---')) { taskTools = r.tools; return { tool: ['finish_task', { result: 'ok' }] } }
    if (r.lastUser.includes('[Platform]')) return { text: 'done' }
    return r.toolResults.length ? { text: 'started' } : { tool: ['start_task', { title: 't', brief: 'b' }] }
  })
  await s.chat({ agent: bot }, 'do it in the background')
  await s.until(() => taskTools, { what: 'the task to run' })
  a.ok(!taskTools.includes('request_secret') && taskTools.includes('http_request'))
})
