// ffprobe / ffmpeg: what a file is, and the contact sheet the reviewer looks at.
//
// A contact sheet is one JPEG: the first row is the locked reference (the look everything must
// match), then one row per candidate, four frames each across its length, every row labelled.
// One image on purpose: the platform keeps only the newest image a model has seen, and the
// reviewer needs the reference and the takes side by side, not in two turns.
//
// Cells are 320×180 and a sheet has at most 8 candidate rows, so it stays ~1.3k×1.7k px —
// under what vision models take without downscaling it into mush.
//
// Self-test: node studio/media.mjs (needs ffmpeg + a DejaVu font; the studio image has both)
import { spawn } from 'node:child_process'
import { mkdtemp, rm, readFile, writeFile, access } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'

// The labels carry character names, which are Chinese more often than not: DejaVu has no CJK and
// drew 蛮吉 as boxes, on the sheet the reviewer judges. The image sets STUDIO_FONT to WenQuanYi Micro
// Hei (~5 MB, Latin and CJK); DejaVu stays the fallback for running this outside the image.
export const FONT = process.env.STUDIO_FONT || '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
const CELL_W = 320, CELL_H = 180, PER_ROW = 4
export const MAX_ROWS = 8

function run(cmd, args, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs)
    p.stdout.on('data', d => { out += d })
    p.stderr.on('data', d => { err += d })
    p.on('error', e => { clearTimeout(t); reject(e) })
    p.on('close', code => { clearTimeout(t); code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}: ${err.trim().split('\n').slice(-3).join(' | ')}`)) })
  })
}

/** → {width, height, duration_ms (null for stills), codec, audio: has a sound track} */
export async function probe(path) {
  const j = JSON.parse(await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', path], 30_000))
  const v = (j.streams ?? []).find(s => s.codec_type === 'video' && s.disposition?.attached_pic !== 1)
  const au = (j.streams ?? []).find(s => s.codec_type === 'audio')
  const dur = Number(j.format?.duration ?? v?.duration ?? au?.duration)
  // Speech from TTS: sound only.
  if (!v && au) return { width: null, height: null, duration_ms: Number.isFinite(dur) ? Math.round(dur * 1000) : null, codec: au.codec_name, audio: true }
  if (!v) throw new Error('not an image, video or audio file ffmpeg can read')
  const still = ['png', 'mjpeg', 'webp', 'bmp', 'gif'].includes(v.codec_name) && !(dur > 0.2)
  return { width: v.width ?? null, height: v.height ?? null, duration_ms: still || !Number.isFinite(dur) ? null : Math.round(dur * 1000), codec: v.codec_name, audio: !!au }
}

const fit = `scale=${CELL_W}:${CELL_H}:force_original_aspect_ratio=decrease,pad=${CELL_W}:${CELL_H}:(ow-iw)/2:(oh-ih)/2:color=0x202020`
// ⚠️ Every cell must come out in ONE pixel format. A PNG still decodes to yuvj444p, video frames to
// yuvj420p; when the format changes mid-sequence the tile filter silently drops that frame and
// every later cell shifts left one place — the sheet has the right size and the wrong pictures
// (the reference vanished and "#1" sat at the end of the reference row). Checked by pixel below.
const ONE_FORMAT = ',format=yuvj420p'
// Label text goes through textfile=, never text=: inside a filter graph ' : , \ are syntax, and a
// name like "Mang'ji: front" escaped by hand ended the quoting early — the rest of the chain
// (the format filter after it) became part of the label and the cell kept the wrong format.
const label = file => `,drawtext=fontfile=${FONT}:textfile=${file}:x=8:y=8:fontsize=26:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=6`

/**
 * Build a sheet. refs: [{path, label}] (≤ 4, the reference row); takes: [{path, n}] (≤ 8 videos).
 * Returns a JPEG Buffer.
 */
export async function contactSheet({ refs = [], takes = [] }) {
  if (!takes.length) throw new Error('no candidates to put on a sheet')
  if (takes.length > MAX_ROWS) throw new Error(`at most ${MAX_ROWS} candidates per sheet (got ${takes.length}); ask for fewer`)
  await access(FONT).catch(() => { throw new Error(`the label font is missing (${FONT}); the sheet would have no candidate numbers`) })
  const dir = await mkdtemp(join(tmpdir(), 'sheet-'))
  try {
    let i = 0
    const cell = () => join(dir, `c${String(i++).padStart(4, '0')}.jpg`)
    const blank = out => run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=c=0x202020:s=${CELL_W}x${CELL_H}`, '-frames:v', '1', '-vf', ONE_FORMAT.slice(1), '-y', out])
    const rows = []
    if (refs.length) rows.push(refs.slice(0, PER_ROW).map((r, k) => ({ src: r.path, still: true, text: k === 0 ? `REF ${r.label ?? ''}`.trim() : r.label ?? '' })))
    for (const t of takes) {
      const { duration_ms } = await probe(t.path)
      const d = (duration_ms ?? 4000) / 1000
      rows.push(Array.from({ length: PER_ROW }, (_, k) => ({
        src: t.path, at: (d * (0.1 + 0.8 * k / (PER_ROW - 1))).toFixed(2), text: k === 0 ? `#${t.n}` : `${Math.round(d * (0.1 + 0.8 * k / (PER_ROW - 1)) * 10) / 10}s`,
      })))
    }
    for (const row of rows) {
      for (let k = 0; k < PER_ROW; k++) {
        const c = row[k], out = cell()
        if (!c) { await blank(out); continue }
        const input = c.still ? ['-i', c.src] : ['-ss', c.at, '-i', c.src]
        let lab = ''
        if (c.text) { const f = `${out}.txt`; await writeFile(f, c.text); lab = label(f) }
        await run('ffmpeg', ['-v', 'error', ...input, '-frames:v', '1', '-vf', fit + lab + ONE_FORMAT, '-q:v', '3', '-y', out])
      }
    }
    const out = join(dir, 'sheet.jpg')
    await run('ffmpeg', ['-v', 'error', '-framerate', '1', '-i', join(dir, 'c%04d.jpg'),
      '-vf', `tile=${PER_ROW}x${rows.length}:padding=4:margin=4:color=0x000000`, '-frames:v', '1', '-q:v', '3', '-y', out])
    return await readFile(out)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// ---------- assembling an episode ----------
