// Speech in the browser: hearing the person, reading replies aloud, and noticing someone start to
// talk. The rules about *what* is read (and how a reply is cut into sentences) are in voice.mjs;
// this file only drives the browser's microphone, recognizer and voices.
//
// Two engines each, as the voice settings say:
//   device    SpeechRecognition / speechSynthesis — the browser's own (Chrome, Edge, Safari send the
//             audio to their maker's speech service; Firefox has no recognizer)
//   upstream  record with MediaRecorder → /api/voice/transcribe; /api/voice/speak → an <audio> element
import { deviceTone, scriptOf } from './voice.mjs'

const SR = window.SpeechRecognition || window.webkitSpeechRecognition
export const canHear = () => !!SR
export const canRecord = () => !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder)
export const canSpeak = () => 'speechSynthesis' in window

/** What the recognizer should listen for: the person's choice, else the interface language. */
export function hearLang(choice, uiLang) {
  if (choice) return choice
  const nav = navigator.languages?.length ? navigator.languages : [navigator.language || 'en-US']
  if (uiLang === 'zh-Hans') return 'zh-CN'
  if (uiLang === 'zh-Hant') return nav.find(l => /^zh-(TW|HK|MO|Hant)/i.test(l)) || 'zh-TW'
  return nav.find(l => /^en\b/i.test(l)) || 'en-US'
}

// ═══ Device voices ═══
/** The browser's voices; some browsers fill the list a moment after the page loads. */
export function deviceVoices() {
  if (!canSpeak()) return Promise.resolve([])
  const now = speechSynthesis.getVoices()
  if (now.length) return Promise.resolve(now)
  return new Promise(ok => {
    const done = () => { speechSynthesis.removeEventListener('voiceschanged', done); ok(speechSynthesis.getVoices()) }
    speechSynthesis.addEventListener('voiceschanged', done)
    setTimeout(done, 1500)
  })
}

/**
 * The voice to say `text` with. The person's chosen voice when it can say this language at all;
 * otherwise the best voice for the script the text is written in — an English voice reading
 * Chinese is not speech.
 */
function voiceFor(text, preferred, uiLang) {
  const vs = speechSynthesis.getVoices()
  const want = scriptOf(text)
  const lang = v => (v.lang || '').toLowerCase().replace('_', '-')
  const chosen = preferred && vs.find(v => v.voiceURI === preferred || v.name === preferred)
  const cjk = v => /^(zh|ja|ko|yue|cmn)/.test(lang(v))
  if (chosen && (want ? lang(chosen).startsWith(want) || (want === 'zh' && /^(cmn|yue)/.test(lang(chosen))) : true)) return chosen
  if (want === 'zh') {
    const region = uiLang === 'zh-Hant' ? /^zh-(tw|hk)/ : /^zh-cn/
    return vs.find(v => region.test(lang(v))) || vs.find(v => /^(zh|cmn)/.test(lang(v))) || null
  }
  if (want) return vs.find(v => lang(v).startsWith(want)) || null
  const ui = uiLang.startsWith('zh') ? 'en' : uiLang.slice(0, 2)
  return vs.find(v => v.default && !cjk(v)) || vs.find(v => lang(v).startsWith(ui)) || vs.find(v => lang(v).startsWith('en')) || null
}

// ═══ Speaking ═══
/**
 * A queue of sentences read one after another. say() returns at once; `onState(speaking)` says
 * when sound starts and when the queue has run dry. Upstream audio is fetched up to three
 * sentences ahead so there is no gap between them.
 */
