// Tags and reference matching. The cinematographer finds reference images by tag
// ("char.refs 蛮吉 --look 战斗装 --angle 3-4 --expr 咬牙"), so a tag that is missing or spelled
// two ways is a picture that doesn't exist (character-bible skill). Tags are "key:value".
//
// Matching is strict first, then relaxed one filter at a time in a fixed order — and the
// answer says which filters were dropped. A reference that silently doesn't match what was
// asked for is how a 3/4 shot gets generated from a front view.
//
// Self-test: node studio/refs.mjs

// The keys the crew's skills use. Other keys are allowed (free tags), these are just normalised.
export const TAG_KEYS = ['angle', 'expr', 'light', 'shot']

// Angle spellings seen in the skills and likely from models → one form.
const ANGLE = {
  '正': '正', '正面': '正', front: '正',
  '3-4': '3-4', '3/4': '3-4', '四分之三': '3-4', 'three-quarter': '3-4',
  '侧': '侧', '侧面': '侧', side: '侧', profile: '侧',
  '背': '背', '背面': '背', back: '背',
}

/** "angle:3/4" / " Angle : 正面 " → "angle:3-4" / "angle:正". Untyped words become plain tags. */
export function normTag(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return ''
  const i = s.indexOf(':')
  if (i < 0) return s.toLowerCase().slice(0, 60)
  const key = s.slice(0, i).trim().toLowerCase()
  let val = s.slice(i + 1).trim()
  if (!key || !val) return ''
  if (key === 'angle') val = ANGLE[val.toLowerCase()] ?? ANGLE[val] ?? val
  return `${key}:${val}`.slice(0, 80)
}

export function normTags(list) {
  const out = []
  for (const t of Array.isArray(list) ? list : String(list ?? '').split(',')) {
    const n = normTag(t)
    if (n && !out.includes(n)) out.push(n)
  }
  return out.slice(0, 40)
}

// Relax the least important filter first: framing, then light, then expression. Angle is
// never dropped — a wrong-angle turnaround is the classic cause of a character drifting.
const RELAX = ['shot', 'light', 'expr']

/**
 * Pick references from candidate assets.
 * @param assets [{id, tags, kind, ...}] already limited to the right character/look/location
 * @param want   {angle, expr, light, shot} — any may be empty
 * @returns {matches, relaxed} — matches ordered by how many wanted tags they carry
 */
export function matchRefs(assets, want = {}) {
  const filters = Object.fromEntries(TAG_KEYS
    .map(k => [k, want[k] ? normTag(`${k}:${want[k]}`) : ''])
    .filter(([, v]) => v))
  const has = (a, tag) => (a.tags ?? []).includes(tag)
  const relaxed = []
  let active = { ...filters }
  for (let round = 0; ; round++) {
    const hits = assets.filter(a => Object.values(active).every(t => has(a, t)))
    if (hits.length || round >= RELAX.length) {
      const score = a => Object.values(filters).filter(t => has(a, t)).length
      return { matches: [...hits].sort((x, y) => score(y) - score(x)), relaxed }
    }
    const next = RELAX.find(k => active[k])
    if (!next) return { matches: [], relaxed }
    relaxed.push(next)
    delete active[next]
  }
}

// ---------- self-test ----------
if (import.meta.url === `file://${process.argv[1]}`) {
  const a = await import('node:assert/strict')

  a.equal(normTag('angle:3/4'), 'angle:3-4')
  a.equal(normTag(' Angle : 正面 '), 'angle:正')
  a.equal(normTag('angle:Front'), 'angle:正')
  a.equal(normTag('expr:咬牙'), 'expr:咬牙')
  a.equal(normTag('Negative'), 'negative')
  a.equal(normTag('angle:'), '')
  a.deepEqual(normTags('angle:正, angle:正面 ,expr:笑'), ['angle:正', 'expr:笑'], 'duplicates after normalising collapse')
  a.equal(normTags(Array(100).fill(0).map((_, i) => `t${i}`)).length, 40)

  const A = (id, ...tags) => ({ id, tags })
  const pool = [
    A('front-neutral', 'angle:正', 'expr:平静', 'light:白天'),
    A('front-grit', 'angle:正', 'expr:咬牙', 'light:黄昏'),
    A('side-grit', 'angle:侧', 'expr:咬牙', 'light:黄昏'),
    A('tq-calm', 'angle:3-4', 'expr:平静', 'light:白天'),
  ]

  // Exact match wins, nothing relaxed.
  let r = matchRefs(pool, { angle: '正面', expr: '咬牙', light: '黄昏' })
  a.deepEqual(r.matches.map(x => x.id), ['front-grit'])
  a.deepEqual(r.relaxed, [])

  // No 3/4 with gritted teeth at dusk: light goes first, then expression — and it says so.
  r = matchRefs(pool, { angle: '3/4', expr: '咬牙', light: '黄昏', shot: '中景' })
  a.deepEqual(r.matches.map(x => x.id), ['tq-calm'])
  a.deepEqual(r.relaxed, ['shot', 'light', 'expr'])

  // Angle is never relaxed: no back view → nothing, not a front view pretending.
  r = matchRefs(pool, { angle: '背', expr: '咬牙' })
  a.deepEqual(r.matches, [])

  // No filters → everything.
  a.equal(matchRefs(pool, {}).matches.length, 4)

  console.log('refs.mjs: all checks passed')
}
