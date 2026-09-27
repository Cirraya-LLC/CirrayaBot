// End-to-end: one episode of a series, from a person's script to the finished cut, through the REAL
// platform and studio (a running compose deployment). Scripted fake models stand in for the crew,
// with fake Seedance and fake speech (TTS) servers:
//
//   a person adds E01 and starts it → the director gets a breakdown work order IN HIS OWN CHAT,
//   cuts scenes and shots with dialogue, submits → a person sends it back once with a note → the
//   director gets it again (rev 1, the note in it) and resubmits → a person approves → the art
//   director gets "references" orders, makes them → a person locks them → the cinematographer gets
//   "prompt + generate" orders → takes → the reviewer gets a review order, SEES the sheet (after one
//   429), rejects one shot → the cinematographer gets the fix → … everything approved → the studio
//   cuts the episode on its own (9:16 H.264, narration by TTS, subtitles burned in + .srt) → a person
//   is told in the group → approves → done.
//
// And on the way: nobody hands work over with an @ — the group holds only the studio's lines; the
// director runs on "deepseek-flash" (our own loop now, not DeepSeek Harness) and its reasoning is
// passed back on every later request; the crew is offered the studio tool and nothing else.
//
// It asserts on artifacts: studio state, the files, what the models and Seedance were actually sent.
//
//   Run from the deployment directory, with in .env:
//     SEEDANCE_BASE_URL=http://host.docker.internal:18777/sd  SEEDANCE_API_KEY=sd-key  NOTIFY_QUIET_MS=1000
//   node studio/e2e-platform.mjs <deployment dir>
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
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
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a)

// ---- media for the fakes: a 16:9 take with sound (Seedance), a still, a short speech clip ----
const tmp = mkdtempSync(join(tmpdir(), 'e2es-'))
execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=24:duration=5', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=5',
  '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', join(tmp, 't.mp4')])
execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=512x768', '-frames:v', '1', '-y', join(tmp, 'ref.png')])
execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=900:duration=1.6', '-y', join(tmp, 'v.mp3')])
const TAKE = readFileSync(join(tmp, 't.mp4')), PNG = readFileSync(join(tmp, 'ref.png')).toString('base64'), MP3 = readFileSync(join(tmp, 'v.mp3'))

// ---- the fake crew: one scripted person per ROLE marker. Each turn is a list of studio calls,
// made one per step; the step is the number of tool calls since the newest user message. ----
const seen = []
const sse = (res, frames) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const f of frames) res.write(`data: ${JSON.stringify(f)}\n\n`)
  res.end('data: [DONE]\n\n')
}
const textOf = m => (Array.isArray(m?.content) ? m.content.filter(x => x.type === 'text').map(x => x.text).join('') : String(m?.content ?? ''))
const shotsIn = s => [...new Set(s.match(/E01-S\d+-SH\d+/g) ?? [])]
const rejectedOnce = new Set()
let reviewRounds = 0

