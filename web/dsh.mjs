// DeepSeek Harness (dsh) for agents whose model is deepseek-*.
//
// The platform stays the source of truth: history, memory, the transcript, approvals, spending and
// caps are all ours, exactly as for any other agent. dsh runs the model loop — call the model, run
// a tool, feed the result back — and nothing else:
//
//   runAgent ──(model is deepseek-*)──▶ runTurn: docker exec -i <dsh container> node /opt/dsh/run.mjs
//      ▲                                   one runtime per turn, stdin/stdout = dsh's SDK JSON-RPC
//      │                                   (deploy/dsh/run.mjs; the key goes in on stdin line 1)
//      └── MCP tools/call ◀── dsh ──────── the platform's tools, served by server.mjs (mcpHandle)
//
// One runtime per turn, not one per agent: the system prompt changes every turn (memory, group
// recall, skills), a fresh runtime has no session to go stale, and "cancel" is just ending it.
// It costs about a second to start, against model calls that take several.
//
// What an agent on dsh gives up (the boss accepted these, 2026-09-25): replies arrive a message at
// a time, not token by token; images a tool returns are not shown to it (the studio tool says so
// instead — so the reviewer shouldn't run on DeepSeek); cancelling kills the runtime mid-step.
//
// Self-test: node web/dsh.mjs

/** Runs on dsh: the model name says it's a DeepSeek model. */
export const isDsh = model => /^deepseek/i.test(String(model ?? '').trim())

// The platform's three effort levels onto dsh's DeepSeek vocabulary (off / low / high / max).
// Empty stays empty: nothing on the wire, the model's own default — same rule as protocols.mjs.
export const EFFORT = { low: 'low', medium: 'high', high: 'max' }

// dsh names every MCP tool mcp__<server>__<name>; the server is called "platform" (run.mjs).
export const TOOL_PREFIX = 'mcp__platform__'

/**
 * The platform's messages (system + history, already fitted to the context window) → what one
 * dsh turn takes: a system prompt, and one user message. dsh sessions start empty every turn, so
 * the conversation so far travels inside that message, oldest first, the newest set apart.
 * In a group the log already reads "[name] …"; in a direct chat the person is "[User]".
 */
export function renderTurn(messages, { group = false } = {}) {
  const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n')
  const rest = messages.filter(m => m.role === 'user' || m.role === 'assistant')
  const said = m => (m.role === 'assistant' ? `[You] ${m.content ?? ''}` : group ? String(m.content ?? '') : `[User] ${m.content ?? ''}`)
  const last = rest.at(-1)
  if (!last) return { system, prompt: '' }
  const earlier = rest.slice(0, -1)
  if (!earlier.length) return { system, prompt: group ? said(last) : String(last.content ?? '') }
  return { system, prompt: `The conversation so far, oldest first ("[You]" is you):

${earlier.map(said).join('\n\n')}

--- The new message ---
${said(last)}` }
}

/** A line the system prompt gets on dsh: its tools carry a prefix the rest of the prompt doesn't. */
export const TOOL_NOTE = `

--- Tool names ---
Your tools are named ${TOOL_PREFIX}<name>: ${TOOL_PREFIX}studio is the studio tool, ${TOOL_PREFIX}read_skill is read_skill, and so on.`

export class DshError extends Error {
  constructor(message, extra = {}) { super(message); Object.assign(this, extra) }
}

/**
 * One turn on one runtime.
 *
 * `child` is what spawning `docker exec -i … run.mjs` gives: {stdin, stdout, stderr, kill(),
 * exited: Promise<code>}. `config` is run.mjs's line 1. `onEvent` gets
 *   {type:'step'}                                 a model call is starting
 *   {type:'message', text, calls, usage}          one assistant message (calls = tool names)
 *   {type:'stray', name}                          dsh offered the model a tool that isn't the platform's
 * Resolves {text} — the last thing it said — or rejects with a DshError (`upstream` set when the
 * model call itself failed, with its status).
 */
