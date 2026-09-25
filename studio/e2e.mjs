// End-to-end check of the studio against real PostgreSQL and real ffmpeg, with fake Seedance and
// GPT-image servers standing in for the paid APIs. It checks ARTIFACTS — files in the store,
// rows in the database, pixels in the sheet — not just that calls answered "ok" (CLAUDE.md 2.14).
//
//   STUDIO_DATABASE_URL=postgres://studio:…@host/multiagent node studio/e2e.mjs
//
// Needs the studio role and schema to exist (the app creates them) and ffmpeg on PATH.
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import pg from 'pg'

const HERE = dirname(fileURLToPath(import.meta.url))
const DB = process.env.STUDIO_DATABASE_URL
if (!DB) { console.error('set STUDIO_DATABASE_URL'); process.exit(2) }
const sql = new pg.Pool({ connectionString: DB, options: '-c search_path=studio' })
const dir = await mkdtemp(join(tmpdir(), 'studio-e2e-'))
const ff = args => execFileSync('ffmpeg', ['-v', 'error', ...args, '-y'])
const sha = b => createHash('sha256').update(b).digest('hex')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const RUN = Date.now().toString(36)

// ---- media the fakes hand out ----
ff(['-f', 'lavfi', '-i', 'color=c=red:s=600x900', '-frames:v', '1', join(dir, 'red.png')])
ff(['-f', 'lavfi', '-i', 'color=c=blue:s=600x900', '-frames:v', '1', join(dir, 'blue.png')])
ff(['-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=24:duration=4', '-pix_fmt', 'yuv420p', join(dir, 'take.mp4')])
ff(['-f', 'lavfi', '-i', 'color=c=green:s=640x360', '-frames:v', '1', join(dir, 'last.jpg')])
const RED = await readFile(join(dir, 'red.png')), BLUE = await readFile(join(dir, 'blue.png'))
const TAKE = await readFile(join(dir, 'take.mp4')), LAST = await readFile(join(dir, 'last.jpg'))

// ---- fake Seedance: every task runs for two polls; prompts with FAIL-ONE fail their 2nd take ----
const tasks = new Map()
let created = 0, running = 0, maxRunning = 0
const bodies = []
const seed = createServer(async (req, res) => {
  let b = ''; for await (const c of req) b += c
  const json = (code, j) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)) }
  if (req.url === '/v.mp4') { res.writeHead(200, { 'content-type': 'video/mp4' }); return res.end(TAKE) }
  if (req.url === '/last.jpg') { res.writeHead(200, { 'content-type': 'image/jpeg' }); return res.end(LAST) }
  if (req.headers.authorization !== 'Bearer sd-key') return json(401, { error: { message: 'bad key' } })
  if (req.method === 'POST') {
    const body = JSON.parse(b); bodies.push(body)
    const id = `cgt-${++created}`
    const text = body.content[0].text
    tasks.set(id, { polls: 0, fail: text.includes('FAIL-ONE') && created % 3 === 2 })
    running++; maxRunning = Math.max(maxRunning, running)
    return json(200, { id })
  }
  const t = tasks.get(req.url.split('/').pop())
  if (!t) return json(404, { error: { message: 'no task' } })
  if (++t.polls < 2) return json(200, { status: 'running' })
  if (!t.done) { t.done = true; running-- }
  const base = `http://127.0.0.1:${seed.address().port}`
  return json(200, t.fail ? { status: 'failed', error: { message: 'OutputVideoSensitiveContentDetected' } }
    : { status: 'succeeded', content: { video_url: `${base}/v.mp4`, last_frame_url: `${base}/last.jpg` }, usage: { completion_tokens: 1234 } })
})
// ---- fake GPT image: generations → red turnaround ----
const gpt = createServer(async (req, res) => {
  for await (const _ of req);
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ data: [{ b64_json: RED.toString('base64') }] }))
})
await Promise.all([seed, gpt].map(s => new Promise(r => s.listen(0, '127.0.0.1', r))))

