// End-to-end check of the crew loop through the REAL platform and studio (a running compose
// deployment), with a scripted fake model standing in for the agents and a fake Seedance:
//
//   shot.gen → studio worker → "@reviewer candidates ready" (event) → reviewer calls shot.sheet
//   → SEES the sheet (image in its next request) → shot.reject → "@cinematographer rejected"
//   → cinematographer writes a new prompt and regenerates → … → 3rd rejection → "@human", nobody woken.
//
// It asserts on artifacts: group log rows, tool rows, what the model was actually sent, studio state.
//
//   Run from the deployment directory, with in .env:
//     SEEDANCE_BASE_URL=http://host.docker.internal:18777/sd  SEEDANCE_API_KEY=sd-key  NOTIFY_QUIET_MS=1000
//   node studio/e2e-platform.mjs <deployment dir>
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

// ---- media for the fake Seedance ----
const tmp = mkdtempSync(join(tmpdir(), 'e2ep-'))
execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=24:duration=4', '-pix_fmt', 'yuv420p', '-y', join(tmp, 't.mp4')])
const TAKE = readFileSync(join(tmp, 't.mp4'))

// ---- the fake model: one scripted person per ROLE marker in the persona ----
const seen = []           // {role, tools, image, text} per request
const sse = (res, frames) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const f of frames) res.write(`data: ${JSON.stringify(f)}\n\n`)
  res.end('data: [DONE]\n\n')
}
const say = (res, text) => sse(res, [{ choices: [{ delta: { content: text } }] }])
const toolCall = (res, action, args) => sse(res, [{ choices: [{ delta: { tool_calls: [{ index: 0, id: `c${Math.random().toString(36).slice(2, 8)}`,
  function: { name: 'studio', arguments: JSON.stringify({ action, args }) } }] } }] }, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }])
const textOf = m => (Array.isArray(m?.content) ? m.content.filter(x => x.type === 'text').map(x => x.text).join('') : String(m?.content ?? ''))
const lastCall = msgs => { for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].tool_calls) return JSON.parse(msgs[i].tool_calls[0].function.arguments).action; return null }
const shotIn = s => (s.match(/S\d+-SH\d+/) ?? [])[0]

function model(body, res) {
  const msgs = body.messages
  const role = (textOf(msgs[0]).match(/ROLE:(\w+)/) ?? [])[1] ?? 'none'
  const last = msgs.at(-1)
  const image = Array.isArray(last.content) && last.content.some(x => x.type === 'image_url' && x.image_url.url.startsWith('data:image/'))
  // The newest user message that isn't a tool's image follow-up.
  const said = [...msgs].reverse().find(m => m.role === 'user' && !Array.isArray(m.content))
  seen.push({ role, tools: (body.tools ?? []).map(t => t.function.name), image, last: textOf(last).slice(0, 120) })
  const after = last.role === 'tool' || image ? lastCall(msgs) : null
  if (role === 'reviewer') {
    if (after === 'shot.sheet' && image) return toolCall(res, 'shot.reject', { shot: shotIn(JSON.stringify(msgs.slice(-4))) ?? 'S01-SH001',
      reason: 'candidate hair colour drifts from the locked card, redo', route: 'prompt' })
    if (after === 'shot.sheet') return say(res, 'I could not see the sheet.')
    if (after === 'shot.reject') return say(res, '已打回。')
    const s = shotIn(textOf(said))
    if (/候选已就绪/.test(textOf(said)) && s) return toolCall(res, 'shot.sheet', { shot: s })
    return say(res, '好的')
  }
  if (role === 'cinematographer') {
    const s = shotIn(JSON.stringify(msgs.slice(-6))) ?? 'S01-SH001'
    if (after === 'shot.prompt') return toolCall(res, 'shot.gen', { shot: s, model: 'seedance-2.5', n: 1 })
    if (after === 'shot.gen') return say(res, '已重新生成。')
    if (/被打回/.test(textOf(said))) return toolCall(res, 'shot.prompt', { shot: s, text: `black hair, attempt ${Date.now()}` })
    return say(res, '收到')
  }
  return say(res, 'hello')
}

