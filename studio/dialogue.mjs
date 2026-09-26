// Dialogue in a shot, and the subtitles made from it. Pure: no database, no ffmpeg.
//
// The director writes the lines into the shot definition (shot.plan), each one of three kinds:
//
//   onscreen   a character we see, speaking. Seedance generates it WITH the picture
//              (generate_audio) so the lips match — the studio appends the lines to the prompt
//              itself, so a cinematographer who forgets them can't lose them.
//   offscreen  a character we don't see (a voice through a door, on the phone): TTS, in that
//              character's own voice (card.voice).
//   narration  the narrator: TTS, in the project's narrator voice (info.narrator).
//
// Every line becomes a subtitle. Short dramas are watched with the sound off as often as on.
//
// Self-test: node studio/dialogue.mjs
export const KINDS = ['onscreen', 'offscreen', 'narration']
export const MAX_LINES = 12

/**
 * Check and tidy `def.dialogue`. Returns {lines, error}. A narration line needs no speaker; the
 * others name a character, which must exist in the project (checked by the caller, who has the db).
 */
export function normDialogue(raw) {
  if (raw == null) return { lines: [] }
  if (!Array.isArray(raw)) return { error: 'dialogue must be a list of {speaker, text, kind}' }
  if (raw.length > MAX_LINES) return { error: `at most ${MAX_LINES} lines per shot — a shot that talks more than that is two shots` }
  const lines = []
  for (const [i, l] of raw.entries()) {
    if (!l || typeof l !== 'object') return { error: `dialogue line ${i + 1} must be an object {speaker, text, kind}` }
    const kind = KINDS.includes(l.kind) ? l.kind : l.kind == null ? 'onscreen' : null
    if (!kind) return { error: `dialogue line ${i + 1}: kind is one of ${KINDS.join(' / ')}` }
    const text = String(l.text ?? '').trim()
    if (!text) return { error: `dialogue line ${i + 1} has no text` }
    if (text.length > 300) return { error: `dialogue line ${i + 1} is over 300 characters — split it` }
    const speaker = String(l.speaker ?? '').trim().slice(0, 80)
    if (kind !== 'narration' && !speaker) return { error: `dialogue line ${i + 1}: who says it? (speaker)` }
    lines.push({ kind, speaker: kind === 'narration' ? '' : speaker, text })
  }
  return { lines }
}

const LABEL = {
  en: { head: 'Dialogue — spoken on camera, lips in sync, exactly these words:', q: t => `"${t}"` },
  'zh-Hans': { head: '对白（角色出镜说出，口型同步，逐字照念）：', q: t => `「${t}」` },
  'zh-Hant': { head: '對白（角色出鏡說出，口型同步，逐字照念）：', q: t => `「${t}」` },
}

/** The block the studio adds to a Seedance prompt. Empty when nobody speaks on camera. */
export function promptBlock(lines, lang = 'en') {
  const on = (lines ?? []).filter(l => l.kind === 'onscreen')
  if (!on.length) return ''
  const L = LABEL[lang] ?? LABEL.en
  return `\n\n${L.head}\n${on.map(l => `${l.speaker}: ${L.q(l.text)}`).join('\n')}`
}

/** Does this shot need Seedance to generate sound? */
export const speaksOnCamera = lines => (lines ?? []).some(l => l.kind === 'onscreen')

/**
 * How long a line takes to say, when nothing better is known. CJK ~4.5 characters a second,
 * other scripts ~14; at least 1.2 s so a subtitle can be read at all.
 */
export function estimateSeconds(text) {
  const s = String(text ?? '')
  const cjk = (s.match(/[　-鿿가-힯＀-￯]/g) ?? []).length
  return Math.max(1.2, cjk / 4.5 + (s.length - cjk) / 14)
}

/**
 * Subtitle cues for a cut. shots: [{start, duration, lines, spoken: {lineIndex: seconds}}] where
 * `spoken` holds the real length of TTS audio when there is one.
 *
 * On camera: the lines share the shot, in order — the model decides the exact moment, so the
 *   honest thing is an even split (never running past the cut).
 * Off camera / narration: one after another from the shot's start, each as long as its audio;
 *   if the voice runs past the shot it runs past, and the cue says so — hiding it would lie.
 * Returns {cues: [{start, end, text}], narration: [{shot, line, at}]} — `at` is where each TTS
 * clip starts in the cut, for the mix.
 */
