// End-to-end check of the web workbench's side of the studio, through a RUNNING deployment, with a
// fake Seedance. It builds a small film — two scenes, a locked character, shots in every state, real
// takes with last frames — then does what a person does in the workbench, through the same endpoint
// the page uses (/api/studio/call), and checks the artifacts: the board, the shot page, the files
// streamed with byte ranges, the notices in the crew group, the audit.
//
// The film is left in place (project wb-<run>): it is what the screenshots are taken of.
//
//   Run from the deployment directory, with in .env (the same as e2e-platform):
//     SEEDANCE_BASE_URL=http://host.docker.internal:18777/sd  SEEDANCE_API_KEY=sd-key  NOTIFY_QUIET_MS=1000
//   node studio/e2e-workbench.mjs <deployment dir>
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { readFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'

const DIR = process.argv[2] ?? '.'
const ENV = Object.fromEntries(readFileSync(join(DIR, '.env'), 'utf8').split('\n').map(l => l.match(/^(\w+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2]]))
const APP = `http://127.0.0.1:${ENV.WEB_PORT || 8080}`
const K = ENV.ACCESS_TOKEN
const RUN = Date.now().toString(36).slice(-5)
const PORT = 18777
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ---- media: three different takes, each with its last frame ----
const tmp = mkdtempSync(join(tmpdir(), 'e2ew-'))
const SOURCES = ['testsrc2=size=640x360:rate=24', 'smptehdbars=size=640x360:rate=24', 'mandelbrot=size=640x360:rate=24']
const TAKES = SOURCES.map((src, i) => {
  // VP9 in MP4: the open-source Chromium the browser checks run in has no H.264 decoder.
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', src, '-t', '4', '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '600k', '-pix_fmt', 'yuv420p', '-y', join(tmp, `v${i}.mp4`)])
  execFileSync('ffmpeg', ['-v', 'error', '-sseof', '-0.1', '-i', join(tmp, `v${i}.mp4`), '-frames:v', '1', '-y', join(tmp, `f${i}.png`)])
  return { video: readFileSync(join(tmp, `v${i}.mp4`)), frame: readFileSync(join(tmp, `f${i}.png`)) }
})
execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x8a3b2e:size=512x768', '-frames:v', '1', '-y', join(tmp, 'ref.png')])
execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'gradients=size=768x432:c0=0x223355:c1=0xd08040', '-frames:v', '1', '-y', join(tmp, 'loc.png')])
const REF = readFileSync(join(tmp, 'ref.png')).toString('base64'), LOC = readFileSync(join(tmp, 'loc.png')).toString('base64')

// ---- fake Seedance: task n returns take n % 3 ----
let n = 0
const server = createServer(async (req, res) => {
  for await (const _ of req) {}
  const json = (code, j) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)) }
  const m = req.url.match(/^\/(v|f)(\d)\.(mp4|png)$/)
  if (m) { res.writeHead(200, { 'content-type': m[1] === 'v' ? 'video/mp4' : 'image/png' }); return res.end(TAKES[m[2]][m[1] === 'v' ? 'video' : 'frame']) }
  if (req.url.startsWith('/sd/api/v3/contents/generations/tasks')) {
    if (req.headers.authorization !== 'Bearer sd-key') return json(401, { error: { message: 'key' } })
    if (req.method === 'POST') return json(200, { id: `t${n++}` })
    const k = Number(req.url.split('/').pop().slice(1)) % 3
    return json(200, { status: 'succeeded', content: { video_url: `http://host.docker.internal:${PORT}/v${k}.mp4`, last_frame_url: `http://host.docker.internal:${PORT}/f${k}.png` } })
  }
  json(404, {})
})
await new Promise(r => server.listen(PORT, '0.0.0.0', r))

// ---- helpers ----
const api = async (method, path, body, headers = {}) => {
  const r = await fetch(`${APP}${path}${path.includes('?') ? '&' : '?'}k=${K}`, { method, headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body) })
  const buf = Buffer.from(await r.arrayBuffer())
  let j; try { j = JSON.parse(buf.toString()) } catch { j = null }
  return { status: r.status, body: j, buf, headers: r.headers }
}
const ok = async (...a) => { const r = await api(...a); assert.ok(r.status < 300, `${a[0]} ${a[1]} → ${r.status} ${r.buf.toString().slice(0, 300)}`); return r.body }
// What the page does: the panel's own door, as a person.
const panel = (action, args) => ok('POST', '/api/studio/call', { action, args })
// What the crew does (not something the page offers), seeded straight at the studio.
const crew = (actor, action, args) => {
  const j = JSON.parse(execFileSync('docker', ['compose', 'exec', '-T', '-e', `A=${JSON.stringify({ action, args })}`, '-e', `ACTOR=${actor}`, 'app', 'node', '-e',
    `fetch(process.env.STUDIO_URL+'/v1/call',{method:'POST',headers:{authorization:'Bearer '+process.env.STUDIO_TOKEN,'x-studio-actor':process.env.ACTOR},body:process.env.A}).then(r=>r.json()).then(j=>process.stdout.write(JSON.stringify(j)))`],
  { cwd: DIR, maxBuffer: 64 << 20 }).toString())
  assert.equal(j.ok, true, `${action}: ${JSON.stringify(j.error)}`)
  return j.result
}
const psql = sql => execFileSync('docker', ['compose', 'exec', '-T', 'db', 'psql', '-U', 'multiagent', '-d', 'multiagent', '-tAc', sql], { cwd: DIR }).toString().trim()