const SCRIPT = {
  director: said => /被退回|上一版人给的意见|可以拆了/.test(said) ? [
    ['scene.add', { code: 'E01-S01', episode: 'E01', title: '断崖', script: '蛮吉在断崖上拔刀。' }],
    ['shot.plan', { scene: 'E01-S01', shots: [
      { id: 'E01-S01-SH001', duration_s: 3, characters: [{ name: '蛮吉', look: '战斗装' }], location: '断崖', story_beat: '拔刀',
        continuity: { out_to: 'E01-S01-SH002' }, dialogue: [{ speaker: '蛮吉', text: '谁也别想过去！', kind: 'onscreen' }] },
      { id: 'E01-S01-SH002', duration_s: 4, characters: [{ name: '蛮吉', look: '战斗装' }], location: '断崖', story_beat: '风起',
        continuity: { in_from: 'E01-S01-SH001' }, dialogue: [{ kind: 'narration', text: '那一年，他十二岁。' }, { kind: 'narration', text: '风从断崖下面吹上来，他握着刀的手一直在抖，却没有退后半步。' }] },
    ] }],
    ['episode.submit', { episode: 'E01' }],
  ] : [],
  art: said => /补参考图|要用到/.test(said) ? [
    ['char.add', { name: '蛮吉', card: { hair: 'black' } }],
    ['look.add', { character: '蛮吉', look: '战斗装' }],
    ['asset.save', { character: '蛮吉', look: '战斗装', kind: 'turnaround', tags: ['正'], data_b64: PNG }],
    ['loc.add', { name: '断崖' }],
    ['asset.save', { location: '断崖', kind: 'location', data_b64: PNG }],
    ['voice.list', { query: '少年' }],
    ['char.voice', { name: '蛮吉', voice: 'male-qn-qingse', emotion: 'angry' }],
  ] : [],
  cinematographer: said => shotsIn(said).flatMap(s => [
    ['shot.prompt', { shot: s, text: `${s}: boy draws a blade on a cliff, black hair, ${Date.now()}` }],
    ['shot.gen', { shot: s, model: 'seedance-2.5', n: 1 }],
  ]),
  // The reviewer rejects SH001 once (on the image it saw), and approves everything else.
  reviewer: said => shotsIn(said).flatMap(s => [
    ['shot.sheet', { shot: s }],
    rejectedOnce.has(s) || !s.endsWith('SH001')
      ? ['shot.approve', { shot: s, pick: 'LAST' }]
      : ['shot.reject', { shot: s, reason: 'hair colour drifts brown in every take; the card says black', route: 'prompt' }],
  ]),
}

function model(body, res) {
  const msgs = body.messages
  const role = (textOf(msgs[0]).match(/ROLE:(\w+)/) ?? [])[1] ?? 'none'
  const iUser = msgs.findLastIndex(m => m.role === 'user' && !Array.isArray(m.content) && !/^\(the image/.test(textOf(m)))
  const said = textOf(msgs[iUser])
  const step = msgs.slice(iUser + 1).filter(m => m.tool_calls).length
  const last = msgs.at(-1)
  const image = Array.isArray(last.content) && last.content.some(x => x.type === 'image_url' && x.image_url.url.startsWith('data:image/'))
  seen.push({ role, model: body.model, tools: (body.tools ?? []).map(t => t.function.name), image, effort: body.reasoning_effort,
    assistants: msgs.filter(m => m.role === 'assistant').map(m => ({ calls: !!m.tool_calls, reasoning: m.reasoning_content ?? null })) })
  const plan = SCRIPT[role]?.(said) ?? []
  // DeepSeek-style: every answer carries reasoning, which it wants back.
  const think = body.model.startsWith('deepseek') ? [{ choices: [{ delta: { reasoning_content: `thinking ${role} ${step}` } }] }] : []
  if (step < plan.length) {
    let [action, args] = plan[step]
    if (args.pick === 'LAST') {       // the newest candidate in what shot.sheet answered
      const out = textOf(msgs.findLast(m => m.role === 'tool'))
      const ns = (out.match(/"candidates": \[([\d,\s]+)\]/)?.[1] ?? '1').split(',').map(Number)
      args = { ...args, pick: ns.at(-1) }
    }
    if (action === 'shot.reject') rejectedOnce.add(args.shot)
    if (action === 'shot.sheet') reviewRounds++
    return sse(res, [...think, { choices: [{ delta: { tool_calls: [{ index: 0, id: `c${Math.random().toString(36).slice(2, 8)}`,
      function: { name: 'studio', arguments: JSON.stringify({ action, args }) } }] } }] }, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }])
  }
  return sse(res, [...think, { choices: [{ delta: { content: plan.length ? '做完了。' : '收到。' } }] }])
}

