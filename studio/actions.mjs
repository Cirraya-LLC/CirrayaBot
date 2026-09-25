// Every studio action: what the crew's skills call "studio char show", "studio shot gen"…
// Permission is checked before any of this runs (roles.mjs); here each action checks the data:
// the project, the state machine (shots.mjs), locks, and that ids belong to this project.
//
// Errors are StudioError(code, sentence). The sentence goes back to an agent as a tool result,
// so it says what to do next, not just what went wrong.
import * as db from './db.mjs'
import { ROLES } from './roles.mjs'
import { move, rejectTarget, REJECTS_TO_HUMAN } from './shots.mjs'
import { normTags, matchRefs } from './refs.mjs'
import * as seedance from './seedance.mjs'
import * as gptimage from './gptimage.mjs'
import * as comfy from './comfy.mjs'
import { probe, contactSheet, MAX_ROWS } from './media.mjs'
import { enqueue } from './notify.mjs'
import * as keys from './keys.mjs'
import { normDialogue, promptBlock, speaksOnCamera } from './dialogue.mjs'
import { ready as ttsReady } from './tts.mjs'
import { CLOSED_BY_AGENT } from './pipeline.mjs'

export class StudioError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status }
}
export const fail = (code, message, status) => { throw new StudioError(code, message, status) }

const slugOk = s => /^[a-z0-9][a-z0-9-]{0,39}$/.test(String(s ?? ''))
const text = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const obj = (v, what) => {
  if (v === undefined) return undefined
  if (v && typeof v === 'object' && !Array.isArray(v)) return v
  fail('bad_arg', `${what} must be a JSON object`)
}
const list = v => (Array.isArray(v) ? v : v == null || v === '' ? [] : String(v).split(',')).map(x => String(x).trim()).filter(Boolean)

const IMAGE_KINDS = ['turnaround', 'expression', 'detail', 'lighting', 'height_chart', 'negative', 'location', 'prop', 'concept', 'other']
const REF_KINDS = ['turnaround', 'expression', 'detail', 'lighting']

// ---------- lookups (always inside one project) ----------
async function projectOf(actorKey, args = {}) {
  const id = text(args.project) || await db.currentProject(actorKey)
  if (!id) fail('no_project', 'no current project — run project.use with a project slug first (project.list shows them)')
  const p = await db.getProject(id)
  if (!p) fail('no_such_project', `there is no project "${id}" (project.list shows them)`, 404)
  return p
}

async function charOf(p, name) {
  const n = text(name, 80)
  if (!n) fail('bad_arg', 'which character? (character name)')
  const c = (await db.q('select * from characters where project_id = $1 and (lower(name) = lower($2) or id = $2)', [p.id, n])).rows[0]
  if (!c) fail('no_such_character', `project ${p.id} has no character "${n}" (char.list shows them)`, 404)
  return c
}
async function lookOf(c, name, { required = false } = {}) {
  const n = text(name, 80)
  if (!n) { if (required) fail('bad_arg', `which look of ${c.name}?`); return null }
  const l = (await db.q('select * from looks where character_id = $1 and (lower(name) = lower($2) or id = $2)', [c.id, n])).rows[0]
  if (!l) fail('no_such_look', `${c.name} has no look "${n}" (char.show lists them)`, 404)
  return l
}
async function locOf(p, name) {
  const n = text(name, 80)
  if (!n) fail('bad_arg', 'which location?')
  const l = (await db.q('select * from locations where project_id = $1 and (lower(name) = lower($2) or id = $2)', [p.id, n])).rows[0]
  if (!l) fail('no_such_location', `project ${p.id} has no location "${n}" (loc.list shows them)`, 404)
  return l
}
async function episodeOf(p, code) {
  const c = text(code, 40)
  if (!c) fail('bad_arg', 'which episode? (episode code, e.g. E01)')
  const e = (await db.q('select * from episodes where project_id = $1 and lower(code) = lower($2)', [p.id, c])).rows[0]
  if (!e) fail('no_such_episode', `project ${p.id} has no episode ${c} (episode.list shows them)`, 404)
  return e
}
async function sceneOf(p, code) {
  const c = text(code, 40)
  if (!c) fail('bad_arg', 'which scene? (scene code, e.g. S03)')
  const s = (await db.q('select * from scenes where project_id = $1 and lower(code) = lower($2)', [p.id, c])).rows[0]
  if (!s) fail('no_such_scene', `project ${p.id} has no scene ${c} (scene.list shows them)`, 404)
  return s
}
async function shotOf(p, code) {
  const c = text(code, 40)
  if (!c) fail('bad_arg', 'which shot? (shot code, e.g. S03-SH004)')
  const s = (await db.q('select * from shots where project_id = $1 and lower(code) = lower($2)', [p.id, c])).rows[0]
  if (!s) fail('no_such_shot', `project ${p.id} has no shot ${c}`, 404)
  return s
}
async function assetOf(p, id) {
  const a = (await db.q('select * from assets where id = $1 and project_id = $2', [text(id, 60), p.id])).rows[0]
  if (!a) fail('no_such_asset', `project ${p.id} has no asset ${id}`, 404)
  return a
}

/** Locked = the look everything must match. Nothing linked to it changes — except adding a negative example. */
async function refuseIfLocked(links, kind = '') {
  if (kind === 'negative') return
  for (const [table, id] of [['characters', links.character_id], ['looks', links.look_id], ['locations', links.location_id]]) {
    if (!id) continue
    const r = (await db.q(`select name, status from ${table} where id = $1`, [id])).rows[0]
    if (r?.status === 'locked') fail('locked', `${r.name} is locked (final); it can't change. If it must, ask the user — only a person unlocks.`, 409)
  }
}

// ---------- views ----------
const assetView = a => ({
  id: a.id, kind: a.kind, mime: a.mime, bytes: a.bytes, width: a.width, height: a.height,
  duration_ms: a.duration_ms, tags: a.tags, status: a.status, sha256: a.sha256,
  character_id: a.character_id, look_id: a.look_id, location_id: a.location_id, shot_id: a.shot_id,
  generation_id: a.generation_id, created_by: a.created_by, created_at: a.created_at,
})
const projectView = p => ({ id: p.id, name: p.name, notify_group: p.notify_group, info: p.info })
// Vertical is what a short drama is. New projects start there; an older project keeps what it had.
export const DEFAULT_RATIO = '9:16'
export const ratioOf = info => info?.seedance?.ratio ?? info?.ratio ?? '16:9'

