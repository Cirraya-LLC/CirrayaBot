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

const stamp = s => {
  const ms = Math.max(0, Math.round(s * 1000))
  const h = Math.floor(ms / 3_600_000), m = Math.floor(ms / 60_000) % 60, sec = Math.floor(ms / 1000) % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`
}
/** SubRip. Line breaks inside a cue become spaces: one subtitle, one line on a phone. */
export const srt = cues => cues.map((c, i) => `${i + 1}\n${stamp(c.start)} --> ${stamp(c.end)}\n${String(c.text).replace(/\s*\n\s*/g, ' ')}\n`).join('\n')

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
    '1\n00:00:00,000 --> 00:00:01,950\nA：one\n\n2\n01:01:01,500 --> 01:01:02,000\na b\n')
  console.log('dialogue.mjs: all checks passed')
}
