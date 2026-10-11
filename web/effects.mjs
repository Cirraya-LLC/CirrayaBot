// Calls that change something outside — run a command, click in a page, send a request that writes,
// hand a file over, start a task — must not happen twice because the server restarted in the middle of
// a turn. The turn is picked up again from its last saved step (2.36.6), and a call that had already
// run (or was running) when the process died is very likely to be made again.
//
// So such a call is logged before it runs and when it finishes, per run (a front turn or a task run).
// A run that ends normally clears its log; only an interrupted one leaves entries. When the resumed run
// makes the exact same call, the log answers instead: its result if it finished, "outcome unknown —
// check first" if it never did. Asked again after that, it runs. Pure: server.mjs keeps the log.
// `node web/effects.mjs` is the self-test.
import { createHash } from 'node:crypto'
import { toolSubject } from './approve.mjs'

const READ_ACTIONS = new Set(['open', 'read', 'screenshot', 'back', 'scroll', 'reload'])

/** Does this call change something outside? Reading — a file, a page, a GET — is safe to repeat. */
export function hasEffect(name, args = {}) {
  switch (name) {
    case 'bash': case 'send_file': case 'start_task': case 'answer_task': case 'cancel_task': return true
    case 'browser': return !READ_ACTIONS.has(String(args.action ?? ''))
    case 'http_request': return !['GET', 'HEAD', 'OPTIONS'].includes(String(args.method || 'GET').toUpperCase())
    default: return false   // write_file and install_packages give the same result run twice; the rest read or talk
  }
}

/** The same call: same tool, same arguments, whatever order the model wrote the keys in. */
export function callKey(name, args = {}) {
  const stable = v => Array.isArray(v) ? v.map(stable)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])])) : v
  return createHash('sha256').update(`${name}\n${JSON.stringify(stable(args))}`).digest('hex')
}

/** What the agent is told instead of running a call the log already has (`prior` from before the restart). */
export function answerFromLog(name, args, prior) {
  const what = toolSubject(name, args)
  return prior.status === 'done'
    ? `[Platform] This exact call (${what}) already ran before the server restarted, so it was not run again. What it returned then:\n${prior.result ?? ''}`
    : `[Platform] This exact call (${what}) was started before the server restarted and may or may not have finished. ` +
      'It was not run again. Check whether it took effect before trying it again — if you then make the same call, it will run.'
}

// ---------- self-test ----------
if (import.meta.url === `file://${process.argv[1]}`) {
  const { strict: a } = await import('node:assert')
  a.ok(hasEffect('bash', { command: 'ls' }), 'a command can do anything')
  a.ok(!hasEffect('read_file', { path: '/work/x' }))
  a.ok(!hasEffect('http_request', { url: 'https://x', method: 'get' }) && hasEffect('http_request', { url: 'https://x', method: 'POST' }))
  a.ok(!hasEffect('browser', { action: 'read' }) && hasEffect('browser', { action: 'click', index: 2 }))
  a.ok(hasEffect('start_task', {}) && !hasEffect('list_tasks', {}) && !hasEffect('write_file', { path: 'a', content: 'b' }))
  a.equal(callKey('bash', { command: 'ls', timeout: 5 }), callKey('bash', { timeout: 5, command: 'ls' }), 'key order does not matter')
  a.notEqual(callKey('bash', { command: 'ls' }), callKey('bash', { command: 'ls -a' }))
  a.match(answerFromLog('bash', { command: 'git push' }, { status: 'done', result: 'pushed' }), /git push\) already ran[\s\S]*pushed/)
  a.match(answerFromLog('http_request', { method: 'POST', url: 'https://api.x/charge' }, { status: 'started' }),
    /POST https:\/\/api.x\/charge.*may or may not have finished/)
  console.log('effects: all checks pass')
}
