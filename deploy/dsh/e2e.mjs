// End-to-end check of DeepSeek Harness and the Keys panel through a RUNNING compose deployment,
// with a fake DeepSeek (Chat Completions) and a fake Seedance standing in for the real ones.
// It asserts on artifacts — transcript rows, usage rows, what the upstream was actually sent,
// processes left in the dsh container — not on what an agent says it did (CLAUDE.md 2.14).
//
//   node deploy/dsh/e2e.mjs <deployment dir>        (the deployment must be up: ./start.sh)
//
// The fakes listen on the host; containers reach them at the compose network's gateway.
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const DIR = process.argv[2] ?? '.'
const ENV = Object.fromEntries(readFileSync(join(DIR, '.env'), 'utf8').split('\n').map(l => l.match(/^(\w+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2]]))
const APP = `http://127.0.0.1:${ENV.WEB_PORT || 8080}`
const K = ENV.ACCESS_TOKEN
const RUN = Date.now().toString(36).slice(-5)
const DS_PORT = 18901, SD_PORT = 18902
const DSH = `${ENV.AGENT_PREFIX || 'ma'}-dsh`
const sleep = ms => new Promise(r => setTimeout(r, ms))
const gw = execFileSync('docker', ['network', 'inspect', `${ENV.COMPOSE_PROJECT_NAME || 'multi-agent'}_default`, '-f', '{{(index .IPAM.Config 0).Gateway}}']).toString().trim()

