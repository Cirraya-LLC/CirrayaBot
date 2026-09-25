// Seedance through ModelArk's task API (or a relay that speaks the same paths).
//
//   POST {base}/api/v3/contents/generations/tasks   → {id}
//   GET  {base}/api/v3/contents/generations/tasks/{id} → {status, content:{video_url, last_frame_url}, usage, error}
//
// Facts from the official docs (2026-09-25), each one a way to lose money or footage:
//   - video_url / last_frame_url are valid for 24 hours → the worker downloads on success
//   - generate_audio defaults to TRUE → we always send it explicitly
//   - duration: 2.5 takes 4–30 s, 2.0 takes 4–15 s. A 3-second shot is generated at 4 s and the
//     wanted length is recorded (params.trim_to) — the edit trims it, the model can't
//   - reference images: role reference_image, 2.5 takes up to 30, 2.0 up to 9; body ≤ 64 MB
//   - 2.0 rejects reference images containing real human faces
//
// Self-test: node studio/seedance.mjs (a fake server stands in for the API)

import { value } from './keys.mjs'

const env = process.env

export const MODELS = {
  'seedance-2.0': { id: env.SEEDANCE_MODEL_20 || 'dreamina-seedance-2-0-260128', maxRefs: 9, minS: 4, maxS: 15 },
  'seedance-2.5': { id: env.SEEDANCE_MODEL_25 || 'dreamina-seedance-2-5-260628', maxRefs: 30, minS: 4, maxS: 30 },
}

// The Keys panel first, then .env (keys.mjs).
export const config = () => ({
  base: value('seedance', 'base_url').replace(/\/+$/, ''),
  key: value('seedance', 'api_key'),
})

// Per project, the defaults the boss agreed to: 40 videos an hour, 4 running at once.
// The hourly cap refuses; the concurrency limit only queues (a hero shot draws 8).
export const limits = (info = {}) => ({
  perHour: Number(info.seedance?.per_hour ?? env.SEEDANCE_PER_HOUR ?? 40),
  concurrent: Number(info.seedance?.concurrent ?? env.SEEDANCE_CONCURRENT ?? 4),
})

/** Can `n` more videos start in this project? `used` = videos requested in the last hour. */
export function rateCheck(used, n, perHour) {
  const left = Math.max(0, perHour - used)
  if (n <= left) return { ok: true, left: left - n }
  return { ok: false, left,
    error: `the project's Seedance limit is ${perHour} videos per hour; ${used} were requested in the last hour, so at most ${left} more now. ` +
      'Draw fewer, or wait — and if the same shot keeps failing, the shot design may be the problem, not the luck.' }
}

/**
 * The task body. `refs` are data: URLs (the studio is usually not reachable from the internet,
 * so ModelArk can't fetch our files by URL).
 */
export function buildTask({ model, prompt, refs = [], duration = 5, ratio = '16:9', resolution = '720p', seed, audio = false }) {
  const m = MODELS[model]
  if (!m) throw new Error(`unknown model ${model}; use ${Object.keys(MODELS).join(' or ')}`)
  if (!String(prompt ?? '').trim()) throw new Error('the prompt is empty')
  if (refs.length > m.maxRefs) throw new Error(`${model} takes at most ${m.maxRefs} reference images (got ${refs.length})`)
  const want = Number(duration) || 5
  const dur = Math.min(m.maxS, Math.max(m.minS, Math.round(want)))
  const body = {
    model: m.id,
    content: [{ type: 'text', text: String(prompt) },
      ...refs.map(url => ({ type: 'image_url', image_url: { url }, role: 'reference_image' }))],
    resolution, ratio, duration: dur,
    seed: Number.isInteger(seed) ? seed : Math.floor(Math.random() * 2 ** 31),
    watermark: false,
    generate_audio: audio === true,
    return_last_frame: true,
  }
  return { body, trim_to: want < dur ? want : null }
}

