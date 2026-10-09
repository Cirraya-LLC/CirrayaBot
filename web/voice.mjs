// Voice: what is said out loud and how a spoken message gets in. Pure, and loaded by the server
// and by the web page alike (app.js imports it) — so a reply sounds the same whoever reads it.
// `node web/voice.mjs` is the self-test.
//
// Two ways each, chosen in the settings:
//   device    the browser's / the phone's own speech recognition and voices — nothing to set up
//   upstream  one of the person's own upstreams, OpenAI-style /audio/transcriptions and /audio/speech
// The agent loop never changes: speech becomes a text message, a reply is text read aloud.

export const MODES = ['device', 'upstream']
export const SPEAK_MAX = 4000            // characters per /audio/speech call (OpenAI's limit is 4096)
export const AUDIO_MAX = 25 * 1024 * 1024 // a recording sent for transcription

/**
 * Voice settings as saved. Upstream modes need the upstream (''= the default one), a model, and —
 * for speaking — a voice: there is no default name, since voices differ per upstream.
 * Returns the clean settings, or { need } naming what is missing.
 */
export function checkVoice(b) {
  const part = (x, speaking) => {
    const mode = MODES.includes(x?.mode) ? x.mode : 'device'
    if (mode === 'device') return { mode }
    const model = String(x?.model ?? '').trim()
    if (!model || model.length > 200) return { need: speaking ? 'ttsModel' : 'sttModel' }
    const out = { mode, provider_id: String(x?.provider_id ?? '').trim(), model }
    if (speaking) {
      const voice = String(x?.voice ?? '').trim()
      if (!voice || voice.length > 100) return { need: 'voice' }
      out.voice = voice
    }
    return out
  }
  const stt = part(b?.stt, false), tts = part(b?.tts, true)
  if (stt.need) return stt
  if (tts.need) return tts
  return { stt, tts }
}
export const DEFAULT_VOICE = { stt: { mode: 'device' }, tts: { mode: 'device' } }

/**
 * A reply as it should sound. Code is not read out — "(code)" says something was there — and
 * neither are URLs, tables' pipes or Markdown's marks. `codeWord` is what stands in for a block.
 */
