// The studio's model keys: Seedance, GPT image, ComfyUI, and speech (TTS) for narration.
//
// Two sources, per field: what a person typed into the Keys panel (stored in the studio's own
// `config` table — never the platform's database), else the studio container's environment
// (.env). The panel wins, so a key can be changed without restarting anything; clearing a panel
// value falls back to .env again.
//
// This module holds no database handle: server.mjs loads the rows at startup and after every
// keys.set, and the adapters read `value()` synchronously. One process, so one cache is the truth.
//
// A secret never leaves this service: keys.get returns the last four characters and where the
// value came from, nothing more — not to the panel, and not to an agent (keys.* is human-only).
//
// Self-test: node studio/keys.mjs

export const KEYS = {
  seedance: {
    base_url: { env: 'SEEDANCE_BASE_URL', url: true },
    api_key: { env: 'SEEDANCE_API_KEY', secret: true },
  },
  gpt_image: {
    base_url: { env: 'GPT_IMAGE_BASE_URL', url: true, fallback: 'https://api.openai.com/v1' },
    api_key: { env: 'GPT_IMAGE_API_KEY', secret: true },
    model: { env: 'GPT_IMAGE_MODEL', fallback: 'gpt-image-1' },
  },
  comfy: {
    url: { env: 'COMFY_URL', url: true },
  },
  // Narration and off-screen voices (tts.mjs): MiniMax T2A v2. Mainland by default; an
  // international key needs https://api.minimax.io. Without a key narration stays in the subtitles
  // and the assembly says so.
  tts: {
    base_url: { env: 'TTS_BASE_URL', url: true, fallback: 'https://api.minimax.cn' },
    api_key: { env: 'TTS_API_KEY', secret: true },
    model: { env: 'TTS_MODEL', fallback: 'speech-2.8-hd' },
  },
}

let panel = {}   // 'seedance.api_key' → value, only non-empty ones

/** Replace the cache with the stored rows ({key: value}). */
export function setPanel(rows) {
  panel = Object.fromEntries(Object.entries(rows ?? {}).filter(([, v]) => typeof v === 'string' && v !== ''))
}

function spec(name, field) {
  const f = KEYS[name]?.[field]
  if (!f) throw new Error(`unknown key ${name}.${field}`)
  return f
}

/** Where a field's value comes from right now: 'panel' | 'env' | 'default' | 'none'. */
export function sourceOf(name, field, env = process.env) {
  const f = spec(name, field)
  if (panel[`${name}.${field}`]) return 'panel'
  if (env[f.env]) return 'env'
  return f.fallback ? 'default' : 'none'
}

/** The value the adapters use. */
export function value(name, field, env = process.env) {
  const f = spec(name, field)
  return panel[`${name}.${field}`] || env[f.env] || f.fallback || ''
}

const hint = v => (v ? `••••${v.slice(-4)}` : '')

/** What the panel may see: plain values for URLs and model names, a hint for secrets. */
export function view(env = process.env) {
  return Object.entries(KEYS).map(([name, fields]) => ({
    name,
    fields: Object.fromEntries(Object.entries(fields).map(([field, f]) => {
      const v = value(name, field, env)
      return [field, { source: sourceOf(name, field, env), env: f.env, ...f.secret ? { hint: hint(v) } : { value: v } }]
    })),
    // Enough to try: the fields without a fallback are all filled.
    ready: Object.entries(fields).every(([field]) => value(name, field, env) !== ''),
  }))
}

/**
 * A panel edit → the rows to write ({key: value}; '' deletes the row).
 * A secret left empty is kept; `clear` lists fields to drop back to .env. Anything else empty
 * also drops back — the form shows the effective value, so emptying it means "not mine".
 */
