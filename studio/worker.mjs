// The generation worker: turns queued Seedance takes into candidates.
//
//   queued ──submit──▶ running(remote_id) ──poll──▶ succeeded: video downloaded into the store
//                                                    failed:    reason kept
//
// All state is in the generations table; this loop only moves rows forward, so a restart loses
// nothing it hasn't already said. Two rules that cost money when broken:
//   - **Download on success, immediately.** video_url expires after 24 hours; a URL in a row is
//     not footage.
//   - **A take marked running before its remote id was saved may have been billed.** On startup
//     such rows are failed with a reason that says so, never silently resubmitted (that would be
//     the same take paid for twice).
//
// When the last take of a round finishes, the shot moves (review, or back to prompted if every
// take failed) and onRoundDone is called — phase 3 turns that into "@reviewer candidates ready".
import { Readable } from 'node:stream'
import * as db from './db.mjs'
import * as seedance from './seedance.mjs'
import { move } from './shots.mjs'

const TICK_MS = Number(process.env.STUDIO_TICK_MS || 5000)
const POLL_MS = Number(process.env.STUDIO_POLL_MS || 10_000)
const DOWNLOAD_TRIES = 3

export function startWorker({ store, stash, addAsset, finishGeneration, onRoundDone = () => {} }) {
  const lastPoll = new Map()      // generation id → ms
  const downloadFails = new Map() // generation id → count
  let busy = false, again = false

  async function recoverOrphans() {
    const { rows } = await db.q(`update generations set status = 'failed', finished_at = now(),
        error = 'the studio restarted while this take was being submitted; it may have been billed but its task id was never saved'
      where engine = 'seedance' and status = 'running' and remote_id = '' returning id, shot_id, round`)
    for (const r of rows) await closeRoundIfDone(r.shot_id, r.round)
    if (rows.length) console.log(`worker: ${rows.length} take(s) lost in a restart were marked failed`)
  }

  async function submit() {
    const { rows: projects } = await db.q(`select distinct g.project_id, p.info from generations g join projects p on p.id = g.project_id
      where g.engine = 'seedance' and g.status = 'queued'`)
    const cfg = seedance.config()
    for (const { project_id, info } of projects) {
      const { concurrent } = seedance.limits(info)
      const running = (await db.q(`select count(*)::int as n from generations where project_id = $1 and engine = 'seedance' and status = 'running'`, [project_id])).rows[0].n
      const slots = Math.max(0, concurrent - running)
      if (!slots) continue
      const { rows: queued } = await db.q(`select * from generations where project_id = $1 and engine = 'seedance' and status = 'queued'
        order by created_at limit $2`, [project_id, slots])
      for (const g of queued) {
        // Claim it first (guarded), so a second worker or tick can't submit the same take.
        const claimed = await db.q(`update generations set status = 'running', started_at = now() where id = $1 and status = 'queued'`, [g.id])
        if (!claimed.rowCount) continue
        try {
          const refs = []
          for (const id of g.ref_asset_ids) {
            const a = (await db.q('select * from assets where id = $1', [id])).rows[0]
            if (!a) throw new Error(`reference ${id} no longer exists`)
            refs.push(`data:${a.mime};base64,${(await store.read(a.sha256)).toString('base64')}`)
          }
          const { body, trim_to } = seedance.buildTask({ model: g.model, prompt: g.prompt, refs, ...g.params })
          const remote = await seedance.createTask(cfg, body)
          await db.q(`update generations set remote_id = $2, params = params || $3 where id = $1`,
            [g.id, remote, { seed: body.seed, sent_duration: body.duration, trim_to }])
        } catch (e) {
          await finishGeneration(g.id, { ok: false, error: e.message })
          await closeRoundIfDone(g.shot_id, g.round)
        }
      }
    }
  }

  async function download(url, maxBytes) {
    const res = await fetch(url, { signal: AbortSignal.timeout(600_000) })
    if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`)
    return stash(Readable.fromWeb(res.body), { maxBytes })
  }

  async function poll() {
    const cfg = seedance.config()
    const { rows } = await db.q(`select g.*, p.id as pid from generations g join projects p on p.id = g.project_id
      where g.engine = 'seedance' and g.status = 'running' and g.remote_id <> '' order by g.started_at`)
    for (const g of rows) {
      if (Date.now() - (lastPoll.get(g.id) ?? 0) < POLL_MS) continue
      lastPoll.set(g.id, Date.now())
      let t
      try { t = await seedance.getTask(cfg, g.remote_id) } catch (e) { console.error(`worker: polling ${g.id}: ${e.message}`); continue }
      if (t.state === 'pending') continue
      if (t.state === 'failed') {
        await finishGeneration(g.id, { ok: false, error: t.error })
      } else {
        let video
        try { video = await download(t.video_url, 2 * 1024 ** 3) } catch (e) {
          const n = (downloadFails.get(g.id) ?? 0) + 1
          downloadFails.set(g.id, n)
          console.error(`worker: ${g.id} download attempt ${n}: ${e.message}`)
          if (n < DOWNLOAD_TRIES) continue      // the URL is good for 24 h; try again next poll
          await finishGeneration(g.id, { ok: false, error: `generated, but the video could not be downloaded (${e.message})` })
          await closeRoundIfDone(g.shot_id, g.round)
          continue
        }
        const p = { id: g.pid }
        const out = []
        const va = await addAsset(p, video, { kind: 'video', shot_id: g.shot_id, generation_id: g.id, created_by: g.requested_by,
          tags: [`model:${g.model}`, ...g.params?.trim_to ? [`trim_to:${g.params.trim_to}`] : []] })
        out.push(va.id)
        if (t.last_frame_url) {
          // The last frame is how the next shot's first frame gets matched; losing it is not fatal.
          try {
            const f = await download(t.last_frame_url, 50 * 1024 ** 2)
            out.push((await addAsset(p, f, { kind: 'frame', shot_id: g.shot_id, generation_id: g.id, created_by: g.requested_by, tags: ['last-frame'] })).id)
          } catch (e) { console.error(`worker: ${g.id} last frame: ${e.message}`) }
        }
        // Candidate numbers are per shot and never reused.
        await db.q(`insert into candidates (shot_id, n, generation_id, asset_id, prompt_version)
          values ($1, (select coalesce(max(n), 0) + 1 from candidates where shot_id = $1), $2, $3, $4)`,
          [g.shot_id, g.id, va.id, g.prompt_version])
        await finishGeneration(g.id, { ok: true, usage: t.usage, outputs: out })
      }
      lastPoll.delete(g.id); downloadFails.delete(g.id)
      await closeRoundIfDone(g.shot_id, g.round)
    }
  }

  async function closeRoundIfDone(shotId, round) {
    if (!shotId || !round) return
    const st = (await db.q(`select count(*) filter (where status in ('queued','running'))::int as pending,
        count(*) filter (where status = 'succeeded')::int as ok, count(*) filter (where status = 'failed')::int as failed,
        min(project_id) as project_id
      from generations where shot_id = $1 and round = $2`, [shotId, round])).rows[0]
    if (st.pending) return
    const s = (await db.q('select * from shots where id = $1', [shotId])).rows[0]
    if (!s || s.status !== 'generating') return
    const action = st.ok ? 'done_ok' : 'done_no'
    const to = move(s.status, action).to
    const moved = await db.q(`update shots set status = $3, updated_at = now() where id = $1 and status = $2`, [s.id, s.status, to])
    if (!moved.rowCount) return
    const errors = st.failed ? (await db.q(`select error from generations where shot_id = $1 and round = $2 and status = 'failed'`, [shotId, round])).rows.map(r => r.error) : []
    await db.audit('studio', 'round.done', s.code, st.ok > 0, `${st.ok} ok, ${st.failed} failed`)
    try { await onRoundDone({ project_id: st.project_id, shot: s.code, round, ok: st.ok, failed: st.failed, status: to, errors }) }
    catch (e) { console.error(`worker: onRoundDone for ${s.code}: ${e.message}`) }
  }

  async function tick() {
    if (busy) { again = true; return }
    busy = true
    try { await submit(); await poll() }
    catch (e) { console.error('worker tick failed:', e.message) }
    finally {
      busy = false
      if (again) { again = false; setImmediate(tick) }
    }
  }

  const ready = recoverOrphans().catch(e => console.error('worker: recovering orphans failed:', e.message))
  const timer = setInterval(() => { ready.then(tick) }, TICK_MS)
  timer.unref?.()
  return { kick: () => ready.then(tick), stop: () => clearInterval(timer), tick }
}