// ---- fake Seedance and fake speech ----
const tasks = new Map(), seedanceBodies = [], ttsBodies = []
let limited = false
const server = createServer(async (req, res) => {
  let b = ''; for await (const c of req) b += c
  const json = (code, j) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)) }
  if (req.url === '/v1/chat/completions') {
    const body = JSON.parse(b)
    // The first time the reviewer is sent a picture, answer 429 once. A rate limit is not "this model
    // can't see images": the retry must still carry the sheet, or the reviewer judges blind.
    const last = body.messages.at(-1)
    if (!limited && Array.isArray(last.content) && last.content.some(x => x.type === 'image_url')) {
      limited = true
      res.writeHead(429, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"rate limited"}}')
    }
    return model(body, res)
  }
  // MiniMax: errors come inside a 200 (base_resp), audio as hex.
  const mm = { status_code: 0, status_msg: 'success' }
  if (req.url.startsWith('/mm/')) {
    if (req.headers.authorization !== 'Bearer tts-key') return json(200, { base_resp: { status_code: 1004, status_msg: 'login fail' } })
    if (req.url === '/mm/v1/get_voice') return json(200, { system_voice: [{ voice_id: 'male-qn-qingse', voice_name: '青涩青年', description: ['少年感的男声'] },
      { voice_id: 'narr-voice', voice_name: '旁白', description: ['沉稳'] }], base_resp: mm })
    if (req.url === '/mm/v1/t2a_v2') { ttsBodies.push(JSON.parse(b)); return json(200, { data: { audio: MP3.toString('hex'), status: 2 }, base_resp: mm }) }
  }
  // The upstream's model list, for picking a crew member's model.
  if (req.url === '/v1/models') return json(200, { data: ['fake-model', 'deepseek-flash', 'anthropic/claude-sonnet-5', 'anthropic/claude-sonnet-5-thinking'].map(id => ({ id })) })
  if (req.url === '/v.mp4') { res.writeHead(200, { 'content-type': 'video/mp4' }); return res.end(TAKE) }
  if (req.url.startsWith('/sd/api/v3/contents/generations/tasks')) {
    if (req.headers.authorization !== 'Bearer sd-key') return json(401, { error: { message: 'key' } })
    if (req.method === 'POST') { seedanceBodies.push(JSON.parse(b)); const id = `t${tasks.size + 1}`; tasks.set(id, 0); return json(200, { id }) }
    return json(200, { status: 'succeeded', content: { video_url: `http://host.docker.internal:${PORT}/v.mp4` } })
  }
  json(404, {})
})
await new Promise(r => server.listen(PORT, '0.0.0.0', r))