export function edit(name, values = {}, clear = []) {
  const fields = KEYS[name]
  if (!fields) throw new Error(`unknown key group "${name}"; one of ${Object.keys(KEYS).join(', ')}`)
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('values must be an object')
  const out = {}
  for (const [field, raw] of Object.entries(values)) {
    const f = fields[field]
    if (!f) throw new Error(`${name} has no field "${field}"`)
    if (raw != null && typeof raw !== 'string') throw new Error(`${name}.${field} must be a string`)
    const v = String(raw ?? '').trim()
    if (v.length > 2000) throw new Error(`${name}.${field} is too long`)
    if (f.secret && !v) continue
    if (f.url && v && !/^https?:\/\/[^\s/]+/i.test(v)) throw new Error(`${name}.${field} must start with http:// or https://`)
    out[`${name}.${field}`] = f.url ? v.replace(/\/+$/, '') : v
  }
  for (const field of Array.isArray(clear) ? clear : []) {
    if (!fields[field]) throw new Error(`${name} has no field "${field}"`)
    out[`${name}.${field}`] = ''
  }
  return out
}

/**
 * Try the saved values against the real service with a request that costs nothing:
 * Seedance lists one task, GPT image lists models, ComfyUI reports its system stats.
 * → {ok, code, vars, message}: `code` + `vars` for the panel to say in the viewer's language
 * (web/i18n.js key.t.<code>), `message` the same in English.
 */
export async function test(name, { env = process.env, timeoutMs = 15_000 } = {}) {
  const v = field => value(name, field, env)
  const get = (url, headers = {}) => fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
  const reason = async r => {
    const t = await r.text().catch(() => '')
    try { const j = JSON.parse(t); return String(j.error?.message ?? j.error ?? j.message ?? t).slice(0, 200) } catch { return t.slice(0, 200) }
  }
  const say = (ok, code, vars = {}) => ({ ok, code, vars, message: TEST_TEXT[code](vars) })
  try {
    if (name === 'seedance') {
      if (!v('base_url') || !v('api_key')) return say(false, 'need', { fields: 'base_url, api_key' })
      const r = await get(`${v('base_url')}/api/v3/contents/generations/tasks?page_num=1&page_size=1`, { authorization: `Bearer ${v('api_key')}` })
      if (r.ok) return say(true, 'ok')
      if (r.status === 401 || r.status === 403) return say(false, 'rejected', { status: r.status, detail: await reason(r) })
      if (r.status === 404) return say(false, 'noTaskList')
      return say(false, 'status', { status: r.status, detail: await reason(r) })
    }
    if (name === 'gpt_image') {
      if (!v('api_key')) return say(false, 'need', { fields: 'api_key' })
      const r = await get(`${v('base_url')}/models`, { authorization: `Bearer ${v('api_key')}` })
      if (r.status === 401 || r.status === 403) return say(false, 'rejected', { status: r.status, detail: await reason(r) })
      if (!r.ok) return say(false, 'status', { status: r.status, detail: await reason(r) })
      const ids = ((await r.json().catch(() => ({}))).data ?? []).map(m => m.id)
      return ids.includes(v('model')) ? say(true, 'modelOk', { model: v('model') })
        : say(true, 'modelUnlisted', { model: v('model'), n: ids.length })
    }
    if (name === 'tts') {
      if (!v('api_key')) return say(false, 'need', { fields: 'api_key' })
      // Listing voices is free; saying a word is not. MiniMax reports errors inside a 200.
      // (Not tts.voices(): tts.mjs imports this file, and under the self-test's top-level await the
      // cycle never finishes loading.)
      const r = await fetch(`${v('base_url').replace(/\/v1$/, '')}/v1/get_voice`, { method: 'POST', signal: AbortSignal.timeout(timeoutMs),
        headers: { 'content-type': 'application/json', authorization: `Bearer ${v('api_key')}` }, body: '{"voice_type":"all"}' })
      if (!r.ok) return say(false, 'status', { status: r.status, detail: await reason(r) })
      const j = await r.json().catch(() => ({}))
      const code = j.base_resp?.status_code
      if (code === 1004) return say(false, 'rejected', { status: 1004, detail: `${j.base_resp.status_msg ?? ''} — a key only works on the site that issued it (api.minimax.cn / api.minimax.io)` })
      if (code !== 0) return say(false, 'status', { status: code ?? '?', detail: String(j.base_resp?.status_msg ?? JSON.stringify(j).slice(0, 200)) })
      return say(true, 'voicesOk', { n: ['system_voice', 'voice_cloning', 'voice_generation'].reduce((n, k) => n + (j[k]?.length ?? 0), 0) })
    }
    if (name === 'comfy') {
      if (!v('url')) return say(false, 'need', { fields: 'url' })
      const r = await get(`${v('url')}/system_stats`)
      if (!r.ok) return say(false, 'status', { status: r.status, detail: await reason(r) })
      const j = await r.json().catch(() => ({}))
      return say(true, 'comfyOk', { version: String(j.system?.comfyui_version ?? '?'), device: String(j.devices?.[0]?.name ?? '—') })
    }
    return say(false, 'unknown', { name })
  } catch (e) {
    return say(false, 'unreachable', { detail: e?.name === 'TimeoutError' ? `no answer within ${timeoutMs / 1000}s` : String(e?.cause?.code ?? e?.cause?.message ?? e.message) })
  }
}