// ---------- storing files ----------
/** Sniff the real type: the caller's word for it is not evidence. */
export function sniff(buf) {
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png'
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf.length > 12 && buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return 'image/webp'
  if (buf.length > 12 && buf.subarray(4, 8).toString() === 'ftyp') return 'video/mp4'
  if (buf.length > 3 && buf.subarray(0, 3).toString() === 'ID3') return 'audio/mpeg'
  if (buf.length > 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'audio/mpeg'
  if (buf.length > 12 && buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WAVE') return 'audio/wav'
  return ''
}

// kick(projectId): the pipeline should look at this project again. kickWorker(): there is
// something new for the worker (a take, a cut).
export function makeActions({ store, kick = () => {}, kickWorker = () => {} }) {
  /** Put bytes in the store and describe them. Returns the columns an asset row needs. */
  async function stash(input, { maxBytes, mime: given } = {}) {
    const r = await store.put(input, { maxBytes })
    const head = await store.read(r.sha256).then(b => b.subarray(0, 32))
    const mime = sniff(head) || given || ''
    if (!mime) fail('bad_file', 'that is not a PNG, JPEG, WebP, MP4, MP3 or WAV file')
    let meta = { width: null, height: null, duration_ms: null }
    try { meta = await probe(store.path(r.sha256)) } catch (e) { fail('bad_file', `the file can't be read as media: ${e.message}`) }
    return { sha256: r.sha256, bytes: r.bytes, mime, width: meta.width, height: meta.height, duration_ms: meta.duration_ms }
  }

  /** Text files (subtitles): stored like any other file, but nothing to probe. */
  async function stashText(str, mime) {
    const r = await store.put(Buffer.from(str, 'utf8'), { maxBytes: 10 * 1024 ** 2 })
    return { sha256: r.sha256, bytes: r.bytes, mime, width: null, height: null, duration_ms: null }
  }

  async function addAsset(p, file, f) {
    const id = db.newId('as')
    const { rows } = await db.q(`
      insert into assets (id, project_id, sha256, mime, bytes, width, height, duration_ms, kind,
        character_id, look_id, location_id, shot_id, tags, generation_id, created_by)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) returning *`,
      [id, p.id, file.sha256, file.mime, file.bytes, file.width, file.height, file.duration_ms, f.kind,
        f.character_id ?? null, f.look_id ?? null, f.location_id ?? null, f.shot_id ?? null,
        normTags(f.tags ?? []), f.generation_id ?? null, f.created_by ?? ''])
    return rows[0]
  }

  /** The links an image asset hangs off, from {character, look, location} names. */
  async function linksOf(p, a) {
    const out = {}
    if (a.character) {
      const c = await charOf(p, a.character)
      out.character_id = c.id
      const l = await lookOf(c, a.look)
      if (l) out.look_id = l.id
    }
    if (a.location) out.location_id = (await locOf(p, a.location)).id
    return out
  }

  const dataUrl = async a => `data:${a.mime};base64,${(await store.read(a.sha256)).toString('base64')}`

  /** Reference assets by id: in this project, active, images. */
  async function refAssets(p, ids, { max = 9 } = {}) {
    const want = list(ids)
    if (want.length > max) fail('too_many_refs', `at most ${max} reference images`)
    const out = []
    for (const id of want) {
      const a = await assetOf(p, id)
      if (!a.mime.startsWith('image/')) fail('bad_ref', `${id} is not an image`)
      if (a.status !== 'active') fail('bad_ref', `${id} is deprecated; use its replacement`)
      out.push(a)
    }
    return out
  }

  async function newGeneration(p, g) {
    const id = db.newId('gen')
    await db.q(`insert into generations (id, project_id, shot_id, engine, model, kind, prompt, prompt_version,
        ref_asset_ids, params, status, requested_by, round, started_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [id, p.id, g.shot_id ?? null, g.engine, g.model ?? '', g.kind, g.prompt ?? '', g.prompt_version ?? null,
      g.ref_asset_ids ?? [], g.params ?? {}, g.status ?? 'queued', g.requested_by ?? '', g.round ?? '',
      g.status === 'running' ? new Date() : null])
    return id
  }

  const finishGeneration = (id, { ok, error = '', usage = {}, outputs = [] }) => db.q(`
    update generations set status = $2, error = $3, usage = $4, output_asset_ids = $5, finished_at = now(),
      duration_ms = (extract(epoch from (now() - coalesce(started_at, created_at))) * 1000)::int
    where id = $1`, [id, ok ? 'succeeded' : 'failed', String(error).slice(0, 500), usage, outputs])

  /** Move a shot, but only if nobody moved it meanwhile. Returns the new row. */
  async function moveShot(s, action, set = '', params = []) {
    const m = move(s.status, action)
    if (m.error) fail('bad_state', `${s.code}: ${m.error}`, 409)
    const { rows } = await db.q(`update shots set status = $3, updated_at = now()${set ? `, ${set}` : ''}
      where id = $1 and status = $2 returning *`, [s.id, s.status, m.to, ...params])
    if (!rows[0]) fail('conflict', `${s.code} changed while you were working on it; look at it again (shot.show)`, 409)
    return rows[0]
  }

  // ------------------------------------------------------------------
  const H = {}

  // ---- projects / crew ----
  H['project.list'] = async () => (await db.listProjects()).map(p => ({ id: p.id, name: p.name }))
  H['project.current'] = async (_a, ctx) => {
    const id = await db.currentProject(ctx.actorKey)
    return id ? { project: id } : { project: null, hint: 'run project.use <slug>' }
  }
  H['project.use'] = async (a, ctx) => {
    const p = await db.getProject(text(a.project))
    if (!p) fail('no_such_project', `there is no project "${text(a.project)}" (project.list shows them)`, 404)
    await db.useProject(ctx.actorKey, p.id)
    return { project: p.id, name: p.name }
  }
  H['project.info'] = async (a, ctx) => projectView(await projectOf(ctx.actorKey, a))
  H['project.create'] = async a => {
    if (!slugOk(a.id)) fail('bad_slug', 'project id must be lowercase letters, digits and dashes (max 40)')
    const name = text(a.name, 80)
    if (!name) fail('name_required', 'a project needs a name')
    if (await db.getProject(a.id)) fail('exists', `project "${a.id}" already exists`, 409)
    const info = obj(a.info, 'info') ?? {}
    if (!info.ratio && !info.seedance?.ratio) info.ratio = DEFAULT_RATIO
    return projectView(await db.createProject({ id: a.id, name, info, notify_group: text(a.notify_group, 80) }))
  }
  H['project.edit'] = async a => {
    const p = await db.getProject(text(a.project))
    if (!p) fail('no_such_project', `there is no project "${text(a.project)}"`, 404)
    return projectView(await db.updateProject(p.id, {
      name: a.name === undefined ? undefined : text(a.name, 80) || p.name,
      info: obj(a.info, 'info'),
      notify_group: a.notify_group === undefined ? undefined : text(a.notify_group, 80),
    }))
  }
  H['crew.list'] = async () => db.listCrew()
  H['crew.set'] = async a => {
    const id = text(a.agent_id, 63)
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) fail('bad_agent', 'agent_id must be a platform agent id')
    const role = a.role ? text(a.role, 30) : null
    if (role && !ROLES.includes(role)) fail('bad_role', `role must be one of ${ROLES.join(' / ')}, or empty to remove`)
    await db.setRole(id, role)
    return { agent_id: id, role }
  }

  // ---- model keys (the Keys panel; keys.mjs). Human-only in roles.mjs ----
  H['keys.get'] = async () => keys.view()
  H['keys.set'] = async a => {
    let rows
    try { rows = keys.edit(text(a.name, 40), a.values ?? {}, a.clear ?? []) } catch (e) { fail('bad_arg', e.message) }
    await db.setConfig(rows)
    keys.setPanel(await db.getConfig())
    return keys.view().find(k => k.name === a.name)
  }
  H['keys.test'] = async a => {
    if (!keys.KEYS[a.name]) fail('bad_arg', `unknown key group "${a.name}"; one of ${Object.keys(keys.KEYS).join(', ')}`)
    return keys.test(a.name)
  }

  // ---- characters and looks ----
  H['char.list'] = async (a, ctx) => {
    const p = await projectOf(ctx.actorKey, a)
    const { rows } = await db.q(`
      select c.name, c.status, c.card->'voice' as voice, coalesce(json_agg(json_build_object('name', l.name, 'status', l.status) order by l.created_at)
             filter (where l.id is not null), '[]') as looks
        from characters c left join looks l on l.character_id = c.id
       where c.project_id = $1 group by c.id order by c.created_at`, [p.id])
    return rows
  }
  H['char.show'] = async (a, ctx) => {
    const p = await projectOf(ctx.actorKey, a)
    const c = await charOf(p, a.name)
    const looks = (await db.q('select id, name, status, card, locked_at from looks where character_id = $1 order by created_at', [c.id])).rows
    const counts = (await db.q(`select coalesce(l.name, '(no look)') as look, a.kind, count(*)::int as n
        from assets a left join looks l on l.id = a.look_id
       where a.character_id = $1 and a.status = 'active' group by 1, 2 order by 1, 2`, [c.id])).rows
    const lora = (await db.q('select name, trigger, strength, look_id from loras where character_id = $1', [c.id])).rows
    return { name: c.name, status: c.status, card: c.card, forbidden: c.forbidden, looks, assets: counts, loras: lora }
  }
  H['char.add'] = async (a, ctx) => {
    const p = await projectOf(ctx.actorKey, a)
    const name = text(a.name, 80)
    if (!name) fail('bad_arg', 'a character needs a name')
    const id = db.newId('ch')
    try {
      await db.q(`insert into characters (id, project_id, name, card, forbidden, created_by) values ($1,$2,$3,$4,$5,$6)`,
        [id, p.id, name, obj(a.card, 'card') ?? {}, list(a.forbidden).slice(0, 40), ctx.actorKey])
    } catch (e) { if (e.code === '23505') fail('exists', `${name} already exists in ${p.id}`, 409); throw e }
    return { id, name, status: 'draft', note: 'draft until a person locks it' }
  }
  H['char.edit'] = async (a, ctx) => {
    const p = await projectOf(ctx.actorKey, a)
    const c = await charOf(p, a.name)
    await refuseIfLocked({ character_id: c.id })
    await db.q(`update characters set card = coalesce($2, card), forbidden = coalesce($3, forbidden), updated_at = now() where id = $1`,
      [c.id, obj(a.card, 'card') ?? null, a.forbidden === undefined ? null : list(a.forbidden).slice(0, 40)])
    return { name: c.name, updated: true }
  }
  // A voice isn't the look: it can be set on a locked character (the picture stays final).
  H['char.voice'] = async (a, ctx) => {
    const p = await projectOf(ctx.actorKey, a)
    const c = await charOf(p, a.name)
    const voice = text(a.voice, 80)
    if (!voice) fail('bad_arg', 'which voice? (the speech service\'s name for it, e.g. alloy, nova, onyx)')
    const v = { voice, instructions: text(a.instructions, 1000) }
    await db.q(`update characters set card = card || jsonb_build_object('voice', $2::jsonb), updated_at = now() where id = $1`, [c.id, JSON.stringify(v)])
    return { name: c.name, voice: v }
  }
  H['look.add'] = async (a, ctx) => {
    const p = await projectOf(ctx.actorKey, a)
    const c = await charOf(p, a.character ?? a.name)
    const look = text(a.look, 80)
    if (!look) fail('bad_arg', 'a look needs a name (look)')
    const id = db.newId('lk')
    try {
      await db.q('insert into looks (id, character_id, name, card, created_by) values ($1,$2,$3,$4,$5)',
        [id, c.id, look, obj(a.card, 'card') ?? {}, ctx.actorKey])
    } catch (e) { if (e.code === '23505') fail('exists', `${c.name} already has a look "${look}"`, 409); throw e }
    return { id, character: c.name, look, status: 'draft' }
  }
  H['look.edit'] = async (a, ctx) => {
    const p = await projectOf(ctx.actorKey, a)
    const c = await charOf(p, a.character ?? a.name)
    const l = await lookOf(c, a.look, { required: true })
    await refuseIfLocked({ look_id: l.id })
    await db.q('update looks set card = coalesce($2, card), updated_at = now() where id = $1', [l.id, obj(a.card, 'card') ?? null])
    return { character: c.name, look: l.name, updated: true }
  }
  H['char.refs'] = async (a, ctx) => {
    const p = await projectOf(ctx.actorKey, a)
    const c = await charOf(p, a.name)
    const l = await lookOf(c, a.look)
    const { rows } = await db.q(`select * from assets where character_id = $1 and status = 'active' and kind = any($2)
        ${l ? 'and look_id = $3' : ''} order by created_at desc`, l ? [c.id, REF_KINDS, l.id] : [c.id, REF_KINDS])
    const { matches, relaxed } = matchRefs(rows, a)
    const limit = Math.min(10, Math.max(1, Number(a.limit) || 3))
    return { character: c.name, look: l?.name ?? null, relaxed,
      note: relaxed.length ? `no exact match; dropped ${relaxed.join(', ')} to find these` : undefined,
      refs: matches.slice(0, limit).map(assetView) }
  }

  // ---- locations ----
  H['loc.list'] = async (a, ctx) => {
    const p = await projectOf(ctx.actorKey, a)
    return (await db.q('select name, status from locations where project_id = $1 order by created_at', [p.id])).rows
  }
  H['loc.show'] = async (a, ctx) => {
    const p = await projectOf(ctx.actorKey, a)
    const l = await locOf(p, a.name)
    const counts = (await db.q(`select kind, count(*)::int as n from assets where location_id = $1 and status = 'active' group by 1`, [l.id])).rows
    return { name: l.name, status: l.status, card: l.card, assets: counts }
  }
  H['loc.add'] = async (a, ctx) => {
    const p = await projectOf(ctx.actorKey, a)
    const name = text(a.name, 80)
    if (!name) fail('bad_arg', 'a location needs a name')
    const id = db.newId('lc')
    try {
      await db.q('insert into locations (id, project_id, name, card, created_by) values ($1,$2,$3,$4,$5)',
        [id, p.id, name, obj(a.card, 'card') ?? {}, ctx.actorKey])
    } catch (e) { if (e.code === '23505') fail('exists', `${name} already exists in ${p.id}`, 409); throw e }
    return { id, name, status: 'draft' }
  }
  H['loc.edit'] = async (a, ctx) => {
    const p = await projectOf(ctx.actorKey, a)
    const l = await locOf(p, a.name)
    await refuseIfLocked({ location_id: l.id })
    await db.q('update locations set card = coalesce($2, card), updated_at = now() where id = $1', [l.id, obj(a.card, 'card') ?? null])
    return { name: l.name, updated: true }
  }
  H['loc.refs'] = async (a, ctx) => {
    const p = await projectOf(ctx.actorKey, a)
    const l = await locOf(p, a.name)
    const { rows } = await db.q(`select * from assets where location_id = $1 and status = 'active' and kind <> 'negative' order by created_at desc`, [l.id])
    const { matches, relaxed } = matchRefs(rows, a)
    return { location: l.name, relaxed, refs: matches.slice(0, Math.min(10, Math.max(1, Number(a.limit) || 3))).map(assetView) }
  }

  // ---- locking: a person only (roles.mjs) ----
  async function setLock(table, row, locked) {
    await db.q(`update ${table} set status = $2, locked_at = ${locked ? 'now()' : 'null'}, updated_at = now() where id = $1`,
      [row.id, locked ? 'locked' : 'draft'])
  }
  H['char.lock'] = H['char.unlock'] = async (a, ctx, action) => {
    const locked = action === 'char.lock'
    const p = await projectOf(ctx.actorKey, a)
    const c = await charOf(p, a.name)
    const l = await lookOf(c, a.look)
    if (l) { await setLock('looks', l, locked); return { character: c.name, look: l.name, status: locked ? 'locked' : 'draft' } }
    await setLock('characters', c, locked)
    // Locking a character locks all its looks; unlocking it leaves them as they were.
    if (locked) await db.q(`update looks set status = 'locked', locked_at = now() where character_id = $1 and status = 'draft'`, [c.id])
    return { character: c.name, status: locked ? 'locked' : 'draft' }
  }
  H['loc.lock'] = H['loc.unlock'] = async (a, ctx, action) => {
    const locked = action === 'loc.lock'
    const p = await projectOf(ctx.actorKey, a)
    const l = await locOf(p, a.name)
    await setLock('locations', l, locked)
    return { location: l.name, status: locked ? 'locked' : 'draft' }
  }

  // ---- assets ----
  H['asset.show'] = async (a, ctx) => {
    const p = await projectOf(ctx.actorKey, a)
    const as = await assetOf(p, a.id ?? a.asset)
    const gen = as.generation_id ? (await db.q('select id, engine, model, prompt, ref_asset_ids, params, duration_ms, requested_by, created_at from generations where id = $1', [as.generation_id])).rows[0] : null
    const usedBy = (await db.q(`select s.code from shot_prompts sp join shots s on s.id = sp.shot_id where $1 = any(sp.ref_asset_ids) group by s.code`, [as.id])).rows.map(r => r.code)
    return { ...assetView(as), lineage: gen, used_in_shots: usedBy }
  }
  H['asset.save'] = async (a, ctx) => {
    const p = await projectOf(ctx.actorKey, a)
    const kind = text(a.kind, 30)
    if (!IMAGE_KINDS.includes(kind)) fail('bad_kind', `kind must be one of ${IMAGE_KINDS.join(', ')}`)
    if (typeof a.data_b64 !== 'string' || !a.data_b64) fail('bad_arg', 'no file content (data_b64)')
    const buf = Buffer.from(a.data_b64, 'base64')
    if (buf.length > 25 * 1024 ** 2) fail('too_large', 'images up to 25 MB')
    if (!sniff(buf).startsWith('image/')) fail('bad_file', 'only PNG, JPEG or WebP images can be saved')
    const links = await linksOf(p, a)
    await refuseIfLocked(links, kind)
    const file = await stash(buf, { maxBytes: 25 * 1024 ** 2 })
    const row = await addAsset(p, file, { ...links, kind, tags: a.tags, created_by: ctx.actorKey })
    return assetView(row)
  }
  H['asset.tag'] = async (a, ctx) => {
    const p = await projectOf(ctx.actorKey, a)
    const as = await assetOf(p, a.id ?? a.asset)
    const adding = normTags(list(a.add))
    if (!(adding.length === 1 && adding[0] === 'negative')) await refuseIfLocked(as)
    const status = a.status === undefined ? as.status : text(a.status, 20)
    if (!['active', 'deprecated'].includes(status)) fail('bad_arg', 'status is active or deprecated')
    const drop = new Set(normTags(list(a.remove)))
    const tags = normTags([...as.tags.filter(t => !drop.has(t)), ...adding])
    const { rows } = await db.q('update assets set tags = $2, status = $3 where id = $1 returning *', [as.id, tags, status])
    return assetView(rows[0])
  }
  H['asset.gen'] = async (a, ctx) => {
    const p = await projectOf(ctx.actorKey, a)
    const engine = text(a.engine, 20)
    if (!['gpt-image', 'comfy'].includes(engine)) fail('bad_arg', 'engine is gpt-image or comfy (video goes through shot.gen)')
    const prompt = text(a.prompt, 8000)
    if (!prompt) fail('bad_arg', 'a prompt is needed')
    const kind = text(a.kind, 30) || 'concept'
    if (!IMAGE_KINDS.includes(kind)) fail('bad_kind', `kind must be one of ${IMAGE_KINDS.join(', ')}`)
    const links = await linksOf(p, a)
    await refuseIfLocked(links, kind)
    const refs = await refAssets(p, a.refs, { max: 16 })
    const n = Math.min(4, Math.max(1, Number(a.n) || 1))
    const size = gptimage.SIZES.includes(a.size) ? a.size : 'auto'
    const quality = gptimage.QUALITIES.includes(a.quality) ? a.quality : 'auto'
    const cfg = engine === 'gpt-image' ? gptimage.config() : comfy.config()
    const params = { n, size, quality }
    let loraRow = null
    if (engine === 'comfy') {
      loraRow = (await db.q(`select * from loras where project_id = $1 and (($2::text is not null and look_id = $2) or character_id = $3)
        order by (look_id = $2) desc nulls last limit 1`, [p.id, links.look_id ?? null, links.character_id ?? null])).rows[0] ?? null
      Object.assign(params, { lora: loraRow?.name ?? null, seed: Math.floor(Math.random() * 2 ** 31) })
    }
    const genId = await newGeneration(p, { engine, model: engine === 'gpt-image' ? cfg.model : 'comfy', kind: 'image', prompt,
      ref_asset_ids: refs.map(r => r.id), params, status: 'running', requested_by: ctx.actorKey })
    let out
    try {
      if (engine === 'gpt-image') {
        const srcs = await Promise.all(refs.map(async r => ({ buf: await store.read(r.sha256), mime: r.mime })))
        out = srcs.length ? await gptimage.edit(cfg, { prompt, refs: srcs, size, quality }) : await gptimage.generate(cfg, { prompt, n, size, quality })
      } else {
        const wf = p.info?.comfy?.workflow
        const [w, h] = size === 'auto' ? [1024, 1024] : size.split('x').map(Number)
        const vars = { prompt, negative: text(a.negative, 2000) || p.info?.comfy?.negative || '', seed: params.seed,
          width: w, height: h, lora: loraRow?.name, lora_strength: loraRow?.strength }
        out = await comfy.run(cfg, wf, vars, await Promise.all(refs.map(async r => ({ buf: await store.read(r.sha256), mime: r.mime, sha256: r.sha256 }))))
      }
    } catch (e) {
      await finishGeneration(genId, { ok: false, error: e.message })
      fail('engine_failed', `${engine} failed: ${e.message}`, 502)
    }
    const assets = []
    for (const img of out.images) {
      const file = await stash(img, { maxBytes: 50 * 1024 ** 2 })
      assets.push(await addAsset(p, file, { ...links, kind, tags: a.tags, generation_id: genId, created_by: ctx.actorKey }))
    }
    await finishGeneration(genId, { ok: true, usage: out.usage ?? {}, outputs: assets.map(x => x.id) })
    return { generation: genId, assets: assets.map(assetView),
      note: 'saved to the library as drafts with the tags you gave; check them (asset.show) and fix tags with asset.tag' }
  }
  H['asset.edit'] = async (a, ctx) => {
    const p = await projectOf(ctx.actorKey, a)
    const src = await assetOf(p, a.id ?? a.asset)
    await refuseIfLocked(src)
    const instruction = text(a.instruction, 8000)
    if (!instruction) fail('bad_arg', 'what should change? (instruction)')
    const extra = await refAssets(p, a.refs, { max: 15 })
    const mask = a.mask ? await assetOf(p, a.mask) : null
    const cfg = gptimage.config()
    const genId = await newGeneration(p, { engine: 'gpt-image', model: cfg.model, kind: 'image', prompt: instruction,
      ref_asset_ids: [src.id, ...extra.map(r => r.id), ...mask ? [mask.id] : []], params: { edit_of: src.id, mask: mask?.id ?? null },
      status: 'running', requested_by: ctx.actorKey })
    let out
    try {
      out = await gptimage.edit(cfg, {
        prompt: instruction,
        refs: await Promise.all([src, ...extra].map(async r => ({ buf: await store.read(r.sha256), mime: r.mime }))),
        mask: mask ? { buf: await store.read(mask.sha256), mime: mask.mime } : null,
      })
    } catch (e) {
      await finishGeneration(genId, { ok: false, error: e.message })
      fail('engine_failed', `gpt-image failed: ${e.message}`, 502)
    }
    const assets = []
    for (const img of out.images) {
      const file = await stash(img, { maxBytes: 50 * 1024 ** 2 })
      assets.push(await addAsset(p, file, { character_id: src.character_id, look_id: src.look_id, location_id: src.location_id,
        kind: src.kind, tags: [...src.tags, 'edited'], generation_id: genId, created_by: ctx.actorKey }))
    }
    await finishGeneration(genId, { ok: true, usage: out.usage ?? {}, outputs: assets.map(x => x.id) })
    return { generation: genId, assets: assets.map(assetView),
      note: `the original ${src.id} is unchanged; if the new one replaces it, deprecate the old one (asset.tag status=deprecated)` }
  }

  // ---- scenes ----
  H['scene.list'] = async (a, ctx) => {
    const p = await projectOf(ctx.actorKey, a)
    const ep = a.episode ? await episodeOf(p, a.episode) : null
    return (await db.q(`select sc.code, sc.title, sc.locked, e.code as episode, count(s.id)::int as shots,
        count(s.id) filter (where s.status in ('approved','locked'))::int as approved
        from scenes sc left join shots s on s.scene_id = sc.id left join episodes e on e.id = sc.episode_id
        where sc.project_id = $1 ${ep ? 'and sc.episode_id = $2' : ''}
        group by sc.id, e.code order by sc.ord, sc.created_at`, ep ? [p.id, ep.id] : [p.id])).rows
  }
  H['scene.show'] = async (a, ctx) => {
    const p = await projectOf(ctx.actorKey, a)
    const sc = await sceneOf(p, a.code ?? a.scene)
    const shots = (await db.q('select code, status, priority, reject_count, def from shots where scene_id = $1 order by ord, created_at', [sc.id])).rows
    return { code: sc.code, title: sc.title, locked: sc.locked, script: sc.script,
      shots: shots.map(s => ({ code: s.code, status: s.status, priority: s.priority, rejections: s.reject_count, story_beat: s.def?.story_beat })) }
  }
  H['scene.add'] = async (a, ctx) => {
    const p = await projectOf(ctx.actorKey, a)
    const code = text(a.code, 40)
    if (!/^[\w.-]{1,40}$/.test(code)) fail('bad_arg', 'a scene code is letters, digits, dot, dash or underscore (e.g. S03)')
    const script = typeof a.script === 'string' ? a.script.trim().slice(0, 200_000) : ''
    if (!script) fail('bad_arg', 'a scene carries its slice of the script (script) — copy it exactly as the user gave it')
    // A series cuts scenes out of an episode; a project with episodes needs to know which.
    const hasEpisodes = (await db.q('select 1 from episodes where project_id = $1 limit 1', [p.id])).rowCount
    const ep = a.episode ? await episodeOf(p, a.episode) : null
    if (hasEpisodes && !ep) fail('bad_arg', 'which episode is this scene in? (episode, e.g. E01 — episode.list shows them)')
    if (ep && !['breakdown', 'draft'].includes(ep.stage) && ctx.actor?.kind !== 'human')
      fail('bad_state', `${ep.code} is past its breakdown (${ep.stage}); new scenes need a person to send it back`, 409)
    const id = db.newId('sc')
    try {
      await db.q('insert into scenes (id, project_id, code, title, script, ord, created_by, episode_id) values ($1,$2,$3,$4,$5,$6,$7,$8)',
        [id, p.id, code, text(a.title, 120), script, Number.isInteger(a.ord) ? a.ord : 0, ctx.actorKey, ep?.id ?? null])
    } catch (e) {
      if (e.code === '23505') fail('exists', `scene ${code} already exists; its text is the user's and only a person can change it (scene.edit)`, 409)
      throw e
    }
    return { code, title: text(a.title, 120), ...ep ? { episode: ep.code } : {} }
  }
  H['scene.edit'] = async (a, ctx) => {
    const p = await projectOf(ctx.actorKey, a)
    const sc = await sceneOf(p, a.code ?? a.scene)
    await db.q('update scenes set title = coalesce($2, title), script = coalesce($3, script), ord = coalesce($4, ord), updated_at = now() where id = $1',
      [sc.id, a.title === undefined ? null : text(a.title, 120), typeof a.script === 'string' ? a.script : null, Number.isInteger(a.ord) ? a.ord : null])
    return { code: sc.code, updated: true }
  }

  // ---- shots ----
  function checkShotDef(d) {
    if (!d || typeof d !== 'object' || Array.isArray(d)) fail('bad_shot', 'each shot is a JSON object (see the shot-breakdown skill)')
    const code = text(d.id, 40)
    if (!/^[\w.-]{1,40}$/.test(code)) fail('bad_shot', `shot id "${d.id}" must be letters, digits, dot, dash or underscore (e.g. S03-SH004)`)
    const dur = Number(d.duration_s)
    if (!(dur > 0 && dur <= 30)) fail('bad_shot', `${code}: duration_s must be a number of seconds, 1–30`)
    if (!Array.isArray(d.characters ?? [])) fail('bad_shot', `${code}: characters must be a list`)
    const priority = ['hero', 'normal', 'filler'].includes(d.priority) ? d.priority : 'normal'
    const warn = []
    if (!d.continuity?.in_from && !d.continuity?.out_to) warn.push(`${code}: no continuity written — the reviewer checks continuity against it`)
    const { lines, error } = normDialogue(d.dialogue)
    if (error) fail('bad_shot', `${code}: ${error}`)
    return { code, priority, def: { ...d, dialogue: lines }, warn }
  }
  H['shot.plan'] = async (a, ctx) => {
    const p = await projectOf(ctx.actorKey, a)
    const sc = await sceneOf(p, a.scene)
    if (sc.locked) fail('locked', `scene ${sc.code} is locked; a person has to unlock it first`, 409)
    const shots = Array.isArray(a.shots) ? a.shots : fail('bad_arg', 'shots must be a list of shot objects')
    if (!shots.length || shots.length > 60) fail('bad_arg', 'between 1 and 60 shots per plan')
    const checked = shots.map(checkShotDef)
    const out = [], warn = []
    // Speakers are characters (a voice and a face). An extra who says one line may not be one —
    // said, not refused.
    const known = new Set((await db.q('select lower(name) as n from characters where project_id = $1', [p.id])).rows.map(r => r.n))
    for (const c of checked) for (const l of c.def.dialogue)
      if (l.speaker && !known.has(l.speaker.toLowerCase())) warn.push(`${c.code}: "${l.speaker}" speaks but is not a character in the bible — their voice will be the default one`)
    for (const [i, c] of checked.entries()) {
      warn.push(...c.warn)
      const cur = (await db.q('select * from shots where project_id = $1 and lower(code) = lower($2)', [p.id, c.code])).rows[0]
      if (cur && cur.scene_id !== sc.id) fail('bad_shot', `${c.code} belongs to another scene`, 409)
      if (cur) {
        await moveShot(cur, 'replan', 'def = $4, priority = $5, ord = $6', [c.def, c.priority, i])
        out.push({ code: c.code, status: 'planned', changed: true })
      } else {
        await db.q('insert into shots (id, project_id, scene_id, code, ord, def, priority) values ($1,$2,$3,$4,$5,$6,$7)',
          [db.newId('sh'), p.id, sc.id, c.code, i, c.def, c.priority])
        out.push({ code: c.code, status: 'planned' })
      }
    }
    return { scene: sc.code, shots: out, ...warn.length ? { warnings: warn } : {} }
  }
  H['shot.show'] = async (a, ctx) => {
    const p = await projectOf(ctx.actorKey, a)
    const s = await shotOf(p, a.shot ?? a.code)
    const prompt = (await db.q('select version, text, ref_asset_ids as refs, note, created_by, created_at from shot_prompts where shot_id = $1 order by version desc limit 1', [s.id])).rows[0] ?? null
    const cands = (await db.q(`select c.n, c.asset_id, c.prompt_version, c.created_at, g.round, g.model, g.params->>'trim_to' as trim_to
        from candidates c join generations g on g.id = c.generation_id where c.shot_id = $1 order by c.n`, [s.id])).rows
    const gens = (await db.q(`select status, count(*)::int as n from generations where shot_id = $1 group by status`, [s.id])).rows
    const reviews = (await db.q('select verdict, pick, route, reason, note, attempt, reviewer, created_at from reviews where shot_id = $1 order by id', [s.id])).rows
    const around = (await db.q(`select code, def->'continuity' as continuity, status from shots where scene_id = $1 and ord in ($2 - 1, $2 + 1) order by ord`, [s.scene_id, s.ord])).rows
    return { code: s.code, status: s.status, priority: s.priority, def: s.def, rejections: s.reject_count,
      prompt, candidates: cands, generations: Object.fromEntries(gens.map(g => [g.status, g.n])),
      picked: s.pick_asset_id, reviews, neighbours: around }
  }
  H['shot.prompt'] = async (a, ctx) => {
    const p = await projectOf(ctx.actorKey, a)
    const s = await shotOf(p, a.shot ?? a.code)
    const body = text(a.text, 8000)
    if (!body) fail('bad_arg', 'the prompt text is empty')
    const refs = await refAssets(p, a.refs, { max: 9 })
    const s2 = await moveShot(s, 'prompt', 'prompt_version = prompt_version + 1')
    await db.q('insert into shot_prompts (shot_id, version, text, ref_asset_ids, note, created_by) values ($1,$2,$3,$4,$5,$6)',
      [s.id, s2.prompt_version, body, refs.map(r => r.id), text(a.note, 500), ctx.actorKey])
    return { shot: s.code, version: s2.prompt_version, refs: refs.length,
      ...refs.length > 3 ? { warning: 'more than 3 references tends to confuse the model (shot-prompting skill)' } : {} }
  }
  H['shot.gen'] = async (a, ctx) => {
    const p = await projectOf(ctx.actorKey, a)
    const s = await shotOf(p, a.shot ?? a.code)
    const model = text(a.model, 30)
    if (!seedance.MODELS[model]) fail('bad_arg', `model is ${Object.keys(seedance.MODELS).join(' or ')}`)
    const n = Number(a.n)
    if (!Number.isInteger(n) || n < 1 || n > MAX_ROWS) fail('bad_arg', `n is 1–${MAX_ROWS} takes`)
    const pr = (await db.q('select * from shot_prompts where shot_id = $1 order by version desc limit 1', [s.id])).rows[0]
    if (!pr) fail('bad_state', `${s.code}: save a prompt first (shot.prompt)`, 409)
    if (pr.ref_asset_ids.length > seedance.MODELS[model].maxRefs) fail('too_many_refs', `${model} takes at most ${seedance.MODELS[model].maxRefs} references`)
    const cfg = seedance.config()
    if (!cfg.base || !cfg.key) fail('not_configured', 'Seedance is not configured on this studio (a person sets it in the Keys panel); tell the user', 503)
    const lim = seedance.limits(p.info)
    const round = db.newId('rd')
    const info = p.info?.seedance ?? {}
    // On-camera dialogue is generated with the picture, so the lips match: the studio adds the lines
    // and turns sound on itself — a prompt that forgot them can't lose them.
    const lines = s.def?.dialogue ?? []
    const params = { duration: Number(s.def?.duration_s) || 5, ratio: ratioOf(p.info), resolution: info.resolution ?? '720p',
      audio: info.generate_audio === true || speaksOnCamera(lines) }
    const sent = pr.text + promptBlock(lines, p.info?.lang)
    // The hourly cap is checked and the takes inserted in one transaction, under a per-project
    // lock — two shot.gen calls at once must not both see "36 used" and both add 8.
    const left = await db.tx(async q => {
      await q('select pg_advisory_xact_lock(hashtext($1))', [`seedance:${p.id}`])
      const used = (await q(`select count(*)::int as n from generations where project_id = $1 and engine = 'seedance' and created_at > now() - interval '1 hour'`, [p.id])).rows[0].n
      const r = seedance.rateCheck(used, n, lim.perHour)
      if (!r.ok) fail('rate_limited', r.error, 429)
      const m = move(s.status, 'gen')
      if (m.error) fail('bad_state', `${s.code}: ${m.error}`, 409)
      const moved = await q(`update shots set status = 'generating', updated_at = now() where id = $1 and status = $2`, [s.id, s.status])
      if (!moved.rowCount) fail('conflict', `${s.code} changed while you were working on it; look at it again (shot.show)`, 409)
      for (let i = 0; i < n; i++) {
        await q(`insert into generations (id, project_id, shot_id, engine, model, kind, prompt, prompt_version, ref_asset_ids, params, requested_by, round)
          values ($1,$2,$3,'seedance',$4,'video',$5,$6,$7,$8,$9,$10)`,
        [db.newId('gen'), p.id, s.id, model, sent, pr.version, pr.ref_asset_ids, params, ctx.actorKey, round])
      }
      return r.left
    })
    kickWorker()
    return { shot: s.code, round, takes: n, model, prompt_version: pr.version, left_this_hour: left, ratio: params.ratio, sound: params.audio,
      ...sent !== pr.text ? { dialogue: 'the on-camera lines were added to the prompt' } : {},
      note: `queued; at most ${lim.concurrent} run at once. The reviewer is told when they are ready — don't poll.` }
  }
  H['shot.sheet'] = async (a, ctx) => {
    const p = await projectOf(ctx.actorKey, a)
    const s = await shotOf(p, a.shot ?? a.code)
    const m = move(s.status, 'sheet')
    if (m.error) fail('bad_state', `${s.code}: ${m.error}`, 409)
    const want = list(a.candidates).map(Number).filter(Number.isInteger)
    let cands = (await db.q(`select c.n, c.asset_id, g.round from candidates c join generations g on g.id = c.generation_id
        where c.shot_id = $1 order by c.n`, [s.id])).rows
    if (want.length) cands = cands.filter(c => want.includes(c.n))
    else {
      // Default: the newest round — that is what the reviewer was told about.
      const last = cands.at(-1)?.round
      cands = cands.filter(c => c.round === last)
    }
    if (!cands.length) fail('bad_state', `${s.code} has no such candidates`, 409)
    if (cands.length > MAX_ROWS) fail('bad_arg', `at most ${MAX_ROWS} candidates per sheet; pass candidates=[…] to pick`)
    const takes = []
    for (const c of cands) takes.push({ path: store.path((await assetOf(p, c.asset_id)).sha256), n: c.n })
    // The reference row: each character's locked front turnaround for the look this shot uses.
    const refs = []
    for (const ch of (s.def?.characters ?? []).slice(0, 4)) {
      const c = (await db.q('select * from characters where project_id = $1 and lower(name) = lower($2)', [p.id, String(ch.name ?? '')])).rows[0]
      if (!c) continue
      const l = ch.look ? (await db.q('select * from looks where character_id = $1 and lower(name) = lower($2)', [c.id, String(ch.look)])).rows[0] : null
      const rows = (await db.q(`select * from assets where character_id = $1 and status = 'active' and kind = 'turnaround' ${l ? 'and look_id = $2' : ''}
          order by created_at`, l ? [c.id, l.id] : [c.id])).rows
      const pick = matchRefs(rows, { angle: '正' }).matches[0] ?? rows[0]
      if (pick) refs.push({ path: store.path(pick.sha256), label: `${c.name}${l ? `/${l.name}` : ''}`, asset_id: pick.id, locked: (l ?? c).status === 'locked' })
    }
    let jpg
    try { jpg = await contactSheet({ refs, takes }) } catch (e) { fail('sheet_failed', `couldn't build the sheet: ${e.message}`, 500) }
    const file = await stash(jpg, { maxBytes: 20 * 1024 ** 2 })
    const row = await addAsset(p, file, { kind: 'sheet', shot_id: s.id, tags: cands.map(c => `candidate:${c.n}`), created_by: ctx.actorKey })
    return { shot: s.code, sheet: assetView(row), candidates: cands.map(c => c.n),
      reference_row: refs.map(r => ({ asset_id: r.asset_id, label: r.label, locked: r.locked })),
      layout: 'row 1 = locked reference (REF); then one row per candidate, labelled #n, four frames across its length' }
  }
  H['shot.approve'] = async (a, ctx) => {
    const p = await projectOf(ctx.actorKey, a)
    const s = await shotOf(p, a.shot ?? a.code)
    const pick = Number(a.pick)
    const c = (await db.q('select * from candidates where shot_id = $1 and n = $2', [s.id, pick])).rows[0]
    if (!c) fail('bad_arg', `${s.code} has no candidate #${a.pick}`)
    // A person may take a take the crew rejected; the crew approves only what is in review.
    await moveShot(s, ctx.actor?.kind === 'human' && s.status === 'rejected' ? 'override' : 'approve', 'pick_asset_id = $4', [c.asset_id])
    await db.q('insert into reviews (shot_id, verdict, pick, note, scores, reviewer) values ($1,$2,$3,$4,$5,$6)',
      [s.id, 'approve', pick, text(a.note, 2000), obj(a.scores, 'scores') ?? {}, ctx.actorKey])
    // A person deciding in the workbench is news for the crew (the reviewer may be about to look at
    // the same takes); an agent approving says so in the group itself.
    if (ctx.actor?.kind === 'human') await enqueue(p.id, { kind: 'approved', shot: s.code, pick })
    kick(p.id)
    return { shot: s.code, status: 'approved', pick }
  }
  H['shot.reject'] = async (a, ctx) => {
    const p = await projectOf(ctx.actorKey, a)
    const s = await shotOf(p, a.shot ?? a.code)
    const reason = text(a.reason, 2000)
    if (reason.length < 15) fail('bad_arg', 'the reason must say what to fix, specifically enough to act on (which candidate, which part, which card rule)')
    const route = text(a.route, 10)
    if (!['prompt', 'asset', 'plan'].includes(route)) fail('bad_arg', 'route is prompt (generation plan), asset (references) or plan (shot design)')
    const s2 = await moveShot(s, 'reject', 'reject_count = reject_count + 1')
    await db.q('insert into reviews (shot_id, verdict, route, reason, note, scores, attempt, reviewer) values ($1,$2,$3,$4,$5,$6,$7,$8)',
      [s.id, 'reject', route, reason, text(a.note, 2000), obj(a.scores, 'scores') ?? {}, s2.reject_count, ctx.actorKey])
    const to = rejectTarget(s2.reject_count, route)
    // The routing is the studio's job, not the reviewer's: the route's owner gets a work order
    // (pipeline.mjs); on the 3rd rejection a person is told in the group, with all three reasons.
    if (to === 'human') {
      const reasons = (await db.q(`select reason from reviews where shot_id = $1 and verdict = 'reject' order by id`, [s.id])).rows.map(r => r.reason)
      await enqueue(p.id, { kind: 'reject', shot: s.code, attempt: s2.reject_count, route, reason, goes_to: to, reasons })
    }
    kick(p.id)
    return { shot: s.code, status: 'rejected', attempt: s2.reject_count, route, goes_to: to,
      note: to === 'human' ? `this is rejection #${s2.reject_count}: it goes to a person now, not back to the crew`
        : `the ${to} gets a work order; you don't need to tell them` }
  }
  // A person handing a shot back to the crew — typically after the 3rd rejection landed on them.
  H['shot.reopen'] = async (a, ctx) => {
    const p = await projectOf(ctx.actorKey, a)
    const s = await shotOf(p, a.shot ?? a.code)
    if (s.status !== 'rejected') fail('bad_state', `${s.code} is ${s.status}; only a rejected shot can be reopened`, 409)
    const route = text(a.route, 10)
    if (!['prompt', 'asset', 'plan'].includes(route)) fail('bad_arg', 'route is prompt, asset or plan — who gets it back')
    const note = text(a.note, 2000)
    if (note.length < 5) fail('bad_arg', 'say what should change (note)')
    await db.q('insert into reviews (shot_id, verdict, route, reason, attempt, reviewer) values ($1,$2,$3,$4,$5,$6)',
      [s.id, 'reopen', route, note, s.reject_count, ctx.actorKey])
    return { shot: s.code, route, note: 'back to the crew; the next rejection comes to a person again' }
  }
  H['shot.lock'] = async (a, ctx) => {
    const p = await projectOf(ctx.actorKey, a)
    const sc = await sceneOf(p, a.scene ?? a.code)
    return db.tx(async q => {
      const shots = (await q('select code, status from shots where scene_id = $1 for update', [sc.id])).rows
      if (!shots.length) fail('bad_state', `scene ${sc.code} has no shots`, 409)
      const open = shots.filter(x => x.status !== 'approved' && x.status !== 'locked')
      if (open.length) fail('bad_state', `scene ${sc.code} can't be locked: ${open.map(x => `${x.code} is ${x.status}`).join(', ')}`, 409)
      await q(`update shots set status = 'locked', updated_at = now() where scene_id = $1`, [sc.id])
      await q(`update scenes set locked = true, locked_at = now(), updated_at = now() where id = $1`, [sc.id])
      return { scene: sc.code, locked: true, shots: shots.length }
    })
  }
  // ---- episodes: a series is episodes; each moves through the pipeline (pipeline.mjs) ----
  const episodeView = e => ({ code: e.code, title: e.title, logline: e.logline, stage: e.stage, rev: e.rev, note: e.note, ord: e.ord })
  H['episode.list'] = async (a, ctx) => {
    const p = await projectOf(ctx.actorKey, a)
    return (await db.q(`select e.*, count(distinct sc.id)::int as scenes, count(s.id)::int as shots,
        count(s.id) filter (where s.status in ('approved','locked'))::int as approved
        from episodes e left join scenes sc on sc.episode_id = e.id left join shots s on s.scene_id = sc.id
        where e.project_id = $1 group by e.id order by e.ord, e.created_at`, [p.id])).rows
      .map(e => ({ ...episodeView(e), scenes: e.scenes, shots: e.shots, approved: e.approved }))
  }
  H['episode.show'] = async (a, ctx) => {
    const p = await projectOf(ctx.actorKey, a)
    const e = await episodeOf(p, a.episode ?? a.code)
    const scenes = (await db.q(`select sc.code, sc.title, sc.locked, count(s.id)::int as shots,
        count(s.id) filter (where s.status in ('approved','locked'))::int as approved
        from scenes sc left join shots s on s.scene_id = sc.id where sc.episode_id = $1 group by sc.id order by sc.ord, sc.created_at`, [e.id])).rows
    const cut = (await db.q(`select a.id, a.status, a.error, a.log, a.created_at, a.finished_at, a.video_asset_id, a.srt_asset_id, v.duration_ms
        from assemblies a left join assets v on v.id = a.video_asset_id where a.episode_id = $1 order by a.created_at desc limit 1`, [e.id])).rows[0] ?? null
    const orders = (await db.q(`select id, role, kind, subject, status, agent_id, attempts, error, created_at from orders
        where episode_id = $1 and status in ('open','sent','stuck') order by id`, [e.id])).rows
    return { ...episodeView(e), script: e.script, ratio: ratioOf(p.info), scenes, cut, orders }
  }
  H['episode.add'] = async (a, ctx) => {
    const p = await projectOf(ctx.actorKey, a)
    const code = text(a.code, 40)
    if (!/^[\w.-]{1,40}$/.test(code)) fail('bad_arg', 'an episode code is letters, digits, dot, dash or underscore (e.g. E01)')
    const script = typeof a.script === 'string' ? a.script.trim().slice(0, 200_000) : ''
    const id = db.newId('ep')
    const ord = Number.isInteger(a.ord) ? a.ord
      : (await db.q('select coalesce(max(ord), 0) + 1 as n from episodes where project_id = $1', [p.id])).rows[0].n
    try {
      await db.q('insert into episodes (id, project_id, code, title, logline, script, ord, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8)',
        [id, p.id, code, text(a.title, 120), text(a.logline, 1000), script, ord, ctx.actorKey])
    } catch (e) { if (e.code === '23505') fail('exists', `episode ${code} already exists`, 409); throw e }
    return { code, stage: 'draft' }
  }
  H['episode.edit'] = async (a, ctx) => {
    const p = await projectOf(ctx.actorKey, a)
    const e = await episodeOf(p, a.episode ?? a.code)
    await db.q(`update episodes set title = coalesce($2, title), logline = coalesce($3, logline), script = coalesce($4, script),
        ord = coalesce($5, ord), updated_at = now() where id = $1`,
      [e.id, a.title === undefined ? null : text(a.title, 120), a.logline === undefined ? null : text(a.logline, 1000),
        typeof a.script === 'string' ? a.script.slice(0, 200_000) : null, Number.isInteger(a.ord) ? a.ord : null])
    return { code: e.code, updated: true }
  }
  /** Move an episode, guarded like a shot: only from the stage the caller saw. */
  async function moveEpisode(e, from, to, set = '', params = []) {
    if (!from.includes(e.stage)) fail('bad_state', `${e.code} is ${e.stage}; this needs it to be ${from.join(' or ')}`, 409)
    const r = await db.q(`update episodes set stage = $3, updated_at = now()${set ? `, ${set}` : ''} where id = $1 and stage = $2 returning *`,
      [e.id, e.stage, to, ...params])
    if (!r.rows[0]) fail('conflict', `${e.code} changed meanwhile; look at it again`, 409)
    return r.rows[0]
  }
  // A person starts production of an episode: the director gets the breakdown order.
  H['episode.start'] = async (a, ctx) => {
    const p = await projectOf(ctx.actorKey, a)
    const e = await episodeOf(p, a.episode ?? a.code)
    if (!e.script.trim()) fail('bad_state', `${e.code} has no script yet`, 409)
    await moveEpisode(e, ['draft'], 'breakdown')
    kick(p.id)
    return { code: e.code, stage: 'breakdown', note: 'the director has been given the breakdown' }
  }
  H['episode.submit'] = async (a, ctx) => {
    const p = await projectOf(ctx.actorKey, a)
    const e = await episodeOf(p, a.episode ?? a.code)
    const c = (await db.q(`select count(distinct sc.id)::int as scenes, count(s.id)::int as shots,
        count(sc.id) filter (where not exists (select 1 from shots x where x.scene_id = sc.id))::int as empty
        from scenes sc left join shots s on s.scene_id = sc.id where sc.episode_id = $1`, [e.id])).rows[0]
    if (!c.shots) fail('bad_state', `${e.code} has no shots yet — cut it into scenes (scene.add with episode) and plan them (shot.plan)`, 409)
    if (c.empty) fail('bad_state', `${e.code}: ${c.empty} scene(s) have no shots; plan them first`, 409)
    await moveEpisode(e, ['breakdown'], 'breakdown_review')
    kick(p.id)
    return { code: e.code, stage: 'breakdown_review', scenes: c.scenes, shots: c.shots, note: 'a person reviews the breakdown next; you will hear if it comes back' }
  }
  // A person's decision at a gate: the breakdown, or the finished cut.
  H['episode.review'] = async (a, ctx) => {
    const p = await projectOf(ctx.actorKey, a)
    const e = await episodeOf(p, a.episode ?? a.code)
    const decision = text(a.decision, 10)
    if (!['approve', 'revise'].includes(decision)) fail('bad_arg', 'decision is approve or revise')
    const note = text(a.note, 2000)
    let out
    if (e.stage === 'breakdown_review') {
      if (decision === 'approve') out = await moveEpisode(e, ['breakdown_review'], 'production', "note = ''")
      else {
        if (note.length < 5) fail('bad_arg', 'say what should change (note)')
        out = await moveEpisode(e, ['breakdown_review'], 'breakdown', 'rev = rev + 1, note = $4', [note])
      }
    } else if (e.stage === 'final_review') {
      if (decision === 'approve') out = await moveEpisode(e, ['final_review'], 'done')
      else fail('bad_arg', 'to change a finished cut, reject the shots that need it (shot.reject) — the episode goes back to production by itself')
    } else fail('bad_state', `${e.code} is ${e.stage}; nothing is waiting for a decision`, 409)
    kick(p.id)
    return { code: e.code, stage: out.stage }
  }
  // Cut it again now (a person or the director): e.g. after changing a voice. Same takes, new cut.
  H['episode.assemble'] = async (a, ctx) => {
    const p = await projectOf(ctx.actorKey, a)
    const e = await episodeOf(p, a.episode ?? a.code)
    const shots = (await db.q(`select s.code, s.status, (select c.n from candidates c where c.shot_id = s.id and c.asset_id = s.pick_asset_id) as pick
        from shots s join scenes sc on sc.id = s.scene_id where sc.episode_id = $1 order by sc.ord, sc.created_at, s.ord, s.created_at`, [e.id])).rows
    if (!shots.length) fail('bad_state', `${e.code} has no shots`, 409)
    const open = shots.filter(x => !['approved', 'locked'].includes(x.status) || !x.pick)
    if (open.length) fail('bad_state', `not every shot is approved yet: ${open.map(x => `${x.code} is ${x.status}`).join(', ')}`, 409)
    const busy = (await db.q(`select id from assemblies where episode_id = $1 and status in ('queued','running')`, [e.id])).rows[0]
    if (busy) fail('bad_state', `${e.code} is already being cut (${busy.id})`, 409)
    const id = db.newId('asm')
    await db.q(`insert into assemblies (id, project_id, episode_id, sig, params, requested_by) values ($1,$2,$3,$4,$5,$6)`,
      [id, p.id, e.id, shots.map(x => `${x.code}=${x.pick}`).join(','), { burn: a.burn_subtitles !== false }, ctx.actorKey])
    kickWorker()
    return { episode: e.code, assembly: id, note: 'queued; a person is told when the cut is ready' }
  }

  // ---- work orders (pipeline.mjs makes them; notify.mjs delivers them) ----
  H['order.list'] = async (a, ctx) => {
    const p = await projectOf(ctx.actorKey, a)
    const mine = ctx.actor?.kind === 'agent'
    return (await db.q(`select id, role, kind, subject, body, status, attempts, created_at, sent_at from orders
        where project_id = $1 and status in ('open','sent','stuck') ${mine ? 'and role = $2' : ''} order by id`,
      mine ? [p.id, ctx.role] : [p.id])).rows
  }
  H['order.done'] = async (a, ctx) => {
    const p = await projectOf(ctx.actorKey, a)
    const o = (await db.q('select * from orders where id = $1 and project_id = $2', [Number(a.id), p.id])).rows[0]
    if (!o) fail('no_such_order', `no work order #${a.id} in ${p.id} (order.list shows yours)`, 404)
    if (ctx.actor?.kind === 'agent' && o.role !== ctx.role) fail('forbidden', `order #${o.id} is the ${o.role}'s, not yours`, 403)
    if (!['open', 'sent', 'stuck'].includes(o.status)) return { id: o.id, status: o.status, note: 'already closed' }
    // The studio closes what it can see for itself; saying "done" to those would be a claim, not a fact.
    if (!CLOSED_BY_AGENT.has(o.kind))
      fail('bad_state', `order #${o.id} (${o.kind} ${o.subject}) closes by itself when the studio sees the work done — it doesn't yet. Do the work; don't close it by hand.`, 409)
    const note = text(a.note, 1000)
    if (note.length < 5) fail('bad_arg', 'say what you changed (note) — the next person works from it')
    await db.q(`update orders set status = 'done', done_at = now(), note = $2 where id = $1`, [o.id, note])
    kick(p.id)
    return { id: o.id, status: 'done' }
  }

  // ---- the workbench (web UI): whole views in one call each ----
  H['project.board'] = async (a, ctx) => {
    const p = await projectOf(ctx.actorKey, a)
    const ep = a.episode ? await episodeOf(p, a.episode) : null
    const episodes = (await db.q(`select e.code, e.title, e.stage, count(s.id)::int as shots,
        count(s.id) filter (where s.status in ('approved','locked'))::int as approved,
        (select count(*)::int from orders o where o.episode_id = e.id and o.status in ('open','sent','stuck')) as orders
        from episodes e left join scenes sc on sc.episode_id = e.id left join shots s on s.scene_id = sc.id
        where e.project_id = $1 group by e.id order by e.ord, e.created_at`, [p.id])).rows
    const scenes = (await db.q(`select sc.code, sc.title, sc.locked, length(sc.script)::int as script_chars, e.code as episode
        from scenes sc left join episodes e on e.id = sc.episode_id
        where sc.project_id = $1 ${ep ? 'and sc.episode_id = $2' : ''} order by sc.ord, sc.created_at`, ep ? [p.id, ep.id] : [p.id])).rows
    const shots = (await db.q(`
      select s.code, sc.code as scene, s.status, s.priority, s.reject_count as rejections, s.prompt_version,
             s.def->>'story_beat' as story_beat, (s.def->>'duration_s')::float8 as duration_s, s.updated_at,
             (select count(*)::int from candidates c where c.shot_id = s.id) as candidates,
             (select c.n from candidates c where c.shot_id = s.id and c.asset_id = s.pick_asset_id) as picked,
             -- a still for the card: the picked take's last frame, else the newest take's
             (select f.id from candidates c join assets f on f.generation_id = c.generation_id and f.kind = 'frame'
               where c.shot_id = s.id order by (c.asset_id = s.pick_asset_id) desc nulls last, c.n desc limit 1) as thumb,
             (select count(*)::int from generations g where g.shot_id = s.id and g.status in ('queued','running')) as pending
        from shots s join scenes sc on sc.id = s.scene_id
       where s.project_id = $1 ${ep ? 'and sc.episode_id = $2' : ''} order by sc.ord, sc.created_at, s.ord, s.created_at`, ep ? [p.id, ep.id] : [p.id])).rows
    const lim = seedance.limits(p.info)
    const q = (await db.q(`select count(*) filter (where created_at > now() - interval '1 hour')::int as used,
        count(*) filter (where status = 'running')::int as running, count(*) filter (where status = 'queued')::int as queued
        from generations where project_id = $1 and engine = 'seedance'`, [p.id])).rows[0]
    const bible = (await db.q(`select
        (select count(*)::int from characters where project_id = $1) as characters,
        (select count(*)::int from characters where project_id = $1 and status = 'locked') as characters_locked,
        (select count(*)::int from locations where project_id = $1) as locations,
        (select count(*)::int from locations where project_id = $1 and status = 'locked') as locations_locked`, [p.id])).rows[0]
    const cfg = seedance.config()
    const orders = (await db.q(`select role, count(*)::int as n, count(*) filter (where status = 'stuck')::int as stuck
        from orders where project_id = $1 and status in ('open','sent','stuck') group by role`, [p.id])).rows
    return { project: projectView(p), episodes, episode: ep?.code ?? null, ratio: ratioOf(p.info), orders,
      scenes, shots, bible, seedance_ready: !!(cfg.base && cfg.key), rejects_to_human: REJECTS_TO_HUMAN, tts_ready: ttsReady(),
      quota: { used: q.used, per_hour: lim.perHour, concurrent: lim.concurrent, running: q.running, queued: q.queued } }
  }
  H['shot.detail'] = async (a, ctx) => {
    const p = await projectOf(ctx.actorKey, a)
    const s = await shotOf(p, a.shot ?? a.code)
    const scene = (await db.q('select code, title from scenes where id = $1', [s.scene_id])).rows[0]
    const prompts = (await db.q('select version, text, ref_asset_ids as refs, note, created_by, created_at from shot_prompts where shot_id = $1 order by version desc', [s.id])).rows
    const candidates = (await db.q(`
      select c.n, c.asset_id, c.prompt_version, c.created_at, g.id as generation_id, g.round, g.model,
             g.params->>'trim_to' as trim_to, v.mime, v.duration_ms, v.width, v.height,
             (select f.id from assets f where f.generation_id = c.generation_id and f.kind = 'frame' order by f.created_at limit 1) as frame
        from candidates c join generations g on g.id = c.generation_id join assets v on v.id = c.asset_id
       where c.shot_id = $1 order by c.n`, [s.id])).rows
    const generations = (await db.q(`select id, round, model, status, error, prompt_version, requested_by, created_at, finished_at, duration_ms
        from generations where shot_id = $1 order by created_at desc limit 60`, [s.id])).rows
    const sheets = (await db.q(`select id, tags, created_at from assets where shot_id = $1 and kind = 'sheet' order by created_at desc limit 10`, [s.id])).rows
    const reviews = (await db.q('select verdict, pick, route, reason, note, attempt, reviewer, created_at from reviews where shot_id = $1 order by id', [s.id])).rows
    return { code: s.code, scene, status: s.status, priority: s.priority, def: s.def, rejections: s.reject_count,
      rejects_to_human: REJECTS_TO_HUMAN, prompt_version: s.prompt_version,
      picked: candidates.find(c => c.asset_id === s.pick_asset_id)?.n ?? null,
      prompts, candidates, generations, sheets, reviews }
  }

  H['review.history'] = async (a, ctx) => {
    const p = await projectOf(ctx.actorKey, a)
    const s = await shotOf(p, a.shot ?? a.code)
    const reviews = (await db.q('select verdict, pick, route, reason, note, scores, attempt, reviewer, created_at from reviews where shot_id = $1 order by id', [s.id])).rows
    const prompts = (await db.q('select version, text, ref_asset_ids as refs, note, created_by, created_at from shot_prompts where shot_id = $1 order by version', [s.id])).rows
    return { shot: s.code, status: s.status, rejections: s.reject_count, reviews, prompts }
  }

  return { handlers: H, projectOf, assetOf, finishGeneration, addAsset, stash, stashText, dataUrl, moveShot, newGeneration }
}