// ---- the studio itself ----
const PORT = 18000 + Math.floor(Math.random() * 1000)
const TOKEN = 'e2e-token-0123456789'
let child
async function startStudio() {
  child = spawn(process.execPath, [join(HERE, 'server.mjs')], { stdio: ['ignore', 'pipe', 'pipe'], env: {
    ...process.env, STUDIO_TOKEN: TOKEN, STUDIO_PORT: String(PORT), STUDIO_DATA: join(dir, 'data'),
    SEEDANCE_BASE_URL: `http://127.0.0.1:${seed.address().port}`, SEEDANCE_API_KEY: 'sd-key',
    GPT_IMAGE_BASE_URL: `http://127.0.0.1:${gpt.address().port}/v1`, GPT_IMAGE_API_KEY: 'sk',
    STUDIO_TICK_MS: '200', STUDIO_POLL_MS: '100' } })
  child.stderr.on('data', d => process.stderr.write(`[studio] ${d}`))
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok) return } catch {}
    await sleep(100)
  }
  throw new Error('studio did not come up')
}
const stopStudio = () => new Promise(r => { child.once('close', r); child.kill() })

const call = async (actor, action, args = {}) => {
  const r = await fetch(`http://127.0.0.1:${PORT}/v1/call`, { method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'x-studio-actor': actor }, body: JSON.stringify({ action, args }) })
  return { status: r.status, ...(await r.json()) }
}
const ok = async (actor, action, args) => {
  const r = await call(actor, action, args)
  assert.equal(r.ok, true, `${actor} ${action}: ${JSON.stringify(r.error)}`)
  return r.result
}
const refused = async (actor, action, args, code, re) => {
  const r = await call(actor, action, args)
  assert.equal(r.ok, false, `${actor} ${action} should have been refused`)
  assert.equal(r.error.code, code, `${action}: ${r.error.message}`)
  if (re) assert.match(r.error.message, re)
  return r
}
const waitShot = async (actor, code, want) => {
  for (let i = 0; i < 150; i++) {
    const s = await ok(actor, 'shot.show', { shot: code })
    if (s.status === want) return s
    await sleep(100)
  }
  throw new Error(`${code} never reached ${want}`)
}

