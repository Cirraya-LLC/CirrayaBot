// Voice: on "device" the server only keeps the setting; on "upstream" it asks the person's own
// upstream to hear and to speak, the key never leaving the server.
import { test, before, after } from 'node:test'
import { strict as a } from 'node:assert'
import { startStack } from './stack.mjs'
import { fakeUpstream } from './fake-upstream.mjs'

let s, up, pid
before(async () => {
  up = await fakeUpstream({ name: 'voice' })
  s = await startStack()
  await s.agent(up, { name: 'Viv' })
  pid = (await s.api('GET', '/api/providers')).body.find(p => p.base_url === up.url).id
})
after(async () => { await s?.close(); await up?.close() })

const audio = (bytes = 2048) => Buffer.alloc(bytes, 7)
async function transcribe(body, type = 'audio/webm', q = '') {
  const r = await fetch(`${s.url}/api/voice/transcribe${q}`, { method: 'POST', headers: { cookie: `ma_token=${s.token}`, 'content-type': type }, body })
  return { status: r.status, body: await r.json() }
}
async function speak(body) {
  const r = await fetch(`${s.url}/api/voice/speak`, { method: 'POST', headers: { cookie: `ma_token=${s.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body) })
  return { status: r.status, type: r.headers.get('content-type'), bytes: Buffer.from(await r.arrayBuffer()) }
}

test('by default the device does it, and the server says so', async () => {
  a.deepEqual((await s.api('GET', '/api/settings/voice')).body, { stt: { mode: 'device' }, tts: { mode: 'device' } })
  const t = await transcribe(audio())
  a.equal(t.status, 400); a.match(t.body.error, /set to this device/)
  a.equal((await speak({ text: 'hi' })).status, 400)
})

test('settings are checked: an upstream voice needs a model and a voice name, no defaults', async () => {
  const put = b => s.api('PUT', '/api/settings/voice', b)
  a.equal((await put({ stt: { mode: 'upstream' } })).status, 400)
  const noVoice = await put({ tts: { mode: 'upstream', model: 'tts-1' } })
  a.equal(noVoice.status, 400); a.match(noVoice.body.error, /voice name/); a.doesNotMatch(noVoice.body.error, /alloy|tts-1/, 'no model or voice is suggested')
  a.equal((await put({ stt: { mode: 'upstream', provider_id: 'nope', model: 'whisper-1' } })).status, 400)
  const ok = await put({ stt: { mode: 'upstream', provider_id: pid, model: 'whisper-1' }, tts: { mode: 'upstream', provider_id: pid, model: 'tts-1', voice: 'nova' } })
  a.equal(ok.status, 200, JSON.stringify(ok.body))
})

test('a recording is sent to the upstream with its model and comes back as words', async () => {
  const t = await transcribe(audio(4096), 'audio/webm;codecs=opus', '?language=en')
  a.deepEqual(t, { status: 200, body: { text: 'hello from the microphone' } })
  const h = up.heard.at(-1)
  a.equal(h.model, 'whisper-1'); a.equal(h.language, 'en'); a.equal(h.filename, 'speech.webm')
  a.match(h.type, /^multipart\/form-data/)
  const m4a = await transcribe(audio(), 'audio/mp4')
  a.equal(m4a.status, 200); a.equal(up.heard.at(-1).filename, 'speech.m4a')
  a.equal((await transcribe(Buffer.alloc(0))).status, 400, 'nothing recorded')
})

test('text is spoken in the agent\'s own voice, else the default', async () => {
  let r = await speak({ text: 'Hello there.' })
  a.equal(r.status, 200); a.equal(r.type, 'audio/wav'); a.equal(r.bytes.subarray(0, 4).toString(), 'RIFF')
  a.deepEqual(up.spoken.at(-1).body, { model: 'tts-1', input: 'Hello there.', voice: 'nova', response_format: 'mp3' })
  const bot = (await s.api('GET', '/api/bots')).body.find(b => b.name === 'Viv').id
  a.equal((await s.api('PATCH', `/api/bots/${bot}`, { voice: 'onyx' })).status, 200)
  r = await speak({ text: 'Again.', agent: bot })
  a.equal(up.spoken.at(-1).body.voice, 'onyx')
  a.equal((await speak({ text: 'x'.repeat(4001) })).status, 400, 'too long for one call')
  a.equal((await speak({ text: '  ' })).status, 400)
})

test('an upstream without speech says so plainly', async () => {
  up.noAudio = true
  try {
    const t = await transcribe(audio())
    a.equal(t.status, 424); a.match(t.body.error, /no speech endpoint/)
    a.equal((await speak({ text: 'hi' })).status, 424)
  } finally { up.noAudio = false }
})

test('an Anthropic-protocol upstream cannot be the voice', async () => {
  const p = (await s.api('POST', '/api/providers', { name: 'claude', base_url: 'https://api.anthropic.example/v1', protocol: 'messages' })).body
  const r = await s.api('PUT', '/api/settings/voice', { stt: { mode: 'upstream', provider_id: p.id, model: 'x' } })
  a.equal(r.status, 400); a.match(r.body.error, /Anthropic/)
})

test('an upstream that cannot be reached is its failure, not a server error', async () => {
  const p = (await s.api('POST', '/api/providers', { name: 'gone', base_url: 'http://127.0.0.1:9/v1', protocol: 'chat' })).body
  a.equal((await s.api('PUT', '/api/settings/voice', { stt: { mode: 'upstream', provider_id: p.id, model: 'whisper-1' } })).status, 200)
  const t = await transcribe(audio())
  a.equal(t.status, 424); a.match(t.body.error, /Couldn't reach the voice upstream "gone"/)
})
