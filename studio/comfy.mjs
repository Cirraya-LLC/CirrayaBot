// A ComfyUI the boss runs himself ("ComfyUI本地"). Routes checked against ComfyUI's server.py:
//
//   POST /upload/image  multipart `image` (+ overwrite)  → {name, subfolder, type}
//   POST /prompt        {prompt: <API-format workflow>, client_id} → {prompt_id} | 400 {error, node_errors}
//   GET  /history/{id}  → {} while running; {<id>: {status:{status_str}, outputs:{<node>:{images:[…]}}}} when done
//   GET  /view?filename=&subfolder=&type=  → the bytes
//
// The workflow is the project's, not ours: node graphs depend on which checkpoints and LoRAs are
// installed on his machine, so a built-in one would only work by luck. It lives in
// project info as `comfy.workflow` (ComfyUI's "Save (API format)" export), with placeholders:
//
//   "{{prompt}}" "{{negative}}" "{{seed}}" "{{ref}}" "{{ref2}}"… "{{lora}}" "{{lora_strength}}"
//   "{{width}}" "{{height}}"
//
// A string that is exactly "{{seed}}" (or width/height/lora_strength) becomes a number — the
// node inputs are typed and "42" isn't 42.
//
// Self-test: node studio/comfy.mjs (a fake server stands in for ComfyUI)
import { randomUUID } from 'node:crypto'

export const config = () => ({ base: String(process.env.COMFY_URL || '').replace(/\/+$/, '') })

const NUMERIC = new Set(['seed', 'width', 'height', 'lora_strength'])

/** Deep-copy the workflow with placeholders filled. Unknown placeholders are an error, not a blank. */
export function fillWorkflow(workflow, vars) {
  if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow))
    throw new Error('this project has no ComfyUI workflow — a person has to put one in project info (comfy.workflow, API format)')
  const missing = new Set()
  const walk = v => {
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
    if (typeof v !== 'string') return v
    const whole = /^\{\{(\w+)\}\}$/.exec(v)
    if (whole && NUMERIC.has(whole[1]) && vars[whole[1]] !== undefined) return Number(vars[whole[1]])
    return v.replace(/\{\{(\w+)\}\}/g, (m, k) => {
      if (vars[k] === undefined || vars[k] === null) { missing.add(k); return m }
      return String(vars[k])
    })
  }
  const out = walk(workflow)
  if (missing.size) throw new Error(`the ComfyUI workflow needs ${[...missing].map(k => `{{${k}}}`).join(', ')}, which this request didn't provide`)
  return out
}

async function json(res, what) {
  const text = await res.text()
  let j = null
  try { j = JSON.parse(text) } catch {}
  if (!res.ok) {
    const nodeErr = j?.node_errors && Object.values(j.node_errors)[0]?.errors?.[0]?.message
    throw new Error(`ComfyUI ${what} ${res.status}: ${(nodeErr || j?.error?.message || text).slice(0, 300)}`)
  }
  return j
}

export async function upload(cfg, buf, mime, name) {
  const form = new FormData()
  form.set('image', new Blob([buf], { type: mime }), name)
  form.set('overwrite', 'true')
  const j = await json(await fetch(`${cfg.base}/upload/image`, { method: 'POST', body: form, signal: AbortSignal.timeout(60_000) }), 'upload')
  return j.subfolder ? `${j.subfolder}/${j.name}` : j.name
}

/**
 * Run a workflow to the end. refs: [{buf, mime, sha256}] are uploaded first and named by hash,
 * so the same reference isn't uploaded twice under different names.
 */
export async function run(cfg, workflow, vars, refs = [], { timeoutMs = 600_000, pollMs = 2000 } = {}) {
  if (!cfg.base) throw new Error('ComfyUI is not configured (COMFY_URL in .env)')
  const names = []
  for (const r of refs) names.push(await upload(cfg, r.buf, r.mime, `studio-${r.sha256.slice(0, 16)}.${r.mime === 'image/jpeg' ? 'jpg' : 'png'}`))
  const all = { ...vars }
  names.forEach((n, i) => { all[i ? `ref${i + 1}` : 'ref'] = n })
  const prompt = fillWorkflow(workflow, all)
  const { prompt_id } = await json(await fetch(`${cfg.base}/prompt`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt, client_id: randomUUID() }), signal: AbortSignal.timeout(60_000),
  }), 'prompt')
  if (!prompt_id) throw new Error('ComfyUI accepted the workflow but returned no prompt_id')

  const until = Date.now() + timeoutMs
  for (;;) {
    const h = (await json(await fetch(`${cfg.base}/history/${prompt_id}`, { signal: AbortSignal.timeout(30_000) }), 'history'))?.[prompt_id]
    if (h) {
      if (h.status?.status_str === 'error') {
        const msg = (h.status.messages ?? []).find(m => m[0] === 'execution_error')?.[1]?.exception_message
        throw new Error(`ComfyUI failed: ${msg ?? 'execution error'}`)
      }
      const files = Object.values(h.outputs ?? {}).flatMap(o => o.images ?? []).filter(f => f.type === 'output')
      if (!files.length) throw new Error('ComfyUI finished but the workflow saved no image (is there a SaveImage node?)')
      const images = []
      for (const f of files) {
        const q = new URLSearchParams({ filename: f.filename, subfolder: f.subfolder ?? '', type: f.type })
        const r = await fetch(`${cfg.base}/view?${q}`, { signal: AbortSignal.timeout(120_000) })
        if (!r.ok) throw new Error(`ComfyUI /view ${r.status} for ${f.filename}`)
        images.push(Buffer.from(await r.arrayBuffer()))
      }
      return { images, prompt_id }
    }
    if (Date.now() > until) throw new Error(`ComfyUI didn't finish within ${Math.round(timeoutMs / 1000)} s (prompt ${prompt_id} may still be running there)`)
    await new Promise(r => setTimeout(r, pollMs))
  }
}