export function timeline(shots) {
  const cues = [], narration = []
  for (const [si, s] of shots.entries()) {
    const on = s.lines.map((l, i) => ({ ...l, i })).filter(l => l.kind === 'onscreen')
    const off = s.lines.map((l, i) => ({ ...l, i })).filter(l => l.kind !== 'onscreen')
    on.forEach((l, k) => {
      const a = s.start + (s.duration * k) / on.length, b = s.start + (s.duration * (k + 1)) / on.length
      cues.push({ start: a, end: Math.max(a + 0.5, b - 0.05), text: l.speaker ? `${l.speaker}：${l.text}` : l.text })
    })
    let t = s.start + 0.2
    for (const l of off) {
      const len = s.spoken?.[l.i] ?? estimateSeconds(l.text)
      narration.push({ shot: si, line: l.i, at: t })
      cues.push({ start: t, end: t + len, text: l.kind === 'narration' ? l.text : `${l.speaker}：${l.text}` })
      t += len + 0.15
    }
  }
  return { cues: cues.sort((a, b) => a.start - b.start), narration }
}

// ---------- laying subtitles out on the frame ----------
// A cue must fit the picture: at most two lines, broken between words — never inside one (中文
// has no spaces, so Intl.Segmenter finds the words; a line that breaks "十二|岁" reads wrong). A cue
// longer than two lines becomes several cues one after another, sharing its time by length.
const CJK = /[\u2e80-\u9fff\uac00-\ud7af\uff00-\uffef\u3000-\u303f]/
const width = str => [...str].reduce((n, ch) => n + (CJK.test(ch) ? 1 : 0.55), 0)
const CLOSING = /^[，。！？；：、,.!?;:）】》」』…—]+$/
const words = text => {
  const out = []
  try {
    for (const { segment } of new Intl.Segmenter('zh', { granularity: 'word' }).segment(text)) {
      // Punctuation stays with the word before it: a line never starts with "，".
      if (out.length && CLOSING.test(segment.trim())) out[out.length - 1] += segment
      else out.push(segment)
    }
  } catch { out.push(...text) }
  return out
}

/** Lines of at most `max` width units (a CJK character is 1). A single word wider than that is cut. */
export function wrap(text, max) {
  const lines = []
  let cur = ''
  for (const w of words(String(text).replace(/\s+/g, ' ').trim())) {
    if (cur && width(cur + w) > max) { lines.push(cur.trim()); cur = '' }
    let piece = cur ? w : w.trimStart()
    while (width(piece) > max) {                     // a "word" longer than a line (a URL, a name run)
      let cut = 0, n = 0
      for (const ch of piece) { n += CJK.test(ch) ? 1 : 0.55; if (n > max) break; cut += ch.length }
      lines.push(piece.slice(0, cut)); piece = piece.slice(cut)
    }
    cur += piece
  }
  if (cur.trim()) lines.push(cur.trim())
  return lines
}

/** How many width units fit on one line of this frame (the burned-in style in media.mjs). */
export function lineUnits(frameW, frameH) {
  const fontPx = 12 * frameH / 288                   // libass: FontSize 12 in a 288-high script
  return Math.max(6, Math.floor(frameW * 0.86 / fontPx))
}

/** Cues laid out for the frame: ≤ 2 lines each, long ones split in time by their length. */
export function layout(cues, max) {
  const out = []
  for (const c of cues) {
    const lines = wrap(c.text, max)
    const chunks = []
    for (let i = 0; i < lines.length; i += 2) chunks.push(lines.slice(i, i + 2))
    const total = chunks.reduce((n, ch) => n + width(ch.join('')), 0) || 1
    let t = c.start
    for (const [k, ch] of chunks.entries()) {
      const end = k === chunks.length - 1 ? c.end : t + (c.end - c.start) * width(ch.join('')) / total
      out.push({ start: t, end, text: ch.join('\n') })
      t = end
    }
  }
  return out
}

