// Background tasks: the rules, kept pure so they can be checked without a model or a database:
//   node web/tasks.mjs
//
// A conversation is the front thread: it talks to the person and never blocks on work. Anything that
// takes a while goes out as a task, run by an agent on its own (in a group, by whichever member it was
// given to). Tasks of different agents run side by side; one agent's tasks run one after another, since
// they share that agent's machine. A task that needs something only the person can give stops with a
// question; the person's answer — typed into the card, or passed on by the front thread — resumes it.
// When a task finishes, fails or asks, the front thread hears about it and takes a turn to tell the person.

export const TASK_STATUSES = ['queued', 'running', 'waiting', 'done', 'failed', 'stopped']
export const OPEN = ['queued', 'running', 'waiting']
export const isOpen = t => OPEN.includes(t?.status)

export const MAX_OPEN_PER_CONVERSATION = 8     // queued + running + waiting at once
export const MAX_PER_SESSION = 40              // ever, in one session — a front thread that keeps spawning is looping
export const TITLE_MAX = 120
export const BRIEF_MAX = 4000
export const QUESTION_MAX = 2000
export const RESULT_MAX = 12_000

const oneLine = s => String(s ?? '').replace(/\s+/g, ' ').trim()

/** What start_task was given. Returns {title, brief} or a sentence saying what's wrong. */
export function checkTaskInput(args) {
  const title = oneLine(args?.title)
  const brief = String(args?.brief ?? '').trim()
  if (!title) return 'title is required: a few words saying what the task is'
  if (title.length > TITLE_MAX) return `title is too long (at most ${TITLE_MAX} characters) — put the details in brief`
  if (brief.length > BRIEF_MAX) return `brief is too long (at most ${BRIEF_MAX} characters)`
  return { title, brief }
}

/** Find the member a task is for, by name (case-insensitive). Empty = the caller itself. */
export function pickAssignee(name, me, members) {
  const n = oneLine(name).replace(/^@/, '').toLowerCase()
  if (!n || n === me.name.toLowerCase() || n === 'me' || n === 'myself') return me
  return members.find(b => b.name.toLowerCase() === n) ?? null
}

/** The first thing the task's own conversation says. */
export function taskOpening(t, byName) {
  return `[Platform] Background task #${t.id}${byName ? `, handed to you by ${byName}` : ''}: ${t.title}` +
    (t.brief ? `\n\n${t.brief}` : '')
}

/** How a task event reads to the front thread's model. These are the only way it learns what happened. */
export function eventForModel(e) {
  if (e.kind === 'call') return e.phase === 'start'
    ? '[Platform] A voice call started: what follows was said aloud, and your replies were read aloud.'
    : `[Platform] The voice call ended${e.title ? ` ("${e.title}")` : ''}.`
  const who = `Background task #${e.task}${e.agent ? ` (${e.agent})` : ''} "${e.title ?? ''}"`
  switch (e.kind) {
    case 'asked': return `[Platform] ${who} is waiting for the user: ${e.text}\n` +
      'Tell the user in your own words what it needs. When they answer, pass it on with answer_task.'
    case 'done': return `[Platform] ${who} finished. Its report:\n${e.text}` +
      (e.files?.length ? `\nIt sent the user ${e.files.length === 1 ? 'a file' : `${e.files.length} files`}: ${e.files.map(f => f.name).join(', ')}.` : '')
    case 'failed': return `[Platform] ${who} failed: ${e.text}`
    case 'stopped': return `[Platform] ${who} was stopped${e.by ? ` by ${e.by}` : ' by the user'}.`
    // The answer itself isn't here on purpose: it went straight to the task, and may be a password.
    case 'answered': return `[Platform] The user answered ${who} directly; the answer went to the task.`
    case 'approval': return `[Platform] ${who} is waiting for the user to approve: ${e.text}`
    default: return `[Platform] ${who}: ${e.text ?? e.kind}`
  }
}

/** Which events give the front thread a turn of its own. An answer or a stop came from the person — nothing to report. */
export const wakes = kind => kind === 'asked' || kind === 'done' || kind === 'failed'