const TEST_TEXT = {
  need: x => `Not filled in yet: ${x.fields}.`,
  ok: () => 'It answered and accepted the key.',
  rejected: x => `The key was rejected (${x.status}): ${x.detail}`,
  noTaskList: () => 'Reached the server, but it has no task list at /api/v3/contents/generations/tasks — check the base URL (a relay may also not implement listing).',
  status: x => `It answered ${x.status}: ${x.detail}`,
  modelOk: x => `Key accepted; ${x.model} is available.`,
  modelUnlisted: x => `Key accepted, but ${x.model} is not among its ${x.n} models — a relay may still serve it.`,
  voicesOk: x => `Key accepted; the account has ${x.n} voices.`,
  comfyOk: x => `ComfyUI ${x.version} is up (${x.device}).`,
  unknown: x => `unknown key group "${x.name}"`,
  unreachable: x => `Could not reach it: ${x.detail}`,
}

// ---------- self-test ----------
if (import.meta.url === `file://${process.argv[1]}`) {
  const a = await import('node:assert/strict')
  const { createServer } = await import('node:http')
  const env = { SEEDANCE_BASE_URL: 'http://env-sd', SEEDANCE_API_KEY: 'env-key-1234', GPT_IMAGE_API_KEY: '' }

  setPanel({})
  a.equal(value('seedance', 'base_url', env), 'http://env-sd')
  a.equal(sourceOf('seedance', 'api_key', env), 'env')
  a.equal(value('gpt_image', 'base_url', env), 'https://api.openai.com/v1', 'the fallback')
  a.equal(sourceOf('gpt_image', 'base_url', env), 'default')
  a.equal(sourceOf('comfy', 'url', env), 'none')
  a.equal(value('tts', 'base_url', env), 'https://api.minimax.cn', 'MiniMax, mainland, by default')
  a.equal(value('tts', 'model', env), 'speech-2.8-hd')
  a.equal(view(env).find(x => x.name === 'tts').ready, false, 'no speech until a key is set')

  // The panel wins, field by field; an empty row is no row.
  setPanel({ 'seedance.api_key': 'panel-key-9876', 'seedance.base_url': '' })
  a.equal(value('seedance', 'api_key', env), 'panel-key-9876')
  a.equal(sourceOf('seedance', 'base_url', env), 'env')

  // A secret never comes out, only its tail.
  const v = view(env)
  const sd = v.find(x => x.name === 'seedance')
  a.deepEqual(sd.fields.api_key, { source: 'panel', env: 'SEEDANCE_API_KEY', hint: '••••9876' })
  a.equal(sd.fields.base_url.value, 'http://env-sd')
  a.equal(sd.ready, true)
  a.equal(v.find(x => x.name === 'comfy').ready, false)
  a.ok(!JSON.stringify(v).includes('panel-key-9876') && !JSON.stringify(v).includes('env-key-1234'))

  // Editing: an empty secret is kept, other empties drop back to .env, clear drops the secret.
  a.deepEqual(edit('seedance', { api_key: '', base_url: 'https://relay.example/' }), { 'seedance.base_url': 'https://relay.example' })
  a.deepEqual(edit('seedance', { base_url: '' }, ['api_key']), { 'seedance.base_url': '', 'seedance.api_key': '' })
  a.throws(() => edit('seedance', { base_url: 'relay.example' }), /http/)
  a.throws(() => edit('seedance', { model: 'x' }), /no field/)
  a.throws(() => edit('nope', {}), /unknown key group/)
  a.throws(() => edit('comfy', { url: 5 }), /string/)

  // Tests against fakes: accepted, rejected, and down.
  const srv = createServer((req, res) => {
    const auth = req.headers.authorization
    if (req.url === '/mm/v1/get_voice') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(auth === 'Bearer mm' ? '{"system_voice":[{"voice_id":"a"},{"voice_id":"b"}],"base_resp":{"status_code":0}}' : '{"base_resp":{"status_code":1004,"status_msg":"login fail"}}') }
    if (req.url.startsWith('/sd/api/v3/contents/generations/tasks?')) { res.writeHead(auth === 'Bearer good' ? 200 : 401, { 'content-type': 'application/json' }); return res.end(auth === 'Bearer good' ? '{"items":[]}' : '{"error":{"message":"bad key"}}') }
    if (req.url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"data":[{"id":"gpt-image-1"}]}') }
    if (req.url === '/comfy/system_stats') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"system":{"comfyui_version":"0.3.60"},"devices":[{"name":"cuda:0 RTX"}]}') }
    res.writeHead(404); res.end()
  })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${srv.address().port}`
  setPanel({ 'seedance.base_url': `${base}/sd`, 'seedance.api_key': 'good', 'gpt_image.base_url': `${base}/v1`, 'gpt_image.api_key': 'k', 'comfy.url': `${base}/comfy` })
  a.equal((await test('seedance', { env: {} })).ok, true)
  a.deepEqual((await test('gpt_image', { env: {} })).vars, { model: 'gpt-image-1' })
  setPanel({ 'tts.base_url': `${base}/mm/v1`, 'tts.api_key': 'mm' })
  const tt = await test('tts', { env: {} })
  a.equal(tt.code, 'voicesOk', tt.message); a.deepEqual(tt.vars, { n: 2 })
  setPanel({ 'tts.base_url': `${base}/mm`, 'tts.api_key': 'wrong' })
  const tb = await test('tts', { env: {} })
  a.equal(tb.code, 'rejected'); a.match(tb.message, /api\.minimax\.io/, 'says a key belongs to one site')
  setPanel({ 'seedance.base_url': `${base}/sd`, 'seedance.api_key': 'good', 'gpt_image.base_url': `${base}/v1`, 'gpt_image.api_key': 'k', 'comfy.url': `${base}/comfy` })
  const cf = await test('comfy', { env: {} })
  a.equal(cf.code, 'comfyOk'); a.match(cf.message, /0\.3\.60.*RTX/)
  setPanel({ 'seedance.base_url': `${base}/sd`, 'seedance.api_key': 'bad' })
  const bad = await test('seedance', { env: {} })
  a.equal(bad.ok, false); a.equal(bad.code, 'rejected'); a.match(bad.message, /rejected \(401\): bad key/)
  srv.close()
  setPanel({ 'comfy.url': 'http://127.0.0.1:1' })
  a.equal((await test('comfy', { env: {} })).code, 'unreachable')
  setPanel({})
  a.deepEqual((await test('seedance', { env: {} })).vars, { fields: 'base_url, api_key' })
  console.log('keys.mjs: all checks passed')
}