async function call(cfg, path, init = {}, signal) {
  if (!cfg.base || !cfg.key) throw new Error('Seedance is not configured (the Keys panel, or SEEDANCE_BASE_URL / SEEDANCE_API_KEY in .env)')
  const res = await fetch(`${cfg.base}/api/v3/contents/generations/tasks${path}`, {
    ...init, signal: signal ?? AbortSignal.timeout(60_000),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.key}`, ...init.headers },
  })
  const text = await res.text()
  let j = null
  try { j = JSON.parse(text) } catch {}
  if (!res.ok) throw Object.assign(new Error(`Seedance ${res.status}: ${(j?.error?.message ?? text).slice(0, 300)}`), { status: res.status })
  if (!j) throw new Error(`Seedance returned something that isn't JSON: ${text.slice(0, 200)}`)
  return j
}

export async function createTask(cfg, body) {
  const j = await call(cfg, '', { method: 'POST', body: JSON.stringify(body) })
  if (!j.id) throw new Error(`Seedance accepted the task but returned no id: ${JSON.stringify(j).slice(0, 200)}`)
  return j.id
}

/** → {state: 'pending'|'succeeded'|'failed', video_url, last_frame_url, usage, error} */
export async function getTask(cfg, id) {
  const j = await call(cfg, `/${encodeURIComponent(id)}`)
  const st = String(j.status ?? '')
  if (st === 'queued' || st === 'running') return { state: 'pending' }
  if (st === 'succeeded') {
    if (!j.content?.video_url) return { state: 'failed', error: 'the task succeeded but returned no video_url' }
    return { state: 'succeeded', video_url: j.content.video_url, last_frame_url: j.content.last_frame_url ?? '', usage: j.usage ?? {} }
  }
  // failed, cancelled, expired, or anything new: all mean "no video is coming"
  return { state: 'failed', error: j.error?.message || j.error?.code || `task ended as ${st || 'unknown'}` }
}

// ---------- self-test ----------
if (import.meta.url === `file://${process.argv[1]}`) {
  const a = await import('node:assert/strict')
  const { createServer } = await import('node:http')

  // The body, field by field.
  const { body, trim_to } = buildTask({ model: 'seedance-2.5', prompt: 'a cat yawns', refs: ['data:image/png;base64,AAAA'], duration: 3, seed: 7 })
  a.equal(body.model, 'dreamina-seedance-2-5-260628')
  a.deepEqual(body.content[1], { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' }, role: 'reference_image' })
  a.equal(body.generate_audio, false, 'audio is sent explicitly, never left to the default (true)')
  a.equal(body.watermark, false)
  a.equal(body.return_last_frame, true)
  a.equal(body.duration, 4, 'a 3 s shot is generated at the 4 s minimum…')
  a.equal(trim_to, 3, '…and the wanted length is kept for the edit')
  a.equal(body.seed, 7)
  a.equal(buildTask({ model: 'seedance-2.0', prompt: 'x', duration: 40 }).body.duration, 15, '2.0 caps at 15 s')
  a.equal(buildTask({ model: 'seedance-2.0', prompt: 'x', duration: 5 }).trim_to, null)
  a.throws(() => buildTask({ model: 'seedance-2.0', prompt: 'x', refs: Array(10).fill('d') }), /at most 9/)
  a.throws(() => buildTask({ model: 'seedance-9', prompt: 'x' }), /unknown model/)
  a.throws(() => buildTask({ model: 'seedance-2.5', prompt: ' ' }), /empty/)
  a.ok(Number.isInteger(buildTask({ model: 'seedance-2.5', prompt: 'x' }).body.seed), 'a random seed per take')

  // The hourly cap.
  a.deepEqual(rateCheck(30, 8, 40), { ok: true, left: 2 })
  const r = rateCheck(36, 8, 40)
  a.equal(r.ok, false); a.equal(r.left, 4); a.match(r.error, /at most 4 more/)
  a.equal(rateCheck(40, 1, 40).ok, false)
  a.equal(limits({ seedance: { per_hour: 10 } }).perHour, 10, 'a project can lower it')
  a.equal(limits({}).concurrent, 4)

  // The client against a fake API: auth header, create → poll → done, and the failure shapes.
  const seen = []
  let polls = 0
  const srv = createServer(async (req, res) => {
    let b = ''; for await (const c of req) b += c
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: b && JSON.parse(b) })
    const send = (code, j) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)) }
    if (req.method === 'POST') return b.includes('"boom"') ? send(400, { error: { message: 'bad prompt' } }) : send(200, { id: 'cgt-1' })
    if (req.url.endsWith('/cgt-1')) return send(200, ++polls < 2 ? { status: 'running' }
      : { status: 'succeeded', content: { video_url: 'http://x/v.mp4', last_frame_url: 'http://x/f.jpg' }, usage: { completion_tokens: 99 } })
    if (req.url.endsWith('/cgt-bad')) return send(200, { status: 'failed', error: { code: 'OutputVideoSensitiveContentDetected', message: 'blocked' } })
    if (req.url.endsWith('/cgt-exp')) return send(200, { status: 'expired' })
    send(404, { error: { message: 'no such task' } })
  })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  const cfg = { base: `http://127.0.0.1:${srv.address().port}/`.replace(/\/$/, ''), key: 'k-123' }
  try {
    a.equal(await createTask(cfg, body), 'cgt-1')
    a.equal(seen[0].url, '/api/v3/contents/generations/tasks')
    a.equal(seen[0].auth, 'Bearer k-123')
    a.equal(seen[0].body.generate_audio, false)
    a.deepEqual(await getTask(cfg, 'cgt-1'), { state: 'pending' })
    const done = await getTask(cfg, 'cgt-1')
    a.equal(done.state, 'succeeded'); a.equal(done.video_url, 'http://x/v.mp4'); a.equal(done.usage.completion_tokens, 99)
    a.deepEqual(await getTask(cfg, 'cgt-bad'), { state: 'failed', error: 'blocked' })
    a.deepEqual(await getTask(cfg, 'cgt-exp'), { state: 'failed', error: 'task ended as expired' })
    await a.rejects(createTask(cfg, { ...body, content: [{ type: 'text', text: 'boom' }] }), /Seedance 400: bad prompt/)
    await a.rejects(getTask(cfg, 'nope'), /404/)
    await a.rejects(createTask({ base: '', key: '' }, body), /not configured/)
  } finally { srv.close() }

  console.log('seedance.mjs: all checks passed')
}
