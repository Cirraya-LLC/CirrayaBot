// Three upstream protocols: OpenAI Chat Completions / OpenAI Responses / Anthropic Messages.
//
// Inside the server, conversation history is ALWAYS in Chat Completions shape (system / user /
// assistant+tool_calls / tool) — that is what the database stores and fitContext trims.
// Protocol differences are translated only at the moment we call the upstream, and results
// come back as one { content, calls }. Switching protocol touches neither the agent loop nor history.

import { Say } from './i18n.mjs'
import { estimateUsage } from './model.mjs'

// Upstream failures. `upstream` / `upstreamStatus` let callers decide on retries without
// matching the (translated) message text.
const upstreamFail = (key, vars, httpStatus) =>
  Object.assign(new Say(key, vars, 502), { upstream: true, upstreamStatus: httpStatus ?? null })

export const PROTOCOLS = ['chat', 'responses', 'messages']
export const normProtocol = p => PROTOCOLS.includes(p) ? p : 'chat'

// ---------- request translation ----------

/** Chat-shaped tool definitions → the shape each protocol wants */
const toolsFor = (protocol, tools) => {
  if (!tools?.length) return undefined
  if (protocol === 'responses')
    return tools.map(t => ({ type: 'function', name: t.function.name,
      description: t.function.description, parameters: t.function.parameters }))
  if (protocol === 'messages')
    return tools.map(t => ({ name: t.function.name,
      description: t.function.description, input_schema: t.function.parameters }))
  return tools
}

// Images: internal messages may carry `images` (an array of data: URLs), only on user messages
// (browser screenshots). Each protocol puts images somewhere different; all translated here.
// Images are never stored in the database.

/** Chat Completions: a user message with images gets an array `content` */
export function toChatMessages(messages) {
  return messages.map(({ images, ...m }) => images?.length
    ? { ...m, content: [{ type: 'text', text: String(m.content || ' ') },
        ...images.map(url => ({ type: 'image_url', image_url: { url } }))] }
    : m)
}

/** data:image/jpeg;base64,xxx → an Anthropic image block */
const anthropicImage = url => {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(url)
  return m ? { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } } : null
}

export function toResponsesInput(messages) {
  const input = []
  for (const m of messages) {
    if (m.role === 'tool') { input.push({ type: 'function_call_output', call_id: m.tool_call_id, output: String(m.content ?? '') }); continue }
    if (m.images?.length) input.push({ role: m.role, content: [{ type: 'input_text', text: String(m.content || ' ') },
      ...m.images.map(image_url => ({ type: 'input_image', image_url }))] })
    else if (m.content) input.push({ role: m.role, content: String(m.content) })
    for (const tc of m.tool_calls ?? [])
      input.push({ type: 'function_call', call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments || '{}' })
  }
  return input
}

/**
 * Anthropic is stricter than Chat: system goes separately; tool results are tool_result blocks
 * in a user message; consecutive same-role messages must be merged; the first must be user;
 * text blocks can't be empty strings.
 */
export function toAnthropic(messages) {
  const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n')
  const out = []
  const push = (role, blocks) => {
    if (!blocks.length) return
    const last = out.at(-1)
    if (last?.role === role) last.content.push(...blocks)
    else out.push({ role, content: blocks })
  }
  for (const m of messages) {
    if (m.role === 'system') continue
    if (m.role === 'tool') {
      push('user', [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: String(m.content ?? '') || '(empty)' }])
      continue
    }
    const blocks = m.content ? [{ type: 'text', text: String(m.content) }] : []
    for (const img of m.images ?? []) { const b = anthropicImage(img); if (b) blocks.push(b) }
    for (const tc of m.tool_calls ?? []) {
      let input = {}
      try { input = JSON.parse(tc.function.arguments || '{}') } catch {}
      blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input })
    }
    push(m.role === 'assistant' ? 'assistant' : 'user', blocks)
  }
  // After fitContext trims the front, it may start with assistant — Anthropic 400s on that
  if (out[0]?.role === 'assistant') out.unshift({ role: 'user', content: [{ type: 'text', text: '(continuing the earlier conversation)' }] })
  return { system, messages: out }
}

