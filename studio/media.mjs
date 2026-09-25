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
import { join } from 'node:path'
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

/** → {width, height, duration_ms (null for stills), codec} */
export async function probe(path) {
  const j = JSON.parse(await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', path], 30_000))
  const v = (j.streams ?? []).find(s => s.codec_type === 'video')
  if (!v) throw new Error('not an image or video ffmpeg can read')
  const dur = Number(j.format?.duration ?? v.duration)
  const still = ['png', 'mjpeg', 'webp', 'bmp', 'gif'].includes(v.codec_name) && !(dur > 0.2)
  return { width: v.width ?? null, height: v.height ?? null, duration_ms: still || !Number.isFinite(dur) ? null : Math.round(dur * 1000), codec: v.codec_name }
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

    await a.rejects(contactSheet({ takes: [] }), /no candidates/)
    await a.rejects(contactSheet({ takes: Array(9).fill({ path: v1, n: 1 }) }), /at most 8/)
    console.log('media.mjs: all checks passed')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
