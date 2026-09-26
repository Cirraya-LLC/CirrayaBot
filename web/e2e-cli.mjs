// End-to-end: crew members running on the three coding CLIs — the REAL Claude Code, Codex and
// Grok Build binaries in the running deployment's cli container — with a scripted fake model
// upstream standing in for Anthropic / OpenAI / xAI, since no account can sign in here.
//
// For each CLI: a DM asks the agent to run a command → the CLI calls our `bash` over MCP → it runs
// in the AGENT'S OWN container (its hostname comes back, not the cli container's) → the answer
// streams back and is stored with the tool row between question and answer. And:
//   - what the model was sent: our tools and nothing of the CLI's own that touches a machine,
//     our persona as the system prompt, no CLAUDE.md text;
//   - the approval gate: a risky command asks first; "deny" goes back to the CLI as the result;
//   - a usage row per turn; hanging up kills the CLI inside the container;
//   - /mcp without the turn's token lists nothing and runs nothing;
//   - signing in: Codex's device flow shows its page and code in the UI, and can be cancelled.
//
// The deployment needs MODULES with cli, AGENT_TOOLS=on (any small AGENT_IMAGE with bash will do,
// e.g. node:24-slim), and — Claude Code has no config file we let it read — in
// docker-compose.override.yml for the cli service:
//   environment: { ANTHROPIC_BASE_URL: http://host.docker.internal:18780, ANTHROPIC_API_KEY: sk-e2e }
// Codex and Grok are pointed at the fake through their own config files in the shared home, which
// this script writes and removes.
//
//   node web/e2e-cli.mjs <deployment dir>
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const DIR = process.argv[2] ?? '.'
const ENV = Object.fromEntries(readFileSync(join(DIR, '.env'), 'utf8').split('\n').map(l => l.match(/^(\w+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2]]))
const APP = `http://127.0.0.1:${ENV.WEB_PORT || 8080}`
const K = ENV.ACCESS_TOKEN
const CLI = ENV.CLI_CONTAINER
const PORT = 18780
const RUN = Date.now().toString(36).slice(-5)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a)
const sh = (...argv) => execFileSync('docker', argv, { encoding: 'utf8' })
assert.ok(CLI, 'CLI_CONTAINER is empty: add cli to MODULES and rerun ./start.sh')
assert.equal(ENV.AGENT_TOOLS, 'on', 'this test runs bash in the agent\'s own container: AGENT_TOOLS=on')