export function speakable(md, { codeWord = 'code' } = {}) {
  let t = String(md ?? '')
  t = t.replace(/```[\s\S]*?(```|$)/g, ` (${codeWord}) `)                 // fenced blocks, closed or still streaming
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')                             // images: their alt text
  t = t.replace(/\[([^\]]+)\]\((?:[^()]|\([^)]*\))*\)/g, '$1')               // links: their words
  t = t.replace(/https?:\/\/\S+/g, '')                                       // bare URLs
  t = t.replace(/`([^`\n]+)`/g, '$1')                                        // inline code: just the words
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, '')                                   // headings
  t = t.replace(/^\s*[-*+]\s+/gm, '').replace(/^\s*\d+[.)]\s+/gm, '')        // list markers
  t = t.replace(/^\s*>\s?/gm, '')                                            // quotes
  t = t.replace(/^[ \t]*\|?[ \t]*:?-{3,}.*$/gm, '')                          // table rules
  t = t.replace(/^[ \t]*\|(.*)\|[ \t]*$/gm, (m, row) => row.split('|').map(c => c.trim()).filter(Boolean).join(', '))
  t = t.replace(/(\*\*|__|~~)(.+?)\1/g, '$2').replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)/g, '$1$2')
  t = t.replace(/@(\S+)/g, '$1')
  return t.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/\n{2,}/g, '\n').trim()
}

/**
 * Split text into pieces that can be spoken one after another while a reply is still streaming:
 * whole sentences come out, the unfinished tail stays behind. `final` = the reply is complete, so
 * the tail goes too. Very long sentences are cut at a comma or a space so speech starts promptly.
 */
export function sentences(text, { final = false, max = 220 } = {}) {
  const out = []
  let rest = String(text ?? '')
  // CJK sentence marks end a sentence where they stand; . ! ? only before a space or the end ("3.14").
  const end = /[。！？…]+["'”’」』)\]]*|[.!?]+["'”’)\]]*(\s+|$)|\n+/g
  let m, from = 0
  while ((m = end.exec(rest))) {
    // At the very end of what has streamed so far, "3." may yet become "3.14": wait for more.
    if (m.index + m[0].length === rest.length && !final && /^[.!?]/.test(m[0]) && !/\s$/.test(m[0])) break
    const piece = rest.slice(from, m.index + m[0].length).trim()
    if (piece) out.push(...cut(piece, max))
    from = m.index + m[0].length
  }
  rest = rest.slice(from)
  if (final && rest.trim()) { out.push(...cut(rest.trim(), max)); rest = '' }
  else if (rest.length > max) {
    const at = Math.max(rest.lastIndexOf(', ', max - 1), rest.lastIndexOf('，', max - 1), rest.lastIndexOf(' ', max - 1))
    if (at > 40) { out.push(rest.slice(0, at + 1).trim()); rest = rest.slice(at + 1) }
  }
  return { out: out.filter(s => /[\p{L}\p{N}]/u.test(s)), rest }
}

function cut(s, max) {
  const out = []
  while (s.length > max) {
    let at = Math.max(s.lastIndexOf(', ', max - 1), s.lastIndexOf('，', max - 1), s.lastIndexOf('、', max - 1), s.lastIndexOf(' ', max - 1))
    if (at < 40) at = max - 1
    out.push(s.slice(0, at + 1).trim()); s = s.slice(at + 1).trim()
  }
  if (s) out.push(s)
  return out
}

/**
 * A voice of its own for each agent on a device voice: the same voice, a slightly different pitch
 * and pace, picked from the agent's id — so in a group you hear who is speaking. 1 = unchanged.
 */
export function deviceTone(agentId) {
  let h = 0x811c9dc5                                            // FNV-1a: close ids still land far apart
  for (const ch of String(agentId ?? '')) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0 }
  return { pitch: +(0.85 + (h % 13) * 0.025).toFixed(3), rate: +(0.94 + ((h >>> 8) % 5) * 0.03).toFixed(3) }
}

// ---------- self-test ----------
if (typeof process !== 'undefined' && import.meta.url === `file://${process.argv[1]}`) {
  const { strict: a } = await import('node:assert')
  a.deepEqual(checkVoice({}), DEFAULT_VOICE)
  a.deepEqual(checkVoice({ stt: { mode: 'upstream', model: '' } }), { need: 'sttModel' })
  a.deepEqual(checkVoice({ tts: { mode: 'upstream', model: 'tts-1' } }), { need: 'voice' }, 'no default voice name')
  a.deepEqual(checkVoice({ stt: { mode: 'upstream', provider_id: 'p1', model: 'whisper-1' }, tts: { mode: 'upstream', model: 'tts-1', voice: 'nova' } }),
    { stt: { mode: 'upstream', provider_id: 'p1', model: 'whisper-1' }, tts: { mode: 'upstream', provider_id: '', model: 'tts-1', voice: 'nova' } })
  a.deepEqual(checkVoice({ stt: { mode: 'nonsense' } }).stt, { mode: 'device' })

  a.equal(speakable('Run this:\n```bash\nrm -rf /\n```\nthen check.'), 'Run this:\n(code)\nthen check.')
  a.equal(speakable('See [the docs](https://x.com/a_(b)) and https://y.com/z now.'), 'See the docs and now.')
  a.equal(speakable('## Title\n- **bold** item\n- `code` item\n1. first'), 'Title\nbold item\ncode item\nfirst')
  a.equal(speakable('| a | b |\n|---|---|\n| 1 | 2 |'), 'a, b\n1, 2', 'a table is read row by row')
  a.equal(speakable('half a block ```js\nconst x = 1'), 'half a block (code)', 'a block still streaming is not read either')
  a.equal(speakable('@Lin please look'), 'Lin please look')
  a.equal(speakable('snake_case and *emphasis*'), 'snake_case and emphasis')

  let s = sentences('Hello there. How are')
  a.deepEqual(s, { out: ['Hello there.'], rest: 'How are' })
  s = sentences('Pi is 3.14')
  a.deepEqual(s.out, [], 'a decimal point is not the end of a sentence')
  a.deepEqual(sentences('Pi is 3.14', { final: true }).out, ['Pi is 3.14'])
  a.deepEqual(sentences('你好。今天怎么样？还').out, ['你好。', '今天怎么样？'])
  a.deepEqual(sentences('Line one\nLine two\n').out, ['Line one', 'Line two'])
  a.deepEqual(sentences('(code)\n...\n', { final: true }).out, ['(code)'], 'nothing without a letter or digit')
  const long = 'word, '.repeat(80)
  a.ok(sentences(long).out.every(x => x.length <= 220), 'a long run is cut so speech can start')
  const t1 = deviceTone('chief'), t2 = deviceTone('operator')
  a.ok(t1.pitch >= 0.85 && t1.pitch <= 1.15 && t1.rate >= 0.94 && t1.rate <= 1.06)
  a.deepEqual(deviceTone('chief'), t1, 'stable per agent')
  a.ok(t1.pitch !== t2.pitch || t1.rate !== t2.rate, 'different agents sound different')
  console.log('voice: all checks pass')
}
