// A local MCP server for the end-to-end tests: JSON-RPC over stdin/stdout, one message per line, the way a server
// started inside an agent's machine talks. The fake docker runs it on the host for real (see fake-docker.sh).
// Tools: read_note (read-only) and show_key, which prints the FAKE_KEY it was started with — the test checks that
// value never reaches the model.
import { createInterface } from 'node:readline'

const send = m => process.stdout.write(`${JSON.stringify(m)}\n`)
console.log('fake stdio server starting')          // a log line on stdout: a client must skip it
for await (const line of createInterface({ input: process.stdin })) {
  let m
  try { m = JSON.parse(line) } catch { continue }
  if (m.id == null) continue
  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'local' } } })
  else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: [
    { name: 'read_note', description: 'Read the note', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: {} } },
    { name: 'show_key', description: 'Show the key this server was started with', inputSchema: { type: 'object', properties: {} } },
  ] } })
  else if (m.method === 'tools/call') {
    const name = m.params?.name
    const text = name === 'read_note' ? `note: started as uid ${process.getuid?.()} in ${process.cwd()}` : `the key is ${process.env.FAKE_KEY ?? '(none)'}`
    send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text }] } })
  } else send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no such method' } })
}