export class Speaker {
  constructor({ mode, speakUrl, fetch, preferred, uiLang, onState = () => {}, onSay = () => {}, onError = () => {} }) {
    Object.assign(this, { mode, speakUrl, fetch, preferred, uiLang, onState, onSay, onError })
    this.queue = []; this.playing = null; this.gen = 0; this.warned = false
  }
  get busy() { return !!this.playing || this.queue.length > 0 }
  say(text, agent) {
    if (!String(text ?? '').trim()) return
    const item = { text, agent, gen: this.gen }
    this.queue.push(item)
    if (this.mode() === 'upstream') this.prefetch()
    if (!this.playing) this.next()
  }
  prefetch() {
    for (const it of this.queue.slice(0, 3)) {
      if (it.audio) continue
      it.ctl = new AbortController()
      it.audio = this.fetch(this.speakUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: it.ctl.signal,
        body: JSON.stringify({ text: it.text, agent: it.agent }) })
        .then(async r => { if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`); return r.blob() })
      it.audio.catch(() => {})                        // handled where it is awaited
    }
  }
  async next() {
    const it = this.queue.shift()
    if (!it) { if (this.playing !== null) { this.playing = null; this.onState(false) } return }
    // Playing before saying so: a listener asking "is it speaking?" from onState must hear yes.
    const first = !this.playing
    this.playing = it
    if (first) this.onState(true)
    this.onSay(it.text, it.agent)
    try {
      if (this.mode() === 'upstream') { this.prefetch(); await this.playUpstream(it) }
      else await this.playDevice(it)
    } catch (e) {
      // One message per run of failures: a reply of twenty sentences shouldn't say so twenty times.
      if (it.gen === this.gen && e?.name !== 'AbortError' && !this.warned) { this.warned = true; this.onError(e) }
    }
    if (it.gen !== this.gen) return                    // stopped meanwhile; stop() already reset the state
    this.next()
  }
  playDevice(it) {
    return new Promise(done => {
      const u = new SpeechSynthesisUtterance(it.text)
      const v = voiceFor(it.text, this.preferred(), this.uiLang())
      if (v) { u.voice = v; u.lang = v.lang }
      const tone = deviceTone(it.agent)
      u.pitch = tone.pitch; u.rate = tone.rate
      // Some engines never fire onend (or drop the utterance when it is collected): a watchdog,
      // generous enough for slow voices, keeps the queue moving.
      const dog = setTimeout(finish, 4000 + it.text.length * 160)
      function finish() { clearTimeout(dog); done() }
      u.onend = finish; u.onerror = finish
      it.utter = u                                    // keep a reference while it plays
      it.cancel = () => { speechSynthesis.cancel(); finish() }
      speechSynthesis.speak(u)
    })
  }
  async playUpstream(it) {
    const blob = await it.audio
    if (it.gen !== this.gen) return
    const url = URL.createObjectURL(blob)
    const el = new Audio(url)
    await new Promise((done, fail) => {
      const end = () => { URL.revokeObjectURL(url); done() }
      el.onended = end; el.onerror = () => { URL.revokeObjectURL(url); fail(new Error('audio')) }
      it.cancel = () => { el.pause(); end() }
      el.play().catch(e => { URL.revokeObjectURL(url); fail(e) })
    })
    this.warned = false
  }
  /** Silence now, and forget everything queued. */
  stop() {
    this.gen++
    for (const it of this.queue) it.ctl?.abort()
    this.queue = []
    const p = this.playing
    this.playing = null
    p?.ctl?.abort(); p?.cancel?.()
    if (canSpeak()) speechSynthesis.cancel()
    if (p) this.onState(false)
  }
}

// ═══ The microphone, as a level ═══
/**
 * One open microphone with echo cancellation, and how loud it is right now. Echo cancellation
 * covers sound this page plays itself (an <audio> element) — not the operating system's own
 * speech engine, which is why talking over a device voice isn't detected.
 */
export class Mic {
  async open() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
    this.ctx = new AudioContext()
    const src = this.ctx.createMediaStreamSource(this.stream)
    this.an = this.ctx.createAnalyser(); this.an.fftSize = 1024
    src.connect(this.an)
    this.buf = new Float32Array(this.an.fftSize)
    return this
  }
  level() {
    if (!this.an) return 0
    this.an.getFloatTimeDomainData(this.buf)
    let sum = 0
    for (const x of this.buf) sum += x * x
    return Math.sqrt(sum / this.buf.length)
  }
  close() { this.stream?.getTracks().forEach(t => t.stop()); this.ctx?.close().catch(() => {}); this.an = null }
}

/**
 * Speech as opposed to room noise: louder than the quiet the mic heard so far, for long enough.
 * tick() every ~50 ms with the level; it says whether someone is talking now.
 */
export class Voice {
  constructor({ floor = 0.004, min = 0.012, onsetMs = 140 } = {}) { this.floor = floor; this.min = min; this.onsetMs = onsetMs; this.loudFor = 0 }
  get threshold() { return Math.max(this.min, this.floor * 3) }
  tick(level, ms = 50) {
    const loud = level > this.threshold
    // The quiet adapts slowly, and only while nobody is talking — otherwise speech raises its own bar.
    if (!loud) this.floor = this.floor * 0.97 + Math.min(level, this.min) * 0.03
    this.loudFor = loud ? this.loudFor + ms : 0
    return this.loudFor >= this.onsetMs
  }
}

const pickType = () => ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
  .find(t => window.MediaRecorder?.isTypeSupported?.(t)) || ''

// ═══ Hearing ═══
/**
 * One thing said, as text. start() resolves with it ('' = nothing was heard); stop() ends the
 * listening now and keeps what was said, abort() throws it away.
 *
 *   mode        'device' | 'upstream'
 *   lang        BCP-47 for the device recognizer; the upstream gets its first two letters, if any
 *   continuous  dictation: keep going through pauses, until stop() (device) or a long silence
 *   mic         an open Mic, for upstream mode (opened and closed here if not given)
 *   transcribe  blob → text, for upstream mode
 *   onInterim   what has been heard so far (device), or the mic level (upstream: a number)
 */
export class Listener {
  start({ mode, lang, continuous = false, mic = null, transcribe, onInterim = () => {}, onSpeech = () => {},
    endSilenceMs = continuous ? 2500 : 1100, noSpeechMs = continuous ? 15000 : 9000, maxMs = continuous ? 120000 : 60000 }) {
    this.done = false
    return mode === 'upstream'
      ? this.record({ lang, mic, transcribe, onInterim, onSpeech, endSilenceMs, noSpeechMs, maxMs })
      : this.recognize({ lang, continuous, onInterim, onSpeech })
  }

  recognize({ lang, continuous, onInterim, onSpeech }) {
    return new Promise((resolve, reject) => {
      if (!SR) return reject(Object.assign(new Error('no recognizer'), { code: 'unsupported' }))
      const rec = new SR()
      rec.lang = lang; rec.interimResults = true; rec.continuous = continuous; rec.maxAlternatives = 1
      let final = '', interim = '', failed = null, spoke = false
      rec.onresult = e => {
        interim = ''
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i]
          if (r.isFinal) final += r[0].transcript; else interim += r[0].transcript
        }
        if (!spoke && (final || interim)) { spoke = true; onSpeech() }
        onInterim((final + interim).trim())
      }
      rec.onerror = e => {
        if (e.error === 'no-speech' || e.error === 'aborted') return
        failed = Object.assign(new Error(e.error), { code: /not-allowed|service-not-allowed/.test(e.error) ? 'denied' : e.error })
      }
      rec.onend = () => {
        this.rec = null
        if (failed) return reject(failed)
        resolve(this.thrown ? '' : (final || interim).trim())
      }
      this.rec = rec; this.thrown = false
      try { rec.start() } catch (e) { reject(e) }
    })
  }

  async record({ lang, mic, transcribe, onInterim, onSpeech, endSilenceMs, noSpeechMs, maxMs }) {
    const own = !mic
    if (own) mic = await new Mic().open().catch(e => { throw Object.assign(e, { code: e.name === 'NotAllowedError' ? 'denied' : 'mic' }) })
    const type = pickType()
    const rec = new MediaRecorder(mic.stream, type ? { mimeType: type } : undefined)
    const chunks = []
    rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data) }
    const stopped = new Promise(ok => { rec.onstop = ok })
    rec.start(250)
    const voice = new Voice()
    let heard = false, quietFor = 0, t = 0
    this.thrown = false
    await new Promise(ok => {
      const end = () => { clearInterval(timer); this.finish = null; ok() }
      const timer = setInterval(() => {
        const level = mic.level()
        onInterim(level)
        t += 50
        if (voice.tick(level) && !heard) { heard = true; onSpeech() }
        quietFor = level > voice.threshold * 0.7 ? 0 : quietFor + 50
        if ((heard && quietFor >= endSilenceMs) || (!heard && t >= noSpeechMs) || t >= maxMs) end()
      }, 50)
      this.finish = end
    })
    rec.stop()
    await stopped
    if (own) mic.close()
    if (this.thrown || !heard || !chunks.length) return ''
    const blob = new Blob(chunks, { type: rec.mimeType || type || 'audio/webm' })
    return transcribe(blob, (lang || '').slice(0, 2).toLowerCase())
  }

  /** Done listening: keep what was said. */
  stop() { if (this.rec) this.rec.stop(); this.finish?.() }
  /** Done listening: nothing was meant. */
  abort() { this.thrown = true; if (this.rec) this.rec.abort(); this.finish?.() }
}
