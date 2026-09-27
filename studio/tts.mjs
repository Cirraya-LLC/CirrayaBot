// Speech for narration and off-screen lines: MiniMax's T2A v2 (the boss's pick, 2026-09-27).
//
//   POST {base}/v1/t2a_v2   {model, text, voice_setting:{voice_id, speed, vol, pitch, emotion?},
//                            audio_setting:{…mp3}, language_boost:'auto'}
//     → {data:{audio: <hex>}, base_resp:{status_code, status_msg}}
//   POST {base}/v1/get_voice {voice_type:'all'} → {system_voice:[{voice_id, voice_name, description}], voice_cloning…}
//
// Base URL: https://api.minimax.cn (mainland; the docs also list https://api-bj.minimaxi.com) or
// https://api.minimax.io (international). A key only works on the site that issued it.
// ⚠️ MiniMax answers errors with HTTP 200 and a non-zero base_resp.status_code — the status line
// says nothing.
//
// On-screen dialogue is NOT spoken here: Seedance generates it with the picture (generate_audio),
// so the lips match. This is for the narrator and for voices the camera doesn't see.
//
// A character keeps one voice for the whole series: `card.voice` = {voice, emotion}; the narrator's
// is the project's `info.narrator`. The voice is a MiniMax voice_id (a system voice, or one cloned
// or designed in the person's own account) — voice.list reads them from the account.
//
// No key is a normal state, not an error: until one is set narration stays in the subtitles and the
// assembly says so.
//
// Self-test: node studio/tts.mjs (a fake server stands in for the API)
import { value } from './keys.mjs'

export const config = () => ({
  base: value('tts', 'base_url').replace(/\/+$/, '').replace(/\/v1$/, ''),
  key: value('tts', 'api_key'),
  model: value('tts', 'model'),
})
export const ready = (cfg = config()) => !!(cfg.base && cfg.key)

// Both from MiniMax's own examples: a young man, and a news-reading woman for the narrator.
export const DEFAULT_VOICE = 'male-qn-qingse'
export const DEFAULT_NARRATOR = 'Chinese (Mandarin)_News_Anchor'
export const EMOTIONS = ['happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised', 'calm', 'fluent', 'whisper']

/** A character card's voice (or the narrator's) → {voice, emotion}. Tolerates a bare string and the old {voice, instructions}. */
export function voiceOf(card, fallback = DEFAULT_VOICE) {
  const v = card?.voice
  if (typeof v === 'string' && v.trim()) return { voice: v.trim().slice(0, 120), emotion: '' }
  if (v && typeof v === 'object') {
    const emotion = String(v.emotion ?? '').trim()
    return { voice: String(v.voice ?? '').trim().slice(0, 120) || fallback, emotion: EMOTIONS.includes(emotion) ? emotion : '' }
  }
  return { voice: fallback, emotion: '' }
}

const said = j => ({ code: j?.base_resp?.status_code, msg: String(j?.base_resp?.status_msg ?? '') })

async function post(cfg, path, body, timeoutMs) {
  const res = await fetch(`${cfg.base}${path}`, {
    method: 'POST', signal: AbortSignal.timeout(timeoutMs),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.key}` },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let j = null; try { j = JSON.parse(text) } catch {}
  if (!res.ok) throw Object.assign(new Error(`TTS ${res.status}: ${(said(j).msg || text).slice(0, 300)}`), { status: res.status })
  if (!j) throw new Error(`TTS answered with something that isn't JSON: ${text.slice(0, 200)}`)
  const s = said(j)
  // 1004 = authentication failed; the rest are in MiniMax's error table (1002 rate limit, 2013 bad input…)
  if (s.code !== 0 && s.code !== undefined) throw Object.assign(new Error(`TTS error ${s.code}: ${s.msg.slice(0, 300)}`), { code: s.code })
  return j
}

/** → {audio: Buffer, mime} */
export async function speak(cfg, { text, voice = DEFAULT_VOICE, emotion = '' }) {
  if (!cfg.base || !cfg.key) throw new Error('speech is not configured (the Keys panel → MiniMax speech, or TTS_API_KEY in .env)')
  const input = String(text ?? '').trim()
  if (!input) throw new Error('nothing to say')
  const j = await post(cfg, '/v1/t2a_v2', {
    model: cfg.model, text: input.slice(0, 3000), stream: false, language_boost: 'auto',
    voice_setting: { voice_id: voice, speed: 1, vol: 1, pitch: 0, ...EMOTIONS.includes(emotion) ? { emotion } : {} },
    audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 },
  }, 120_000)
  const hex = j.data?.audio
  if (typeof hex !== 'string' || !/^[0-9a-f]+$/i.test(hex)) throw new Error('TTS returned no audio')
  const audio = Buffer.from(hex, 'hex')
  if (audio.length < 100) throw new Error('TTS returned almost nothing')
  return { audio, mime: 'audio/mpeg' }
}

