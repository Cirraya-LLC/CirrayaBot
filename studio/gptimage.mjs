// GPT image: OpenAI's Images API, straight to OpenAI or through a relay that speaks it.
//
//   POST {base}/images/generations   JSON        {model, prompt, n, size, quality, output_format}
//   POST {base}/images/edits         multipart   image (or image[] for several), mask, prompt, …
//   → {data: [{b64_json} | {url}], usage}
//
// Shapes checked against openai-openapi's spec (2026-09-25), not memory. `base` includes /v1,
// the same convention as the platform's upstreams (https://api.openai.com/v1).
//
// Self-test: node studio/gptimage.mjs (a fake server stands in for the API)

const env = process.env

export const config = () => ({
  base: String(env.GPT_IMAGE_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
  key: env.GPT_IMAGE_API_KEY || '',
  model: env.GPT_IMAGE_MODEL || 'gpt-image-1',
})

export const SIZES = ['auto', '1024x1024', '1536x1024', '1024x1536']
export const QUALITIES = ['auto', 'low', 'medium', 'high']

function need(cfg) {
  if (!cfg.key) throw new Error('GPT image is not configured (GPT_IMAGE_API_KEY in .env)')
}

/** Every image in the answer as a Buffer — b64 inline, or fetched when the relay returns URLs. */
async function images(res) {
  const text = await res.text()
  let j = null
  try { j = JSON.parse(text) } catch {}
  if (!res.ok) throw new Error(`GPT image ${res.status}: ${(j?.error?.message ?? text).slice(0, 300)}`)
  const out = []
  for (const d of j?.data ?? []) {
    if (d.b64_json) out.push(Buffer.from(d.b64_json, 'base64'))
    else if (d.url) {
      const r = await fetch(d.url, { signal: AbortSignal.timeout(120_000) })
      if (!r.ok) throw new Error(`GPT image returned a URL that failed to download (${r.status})`)
      out.push(Buffer.from(await r.arrayBuffer()))
    }
  }
  if (!out.length) throw new Error('GPT image returned no image (a refusal usually looks like this)')
  return { images: out, usage: j.usage ?? {} }
}

export async function generate(cfg, { prompt, n = 1, size = 'auto', quality = 'auto' }) {
  need(cfg)
  const res = await fetch(`${cfg.base}/images/generations`, {
    method: 'POST', signal: AbortSignal.timeout(300_000),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.key}` },
    body: JSON.stringify({ model: cfg.model, prompt, n, size, quality, output_format: 'png' }),
  })
  return images(res)
}

/** refs: [{buf, mime}] — the first is the image being edited; mask: {buf, mime} | null */
export async function edit(cfg, { prompt, refs, mask = null, size = 'auto', quality = 'auto' }) {
  need(cfg)
  if (!refs?.length) throw new Error('an edit needs at least one source image')
  const form = new FormData()
  form.set('model', cfg.model)
  form.set('prompt', prompt)
  form.set('size', size)
  form.set('quality', quality)
  const field = refs.length > 1 ? 'image[]' : 'image'
  refs.forEach((r, i) => form.append(field, new Blob([r.buf], { type: r.mime }), `ref${i}.${ext(r.mime)}`))
  if (mask) form.set('mask', new Blob([mask.buf], { type: mask.mime }), `mask.${ext(mask.mime)}`)
  const res = await fetch(`${cfg.base}/images/edits`, {
    method: 'POST', signal: AbortSignal.timeout(300_000),
    headers: { authorization: `Bearer ${cfg.key}` }, body: form,
  })
  return images(res)
}

const ext = mime => ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' })[mime] ?? 'png'

// ---------- self-test ----------
if (import.meta.url === `file://${process.argv[1]}`) {
  const a = await import('node:assert/strict')
  const { createServer } = await import('node:http')
  const png = Buffer.from('89504e470d0a1a0a', 'hex')
  const seen = []
  const srv = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c)
    const raw = Buffer.concat(chunks)
    seen.push({ url: req.url, auth: req.headers.authorization, type: req.headers['content-type'], raw })
    const send = (code, j) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)) }
    if (req.url === '/v1/images/generations') {
      const b = JSON.parse(raw)
      if (b.prompt === 'refuse') return send(400, { error: { message: 'safety system' } })
      if (b.prompt === 'by-url') return send(200, { data: [{ url: `http://127.0.0.1:${srv.address().port}/file.png` }] })
      return send(200, { data: Array(b.n).fill({ b64_json: png.toString('base64') }), usage: { total_tokens: 5 } })
    }
    if (req.url === '/v1/images/edits') return send(200, { data: [{ b64_json: png.toString('base64') }] })
    if (req.url === '/file.png') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(png) }
    send(404, {})
  })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  const cfg = { base: `http://127.0.0.1:${srv.address().port}/v1`, key: 'sk-x', model: 'gpt-image-1' }
  try {
    const g = await generate(cfg, { prompt: 'a turnaround sheet', n: 2 })
    a.equal(g.images.length, 2); a.deepEqual(g.images[0], png); a.equal(g.usage.total_tokens, 5)
    const sent = JSON.parse(seen[0].raw)
    a.equal(sent.model, 'gpt-image-1'); a.equal(sent.output_format, 'png'); a.equal(seen[0].auth, 'Bearer sk-x')

    a.deepEqual((await generate(cfg, { prompt: 'by-url' })).images[0], png, 'a relay answering with URLs works too')
    await a.rejects(generate(cfg, { prompt: 'refuse' }), /GPT image 400: safety system/)

    await edit(cfg, { prompt: 'fix the hair', refs: [{ buf: png, mime: 'image/png' }, { buf: png, mime: 'image/png' }],
      mask: { buf: png, mime: 'image/png' } })
    const e = seen.at(-1)
    a.match(e.type, /^multipart\/form-data/)
    const body = e.raw.toString('latin1')
    a.equal((body.match(/name="image\[\]"/g) ?? []).length, 2, 'several sources go as image[]')
    a.match(body, /name="mask"/)
    await edit(cfg, { prompt: 'x', refs: [{ buf: png, mime: 'image/png' }] })
    a.match(seen.at(-1).raw.toString('latin1'), /name="image"; filename/, 'one source goes as image')

    await a.rejects(generate({ ...cfg, key: '' }, { prompt: 'x' }), /not configured/)
  } finally { srv.close() }
  console.log('gptimage.mjs: all checks passed')
}