function buildRequest(p, messages, tools) {
  const protocol = normProtocol(p.protocol)
  const base = p.base_url.replace(/\/+$/, '')
  const bearer = p.api_key ? { authorization: `Bearer ${p.api_key}` } : {}
  if (protocol === 'responses') return {
    url: `${base}/responses`, headers: bearer,
    body: { model: p.model, input: toResponsesInput(messages), stream: true, store: false,
            ...tools?.length ? { tools: toolsFor(protocol, tools), tool_choice: 'auto' } : {} },
  }
  if (protocol === 'messages') {
    const { system, messages: msgs } = toAnthropic(messages)
    return {
      url: `${base}/messages`,
      // Only x-api-key: the official API uses it, and an extra Bearer makes some gateways treat it as a bad credential
      headers: { ...p.api_key ? { 'x-api-key': p.api_key } : {}, 'anthropic-version': '2023-06-01' },
      body: { model: p.model, max_tokens: 8192, stream: true, messages: msgs,
              ...system ? { system } : {},
              ...tools?.length ? { tools: toolsFor(protocol, tools) } : {} },
    }
  }
  return {
    url: `${base}/chat/completions`, headers: bearer,
    body: { model: p.model, messages: toChatMessages(messages), stream: true, ...tools?.length ? { tools, tool_choice: 'auto' } : {} },
  }
}

// ---------- stream parsing ----------
// One "consume a JSON frame" function per protocol, accumulating into the same { content, calls }.
// calls accumulate by their own index key: tool arguments arrive in fragments.

function chatFrame(f, st, onDelta) {
  // The usage chunk comes last and carries no choices (choices: []) — measured on a real relay.
  if (f.usage) st.count(f.usage.prompt_tokens, f.usage.completion_tokens)
  if (f.choices?.[0]?.finish_reason === 'length') st.truncated = true
  const delta = f.choices?.[0]?.delta
  if (delta?.content) { st.content += delta.content; onDelta(delta.content) }
  for (const tc of delta?.tool_calls ?? []) {
    const c = st.call(tc.index ?? 0)
    if (tc.id) c.id = tc.id
    if (tc.function?.name) c.name = tc.function.name
    if (tc.function?.arguments) c.args += tc.function.arguments
  }
}

function responsesFrame(f, st, onDelta) {
  switch (f.type) {
    case 'response.output_text.delta':
      if (f.delta) { st.content += f.delta; onDelta(f.delta) }
      break
    case 'response.output_item.added':
    case 'response.output_item.done':
      if (f.item?.type === 'function_call') {
        const c = st.call(f.output_index)
        c.id = f.item.call_id || c.id
        c.name = f.item.name || c.name
        // The done frame has the full arguments; trust it (some gateways send no deltas)
        if (f.type === 'response.output_item.done' && f.item.arguments) c.args = f.item.arguments
      }
      break
    case 'response.function_call_arguments.delta':
      st.call(f.output_index).args += f.delta ?? ''
      break
    case 'response.completed':
      st.count(f.response?.usage?.input_tokens, f.response?.usage?.output_tokens)
      break
    case 'response.failed':
    case 'response.incomplete':
      throw upstreamFail('protocol.upstreamError', { detail: f.response?.error?.message ?? f.response?.incomplete_details?.reason ?? f.type })
  }
}

function messagesFrame(f, st, onDelta) {
  // Anthropic splits it: the prompt is known at message_start, the completion only at message_delta.
  // Cache reads/writes are prompt tokens too — leaving them out would make a cached turn look free.
  const u = f.type === 'message_start' ? f.message?.usage : f.type === 'message_delta' ? f.usage : null
  if (u) st.count(
    (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) || null,
    u.output_tokens)
  if (f.type === 'message_delta' && f.delta?.stop_reason === 'max_tokens') st.truncated = true
  if (f.type === 'content_block_start' && f.content_block?.type === 'tool_use') {
    const c = st.call(f.index)
    c.id = f.content_block.id; c.name = f.content_block.name
  } else if (f.type === 'content_block_delta') {
    if (f.delta?.type === 'text_delta' && f.delta.text) { st.content += f.delta.text; onDelta(f.delta.text) }
    if (f.delta?.type === 'input_json_delta') st.call(f.index).args += f.delta.partial_json ?? ''
  }
}

const FRAME = { chat: chatFrame, responses: responsesFrame, messages: messagesFrame }

