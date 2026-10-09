// A model upstream that answers from a script: the end-to-end tests decide, request by request,
// what the "model" says, and can look at exactly what the server sent it. OpenAI Chat
// Completions protocol (the other two are translated in protocols.mjs and checked by its self-test).
//
//   const up = await fakeUpstream()
//   up.on(req => ({ text: 'hi' }))                     // every request gets this
//   up.on(req => req.toolResults.length ? { text: 'done' } : { tool: ['bash', { command: 'ls' }] })
//
// A reply is one of:
//   { text }                          a plain answer
//   { tool: [name, args] }            one tool call;  { tools: [[name, args], ...] } several
//   { status, error }                 an HTTP error before any byte (e.g. 500, 503, 429)
//   { streamError }                   200, then an error frame inside the stream
//   { empty: true }                   200 and nothing at all
// plus, on any of them: { wait: ms } to answer late, { usage: { prompt_tokens, completion_tokens } }.
import { createServer } from 'node:http'

/** What a test reads off a request: the last user text, the tool results so far, the system prompt. */
export function describe(body) {
  const messages = body.messages ?? []
  const text = m => typeof m.content === 'string' ? m.content
    : Array.isArray(m.content) ? m.content.map(p => p.text ?? '').join('') : ''
  const users = messages.filter(m => m.role === 'user').map(text)
  // Tool results of the current turn: those after the last message a person (or the platform) wrote.
  let since = messages.length
  while (since > 0 && messages[since - 1].role !== 'user') since--
  return {
    body, messages, model: body.model,
    system: text(messages.find(m => m.role === 'system') ?? {}),
    lastUser: users.at(-1) ?? '',
    users,
    toolResults: messages.slice(since).filter(m => m.role === 'tool').map(text),
    tools: (body.tools ?? []).map(t => t.function?.name),
  }
}

/** A WAV of `seconds` of a quiet tone — something a browser can actually play. */
export function wav(seconds = 0.25, rate = 8000) {
  const n = Math.round(seconds * rate), data = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin(i / rate * 2 * Math.PI * 440) * 3000), i * 2)
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12)
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24)
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40)
  return Buffer.concat([h, data])
}

export async function fakeUpstream({ models = [{ id: 'fake' }], name = 'fake' } = {}) {
  const requests = []
  let handler = () => ({ text: 'ok' })
  let n = 0
  const open = new Set()
  const server = createServer(async (req, res) => {
    open.add(res)
    res.on('close', () => open.delete(res))
    let raw = ''
    for await (const c of req) raw += c
    if (req.url.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ data: up.models }))
    }
    if (req.url.endsWith('/audio/transcriptions') || req.url.endsWith('/audio/speech')) {
      if (up.noAudio) { res.writeHead(404); return res.end('404 page not found') }
      if (req.url.endsWith('/audio/speech')) {
        up.spoken.push({ body: JSON.parse(raw || '{}'), auth: req.headers.authorization ?? null })
        res.writeHead(200, { 'content-type': 'audio/wav' })
        return res.end(wav(0.25))
      }
      // multipart: the fields are read by name; the file is only measured
      const field = name => new RegExp(`name="${name}"\r\n\r\n([^\r]*)`).exec(raw)?.[1] ?? null
      up.heard.push({ type: req.headers['content-type'], size: raw.length, model: field('model'), language: field('language'),
        filename: /filename="([^"]+)"/.exec(raw)?.[1] ?? null, auth: req.headers.authorization ?? null })
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ text: up.transcript }))
    }
    if (!req.url.endsWith('/chat/completions')) { res.writeHead(404); return res.end() }
    const body = JSON.parse(raw || '{}')
    const r = describe(body)
    r.headers = req.headers
    requests.push(r)
    let reply
    try { reply = await handler(r, requests.length) ?? { text: 'ok' } }
    catch (e) { reply = { status: 500, error: `fake upstream handler threw: ${e.message}` } }
    if (reply.wait) await new Promise(t => setTimeout(t, reply.wait))
    if (res.destroyed) return
    if (reply.status) {
      res.writeHead(reply.status, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: { message: reply.error ?? `status ${reply.status}` } }))
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const frame = f => res.write(`data: ${JSON.stringify(f)}\n\n`)
    if (reply.streamError) { frame({ choices: [{ delta: { role: 'assistant' } }] }); frame({ error: { message: reply.streamError } }) }
    else if (reply.empty) frame({ choices: [{ delta: { role: 'assistant' }, finish_reason: 'stop' }] })
    else if (reply.tool || reply.tools) {
      const calls = reply.tools ?? [reply.tool]
      frame({ choices: [{ delta: { tool_calls: calls.map(([fn, args], index) =>
        ({ index, id: `call_${name}_${++n}`, type: 'function', function: { name: fn, arguments: JSON.stringify(args ?? {}) } })) },
      finish_reason: 'tool_calls' }] })
    } else frame({ choices: [{ delta: { content: String(reply.text ?? '') }, finish_reason: 'stop' }] })
    if (reply.usage) frame({ choices: [], usage: reply.usage })
    res.end('data: [DONE]\n\n')
  })
  await new Promise(ok => server.listen(0, '127.0.0.1', ok))
  const up = {
    url: `http://127.0.0.1:${server.address().port}/v1`,
    requests,
    models,
    transcript: 'hello from the microphone',
    heard: [],
    spoken: [],
    noAudio: false,
    on(fn) { handler = fn; return up },
    /** Requests the server made after this point. */
    mark() { const at = requests.length; return () => requests.slice(at) },
    close() {
      for (const res of open) res.destroy()
      return new Promise(ok => server.close(ok))
    },
  }
  return up
}