// Frame sizes per aspect ratio at 720p — what Seedance returns at 720p, and plenty for a phone.
export const FRAME = { '9:16': [720, 1280], '16:9': [1280, 720], '1:1': [960, 960], '3:4': [720, 960], '4:3': [960, 720], '21:9': [1680, 720] }
// The subtitle font: the same CJK face as the labels (the image's WenQuanYi Micro Hei), found by
// libass through fontconfig in the font's own directory.
const SUB_FONT = process.env.STUDIO_SUB_FONT || 'WenQuanYi Micro Hei'

/**
 * One episode from its approved takes. Every take is re-encoded to the same size, rate and sound
 * format first — Seedance returns 10-bit HEVC at some resolutions, H.264 at others, with or without
 * sound, and concatenating mixed streams gives a file that plays in one player and not another.
 * The output is H.264 + AAC in MP4 (faststart): what every phone and browser plays.
 *
 * segments:  [{path, seconds}]      each take, cut to `seconds` (the shot's length, trim_to)
 * narration: [{path, at}]           speech clips placed at `at` seconds into the cut
 * srtPath:   subtitles file or null; burn: draw them into the picture (true) or leave them beside it
 * Returns the path of the finished file inside `dir` (the caller stores it, then removes dir).
 */
// Loudness. Every take is levelled first (Seedance's takes come out at different volumes, and cut
// together they jump), and the finished mix is brought to -14 LUFS / -1.5 dBTP — what short-video
// platforms play at, so an episode is neither drowned out nor turned down by the app. Background
// music sits well under the voices and ducks further whenever anyone speaks.
export const LOUDNESS = { take: -20, final: -14, peak: -1.5 }
export const BGM_LEVELS = { low: -34, medium: -30, high: -26 }

/** Integrated loudness (LUFS) of a file's sound, -Infinity for silence or no sound at all. */
export async function loudness(path) {
  const p = spawn('ffmpeg', ['-hide_banner', '-nostats', '-i', path, '-map', '0:a:0?', '-af', 'ebur128', '-f', 'null', '-'])
  let err = ''
  for await (const c of p.stderr) err += c
  const m = err.match(/Integrated loudness:\s*I:\s*(-?[\d.]+|-inf)/)
  return m && m[1] !== '-inf' ? Number(m[1]) : -Infinity
}
// ⚠️ Not ffmpeg's one-pass loudnorm: on digital silence decoded from AAC it outputs NaN and the
// encoder dies ("Input contains (near) NaN/+-Inf") — a silent take is normal here. Measure, then a
// fixed gain (bounded) and a peak limiter; silence gets no gain at all.
const gainTo = (measured, target) => (measured > -70 ? Math.max(-30, Math.min(30, target - measured)) : 0)
const PEAK = `alimiter=limit=${Math.pow(10, -1.5 / 20).toFixed(3)}:level=disabled`
// Where the subtitle sits, in the 288-high script libass uses: 30 ≈ a tenth up from the bottom; on a
// vertical frame the platforms' own buttons and captions cover the bottom ~15%, so 44 clears them.
export const marginV = (W, H) => (H > W ? 44 : 30)