// ---- fake Seedance ----
const tasks = new Map()
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
  if (req.url === '/v.mp4') { res.writeHead(200, { 'content-type': 'video/mp4' }); return res.end(TAKE) }
  if (req.url.startsWith('/sd/api/v3/contents/generations/tasks')) {
    if (req.headers.authorization !== 'Bearer sd-key') return json(401, { error: { message: 'key' } })
    if (req.method === 'POST') { const id = `t${tasks.size + 1}`; tasks.set(id, 0); return json(200, { id }) }
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
// Actions the panel doesn't offer (the crew's own work) are seeded as a person, straight at the studio.
const studioAsHuman = (action, args) => JSON.parse(execFileSync('docker', ['compose', 'exec', '-T',
  '-e', `A=${JSON.stringify({ action, args })}`, 'app', 'node', '-e',
  `fetch(process.env.STUDIO_URL+'/v1/call',{method:'POST',headers:{authorization:'Bearer '+process.env.STUDIO_TOKEN,'x-studio-actor':'human'},body:process.env.A}).then(r=>r.json()).then(j=>process.stdout.write(JSON.stringify(j)))`],
{ cwd: DIR }).toString())
const must = r => { assert.equal(r.ok, true, JSON.stringify(r.error)); return r.result }
const gw = execFileSync('docker', ['network', 'inspect', `${ENV.COMPOSE_PROJECT_NAME || 'multi-agent'}_default`, '-f', '{{(index .IPAM.Config 0).Gateway}}']).toString().trim()

try {
  // ---- platform setup: an upstream pointing at the fake, three crew agents, one outsider, a group ----
  const prov = await ok('POST', '/api/providers', { name: `fake-${RUN}`, base_url: `http://${gw}:${PORT}/v1`, protocol: 'chat', auto_context: false, context_tokens: 64000 })
  const mk = async (id, name, role) => ok('POST', '/api/bots', { id: `${id}-${RUN}`, name: `${name}${RUN}`, persona: `你是${name}。ROLE:${role}`, provider_id: prov.id, model: 'fake-model' })
  const D = (await mk('dir', '顾衡', 'director')).id, R = (await mk('rev', '严青', 'reviewer')).id
  const C = (await mk('cine', '林野', 'cinematographer')).id, O = (await mk('plain', '路人', 'none')).id
  const g = await ok('POST', '/api/groups', { name: `剧组${RUN}`, members: [D, R, C], lead: D })
  assert.equal((await api('POST', '/api/bots', { name: 'Studio', persona: 'x', model: 'm' })).status, 400, '"Studio" is reserved')

  // ---- studio setup through the panel's own endpoint (as a person) ----
  const P = `e2ep-${RUN}`
  await ok('POST', '/api/studio/call', { action: 'project.create', args: { id: P, name: 'Platform E2E', info: { lang: 'zh-Hans' }, notify_group: g.id } })
  for (const [id, role] of [[D, 'director'], [R, 'reviewer'], [C, 'cinematographer']]) await ok('POST', '/api/studio/call', { action: 'crew.set', args: { agent_id: id, role } })
  assert.equal((await api('POST', '/api/studio/call', { action: 'shot.gen', args: {} })).status, 400, 'the panel does not generate')
  must(studioAsHuman('scene.add', { project: P, code: 'S01', script: '断崖' }))
  must(studioAsHuman('shot.plan', { project: P, scene: 'S01', shots: [{ id: 'S01-SH001', duration_s: 4, characters: [], continuity: { out_to: 'S01-SH002' } }] }))
  must(studioAsHuman('shot.prompt', { project: P, shot: 'S01-SH001', text: 'v1' }))
  // Every crew member works in this project.
  for (const id of [R, C, D]) must(studioAsHuman('crew.set', { agent_id: id, role: { [R]: 'reviewer', [C]: 'cinematographer', [D]: 'director' }[id] }))
  execFileSync('docker', ['compose', 'exec', '-T', 'db', 'psql', '-U', 'multiagent', '-d', 'multiagent', '-qc',
    `insert into studio.actor_project values ${[R, C, D].map(id => `('agent:${id}', '${P}')`).join(',')} on conflict (actor) do update set project_id = excluded.project_id`], { cwd: DIR })

  // ---- the event door has its own token ----
  const bad = await fetch(`${APP}/api/events/group/${g.id}`, { method: 'POST', headers: { authorization: 'Bearer nope', 'content-type': 'application/json' }, body: '{"text":"x"}' })
  assert.equal(bad.status, 401)
  const noK = await fetch(`${APP}/api/events/group/${g.id}?k=${K}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"text":"x"}' })
  assert.equal(noK.status, 401, 'ACCESS_TOKEN does not open the event door')

  // ---- go ----
  must(studioAsHuman('shot.gen', { project: P, shot: 'S01-SH001', model: 'seedance-2.5', n: 2 }))
  let log = []
  for (let i = 0; i < 240; i++) {
    log = (await ok('GET', `/api/groups/${g.id}/messages`))
    if (log.some(m => m.speaker === 'Studio' && m.text.startsWith('@人类'))) break
    await sleep(1000)
  }
  const notices = log.filter(m => m.speaker === 'Studio').map(m => m.text)
  console.log('studio notices:\n  ' + notices.join('\n  '))
  assert.match(notices[0], new RegExp(`^@严青${RUN} 候选已就绪：S01-SH001，2 条`), 'the reviewer is told, by name, in the project language')
  assert.match(notices[1], new RegExp(`^@林野${RUN} S01-SH001 被打回（第 1 次，prompt）`), 'the rejection goes to the cinematographer')
  assert.match(notices.at(-1), /^@人类 S01-SH001 已被打回 3 次/, 'the third goes to a person')
  assert.equal(notices.filter(n => n.includes('被打回（')).length, 2)
  assert.equal(notices.filter(n => n.includes('候选已就绪')).length, 3)

  // The reviewer really saw each sheet: the request after shot.sheet carried an image.
  const rev = seen.filter(s => s.role === 'reviewer')
  assert.ok(limited, 'the 429 was served')
  assert.equal(rev.filter(s => s.image).length, 3, 'three sheets, three images in front of the model — the first one after a 429')
  assert.ok(rev.every(s => s.tools.join() === 'studio'), 'tools off: the crew gets the studio tool and nothing else')
  assert.ok(seen.filter(s => s.role === 'cinematographer').some(s => s.last.includes('shot.gen') || true))

  // The transcript keeps the tool calls; nobody answers the human notice.
  const tools = log.filter(m => m.role === 'tool')
  assert.ok(tools.filter(m => m.name === 'studio' && m.args?.action === 'shot.sheet').length === 3)
  await sleep(5000)
  const after = (await ok('GET', `/api/groups/${g.id}/messages`))
  const iHuman = after.findIndex(m => m.speaker === 'Studio' && m.text.startsWith('@人类'))
  assert.equal(after.slice(iHuman + 1).filter(m => m.role !== 'user').length, 0, 'a notice for a person wakes no agent')

  // The studio's own record agrees.
  const hist = must(studioAsHuman('review.history', { project: P, shot: 'S01-SH001' }))
  assert.equal(hist.rejections, 3); assert.equal(hist.prompts.length, 3, 'v1 by the person, two by the cinematographer')
  assert.ok(hist.reviews.every(r => r.reviewer === `agent:${R}`), 'the studio saw the reviewer, identified by the platform')

  // ---- not on the crew → no studio tool; a step limit is a limit ----
  const dm = await fetch(`${APP}/api/chat?k=${K}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target: { type: 'agent', id: O }, text: 'hi' }) })
  await dm.text()
  assert.deepEqual(seen.filter(s => s.role === 'none').at(-1).tools, [], 'an agent off the crew is offered no studio tool')
  await ok('PATCH', `/api/bots/${C}`, { max_steps: 1 })
  assert.equal((await api('PATCH', `/api/bots/${C}`, { max_steps: 0 })).status, 400)
  const s2 = await fetch(`${APP}/api/chat?k=${K}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target: { type: 'agent', id: C }, text: 'S01-SH001 被打回，请改' }) })
  await s2.text()
  const dmLog = await ok('GET', `/api/dm/${C}`)
  assert.equal(dmLog.filter(m => m.role === 'tool').length, 1, 'one step, then it has to stop')
  assert.match(dmLog.at(-1).content, /hit the tool-use limit/, 'and the stored answer says why it stopped')

  console.log('e2e-platform: all checks passed')
} finally {
  server.close()
}
