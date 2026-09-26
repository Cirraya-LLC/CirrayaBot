// The smallest MCP server that the three CLIs (Claude Code, Codex, Grok Build) accept: streamable
// HTTP, one JSON-RPC message per POST, answered as plain JSON. No sessions, no SSE, no resources —
// a CLI turn only needs to list our tools and call them.
//
// The tools are ours, run by our code (server.mjs execTool): approval, the transcript row, the
// withAgent lock and the agent's own container all apply exactly as on our own loop. That is the
// point of routing them here instead of letting a CLI use its built-in shell.
//
// `node web/mcp.mjs` is the self-test.

export const PROTOCOL = '2025-06-18'

/** Our chat-shaped tool specs → MCP's `tools/list` entries. */
export function mcpTools(specs) {
  return (specs ?? []).map(s => {
    const f = s.function ?? s
    return { name: f.name, description: f.description ?? '', inputSchema: f.parameters ?? { type: 'object', properties: {} } }
  })
}

/** What a tool returned (a string, or {text, image: data URL}) → MCP content blocks. */
export function mcpContent(out, image) {
  const content = [{ type: 'text', text: out ?? '' }]
  const m = /^data:([^;]+);base64,(.*)$/s.exec(image ?? '')
  if (m) content.push({ type: 'image', mimeType: m[1], data: m[2] })
  return content
}

/**
 * One JSON-RPC message in, the reply out (null for a notification, which gets 202 and no body).
 * `turn` = { tools: [chat specs], call: async (name, args) => ({out, image}) }, or null when the
 * token names no running turn — then every call says so instead of pretending to work.
 */
export async function handle(msg, turn) {
  const reply = result => ({ jsonrpc: '2.0', id: msg.id, result })
  const fail = (code, message) => ({ jsonrpc: '2.0', id: msg.id ?? null, error: { code, message } })
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return fail(-32600, 'invalid request')
  if (msg.id === undefined) return null                       // notifications/initialized and friends
  switch (msg.method) {
    case 'initialize':
      return reply({
        protocolVersion: typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'cirrayabot', version: '1' },
      })
    case 'ping': return reply({})
    case 'tools/list':
      return reply({ tools: turn ? mcpTools(turn.tools) : [] })
    case 'tools/call': {
      if (!turn) return reply({ content: [{ type: 'text', text: 'This turn is over; the tool was not run.' }], isError: true })
      const name = String(msg.params?.name ?? '')
      if (!mcpTools(turn.tools).some(t => t.name === name))
        return reply({ content: [{ type: 'text', text: `Unknown tool ${name}` }], isError: true })
      const args = msg.params?.arguments && typeof msg.params.arguments === 'object' ? msg.params.arguments : {}
      try {
        const { out, image } = await turn.call(name, args)
        return reply({ content: mcpContent(out, image) })
      } catch (e) {
        return reply({ content: [{ type: 'text', text: `Tool error: ${e?.message ?? e}` }], isError: true })
      }
    }
    default: return fail(-32601, `method not found: ${msg.method}`)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const assert = (await import('node:assert/strict')).default
  const specs = [{ type: 'function', function: { name: 'bash', description: 'run', parameters: { type: 'object', properties: { command: { type: 'string' } } } } }]
  const calls = []
  const turn = { tools: specs, call: async (n, a) => { calls.push([n, a]); return { out: 'ok', image: 'data:image/png;base64,AAAA' } } }
  const init = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }, turn)
  assert.equal(init.result.protocolVersion, '2025-03-26')
  assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }, turn), null)
  const list = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, turn)
  assert.deepEqual(list.result.tools.map(t => t.name), ['bash'])
  assert.equal(list.result.tools[0].inputSchema.properties.command.type, 'string')
  const r = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'bash', arguments: { command: 'ls' } } }, turn)
  assert.deepEqual(calls, [['bash', { command: 'ls' }]])
  assert.deepEqual(r.result.content, [{ type: 'text', text: 'ok' }, { type: 'image', mimeType: 'image/png', data: 'AAAA' }])
  // A tool the turn wasn't given is refused, never run
  const bad = await handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'rm', arguments: {} } }, turn)
  assert.equal(bad.result.isError, true); assert.equal(calls.length, 1)
  // A finished turn runs nothing
  assert.equal((await handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'bash' } }, null)).result.isError, true)
  assert.deepEqual((await handle({ jsonrpc: '2.0', id: 6, method: 'tools/list' }, null)).result.tools, [])
  assert.equal((await handle({ jsonrpc: '2.0', id: 7, method: 'nope' }, turn)).error.code, -32601)
  // A thrown tool is an error result, not a dead request
  const boom = await handle({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'bash' } }, { tools: specs, call: async () => { throw new Error('x') } })
  assert.equal(boom.result.isError, true)
  console.log('mcp.mjs: all checks passed')
}