/**
 * bgm: {path, level: 'low'|'medium'|'high'} or null — looped to the length of the cut, faded in and out.
 */
export async function assemble({ dir, segments, narration = [], srtPath = null, burn = true, ratio = '9:16', fps = 30, bgm = null }) {
  if (!segments.length) throw new Error('nothing to assemble')
  const [W, H] = FRAME[ratio] ?? FRAME['9:16']
  const parts = []
  for (const [i, s] of segments.entries()) {
    const out = join(dir, `seg${String(i).padStart(3, '0')}.mp4`)
    const { audio } = await probe(s.path)
    const g = audio ? gainTo(await loudness(s.path), LOUDNESS.take) : 0
    const secs = Math.max(0.5, Number(s.seconds) || 1).toFixed(3)
    // A take without sound gets silence of the same length, so every segment has one audio stream.
    const inputs = audio ? ['-i', s.path] : ['-i', s.path, '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo']
    // Level the take (a silent one stays silent).
    const level = g ? `,volume=${g.toFixed(2)}dB` : ''
    await run('ffmpeg', ['-v', 'error', ...inputs, '-t', secs,
      '-map', '0:v:0', '-map', audio ? '0:a:0' : '1:a:0',
      '-vf', `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,fps=${fps},format=yuv420p,setsar=1`,
      '-af', `aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo${level}`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000',
      '-shortest', '-y', out], 600_000)
    parts.push(out)
  }
  const list = join(dir, 'list.txt')
  await writeFile(list, parts.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'))
  const body = join(dir, 'body.mp4')
  await run('ffmpeg', ['-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', '-y', body], 300_000)
  // The sound is mixed on its own first, measured, then brought to the target in the last pass:
  // the loudness of the whole is only known once it is whole.
  const total = segments.reduce((n, s) => n + Math.max(0.5, Number(s.seconds) || 1), 0)
  const fmt = 'aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo'
  const margs = ['-v', 'error', '-i', body]
  for (const n of narration) margs.push('-i', n.path)
  const bgmIn = bgm ? narration.length + 1 : null
  if (bgm) margs.push('-stream_loop', '-1', '-i', bgm.path)
  const mg = []
  let dia = '[0:a]'
  if (narration.length) {
    // Speech on top of the takes' own sound. The takes are ducked while anyone narrates, so the
    // voice stays clear without the scene going silent.
    for (const [k, n] of narration.entries()) {
      const g = gainTo(await loudness(n.path), LOUDNESS.take)
      mg.push(`[${k + 1}:a]${fmt},volume=${g.toFixed(2)}dB,adelay=${Math.round(n.at * 1000)}:all=1[n${k}]`)
    }
    mg.push(`${narration.map((_, k) => `[n${k}]`).join('')}amix=inputs=${narration.length}:normalize=0:duration=longest[voice]`)
    mg.push('[voice]asplit=2[vmix][vkey]')
    mg.push('[0:a][vkey]sidechaincompress=threshold=0.03:ratio=6:attack=20:release=400[bed]')
    mg.push('[bed][vmix]amix=inputs=2:normalize=0:duration=first[dia]')
    dia = '[dia]'
  }
  if (bgm) {
    // Music under everything: levelled low, cut to the episode, faded, and ducked by the dialogue.
    const g = gainTo(await loudness(bgm.path), BGM_LEVELS[bgm.level] ?? BGM_LEVELS.medium)
    const out = Math.max(0, total - 1.5).toFixed(2)
    mg.push(`[${bgmIn}:a]${fmt},volume=${g.toFixed(2)}dB,atrim=0:${total.toFixed(2)},asetpts=PTS-STARTPTS,afade=t=in:d=1,afade=t=out:st=${out}:d=1.5[bgm]`)
    mg.push(`${dia}asplit=2[d1][dkey]`)
    mg.push('[bgm][dkey]sidechaincompress=threshold=0.02:ratio=4:attack=30:release=600[bgmd]')
    mg.push('[d1][bgmd]amix=inputs=2:normalize=0:duration=first[mix]')
    dia = '[mix]'
  }
  mg.push(`${dia}${fmt}[m]`)
  const mix = join(dir, 'mix.wav')
  await run('ffmpeg', [...margs, '-filter_complex', mg.join(';'), '-map', '[m]', '-t', total.toFixed(3), '-c:a', 'pcm_s16le', '-y', mix], 600_000)
  const gain = gainTo(await loudness(mix), LOUDNESS.final)

  const final = join(dir, 'episode.mp4')
  const args = ['-v', 'error', '-i', body, '-i', mix]
  const graph = [`[1:a]volume=${gain.toFixed(2)}dB,${PEAK},${fmt}[aout]`]
  if (srtPath && burn) {
    // ⚠️ libass sizes an SRT against a 384×288 script, not the video: these numbers are in that
    // space and scale with the frame (12 ≈ 1/24 of the height). Lines are already broken by
    // dialogue.layout() to fit; WrapStyle can't be forced for an SRT, so they must not be too long.
    const style = `FontName=${SUB_FONT},FontSize=12,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=1,Shadow=0,MarginV=${marginV(W, H)},Alignment=2`
    const esc = p => p.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'")
    graph.push(`[0:v]subtitles=filename='${esc(srtPath)}':fontsdir='${esc(dirname(FONT))}':force_style='${style}'[vout]`)
  }
  args.push('-filter_complex', graph.join(';'))
  args.push('-map', srtPath && burn ? '[vout]' : '0:v', '-map', '[aout]', '-t', total.toFixed(3))
  args.push(...srtPath && burn ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20'] : ['-c:v', 'copy'])
  args.push('-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-y', final)
  await run('ffmpeg', args, 900_000)
  return final
}

// ---------- self-test ----------
if (import.meta.url === `file://${process.argv[1]}`) {
  const a = await import('node:assert/strict')
  const dir = await mkdtemp(join(tmpdir(), 'media-test-'))
  try {
    // Two short clips (one 10-bit HEVC, like Seedance 2.5 at 1080p) and a still.
    const v1 = join(dir, 'a.mp4'), v2 = join(dir, 'b.mp4'), still = join(dir, 'ref.png')
    await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=24:duration=4', '-pix_fmt', 'yuv420p', '-y', v1])
    await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=720x1280:rate=24:duration=5',
      '-c:v', 'libx265', '-pix_fmt', 'yuv420p10le', '-x265-params', 'log-level=error', '-y', v2])
    await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=600x900', '-frames:v', '1', '-y', still])

    const p1 = await probe(v1)
    a.equal(p1.width, 1280); a.equal(p1.height, 720); a.ok(Math.abs(p1.duration_ms - 4000) < 100)
    a.equal((await probe(v2)).codec, 'hevc', '10-bit HEVC is readable')
    const ps = await probe(still)
    a.equal(ps.duration_ms, null, 'a still has no duration'); a.equal(ps.width, 600)
    await writeFile(join(dir, 'junk.bin'), 'not media')
    await a.rejects(probe(join(dir, 'junk.bin')))

    const jpg = await contactSheet({ refs: [{ path: still, label: "Mang'ji: front" }], takes: [{ path: v1, n: 1 }, { path: v2, n: 7 }] })
    a.deepEqual([...jpg.subarray(0, 3)], [0xff, 0xd8, 0xff], 'a JPEG')
    const out = join(dir, 'sheet.jpg'); await writeFile(out, jpg)
    const ss = await probe(out)
    a.equal(ss.width, 4 * 320 + 5 * 4, '4 cells + padding and margins')
    a.equal(ss.height, 3 * 180 + 4 * 4, 'reference row + one row per take')
    if (process.env.KEEP_SHEET) await writeFile(process.env.KEEP_SHEET, jpg)

    // Look at the pixels, not just the size: the reference (solid red) must be the first cell,
    // the three cells after it blank, and take #1 (testsrc, not grey) at the start of row two.
    const rgb = async (x, y) => {
      const p = spawn('ffmpeg', ['-v', 'error', '-i', out, '-vf', `crop=8:8:${x}:${y},scale=1:1`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])
      const chunks = []; for await (const c of p.stdout) chunks.push(c)
      return [...Buffer.concat(chunks)]
    }
    const [r0, g0, b0] = await rgb(4 + 160, 4 + 150)
    a.ok(r0 > 200 && g0 < 60 && b0 < 60, `reference cell is red (got ${r0},${g0},${b0})`)
    const [r1, g1, b1] = await rgb(4 + 324 + 160, 4 + 90)
    a.ok(Math.abs(r1 - 0x20) < 12 && Math.abs(g1 - 0x20) < 12 && Math.abs(b1 - 0x20) < 12, `cell 2 of the reference row is blank (got ${r1},${g1},${b1})`)
    const t1 = await rgb(4 + 200, 4 + 184 + 60)
    a.ok(!(Math.abs(t1[0] - t1[1]) < 8 && Math.abs(t1[1] - t1[2]) < 8), `row two starts with a real frame, not a blank (got ${t1})`)

    // An episode: a silent 16:9 H.264 take and a 9:16 10-bit HEVC take with sound, cut to 3 s and
    // 4 s, one narration clip, Chinese subtitles burned in.
    const talk = join(dir, 'talk.mp4'), voice = join(dir, 'voice.mp3'), subs = join(dir, 'e.srt')
    await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=720x1280:rate=24:duration=5', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5',
      '-c:v', 'libx265', '-pix_fmt', 'yuv420p10le', '-x265-params', 'log-level=error', '-c:a', 'aac', '-shortest', '-y', talk])
    await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=1.5', '-y', voice])
    a.equal((await probe(voice)).audio, true, 'speech is probed as sound')
    a.equal((await probe(voice)).width, null)
    await writeFile(subs, '1\n00:00:00,500 --> 00:00:02,500\n蛮吉：走！\n')
    const edir = await mkdtemp(join(tmpdir(), 'ep-'))
    const ep = await assemble({ dir: edir, segments: [{ path: v1, seconds: 3 }, { path: talk, seconds: 4 }],
      narration: [{ path: voice, at: 0.5 }], srtPath: subs, burn: true, ratio: '9:16' })
    const pe = await probe(ep)
    a.equal(pe.codec, 'h264', 'plays everywhere'); a.equal(pe.width, 720); a.equal(pe.height, 1280); a.equal(pe.audio, true)
    a.ok(Math.abs(pe.duration_ms - 7000) < 250, `3 s + 4 s (got ${pe.duration_ms})`)
    // The subtitle is really in the picture: the bottom band at 1 s differs from the same band in
    // the version without subtitles.
    const lufs = loudness
    const band = async (file, t) => {
      const p = spawn('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', 'crop=480:160:120:940,scale=96:32', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'])
      const c = []; for await (const x of p.stdout) c.push(x)
      return [...Buffer.concat(c)]
    }
    // The whole is at the platforms' loudness (a 440 Hz tone at full scale went in).
    a.ok(Math.abs(await lufs(ep) - LOUDNESS.final) < 1.5, `the cut is at ${LOUDNESS.final} LUFS (got ${await lufs(ep)})`)
    const plain = await band(join(edir, 'body.mp4'), 1), burned = await band(ep, 1)
    a.ok(Math.max(...plain.map((v, i) => Math.abs(v - burned[i]))) > 80, 'subtitles are drawn into the frame (white text where it was black)')
    await rm(edir, { recursive: true, force: true })

    // Background music: a silent take plus music. The music is there, and the cut still ends on time.
    const music = join(dir, 'music.mp3')
    await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=2', '-y', music])
    const bdir = await mkdtemp(join(tmpdir(), 'ep-'))
    const withMusic = await assemble({ dir: bdir, segments: [{ path: v1, seconds: 4 }], bgm: { path: music, level: 'medium' }, ratio: '16:9' })
    const pm = await probe(withMusic)
    a.ok(Math.abs(pm.duration_ms - 4000) < 200, `the music loops but the cut stays 4 s (got ${pm.duration_ms})`)
    a.ok(await lufs(withMusic) > -40, 'the music is audible on a take that had no sound')
    const silent = await assemble({ dir: bdir, segments: [{ path: v1, seconds: 2 }], ratio: '16:9' })
    a.ok(await lufs(silent) < -60, 'and without music a silent take stays silent (loudness never invents sound)')
    await rm(bdir, { recursive: true, force: true })

    await a.rejects(contactSheet({ takes: [] }), /no candidates/)
    await a.rejects(contactSheet({ takes: Array(9).fill({ path: v1, n: 1 }) }), /at most 8/)
    console.log('media.mjs: all checks passed')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
