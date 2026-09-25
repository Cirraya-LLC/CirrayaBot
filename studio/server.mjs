// The studio: asset library, shot state machine, model adapters, contact sheets.
//
// It is an INTERNAL service. Nothing is published on a host port; the only caller is the
// platform (web/server.mjs), over the compose network. Agents never talk to it directly —
// they call the platform's `studio` tool, and the platform calls here on their behalf,
// saying who they are. So:
//   - agent containers hold no token and no model key, and can't reach this service at all;
//   - identity (x-studio-actor) is set by code, never by a model.
//
// One RPC endpoint, POST /v1/call {action, args}, because permissions are per action
// (roles.mjs) and one door is one place to check them.
//
// Model API keys (Seedance, GPT image, ComfyUI) live only in this container's environment.
import { createServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { access, mkdir, constants } from 'node:fs/promises'
import * as db from './db.mjs'
import { createStore } from './store.mjs'
import { parseActor, deny } from './roles.mjs'
import { makeActions, StudioError, fail } from './actions.mjs'
import { startWorker } from './worker.mjs'

const CFG = {
  token: process.env.STUDIO_TOKEN || '',
  port: Number(process.env.STUDIO_PORT || 8090),
  data: process.env.STUDIO_DATA || '/data',
}
const store = createStore(CFG.data)
let worker = null
const actions = makeActions({ store, kick: () => worker?.kick() })
const HANDLERS = actions.handlers

// ---------- HTTP ----------
function authorized(req) {
  const got = Buffer.from(String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''))
  const want = Buffer.from(CFG.token)
  return got.length === want.length && timingSafeEqual(got, want)
}

// Agents save images through the platform as base64 (asset.save): 25 MB of image is ~34 MB here.
async function readJson(req, max = 40 << 20) {
  let n = 0, chunks = []
  for await (const c of req) { n += c.length; if (n > max) fail('too_large', 'request body too large', 413); chunks.push(c) }
  if (!n) return {}
  try { const v = JSON.parse(Buffer.concat(chunks)); if (v && typeof v === 'object' && !Array.isArray(v)) return v } catch {}
  fail('bad_json', 'body must be a JSON object')
}

const server = createServer(async (req, res) => {
  const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)) }
  const url = new URL(req.url, 'http://x')
  try {
    // No auth, no data: compose's health check has no token.
    if (url.pathname === '/healthz') {
      await db.q('select 1')
      await access(CFG.data, constants.W_OK)
      return send(200, { ok: true })
    }
    if (!authorized(req)) return send(401, { ok: false, error: { code: 'unauthorized', message: 'bad or missing studio token' } })

    if (url.pathname === '/v1/call' && req.method === 'POST') {
      const actor = parseActor(req.headers['x-studio-actor'])
      if (!actor) return send(400, { ok: false, error: { code: 'no_actor', message: 'x-studio-actor must be "human" or "agent:<id>"' } })
      const actorKey = actor.kind === 'human' ? 'human' : `agent:${actor.id}`
      const { action, args = {} } = await readJson(req)
      const role = actor.kind === 'agent' ? await db.roleOf(actor.id) : null
      const why = deny(actor, role, String(action ?? ''))
      if (why) {
        await db.audit(actorKey, String(action ?? ''), '', false, why)
        return send(403, { ok: false, error: { code: 'forbidden', message: why } })
      }
      const handler = HANDLERS[action]
      if (!handler) return send(501, { ok: false, error: { code: 'not_implemented', message: `${action} is not available yet` } })
      const result = await handler(args && typeof args === 'object' ? args : {}, { actor, actorKey, role }, action)
      // Reads aren't audited: they are most of the traffic and change nothing.
      if (!/\.(list|show|refs|current|info|history)$/.test(action)) await db.audit(actorKey, action, args.project ?? args.id ?? '', true)
      return send(200, { ok: true, result })
    }
    // The bytes of an asset, for the platform: a sheet the reviewer's model must see, a video a
    // person plays. Immutable, so cacheable forever by its sha.
    const fm = url.pathname.match(/^\/v1\/files\/([\w-]{1,60})$/)
    if (fm && (req.method === 'GET' || req.method === 'HEAD')) {
      const a = (await db.q('select sha256, mime, bytes from assets where id = $1', [fm[1]])).rows[0]
      if (!a || !await store.has(a.sha256)) return send(404, { ok: false, error: { code: 'no_such_asset', message: `no asset ${fm[1]}` } })
      res.writeHead(200, { 'content-type': a.mime, 'content-length': a.bytes, etag: `"${a.sha256}"`, 'cache-control': 'private, max-age=31536000, immutable' })
      if (req.method === 'HEAD') return res.end()
      return store.open(a.sha256).pipe(res)
    }
    return send(404, { ok: false, error: { code: 'not_found', message: 'no such endpoint' } })
  } catch (e) {
    if (e instanceof StudioError) return send(e.status, { ok: false, error: { code: e.code, message: e.message } })
    console.error(e)
    return send(500, { ok: false, error: { code: 'internal', message: String(e.message ?? e).slice(0, 300) } })
  }
})

// ---------- startup ----------
if (!CFG.token || CFG.token.length < 16) {
  console.error('Refusing to start: STUDIO_TOKEN is missing or shorter than 16 characters (./start.sh generates it).')
  process.exit(1)
}
await mkdir(CFG.data, { recursive: true })
await db.connect()
await db.migrate()
// Phase 3 turns a finished round into a message in the project's group ("@reviewer candidates
// ready"); until then it is logged, so nothing finishes unseen.
worker = startWorker({ store, stash: actions.stash, addAsset: actions.addAsset, finishGeneration: actions.finishGeneration,
  onRoundDone: r => console.log(`round done: ${r.shot} ${r.ok} ok / ${r.failed} failed → ${r.status}`) })
server.listen(CFG.port, '0.0.0.0', () => console.log(`studio listening on :${CFG.port}, files in ${CFG.data}`))