/** Call the upstream once. Returns this step's text and the tools it wants to call. */
export async function callUpstream(p, messages, tools, onDelta, signal) {
  const protocol = normProtocol(p.protocol)
  const { url, headers, body } = buildRequest(p, messages, tools)
  const res = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal,
  })
  if (!res.ok) throw upstreamFail('protocol.upstreamStatus', { status: res.status, body: (await res.text()).slice(0, 200) }, res.status)

  const slots = new Map()
  const st = {
    content: '',
    call: k => { if (!slots.has(k)) slots.set(k, { id: '', name: '', args: '' }); return slots.get(k) },
    // What the upstream says this call cost. Each protocol reports the two halves at a
    // different moment (and some relays report neither), so take whatever arrives and
    // remember that it did: a silent 0 would read as "this call was free".
    used: { prompt: 0, completion: 0, reported: false },
    count(prompt, completion) {
      if (Number(prompt) > 0) { st.used.prompt = Number(prompt); st.used.reported = true }
      if (Number(completion) > 0) { st.used.completion = Number(completion); st.used.reported = true }
    },
  }
  const onLine = line => {
    if (!line.startsWith('data:')) return             // event: lines don't matter, frames carry their own type
    const data = line.slice(5).trim()
    if (!data || data === '[DONE]') return
    let f
    try { f = JSON.parse(data) } catch { return }
    // ⚠️ An upstream can answer 200 and then report an error INSIDE the stream (common with relay
    // gateways). All three protocols do it: chat {error}, messages {type:'error', error},
    // responses {type:'error', message}.
    if (f.error || f.type === 'error')
      throw upstreamFail('protocol.upstreamError', { detail: f.error?.message ?? f.message ?? JSON.stringify(f.error ?? f) })
    FRAME[protocol](f, st, onDelta)
  }
  const reader = res.body.getReader(), dec = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const lines = buf.split('\n'); buf = lines.pop() ?? ''
    for (const line of lines) onLine(line)
  }
  onLine(buf + dec.decode())                          // a last line without a newline still counts
  // Cut off at the output limit: say so, or half an answer looks exactly like a whole one
  if (st.truncated && st.content) {
    const tail = '\n\n(The reply hit the length limit and was cut off.)'
    st.content += tail; onDelta(tail)
  }
  const calls = [...slots.values()].filter(c => c.name).map(c => ({ ...c, id: c.id || `call_${Math.random().toString(36).slice(2, 10)}` }))
  // Not a word and no tool call — also a failure (usually a bad channel that didn't even report an error)
  if (!st.content.trim() && !calls.length) throw upstreamFail('protocol.empty')
  // An upstream that said nothing about tokens still cost money: estimate rather than record zero.
  const usage = st.used.reported
    ? { prompt: st.used.prompt, completion: st.used.completion, estimated: false }
    : { ...estimateUsage(messages, st.content, calls), estimated: true }
  return { content: st.content, calls, usage }
}

