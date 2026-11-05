// Isolation: an agent's machine runs under the strongest runtime the engine has (a Kata VM, then gVisor, then a
// plain container), steps down when one won't start, says so, and never goes below the floor. The fake docker
// reports runtimes from <log>.runtimes and fails the one named in <log>.fail-runtime.
import { test, after } from 'node:test'
import { strict as a } from 'node:assert'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { startStack } from './stack.mjs'
import { fakeUpstream } from './fake-upstream.mjs'

const up = await fakeUpstream()
const stacks = []
after(async () => { for (const s of stacks) await s.close(); await up.close() })

const KATA = { kata: { runtimeType: 'io.containerd.kata.v2' } }
const GVISOR = { runsc: { path: '/usr/local/bin/runsc', runtimeArgs: ['--overlay2=none'] } }
const GVISOR_IN_MEMORY = { runsc: { path: '/usr/local/bin/runsc' } }

/** A stack whose engine has these runtimes (and fails `fail`), with AGENT_RUNTIME* from env. */
async function stack(runtimes, { fail = null, env = {} } = {}) {
  const s = await startStack({ tools: true, env })
  stacks.push(s)
  const state = join(s.work, 'docker.log.containers')
  await writeFile(`${state}.runtimes`, JSON.stringify({ runc: { path: 'runc' }, ...runtimes }))
  if (fail) await writeFile(`${state}.fail-runtime`, fail)
  return s
}
const runs = async s => (await readFile(join(s.work, 'docker.log'), 'utf8').catch(() => '')).split('\n').filter(l => l.startsWith('run -d '))
/** One turn that runs a command, so the agent's machine is made. Returns the chat result. */
async function useMachine(s, name) {
  const bot = await s.agent(up, { name })
  up.on(r => r.toolResults.length ? { text: 'done' } : { tool: ['bash', { command: 'echo hi' }] })
  return { bot, r: await s.chat({ agent: bot }, 'say hi') }
}

test('auto takes the strongest: a Kata VM, with its own resolver file', async () => {
  const s = await stack({ ...KATA, ...GVISOR })
  await useMachine(s, 'Kim')
  const [run] = await runs(s)
  a.match(run, /--runtime kata /)
  a.match(run, /--label ma\.runtime=kata /)
  a.ok(run.includes(`-v ${join(s.work, '.agent-resolv.conf')}:/etc/resolv.conf:ro`), 'Docker\'s own DNS does not reach a VM')
  a.equal(await readFile(join(s.work, '.agent-resolv.conf'), 'utf8'), 'nameserver 8.8.8.8\nnameserver 1.1.1.1\n')
  const iso = (await s.api('GET', '/api/isolation')).body
  a.deepEqual([iso.mode, iso.using, iso.weaker, iso.available], ['auto', 'kata', false, ['kata', 'gvisor', 'runc']])
  a.equal((await s.api('GET', '/api/activity')).body.isolation.using, 'kata', 'the activity page says it too')
})

test('a VM that will not start steps down to gVisor, says why, and is not tried again', async () => {
  const s = await stack({ ...KATA, ...GVISOR }, { fail: 'kata' })
  await useMachine(s, 'Lee')
  await useMachine(s, 'Max')
  const all = await runs(s)
  a.equal(all.length, 3, 'kata once, then gVisor for both')
  a.match(all[0], /--runtime kata /)
  a.ok(all.slice(1).every(l => / --runtime runsc /.test(l) && l.includes('ma.runtime=gvisor')))
  const iso = (await s.api('GET', '/api/isolation', undefined, { 'x-lang': 'zh-Hans' })).body
  a.equal(iso.using, 'gvisor')
  a.ok(iso.problems.some(p => p.includes('kata 启动机器失败')), JSON.stringify(iso.problems))
  a.match(s.log(), /\[isolation\] kata would not start/)
})

test('gVisor keeping changes in memory is not used; a plain container is marked weaker and keeps Docker\'s DNS', async () => {
  const s = await stack(GVISOR_IN_MEMORY)
  await useMachine(s, 'Ivy')
  const [run] = await runs(s)
  a.ok(!run.includes('--runtime') && !run.includes('/etc/resolv.conf') && run.includes('ma.runtime=runc'))
  const iso = (await s.api('GET', '/api/isolation')).body
  a.deepEqual([iso.using, iso.weaker], ['runc', true])
  a.ok(iso.problems.some(p => p.includes('--overlay2=none')))
})

test('a floor of gVisor: no plain containers, and the turn says why', async () => {
  const s = await stack({}, { env: { AGENT_RUNTIME_FLOOR: 'gvisor' } })
  const { r } = await useMachine(s, 'Joe')
  a.match(JSON.stringify(r.error ?? r.events), /No allowed isolation/)
  a.equal((await runs(s)).length, 0, 'nothing was started')
  const iso = (await s.api('GET', '/api/isolation')).body
  a.equal(iso.using, null)
  a.match(iso.error, /install Kata Containers or gVisor/)
})

test('asked for exactly Kata: no stepping down when it fails', async () => {
  const s = await stack({ ...KATA, ...GVISOR }, { fail: 'kata', env: { AGENT_RUNTIME: 'kata' } })
  const { r } = await useMachine(s, 'Pat')
  a.match(JSON.stringify(r.error ?? r.events), /cannot start here/)
  const all = await runs(s)
  a.equal(all.length, 1)
  a.ok(!all.some(l => l.includes('runsc')))
})