// ---------- the fake upstream: three wire formats, one script ----------
// The newest "RUN:<command>" in what the model was sent is the command it asks for; once the tool
// result is back it answers "tool said: …". "SLEEP" makes it hang (for the hang-up test).
const seen = { messages: [], responses: [], chat: [] }
const hanging = []
const lastRun = body => { const m = [...JSON.stringify(body).matchAll(/RUN:([^"\\]+)/g)].pop(); return m?.[1].trim() }
const sse = (res, frames, named = true) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const [ev, d] of frames) res.write(`${named && ev ? `event: ${ev}\n` : ''}data: ${typeof d === 'string' ? d : JSON.stringify(d)}\n\n`)
  res.end()
}
const fake = createServer((req, res) => {
  let b = ''
  req.on('data', d => { b += d })
  req.on('end', () => {
    let j = {}
    try { j = JSON.parse(b) } catch {}
    if (req.method === 'GET' && req.url.includes('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake', object: 'model', created: 1, owned_by: 'e2e' }] }))
    }
    if (/SLEEP/.test(b) && !/tool said/.test(b)) { hanging.push(res); return }
    const cmd = lastRun(j)
    if (req.url.startsWith('/v1/messages')) {
      if (req.url.includes('count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"input_tokens":10}') }
      seen.messages.push(j)
      const last = j.messages?.at(-1)
      const result = Array.isArray(last?.content) && last.content.find(c => c.type === 'tool_result')
      const tool = (j.tools ?? []).find(t => /bash$/.test(t.name))
      const start = ['message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: j.model, content: [], stop_reason: null, usage: { input_tokens: 100, output_tokens: 1 } } }]
      const end = reason => [['message_delta', { type: 'message_delta', delta: { stop_reason: reason }, usage: { output_tokens: 7 } }], ['message_stop', { type: 'message_stop' }]]
      if (tool && cmd && !result) return sse(res, [start,
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu' + seen.messages.length, name: tool.name, input: {} } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command: cmd }) } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }], ...end('tool_use')])
      const said = result ? `tool said: ${JSON.stringify(result.content)}` : 'hello from fake claude'
      return sse(res, [start,
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: said.slice(0, 20) } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: said.slice(20) } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }], ...end('end_turn')])
    }
    if (req.url.includes('/responses')) {
      seen.responses.push(j)
      const out = Array.isArray(j.input) && [...j.input].reverse().find(x => x.type === 'function_call_output')
      const lastUser = Array.isArray(j.input) && [...j.input].reverse().findIndex(x => x.role === 'user')
      const outIdx = Array.isArray(j.input) && [...j.input].reverse().findIndex(x => x.type === 'function_call_output')
      const answered = out && outIdx < lastUser
      const ns = (j.tools ?? []).find(t => t.type === 'namespace' && t.tools?.some(x => x.name === 'bash'))
      const usage = { input_tokens: 100, output_tokens: 7, total_tokens: 107 }
      if (ns && cmd && !answered) {
        const item = { type: 'function_call', id: 'fc1', call_id: 'call' + seen.responses.length, namespace: ns.name, name: 'bash', arguments: JSON.stringify({ command: cmd }), status: 'completed' }
        return sse(res, [['response.created', { type: 'response.created', response: { id: 'r', status: 'in_progress', output: [] } }],
          ['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item }],
          ['response.completed', { type: 'response.completed', response: { id: 'r', status: 'completed', output: [item], usage } }]])
      }
      const text = answered ? `tool said: ${JSON.stringify(out.output)}` : 'hello from fake codex'
      const item = { type: 'message', id: 'msg1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }
      return sse(res, [['response.created', { type: 'response.created', response: { id: 'r', status: 'in_progress', output: [] } }],
        ['response.output_text.delta', { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: 'msg1', delta: text }],
        ['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item }],
        ['response.completed', { type: 'response.completed', response: { id: 'r', status: 'completed', output: [item], usage } }]])
    }
    if (req.url.includes('/chat/completions')) {
      seen.chat.push(j)
      const base = { id: 'c', object: 'chat.completion.chunk', created: 1, model: j.model }
      const names = (j.tools ?? []).map(t => t.function?.name)
      const msgs = j.messages ?? []
      const since = msgs.slice(msgs.findLastIndex(m => m.role === 'user' && /RUN:|SLEEP|hello/.test(JSON.stringify(m.content))) + 1)
      const tools = since.filter(m => m.role === 'tool')
      const call = (name, args) => sse(res, [[null, { ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call' + seen.chat.length, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }],
        [null, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 100, completion_tokens: 7, total_tokens: 107 } }], [null, '[DONE]']], false)
      if (names.includes('use_tool') && cmd && tools.length === 0) return call('search_tool', { query: 'bash' })
      if (names.includes('use_tool') && cmd && tools.length === 1) return call('use_tool', { tool_name: 'cirrayabot__bash', tool_input: { command: cmd } })
      const text = tools.length ? `tool said: ${JSON.stringify(tools.at(-1).content)}` : 'hello from fake grok'
      return sse(res, [[null, { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: text } }] }],
        [null, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 7, total_tokens: 107 } }], [null, '[DONE]']], false)
    }
    res.writeHead(404); res.end('{}')
  })
})
await new Promise(r => fake.listen(PORT, '0.0.0.0', r))

