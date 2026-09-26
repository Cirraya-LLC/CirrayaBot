// The platform's side of the film studio (studio/): the `studio` tool agents call, and the
// helpers the workbench (web UI) and the event endpoint use.
//
// Agents never talk to the studio themselves. This process holds STUDIO_TOKEN and says which
// agent it is acting for — the identity comes from code, so no model can claim to be the
// director. The studio decides what that agent may do (studio/roles.mjs).
//
// Self-test: node web/studio.mjs (a fake studio stands in)
import { env } from './env.mjs'

const URL_ = () => String(env.STUDIO_URL || '').replace(/\/+$/, '')
export const enabled = () => !!(URL_() && env.STUDIO_TOKEN)

// The name the studio's messages carry in group logs. A data marker like 'User': stored, compared,
// never translated. No agent may take it (checkAgent), or it would read the studio's notices as its own.
export const STUDIO_SPEAKER = 'Studio'

/** One studio action. Never throws for a refusal: {ok:false, status, error:{code, message}}. */
export async function call(actor, action, args = {}, { timeoutMs = 330_000 } = {}) {
  if (!enabled()) return { ok: false, status: 503, error: { code: 'no_studio', message: 'the studio is not configured on this deployment' } }
  let res
  try {
    res = await fetch(`${URL_()}/v1/call`, {
      method: 'POST', signal: AbortSignal.timeout(timeoutMs),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.STUDIO_TOKEN}`, 'x-studio-actor': actor },
      body: JSON.stringify({ action, args }),
    })
  } catch (e) {
    return { ok: false, status: 503, error: { code: 'unreachable', message: `the studio is not reachable (${e.cause?.code ?? e.message})` } }
  }
  const j = await res.json().catch(() => null)
  return j ? { ...j, status: res.status } : { ok: false, status: res.status, error: { code: 'bad_reply', message: `the studio answered ${res.status} with no JSON` } }
}

/** An asset's bytes (images for the model and the panel). */
export async function file(assetId) {
  const res = await fetch(`${URL_()}/v1/files/${encodeURIComponent(assetId)}`, {
    headers: { authorization: `Bearer ${env.STUDIO_TOKEN}` }, signal: AbortSignal.timeout(60_000) })
  if (!res.ok) throw new Error(`studio file ${assetId}: HTTP ${res.status}`)
  return { buf: Buffer.from(await res.arrayBuffer()), mime: res.headers.get('content-type') ?? 'application/octet-stream' }
}

/**
 * An asset as a stream, for the browser: a Range header passes through, so a <video> can seek.
 * Returns the studio's Response (status 200/206/416), or throws when the studio can't be reached.
 */
export function fileStream(assetId, range) {
  return fetch(`${URL_()}/v1/files/${encodeURIComponent(assetId)}`, {
    headers: { authorization: `Bearer ${env.STUDIO_TOKEN}`, ...range ? { range } : {} } })
}

// Who is on the crew, asked of the studio and kept for half a minute: every agent turn asks, and
// a role changed in the panel should show up without a restart.
let crew = { at: 0, map: new Map() }
export async function roleOf(agentId) {
  if (!enabled()) return null
  if (Date.now() - crew.at > 30_000) {
    const r = await call('human', 'crew.list', {}, { timeoutMs: 5000 })
    // The studio being down must not take the chat with it: no role → no tool this turn.
    crew = { at: Date.now(), map: r.ok ? new Map(r.result.map(c => [c.agent_id, c.role])) : crew.map }
  }
  return crew.map.get(agentId) ?? null
}
export const forgetCrew = () => { crew = { at: 0, map: new Map() } }

// The skills write commands the way a CLI would ("studio char refs 蛮吉 --look 战斗装 --angle 3-4").
// The tool takes the same thing as {action, args}; this table says what the positional word is.
const POSITIONAL = {
  'project.use': 'project', 'char.show': 'name', 'char.refs': 'name', 'char.add': 'name', 'char.edit': 'name',
  'look.add': 'character', 'look.edit': 'character', 'loc.show': 'name', 'loc.refs': 'name', 'loc.add': 'name',
  'loc.edit': 'name', 'asset.show': 'id', 'asset.tag': 'id', 'asset.edit': 'id', 'asset.save': 'path',
  'scene.show': 'code', 'scene.add': 'code', 'shot.plan': 'scene', 'shot.show': 'shot', 'shot.prompt': 'shot',
  'shot.gen': 'shot', 'shot.sheet': 'shot', 'shot.approve': 'shot', 'shot.reject': 'shot', 'shot.lock': 'scene',
  'review.history': 'shot', 'episode.show': 'episode', 'episode.submit': 'episode', 'episode.assemble': 'episode',
  'char.voice': 'name', 'order.done': 'id',
}

export const TOOL = { type: 'function', function: {
  name: 'studio',
  description: 'The film studio (a short-drama series): episodes, scenes, shots, characters, locations, assets, generation, review, work orders. ' +
    'Your skills write its commands CLI-style; call them here as {action, args}: "studio char refs 蛮吉 --look 战斗装 --angle 3-4" is ' +
    '{"action":"char.refs","args":{"name":"蛮吉","look":"战斗装","angle":"3-4"}}. The first word after the command goes in: ' +
    Object.entries(POSITIONAL).map(([k, v]) => `${k}→${v}`).join(', ') + '. ' +
    'Files: asset.save takes {path} of a file on your machine; shot.plan takes {scene, shots:[…]} or {scene, file} (a JSON file on your machine). ' +
    'shot.sheet returns the contact sheet as an image you can see. asset.show with {"view":true} shows you an image asset. ' +
    'Work comes to you as numbered work orders in your chat; the studio closes each one when it sees the work done — ' +
    'you don\'t hand work over with @ (order.list shows yours; order.done {id, note} only for the ones that say so). ' +
    'Episodes: episode.list / episode.show {episode}; a scene belongs to one (scene.add {code, episode, title, script}). ' +
    'Dialogue goes in each shot of shot.plan: "dialogue":[{"speaker":"蛮吉","text":"走！","kind":"onscreen"}] — kind onscreen (spoken on camera; ' +
    'the studio adds it to the Seedance prompt and turns sound on), offscreen, or narration (no speaker; both spoken by TTS). ' +
    'Answers are JSON. A refusal says why — report it as it is; don\'t work around a permission.',
  parameters: { type: 'object', required: ['action'], properties: {
    action: { type: 'string', description: 'e.g. project.info, char.show, shot.gen, shot.sheet, shot.reject' },
    args: { type: 'object', description: 'the command\'s options, e.g. {"shot":"S03-SH004","model":"seedance-2.5","n":4}' } } } } }

const clip = (s, n = 12_000) => (s.length > n ? `${s.slice(0, n)}\n… (truncated, ${s.length} characters)` : s)

/**
 * Run one studio tool call for an agent. Returns text, or {text, image} when the model should see
 * a picture. `readFile(path)` reads a file on the agent's own machine (null when it has none).
 */
export async function runTool(args, ctx, { readFile } = {}) {
  const action = String(args?.action ?? '').trim()
  // Models sometimes flatten the args into the call itself; take them either way.
  const a = { ...(args?.args && typeof args.args === 'object' ? args.args : Object.fromEntries(Object.entries(args ?? {}).filter(([k]) => k !== 'action'))) }
  if (!action) return 'Say which studio action (e.g. "project.info").'

  // Files on the agent's machine go to the studio as bytes: the studio can't see his container.
  if (action === 'asset.save' && a.path && !a.data_b64) {
    if (!readFile) return 'You have no machine of your own on this deployment, so there is no file to save.'
    const f = await readFile(String(a.path), 25 * 1024 ** 2)
    if (f.error) return `Could not read ${a.path}: ${f.error}`
    a.data_b64 = f.buf.toString('base64'); delete a.path
  }
  if (action === 'shot.plan' && a.file && !a.shots) {
    if (!readFile) return 'You have no machine of your own; pass the shots inline as {scene, shots:[…]}.'
    const f = await readFile(String(a.file), 2 * 1024 ** 2)
    if (f.error) return `Could not read ${a.file}: ${f.error}`
    let parsed
    try { parsed = JSON.parse(f.buf.toString('utf8')) } catch (e) { return `${a.file} is not valid JSON: ${e.message}` }
    a.shots = Array.isArray(parsed) ? parsed : parsed?.shots
    delete a.file
  }

  const r = await call(`agent:${ctx.bot.id}`, action, a)
  if (!r.ok) return `Studio refused ${action} (${r.error?.code}): ${r.error?.message}`
  const text = clip(JSON.stringify(r.result, null, 1))

  // Pictures the model must actually see: the contact sheet, or an image it asked to view.
  const imageId = action === 'shot.sheet' ? r.result?.sheet?.id
    : action === 'asset.show' && a.view && String(r.result?.mime ?? '').startsWith('image/') ? r.result.id : null
  if (!imageId) return text
  if (ctx.noImages) return `${text}\n\nThe image exists, but the model you run on can't see images, so you have NOT seen it. ` +
    'Do not judge anything from it and do not guess. Tell the user this job needs a model that accepts images.'
  try {
    const { buf, mime } = await file(imageId)
    return { text: `${text}\n\nThe image (${imageId}) is attached to the next message.`, image: `data:${mime};base64,${buf.toString('base64')}` }
  } catch (e) {
    return `${text}\n\nThe image could not be fetched (${e.message}), so you have NOT seen it — don't judge from it.`
  }
}

// What the web UI (a person, holding ACCESS_TOKEN) may do through the platform: set up projects and
// the crew, lock what is final, write the script into scenes, and — in the workbench — review: a
// person may approve, reject and pick takes, as the reviewer does (the boss, 2026-09-25). It does
// not generate: prompts and takes stay the crew's work.
export const PANEL_ACTIONS = new Set([
  'project.list', 'project.info', 'project.create', 'project.edit', 'project.board',
  'crew.list', 'crew.set',
  'char.list', 'char.show', 'char.refs', 'char.lock', 'char.unlock',
  'loc.list', 'loc.show', 'loc.refs', 'loc.lock', 'loc.unlock',
  'scene.list', 'scene.show', 'scene.add', 'scene.edit', 'shot.lock',
  'shot.show', 'shot.detail', 'review.history', 'asset.show',
  'shot.sheet', 'shot.approve', 'shot.reject', 'shot.reopen',
  // The pipeline's gates and the series itself are a person's (studio/roles.mjs).
  'episode.list', 'episode.show', 'episode.add', 'episode.edit', 'episode.start', 'episode.review', 'episode.assemble',
  'order.list', 'char.voice', 'project.bgm',
  // The Keys panel: the studio's model keys (studio/keys.mjs). The answer carries hints, never keys.
  'keys.get', 'keys.set', 'keys.test',
])

// ---------- self-test ----------
if (import.meta.url === `file://${process.argv[1]}`) {
  const a = await import('node:assert/strict')
  const { createServer } = await import('node:http')
  const png = Buffer.from('89504e470d0a1a0a0000', 'hex')
  const seen = []
  const srv = createServer(async (req, res) => {
    let b = ''; for await (const c of req) b += c
    const send = (code, j) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)) }
    if (req.headers.authorization !== 'Bearer tok-123') return send(401, { ok: false, error: { code: 'unauthorized', message: 'no' } })
    if (req.url.startsWith('/v1/files/')) { res.writeHead(200, { 'content-type': 'image/jpeg' }); return res.end(png) }
    const body = JSON.parse(b); seen.push({ actor: req.headers['x-studio-actor'], ...body })
    if (body.action === 'crew.list') return send(200, { ok: true, result: [{ agent_id: 'rev', role: 'reviewer' }] })
    if (body.action === 'shot.sheet') return send(200, { ok: true, result: { shot: 'S1', sheet: { id: 'as_sheet', mime: 'image/jpeg' } } })
    if (body.action === 'shot.approve') return send(403, { ok: false, error: { code: 'forbidden', message: 'shot.approve is not part of the art\'s job' } })
    send(200, { ok: true, result: { echo: body.args } })
  })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  env.STUDIO_URL = `http://127.0.0.1:${srv.address().port}`; env.STUDIO_TOKEN = 'tok-123'
  try {
    a.equal(await roleOf('rev'), 'reviewer')
    a.equal(await roleOf('someone'), null, 'not on the crew → no tool')
    const ctx = { bot: { id: 'rev' } }

    const r1 = await runTool({ action: 'shot.sheet', args: { shot: 'S1' } }, ctx)
    a.equal(seen.at(-1).actor, 'agent:rev', 'the actor is who the platform says, not a model argument')
    a.match(r1.image, /^data:image\/jpeg;base64,/, 'the sheet comes back as a picture')
    const blind = await runTool({ action: 'shot.sheet', args: { shot: 'S1' } }, { ...ctx, noImages: true })
    a.equal(typeof blind, 'string'); a.match(blind, /have NOT seen it/, 'a model without vision is told so, not handed a guess')

    a.match(await runTool({ action: 'shot.approve', args: { shot: 'S1', pick: 1 } }, ctx), /Studio refused shot.approve \(forbidden\)/)
    // Flattened args still arrive; an actor can't be smuggled in through them.
    await runTool({ action: 'char.show', name: '蛮吉', actor: 'human' }, ctx)
    a.deepEqual(seen.at(-1).args, { name: '蛮吉', actor: 'human' }); a.equal(seen.at(-1).actor, 'agent:rev')

    // Files come off the agent's machine as bytes.
    const read = async (p, max) => (p === '/work/a.png' ? { buf: png } : { error: 'No such file' })
    await runTool({ action: 'asset.save', args: { path: '/work/a.png', kind: 'turnaround' } }, ctx, { readFile: read })
    a.equal(seen.at(-1).args.data_b64, png.toString('base64')); a.equal(seen.at(-1).args.path, undefined)
    a.match(await runTool({ action: 'asset.save', args: { path: '/nope' } }, ctx, { readFile: read }), /Could not read \/nope: No such file/)
    a.match(await runTool({ action: 'asset.save', args: { path: '/work/a.png' } }, ctx), /no machine/)
    const plan = async () => ({ buf: Buffer.from(JSON.stringify({ shots: [{ id: 'S1-SH1' }] })) })
    await runTool({ action: 'shot.plan', args: { scene: 'S1', file: 'shots.json' } }, ctx, { readFile: plan })
    a.deepEqual(seen.at(-1).args, { scene: 'S1', shots: [{ id: 'S1-SH1' }] })

    env.STUDIO_TOKEN = 'wrong'
    a.equal((await call('human', 'project.list')).status, 401)
    env.STUDIO_URL = 'http://127.0.0.1:1'; env.STUDIO_TOKEN = 'x'
    const down = await call('human', 'project.list')
    a.equal(down.ok, false); a.equal(down.error.code, 'unreachable')
  } finally { srv.close() }
  console.log('studio.mjs: all checks passed')
}
