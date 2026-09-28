// How far an agent goes on its own. Pure, so the rules can be checked without a model:
//   node web/autonomy.mjs
//
// "manual" is how this product started: a dozen tool calls per turn, a short relay, and the
// person pushes it on with "continue". "auto" is what people asked for instead — the Claude Code
// / Codex way of working: take the task to done, keep a plan, don't stop to ask whether to go on,
// and keep going when the page is closed. The approval gate (approve.mjs) and the daily spending
// cap apply in both; auto mode changes how long an agent keeps going, not what it is allowed to do.

export const AUTONOMY_MODES = ['auto', 'manual']

/** '' = not set here (follow the next level up). Anything unknown is treated as not set. */
export const normAutonomy = v => AUTONOMY_MODES.includes(String(v ?? '').trim()) ? String(v).trim() : ''

/** The agent's own setting wins, then the platform's; a platform never set means auto. */
export const resolveAutonomy = (own, platform) => normAutonomy(own) || normAutonomy(platform) || 'auto'

// steps     model calls in one agent's turn. In auto mode this is a runaway guard, not a budget —
//           the daily cap is the budget.
// handoffs  handoffs in one group message.
// perPerson how many times the relay may come back to the same colleague.
// nudges    how many times an agent that stops with its plan unfinished is sent back to it.
const LIMITS = {
  manual: { steps: 12, handoffs: 5, perPerson: 2, nudges: 0 },
  auto: { steps: 150, handoffs: 40, perPerson: 12, nudges: 3 },
}
export const limitsFor = mode => LIMITS[mode === 'manual' ? 'manual' : 'auto']

// ---------- the plan ----------
// An agent in auto mode writes down its steps (update_plan) and ticks them off. It is the only
// reliable way to tell "I'm done" from "I stopped": a model that ends its turn with steps still
// open is sent back to them, a few times at most.

export const PLAN_STATUSES = ['pending', 'in_progress', 'completed', 'blocked']
const MAX_PLAN = 30

/** Validate what the model sent. Returns the plan, or a string saying what is wrong with it. */
export function checkPlan(raw) {
  if (!Array.isArray(raw) || !raw.length) return 'plan must be a non-empty list of {step, status}'
  if (raw.length > MAX_PLAN) return `at most ${MAX_PLAN} steps — group smaller ones together`
  const out = []
  for (const [i, x] of raw.entries()) {
    const step = String(x?.step ?? '').replace(/\s+/g, ' ').trim()
    const status = String(x?.status ?? 'pending').trim()
    if (!step) return `step ${i + 1} has no text`
    if (!PLAN_STATUSES.includes(status)) return `step ${i + 1}: status must be one of ${PLAN_STATUSES.join(' / ')}`
    out.push({ step: step.slice(0, 200), status })
  }
  if (out.filter(x => x.status === 'in_progress').length > 1) return 'only one step can be in_progress at a time'
  return out
}

const MARK = { pending: '[ ]', in_progress: '[>]', completed: '[x]', blocked: '[!]' }
export const planText = plan => plan.map(x => `${MARK[x.status]} ${x.step}`).join('\n')

/** Steps still to do. A blocked step is not "to do" — the agent said why it can't. */
export const openSteps = plan => (plan ?? []).filter(x => x.status === 'pending' || x.status === 'in_progress')

/**
 * The agent ended its turn. Should it be sent back to work? Returns the message to send, or null.
 * Only in auto mode, only with a plan, only while the nudge budget lasts.
 */
export function nudgeFor(plan, used, limits) {
  const open = openSteps(plan)
  if (!open.length || used >= limits.nudges) return null
  return `[Platform] You ended your turn, but your plan still has ${open.length} open step${open.length > 1 ? 's' : ''}:\n` +
    open.map(x => `${MARK[x.status]} ${x.step}`).join('\n') +
    '\nNobody is going to tell you to continue — keep working on them now. If a step turns out to be unnecessary, ' +
    'mark it completed and say so; if you truly cannot do it without the user, mark it blocked and say exactly what you need.'
}

// ---------- the group relay ----------

/**
 * Who speaks next after `speaker` replied. An @ always wins. With nobody @-ed, a manual group
 * stops; an auto group hands the reply back to its coordinator, who decides what comes next —
 * the coordinator not @-ing anyone is what ends it.
 */
export function nextSpeaker({ mention, speaker, coordinator, auto }) {
  if (mention) return { bot: mention, auto: false }
  if (auto && coordinator && coordinator.id !== speaker.id) return { bot: coordinator, auto: true }
  return null
}

// ---------- self-test ----------
if (import.meta.url === `file://${process.argv[1]}`) {
  const assert = (await import('node:assert/strict')).default
  assert.equal(resolveAutonomy('', ''), 'auto')
  assert.equal(resolveAutonomy('', 'manual'), 'manual')
  assert.equal(resolveAutonomy('auto', 'manual'), 'auto')
  assert.equal(resolveAutonomy('nonsense', 'manual'), 'manual')
  assert.equal(limitsFor('manual').steps, 12)
  assert.equal(limitsFor('whatever').steps, 150)

  assert.match(checkPlan([]), /non-empty/)
  assert.match(checkPlan([{ step: 'a', status: 'done' }]), /status/)
  assert.match(checkPlan([{ step: 'a', status: 'in_progress' }, { step: 'b', status: 'in_progress' }]), /one step/)
  const plan = checkPlan([{ step: ' write   it ', status: 'completed' }, { step: 'test it', status: 'in_progress' },
    { step: 'ask for the key', status: 'blocked' }, { step: 'ship' }])
  assert.equal(plan[0].step, 'write it')
  assert.equal(plan[3].status, 'pending')
  assert.equal(planText(plan), '[x] write it\n[>] test it\n[!] ask for the key\n[ ] ship')
  assert.equal(openSteps(plan).length, 2, 'blocked and completed steps are not open')

  const auto = limitsFor('auto'), manual = limitsFor('manual')
  assert.match(nudgeFor(plan, 0, auto), /2 open steps/)
  assert.equal(nudgeFor(plan, 3, auto), null, 'the nudge budget runs out')
  assert.equal(nudgeFor(plan, 0, manual), null, 'manual mode never nudges')
  assert.equal(nudgeFor(null, 0, auto), null, 'no plan, nothing to hold it to')
  assert.equal(nudgeFor(checkPlan([{ step: 'x', status: 'completed' }]), 0, auto), null)

  const a = { id: 'a' }, b = { id: 'b' }, lead = { id: 'lead' }
  assert.deepEqual(nextSpeaker({ mention: b, speaker: a, coordinator: lead, auto: true }), { bot: b, auto: false })
  assert.deepEqual(nextSpeaker({ mention: null, speaker: a, coordinator: lead, auto: true }), { bot: lead, auto: true })
  assert.equal(nextSpeaker({ mention: null, speaker: lead, coordinator: lead, auto: true }), null, 'the coordinator ends it')
  assert.equal(nextSpeaker({ mention: null, speaker: a, coordinator: lead, auto: false }), null, 'manual stops on no @')
  console.log('autonomy: all checks pass')
}
