// Traces for an OpenTelemetry collector, over OTLP/HTTP with JSON, with no dependency. Switched on by the standard
// variables: OTEL_EXPORTER_OTLP_TRACES_ENDPOINT (the full URL) or OTEL_EXPORTER_OTLP_ENDPOINT (+ /v1/traces),
// OTEL_EXPORTER_OTLP_HEADERS (k=v,k2=v2 — e.g. an API key), OTEL_SERVICE_NAME (default cirrayabot).
//
// What it sends: a span per agent turn (invoke_agent), and under it one per model call (chat <model>: tokens, cost)
// and one per tool call (execute_tool <name>: outcome, time) — names and attributes after the GenAI semantic
// conventions. **No prompts, replies, commands or outputs** unless OTEL_CAPTURE_CONTENT=1: they can hold the user's
// data, and a collector is somewhere else. Exporting never throws into an agent's turn: a collector that is down costs
// a log line a minute and the spans in that batch.
//
// `node web/otel.mjs` is the self-test.
import { randomBytes } from 'node:crypto'

export const KIND = { internal: 1, server: 2, client: 3 }
const nowNs = () => BigInt(Math.round((performance.timeOrigin + performance.now()) * 1e6))

/** An attribute value as OTLP/JSON spells it. */
export function value(v) {
  if (typeof v === 'boolean') return { boolValue: v }
  if (typeof v === 'number') return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v }
  if (typeof v === 'bigint') return { intValue: String(v) }
  return { stringValue: String(v) }
}
export const attributes = o => Object.entries(o ?? {}).filter(([, v]) => v != null && v !== '').map(([key, v]) => ({ key, value: value(v) }))

/** OTEL_EXPORTER_OTLP_HEADERS: "k=v,k2=v2", values URL-encoded. */
export function parseHeaders(s) {
  const out = {}
  for (const part of String(s ?? '').split(',')) {
    const i = part.indexOf('=')
    if (i < 1) continue
    try { out[decodeURIComponent(part.slice(0, i).trim())] = decodeURIComponent(part.slice(i + 1).trim()) } catch {}
  }
  return out
}

/** Where traces go, from the standard variables; null = not switched on. */
export function endpointOf(env) {
  if (env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) return env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
  if (env.OTEL_EXPORTER_OTLP_ENDPOINT) return `${env.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/+$/, '')}/v1/traces`
  return null
}

const NOOP = { traceId: null, spanId: null, set() { return this }, error() { return this }, end() {} }

export class Tracer {
  /** `send(url, {method, headers, body})` → a fetch-like promise; `log` for the occasional line about a failed export. */
  constructor({ endpoint = null, headers = {}, service = 'cirrayabot', version = '', content = false,
    send = (u, o) => fetch(u, o), log = console.warn, flushMs = 5000, maxBatch = 256, maxQueue = 4096 } = {}) {
    Object.assign(this, { endpoint, headers, service, version, content, send, log, maxBatch, maxQueue, queue: [], lastLog: 0 })
    this.enabled = !!endpoint
    if (this.enabled) { this.timer = setInterval(() => this.flush(), flushMs); this.timer.unref?.() }
  }

  /** A span; `parent` = another span (or null for a new trace). End it with `.end()`. A no-op when switched off. */
  start(name, { parent = null, kind = KIND.internal, attrs = {} } = {}) {
    if (!this.enabled) return NOOP
    const span = {
      traceId: parent?.traceId ?? randomBytes(16).toString('hex'), spanId: randomBytes(8).toString('hex'),
      parentSpanId: parent?.spanId ?? undefined, name, kind, start: nowNs(), attrs: { ...attrs }, status: null, ended: false,
      set: (k, v) => { span.attrs[k] = v; return span },
      error: msg => { span.status = { code: 2, message: String(msg ?? '').slice(0, 300) }; return span },
      end: () => {
        if (span.ended) return
        span.ended = true
        span.endNs = nowNs()
        if (this.queue.length >= this.maxQueue) this.queue.shift()            // a collector that is down mustn't eat memory
        this.queue.push(span)
        if (this.queue.length >= this.maxBatch) this.flush()
      },
    }
    return span
  }