// ---------- the platform ----------
const api = async (method, path, body) => {
  const r = await fetch(`${APP}${path}${path.includes('?') ? '&' : '?'}k=${K}`, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) })
  const text = await r.text()
  let j = null
  try { j = JSON.parse(text) } catch {}
  return { status: r.status, body: j ?? text }
}
/** One DM, read to the end. `onEvent` may answer approvals; `hangUpAfter` closes the stream early. */
async function chat(agentId, text, { onEvent, hangUpAfter } = {}) {
  const ac = new AbortController()
  const r = await fetch(`${APP}/api/chat?k=${K}`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target: { type: 'agent', id: agentId }, text }), signal: ac.signal })
  if (!r.ok) return { status: r.status, error: await r.text(), events: [] }
  const events = []
  if (hangUpAfter) setTimeout(() => ac.abort(), hangUpAfter)
  let buf = ''
  try {
    for await (const chunk of r.body) {
      buf += Buffer.from(chunk).toString()
      for (let i; (i = buf.indexOf('\n\n')) >= 0;) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2)
        const ev = block.match(/^event: (.*)$/m)?.[1]
        const data = JSON.parse(block.match(/^data: (.*)$/m)?.[1] ?? '{}')
        events.push({ ev, ...data })
        await onEvent?.({ ev, ...data })
      }
    }
  } catch (e) { if (!ac.signal.aborted) throw e }
  return { status: 200, events, text: events.filter(e => e.ev === 'delta').map(e => e.text).join('') }
}

// Codex and Grok read their upstream from their own config in the shared home.
const CODEX_CFG = `model_provider = "e2e"\n[model_providers.e2e]\nname = "e2e"\nbase_url = "http://host.docker.internal:${PORT}/v1"\nwire_api = "responses"\nexperimental_bearer_token = "sk-e2e"\n`
const GROK_CFG = `[model.fake]\nmodel = "fake"\nbase_url = "http://host.docker.internal:${PORT}/v1"\napi_key = "sk-e2e"\n`
sh('exec', CLI, 'sh', '-c', `mkdir -p ~/.codex ~/.grok && printf %s '${CODEX_CFG}' > ~/.codex/config.toml && printf %s '${GROK_CFG}' > ~/.grok/config.toml`)
const envOfCli = sh('exec', CLI, 'env')
assert.match(envOfCli, /ANTHROPIC_BASE_URL=http:\/\/host\.docker\.internal:18780/, 'set ANTHROPIC_BASE_URL for the cli service (see the top of this file)')