// ---- helpers ----
const api = async (method, path, body) => {
  const r = await fetch(`${APP}${path}${path.includes('?') ? '&' : '?'}k=${K}`, { method, headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await r.text()
  let j; try { j = JSON.parse(text) } catch { j = text }
  return { status: r.status, body: j }
}
const ok = async (...a) => { const r = await api(...a); assert.ok(r.status < 300, `${a[0]} ${a[1]} → ${r.status} ${JSON.stringify(r.body)}`); return r.body }
const panel = (action, args) => ok('POST', '/api/studio/call', { action, args })
const studioAsHuman = (action, args) => {
  const j = JSON.parse(execFileSync('docker', ['compose', 'exec', '-T', '-e', `A=${JSON.stringify({ action, args })}`, 'app', 'node', '-e',
    `fetch(process.env.STUDIO_URL+'/v1/call',{method:'POST',headers:{authorization:'Bearer '+process.env.STUDIO_TOKEN,'x-studio-actor':'human'},body:process.env.A}).then(r=>r.json()).then(j=>process.stdout.write(JSON.stringify(j)))`], { cwd: DIR }).toString())
  assert.equal(j.ok, true, `${action}: ${JSON.stringify(j.error)}`)
  return j.result
}
const sql = q => execFileSync('docker', ['compose', 'exec', '-T', 'db', 'psql', '-U', 'multiagent', '-d', 'multiagent', '-tAc', q], { cwd: DIR }).toString().trim()
const gw = execFileSync('docker', ['network', 'inspect', `${ENV.COMPOSE_PROJECT_NAME || 'multi-agent'}_default`, '-f', '{{(index .IPAM.Config 0).Gateway}}']).toString().trim()
async function until(what, fn, secs = 180) {
  for (let i = 0; i < secs; i++) { const v = await fn(); if (v) return v; await sleep(1000) }
  throw new Error(`timed out waiting for: ${what}`)
}
const stage = async P => (await panel('episode.show', { project: P, episode: 'E01' })).stage

try {
  // ---- setup: an upstream on the fake, four crew members (the director on deepseek-flash), a group ----
  const prov = await ok('POST', '/api/providers', { name: `fake-${RUN}`, base_url: `http://${gw}:${PORT}/v1`, protocol: 'chat', auto_context: false, context_tokens: 64000 })
  const mk = async (id, name, role, extra = {}) => (await ok('POST', '/api/bots', { id: `${id}-${RUN}`, name: `${name}${RUN}`,
    persona: `你是${name}。ROLE:${role}`, provider_id: prov.id, model: 'fake-model', ...extra })).id
  const D = await mk('dir', '顾衡', 'director', { model: 'deepseek-flash', effort: 'high' })
  const A = await mk('art', '苏棠', 'art'), C = await mk('cine', '林野', 'cinematographer'), R = await mk('rev', '严青', 'reviewer')
  const O = await mk('plain', '路人', 'none')
  const g = await ok('POST', '/api/groups', { name: `剧组${RUN}`, members: [D, A, C, R], lead: D, shared_machine: true })
  assert.equal(g.shared_machine, true, 'the crew group shares one machine')

  const P = `ser-${RUN}`
  await panel('project.create', { id: P, name: 'Series E2E', info: { lang: 'zh-Hans', narrator: { voice: 'narr-voice', emotion: 'calm' } }, notify_group: g.id })
  assert.equal((await panel('project.info', { project: P })).info.ratio, '9:16', 'a new project is vertical')

  // ---- the built-in crew (web/crew.mjs): there from the start, roles fixed, can't be deleted ----
  const bots = await ok('GET', '/api/bots')
  const builtIn = ['director', 'art', 'cinematographer', 'reviewer'].map(r => bots.find(b => b.id === `crew-${r}`))
  assert.ok(builtIn.every(b => b?.fixed), 'the four crew members exist and are marked fixed')
  assert.deepEqual(builtIn.map(b => b.candidates[0]), ['claude-opus-5-5', 'gpt-5.6-sol', 'claude-sonnet-5', 'claude-opus-5-5'])
  const roles = new Map((await panel('crew.list', {})).map(c => [c.agent_id, c.role]))
  assert.deepEqual(builtIn.map(b => roles.get(b.id)), ['director', 'art', 'cinematographer', 'reviewer'], 'their roles were set on start')
  const cg = (await ok('GET', '/api/studio/status')).crew_group
  assert.ok(cg && (await ok('GET', '/api/groups')).find(x => x.id === cg)?.members.includes('crew-director'), 'the status names the crew\'s group')
  assert.equal((await api('DELETE', '/api/bots/crew-reviewer')).status, 400, 'a built-in member can\'t be deleted')
  assert.equal((await api('POST', '/api/studio/call', { action: 'crew.set', args: { agent_id: O, role: 'reviewer' } })).status, 400, 'the panel can\'t move a role')
  // A member with no model gets the first candidate its upstream lists — the plain variant, saved; a chosen one is never touched.
  const cine = builtIn[2]
  sql(`update agents set provider_id = '${prov.id}', model = '', runtime = '' where id = 'crew-cinematographer'`)
  await ok('PATCH', `/api/providers/${prov.id}`, {})
  const picked = await until('a model picked', async () => (await ok('GET', '/api/bots')).find(b => b.id === 'crew-cinematographer').model, 20)
  assert.equal(picked, 'anthropic/claude-sonnet-5')
  sql(`update agents set model = 'mine' where id = 'crew-cinematographer'`)
  await ok('PATCH', `/api/providers/${prov.id}`, {})
  await sleep(1500)
  assert.equal((await ok('GET', '/api/bots')).find(b => b.id === 'crew-cinematographer').model, 'mine', 'a person\'s choice stays')
  sql(`update agents set provider_id = ${cine.provider_id ? `'${cine.provider_id}'` : 'null'}, model = '${cine.model.replace(/'/g, "''")}', runtime = '${cine.runtime}' where id = 'crew-cinematographer'`)

  // This run's own crew, in its own group: the pipeline gives each order to the role-holder in the project's group.
  // Roles are set straight at the studio — the page can't — as test setup.
  for (const [id, role] of [[D, 'director'], [A, 'art'], [C, 'cinematographer'], [R, 'reviewer']]) studioAsHuman('crew.set', { agent_id: id, role })
  sql(`insert into studio.actor_project values ${[D, A, C, R].map(id => `('agent:${id}', '${P}')`).join(',')} on conflict (actor) do update set project_id = excluded.project_id`)
  // Speech through the Keys panel, pointing at the fake.
  await panel('keys.set', { name: 'tts', values: { base_url: `http://${gw}:${PORT}/mm`, api_key: 'tts-key', model: 'fake-tts' } })
  // Background music, uploaded by a person in project settings.
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=3', '-y', join(tmp, 'bgm.mp3')])
  const setBgm = await panel('project.bgm', { project: P, data_b64: readFileSync(join(tmp, 'bgm.mp3')).toString('base64'), name: 'theme.mp3', level: 'low' })
  assert.equal(setBgm.bgm.level, 'low'); assert.equal(setBgm.bgm.name, 'theme.mp3')
  assert.equal((await api('POST', '/api/studio/call', { action: 'project.bgm', args: { project: P, data_b64: PNG } })).status, 400, 'a picture is not music')
  assert.equal((await panel('keys.test', { name: 'tts' })).code, 'voicesOk')
  assert.deepEqual((await panel('voice.list', { query: '沉稳' })).voices.map(v => v.id), ['narr-voice'], 'the account\'s voices, searchable')

  // ---- a person writes E01 and starts it ----
  await panel('episode.add', { project: P, code: 'E01', title: '初见', script: '蛮吉在断崖上拔刀。风起。' })
  assert.equal((await api('POST', '/api/studio/call', { action: 'episode.add', args: { project: P, code: 'E01' } })).status, 409)
  await panel('episode.start', { project: P, episode: 'E01' })

  // The director's order arrives in HIS chat, and the group gets one line about it.
  await until('breakdown submitted', async () => (await stage(P)) === 'breakdown_review')
  const dDm = await ok('GET', `/api/dm/${D}`)
  const order1 = dDm.find(m => m.speaker === 'Studio')
  assert.ok(order1 && /〔片场工单/.test(order1.content) && /可以拆了/.test(order1.content), 'the breakdown order is in the director\'s own chat, from "Studio"')
  const show = await panel('episode.show', { project: P, episode: 'E01' })
  assert.deepEqual(show.scenes.map(s => [s.code, s.shots]), [['E01-S01', 2]])

  // ---- a person sends the breakdown back once, then approves ----
  assert.equal((await api('POST', '/api/studio/call', { action: 'episode.review', args: { project: P, episode: 'E01', decision: 'revise' } })).status, 400, 'a send-back needs a note')
  await panel('episode.review', { project: P, episode: 'E01', decision: 'revise', note: '第二个镜头太长，改短一点' })
  await until('resubmitted', async () => (await stage(P)) === 'breakdown_review' && (await ok('GET', `/api/dm/${D}`)).filter(m => m.speaker === 'Studio').length === 2)
  assert.match((await ok('GET', `/api/dm/${D}`)).filter(m => m.speaker === 'Studio')[1].content, /上一版人给的意见：第二个镜头太长/, 'the second order carries the note')
  await panel('episode.review', { project: P, episode: 'E01', decision: 'approve' })
  log('breakdown approved')

  // ---- references: the art director gets them as an order; a person locks ----
  await until('references made', async () => sql(`select count(*) from studio.assets a join studio.projects p on p.id = a.project_id where p.id = '${P}' and a.kind in ('turnaround','location')`) === '2')
  const lockOrder = await until('a person asked to lock', async () => (await ok('GET', `/api/groups/${g.id}/messages`)).find(m => m.speaker === 'Studio' && /^@人类 .*等你定稿/s.test(m.text)))
  assert.ok(lockOrder)
  assert.equal(sql(`select count(*) from studio.orders where project_id = '${P}' and role = 'cinematographer'`), '0', 'nothing to prompt until the bible is locked')
  await panel('char.lock', { project: P, name: '蛮吉' })
  await panel('loc.lock', { project: P, name: '断崖' })
  log('bible locked')

  // ---- prompts, takes, review (one rejection), approval ----
  await until('both shots approved', async () => sql(`select count(*) from studio.shots where project_id = '${P}' and status = 'approved'`) === '2', 300)
  log('all approved')
  // Seedance got the vertical ratio; the shot that talks got its lines and sound, the narrated one didn't.
  const sd1 = seedanceBodies.find(b => b.content[0].text.startsWith('E01-S01-SH001')), sd2 = seedanceBodies.find(b => b.content[0].text.startsWith('E01-S01-SH002'))
  assert.equal(sd1.ratio, '9:16'); assert.equal(sd1.generate_audio, true); assert.match(sd1.content[0].text, /对白（角色出镜说出，口型同步，逐字照念）：\n蛮吉: 「谁也别想过去！」$/)
  assert.equal(sd2.generate_audio, false, 'narration is not Seedance\'s'); assert.doesNotMatch(sd2.content[0].text, /那一年/)
  assert.equal(seedanceBodies.filter(b => b.content[0].text.startsWith('E01-S01-SH001')).length, 2, 'SH001 was generated again after its rejection')
  const rev = seen.filter(s => s.role === 'reviewer')
  assert.ok(limited, 'the 429 was served'); assert.equal(rev.filter(s => s.image).length, 3, 'three sheets, three images in front of the reviewer — the first after a 429')

  // ---- the cut: made by the studio on its own, a person told ----
  const finalLine = await until('the cut is ready', async () => (await ok('GET', `/api/groups/${g.id}/messages`)).find(m => m.speaker === 'Studio' && /E01 已经剪好/.test(m.text)), 300)
  assert.match(finalLine.text, /^@人类 E01 已经剪好（\d+ 秒）/)
  const ep = await panel('episode.show', { project: P, episode: 'E01' })
  assert.equal(ep.stage, 'final_review'); assert.equal(ep.cut.status, 'done'); assert.deepEqual(ep.cut.log, [], 'nothing left out')
  // The file itself: vertical H.264 with sound, as long as the two shots (3 s trimmed from 5, 4 s).
  const vid = await fetch(`${APP}/api/studio/file/${ep.cut.video_asset_id}?k=${K}`)
  assert.equal(vid.status, 200); assert.equal(vid.headers.get('content-type'), 'video/mp4')
  writeFileSync(join(tmp, 'cut.mp4'), Buffer.from(await vid.arrayBuffer()))
  const pr = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', join(tmp, 'cut.mp4')]).toString())
  const v = pr.streams.find(s => s.codec_type === 'video')
  assert.equal(v.codec_name, 'h264'); assert.equal(v.width, 720); assert.equal(v.height, 1280)
  assert.ok(pr.streams.some(s => s.codec_type === 'audio'), 'with sound')
  assert.ok(Math.abs(Number(pr.format.duration) - 7) < 0.3, `3 s + 4 s (got ${pr.format.duration})`)
  // At the platforms' loudness, music and all.
  const ebr = execFileSync('sh', ['-c', `ffmpeg -hide_banner -nostats -i '${join(tmp, 'cut.mp4')}' -af ebur128 -f null - 2>&1 | grep -A1 'Integrated loudness' | tail -1`]).toString()
  const I = Number(ebr.match(/I:\s*(-?[\d.]+)/)?.[1])
  assert.ok(Math.abs(I + 14) < 1.5, `the cut is at -14 LUFS (got ${I})`)
  // Subtitles beside it, every line; speech in the right voices, cached.
  const srt = await (await fetch(`${APP}/api/studio/file/${ep.cut.srt_asset_id}?k=${K}`)).text()
  assert.match(srt, /蛮吉：谁也别想过去！/); assert.match(srt, /那一年，他十二岁。/)
  // Every cue fits a 9:16 frame: ≤ 2 lines of ≤ 11 characters, never broken inside a word.
  const cueTexts = srt.trim().split(/\n\n+/).map(c => c.split('\n').slice(2))
  assert.ok(cueTexts.every(ls => ls.length <= 2 && ls.every(l => [...l].length <= 11)), `cues fit the frame: ${JSON.stringify(cueTexts)}`)
  assert.equal(cueTexts.length, 4, 'the long line (29 characters, three lines) became two cues')
  assert.ok(!cueTexts.flat().some(l => /^[，。！？]/.test(l)), 'no line starts with punctuation')
  assert.equal(cueTexts.flat().join('').replace(/蛮吉：|\s/g, ''), '谁也别想过去！那一年，他十二岁。风从断崖下面吹上来，他握着刀的手一直在抖，却没有退后半步。', 'nothing lost or doubled in the layout')
  assert.deepEqual(ttsBodies.map(b => [b.text, b.voice_setting.voice_id, b.voice_setting.emotion, b.model]),
    [['那一年，他十二岁。', 'narr-voice', 'calm', 'fake-tts'], ['风从断崖下面吹上来，他握着刀的手一直在抖，却没有退后半步。', 'narr-voice', 'calm', 'fake-tts']], 'only the narration is spoken by MiniMax, in the narrator\'s voice and emotion')
  assert.deepEqual(sql(`select card->'voice' from studio.characters where project_id = '${P}' and name = '蛮吉'`), '{"voice": "male-qn-qingse", "emotion": "angry"}', 'the art director set the character\'s voice from the account\'s list')
  assert.equal(sql(`select count(*) from studio.generations where project_id = '${P}' and engine = 'tts' and status = 'succeeded'`), '2')
  await panel('episode.assemble', { project: P, episode: 'E01' })
  await until('recut', async () => sql(`select count(*) from studio.assemblies where episode_id = (select id from studio.episodes where project_id = '${P}') and status = 'done'`) === '2')
  assert.equal(ttsBodies.length, 2, 'cutting again reuses the speech')

  await panel('episode.review', { project: P, episode: 'E01', decision: 'approve' })
  assert.equal(await stage(P), 'done')
  log('episode done')

  // ---- how they talked ----
  const glog = await ok('GET', `/api/groups/${g.id}/messages`)
  assert.equal(glog.filter(m => m.role === 'assistant').length, 0, 'nobody worked in the group: every order ran in the member\'s own chat')
  assert.ok(glog.some(m => m.speaker === 'Studio' && new RegExp(`^📋 工单 → 林野${RUN}：E01-S01-SH00\\d（写提示词并生成）`).test(m.text)), 'the group sees who got what')
  const orders = sql(`select role || ':' || kind || ':' || status from studio.orders where project_id = '${P}' order by id`).split('\n')
  assert.ok(orders.every(o => /:(done|cancelled)$/.test(o)), `every order closed by the state it asked for: ${orders.join(' ')}`)
  for (const k of ['director:breakdown', 'art:asset', 'human:lock', 'cinematographer:prompt', 'reviewer:review', 'cinematographer:fixprompt', 'human:final'])
    assert.ok(orders.some(o => o.startsWith(k)), `an order ${k}`)
  // Closing by hand is only for what the studio can't see.
  const anOrder = sql(`select id from studio.orders where project_id = '${P}' and kind = 'prompt' limit 1`)
  assert.ok(seen.filter(s => ['director', 'art', 'cinematographer', 'reviewer'].includes(s.role)).every(s => s.tools.join() === 'studio'), 'tools off: the crew gets the studio tool and nothing else')
  assert.ok(anOrder)

  // DeepSeek on our own loop: effort in its own words, and its reasoning comes back on every later request.
  const ds = seen.filter(s => s.role === 'director')
  assert.ok(ds.every(s => s.model === 'deepseek-flash' && s.effort === 'max'), 'high → max')
  const withHistory = ds.filter(s => s.assistants.length)
  assert.ok(withHistory.length > 3)
  assert.ok(withHistory.every(s => s.assistants.every(x => x.reasoning?.startsWith('thinking director'))), 'every assistant message went back with its reasoning — in the turn and across turns')
  assert.ok(withHistory.some(s => s.assistants.some(x => !x.calls)), 'including a previous turn\'s final answer, from the database')

  // ---- not on the crew → no studio tool ----
  const dm = await fetch(`${APP}/api/chat?k=${K}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target: { type: 'agent', id: O }, text: 'hi' }) })
  await dm.text()
  assert.deepEqual(seen.filter(s => s.role === 'none').at(-1).tools, [], 'an agent off the crew is offered no studio tool')
  // The event doors have their own token.
  assert.equal((await fetch(`${APP}/api/events/order?k=${K}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"text":"x"}' })).status, 401, 'ACCESS_TOKEN does not open the work-order door')

  console.log('e2e-platform: all checks passed')
} finally {
  server.close()
}