export function runTurn({ child, config, init, prompt, onEvent = () => {}, signal }) {
  return new Promise((resolve, reject) => {
    let settled = false, buf = '', nid = 0, err = '', messageId = null, text = '', failure = null
    const pending = new Map(), spliced = new Set(), finished = new Set()
    // A boot failure is a long stack; the lines that say what happened start with "Error".
    const tail = () => {
      const lines = err.trim().split('\n').map(l => l.trim()).filter(Boolean)
      const said = lines.filter(l => /^(Error|\w+Error)\b/.test(l))
      return (said.length ? said.slice(0, 2) : lines.slice(-3)).join(' | ').slice(0, 400)
    }
    const done = (e, v) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      for (const p of pending.values()) p.rej(new DshError('the runtime ended'))
      if (e) { child.kill(); reject(e) } else resolve(v)
    }
    const onAbort = () => done(new DshError('aborted', { aborted: true }))
    if (signal?.aborted) return onAbort()
    signal?.addEventListener('abort', onAbort, { once: true })

    const send = m => { try { child.stdin.write(JSON.stringify(m) + '\n') } catch {} }
    const request = (method, params) => new Promise((res, rej) => {
      const id = ++nid
      pending.set(id, { res, rej })
      send({ jsonrpc: '2.0', id, method, params })
    })
    const check = () => {
      if (!messageId || !finished.has(messageId)) return
      if (failure) return done(new DshError(failure.message ?? 'the model call failed',
        { upstream: true, upstreamStatus: failure.status, code: failure.code }))
      // Ask it to exit, then let go: the runtime is ours alone and ends when its stdin does.
      send({ jsonrpc: '2.0', id: ++nid, method: 'shutdown' })
      try { child.stdin.end() } catch {}
      done(null, { text })
    }
    const handle = m => {
      if (m.id !== undefined && !m.method) {
        const p = pending.get(m.id)
        pending.delete(m.id)
        if (m.error) p?.rej(new DshError(String(m.error.message ?? 'dsh error')))
        else p?.res(m.result)
        return
      }
      if (m.method === 'session.status') {
        // Idle after our message was spliced in = the turn it started is over.
        if (m.params?.status === 'idle') { for (const id of spliced) finished.add(id); check() }
        return
      }
      if (m.method !== 'session.event') return
      const ev = m.params?.event ?? {}
      const d = ev.data ?? {}
      if (ev.type === 'agent/inbox/spliced') for (const x of d.inserted ?? []) spliced.add(x.id)
      else if (ev.type === 'step/start') onEvent({ type: 'step' })
      else if (ev.type === 'assistant/message') {
        const parts = d.message?.content ?? []
        const said = parts.filter(p => p.type === 'text').map(p => p.text ?? '').join('')
        if (said.trim()) text = said
        onEvent({ type: 'message', text: said, calls: parts.filter(p => p.type === 'tool-call').map(p => p.name), usage: d.usage ?? null })
      } else if (ev.type === 'request/header') {
        // The tools this model call offers, before it goes out. Anything not ours means a dsh tool row
        // is on that run.mjs doesn't know to disable. (Not tool/call: a model inventing a tool name
        // produces one of those too, with UNKNOWN_TOOL — that's the model, not a leak.)
        for (const t of d.header?.tools ?? []) if (!String(t?.name ?? '').startsWith(TOOL_PREFIX)) onEvent({ type: 'stray', name: String(t?.name ?? '') })
      } else if (ev.type === 'turn/end' && d.reason?.kind === 'error') failure = d.reason.error ?? { message: 'the turn failed' }
    }

    child.stderr?.on('data', c => { err = (err + c).slice(-8000) })
    child.stdout.on('data', c => {
      buf += c
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line) continue
        let m
        try { m = JSON.parse(line) } catch { continue }
        handle(m)
      }
    })
    child.stdin.on?.('error', () => {})
    child.exited.then(code => done(new DshError(`the DeepSeek Harness runtime exited (${code})${tail() ? `: ${tail()}` : ''}`)))

    ;(async () => {
      send(config)
      await request('initialize', init)
      const r = await request('session/prompt', { sessionId: 'turn', contentBlocks: [{ type: 'text', text: prompt }] })
      messageId = r?.messageId ?? null
      if (!messageId) throw new DshError('dsh accepted the prompt without a message id')
      check()
    })().catch(e => done(e instanceof DshError ? e : new DshError(`${e.message}${tail() ? `: ${tail()}` : ''}`)))
  })
}

