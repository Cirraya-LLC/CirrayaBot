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
import { parseActor, deny, ROLES } from './roles.mjs'

const CFG = {
  token: process.env.STUDIO_TOKEN || '',
  port: Number(process.env.STUDIO_PORT || 8090),
  data: process.env.STUDIO_DATA || '/data',
}
export const store = createStore(CFG.data)

/** An error the caller should see as-is: 4xx, a stable code, an English sentence an agent can act on. */
export class StudioError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status }
}
const fail = (code, message, status) => { throw new StudioError(code, message, status) }

const slugOk = s => /^[a-z0-9][a-z0-9-]{0,39}$/.test(String(s ?? ''))
const text = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '')

/** The caller's current project, or a clear instruction to pick one. */
async function projectOf(actorKey, args = {}) {
  const id = text(args.project) || await db.currentProject(actorKey)
  if (!id) fail('no_project', 'no current project — run project.use with a project slug first (project.list shows them)')
  const p = await db.getProject(id)
  if (!p) fail('no_such_project', `there is no project "${id}" (project.list shows them)`, 404)
  return p
}

const projectView = p => ({ id: p.id, name: p.name, notify_group: p.notify_group, info: p.info })

// action → handler(args, ctx). ctx = {actor, actorKey, role}. Phase 1: projects and the crew.
const HANDLERS = {
  'project.list': async () => (await db.listProjects()).map(p => ({ id: p.id, name: p.name })),

  'project.current': async (_a, ctx) => {
    const id = await db.currentProject(ctx.actorKey)
    return id ? { project: id } : { project: null, hint: 'run project.use <slug>' }
  },

  'project.use': async (a, ctx) => {
    const p = await db.getProject(text(a.project))
    if (!p) fail('no_such_project', `there is no project "${text(a.project)}" (project.list shows them)`, 404)
    await db.useProject(ctx.actorKey, p.id)
    return { project: p.id, name: p.name }
  },

  'project.info': async (a, ctx) => projectView(await projectOf(ctx.actorKey, a)),

  'project.create': async a => {
    if (!slugOk(a.id)) fail('bad_slug', 'project id must be lowercase letters, digits and dashes (max 40)')
    const name = text(a.name, 80)
    if (!name) fail('name_required', 'a project needs a name')
    if (await db.getProject(a.id)) fail('exists', `project "${a.id}" already exists`, 409)
    return projectView(await db.createProject({ id: a.id, name, info: a.info === undefined ? {} : objOr(a.info), notify_group: text(a.notify_group, 80) }))
  },

  'project.edit': async a => {
    const p = await db.getProject(text(a.project))
    if (!p) fail('no_such_project', `there is no project "${text(a.project)}"`, 404)
    return projectView(await db.updateProject(p.id, {
      name: a.name === undefined ? undefined : text(a.name, 80) || p.name,
      info: a.info === undefined ? undefined : objOr(a.info),
      notify_group: a.notify_group === undefined ? undefined : text(a.notify_group, 80),
    }))
  },

  'crew.set': async a => {
    const id = text(a.agent_id, 63)
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) fail('bad_agent', 'agent_id must be a platform agent id')
    const role = a.role ? text(a.role, 30) : null
    if (role && !ROLES.includes(role)) fail('bad_role', `role must be one of ${ROLES.join(' / ')}, or empty to remove`)
    await db.setRole(id, role)
    return { agent_id: id, role }
  },
}

function objOr(v) {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v
  fail('bad_info', 'info must be a JSON object')
}

// ---------- HTTP ----------
function authorized(req) {
  const got = Buffer.from(String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''))
  const want = Buffer.from(CFG.token)
  return got.length === want.length && timingSafeEqual(got, want)
}

async function readJson(req, max = 1 << 20) {
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
      const result = await handler(args && typeof args === 'object' ? args : {}, { actor, actorKey, role })
      // Reads aren't audited: they are most of the traffic and change nothing.
      if (!/\.(list|show|refs|current|info|history)$/.test(action)) await db.audit(actorKey, action, args.project ?? args.id ?? '', true)
      return send(200, { ok: true, result })
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
server.listen(CFG.port, '0.0.0.0', () => console.log(`studio listening on :${CFG.port}, files in ${CFG.data}`))