const created = []
let failed = false
try {
  // /mcp without a turn's token: nothing to list, nothing runs
  const bare = await fetch(`${APP}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }).then(r => r.json())
  assert.deepEqual(bare.result.tools, [])
  const forged = await fetch(`${APP}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer nope' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'bash', arguments: { command: 'id' } } }) }).then(r => r.json())
  assert.equal(forged.result.isError, true)
  log('/mcp without a turn token: empty list, calls refused')

  const st = await api('GET', '/api/cli')
  assert.equal(st.body.enabled, true)
  assert.deepEqual(st.body.runtimes.map(r => r.id), ['claude', 'codex', 'grok'])

  // A runtime that isn't one is refused; an agent on a CLI needs no model
  const bad = await api('POST', '/api/bots', { name: `bad-${RUN}`, persona: 'x', model: '', runtime: 'gemini' })
  assert.equal(bad.status, 400)

  for (const [rt, model] of [['claude', ''], ['codex', 'gpt-e2e'], ['grok', 'fake']]) {
    const persona = `You are Probe-${rt}-${RUN}, a careful operator.`
    const mk = await api('POST', '/api/bots', { name: `Probe-${rt}-${RUN}`, persona, model, runtime: rt, approval: 'match' })
    assert.equal(mk.status, 200, JSON.stringify(mk.body))
    const id = mk.body.id
    created.push(id)
    const bot = (await api('GET', '/api/bots')).body.find(b => b.id === id)
    assert.equal(bot.runtime, rt)
    // A client that doesn't know runtimes (the desktop app) can't swap in an upstream's model
    await api('PATCH', `/api/bots/${id}`, { name: bot.name, provider_id: '', model: 'some-upstream-model', effort: 'low' })
    const after = (await api('GET', '/api/bots')).body.find(b => b.id === id)
    assert.deepEqual([after.runtime, after.model, after.effort], [rt, model, 'low'])
    await api('PATCH', `/api/bots/${id}`, { effort: '' })

    // 1. a command, run in the agent's own container
    const before = { m: seen.messages.length, r: seen.responses.length, c: seen.chat.length }
    const t0 = Date.now()
    const turn = await chat(id, 'RUN:hostname')
    assert.equal(turn.status, 200, turn.error)
    const err = turn.events.find(e => e.ev === 'error')
    assert.ok(!err, `${rt}: ${err?.message}`)
    const done = turn.events.find(e => e.ev === 'tool' && e.phase === 'done' && e.name === 'bash')
    assert.ok(done, `${rt}: no bash tool card`)
    const agentHost = sh('exec', `${ENV.AGENT_PREFIX || 'ma'}-agent-${id}`, 'hostname').trim()
    const cliHost = sh('exec', CLI, 'hostname').trim()
    assert.match(done.output, new RegExp(agentHost), `${rt}: ran somewhere else`)
    assert.doesNotMatch(done.output, new RegExp(`^${cliHost}`, 'm'))
    assert.match(turn.text, /tool said: .*exit 0/s, `${rt}: answer was "${turn.text}"`)
    // tool card before the answer's text, like on our own loop
    const firstDelta = turn.events.findIndex(e => e.ev === 'delta')
    assert.ok(turn.events.indexOf(done) < firstDelta, `${rt}: the answer streamed before the tool card`)
    log(`${rt}: bash ran in ${agentHost} (not ${cliHost}), answer streamed in ${Date.now() - t0} ms`)

    const hist = (await api('GET', `/api/dm/${id}`)).body
    const rows = (hist.messages ?? hist).map(m => m.role)
    assert.deepEqual(rows.slice(-3), ['user', 'tool', 'assistant'], `${rt}: transcript ${rows}`)

    // 2. what the model was actually sent
    const sent = rt === 'claude' ? seen.messages.slice(before.m) : rt === 'codex' ? seen.responses.slice(before.r) : seen.chat.slice(before.c)
    assert.ok(sent.length >= 2, `${rt}: ${sent.length} requests`)
    // Grok also asks for a session title on the side, with a tool of its own for that; skip it.
    const main = sent.find(b => JSON.stringify(b).includes('RUN:hostname') && (b.tools ?? []).length
      && !(b.tools ?? []).some(t => t.function?.name === 'session_title'))
    const all = JSON.stringify(sent)
    assert.ok(all.includes(persona), `${rt}: persona not in the system prompt`)
    assert.ok(!all.includes('Unrelated to the parent directory') && !all.includes('# Multi-Agent'), `${rt}: a CLAUDE.md rode along`)
    if (rt === 'claude') {
      assert.ok(main.tools.every(t => t.name.startsWith('mcp__cirrayabot__')), `claude tools: ${main.tools.map(t => t.name)}`)
      assert.ok(main.tools.some(t => t.name === 'mcp__cirrayabot__bash'))
    } else if (rt === 'codex') {
      const own = main.tools.filter(t => t.type !== 'namespace').map(t => t.name ?? t.type)
      assert.deepEqual(own.filter(n => !['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource', 'request_user_input'].includes(n)), [],
        `codex kept tools of its own: ${own}`)
      assert.deepEqual(main.tools.filter(t => t.type === 'namespace').map(t => t.name), ['mcp__cirrayabot'])
      assert.ok(main.instructions.includes(persona), 'codex: our system prompt is not its instructions')
    } else {
      assert.deepEqual(main.tools.map(t => t.function.name).sort(), ['search_tool', 'use_tool'], `grok tools: ${main.tools.map(t => t.function.name)}`)
      assert.equal(main.messages[0].role, 'system'); assert.ok(main.messages[0].content.includes(persona))
    }
    log(`${rt}: the model saw our persona and our tools only`)

    // 3. the approval gate: a risky command asks first; the answer "no" goes back as the result
    let asked = null
    const deny = await chat(id, 'RUN:rm -rf /tmp/e2e-probe', { onEvent: async e => {
      if (e.ev === 'tool' && e.phase === 'ask') { asked = e; await api('POST', `/api/approvals/${e.id}`, { ok: false }) }
    } })
    assert.ok(asked, `${rt}: rm -rf didn't ask`)
    assert.match(deny.text, /Refused by the user/, `${rt}: the refusal didn't reach the model: "${deny.text}"`)
    log(`${rt}: rm -rf asked first; "deny" reached the model as the result`)

    // 4. a usage row, tokens recorded, cost unknown (a subscription has no per-token price)
    const u = execFileSync('docker', ['exec', `${ENV.COMPOSE_PROJECT_NAME || 'multi-agent'}-db-1`, 'psql', '-U', 'multiagent', '-tAc',
      `select provider_id, prompt_tokens > 0, cost_micro is null from usage where agent_id = '${id}' order by id desc limit 1`], { encoding: 'utf8' }).trim()
    assert.equal(u, `cli:${rt}|t|t`)
  }

  // 4b. a group: the Claude member is @-ed, runs a command in its own machine; the log keeps it
  const [cl, cx] = created
  const g = await api('POST', '/api/groups', { name: `CLI-${RUN}`, members: [cl, cx] })
  assert.equal(g.status, 200, JSON.stringify(g.body))
  const gname = (await api('GET', '/api/bots')).body.find(b => b.id === cl).name
  const gr = await fetch(`${APP}/api/chat?k=${K}`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target: { type: 'group', id: g.body.id }, text: `@${gname} RUN:uname -s` }) }).then(r => r.text())
  assert.ok(!/event: error/.test(gr), gr.slice(0, 500))
  const glog = (await api('GET', `/api/groups/${g.body.id}/messages`)).body
  const gm = (glog.messages ?? glog)
  assert.deepEqual(gm.slice(-3).map(m => m.role), ['user', 'tool', 'assistant'])
  assert.equal(gm.at(-1).speaker, gname)
  assert.match(gm.at(-1).text, /Linux/)
  await api('DELETE', `/api/groups/${g.body.id}`)
  log('group: the @-ed Claude member ran uname in its own machine; the group log has it')

  // 5. hanging up kills the CLI inside the container, not just the docker exec client (2.22.1).
  // A fresh agent, so no earlier answer in its history lets the fake reply at once.
  const hk = await api('POST', '/api/bots', { name: `Hang-${RUN}`, persona: 'x', model: '', runtime: 'claude' })
  created.push(hk.body.id)
  const hung = chat(hk.body.id, 'SLEEP please', { hangUpAfter: 8000 })
  await sleep(6000)
  assert.match(sh('exec', CLI, 'ps', '-eo', 'args'), /^claude -p/m, 'the turn never reached the CLI — this check would be vacuous')
  assert.equal((await hung).status, 200)
  await sleep(4000)
  const procs = sh('exec', CLI, 'ps', '-eo', 'args')
  assert.doesNotMatch(procs, /^claude -p/m, `a claude process outlived the hang-up:\n${procs}`)
  for (const r of hanging.splice(0)) r.destroy()
  log('hanging up mid-turn: the claude process in the cli container is gone')

  // 6. signing in: Codex's device flow gives its page and a code; cancelling stops it in the container
  const lg = await api('POST', '/api/cli/login', { runtime: 'codex' })
  assert.equal(lg.status, 200)
  if (lg.body.url) {
    assert.match(lg.body.url, /^https:\/\/auth\.openai\.com\//)
    assert.match(lg.body.code, /^[A-Z0-9]{4,5}-[A-Z0-9]{4,5}$/)
    log(`codex sign-in: ${lg.body.url} code ${lg.body.code}`)
  } else log(`codex sign-in printed no link here (no route to auth.openai.com?): ${lg.body.output}`)
  assert.equal((await api('DELETE', `/api/cli/login/${lg.body.id}`)).status, 200)
  await sleep(1500)
  assert.equal((await api('GET', `/api/cli/login/${lg.body.id}`)).body.state, 'cancelled')
  assert.doesNotMatch(sh('exec', CLI, 'ps', '-eo', 'args'), /codex login/)
  log('codex sign-in cancelled; no login process left')

  console.log('e2e-cli: all checks passed')
} catch (e) {
  failed = true
  console.error(e)
} finally {
  for (const id of created) await api('DELETE', `/api/bots/${id}`)
  sh('exec', CLI, 'rm', '-f', '/home/node/.codex/config.toml', '/home/node/.grok/config.toml')
  fake.close()
  for (const r of hanging) r.destroy()
  process.exit(failed ? 1 : 0)
}