const STATUS_WORD = { queued: 'queued', running: 'working', waiting: 'waiting for the user', done: 'done',
  failed: 'failed', stopped: 'stopped' }

/** One line per task, for list_tasks and for the front thread's system prompt. */
export function taskLine(t, nameOf = id => id) {
  const extra = t.status === 'waiting' ? (t.question ? ` — asks: ${oneLine(t.question).slice(0, 200)}`
    : t.approval ? ' — waiting for approval' : '') : ''
  return `#${t.id} ${nameOf(t.agent_id)} · ${STATUS_WORD[t.status] ?? t.status} · ${t.title}${extra}`
}

/** The front thread's section on tasks. `open` = the conversation's unfinished tasks. */
export function frontSection({ group, open = [], nameOf }) {
  return `

--- Background tasks ---
You are the front of this conversation: you talk to the person, and you stay free to talk.
Work that will take more than a minute or two — building, installing, researching, anything with many commands —
goes out as a background task with start_task${group ? ' (for yourself or a colleague; colleagues work in parallel)' : ' (it is you, working in the background)'}.
A task runs on its own with the same machine and tools, and reports back here when it finishes, fails, or needs
something only the user can give. Quick things — one command, a quick look — just do yourself.
- When a task asks something, tell the user in plain words; when they answer, forward it with answer_task.
- When a task reports back, check the result before you tell the user it's done.
- Don't wait or poll for a task: end your turn; you'll be told when it reports back. list_tasks shows where things stand; cancel_task stops one.
${open.length ? `Open tasks in this conversation right now:\n${open.map(t => '- ' + taskLine(t, nameOf)).join('\n')}` : 'No tasks are open in this conversation right now.'}`
}

/** The task's own section: replaces "how you work" for the agent running it. */
export function taskSection({ t, byName, groupDir, helper = false }) {
  return `

--- You are working on a background task ---
Task #${t.id}${byName ? `, from ${byName}` : ''}: ${t.title}
Nobody is watching this run, and nobody will tell you to continue. Take it all the way to done.
- Anything with more than a couple of steps: write a plan with update_plan first and keep it current.
- Check your own work — run it, test it, look at the result. "It should work" is not done.
- For routine choices, make a sensible assumption and say so in your report instead of asking.
- When you need something only the user can give (a password, a login, a decision about what they want),
  call ask_user with one clear question. Your work pauses there; their answer comes back as the next message.
- When you're done, call finish_task with your report: what you did, where the results are, what the user should check.
  If you can't do it, call finish_task saying exactly why.
- If a command is refused, don't retry it: find another way, or explain in your report.${groupDir ? `
- The group's shared drive is ${groupDir} — put what colleagues or the user should get there.` : ''}${helper ? `

--- A machine of your own for this task ---
This task runs on a fresh machine, beside your other work, not on your usual one.
- /work here is a scratch folder for this task only. Your usual desk is at /desk, read-only: read what you need from it.
- Put what you hand back in /work/out: when the task is done it is copied to /work/helpers/${t.id} on your usual
  machine. Everything else here — other files, what you installed — is thrown away with this machine.
- If you ask the user something, this machine is rebuilt when you carry on: files in /work stay, installed packages don't.` : ''}`
}

/** A tool result or event text, cut to fit. */
export const clipText = (s, n) => { const t = String(s ?? ''); return t.length > n ? t.slice(0, n) + '…' : t }

// ---------- self-test ----------
// ---------- Check-ins ----------
// An agent working on its own, every so often, toward goals the person wrote. It runs as a background
// task, but read-only: anything that changes something outside (a command, a click, a write) is refused
// — it proposes such things in its report instead. And it speaks only when there is something new.

/** How often, in minutes. 0 = never. */
export const CHECKIN_EVERY = [0, 60, 240, 720, 1440]
export const GOALS_MAX = 4000
export const NOTHING_NEW = 'NOTHING_NEW'
/** The report says there is nothing worth the person's attention. */
export const isNothingNew = r => !String(r ?? '').trim() || /^\W*nothing[_ ]new\W*$/i.test(String(r).trim())