/** The voices this account can use: system voices plus the person's own cloned / designed ones. */
export async function voices(cfg, { timeoutMs = 15_000 } = {}) {
  if (!cfg.base || !cfg.key) throw new Error('speech is not configured')
  const j = await post(cfg, '/v1/get_voice', { voice_type: 'all' }, timeoutMs)
  const one = kind => v => ({
    id: String(v.voice_id ?? ''), kind,
    name: String(v.voice_name ?? '') || String(v.voice_id ?? ''),
    description: (Array.isArray(v.description) ? v.description.join(' ') : String(v.description ?? '')).slice(0, 200),
  })
  return [
    ...(j.voice_cloning ?? []).map(one('cloned')),
    ...(j.voice_generation ?? []).map(one('designed')),
    ...(j.system_voice ?? []).map(one('system')),
  ].filter(v => v.id)
}

// ---------- self-test ----------
if (import.meta.url === `file://${process.argv[1]}`) {
  const a = await import('node:assert/strict')
  const { createServer } = await import('node:http')
  a.deepEqual(voiceOf({ voice: 'female-shaonv' }), { voice: 'female-shaonv', emotion: '' })
  a.deepEqual(voiceOf({ voice: { voice: 'male-qn-jingying', emotion: 'sad' } }), { voice: 'male-qn-jingying', emotion: 'sad' })
  a.deepEqual(voiceOf({ voice: { voice: 'x', instructions: 'low, tired' } }), { voice: 'x', emotion: '' }, 'the old OpenAI field is ignored')
  a.deepEqual(voiceOf({ voice: { voice: 'x', emotion: 'grumpy' } }), { voice: 'x', emotion: '' }, 'only MiniMax emotions')
  a.deepEqual(voiceOf({}), { voice: DEFAULT_VOICE, emotion: '' })
  a.deepEqual(voiceOf({}, DEFAULT_NARRATOR), { voice: DEFAULT_NARRATOR, emotion: '' })
  a.equal(ready({ base: 'https://api.minimax.cn', key: '' }), false, 'a base URL alone is not enough — it has a default')

  const seen = []
  const srv = createServer(async (req, res) => {
    let b = ''; for await (const c of req) b += c
    const body = JSON.parse(b)
    seen.push({ url: req.url, auth: req.headers.authorization, body })
    const json = (j, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)) }
    if (req.headers.authorization !== 'Bearer k') return json({ base_resp: { status_code: 1004, status_msg: 'login fail' } })
    if (req.url === '/v1/get_voice') return json({ system_voice: [{ voice_id: 'male-qn-qingse', voice_name: '青涩青年', description: ['年轻男声'] }],
      voice_cloning: [{ voice_id: 'my-voice-1', description: [] }], base_resp: { status_code: 0, status_msg: 'success' } })
    if (body.text === 'bad input') return json({ base_resp: { status_code: 2013, status_msg: 'invalid params' } })
    if (body.text === 'http error') return json({ base_resp: { status_code: 1000, status_msg: 'boom' } }, 500)
    json({ data: { audio: Buffer.alloc(2000, 0xff).toString('hex'), status: 2 }, extra_info: { audio_format: 'mp3' }, base_resp: { status_code: 0, status_msg: 'success' } })
  })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  const cfg = { base: `http://127.0.0.1:${srv.address().port}`, key: 'k', model: 'speech-2.8-hd' }
  try {
    const r = await speak(cfg, { text: '  从前有座山。 ', voice: 'female-shaonv', emotion: 'calm' })
    a.equal(r.audio.length, 2000, 'hex decoded'); a.equal(r.mime, 'audio/mpeg')
    a.equal(seen[0].url, '/v1/t2a_v2'); a.equal(seen[0].auth, 'Bearer k')
    a.equal(seen[0].body.model, 'speech-2.8-hd'); a.equal(seen[0].body.text, '从前有座山。'); a.equal(seen[0].body.stream, false)
    a.deepEqual(seen[0].body.voice_setting, { voice_id: 'female-shaonv', speed: 1, vol: 1, pitch: 0, emotion: 'calm' })
    a.equal(seen[0].body.audio_setting.format, 'mp3')
    await speak(cfg, { text: 'x', voice: 'v' })
    a.equal('emotion' in seen[1].body.voice_setting, false, 'no emotion = let the model choose')
    await a.rejects(speak(cfg, { text: 'bad input' }), /TTS error 2013: invalid params/, 'an error inside a 200')
    await a.rejects(speak(cfg, { text: 'http error' }), /TTS 500: boom/)
    await a.rejects(speak({ ...cfg, key: 'wrong' }, { text: 'x' }), /1004: login fail/)
    await a.rejects(speak(cfg, { text: ' ' }), /nothing to say/)
    await a.rejects(speak({ base: cfg.base, key: '' }, { text: 'x' }), /not configured/)
    const vs = await voices(cfg)
    a.deepEqual(vs.map(v => [v.id, v.kind, v.name]), [['my-voice-1', 'cloned', 'my-voice-1'], ['male-qn-qingse', 'system', '青涩青年']])
    a.equal(vs[1].description, '年轻男声')
  } finally { srv.close() }
  console.log('tts.mjs: all checks passed')
}