// Self-test: node web/protocols.mjs
if (import.meta.url === `file://${process.argv[1]}`) {
  const a = (c, m) => { if (!c) throw new Error('self-test failed: ' + m) }
  const hist = [
    { role: 'system', content: 'S' },
    { role: 'assistant', content: 'tail of the last turn' },   // after trimming, starts with assistant
    { role: 'user', content: 'run it' },
    { role: 'user', content: '[Lin] me too' },                 // two user messages in a row in a group chat
    { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }] },
    { role: 'tool', tool_call_id: 't1', content: 'a.txt' },
  ]
  const an = toAnthropic(hist)
  a(an.system === 'S', 'system goes separately')
  a(an.messages[0].role === 'user', 'must start with user')
  a(an.messages.every((m, i) => i === 0 || m.role !== an.messages[i - 1].role), 'same roles merged, strictly alternating')
  a(an.messages.at(-1).content[0].type === 'tool_result' && an.messages.at(-1).role === 'user', 'tool result goes into a user tool_result')
  a(an.messages.some(m => m.content.some(b => b.type === 'tool_use' && b.input.command === 'ls')), 'tool_use input is an object, not a string')

  const ri = toResponsesInput(hist)
  a(ri.some(x => x.type === 'function_call' && x.call_id === 't1'), 'responses tool call')
  a(ri.some(x => x.type === 'function_call_output' && x.output === 'a.txt'), 'responses tool result')

  // Stream parsing: argument fragments must be joined
  const st = { content: '', m: new Map(), call(k) { if (!this.m.has(k)) this.m.set(k, { id: '', name: '', args: '' }); return this.m.get(k) },
    used: { prompt: 0, completion: 0, reported: false },
    count(p, c) { if (Number(p) > 0) { this.used.prompt = Number(p); this.used.reported = true }
                  if (Number(c) > 0) { this.used.completion = Number(c); this.used.reported = true } } }
  messagesFrame({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'x', name: 'bash' } }, st, () => {})
  messagesFrame({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"comm' } }, st, () => {})
  messagesFrame({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'and":"ls"}' } }, st, () => {})
  a(st.call(1).args === '{"command":"ls"}', 'messages argument fragments joined')
  responsesFrame({ type: 'response.output_item.added', output_index: 3, item: { type: 'function_call', call_id: 'c', name: 'bash' } }, st, () => {})
  responsesFrame({ type: 'response.function_call_arguments.delta', output_index: 3, delta: '{"a"' }, st, () => {})
  responsesFrame({ type: 'response.output_item.done', output_index: 3, item: { type: 'function_call', call_id: 'c', name: 'bash', arguments: '{"a":1}' } }, st, () => {})
  a(st.call(3).args === '{"a":1}', 'responses trusts the done frame\'s full arguments')
  let threw = false
  try { responsesFrame({ type: 'response.failed', response: { error: { message: 'x' } } }, st, () => {}) } catch (e) { threw = e.upstream === true }
  a(threw, 'responses failure frame must throw')
  // Image translation for all three
  const img = 'data:image/jpeg;base64,QUJD'
  const withImg = [{ role: 'user', content: 'screenshot', images: [img] }]
  const ch = toChatMessages(withImg)[0]
  a(Array.isArray(ch.content) && ch.content[1].image_url.url === img && !('images' in ch), 'chat: image goes into the content array, images field not sent')
  a(toChatMessages([{ role: 'user', content: 'x' }])[0].content === 'x', 'chat: messages without images unchanged')
  const rs = toResponsesInput(withImg)[0]
  a(rs.content[1].type === 'input_image' && rs.content[1].image_url === img, 'responses: input_image')
  const am = toAnthropic(withImg).messages[0].content
  a(am[1].type === 'image' && am[1].source.media_type === 'image/jpeg' && am[1].source.data === 'QUJD', 'messages: base64 image block')
  // Usage: every protocol reports it, each in its own place and at its own moment.
  const meter = () => ({ used: { prompt: 0, completion: 0, reported: false },
    count(p, c) { if (Number(p) > 0) { this.used.prompt = Number(p); this.used.reported = true }
                  if (Number(c) > 0) { this.used.completion = Number(c); this.used.reported = true } },
    content: '', call: () => ({ id: '', name: '', args: '' }) })

  const u1 = meter()
  chatFrame({ choices: [], usage: { prompt_tokens: 4388, completion_tokens: 6 } }, u1, () => {})
  a(u1.used.prompt === 4388 && u1.used.completion === 6 && u1.used.reported, 'chat: usage comes on a chunk with no choices')

  const u2 = meter()
  responsesFrame({ type: 'response.completed', response: { usage: { input_tokens: 4388, output_tokens: 6 } } }, u2, () => {})
  a(u2.used.prompt === 4388 && u2.used.completion === 6, 'responses: usage on response.completed')

  const u3 = meter()
  messagesFrame({ type: 'message_start', message: { usage: { input_tokens: 9, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 } } }, u3, () => {})
  a(u3.used.prompt === 114 && u3.used.completion === 0, 'messages: cached prompt tokens are still prompt tokens')
  messagesFrame({ type: 'message_delta', usage: { output_tokens: 5 } }, u3, () => {})
  a(u3.used.prompt === 114 && u3.used.completion === 5, 'messages: the completion only arrives at message_delta, and must not wipe the prompt')

  const u4 = meter()
  chatFrame({ choices: [{ delta: { content: 'hi' } }] }, u4, () => {})
  a(!u4.used.reported, 'an upstream that says nothing must not look like zero tokens')

  console.log('protocols.mjs self-test passed')
}
