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
// Model API keys (Seedance, GPT image, ComfyUI) live only here: in this container's environment,
// or typed into the platform's Keys panel and stored in this service's own table (keys.mjs).
import { createServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { access, mkdir, constants } from 'node:fs/promises'
import * as db from './db.mjs'
import { createStore, byteRange } from './store.mjs'
import { parseActor, deny } from './roles.mjs'
import { makeActions, StudioError, fail } from './actions.mjs'
import { startWorker } from './worker.mjs'
import { startNotifier } from './notify.mjs'
import { setPanel } from './keys.mjs'
import { plan } from './pipeline.mjs'

const CFG = {
  token: process.env.STUDIO_TOKEN || '',
  port: Number(process.env.STUDIO_PORT || 8090),
  data: process.env.STUDIO_DATA || '/data',
}
const store = createStore(CFG.data)
let worker = null
// After a change, the pipeline looks at that project again (a moment later, once per burst).
const planSoon = new Map()
const kick = pid => {
  if (!pid || planSoon.has(pid)) return
  planSoon.set(pid, setTimeout(() => { planSoon.delete(pid); plan(pid).catch(e => console.error(`pipeline: ${pid}: ${e.message}`)) }, 300))
}
const actions = makeActions({ store, kick, kickWorker: () => worker?.kick() })
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
      const { action, args: rawArgs = {} } = await readJson(req)
      const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? { ...rawArgs } : {}
      const role = actor.kind === 'agent' ? await db.roleOf(actor.id) : null
      const why = deny(actor, role, String(action ?? ''))
      if (why) {
        await db.audit(actorKey, String(action ?? ''), '', false, why)
        return send(403, { ok: false, error: { code: 'forbidden', message: why } })
      }
      // Fixed crew members cannot enumerate, switch to, read or mutate another film.
      // This is enforced here even if a client omits/misroutes its current-project pointer.
      const bound = actor.kind === 'agent'
        ? (await db.q('select project_id from crew where agent_id=$1', [actor.id])).rows[0]?.project_id : null
      if (bound) {
        if (args.project != null && args.project !== '' && args.project !== bound)
          fail('project_scope', 'This crew member belongs to a different project.', 403)
        args.project = bound
        if (action === 'project.list') {
          const p = await db.getProject(bound)
          return send(200, { ok: true, result: [{ id: p.id, name: p.name }] })
        }
        if (action === 'project.current') return send(200, { ok: true, result: { project: bound } })
      }
      const handler = HANDLERS[action]
      if (!handler) return send(501, { ok: false, error: { code: 'not_implemented', message: `${action} is not available yet` } })
      const result = await handler(args && typeof args === 'object' ? args : {}, { actor, actorKey, role }, action)
      // Reads aren't audited: they are most of the traffic and change nothing. A key edit is, by
      // name only — the audit table must never hold a key.
      if (!/\.(list|show|refs|current|info|history|get|board|detail)$/.test(action)) {
        await db.audit(actorKey, action, action.startsWith('keys.') ? String(args.name ?? '') : args.project ?? args.id ?? '', true)
        kick(args.project || await db.currentProject(actorKey))
      }
      return send(200, { ok: true, result })
    }
    // The bytes of an asset, for the platform: a sheet the reviewer's model must see, a video a
    // person plays. Immutable, so cacheable forever by its sha.
    const fm = url.pathname.match(/^\/v1\/files\/([\w-]{1,60})$/)
    if (fm && (req.method === 'GET' || req.method === 'HEAD')) {
      const a = (await db.q('select sha256, mime, bytes from assets where id = $1', [fm[1]])).rows[0]
      if (!a || !await store.has(a.sha256)) return send(404, { ok: false, error: { code: 'no_such_asset', message: `no asset ${fm[1]}` } })
      const head = { 'content-type': a.mime, etag: `"${a.sha256}"`, 'cache-control': 'private, max-age=31536000, immutable', 'accept-ranges': 'bytes' }
      // A <video> seeks with Range requests; without 206 it can only play from the start.
      const range = byteRange(req.headers.range, Number(a.bytes))
      if (range === false) { res.writeHead(416, { 'content-range': `bytes */${a.bytes}` }); return res.end() }
      if (range) res.writeHead(206, { ...head, 'content-length': range.end - range.start + 1, 'content-range': `bytes ${range.start}-${range.end}/${a.bytes}` })
      else res.writeHead(200, { ...head, 'content-length': a.bytes })
      if (req.method === 'HEAD') return res.end()
      return store.open(a.sha256, range ?? undefined).pipe(res)
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
setPanel(await db.getConfig())
// A finished round becomes a line in the outbox: "candidates ready" for the reviewer, or "all
// failed" for the cinematographer. The notifier delivers the outbox to the project's group.
worker = startWorker({ store, stash: actions.stash, stashText: actions.stashText, addAsset: actions.addAsset,
  newGeneration: actions.newGeneration, finishGeneration: actions.finishGeneration,
  // A finished round: the pipeline gives the reviewer (or, if every take failed, the cinematographer) a work order.
  onRoundDone: r => kick(r.project_id) })
startNotifier()
server.listen(CFG.port, '0.0.0.0', () => console.log(`studio listening on :${CFG.port}, files in ${CFG.data}`))
