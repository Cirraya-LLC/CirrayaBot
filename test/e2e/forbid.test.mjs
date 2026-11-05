// "Never allowed": a rule the person sets is refused without asking anyone, whatever the approval
// mode — in a conversation, in a background task, in a scheduled task.
import { test, before, after } from 'node:test'
import { strict as a } from 'node:assert'
import { startStack } from './stack.mjs'
import { fakeUpstream } from './fake-upstream.mjs'

let s, up
before(async () => { up = await fakeUpstream(); s = await startStack({ tools: true }) })
after(async () => { await s?.close(); await up?.close() })

const NEVER = String.raw`\bterraform\s+destroy\b`
async function runCommand(agent, command) {
  up.on(r => r.toolResults.length ? { text: `result: ${r.toolResults[0].slice(0, 120)}` } : { tool: ['bash', { command }] })
  let asked = false
  const r = await s.chat({ agent }, `run ${command}`, {
    onEvent: (ev, d) => { if (ev === 'tool' && d.phase === 'ask') { asked = true; return s.api('POST', `/api/approvals/${d.id}`, { ok: true }) } } })
  return { asked, text: r.text }
}

test('a never-allowed command is refused without a card, even with approvals off', async () => {
  const pol = (await s.api('GET', '/api/approvals/policy')).body
  a.deepEqual(pol.forbid, [], 'none to begin with')
  a.equal((await s.api('PUT', '/api/approvals/policy', { mode: 'off', patterns: pol.patterns, forbid: [NEVER, ''] })).status, 200)
  a.deepEqual((await s.api('GET', '/api/approvals/policy')).body.forbid, [NEVER], 'blank lines dropped')

  const kim = await s.agent(up, { name: 'Kim' })
  const bad = await runCommand(kim, 'terraform destroy -auto-approve')
  a.equal(bad.asked, false, 'nobody asked')
  a.match(bad.text, /Refused by a rule the user set \(never allowed/)
  a.doesNotMatch(bad.text, /ran: terraform/)
  a.match((await runCommand(kim, 'terraform plan')).text, /ran: terraform plan/, 'everything else runs as before')

  // Even an agent set to ask about everything is never asked about this one.
  const ned = await s.agent(up, { name: 'Ned', approval: 'all' })
  const r = await runCommand(ned, 'terraform destroy')
  a.equal(r.asked, false)
  a.match(r.text, /never allowed/)
})

test('an older client that saves the policy without the list keeps it', async () => {
  await s.api('PUT', '/api/approvals/policy', { mode: 'match', patterns: [], forbid: [NEVER] })
  a.equal((await s.api('PUT', '/api/approvals/policy', { mode: 'all', patterns: [] })).status, 200)
  const pol = (await s.api('GET', '/api/approvals/policy')).body
  a.equal(pol.mode, 'all')
  a.deepEqual(pol.forbid, [NEVER])
  await s.api('PUT', '/api/approvals/policy', { mode: 'match', patterns: pol.patterns, forbid: [NEVER] })
})

test('a scheduled task is refused it too', async () => {
  const oz = await s.agent(up, { name: 'Oz' })
  up.on(r => r.toolResults.length ? { text: `result: ${r.toolResults[0].slice(0, 120)}` } : { tool: ['bash', { command: 'terraform destroy' }] })
  const made = await s.api('POST', '/api/routines', { name: 'nightly', prompt: 'tear it down', target_kind: 'agent', target_id: oz,
    kind: 'interval', every_minutes: 60, tz: 'UTC' })
  a.equal((await s.api('POST', `/api/routines/${made.body.id}/run`)).status, 202)
  const done = await s.until(async () => {
    const r = (await s.api('GET', '/api/routines')).body.find(x => x.id === made.body.id)
    return r && !r.running && r.last_status && r
  }, { what: 'the routine to finish' })
  const last = (await s.history(oz, done.session_id)).filter(m => m.role === 'assistant').at(-1)?.content ?? ''
  a.match(last, /never allowed/)
})
