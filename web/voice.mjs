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
  t = t.replace(/\*\*|__|~~|`/g, '')                                     // marks left unpaired by a cut mid-sentence
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
  const end = /[。！？…]+["'”’」』)\]*_]*|[.!?]+["'”’)\]*_]*(\s+|$)|\n+/g
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
 * Reads a reply as it streams: push() the new text, get back what can be spoken now. Code blocks
 * are held until they close (then "(code)" is said once), so a fence is never read line by line;
 * a sentence is handed out only once it is complete. push('', true) at the end flushes the rest.
 */
export class Reader {
  constructor({ codeWord = 'code', max = 220 } = {}) { this.raw = ''; this.at = 0; this.codeWord = codeWord; this.max = max }
  push(delta, final = false) {
    this.raw += delta ?? ''
    const p = this.raw.slice(this.at)
    let cut = 0
    if (final) cut = p.length
    else {
      const fences = [...p.matchAll(/```/g)].map(m => m.index)
      const inFence = i => fences.filter(f => f < i).length % 2 === 1
      // The last place a sentence ends outside a code block, or right after a block closes.
      const end = /[。！？…]+["'”’」』)\]*_]*|[.!?]+["'”’)\]*_]*(\s+|$)|\n+/g
      let m
      while ((m = end.exec(p))) {
        const stop = m.index + m[0].length
        if (inFence(m.index)) continue
        if (stop === p.length && /^[.!?]/.test(m[0]) && !/\s$/.test(m[0])) break   // "3." may become "3.14"
        cut = stop
      }
      // A long run with no sentence end yet (and no open block): cut at a comma or space.
      if (!cut && p.length > this.max && !fences.length) {
        const at = Math.max(p.lastIndexOf(', ', this.max - 1), p.lastIndexOf('，', this.max - 1), p.lastIndexOf(' ', this.max - 1))
        if (at > 40) cut = at + 1
      }
    }
    if (!cut) return []
    this.at += cut
    return sentences(speakable(p.slice(0, cut), { codeWord: this.codeWord }), { final: true, max: this.max }).out
  }
}

/**
 * Which language a piece is written in, by its script: 'zh' / 'ja' / 'ko' / 'ru', or '' for
 * anything else — enough to pick a device voice that can say it at all.
 */
export function scriptOf(text) {
  const s = String(text ?? '')
  if (/[\u3040-\u30ff]/.test(s)) return 'ja'
  if (/[\uac00-\ud7af]/.test(s)) return 'ko'
  if (/[\u4e00-\u9fff]/.test(s)) return 'zh'
  if (/[\u0400-\u04ff]/.test(s)) return 'ru'
  return ''
}

// ---------- Cutting in on a call ----------
// The agent's own voice comes back through the microphone while it speaks, and a recognizer turns it
// into words like any other. So what is heard is compared with what was said in the last half minute:
// mostly the same words = echo. Words for spaced scripts; pairs of characters for Chinese / Japanese /
// Korean, where single characters (的, 是) repeat in any two sentences.
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
export function tokens(text) {
  const out = []
  for (const run of String(text ?? '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (!CJK.test(run)) { out.push(run); continue }
    const chars = [...run]
    if (chars.length === 1) out.push(run)
    for (let i = 0; i + 1 < chars.length; i++) out.push(chars[i] + chars[i + 1])
  }
  return out
}

/** How much was said: spaced words, plus CJK characters counted two to a word. */
export function wordCount(text) {
  let n = 0
  for (const run of String(text ?? '').match(/[\p{L}\p{N}]+/gu) ?? []) n += CJK.test(run) ? [...run].length / 2 : 1
  return n
}

export class SpokenMemory {
  constructor({ keepMs = 30_000 } = {}) { this.items = []; this.keepMs = keepMs }
  add(text, now = Date.now()) { this.items.push({ at: now, words: new Set(tokens(text)) }); this.prune(now) }
  prune(now = Date.now()) { this.items = this.items.filter(x => now - x.at < this.keepMs) }
  clear() { this.items = [] }
  /** The share of what was heard that the agent itself said lately (0–1). */
  echoShare(text, now = Date.now()) {
    this.prune(now)
    const heard = tokens(text)
    if (!heard.length || !this.items.length) return 0
    return heard.filter(w => this.items.some(x => x.words.has(w))).length / heard.length
  }
  isEcho(text, ratio = 0.6, now = Date.now()) { return this.echoShare(text, now) >= ratio }
}

/** Short enough to mean "stop talking" on their own. */
const INTERRUPT = new Set(['stop', 'wait', 'hold on', 'hang on', 'pause', 'no', 'enough',
  '停', '停下', '停一下', '等等', '等一下', '别说了', '不对', '暂停', '好了', '够了'])
const clean = t => String(t ?? '').toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, ' ').trim().replace(/\s+/g, ' ')

