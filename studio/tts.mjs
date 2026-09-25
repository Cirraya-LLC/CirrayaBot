// Speech for narration and off-screen lines: OpenAI's /audio/speech, straight or through anything
// that speaks it (a relay, a local CosyVoice / Kokoro server with an OpenAI-shaped front).
//
//   POST {base}/audio/speech  {model, input, voice, instructions?, response_format: 'mp3'}  → audio bytes
//
// On-screen dialogue is NOT spoken here: Seedance generates it with the picture (generate_audio),
// so the lips match. This is for the narrator and for voices the camera doesn't see.
//
// A character keeps one voice for the whole series: `card.voice` = {voice, instructions}; the
// narrator's is the project's `info.narrator`. The voice name is whatever the service calls it
// (OpenAI: alloy, ash, coral, nova, onyx, sage…), so it is free text, not a list.
//
// Unconfigured (no base URL) is a normal state, not an error: the boss sets it up later, and until
// then narration stays in the subtitles and the assembly says so.
//
// Self-test: node studio/tts.mjs (a fake server stands in for the API)
import { value } from './keys.mjs'

export const config = () => ({
  base: value('tts', 'base_url').replace(/\/+$/, ''),
  key: value('tts', 'api_key'),
  model: value('tts', 'model'),
})
export const ready = (cfg = config()) => !!cfg.base

export const DEFAULT_VOICE = 'alloy'

/** A character card's voice (or the narrator's) → {voice, instructions}. Tolerates a bare string. */
export function voiceOf(card) {
  const v = card?.voice
  if (typeof v === 'string' && v.trim()) return { voice: v.trim().slice(0, 80), instructions: '' }
  if (v && typeof v === 'object') return {
    voice: String(v.voice ?? '').trim().slice(0, 80) || DEFAULT_VOICE,
    instructions: String(v.instructions ?? '').trim().slice(0, 1000),
  }
  return { voice: DEFAULT_VOICE, instructions: '' }
}

/** → {audio: Buffer, mime} */
export async function speak(cfg, { text, voice = DEFAULT_VOICE, instructions = '' }) {
  if (!cfg.base) throw new Error('speech is not configured (the Keys panel → TTS, or TTS_BASE_URL in .env)')
  const input = String(text ?? '').trim()
  if (!input) throw new Error('nothing to say')
  const res = await fetch(`${cfg.base}/audio/speech`, {
    method: 'POST', signal: AbortSignal.timeout(120_000),
    headers: { 'content-type': 'application/json', ...cfg.key ? { authorization: `Bearer ${cfg.key}` } : {} },
    body: JSON.stringify({ model: cfg.model, input: input.slice(0, 4096), voice, response_format: 'mp3',
      ...instructions ? { instructions } : {} }),
  })
  const buf = Buffer.from(await res.arrayBuffer())
  if (!res.ok) {
    let why = buf.toString('utf8', 0, 400)
    try { why = JSON.parse(buf.toString()).error?.message ?? why } catch {}
    throw new Error(`TTS ${res.status}: ${String(why).slice(0, 300)}`)
  }
  // A 200 with JSON in it is a relay reporting an error the polite way.
  if (buf[0] === 0x7b) throw new Error(`TTS answered with text instead of audio: ${buf.toString('utf8', 0, 200)}`)
  if (buf.length < 100) throw new Error('TTS returned almost nothing')
  return { audio: buf, mime: res.headers.get('content-type')?.startsWith('audio/') ? res.headers.get('content-type') : 'audio/mpeg' }
}

// ---------- self-test ----------
if (import.meta.url === `file://${process.argv[1]}`) {
  const a = await import('node:assert/strict')
  const { createServer } = await import('node:http')
  a.deepEqual(voiceOf({ voice: 'nova' }), { voice: 'nova', instructions: '' })
  a.deepEqual(voiceOf({ voice: { voice: 'onyx', instructions: 'low, tired' } }), { voice: 'onyx', instructions: 'low, tired' })
  a.deepEqual(voiceOf({}), { voice: DEFAULT_VOICE, instructions: '' })
  a.equal(ready({ base: '' }), false)

  const seen = []
  const srv = createServer(async (req, res) => {
    let b = ''; for await (const c of req) b += c
    seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(b) })
    const body = JSON.parse(b)
    if (body.input === 'polite error') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"error":"quota"}') }
    if (body.voice === 'nope') { res.writeHead(400, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"unknown voice"}}') }
    res.writeHead(200, { 'content-type': 'audio/mpeg' }); res.end(Buffer.alloc(2000, 0xff))
  })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  const cfg = { base: `http://127.0.0.1:${srv.address().port}/v1`, key: 'k', model: 'gpt-4o-mini-tts' }
  try {
    const r = await speak(cfg, { text: '  从前有座山。 ', voice: 'coral', instructions: 'warm' })
    a.equal(r.audio.length, 2000); a.equal(r.mime, 'audio/mpeg')
    a.equal(seen[0].url, '/v1/audio/speech'); a.equal(seen[0].auth, 'Bearer k')
    a.deepEqual(seen[0].body, { model: 'gpt-4o-mini-tts', input: '从前有座山。', voice: 'coral', response_format: 'mp3', instructions: 'warm' })
    await a.rejects(speak(cfg, { text: 'x', voice: 'nope' }), /TTS 400: unknown voice/)
    await a.rejects(speak(cfg, { text: 'polite error' }), /text instead of audio/)
    await a.rejects(speak(cfg, { text: ' ' }), /nothing to say/)
    await a.rejects(speak({ base: '' }, { text: 'x' }), /not configured/)
  } finally { srv.close() }
  console.log('tts.mjs: all checks passed')
}