/** What a check-in is asked to do. `reports`: the last few it sent, oldest first, so it doesn't repeat them. */
export function checkinBrief(goals, reports = [], now = new Date()) {
  const past = reports.length
    ? `\n\nWhat you reported at your last check-ins (don't repeat it; follow it up if there is news):\n` +
      reports.map(r => `--- ${r.at ? new Date(r.at).toISOString().slice(0, 16).replace('T', ' ') : ''}\n${clipText(r.text, 1500)}`).join('\n')
    : ''
  return `It is ${now.toISOString().slice(0, 16).replace('T', ' ')} UTC. This is one of your regular check-ins: nobody asked for it ` +
    `just now. Work toward the goals the user gave you, below — find out what changed, what needs attention, what is ` +
    `coming up — and report.\n\nThe user's goals for you:\n${goals}${past}\n\n` +
    `Rules for a check-in:\n` +
    `- Read-only. Look things up (files, web pages, APIs with GET) but change nothing: commands, clicks, writes and ` +
    `requests that change something are refused. If something should be done, propose it in your report — the user ` +
    `can ask you to do it.\n` +
    `- Report only what is new and worth the user's attention, short and concrete. If there is nothing, finish with ` +
    `exactly ${NOTHING_NEW} as the result: then nothing is sent and nobody is disturbed.\n` +
    `- Finish with finish_task. You cannot ask the user anything during a check-in.`
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const assert = (await import('node:assert/strict')).default
  assert.match(checkTaskInput({}), /title is required/)
  assert.match(checkTaskInput({ title: 'x'.repeat(121) }), /too long/)
  assert.deepEqual(checkTaskInput({ title: '  build   the site ', brief: ' do it ' }), { title: 'build the site', brief: 'do it' })

  const me = { id: 'chief', name: 'Chief of Staff' }, r = { id: 'r', name: 'Researcher' }, l = { id: 'l', name: '小林' }
  assert.equal(pickAssignee('', me, [r, l]), me)
  assert.equal(pickAssignee('@researcher', me, [r, l]), r)
  assert.equal(pickAssignee('小林', me, [r, l]), l)
  assert.equal(pickAssignee('nobody', me, [r, l]), null)

  assert.match(eventForModel({ kind: 'asked', task: 3, agent: 'Researcher', title: 't', text: 'which repo?' }), /answer_task/)
  assert.match(eventForModel({ kind: 'done', task: 3, title: 't', text: 'ok' }), /finished/)
  assert.match(eventForModel({ kind: 'done', task: 3, title: 't', text: 'ok', files: [{ name: 'a.pdf' }] }), /sent the user a file: a\.pdf/)
  assert.ok(wakes('done') && wakes('asked') && wakes('failed'))
  assert.ok(!wakes('answered') && !wakes('stopped') && !wakes('approval'))

  assert.equal(taskLine({ id: 4, agent_id: 'r', status: 'waiting', question: 'key?', title: 'deploy' }, () => 'Researcher'),
    '#4 Researcher · waiting for the user · deploy — asks: key?')
  assert.match(frontSection({ group: true, open: [], nameOf: x => x }), /colleagues work in parallel/)
  assert.match(frontSection({ group: false, open: [{ id: 1, agent_id: 'a', status: 'running', title: 'x' }], nameOf: x => x }), /#1 a · working · x/)
  assert.match(taskSection({ t: { id: 2, title: 'x' }, groupDir: '/groups/g1' }), /\/groups\/g1/)
  assert.ok(isOpen({ status: 'waiting' }) && !isOpen({ status: 'done' }))
  // Check-ins
  assert.ok(isNothingNew('NOTHING_NEW') && isNothingNew('  nothing new. ') && isNothingNew('') && !isNothingNew('The build is red.'))
  const brief = checkinBrief('Watch the build', [{ at: 0, text: 'The build was red.' }], new Date(Date.UTC(2026, 10, 5, 9, 30)))
  assert.match(brief, /2026-11-05 09:30 UTC/)
  assert.match(brief, /Watch the build/)
  assert.match(brief, /The build was red\./)
  assert.match(brief, /Read-only/)
  assert.ok(CHECKIN_EVERY.includes(0) && CHECKIN_EVERY.includes(1440))
  console.log('tasks: all checks pass')
}
