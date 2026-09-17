// "When does this routine run next". Pure functions, no database. Self-test: node web/schedule.mjs
//
// Three kinds:
//   interval  every N minutes (at least 5 — a loop nobody watches still costs money, so the floor can't be low)
//   daily     HH:MM every day / on some weekdays (in the routine's own time zone, not the server's)
//   once      runs one time, then stops itself
//
// No time-zone library: Intl tells us the wall-clock time of an instant in a zone; going back
// to UTC takes two corrections (in the DST-switch hour the first guessed offset can be wrong,
// so we ask again at the guessed instant).

import { Say } from './i18n.mjs'

export const MIN_INTERVAL = 5

export function validTimeZone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true } catch { return false }
}

const fmtCache = new Map()
function parts(ms, tz) {
  let f = fmtCache.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', weekday: 'short',
      year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
    fmtCache.set(tz, f)
  }
  const o = {}
  for (const p of f.formatToParts(new Date(ms))) o[p.type] = p.value
  return { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour, mi: +o.minute, s: +o.second,
    wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(o.weekday) }
}

/** How many milliseconds this zone is ahead of UTC at this instant. */
function offset(ms, tz) {
  const p = parts(ms, tz)
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000
}

/** Wall-clock time in a zone → UTC ms. Day overflow (the 32nd) is carried by Date.UTC. */
export function zonedToUtc(y, mo, d, h, mi, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi)
  const first = guess - offset(guess, tz)
  return guess - offset(first, tz)
}

/**
 * The next run strictly after `from` (ms); null if it will not run again.
 * r: { kind, every_minutes, at_time:'HH:MM', weekdays:[0..6] (empty = every day), run_at, tz }
 */
export function nextRun(r, from = Date.now()) {
  if (r.kind === 'interval') return from + Math.max(MIN_INTERVAL, r.every_minutes) * 60_000
  if (r.kind === 'once') return r.run_at > from ? r.run_at : null
  if (r.kind === 'daily') {
    const [h, mi] = r.at_time.split(':').map(Number)
    const today = parts(from, r.tz)
    for (let i = 0; i <= 8; i++) {
      const t = zonedToUtc(today.y, today.mo, today.d + i, h, mi, r.tz)
      if (t <= from) continue
      if (!r.weekdays?.length || r.weekdays.includes(parts(t, r.tz).wd)) return t
    }
    return null
  }
  return null
}

/**
 * Form → storable routine fields. Throws a readable Say if invalid.
 * This is the only validation point: the UI, and later Agents creating routines, all go through it.
 */
export function checkSchedule(b) {
  const tz = typeof b.tz === 'string' && b.tz ? b.tz : 'Asia/Shanghai'
  if (!validTimeZone(tz)) throw new Say('schedule.badTimeZone', { tz })
  if (b.kind === 'interval') {
    const n = Number(b.every_minutes)
    if (!Number.isInteger(n) || n < MIN_INTERVAL) throw new Say('schedule.tooShort', { min: MIN_INTERVAL })
    if (n > 60 * 24 * 31) throw new Say('schedule.tooLong')
    return { kind: 'interval', every_minutes: n, at_time: '', weekdays: [], run_at: null, tz }
  }
  if (b.kind === 'daily') {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(b.at_time ?? ''))) throw new Say('schedule.badTime')
    const wd = Array.isArray(b.weekdays) ? [...new Set(b.weekdays)] : []
    if (wd.some(d => !Number.isInteger(d) || d < 0 || d > 6)) throw new Say('schedule.badWeekday')
    return { kind: 'daily', every_minutes: 0, at_time: b.at_time, weekdays: wd.sort(), run_at: null, tz }
  }
  if (b.kind === 'once') {
    const t = typeof b.run_at === 'number' ? b.run_at : Date.parse(b.run_at)
    if (!Number.isFinite(t)) throw new Say('schedule.runAtRequired')
    if (t <= Date.now()) throw new Say('schedule.runAtPast')
    return { kind: 'once', every_minutes: 0, at_time: '', weekdays: [], run_at: t, tz }
  }
  throw new Say('schedule.badKind')
}

// Self-test
if (import.meta.url === `file://${process.argv[1]}`) {
  const a = (c, m) => { if (!c) throw new Error('self-test failed: ' + m) }
  const iso = t => new Date(t).toISOString()

  // Shanghai = UTC+8, no DST
  const from = Date.parse('2026-09-19T00:30:00Z')                     // 08:30 Shanghai, Saturday
  a(iso(nextRun({ kind: 'daily', at_time: '09:00', weekdays: [], tz: 'Asia/Shanghai' }, from)) === '2026-09-19T01:00:00.000Z', '09:00 today not reached yet')
  a(iso(nextRun({ kind: 'daily', at_time: '08:00', weekdays: [], tz: 'Asia/Shanghai' }, from)) === '2026-09-20T00:00:00.000Z', '08:00 today has passed → tomorrow')
  a(iso(nextRun({ kind: 'daily', at_time: '09:00', weekdays: [1], tz: 'Asia/Shanghai' }, from)) === '2026-09-21T01:00:00.000Z', 'Mondays only → next Monday')
  a(nextRun({ kind: 'daily', at_time: '09:00', weekdays: [], tz: 'Asia/Shanghai' }, Date.parse('2026-09-19T01:00:00Z')) > Date.parse('2026-09-19T01:00:00Z'), 'exactly on time must skip to the next run, not run again in place')

  // New York DST ends 2026-11-01 02:00; the offset differs around 09:00
  const ny = nextRun({ kind: 'daily', at_time: '09:00', weekdays: [], tz: 'America/New_York' }, Date.parse('2026-11-01T05:00:00Z'))
  a(iso(ny) === '2026-11-01T14:00:00.000Z', `09:00 on the day DST ends is 14:00 UTC, got ${iso(ny)}`)
  const ny2 = nextRun({ kind: 'daily', at_time: '09:00', weekdays: [], tz: 'America/New_York' }, Date.parse('2026-10-30T20:00:00Z'))
  a(iso(ny2) === '2026-10-31T13:00:00.000Z', `09:00 during DST is 13:00 UTC, got ${iso(ny2)}`)

  a(nextRun({ kind: 'interval', every_minutes: 1 }, 0) === 5 * 60_000, 'interval cannot go below 5 minutes')
  a(nextRun({ kind: 'once', run_at: 100 }, 200) === null, 'a past one-off does not run')

  let threw = false
  try { checkSchedule({ kind: 'interval', every_minutes: 2 }) } catch { threw = true }
  a(threw, '2 minutes must be rejected')
  threw = false
  try { checkSchedule({ kind: 'daily', at_time: '9:00' }) } catch { threw = true }
  a(threw, '9:00 is not HH:MM')
  a(checkSchedule({ kind: 'daily', at_time: '09:00', weekdays: [5, 1, 1] }).weekdays.join() === '1,5', 'weekdays deduped and sorted')
  console.log('schedule.mjs self-test passed')
}