// ---------- MCP: the platform's tools, as dsh sees them ----------
// Streamable HTTP, the smallest part of it dsh uses: POST one JSON-RPC message, get one JSON
// answer. No sessions, no server-to-client stream (GET is 405, which the spec allows).

/** The platform's tool specs (OpenAI function shape) → MCP's tools/list entries. */
export const mcpTools = specs => specs.map(s => ({
  name: s.function.name,
  description: s.function.description ?? '',
  inputSchema: s.function.parameters ?? { type: 'object', properties: {} },
}))

/**
 * One JSON-RPC message → the answer to send (null for a notification). `turn` is what the
 * caller found for the bearer token: {tools: [MCP entries], call(name, args) → text}.
 */
export async function mcpHandle(msg, turn) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } }
  if (msg.id === undefined || msg.id === null) return null
  const ok = result => ({ jsonrpc: '2.0', id: msg.id, result })
  const bad = (code, message) => ({ jsonrpc: '2.0', id: msg.id, error: { code, message } })
  switch (msg.method) {
    case 'initialize':
      return ok({ protocolVersion: String(msg.params?.protocolVersion ?? '2025-06-18'), capabilities: { tools: {} },
        serverInfo: { name: 'multi-agent-platform', version: '1' } })
    case 'ping': return ok({})
    case 'tools/list': return ok({ tools: turn.tools })
    case 'tools/call': {
      const name = String(msg.params?.name ?? '')
      if (!turn.tools.some(t => t.name === name)) return ok({ content: [{ type: 'text', text: `Unknown tool ${name}` }], isError: true })
      const args = msg.params?.arguments && typeof msg.params.arguments === 'object' ? msg.params.arguments : {}
      try {
        return ok({ content: [{ type: 'text', text: String(await turn.call(name, args)) }], isError: false })
      } catch (e) {
        return ok({ content: [{ type: 'text', text: `Tool error: ${e.message}` }], isError: true })
      }
    }
    default: return bad(-32601, `method not found: ${msg.method}`)
  }
}

// ---------- the DeepSeek key (Keys panel) ----------
export const DEEPSEEK_BASE = 'https://api.deepseek.com'

/** What the panel may see of the stored key: its tail, never the key. */
export const keyView = k => ({ base_url: k?.base_url || '', set: !!k?.api_key, hint: k?.api_key ? `••••${k.api_key.slice(-4)}` : '' })

/** A panel edit → what to store. An empty key keeps the stored one; `clear` removes it. */
export function keyEdit(cur, b) {
  const base = String(b.base_url ?? cur?.base_url ?? '').trim().replace(/\/+$/, '')
  if (base && !/^https?:\/\/[^\s/]+/i.test(base)) throw new Error('base_url must start with http:// or https://')
  if (b.api_key != null && typeof b.api_key !== 'string') throw new Error('api_key must be a string')
  const key = b.clear === true ? '' : String(b.api_key ?? '').trim() || cur?.api_key || ''
  if (key.length > 400 || base.length > 400) throw new Error('too long')
  return { base_url: base, api_key: key }
}

/**
 * Which key and endpoint a turn uses: the panel's DeepSeek key, else the agent's own upstream if it
 * speaks Chat Completions (a DeepSeek-compatible relay does). null = nothing usable.
 */
export function keyFor(panel, p) {
  if (panel?.api_key) return { key: panel.api_key, base_url: panel.base_url || DEEPSEEK_BASE, from: 'panel' }
  if (p?.api_key && (p.protocol ?? 'chat') === 'chat' && p.base_url) return { key: p.api_key, base_url: p.base_url, from: 'upstream' }
  return null
}

