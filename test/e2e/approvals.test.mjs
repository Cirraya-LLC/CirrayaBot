// "Always allow": a person can say yes once for good — narrowly (this agent, this kind of risky
// command), visibly (listed in the settings), and revocably.
import { test, before, after } from 'node:test'
import { strict as a } from 'node:assert'
import { startStack } from './stack.mjs'
import { fakeUpstream } from './fake-upstream.mjs'

let s, up
before(async () => { up = await fakeUpstream(); s = await startStack({ tools: true }) })
after(async () => { await s?.close(); await up?.close() })

const PUSH = String.raw`\bgit\s+push\b`
/** One turn that runs `command`; answers its card (if any) with `answer`. Resolves to {asked, ask, text}. */
async function runCommand(agent, command, answer = { ok: true }) {
  up.on(r => r.toolResults.length ? { text: `result: ${r.toolResults[0].slice(0, 80)}` } : { tool: ['bash', { command }] })
  let ask = null
  const r = await s.chat({ agent }, `run ${command}`, {
    onEvent: (ev, d) => { if (ev === 'tool' && d.phase === 'ask') { ask = d; return s.api('POST', `/api/approvals/${d.id}`, answer) } } })
  return { asked: !!ask, ask, text: r.text }
}

test('"always allow" covers this agent and this kind of command, and nothing more', async () => {
  const kim = await s.agent(up, { name: 'Kim' }), lee = await s.agent(up, { name: 'Lee' })
  const first = await runCommand(kim, 'git push origin main', { ok: true, always: true })
  a.ok(first.asked)
  a.deepEqual(first.ask.always, [PUSH], 'the card says what "always" would cover')
  a.match(first.text, /ran: git push origin main/)

  const again = await runCommand(kim, 'git push --tags')
  a.equal(again.asked, false, 'not asked again for the same kind of command')
  a.match(again.text, /ran: git push --tags/)

  a.equal((await runCommand(kim, 'sudo whoami')).asked, true, 'another risky pattern still asks')
  a.equal((await runCommand(lee, 'git push origin main')).asked, true, 'another agent still asks')

  const pol = (await s.api('GET', '/api/approvals/policy')).body
  const mine = pol.allow.filter(r => r.agent === kim)
  a.equal(mine.length, 1)
  a.deepEqual([mine[0].agent_name, mine[0].tool, mine[0].pattern, mine[0].example], ['Kim', 'bash', PUSH, 'git push origin main'])

  // Taken back: asked again.
  a.equal((await s.api('DELETE', `/api/approvals/allow/${mine[0].id}`)).status, 200)
  a.equal((await s.api('DELETE', `/api/approvals/allow/${mine[0].id}`)).status, 404)
  a.equal((await runCommand(kim, 'git push origin main')).asked, true)
})

test('a "no" is never remembered, and "always" with a no is just a no', async () => {
  const max = await s.agent(up, { name: 'Max' })
  const r = await runCommand(max, 'git push', { ok: false, always: true })
  a.match(r.text, /Refused by the user/)
  a.equal((await s.api('GET', '/api/approvals/policy')).body.allow.filter(x => x.agent === max).length, 0)
  a.equal((await runCommand(max, 'git push')).asked, true)
})

test('in "ask for everything" mode, "always" covers the tool but a risky command still asks', async () => {
  const ned = await s.agent(up, { name: 'Ned', approval: 'all' })
  const first = await runCommand(ned, 'ls -la', { ok: true, always: true })
  a.deepEqual(first.ask.always, [''], 'the whole tool')
  a.equal((await runCommand(ned, 'cat notes.txt')).asked, false)
  a.equal((await runCommand(ned, 'rm -rf build')).asked, true, 'risky still asks')
})

test('a scheduled task runs what was allowed, and is still refused what was not', async () => {
  const oz = await s.agent(up, { name: 'Oz' })
  await runCommand(oz, 'git push origin main', { ok: true, always: true })
  const routine = async command => {
    up.on(r => r.toolResults.length ? { text: `result: ${r.toolResults[0].slice(0, 80)}` } : { tool: ['bash', { command }] })
    const made = await s.api('POST', '/api/routines', { name: `do ${command}`, prompt: command, target_kind: 'agent', target_id: oz,
      kind: 'interval', every_minutes: 60, tz: 'UTC' })
    a.equal(made.status, 200, JSON.stringify(made.body))
    a.equal((await s.api('POST', `/api/routines/${made.body.id}/run`)).status, 202)
    const done = await s.until(async () => {
      const r = (await s.api('GET', '/api/routines')).body.find(x => x.id === made.body.id)
      return r && !r.running && r.last_status && r
    }, { what: 'the routine to finish' })
    const rows = await s.history(oz, done.session_id)
    return rows.filter(m => m.role === 'assistant').at(-1)?.content ?? ''
  }
  a.match(await routine('git push origin main'), /ran: git push origin main/)
  a.match(await routine('sudo reboot'), /Refused \(this ran as a scheduled task/)
})

test('deleting an agent takes its allowances with it', async () => {
  const pat = await s.agent(up, { name: 'Pat' })
  await runCommand(pat, 'git push', { ok: true, always: true })
  a.equal((await s.api('DELETE', `/api/bots/${pat}`)).status, 200)
  a.equal((await s.api('GET', '/api/approvals/policy')).body.allow.filter(x => x.agent === pat).length, 0)
})
