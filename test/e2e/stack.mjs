// The real server, started the way a deployment starts it, against a database of its own.
//
//   const s = await startStack({ tools: true })   // AGENT_TOOLS=on with a stand-in for docker
//   const up = await fakeUpstream()
//   const bot = await s.agent(up, { name: 'Op' })   // an upstream + an agent on it
//   const r = await s.chat({ agent: bot }, 'hello')
//   await s.close()
//
// The database comes from E2E_DATABASE_URL (default: the local server, as the current OS user):
// a throwaway database is created on it and dropped at the end. The server never reads .env
// (MA_DOTENV=off) and gets its own scratch workspace, so a test run can't touch real data.
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { randomBytes } from 'node:crypto'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
// The same pg the server uses: it lives with the server (web/package.json), not at the repo root.
const pg = createRequire(join(ROOT, 'web', 'package.json'))('pg')
export const FAKE_DOCKER = join(ROOT, 'test', 'e2e', 'fake-docker.sh')

const freePort = () => new Promise((ok, fail) => {
  const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)) })
  s.on('error', fail)
})

// No user in the URL means the current OS user, spelled out: the server runs with a minimal
// environment, and without USER the driver would try someone else.
const adminUrl = () => {
  const u = new URL(process.env.E2E_DATABASE_URL || 'postgres://127.0.0.1:5432/postgres')
  if (!u.username) u.username = userInfo().username
  return u.toString()
}
const dbUrl = name => { const u = new URL(adminUrl()); u.pathname = `/${name}`; return u.toString() }

async function admin(sql) {
  const c = new pg.Client({ connectionString: adminUrl() })
  await c.connect()
  try { await c.query(sql) } finally { await c.end() }
}

/** Parse a text/event-stream body into [{ ev, data }]. */
export async function readEvents(res, onEvent) {
  const events = []
  const dec = new TextDecoder()
  let buf = ''
  const pending = []
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true })
    let i
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2)
      const ev = /^event: (.*)$/m.exec(block)?.[1]
      const data = /^data: (.*)$/m.exec(block)?.[1]
      if (!ev) continue
      const e = { ev, data: data ? JSON.parse(data) : null }
      events.push(e)
      if (onEvent) pending.push(Promise.resolve(onEvent(e.ev, e.data)))
    }
  }
  await Promise.all(pending)
  return events
}

export async function startStack({ tools = false, env = {} } = {}) {
  const name = `ma_e2e_${randomBytes(5).toString('hex')}`
  await admin(`create database ${name}`)
  const work = await mkdtemp(join(tmpdir(), 'ma-e2e-'))
  const token = randomBytes(12).toString('hex')
  const port = await freePort()
  const url = `http://127.0.0.1:${port}`
  let proc = null, log = ''

  async function start() {
    log += `\n--- start ---\n`
    proc = spawn(process.execPath, [join(ROOT, 'web', 'server.mjs')], {
      cwd: ROOT,
      env: {
        PATH: process.env.PATH, HOME: process.env.HOME, MA_DOTENV: 'off',
        DATABASE_URL: dbUrl(name), WEB_PORT: String(port), BIND_HOST: '127.0.0.1', ACCESS_TOKEN: token,
        AGENT_TOOLS: tools ? 'on' : 'off', CONTAINER_CLI: FAKE_DOCKER, FAKE_DOCKER_LOG: join(work, 'docker.log'),
        WORKSPACE_HOST_PATH: work, AGENT_PREFIX: `e2e${port}`,
        MODEL_RETRY_WAITS: '0,20,40',      // the real backoff is 0/2/6 s per failing call
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    proc.stdout.on('data', d => { log += d })
    proc.stderr.on('data', d => { log += d })
    const exited = new Promise(ok => proc.once('exit', ok))
    for (let i = 0; i < 100; i++) {
      if (proc.exitCode != null) throw new Error(`server exited (${proc.exitCode}):\n${log}`)
      try { if ((await fetch(`${url}/healthz`)).ok) return } catch {}
      await Promise.race([exited, new Promise(t => setTimeout(t, 100))])
    }
    throw new Error(`server did not come up:\n${log}`)
  }

  async function stop(signal = 'SIGTERM') {
    if (!proc || proc.exitCode != null) return
    const gone = new Promise(ok => proc.once('exit', ok))
    proc.kill(signal)
    await gone
  }

  await start()

  const headers = { authorization: '', cookie: `ma_token=${token}` }
  const s = {
    url, token, work, db: dbUrl(name),
    log: () => log,

    /** JSON in, JSON out. Resolves to { status, body }. */
    async api(method, path, body) {
      const r = await fetch(url + path, { method, headers: { ...headers, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body) })
      const text = await r.text()
      let parsed = text
      try { parsed = JSON.parse(text) } catch {}
      return { status: r.status, body: parsed }
    },

    /** An upstream on this fake, and an agent using it. Returns the agent's id. */
    async agent(up, { name = 'Op', persona = 'You are a helpful colleague.', model = 'fake', ...rest } = {}) {
      let p = (await s.api('GET', '/api/providers')).body.find(x => x.base_url === up.url)
      if (!p) {
        const r = await s.api('POST', '/api/providers', { name: `up-${up.url.split(':').at(-1)}`, base_url: up.url, protocol: 'chat' })
        if (r.status !== 200) throw new Error(`provider: ${JSON.stringify(r.body)}`)
        p = r.body
      }
      const r = await s.api('POST', '/api/bots', { name, persona, model, provider_id: p.id, ...rest })
      if (r.status !== 200) throw new Error(`agent: ${JSON.stringify(r.body)}`)
      return r.body.id
    },

    /**
     * Send a message and read the whole stream. `onEvent(ev, data)` sees each event as it arrives
     * (to answer an approval card, say). Resolves to { events, text, session, error }.
     */
    async chat(target, text, { session = null, files = [], onEvent, signal, interject = false, call = null } = {}) {
      const body = { target: target.group ? { type: 'group', id: target.group } : { type: 'agent', id: target.agent },
        text, session, files, ...interject ? { interject: true } : {}, ...call ? { call: { id: call } } : {} }
      const r = await fetch(url + '/api/chat', { method: 'POST', signal,
        headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) })
      if (r.status !== 200) return { status: r.status, error: (await r.json()).error, events: [] }
      const events = await readEvents(r, onEvent)
      return {
        status: 200, events,
        text: events.filter(e => e.ev === 'delta').map(e => e.data.text).join(''),
        session: events.find(e => e.ev === 'session')?.data.id ?? null,
        error: events.find(e => e.ev === 'error')?.data ?? null,
      }
    },

    /** Poll until fn() is truthy (it may be async). */
    async until(fn, { timeout = 15_000, every = 100, what = 'condition' } = {}) {
      const end = Date.now() + timeout
      for (;;) {
        const v = await fn()
        if (v) return v
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}\n--- server log ---\n${log.slice(-3000)}`)
        await new Promise(t => setTimeout(t, every))
      }
    },

    /** The stored rows of a DM session ([{ role, content, ... }]), as the history endpoint returns them. */
    async history(agentId, session) {
      const q = session ? `?session=${encodeURIComponent(session)}` : ''
      return (await s.api('GET', `/api/dm/${agentId}${q}`)).body
    },

    stop, start,
    /** Kill the process (no clean shutdown) and start it again on the same database. */
    async restart({ signal = 'SIGKILL' } = {}) { await stop(signal); await start() },
    async close() {
      await stop()
      await admin(`drop database if exists ${name} with (force)`).catch(() => {})
      await rm(work, { recursive: true, force: true })
    },
  }
  return s
}