// ---------- self-test ----------
if (import.meta.url === `file://${process.argv[1]}`) {
  const a = await import('node:assert/strict')
  const { PassThrough } = await import('node:stream')

  a.ok(isDsh('deepseek-v4-flash')); a.ok(isDsh(' DeepSeek-Chat')); a.ok(!isDsh('gpt-5.5')); a.ok(!isDsh('my-deepseek'))

  // Rendering: a first message goes as it is; history travels inside the one message.
  a.deepEqual(renderTurn([{ role: 'system', content: 'S' }, { role: 'user', content: 'hi' }]), { system: 'S', prompt: 'hi' })
  const dm = renderTurn([{ role: 'system', content: 'S' }, { role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }])
  a.match(dm.prompt, /\[User\] a\n\n\[You\] b\n\n--- The new message ---\n\[User\] c$/)
  const grp = renderTurn([{ role: 'system', content: 'S' }, { role: 'user', content: '[顾衡] 开拍' }, { role: 'assistant', content: '收到' }, { role: 'user', content: '[Studio] 候选已就绪' }], { group: true })
  a.match(grp.prompt, /^The conversation so far.*\n\n\[顾衡\] 开拍\n\n\[You\] 收到\n\n--- The new message ---\n\[Studio\] 候选已就绪$/s)
  a.equal(renderTurn([{ role: 'system', content: 'S' }, { role: 'user', content: '[User] go' }], { group: true }).prompt, '[User] go')

  // A fake runtime speaking the SDK protocol: one tool step, then an answer.
  const fake = ({ fail = null, exitEarly = false, stray = false } = {}) => {
    const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough()
    let resolveExit, killed = false, first = null
    const exited = new Promise(r => { resolveExit = r })
    const out = m => stdout.write(JSON.stringify(m) + '\n')
    const ev = (type, data) => out({ jsonrpc: '2.0', method: 'session.event', params: { sessionId: 'turn', event: { type, data } } })
    let lb = ''
    stdin.on('data', c => {
      lb += c
      let i
      while ((i = lb.indexOf('\n')) >= 0) {
        const m = JSON.parse(lb.slice(0, i)); lb = lb.slice(i + 1)
        if (!first) { first = m; continue }
        if (m.method === 'initialize') {
          if (exitEarly) { stderr.write('file:///x.js:1\n  throw e\nError: dsh: plugin tree failed: bad patch\n    at boot (x.js:1)\n    at run (x.js:2)\n}\n'); resolveExit(1); continue }
          out({ jsonrpc: '2.0', id: m.id, result: { serverInfo: { name: 'x' } } })
        }
        if (m.method === 'session/prompt') {
          out({ jsonrpc: '2.0', id: m.id, result: { messageId: 'm1' } })
          ev('agent/inbox/spliced', { inserted: [{ id: 'm1' }] })
          out({ jsonrpc: '2.0', method: 'session.status', params: { status: 'running' } })
          ev('step/start', { step: 1 })
          ev('request/header', { header: { tools: [{ name: 'mcp__platform__bash' }, ...stray ? [{ name: 'bash' }] : []] }, reason: 'initial' })
          ev('assistant/message', { message: { content: [{ type: 'text', text: 'Checking.' }, { type: 'tool-call', name: 'mcp__platform__bash' }] }, usage: { inputTokens: 100, outputTokens: 10 } })
          ev('tool/call', { name: 'made_up_tool' })   // a model inventing a name is not a leak
          ev('step/start', { step: 2 })
          if (fail) ev('turn/end', { reason: { kind: 'error', error: fail } })
          else {
            ev('assistant/message', { message: { content: [{ type: 'text', text: 'Done: 42' }] }, usage: { inputTokens: 150, outputTokens: 5 } })
            ev('turn/end', { reason: { kind: 'completed' } })
          }
          out({ jsonrpc: '2.0', method: 'session.status', params: { status: 'idle' } })
        }
      }
    })
    return { stdin, stdout, stderr, exited, kill: () => { killed = true; resolveExit(137) }, get killed() { return killed }, get first() { return first } }
  }

  const events = []
  const c1 = fake()
  const r1 = await runTurn({ child: c1, config: { rt: 'aa11', key: 'sk' }, init: { model: 'deepseek-chat' }, prompt: 'go', onEvent: e => events.push(e) })
  a.equal(r1.text, 'Done: 42', 'the last thing it said')
  a.deepEqual(c1.first, { rt: 'aa11', key: 'sk' }, 'line 1 is the runtime config, before any JSON-RPC')
  a.deepEqual(events.map(e => e.type), ['step', 'message', 'step', 'message'])
  a.deepEqual(events[1], { type: 'message', text: 'Checking.', calls: ['mcp__platform__bash'], usage: { inputTokens: 100, outputTokens: 10 } })

  // A failed model call surfaces as an upstream error with its status.
  const e2 = await runTurn({ child: fake({ fail: { message: 'Authentication Fails', code: 'AUTH', status: 401 } }), config: {}, init: {}, prompt: 'go' }).catch(e => e)
  a.ok(e2 instanceof DshError); a.equal(e2.upstream, true); a.equal(e2.upstreamStatus, 401); a.match(e2.message, /Authentication Fails/)

  // The runtime dying is an error with its stderr, not a hang.
  const e3 = await runTurn({ child: fake({ exitEarly: true }), config: {}, init: {}, prompt: 'go' }).catch(e => e)
  a.match(e3.message, /exited \(1\): Error: dsh: plugin tree failed: bad patch$/, 'the Error line, not the stack')

  // Abort ends the runtime.
  const ac = new AbortController(), c4 = fake()
  ac.abort()
  const e4 = await runTurn({ child: c4, config: {}, init: {}, prompt: 'go', signal: ac.signal }).catch(e => e)
  a.equal(e4.aborted, true); a.equal(c4.killed, true)

  // A tool offered that isn't the platform's is reported; a tool the model made up is not.
  const seen = []
  await runTurn({ child: fake({ stray: true }), config: {}, init: {}, prompt: 'go', onEvent: e => seen.push(e) })
  a.deepEqual(seen.filter(e => e.type === 'stray'), [{ type: 'stray', name: 'bash' }])

  // MCP
  const specs = [{ type: 'function', function: { name: 'bash', description: 'Run', parameters: { type: 'object', properties: { command: { type: 'string' } } } } }]
  const calls = []
  const turn = { tools: mcpTools(specs), call: async (n, args) => { calls.push([n, args]); if (args.command === 'boom') throw new Error('no container'); return 'exit 0' } }
  a.equal(await mcpHandle({ jsonrpc: '2.0', method: 'notifications/initialized' }, turn), null)
  a.equal((await mcpHandle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } }, turn)).result.protocolVersion, '2025-11-25')
  a.deepEqual((await mcpHandle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, turn)).result.tools,
    [{ name: 'bash', description: 'Run', inputSchema: { type: 'object', properties: { command: { type: 'string' } } } }])
  a.deepEqual((await mcpHandle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'bash', arguments: { command: 'ls' } } }, turn)).result,
    { content: [{ type: 'text', text: 'exit 0' }], isError: false })
  a.equal((await mcpHandle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'write_file', arguments: {} } }, turn)).result.isError, true, 'only the tools this turn has')
  a.match((await mcpHandle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'bash', arguments: { command: 'boom' } } }, turn)).result.content[0].text, /Tool error: no container/)
  a.equal((await mcpHandle({ jsonrpc: '2.0', id: 6, method: 'resources/list' }, turn)).error.code, -32601)
  a.deepEqual(calls, [['bash', { command: 'ls' }], ['bash', { command: 'boom' }]])

  // Keys: the tail only; empty keeps; clear clears; the panel beats the upstream.
  a.deepEqual(keyView({ base_url: '', api_key: 'sk-abcdef1234' }), { base_url: '', set: true, hint: '••••1234' })
  a.deepEqual(keyEdit({ api_key: 'old' }, { api_key: '', base_url: 'https://relay.example/v1/' }), { base_url: 'https://relay.example/v1', api_key: 'old' })
  a.deepEqual(keyEdit({ api_key: 'old' }, { clear: true }), { base_url: '', api_key: '' })
  a.throws(() => keyEdit(null, { base_url: 'ftp://x' }), /http/)
  a.deepEqual(keyFor({ api_key: 'k' }, { api_key: 'u', base_url: 'https://u', protocol: 'chat' }), { key: 'k', base_url: DEEPSEEK_BASE, from: 'panel' })
  a.deepEqual(keyFor(null, { api_key: 'u', base_url: 'https://u', protocol: 'chat' }), { key: 'u', base_url: 'https://u', from: 'upstream' })
  a.equal(keyFor(null, { api_key: 'u', base_url: 'https://u', protocol: 'messages' }), null, 'dsh speaks Chat Completions only')
  console.log('dsh.mjs: all checks passed')
}