// ---- the fake DeepSeek: scripted by a marker in the newest user message ----
const seen = []    // one entry per model request
let hold = null    // SLOW: the request we never answer
const ds = createServer(async (req, res) => {
  let b = ''; for await (const c of req) b += c
  if (req.method === 'GET' && req.url === '/models') {
    res.writeHead(req.headers.authorization === `Bearer sk-e2e-${RUN}wxyz` ? 200 : 401, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ object: 'list', data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }, { id: 'other-model' }] }))
  }
  const body = JSON.parse(b || '{}')
  const msgs = body.messages ?? []
  const user = [...msgs].reverse().find(m => m.role === 'user')
  const userText = typeof user?.content === 'string' ? user.content : (user?.content ?? []).map(p => p.text ?? '').join('')
  const system = msgs.find(m => m.role === 'system')?.content ?? ''
  const tools = msgs.filter(m => m.role === 'tool')
  seen.push({ auth: req.headers.authorization, model: body.model, tools: (body.tools ?? []).map(t => t.function.name), system, userText, toolCount: tools.length,
    effort: body.reasoning_effort, thinking: body.thinking?.type })
  const sse = frames => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const f of frames) res.write(`data: ${JSON.stringify(f)}\n\n`)
    res.end('data: [DONE]\n\n')
  }
  const usage = (p, c) => ({ id: 'u', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: p, completion_tokens: c, total_tokens: p + c } })
  const say = text => sse([{ id: 'x', choices: [{ index: 0, delta: { role: 'assistant', content: text } }] }, usage(150, 5)])
  const call = (name, args, text = '') => sse([{ id: 'x', choices: [{ index: 0, delta: { role: 'assistant', content: text,
    tool_calls: [{ index: 0, id: `call_${seen.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] },
  { id: 'x', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }])
  const last = userText.split('--- The new message ---').at(-1)
  if (last.includes('FAIL401')) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'Authentication Fails, Your api key is invalid', type: 'authentication_error' } })) }
  if (last.includes('SLOW')) { hold = res; return }
  if (last.includes('LOOP')) return call('mcp__platform__studio', { action: 'project.list' }, 'again')
  if (last.includes('TOOLTEST')) return tools.length ? say(`项目：${String(tools.at(-1).content).slice(0, 80)}`)
    : call('mcp__platform__studio', { action: 'project.list' }, '我查一下。')
  if (userText.includes('HANDOFF')) {
    if (system.includes('ROLE:lead')) return say(`好的，分一下工。\n@深B${RUN}`)
    return say('收尾完成。')
  }
  return say(`收到：${last.trim().slice(-20)}`)
})
// ---- a fake Seedance, only for the Keys panel's Test (it lists tasks) ----
const sdAuth = []
const sd = createServer((req, res) => {
  sdAuth.push({ url: req.url, auth: req.headers.authorization })
  res.writeHead(req.headers.authorization === `Bearer panel-sd-${RUN}` ? 200 : 401, { 'content-type': 'application/json' })
  res.end('{"items":[],"total":0}')
})
await new Promise(r => ds.listen(DS_PORT, '0.0.0.0', r))
await new Promise(r => sd.listen(SD_PORT, '0.0.0.0', r))

// ---- helpers ----
const api = async (method, path, body) => {
  const r = await fetch(`${APP}${path}${path.includes('?') ? '&' : '?'}k=${K}`, { method, headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await r.text()
  let j; try { j = JSON.parse(text) } catch { j = text }
  return { status: r.status, body: j, text }
}
const ok = async (...a) => { const r = await api(...a); assert.ok(r.status < 300, `${a[0]} ${a[1]} → ${r.status} ${r.text}`); return r.body }
/** Send a message and collect the stream's events. */
async function chat(target, text, { signal } = {}) {
  const r = await fetch(`${APP}/api/chat?k=${K}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target, text }), signal })
  const raw = await r.text()
  return raw.split('\n\n').filter(Boolean).map(b => ({ ev: b.match(/^event: (.*)$/m)?.[1], d: JSON.parse(b.match(/^data: (.*)$/m)?.[1] ?? 'null') }))
}
const since = n => seen.slice(n)
const dshProcs = () => execFileSync('docker', ['exec', DSH, 'sh', '-c',
  // (skipping itself: its own command line says run.mjs — the pkill -f trap of 2.9.5)
  'for p in /proc/[0-9]*; do [ "${p#/proc/}" = "$$" ] && continue; c=$(tr "\\0" " " < $p/cmdline 2>/dev/null); case "$c" in *run.mjs*|*bin.js*) echo "$c";; esac; done; ls /tmp/dsh 2>/dev/null']).toString().trim()
const studioAs = (actor, action, args) => JSON.parse(execFileSync('docker', ['compose', 'exec', '-T',
  '-e', `A=${JSON.stringify({ action, args })}`, '-e', `ACTOR=${actor}`, 'app', 'node', '-e',
  `fetch(process.env.STUDIO_URL+'/v1/call',{method:'POST',headers:{authorization:'Bearer '+process.env.STUDIO_TOKEN,'x-studio-actor':process.env.ACTOR},body:process.env.A}).then(r=>r.json()).then(j=>process.stdout.write(JSON.stringify(j)))`],
{ cwd: DIR }).toString())
const psql = sql => execFileSync('docker', ['compose', 'exec', '-T', 'db', 'psql', '-U', 'multiagent', '-d', 'multiagent', '-tAc', sql], { cwd: DIR }).toString().trim()

try {
  // ======== Keys panel: DeepSeek ========
  assert.equal((await ok('GET', '/api/keys/deepseek')).harness, true, 'the deployment has a harness')
  const key = `sk-e2e-${RUN}wxyz`
  const put = await api('PUT', '/api/keys/deepseek', { base_url: `http://${gw}:${DS_PORT}/`, api_key: key })
  assert.equal(put.status, 200)
  assert.deepEqual(put.body, { base_url: `http://${gw}:${DS_PORT}`, set: true, hint: '••••wxyz', harness: true })
  assert.ok(!put.text.includes(key) && !(await api('GET', '/api/keys/deepseek')).text.includes(key), 'the key never comes back')
  await ok('PUT', '/api/keys/deepseek', { api_key: '' })
  assert.equal((await ok('GET', '/api/keys/deepseek')).hint, '••••wxyz', 'an empty key box keeps the key')
  const test = await ok('POST', '/api/keys/deepseek/test')
  assert.equal(test.ok, true, JSON.stringify(test))
  assert.deepEqual(test.models, ['deepseek-chat', 'deepseek-reasoner'], 'only the DeepSeek models are listed')
  assert.equal(test.harness.ok, true); assert.match(test.harness.message, /0\.1\.5-rc\.3/)
  assert.equal((await api('PUT', '/api/keys/deepseek', { base_url: 'ftp://x' })).status, 400)

  // ======== Keys panel: the studio's keys (stored in the studio, not the platform) ========
  const view0 = await ok('POST', '/api/studio/call', { action: 'keys.get' })
  assert.deepEqual(view0.map(k => k.name), ['seedance', 'gpt_image', 'comfy'])
  const sdKey = `panel-sd-${RUN}`
  const set = await ok('POST', '/api/studio/call', { action: 'keys.set', args: { name: 'seedance', values: { base_url: `http://${gw}:${SD_PORT}`, api_key: sdKey } } })
  assert.deepEqual(set.fields.api_key, { source: 'panel', env: 'SEEDANCE_API_KEY', hint: `••••${sdKey.slice(-4)}` })
  const sdTest = await ok('POST', '/api/studio/call', { action: 'keys.test', args: { name: 'seedance' } })
  assert.equal(sdTest.ok, true, JSON.stringify(sdTest)); assert.equal(sdTest.code, 'ok')
  assert.equal(sdAuth.at(-1).auth, `Bearer ${sdKey}`, 'the adapter used the key typed into the panel')
  assert.equal(psql(`select count(*) from studio.config where key = 'seedance.api_key'`), '1', 'stored in the studio\'s own table')
  assert.equal(psql(`select count(*) from settings where value::text like '%${sdKey}%'`), '0', 'and nowhere in the platform')
  // An agent can't read even a hint (any agent id: roles refuse keys.* before looking at the role).
  const refused = studioAs('agent:someone', 'keys.get', {})
  assert.equal(refused.ok, false); assert.equal(refused.error.code, 'forbidden')
  await ok('POST', '/api/studio/call', { action: 'keys.set', args: { name: 'seedance', values: { base_url: '' }, clear: ['api_key'] } })
  const back = (await ok('POST', '/api/studio/call', { action: 'keys.get' })).find(k => k.name === 'seedance')
  assert.equal(back.fields.api_key.source, ENV.SEEDANCE_API_KEY ? 'env' : 'none', 'cleared: back to .env')
  assert.equal(psql(`select count(*) from studio.audit where detail like '%${sdKey}%' or target like '%${sdKey}%'`), '0', 'the audit never holds a key')
  assert.ok(Number(psql(`select count(*) from studio.audit where action = 'keys.set' and target = 'seedance'`)) >= 2)
  assert.equal((await api('POST', '/api/studio/call', { action: 'keys.set', args: { name: 'seedance', values: { base_url: 'nope' } } })).status, 400)

  // ======== DeepSeek agents ========
  const prov = await ok('POST', '/api/providers', { name: `ds-${RUN}`, base_url: `http://${gw}:${DS_PORT}`, api_key: `sk-upstream-${RUN}`, protocol: 'chat',
    auto_context: false, context_tokens: 64000, price_in_micro: 1_000_000, price_out_micro: 2_000_000 })
  const mk = async (id, name, role) => ok('POST', '/api/bots', { id: `${id}-${RUN}`, name: `${name}${RUN}`, persona: `你是${name}。ROLE:${role}`, provider_id: prov.id, model: 'deepseek-chat' })
  const A = (await mk('dsa', '深A', 'lead')).id, B = (await mk('dsb', '深B', 'b')).id
  // On the crew, so it has a tool (AGENT_TOOLS may be off): the studio tool.
  await ok('POST', '/api/studio/call', { action: 'crew.set', args: { agent_id: A, role: 'director' } })

  // -- one turn with a tool --
  let n = seen.length
  const ev1 = await chat({ type: 'agent', id: A }, 'TOOLTEST 列出项目')
  assert.ok(!ev1.some(e => e.ev === 'error'), JSON.stringify(ev1.filter(e => e.ev === 'error')))
  const turn1 = since(n)
  assert.equal(turn1.length, 2, 'a tool step, then the answer')
  for (const s of turn1) {
    assert.equal(s.auth, `Bearer ${key}`, 'the Keys panel\'s key, not the upstream\'s')
    assert.equal(s.model, 'deepseek-chat')
    assert.deepEqual(s.tools, ['mcp__platform__studio'], 'the platform\'s tools and nothing of dsh\'s own')
    assert.ok(s.system.startsWith(`你是深A。ROLE:lead`), 'the persona is the system prompt')
    assert.match(s.system, /--- Tool names ---/)
    assert.doesNotMatch(s.system, /deepseek harness|dsh/i, 'no harness identity in the prompt')
  }
  assert.equal(turn1[0].userText, 'TOOLTEST 列出项目', 'a first message goes as it is')
  assert.equal(turn1[0].effort, 'high', 'no effort set: dsh\'s own default (thinking, high) — see CLAUDE.md')
  const tools1 = ev1.filter(e => e.ev === 'tool')
  assert.deepEqual(tools1.map(e => e.d.phase), ['run', 'done'])
  assert.equal(tools1[0].d.name, 'studio')
  const deltas = ev1.filter(e => e.ev === 'delta').map(e => e.d.text)
  assert.deepEqual(deltas.slice(0, 1), ['我查一下。'])
  assert.ok(ev1.findIndex(e => e.ev === 'delta') < ev1.findIndex(e => e.ev === 'tool'), 'the words that announce a tool come before its card')
  const dm1 = await ok('GET', `/api/dm/${A}`)
  assert.deepEqual(dm1.map(m => m.role), ['user', 'tool', 'assistant'], 'question, tool, answer — in that order')
  assert.equal(dm1[1].name, 'studio'); assert.deepEqual(dm1[1].args, { action: 'project.list' })
  assert.match(dm1[2].content, /^项目：/)
  const u1 = (await ok('GET', '/api/usage')).agents.find(a => a.id === A)
  assert.deepEqual({ calls: u1.day.calls, tokens: u1.day.tokens, cost: u1.day.cost_micro }, { calls: 2, tokens: 265, cost: 280 },
    'one usage row per model call, priced with the upstream\'s prices')

  // -- history travels inside the one message --
  n = seen.length
  await chat({ type: 'agent', id: A }, 'HELLO again')
  const h = since(n)[0].userText
  assert.match(h, /^The conversation so far/)
  assert.match(h, /\[User\] TOOLTEST 列出项目\n\n\[You\] 项目：/)
  assert.match(h, /--- The new message ---\n\[User\] HELLO again$/)

  // -- effort: medium → high, high → max --
  await ok('PATCH', `/api/bots/${A}`, { effort: 'high' })
  n = seen.length
  await chat({ type: 'agent', id: A }, 'effort check')
  assert.equal(since(n)[0].effort, 'max'); assert.equal(since(n)[0].thinking, 'enabled')
  await ok('PATCH', `/api/bots/${A}`, { effort: '' })

  // -- the upstream refusing --
  const ev2 = await chat({ type: 'agent', id: A }, 'FAIL401')
  const err2 = ev2.find(e => e.ev === 'error')
  assert.ok(err2, 'a refused call is an error, not a silent empty turn')
  assert.match(err2.d.message, /401/); assert.match(err2.d.message, /Authentication Fails/)
  assert.equal((await ok('GET', `/api/dm/${A}`)).at(-1).content, 'FAIL401', 'no answer stored for it')

  // -- max_steps: it stops after N model calls --
  await ok('PATCH', `/api/bots/${A}`, { max_steps: 2 })
  n = seen.length
  const tBefore = (await ok('GET', `/api/dm/${A}`)).filter(m => m.role === 'tool').length
  await chat({ type: 'agent', id: A }, 'LOOP')
  const dm3 = await ok('GET', `/api/dm/${A}`)
  assert.equal(dm3.filter(m => m.role === 'tool').length - tBefore, 2, 'two steps\' tools ran, no more')
  assert.ok(since(n).length <= 3, `at most the third call started before it was stopped (${since(n).length})`)
  assert.equal(dm3.at(-1).role, 'assistant'); assert.match(dm3.at(-1).content, /again|tool-use limit/)
  await ok('PATCH', `/api/bots/${A}`, { max_steps: null })
  await sleep(1500)
  assert.equal(dshProcs(), '', 'the stopped runtime is gone')

  // -- the daily cap: checked before a turn and before every tool call --
  const spent = (await ok('GET', '/api/usage')).agents.find(a => a.id === A).day.cost_micro
  await ok('PATCH', `/api/bots/${A}`, { daily_cap_micro: spent + 1 })
  n = seen.length
  const ev4 = await chat({ type: 'agent', id: A }, 'LOOP')
  assert.equal(since(n).length, 1, 'the call that crossed the cap is the last one')
  assert.equal(ev4.find(e => e.ev === 'error')?.d.capped, true)
  n = seen.length
  const ev5 = await chat({ type: 'agent', id: A }, 'LOOP')
  assert.equal(since(n).length, 0, 'over the cap: no runtime, no call')
  assert.equal(ev5.find(e => e.ev === 'error')?.d.capped, true)
  await ok('PATCH', `/api/bots/${A}`, { daily_cap_micro: null })

  // -- hanging up ends the runtime --
  const ac = new AbortController()
  const slow = chat({ type: 'agent', id: B }, 'SLOW', { signal: ac.signal }).catch(e => e)
  for (let i = 0; i < 150 && !hold; i++) await sleep(100)
  assert.ok(hold, 'the slow call reached the upstream')
  assert.match(dshProcs(), /run\.mjs/, 'a runtime is working on it')
  ac.abort()
  await slow
  for (let i = 0; i < 50 && dshProcs(); i++) await sleep(200)
  assert.equal(dshProcs(), '', 'the page closing ended the runtime and its /tmp/dsh')
  assert.equal((await ok('GET', `/api/dm/${B}`)).filter(m => m.role === 'assistant').length, 0, 'and nothing was stored as its answer')
  hold.destroy(); hold = null

  // ======== a group relay between two DeepSeek agents ========
  const g = await ok('POST', '/api/groups', { name: `深组${RUN}`, members: [A, B], lead: A })
  n = seen.length
  const evg = await chat({ type: 'group', id: g.id }, 'HANDOFF 开始')
  assert.ok(!evg.some(e => e.ev === 'error'), JSON.stringify(evg.filter(e => e.ev === 'error')))
  const log = await ok('GET', `/api/groups/${g.id}/messages`)
  assert.deepEqual(log.slice(-3).map(m => [m.role, m.speaker ?? '']).slice(1), [['assistant', `深A${RUN}`], ['assistant', `深B${RUN}`]], 'A hands off, B finishes')
  assert.equal(log.at(-3).text, 'HANDOFF 开始')
  assert.match(log.at(-2).text, /@深B/)
  assert.equal(log.at(-1).text, '收尾完成。')
  const bPrompt = since(n).find(s => s.system.includes('ROLE:b')).userText
  assert.match(bPrompt, /HANDOFF 开始/, 'B sees what the user said')
  assert.match(bPrompt, new RegExp(`--- The new message ---\\n\\[深A${RUN}\\] 好的`), 'and A\'s handoff as the new message')

  // -- no key in the panel: the agent's own upstream key, since that upstream speaks Chat Completions --
  await ok('PUT', '/api/keys/deepseek', { clear: true })
  assert.equal((await ok('GET', '/api/keys/deepseek')).set, false)
  n = seen.length
  const evu = await chat({ type: 'agent', id: A }, 'upstream key please')
  assert.ok(!evu.some(e => e.ev === 'error'), JSON.stringify(evu.filter(e => e.ev === 'error')))
  assert.equal(since(n)[0].auth, `Bearer sk-upstream-${RUN}`, 'the fallback is the upstream\'s key')
  await ok('PUT', '/api/keys/deepseek', { api_key: key })

  // ======== the MCP door ========
  const noToken = execFileSync('docker', ['exec', DSH, 'node', '-e',
    `fetch('http://app:8081/mcp',{method:'POST',headers:{authorization:'Bearer nope','content-type':'application/json'},body:'{"jsonrpc":"2.0","id":1,"method":"tools/list"}'}).then(r=>console.log(r.status))`]).toString().trim()
  assert.equal(noToken, '401', 'a token that serves no turn opens nothing')
  const published = await fetch('http://127.0.0.1:8081/mcp', { method: 'POST', signal: AbortSignal.timeout(3000) }).then(r => r.status).catch(() => 'closed')
  assert.equal(published, 'closed', 'the MCP port is not published on the host')

  await sleep(1000)
  assert.equal(dshProcs(), '', 'no runtime left behind, no /tmp/dsh left behind')
  console.log('dsh e2e: all checks passed')
} finally {
  hold?.destroy?.()
  ds.close(); sd.close()
}
