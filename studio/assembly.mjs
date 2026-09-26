// Cutting an episode: the approved takes in script order, each trimmed to its shot's length,
// narration and off-screen lines spoken (tts.mjs) and mixed in, subtitles from every line, burned
// into the picture and also kept as an .srt beside it. The worker runs one at a time.
//
// What was left out is written down (assemblies.log), never silently dropped: no speech service →
// the narration is only in the subtitles; a line the service refused → the same, for that line.
//
// Speech is cached: a line in the same voice with the same words is one asset (tag tts:<hash>),
// so cutting again after a one-shot change doesn't pay for every line twice.
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as db from './db.mjs'
import * as tts from './tts.mjs'
import { timeline, srt, layout, lineUnits } from './dialogue.mjs'
import { assemble, FRAME } from './media.mjs'
import { ratioOf } from './actions.mjs'

export async function runAssembly(id, { store, stash, stashText, addAsset, newGeneration, finishGeneration }) {
  const claimed = await db.q(`update assemblies set status = 'running', started_at = now() where id = $1 and status = 'queued' returning *`, [id])
  const job = claimed.rows[0]
  if (!job) return null
  const log = []
  let dir = null
  try {
    const ep = (await db.q('select * from episodes where id = $1', [job.episode_id])).rows[0]
    const p = await db.getProject(job.project_id)
    const shots = (await db.q(`
      select s.code, s.status, s.def, v.sha256, v.duration_ms, g.params
        from shots s join scenes sc on sc.id = s.scene_id
        left join assets v on v.id = s.pick_asset_id
        left join generations g on g.id = v.generation_id
       where sc.episode_id = $1 order by sc.ord, sc.created_at, s.ord, s.created_at`, [ep.id])).rows
    if (!shots.length) throw new Error(`${ep.code} has no shots`)
    const missing = shots.filter(s => !s.sha256 || !['approved', 'locked'].includes(s.status))
    if (missing.length) throw new Error(`not every shot has an approved take: ${missing.map(s => s.code).join(', ')}`)

    // Each take is cut to its shot's length: trim_to when Seedance's minimum made it longer, else
    // the planned duration, and never longer than the take itself.
    let t = 0
    const plan = shots.map(s => {
      const have = (s.duration_ms ?? 0) / 1000 || Number(s.def?.duration_s) || 4
      const want = Number(s.params?.trim_to) || Number(s.def?.duration_s) || have
      const seconds = Math.min(have, want)
      const row = { ...s, start: t, duration: seconds, lines: s.def?.dialogue ?? [], spoken: {}, clips: {} }
      t += seconds
      return row
    })

    // Speech for everything the camera doesn't say.
    const cfg = tts.config()
    const voices = new Map((await db.q('select lower(name) as n, card from characters where project_id = $1', [p.id])).rows.map(r => [r.n, tts.voiceOf(r.card)]))
    const narrator = tts.voiceOf({ voice: p.info?.narrator })
    let skipped = 0
    for (const s of plan) for (const [i, l] of s.lines.entries()) {
      if (l.kind === 'onscreen') continue
      if (!tts.ready(cfg)) { skipped++; continue }
      const v = l.kind === 'narration' ? narrator : voices.get(l.speaker.toLowerCase()) ?? tts.voiceOf({})
      const hash = createHash('sha1').update(JSON.stringify([cfg.model, v.voice, v.instructions, l.text])).digest('hex').slice(0, 20)
      let a = (await db.q(`select * from assets where project_id = $1 and kind = 'voice' and $2 = any(tags) and status = 'active' limit 1`, [p.id, `tts:${hash}`])).rows[0]
      if (!a) {
        const gen = await newGeneration(p, { engine: 'tts', model: cfg.model, kind: 'audio', prompt: l.text,
          params: { voice: v.voice, instructions: v.instructions, speaker: l.speaker || '(narrator)' }, status: 'running', requested_by: 'studio' })
        try {
          const out = await tts.speak(cfg, { text: l.text, voice: v.voice, instructions: v.instructions })
          const file = await stash(out.audio, { maxBytes: 50 * 1024 ** 2, mime: out.mime })
          a = await addAsset(p, file, { kind: 'voice', tags: [`tts:${hash}`, `voice:${v.voice}`], generation_id: gen, created_by: 'studio' })
          await finishGeneration(gen, { ok: true, outputs: [a.id] })
        } catch (e) {
          await finishGeneration(gen, { ok: false, error: e.message })
          log.push({ code: 'tts_failed', shot: s.code, line: l.text.slice(0, 60), error: e.message.slice(0, 200) })
          continue
        }
      }
      s.clips[i] = store.path(a.sha256)
      s.spoken[i] = (a.duration_ms ?? 0) / 1000 || undefined
    }
    if (skipped) log.push({ code: 'no_tts', lines: skipped })

    const ratio = ratioOf(p.info)
    const [W, H] = FRAME[ratio] ?? FRAME['9:16']
    const { cues: raw, narration } = timeline(plan)
    // Every cue fits the frame: broken between words, two lines at most (dialogue.layout).
    const cues = layout(raw, lineUnits(W, H))
    const subs = srt(cues)
    const srtFile = cues.length ? await stashText(subs, 'application/x-subrip') : null
    const srtAsset = srtFile ? await addAsset(p, srtFile, { kind: 'subtitles', tags: [`episode:${ep.code}`], created_by: 'studio' }) : null

    dir = await mkdtemp(join(tmpdir(), 'cut-'))
    let srtPath = null
    if (cues.length) { srtPath = join(dir, 'subs.srt'); await writeFile(srtPath, subs) }
    // The project's background music, if a person chose one.
    let bgm = null
    if (p.info?.bgm?.asset) {
      const m = (await db.q(`select sha256 from assets where id = $1 and project_id = $2`, [p.info.bgm.asset, p.id])).rows[0]
      if (m && await store.has(m.sha256)) bgm = { path: store.path(m.sha256), level: p.info.bgm.level ?? 'medium' }
      else log.push({ code: 'bgm_missing' })
    }
    const out = await assemble({
      dir, ratio, bgm, burn: job.params?.burn !== false, srtPath,
      segments: plan.map(s => ({ path: store.path(s.sha256), seconds: s.duration })),
      narration: narration.filter(n => plan[n.shot].clips[n.line]).map(n => ({ path: plan[n.shot].clips[n.line], at: n.at })),
    })
    const { createReadStream } = await import('node:fs')
    const file = await stash(createReadStream(out), { maxBytes: 4 * 1024 ** 3 })
    const video = await addAsset(p, file, { kind: 'episode', tags: [`episode:${ep.code}`], created_by: 'studio' })
    await db.q(`update assemblies set status = 'done', finished_at = now(), video_asset_id = $2, srt_asset_id = $3, log = $4 where id = $1`,
      [id, video.id, srtAsset?.id ?? null, JSON.stringify(log)])
    await db.audit('studio', 'episode.cut', ep.code, true, `${plan.length} shots, ${Math.round(t)} s${log.length ? `, ${log.map(l => l.code).join(', ')}` : ''}`)
    return { ok: true, video: video.id, seconds: t, log }
  } catch (e) {
    await db.q(`update assemblies set status = 'failed', finished_at = now(), error = $2, log = $3 where id = $1`, [id, String(e.message).slice(0, 500), JSON.stringify(log)])
    await db.audit('studio', 'episode.cut', job.episode_id, false, e.message)
    console.error(`assembly ${id}: ${e.message}`)
    return { ok: false, error: e.message }
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true })
  }
}
