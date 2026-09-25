// The shot state machine. Pure: given a shot's status and an action, is the move legal and
// where does it land. The database layer asks this before every write, so "approve a shot
// nobody generated" or "regenerate a locked scene" can't happen by any route.
//
//   planned ──prompt──▶ prompted ──gen──▶ generating ──(worker: ≥1 candidate)──▶ review
//      ▲                   ▲  ▲                 │ (worker: every take failed)          │
//      │                   │  └─────────────────┘                                     │
//      │                   └──prompt── rejected ◀──reject──────────────────────────────┤
//      └──replan── rejected / prompted / planned              approve ──▶ approved ──(scene lock)──▶ locked
//
// Drawing more cards is allowed from review and rejected (gen), but a new prompt version is
// what the shot-prompting skill asks for after a rejection — gen reuses the latest prompt.
//
// Self-test: node studio/shots.mjs

export const STATUSES = ['planned', 'prompted', 'generating', 'review', 'approved', 'rejected', 'locked']

// action → statuses it may start from, and where it goes. `null` target = unchanged.
const MOVES = {
  replan:  { from: ['planned', 'prompted', 'rejected'], to: 'planned' },
  prompt:  { from: ['planned', 'prompted', 'rejected', 'review'], to: 'prompted' },
  gen:     { from: ['prompted', 'rejected', 'review'], to: 'generating' },
  done_ok: { from: ['generating'], to: 'review' },        // the worker: this round produced candidates
  done_no: { from: ['generating'], to: 'prompted' },      // the worker: every take in the round failed
  sheet:   { from: ['review', 'approved', 'rejected', 'locked'], to: null },
  approve: { from: ['review'], to: 'approved' },
  // A person may approve a take the crew rejected (the 3rd rejection lands on them, and the best
  // take is sometimes an earlier one). Only actions.mjs's human path uses it.
  override: { from: ['review', 'rejected'], to: 'approved' },
  reject:  { from: ['review'], to: 'rejected' },
  lock:    { from: ['approved'], to: 'locked' },
}

/** Returns {to} when legal, otherwise {error} with a sentence an agent can act on. */
export function move(status, action) {
  const m = MOVES[action]
  if (!m) return { error: `unknown shot action ${action}` }
  if (m.from.includes(status)) return { to: m.to ?? status }
  return { error: WHY[action]?.(status) ?? `can't ${action} a shot that is ${status}` }
}

const WHY = {
  replan: s => s === 'locked' ? 'the scene is locked; a person has to unlock it first'
    : `the shot is ${s}; only a shot that is planned, prompted or rejected can be redefined`,
  prompt: s => s === 'generating' ? 'takes are still generating for this shot; wait for them to finish'
    : `the shot is ${s}; it can't take a new prompt`,
  gen: s => s === 'planned' ? 'save a prompt first (shot.prompt)'
    : s === 'generating' ? 'this shot is already generating; you will be told when the takes are ready — do not poll'
    : `the shot is ${s}; nothing to generate`,
  sheet: s => `there are no candidates to compare yet (the shot is ${s})`,
  approve: s => `only a shot in review can be approved (this one is ${s})`,
  reject: s => `only a shot in review can be rejected (this one is ${s})`,
  lock: s => `a scene can only be locked when every shot is approved (one is ${s})`,
}

// After this many rejections a shot stops routing to the crew and goes to a person.
export const REJECTS_TO_HUMAN = 3

/** Where a rejection goes: the route's owner, or a person once the count reaches the limit. */
export function rejectTarget(attempt, route) {
  if (attempt >= REJECTS_TO_HUMAN) return 'human'
  return { prompt: 'cinematographer', asset: 'art', plan: 'director' }[route] ?? null
}

// ---------- self-test ----------
if (import.meta.url === `file://${process.argv[1]}`) {
  const a = await import('node:assert/strict')

  // The happy path, one step at a time.
  let s = 'planned'
  for (const [act, want] of [['prompt', 'prompted'], ['gen', 'generating'], ['done_ok', 'review'],
    ['sheet', 'review'], ['approve', 'approved'], ['lock', 'locked']]) {
    const r = move(s, act)
    a.equal(r.to, want, `${s} --${act}--> ${want}`)
    s = r.to
  }

  // The rejection loop: reject → new prompt → gen again; or straight to drawing more cards.
  a.equal(move('review', 'reject').to, 'rejected')
  a.equal(move('rejected', 'prompt').to, 'prompted')
  a.equal(move('rejected', 'gen').to, 'generating')
  a.equal(move('review', 'gen').to, 'generating', 'more cards from review')
  a.equal(move('generating', 'done_no').to, 'prompted', 'all takes failed → back to prompted')

  // What must never happen.
  a.match(move('planned', 'gen').error, /save a prompt first/)
  a.match(move('generating', 'gen').error, /already generating.*do not poll/)
  a.match(move('generating', 'prompt').error, /still generating/)
  a.match(move('prompted', 'approve').error, /only a shot in review/)
  a.match(move('approved', 'reject').error, /only a shot in review/)
  a.match(move('review', 'lock').error, /every shot is approved/)
  a.match(move('locked', 'replan').error, /locked/)
  a.ok(move('locked', 'gen').error, 'a locked shot never regenerates')
  a.ok(move('approved', 'prompt').error, 'an approved shot takes no new prompt')
  a.ok(move('planned', 'sheet').error)
  a.match(move('review', 'dance').error, /unknown/)
  for (const st of STATUSES) for (const act of Object.keys(MOVES)) {
    const r = move(st, act)
    a.ok(('to' in r) !== ('error' in r), `${st}/${act} answers exactly one of to/error`)
    if (r.to) a.ok(STATUSES.includes(r.to))
  }

  // Routing a rejection: by route for the first two, to a person on the third.
  a.equal(rejectTarget(1, 'prompt'), 'cinematographer')
  a.equal(rejectTarget(2, 'asset'), 'art')
  a.equal(rejectTarget(1, 'plan'), 'director')
  a.equal(rejectTarget(3, 'prompt'), 'human')
  a.equal(rejectTarget(5, 'asset'), 'human')
  a.equal(rejectTarget(1, 'nonsense'), null)

  console.log('shots.mjs: all checks passed')
}