/**
 * Heard while the agent speaks — does it cut in? A sentence that isn't the agent's own voice (while it
 * plays, most of what the mic hears IS the agent, so a lower share already counts as echo), or one
 * interruption word.
 */
export function isBargeIn(text, memory, now = Date.now()) {
  const c = clean(text)
  if (!c || memory?.isEcho(c, 0.4, now)) return false
  return wordCount(c) >= 2 || INTERRUPT.has(c)
}
/** The same for a transcript still being revised: never on one word, which may yet change. */
export function isInterimBargeIn(text, memory, now = Date.now()) {
  const c = clean(text)
  return !!c && wordCount(c) >= 2 && !memory?.isEcho(c, 0.4, now)
}
/** How long an interim must keep counting as cutting in before playback stops. */
export const INTERIM_BARGE_IN_MS = 300

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
  const r = new Reader()
  a.deepEqual(r.push('Here it is. Run'), ['Here it is.'])
  a.deepEqual(r.push(' this:\n```bash\nls -la\nrm x\n'), ['Run this:'], 'lines inside an open block are not read')
  a.deepEqual(r.push('```\nDone. All'), ['(code)', 'Done.'])
  a.deepEqual(r.push(' good', true), ['All good'])
  const r2 = new Reader()
  a.deepEqual(r2.push('**Bold claim.** And more'), ['Bold claim.'], 'no stray marks')
  a.deepEqual(r2.push('', true), ['And more'])
  const r3 = new Reader()
  a.deepEqual(r3.push('Pi is 3.'), [])
  a.deepEqual(r3.push('14 roughly. '), ['Pi is 3.14 roughly.'])
  a.deepEqual(new Reader().push('| a | b |\n|---|---|\n| 1 | 2 |\n'), ['a, b', '1, 2'])
  a.ok(new Reader().push('word '.repeat(80)).length >= 1, 'a long run starts being read before it ends')
  a.equal(scriptOf('你好'), 'zh'); a.equal(scriptOf('こんにちは'), 'ja'); a.equal(scriptOf('안녕'), 'ko')
  a.equal(scriptOf('Привет'), 'ru'); a.equal(scriptOf('Hello'), '')
  a.deepEqual(tokens('Hello, World 42'), ['hello', 'world', '42'])
  a.deepEqual(tokens('巴黎是首都'), ['巴黎', '黎是', '是首', '首都'])
  a.equal(wordCount('what is three'), 3); a.equal(wordCount('等一下'), 1.5); a.equal(wordCount('请等我说完'), 2.5)
  const mem = new SpokenMemory(), t0 = 1_000_000
  mem.add('The capital of France is Paris.', t0)
  a.ok(mem.isEcho('capital of France is', 0.6, t0 + 500), 'the reply coming back through the mic')
  a.ok(!mem.isEcho('what about Germany', 0.6, t0 + 500))
  const old = new SpokenMemory(); old.add('The capital of France is Paris.', t0)
  a.ok(!old.isEcho('capital of France is', 0.6, t0 + 31_000), 'forgotten after half a minute')
  a.ok(!isBargeIn('France is Paris', mem, t0 + 500), 'echo never cuts in')
  a.ok(isBargeIn('what about Germany', mem, t0 + 500), 'a sentence of their own does')
  a.ok(isBargeIn('Stop!', mem, t0 + 500) && isBargeIn('等一下', mem, t0 + 500), 'one interruption word does')
  a.ok(!isBargeIn('okay', mem, t0 + 500) && !isBargeIn('好的', mem, t0 + 500), 'one ordinary word does not')
  a.ok(!isInterimBargeIn('stop', mem, t0 + 500), 'an interim single word never cuts')
  a.ok(isInterimBargeIn('wait a second', mem, t0 + 500))
  const zh = new SpokenMemory(); zh.add('图片中是一台安装在墙上的空调。', t0)
  a.ok(zh.isEcho('一台安装在墙上的', 0.4, t0 + 100) && !zh.isEcho('那温度是多少', 0.4, t0 + 100))
  a.ok(isBargeIn('那温度是多少呢', zh, t0 + 100) && !isBargeIn('墙上的空调', zh, t0 + 100))
  const t1 = deviceTone('chief'), t2 = deviceTone('operator')
  a.ok(t1.pitch >= 0.85 && t1.pitch <= 1.15 && t1.rate >= 0.94 && t1.rate <= 1.06)
  a.deepEqual(deviceTone('chief'), t1, 'stable per agent')
  a.ok(t1.pitch !== t2.pitch || t1.rate !== t2.rate, 'different agents sound different')
  console.log('voice: all checks pass')
}