try {
  // ---- a crew and its group (no models: notices are stored, nobody is woken) ----
  const mk = async (id, name) => ok('POST', '/api/bots', { id: `${id}-${RUN}`, name: `${name}${RUN}`, persona: `你是${name}。`, model: '' })
  const D = (await mk('wbd', '顾衡')).id, A = (await mk('wba', '苏棠')).id, C = (await mk('wbc', '林野')).id, R = (await mk('wbr', '严青')).id
  const g = await ok('POST', '/api/groups', { name: `剧组${RUN}`, members: [D, A, C, R], lead: D })

  // ---- the project, set up the way the page does it ----
  const P = `wb-${RUN}`
  await panel('project.create', { id: P, name: `断崖 ${RUN}`, info: { lang: 'zh-Hans' }, notify_group: g.id })
  for (const [id, role] of [[D, 'director'], [A, 'art'], [C, 'cinematographer'], [R, 'reviewer']]) await panel('crew.set', { agent_id: id, role })
  await panel('scene.add', { project: P, code: 'S01', title: '断崖', script: '黄昏。蛮吉被逼到断崖边，咬牙拔刀。\n风从谷底卷上来。' })
  await panel('scene.add', { project: P, code: 'S02', title: '回村', script: '夜。蛮吉一瘸一拐走回村口，灯火一盏盏亮起。', ord: 1 })
  assert.equal((await api('POST', '/api/studio/call', { action: 'scene.add', args: { project: P, code: 'S01', script: 'x' } })).status, 409, 'a scene code is taken once')

  // The bible, the art director's work — then a person locks it from the page.
  crew('human', 'char.add', { project: P, name: '蛮吉', card: { hair: '黑发', clothes: '红色短袍', age: '少年' } })
  crew('human', 'look.add', { project: P, character: '蛮吉', look: '战斗装', card: { clothes: '皮甲' } })
  for (const angle of ['正', '侧']) crew('human', 'asset.save', { project: P, character: '蛮吉', look: '战斗装', kind: 'turnaround', tags: [`angle:${angle}`], data_b64: REF })
  crew('human', 'loc.add', { project: P, name: '断崖', card: { time: '黄昏' } })
  crew('human', 'asset.save', { project: P, location: '断崖', kind: 'location', data_b64: LOC })
  await panel('char.lock', { project: P, name: '蛮吉' })

  // The director's breakdown, the cinematographer's prompts and takes.
  const shot = (id, beat, extra = {}) => ({ id, duration_s: 4, shot_size: '中景', angle: '平视', camera_move: '缓推',
    characters: [{ name: '蛮吉', look: '战斗装', action: beat }], location: '断崖', light: '黄昏逆光', story_beat: beat,
    continuity: { in_from: '上一镜结尾', out_to: '下一镜开头' }, ...extra })
  crew(`agent:${D}`, 'project.use', { project: P })
  crew(`agent:${D}`, 'shot.plan', { project: P, scene: 'S01', shots: [shot('S01-SH001', '被逼到绝境后第一次反击', { priority: 'hero' }), shot('S01-SH002', '刀光一闪'), shot('S01-SH003', '风卷起尘土')] })
  crew(`agent:${D}`, 'shot.plan', { project: P, scene: 'S02', shots: [shot('S02-SH001', '一瘸一拐走回村口'), shot('S02-SH002', '灯火一盏盏亮起')] })
  for (const s of ['S01-SH001', 'S01-SH002', 'S01-SH003', 'S02-SH001'])
    crew(`agent:${C}`, 'shot.prompt', { project: P, shot: s, text: `${s}: 黄昏逆光，中景缓推，少年黑发红袍，咬牙拔刀。`, refs: [] })
  crew(`agent:${C}`, 'shot.prompt', { project: P, shot: 'S01-SH001', text: 'S01-SH001 v2: 同上，发色更黑，逆光更强。', note: '按审片意见加深发色' })
  for (const [s, k] of [['S01-SH001', 3], ['S01-SH002', 2], ['S01-SH003', 2]]) crew(`agent:${C}`, 'shot.gen', { project: P, shot: s, model: 'seedance-2.5', n: k })

  // The page refuses to generate: that stays the crew's work.
  assert.equal((await api('POST', '/api/studio/call', { action: 'shot.gen', args: { project: P, shot: 'S02-SH001', model: 'seedance-2.5', n: 1 } })).status, 400)

  let board
  for (let i = 0; i < 120; i++) {
    board = await panel('project.board', { project: P })
    if (board.shots.filter(s => s.status === 'review').length === 3) break
    await sleep(1000)
  }
  assert.deepEqual(board.shots.map(s => [s.code, s.status]), [['S01-SH001', 'review'], ['S01-SH002', 'review'], ['S01-SH003', 'review'], ['S02-SH001', 'prompted'], ['S02-SH002', 'planned']])
  assert.deepEqual(board.scenes.map(s => s.code), ['S01', 'S02'])
  const sh1 = board.shots[0]
  assert.equal(sh1.candidates, 3); assert.equal(sh1.priority, 'hero'); assert.ok(sh1.thumb, 'a still for the card: the newest take’s last frame')
  assert.equal(board.bible.characters_locked, 1)

  // ---- the shot page ----
  let d = await panel('shot.detail', { project: P, shot: 'S01-SH001' })
  assert.deepEqual(d.candidates.map(c => c.n), [1, 2, 3])
  assert.ok(d.candidates.every(c => c.frame && c.mime === 'video/mp4' && c.duration_ms > 3000), 'each take: a video, its last frame, its length')
  assert.equal(d.prompts.length, 2); assert.equal(d.prompts[0].version, 2, 'newest prompt first')
  assert.equal(d.scene.code, 'S01'); assert.equal(d.rejects_to_human, 3)

  // Files for the page: a take seeks by byte range, a still is an image, a bad range is 416.
  const size = Number(psql(`select bytes from studio.assets where id = '${d.candidates[0].asset_id}'`))
  const part = await api('GET', `/api/studio/file/${d.candidates[0].asset_id}`, undefined, { range: 'bytes=0-99' })
  assert.equal(part.status, 206); assert.equal(part.buf.length, 100)
  assert.equal(part.headers.get('content-range'), `bytes 0-99/${size}`); assert.equal(part.headers.get('content-type'), 'video/mp4')
  const whole = await api('GET', `/api/studio/file/${d.candidates[0].asset_id}`)
  assert.equal(whole.status, 200); assert.equal(whole.buf.length, size); assert.deepEqual(whole.buf.subarray(0, 100), part.buf)
  assert.equal((await api('GET', `/api/studio/file/${d.candidates[0].asset_id}`, undefined, { range: `bytes=${size}-` })).status, 416)
  const still = await api('GET', `/api/studio/file/${sh1.thumb}`)
  assert.equal(still.status, 200); assert.equal(still.headers.get('content-type'), 'image/png')
  assert.equal((await api('GET', '/api/studio/file/as_nope')).status, 404)

  // ---- a person reviews from the page ----
  await panel('shot.sheet', { project: P, shot: 'S01-SH001' })
  await panel('shot.approve', { project: P, shot: 'S01-SH001', pick: 2 })
  assert.equal((await api('POST', '/api/studio/call', { action: 'shot.reject', args: { project: P, shot: 'S01-SH002', reason: 'too short', route: 'prompt' } })).status, 400,
    'a rejection must say what to fix — the studio’s rule holds for a person too')
  await panel('shot.reject', { project: P, shot: 'S01-SH002', reason: '第 1、2 条发色都偏棕，和定稿的黑发不符，请重写提示词强调黑发', route: 'prompt' })
  assert.equal((await api('POST', '/api/studio/call', { action: 'shot.approve', args: { project: P, shot: 'S01-SH001', pick: 1 } })).status, 409, 'approved once')

  d = await panel('shot.detail', { project: P, shot: 'S01-SH001' })
  assert.equal(d.status, 'approved'); assert.equal(d.picked, 2); assert.equal(d.sheets.length, 1)
  assert.deepEqual(d.reviews.map(r => [r.verdict, r.pick, r.reviewer]), [['approve', 2, 'human']])
  board = await panel('project.board', { project: P })
  assert.deepEqual(board.shots.map(s => s.status), ['approved', 'rejected', 'review', 'prompted', 'planned'])
  assert.equal(board.shots[0].picked, 2)

  // The crew hears it in the group: the approval wakes nobody; the rejection goes to the cinematographer, marked as a person's.
  let notices = []
  for (let i = 0; i < 40; i++) {
    notices = (await ok('GET', `/api/groups/${g.id}/messages`)).filter(m => m.speaker === 'Studio').map(m => m.text)
    if (notices.some(t => t.includes('人工通过')) && notices.some(t => t.includes('人工打回'))) break
    await sleep(500)
  }
  assert.ok(notices.includes('S01-SH001 已由人工通过（第 2 条）。'), notices.join(' | '))
  assert.ok(notices.some(t => t.startsWith(`@林野${RUN} S01-SH002 被打回（第 1 次，prompt）`) && t.endsWith('（人工打回）')), notices.join(' | '))
  assert.equal(psql(`select count(*) from studio.audit where actor = 'human' and action in ('shot.approve','shot.reject') and ok`) >= '2', true)

  // Locking a scene from the page: refused until every shot in it is approved.
  assert.equal((await api('POST', '/api/studio/call', { action: 'shot.lock', args: { project: P, scene: 'S01' } })).status, 409)

  console.log(`e2e-workbench: all checks passed (project ${P} left in place)`)
} finally {
  server.close()
}
