// The record of what happened: an audit log (tool calls and their outcome, approvals, API changes, trigger deliveries,
// model calls) exported as JSON lines, and traces for an OpenTelemetry collector — without the content by default.
import { test, before, after } from 'node:test'
import { strict as a } from 'node:assert'
import { createServer } from 'node:http'
import { startStack } from './stack.mjs'
import { fakeUpstream } from './fake-upstream.mjs'

let s, up, collector
const spans = [], bodies = []
before(async () => {
  collector = createServer((req, res) => {
    let b = ''
    req.on('data', d => { b += d })
    req.on('end', () => {
      bodies.push(b)
      try { for (const rs of JSON.parse(b).resourceSpans) for (const ss of rs.scopeSpans) spans.push(...ss.spans) } catch {}
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}')
    })
  })
  await new Promise(r => collector.listen(0, '127.0.0.1', r))
  up = await fakeUpstream()
  s = await startStack({ tools: true, env: { OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${collector.address().port}`,
    OTEL_BSP_SCHEDULE_DELAY: '200', OTEL_SERVICE_NAME: 'cb-test' } })
})
after(async () => { await s?.close(); await up?.close(); collector?.close() })

const attr = (span, key) => { const v = span.attributes.find(x => x.key === key)?.value; return v && (v.stringValue ?? v.intValue ?? v.boolValue ?? v.doubleValue) }
const lines = async q => (await (await fetch(`${s.url}/api/audit?${q}`, { headers: { cookie: `ma_token=${s.token}` } })).text())
  .split('\n').filter(Boolean).map(l => JSON.parse(l))

test('a turn becomes a trace: the turn, its model calls and its tool calls — no content by default', async () => {
  const kim = await s.agent(up, { name: 'Kim' })
  up.on(r => r.toolResults.length ? { text: 'listed', usage: { prompt_tokens: 50, completion_tokens: 7 } }
    : { tool: ['bash', { command: 'ls -la /work/very-private-dir' }], usage: { prompt_tokens: 40, completion_tokens: 3 } })
  await s.chat({ agent: kim }, 'list it', { session: 'new' })
  await s.until(() => spans.some(x => x.name === 'invoke_agent Kim'), { what: 'the turn span' })
  await s.until(() => spans.filter(x => x.name.startsWith('chat ')).length >= 2, { what: 'two model calls' })
  const root = spans.find(x => x.name === 'invoke_agent Kim')
  const kids = spans.filter(x => x.parentSpanId === root.spanId)
  const calls = kids.filter(x => x.name.startsWith('chat ')), tools = kids.filter(x => x.name === 'execute_tool bash')
  a.equal(calls.length, 2, 'both model calls under the turn')
  a.equal(tools.length, 1)
  a.ok(kids.every(x => x.traceId === root.traceId))
  a.equal(attr(calls[0], 'gen_ai.request.model'), 'fake')
  a.equal(attr(calls[0], 'gen_ai.usage.input_tokens'), '40')
  a.equal(attr(tools[0], 'cirrayabot.outcome'), 'ran')
  a.equal(attr(root, 'gen_ai.agent.id'), kim)
  a.ok(!bodies.join('').includes('very-private-dir'), 'the command is not sent')
  a.ok(!bodies.join('').includes('list it'), 'nor the message')
  const svc = JSON.parse(bodies[0]).resourceSpans[0].resource.attributes.find(x => x.key === 'service.name').value.stringValue
  a.equal(svc, 'cb-test')
  a.equal((await s.api('GET', '/api/activity')).body.observability.traces, `127.0.0.1:${collector.address().port}`)
})

test('the audit log: tools with outcomes, approvals, API changes without bodies, deliveries, model calls', async () => {
  const lee = await s.agent(up, { name: 'Lee', approval: 'all' })
  a.equal((await s.api('POST', `/api/bots/${lee}/secrets`, { name: 'TOKEN', kind: 'header', origin: 'https://api.example.com',
    value: 'supersecret-value-123' })).status, 200)
  up.on(r => r.toolResults.length ? { text: 'ok' } : { tool: ['bash', { command: 'rm -rf /work/tmp' }] })
  await s.chat({ agent: lee }, 'clean up', { session: 'new', onEvent: (ev, d) => {
    if (ev === 'tool' && d.phase === 'ask') return s.api('POST', `/api/approvals/${d.id}`, { ok: false })
  } })
  await fetch(`${s.url}/hooks/${'x'.repeat(24)}`, { method: 'POST', body: '{}' })
  await new Promise(r => setTimeout(r, 300))

  const all = await lines('days=1')
  const mine = all.filter(x => x.agent === lee)
  const tool = mine.find(x => x.kind === 'tool')
  a.deepEqual([tool.subject, tool.outcome, tool.tool, tool.agent_name], ['rm -rf /work/tmp', 'refused', 'bash', 'Lee'])
  a.ok(mine.some(x => x.kind === 'approval' && x.answer === 'denied' && x.subject === 'rm -rf /work/tmp'))
  a.ok(mine.some(x => x.kind === 'model' && x.prompt_tokens > 0), 'model calls joined in from usage')
  a.ok(all.some(x => x.kind === 'api' && x.subject === `POST /api/bots/${lee}/secrets` && x.status === 200))
  a.ok(all.some(x => x.kind === 'api' && x.subject === 'POST /api/chat'))
  a.ok(all.some(x => x.kind === 'trigger' && x.status === 404), 'a refused delivery is recorded too')
  a.ok(!JSON.stringify(all).includes('supersecret-value-123'), 'no request body, no secret')
  a.ok(all.every((x, i) => i === 0 || all[i - 1].at <= x.at), 'oldest first')

  // Filters, and a range that holds nothing.
  a.ok((await lines(`days=1&kind=tool&agent=${lee}`)).every(x => x.kind === 'tool' && x.agent === lee))
  a.ok((await lines(`days=1&kind=model&agent=${lee}`)).every(x => x.kind === 'model'))
  a.deepEqual(await lines('since=2000-01-01&until=2000-01-02'), [])
  const res = await fetch(`${s.url}/api/audit?days=1`, { headers: { cookie: `ma_token=${s.token}` } })
  a.match(res.headers.get('content-disposition'), /attachment; filename="cirrayabot-audit-\d{4}-\d\d-\d\d\.jsonl"/)
  a.equal((await fetch(`${s.url}/api/audit?days=1`)).status, 401, 'needs the access token')
})