try {
  await startStudio()
  const P = `e2e-${RUN}`
  const [D, A, C, R] = ['d', 'a', 'c', 'r'].map(x => `agent:${x}${RUN}`)
  const H = 'human'

  // Project, crew, and each caller's own current project.
  await ok(H, 'project.create', { id: P, name: 'E2E', info: { style: 'flat 2D', seedance: { per_hour: 8, concurrent: 2 } } })
  for (const [who, role] of [[D, 'director'], [A, 'art'], [C, 'cinematographer'], [R, 'reviewer']])
    await ok(H, 'crew.set', { agent_id: who.slice(6), role })
  for (const who of [H, D, A, C, R]) await ok(who, 'project.use', { project: P })

  // ---- art: a character, a look, references ----
  await ok(A, 'char.add', { name: '蛮吉', card: { hair: 'black', height_cm: 150 }, forbidden: ['黑发', '左脸疤'] })
  await ok(A, 'look.add', { character: '蛮吉', look: '战斗装' })
  const gen = await ok(A, 'asset.gen', { engine: 'gpt-image', prompt: 'front turnaround', kind: 'turnaround',
    character: '蛮吉', look: '战斗装', tags: ['angle:正面', 'light:白天'] })
  const front = gen.assets[0]
  assert.deepEqual(front.tags, ['angle:正', 'light:白天'], 'tags are normalised on the way in')
  assert.equal(front.sha256, sha(RED), 'the stored bytes are what the engine returned')
  assert.ok((await stat(join(dir, 'data/objects', front.sha256.slice(0, 2), front.sha256.slice(2, 4), front.sha256))).isFile())
  const side = await ok(A, 'asset.save', { data_b64: BLUE.toString('base64'), mime: 'image/gif', kind: 'turnaround',
    character: '蛮吉', look: '战斗装', tags: 'angle:侧面' })
  assert.equal(side.mime, 'image/png', 'the real type is sniffed, not taken from the caller')
  await refused(A, 'asset.save', { data_b64: Buffer.from('not an image').toString('base64'), kind: 'turnaround' }, 'bad_file')

  let refs = await ok(C, 'char.refs', { name: '蛮吉', look: '战斗装', angle: '3/4' })
  assert.equal(refs.refs.length, 0, 'no 3/4 view — and angle is never relaxed into a wrong one')
  refs = await ok(C, 'char.refs', { name: '蛮吉', look: '战斗装', angle: '正', light: '黄昏' })
  assert.deepEqual(refs.refs.map(r => r.id), [front.id]); assert.deepEqual(refs.relaxed, ['light'])
  const lineage = await ok(C, 'asset.show', { id: front.id })
  assert.equal(lineage.lineage.engine, 'gpt-image'); assert.equal(lineage.lineage.prompt, 'front turnaround')

  // ---- locking is a person's ----
  await refused(A, 'char.lock', { name: '蛮吉' }, 'forbidden', /only be done by a person/)
  await ok(H, 'char.lock', { name: '蛮吉' })
  await refused(A, 'char.edit', { name: '蛮吉', card: { hair: 'brown' } }, 'locked')
  await refused(A, 'asset.save', { data_b64: BLUE.toString('base64'), kind: 'turnaround', character: '蛮吉', look: '战斗装' }, 'locked')
  await ok(A, 'asset.save', { data_b64: BLUE.toString('base64'), kind: 'negative', character: '蛮吉', look: '战斗装', tags: 'negative' })
  assert.equal((await ok(C, 'char.show', { name: '蛮吉' })).looks[0].status, 'locked', 'locking a character locks its looks')

  // ---- director: scenes and the shot list ----
  await ok(D, 'scene.add', { code: 'S01', title: '断崖', script: '蛮吉被逼到断崖边，拔刀起身。' })
  await refused(D, 'scene.add', { code: 'S01', script: 'rewritten' }, 'exists', /only a person/)
  await refused(D, 'scene.edit', { code: 'S01', script: 'x' }, 'forbidden')
  const plan = await ok(D, 'shot.plan', { scene: 'S01', shots: [
    { id: 'S01-SH001', duration_s: 3, shot_size: '中景', characters: [{ name: '蛮吉', look: '战斗装', action: '拔刀起身' }],
      priority: 'hero', continuity: { out_to: 'S01-SH002' } },
    { id: 'S01-SH002', duration_s: 5, characters: [], priority: 'filler' }] })
  assert.equal(plan.warnings.length, 1, 'the shot without continuity is flagged')
  await refused(C, 'shot.plan', { scene: 'S01', shots: [] }, 'forbidden')

  // ---- cinematographer: prompt, generate ----
  await refused(C, 'shot.gen', { shot: 'S01-SH001', model: 'seedance-2.5', n: 3 }, 'bad_state', /prompt first/)
  await ok(C, 'shot.prompt', { shot: 'S01-SH001', text: 'FAIL-ONE 蛮吉 draws his blade and rises', refs: [front.id] })
  const g1 = await ok(C, 'shot.gen', { shot: 'S01-SH001', model: 'seedance-2.5', n: 3 })
  assert.equal(g1.left_this_hour, 5)
  await ok(C, 'shot.prompt', { shot: 'S01-SH002', text: 'the cliff at dusk' })
  await refused(C, 'shot.gen', { shot: 'S01-SH002', model: 'seedance-2.0', n: 6 }, 'rate_limited', /at most 5 more/)
  await refused(C, 'shot.gen', { shot: 'S01-SH001', model: 'seedance-2.5', n: 1 }, 'bad_state', /already generating/)

  const s1 = await waitShot(R, 'S01-SH001', 'review')
  assert.equal(s1.candidates.length, 2, 'two takes succeeded, one failed')
  assert.deepEqual(s1.candidates.map(c => c.n), [1, 2])
  assert.equal(s1.generations.failed, 1)
  assert.ok(maxRunning <= 2, `never more than the project's 2 at once (saw ${maxRunning})`)
  // What went to Seedance, field by field.
  const sent = bodies[0]
  assert.equal(sent.model, 'dreamina-seedance-2-5-260628')
  assert.equal(sent.generate_audio, false); assert.equal(sent.duration, 4, '3 s shot → 4 s minimum')
  assert.equal(sent.content[1].role, 'reference_image')
  assert.equal(sent.content[1].image_url.url, `data:image/png;base64,${RED.toString('base64')}`, 'the reference is the stored file')
  // The footage is in the store, byte for byte — not a URL that dies in 24 hours.
  const v = (await sql.query(`select a.* from candidates c join assets a on a.id = c.asset_id join shots s on s.id = c.shot_id
      where s.code = 'S01-SH001' and s.project_id = $1 order by c.n`, [P])).rows
  assert.equal(v.length, 2)
  for (const a of v) {
    assert.equal(a.sha256, sha(TAKE)); assert.equal(a.kind, 'video'); assert.equal(a.width, 640)
    assert.ok(a.tags.includes('trim_to:3'))
    assert.deepEqual(await readFile(join(dir, 'data/objects', a.sha256.slice(0, 2), a.sha256.slice(2, 4), a.sha256)), TAKE)
  }
  const frames = (await sql.query(`select count(*)::int as n from assets where project_id = $1 and kind = 'frame'`, [P])).rows[0].n
  assert.equal(frames, 2, 'the last frame of each good take is kept')
  const g = (await sql.query(`select * from generations where project_id = $1 and engine = 'seedance' order by created_at`, [P])).rows
  assert.ok(g.every(x => x.remote_id && x.round === g1.round && x.prompt_version === 1 && x.ref_asset_ids[0] === front.id), 'lineage on every take')
  assert.equal(g.find(x => x.status === 'failed').error, 'OutputVideoSensitiveContentDetected')
  assert.ok(g.filter(x => x.status === 'succeeded').every(x => x.duration_ms >= 0 && x.usage.completion_tokens === 1234))

  // ---- reviewer: the sheet, then the verdicts ----
  await refused(C, 'shot.sheet', { shot: 'S01-SH001' }, 'forbidden')
  const sheet = await ok(R, 'shot.sheet', { shot: 'S01-SH001' })
  assert.deepEqual(sheet.candidates, [1, 2]); assert.equal(sheet.reference_row[0].asset_id, front.id)
  assert.equal(sheet.reference_row[0].locked, true)
  const jpg = Buffer.from(await (await fetch(`http://127.0.0.1:${PORT}/v1/files/${sheet.sheet.id}`, { headers: { authorization: `Bearer ${TOKEN}` } })).arrayBuffer())
  assert.equal(sha(jpg), sheet.sheet.sha256, 'the file endpoint serves exactly the stored sheet')
  const px = execFileSync('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-vf', 'crop=8:8:164:154,scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { input: jpg })
  assert.ok(px[0] > 200 && px[1] < 60, `the reference cell shows the red turnaround (got ${[...px]})`)
  assert.equal((await fetch(`http://127.0.0.1:${PORT}/v1/files/${sheet.sheet.id}`)).status, 401, 'files need the token too')

  await refused(R, 'shot.reject', { shot: 'S01-SH001', reason: 'bad', route: 'prompt' }, 'bad_arg', /specifically/)
  let rj = await ok(R, 'shot.reject', { shot: 'S01-SH001', reason: 'candidates 1–2: hair is brown, the card says black', route: 'prompt' })
  assert.equal(rj.attempt, 1); assert.equal(rj.goes_to, 'cinematographer')
  await refused(C, 'shot.approve', { shot: 'S01-SH001', pick: 1 }, 'forbidden', /not part of the cinematographer/)
  for (const [n, route, to] of [[2, 'asset', 'art'], [3, 'prompt', 'human']]) {
    await ok(C, 'shot.prompt', { shot: 'S01-SH001', text: `fix ${n}: black hair`, refs: [front.id] })
    await ok(C, 'shot.gen', { shot: 'S01-SH001', model: 'seedance-2.5', n: 1 })
    await waitShot(R, 'S01-SH001', 'review')
    rj = await ok(R, 'shot.reject', { shot: 'S01-SH001', reason: `still wrong after fix ${n}, the blade is in the wrong hand`, route })
    assert.equal(rj.attempt, n); assert.equal(rj.goes_to, to)
  }
  assert.match(rj.note, /goes to a person/)
  const hist = await ok(D, 'review.history', { shot: 'S01-SH001' })
  assert.equal(hist.reviews.length, 3); assert.equal(hist.prompts.length, 3, 'every prompt version kept')
  // The hourly cap counted everything: 3 + 1 + 1 = 5 of 8.
  await refused(C, 'shot.gen', { shot: 'S01-SH001', model: 'seedance-2.5', n: 4 }, 'rate_limited', /at most 3 more/)
  await ok(C, 'shot.gen', { shot: 'S01-SH001', model: 'seedance-2.5', n: 1 })
  const last = await waitShot(R, 'S01-SH001', 'review')
  assert.deepEqual(last.candidates.map(c => c.n), [1, 2, 3, 4, 5], 'candidate numbers are never reused')
  await refused(R, 'shot.approve', { shot: 'S01-SH001', pick: 9 }, 'bad_arg')
  await ok(R, 'shot.approve', { shot: 'S01-SH001', pick: 5, note: 'clean' })
  await refused(D, 'shot.lock', { scene: 'S01' }, 'bad_state', /S01-SH002 is prompted/)
  await refused(C, 'shot.prompt', { shot: 'S01-SH001', text: 'x' }, 'bad_state', /can't take a new prompt/)

  // ---- projects are separate ----
  await ok(H, 'project.create', { id: `${P}-b`, name: 'Other film' })
  await ok(A, 'project.use', { project: `${P}-b` })
  await refused(A, 'char.show', { name: '蛮吉' }, 'no_such_character', /has no character/)
  await refused(A, 'asset.show', { id: front.id }, 'no_such_asset')
  assert.equal((await ok(C, 'project.current')).project, P, "the art director's switch didn't move the cinematographer")

  // ---- a take claimed but never sent survives a restart as a clear failure, not a second bill ----
  await stopStudio()
  const shotId = (await sql.query(`select id from shots where project_id = $1 and code = 'S01-SH002'`, [P])).rows[0].id
  await sql.query(`update shots set status = 'generating' where id = $1`, [shotId])
  await sql.query(`insert into generations (id, project_id, shot_id, engine, model, kind, status, round, started_at)
    values ('gen_orphan${RUN}', $1, $2, 'seedance', 'seedance-2.0', 'video', 'running', 'rd_orphan', now())`, [P, shotId])
  const before = created
  await startStudio()
  await sleep(800)
  const orphan = (await sql.query(`select status, error from generations where id = 'gen_orphan${RUN}'`)).rows[0]
  assert.equal(orphan.status, 'failed'); assert.match(orphan.error, /may have been billed/)
  assert.equal(created, before, 'nothing was resubmitted')
  assert.equal((await ok(D, 'shot.show', { shot: 'S01-SH002' })).status, 'prompted', 'its round closed as failed')

  // ---- the audit trail has the refusals ----
  const audit = (await sql.query(`select actor, action from audit where not ok and actor like '%${RUN}'`)).rows
  assert.ok(audit.some(r => r.action === 'char.lock' && r.actor === A))
  assert.ok(audit.some(r => r.action === 'shot.approve' && r.actor === C))

  console.log('e2e: all checks passed')
} finally {
  if (child && child.exitCode === null) await stopStudio()
  seed.close(); gpt.close(); await sql.end()
  await rm(dir, { recursive: true, force: true })
}