const stamp = s => {
  const ms = Math.max(0, Math.round(s * 1000))
  const h = Math.floor(ms / 3_600_000), m = Math.floor(ms / 60_000) % 60, sec = Math.floor(ms / 1000) % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`
}
/** SubRip. The line breaks are layout()'s; blank lines inside a cue would end it, so none survive. */
export const srt = cues => cues.map((c, i) => `${i + 1}\n${stamp(c.start)} --> ${stamp(c.end)}\n${String(c.text).replace(/\n\s*\n+/g, '\n').trim()}\n`).join('\n')

// ---------- self-test ----------
if (import.meta.url === `file://${process.argv[1]}`) {
  const a = await import('node:assert/strict')
  a.deepEqual(normDialogue(undefined), { lines: [] })
  const ok = normDialogue([{ speaker: '蛮吉', text: ' 走！ ' }, { kind: 'narration', text: '那一年，他十二岁。', speaker: 'ignored' }])
  a.deepEqual(ok.lines, [{ kind: 'onscreen', speaker: '蛮吉', text: '走！' }, { kind: 'narration', speaker: '', text: '那一年，他十二岁。' }])
  a.match(normDialogue([{ text: 'x' }]).error, /who says it/, 'on camera needs a speaker')
  a.match(normDialogue([{ speaker: 'a', text: 'x', kind: 'whisper' }]).error, /kind is one of/)
  a.match(normDialogue('hello').error, /must be a list/)
  a.match(normDialogue(Array(13).fill({ speaker: 'a', text: 'x' })).error, /at most 12/)

  a.equal(promptBlock(ok.lines, 'zh-Hans'), '\n\n对白（角色出镜说出，口型同步，逐字照念）：\n蛮吉: 「走！」', 'narration is not for Seedance')
  a.equal(promptBlock([{ kind: 'narration', text: 'x' }]), '')
  a.equal(speaksOnCamera(ok.lines), true)
  a.equal(speaksOnCamera([{ kind: 'offscreen', speaker: 'a', text: 'x' }]), false)

  a.ok(Math.abs(estimateSeconds('那一年，他十二岁。') - 2) < 0.01, '9 CJK characters ≈ 2 s')
  a.equal(estimateSeconds('Hi'), 1.2, 'never shorter than readable')

  const { cues, narration } = timeline([
    { start: 0, duration: 4, lines: [{ kind: 'onscreen', speaker: 'A', text: 'one' }, { kind: 'onscreen', speaker: 'B', text: 'two' }] },
    { start: 4, duration: 3, lines: [{ kind: 'narration', speaker: '', text: 'later' }, { kind: 'offscreen', speaker: 'C', text: 'hey' }], spoken: { 0: 1.5 } },
  ])
  a.deepEqual(cues.map(c => [c.start, +c.end.toFixed(2), c.text]), [[0, 1.95, 'A：one'], [2, 3.95, 'B：two'], [4.2, 5.7, 'later'], [5.85, 7.05, 'C：hey']])
  a.deepEqual(narration, [{ shot: 1, line: 0, at: 4.2 }, { shot: 1, line: 1, at: 5.85 }])
  a.equal(srt([{ start: 0, end: 1.95, text: 'A：one' }, { start: 3661.5, end: 3662, text: 'a\nb' }]),
    '1\n00:00:00,000 --> 00:00:01,950\nA：one\n\n2\n01:01:01,500 --> 01:01:02,000\na\nb\n')

  // Laying out: between words, two lines at most, long cues split in time.
  a.deepEqual(wrap('那一年，他十二岁。蛮吉握紧了刀', 8), ['那一年，他', '十二岁。蛮吉握', '紧了刀'], 'never inside 十二岁, punctuation stays at the end of its line')
  a.deepEqual(wrap('The boy on the cliff draws his blade', 12), ['The boy on the cliff', 'draws his blade'], 'Latin letters are about half a CJK character wide')
  a.deepEqual(wrap('https://example.com/abcdefghijklmnop', 10).length > 1, true, 'a word wider than a line is cut, not left hanging off the frame')
  a.equal(lineUnits(720, 1280), 11, '9:16 at 720×1280: about 11 characters a line')
  a.equal(lineUnits(1280, 720), 36)
  const lay = layout([{ start: 0, end: 6, text: '那一年，他十二岁。蛮吉握紧了刀，站在断崖边上，一动不动。' }], 8)
  a.ok(lay.length === 2 && lay.every(c => c.text.split('\n').length <= 2), `two cues of ≤ 2 lines (${JSON.stringify(lay)})`)
  a.equal(lay[0].start, 0); a.equal(lay[1].end, 6); a.equal(lay[0].end, lay[1].start, 'back to back, sharing the time')
  a.deepEqual(layout([{ start: 1, end: 2, text: '走！' }], 11), [{ start: 1, end: 2, text: '走！' }], 'a short line is left alone')
  console.log('dialogue.mjs: all checks passed')
}