// ---------- self-test ----------
if (import.meta.url === `file://${process.argv[1]}`) {
  const a = await import('node:assert/strict')
  const { createServer } = await import('node:http')

  const wf = {
    3: { class_type: 'KSampler', inputs: { seed: '{{seed}}', steps: 20 } },
    6: { class_type: 'CLIPTextEncode', inputs: { text: 'masterpiece, {{prompt}}' } },
    7: { class_type: 'CLIPTextEncode', inputs: { text: '{{negative}}' } },
    10: { class_type: 'LoadImage', inputs: { image: '{{ref}}' } },
    11: { class_type: 'LoraLoader', inputs: { lora_name: '{{lora}}', strength_model: '{{lora_strength}}' } },
  }
  const vars = { prompt: 'a boy', negative: 'blurry', seed: '42', lora: 'mangji.safetensors', lora_strength: 0.8, ref: 'r.png' }
  const f = fillWorkflow(wf, vars)
  a.equal(f[3].inputs.seed, 42, 'a whole-string numeric placeholder becomes a number')
  a.equal(f[6].inputs.text, 'masterpiece, a boy')
  a.equal(f[11].inputs.strength_model, 0.8)
  a.equal(wf[3].inputs.seed, '{{seed}}', 'the project\'s workflow is not modified')
  a.throws(() => fillWorkflow(wf, { ...vars, lora: undefined }), /needs \{\{lora\}\}/, 'a missing value is an error, not an empty string')
  a.throws(() => fillWorkflow(null, {}), /no ComfyUI workflow/)

  const png = Buffer.from('89504e470d0a1a0a', 'hex')
  let polls = 0, posted = null, uploads = 0
  const srv = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c)
    const send = (code, j) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)) }
    if (req.url === '/upload/image') { uploads++; return send(200, { name: 'studio-abc.png', subfolder: '', type: 'input' }) }
    if (req.url === '/prompt') {
      posted = JSON.parse(Buffer.concat(chunks))
      if (posted.prompt[6].inputs.text.includes('BAD')) return send(400, { error: { message: 'Prompt outputs failed validation' },
        node_errors: { 6: { errors: [{ message: 'Value not in list: ckpt_name' }] } } })
      return send(200, { prompt_id: 'p1' })
    }
    if (req.url === '/history/p1') return send(200, ++polls < 2 ? {} : { p1: { status: { status_str: 'success' },
      outputs: { 9: { images: [{ filename: 'o.png', subfolder: '', type: 'output' }, { filename: 't.png', subfolder: '', type: 'temp' }] } } } })
    if (req.url.startsWith('/view?filename=o.png')) { res.writeHead(200); return res.end(png) }
    send(404, {})
  })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  const cfg = { base: `http://127.0.0.1:${srv.address().port}` }
  try {
    const out = await run(cfg, wf, { ...vars, ref: undefined }, [{ buf: png, mime: 'image/png', sha256: 'a'.repeat(64) }], { pollMs: 10 })
    a.equal(uploads, 1)
    a.equal(posted.prompt[10].inputs.image, 'studio-abc.png', 'the uploaded name fills {{ref}}')
    a.equal(out.images.length, 1, 'only type=output images, not previews')
    a.deepEqual(out.images[0], png)
    await a.rejects(run(cfg, wf, { ...vars, prompt: 'BAD' }, [], { pollMs: 10 }), /Value not in list: ckpt_name/,
      'a node error is reported by what the node said')
    await a.rejects(run({ base: '' }, wf, vars), /not configured/)
  } finally { srv.close() }
  console.log('comfy.mjs: all checks passed')
}