  /** The OTLP/JSON body for these spans. */
  body(spans) {
    return { resourceSpans: [{
      resource: { attributes: attributes({ 'service.name': this.service, 'service.version': this.version || undefined,
        'telemetry.sdk.name': 'cirrayabot', 'telemetry.sdk.language': 'nodejs' }) },
      scopeSpans: [{ scope: { name: 'cirrayabot', version: this.version || undefined }, spans: spans.map(s => ({
        traceId: s.traceId, spanId: s.spanId, ...s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}, name: s.name, kind: s.kind,
        startTimeUnixNano: String(s.start), endTimeUnixNano: String(s.endNs ?? s.start),
        attributes: attributes(s.attrs), status: s.status ?? { code: 1 },
      })) }],
    }] }
  }

  async flush() {
    if (!this.enabled || !this.queue.length) return
    const batch = this.queue.splice(0, this.maxBatch)
    try {
      const r = await this.send(this.endpoint, { method: 'POST', headers: { 'content-type': 'application/json', ...this.headers },
        body: JSON.stringify(this.body(batch)) })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
    } catch (e) {
      if (Date.now() - this.lastLog > 60_000) { this.lastLog = Date.now(); this.log(`[otel] could not send ${batch.length} span(s) to ${this.endpoint}: ${e.message}`) }
    }
    if (this.queue.length >= this.maxBatch) return this.flush()
  }

  async shutdown() { clearInterval(this.timer); await this.flush() }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { strict: a } = await import('node:assert')
  a.deepEqual(value(true), { boolValue: true })
  a.deepEqual(value(3), { intValue: '3' })
  a.deepEqual(value(0.25), { doubleValue: 0.25 })
  a.deepEqual(value('x'), { stringValue: 'x' })
  a.deepEqual(attributes({ a: 1, b: null, c: '', d: 'y' }).map(x => x.key), ['a', 'd'], 'empty attributes are left out')
  a.deepEqual(parseHeaders('x-api-key=abc%3D, authorization=Bearer%20t,bad'), { 'x-api-key': 'abc=', authorization: 'Bearer t' })
  a.equal(endpointOf({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4318/' }), 'http://c:4318/v1/traces')
  a.equal(endpointOf({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://c/x', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4318' }), 'http://c/x')
  a.equal(endpointOf({}), null)

  const off = new Tracer({})
  const n = off.start('x'); n.set('a', 1).end()
  a.equal(off.queue.length, 0, 'switched off: nothing kept')

  const sent = []
  const t = new Tracer({ endpoint: 'http://c/v1/traces', headers: { 'x-key': 'k' }, version: '1.2', flushMs: 1e9,
    send: async (url, o) => { sent.push({ url, o }); return { ok: true } } })
  const turn = t.start('invoke_agent', { attrs: { 'gen_ai.agent.name': 'Kim' } })
  const call = t.start('chat m1', { parent: turn, kind: KIND.client, attrs: { 'gen_ai.request.model': 'm1' } })
  call.set('gen_ai.usage.input_tokens', 120).end()
  t.start('execute_tool bash', { parent: turn }).error('exit 1').end()
  turn.end(); turn.end()
  await t.flush()
  a.equal(sent.length, 1)
  a.equal(sent[0].o.headers['x-key'], 'k')
  const body = JSON.parse(sent[0].o.body)
  const spans = body.resourceSpans[0].scopeSpans[0].spans
  a.equal(spans.length, 3, 'a span ended twice is sent once')
  const [c, tool, root] = spans
  a.equal(c.traceId, root.traceId); a.equal(c.parentSpanId, root.spanId); a.equal(root.parentSpanId, undefined)
  a.equal(c.kind, KIND.client)
  a.deepEqual(c.attributes.find(x => x.key === 'gen_ai.usage.input_tokens').value, { intValue: '120' })
  a.deepEqual(tool.status, { code: 2, message: 'exit 1' })
  a.deepEqual(root.status, { code: 1 })
  a.ok(BigInt(root.endTimeUnixNano) >= BigInt(root.startTimeUnixNano))
  a.ok(body.resourceSpans[0].resource.attributes.some(x => x.key === 'service.name' && x.value.stringValue === 'cirrayabot'))

  // A collector that is down: the batch is dropped, one log line, nothing thrown.
  const logs = []
  const down = new Tracer({ endpoint: 'http://down/v1/traces', flushMs: 1e9, log: m => logs.push(m), send: async () => { throw new Error('ECONNREFUSED') } })
  down.start('a').end(); down.start('b').end()
  await down.flush(); await down.flush()
  a.equal(logs.length, 1); a.match(logs[0], /could not send 2 span\(s\).*ECONNREFUSED/)
  a.equal(down.queue.length, 0)
  const full = new Tracer({ endpoint: 'http://x', flushMs: 1e9, maxBatch: 1e9, maxQueue: 3, send: async () => ({ ok: true }) })
  for (let i = 0; i < 5; i++) full.start(`s${i}`).end()
  a.deepEqual(full.queue.map(s => s.name), ['s2', 's3', 's4'], 'a full queue drops the oldest')
  await t.shutdown(); await down.shutdown(); await full.shutdown()
  console.log('otel: all checks pass')
}
