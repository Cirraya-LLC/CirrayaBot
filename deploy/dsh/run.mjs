// One DeepSeek Harness runtime for one agent turn, inside the dsh container.
//
// The platform (web/dsh.mjs) runs `docker exec -i <dsh container> node /opt/dsh/run.mjs` and speaks
// over stdin/stdout:
//
//   stdin line 1   {rt, key, base_url, system, mcp_url, mcp_token, max_ms} — this turn's settings.
//                  The key comes this way, never as an argument or a -e: those show up in `ps`
//                  and `docker inspect`.
//   after that     dsh's SDK JSON-RPC, newline-delimited, both ways (profile `sdk`).
//
// What the model gets is decided here, by the patch below: the platform's tools over MCP and
// NOTHING of dsh's own. Every dsh tool row is disabled — a tool the host composition keeps is
// visible to the model whatever the persona says (CLAUDE.md 2.9.2) — and the container itself holds
// nothing worth reaching: no docker socket, no workspace, no platform secret.
//
//   node run.mjs --version     print dsh's version (the platform's "Test" button)
//   node run.mjs --kill <rt>   stop a runtime whose docker exec client is gone
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

// The overrides exist for running this outside the image in a test; the image sets neither.
const DSH = process.env.DSH_PACKAGE_DIR || '/opt/dsh/node_modules/@deepseek-ai/dsh'
const ROOT = process.env.DSH_RUN_ROOT || '/tmp/dsh'

// dsh's own tools and the machinery around them, all off. Checked against 0.1.5-rc.3: with these
// disabled the model is offered only mcp__platform__* (the e2e asserts it on every run). When
// upgrading dsh, rerun it — a new tool row added upstream would otherwise be on for every agent.
export const DISABLED = [
  'tool-bash', 'tool-pwsh', 'tool-jobs', 'jobs', 'tool-fs', 'tool-fs-search',
  'agent-instructions',                       // would read AGENTS.md / CLAUDE.md up the tree (2.10)
  'skill', 'skill-filesystem', 'tool-skill',  // the platform has its own skills (read_skill)
  'subagent', 'subagent-spawn-in-process', 'subagent-fork-in-process', 'tool-subagent-control',
  'tool-subagent-list-agents', 'tool-subagent', 'tool-subagent-fork',
  'workflow-worker-thread', 'tool-workflow', 'tool-todo', 'tool-goal', 'tool-ralph', 'goal',
  'goal-round-driver', 'command-goal', 'plan-mode',
  'web', 'web-search-deepseek', 'web-fetch-http', 'tool-web',
  'session-title-llm',                        // a second model call per turn, for a title nobody sees
]

/**
 * The patch for this turn. Written as JSON, which YAML reads as it is — but YAML 1.1 parsers treat
 * NEL / LS / PS as line breaks and refuse other C1 controls, so those are escaped too.
 */
export function patchFor(cfg) {
  const rows = [
    { id: 'system-prompt', config: {
      personaPrefix: cfg.system, personaSuffix: '',
      // Only the platform's system prompt: no "you are dsh" identity, no runtime-context message
      // (cwd, date, sandbox) — the platform already says what the agent needs to know.
      includeHarnessIdentity: false, includeRuntimeContext: false } },
    { insert: [{ id: 'mcp-platform', name: '@deepseek-ai/dsh-mcp-client', config: {
      serverName: 'platform', transport: 'streamable-http', url: cfg.mcp_url,
      headers: { Authorization: `Bearer ${cfg.mcp_token}` },
      // A tool call can wait for a person to approve it; the platform decides when that ends.
      toolCallTimeoutMs: 3_600_000,
      // No platform tools = no point running: fail the turn, don't run a model with nothing.
      failOnStartupError: true } }] },
    ...DISABLED.map(id => ({ id, disabled: true })),
  ]
  return JSON.stringify(rows, null, 1).replace(/[\u0080-\u009f\u2028\u2029\ufeff\ufffe\uffff]/g,
    c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

function main() {
  const arg = process.argv[2]
  if (arg === '--version') {
    console.log(JSON.parse(readFileSync(join(DSH, 'package.json'), 'utf8')).version)
    return
  }
  if (arg === '--kill') {
    const rt = String(process.argv[3] ?? '')
    if (!/^[a-f0-9]{8,64}$/.test(rt)) { console.error('bad runtime id'); process.exit(2) }
    try { process.kill(Number(readFileSync(join(ROOT, rt, 'pid'), 'utf8')), 'SIGTERM') } catch {}
    return
  }

  // Line 1 is ours; everything after it is dsh's, byte for byte.
  let head = Buffer.alloc(0)
  const onData = chunk => {
    head = Buffer.concat([head, chunk])
    const nl = head.indexOf(10)
    if (nl < 0) {
      if (head.length > 8 << 20) { console.error('run.mjs: the config line is over 8 MB'); process.exit(2) }
      return
    }
    process.stdin.off('data', onData)
    process.stdin.pause()
    start(head.subarray(0, nl).toString('utf8'), head.subarray(nl + 1))
  }
  process.stdin.on('data', onData)
  process.stdin.on('end', () => { if (!started) process.exit(2) })
}

let started = false
function start(line, rest) {
  started = true
  let cfg
  try { cfg = JSON.parse(line) } catch { console.error('run.mjs: line 1 is not JSON'); process.exit(2) }
  if (!/^[a-f0-9]{8,64}$/.test(String(cfg.rt ?? ''))) { console.error('run.mjs: bad runtime id'); process.exit(2) }
  for (const k of ['key', 'base_url', 'system', 'mcp_url', 'mcp_token'])
    if (typeof cfg[k] !== 'string' || (k !== 'system' && !cfg[k])) { console.error(`run.mjs: ${k} missing`); process.exit(2) }

  // A fresh home per turn: no sessions, presets or settings carried over from anything before.
  const dir = join(ROOT, cfg.rt)
  mkdirSync(join(dir, 'ws'), { recursive: true })
  mkdirSync(join(dir, 'home'), { recursive: true })
  writeFileSync(join(dir, 'patch.yml'), patchFor(cfg), { mode: 0o600 })
  writeFileSync(join(dir, 'pid'), String(process.pid))
  const cleanup = () => { try { rmSync(dir, { recursive: true, force: true }) } catch {} }

  const child = spawn(process.execPath, [join(DSH, 'lib/bin.js'), '--profile', 'sdk', '--patch', join(dir, 'patch.yml')], {
    cwd: join(dir, 'ws'),
    stdio: ['pipe', 'inherit', 'inherit'],
    env: {
      PATH: process.env.PATH, HOME: join(dir, 'home'), DSH_HOME: join(dir, 'home'),
      DEEPSEEK_API_KEY: cfg.key, DEEPSEEK_BASE_URL: cfg.base_url,
      // dsh would otherwise hold each MCP call for an approval nobody can give over the SDK. The
      // platform asks its own question, in its own UI, before it runs the tool (approve.mjs).
      DSH_PERMISSION_MODE: 'danger-full-access',
    },
  })
  const stop = (sig = 'SIGTERM') => { try { child.kill(sig) } catch {} }
  child.on('exit', (code, sig) => { cleanup(); process.exit(code ?? (sig ? 1 : 0)) })
  child.on('error', e => { console.error(`run.mjs: ${e.message}`); cleanup(); process.exit(1) })
  // The platform hanging up (or its docker exec dying) = this turn is over.
  process.stdin.on('end', () => { try { child.stdin.end() } catch {}; setTimeout(() => stop('SIGKILL'), 10_000).unref() })
  for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(s, () => { stop(); setTimeout(() => stop('SIGKILL'), 3000).unref() })
  // Backstop: no turn lives for ever, whatever happened to the platform.
  setTimeout(() => stop('SIGKILL'), Number(cfg.max_ms) > 0 ? Number(cfg.max_ms) : 2 * 3600_000).unref()

  child.stdin.on('error', () => {})
  if (rest.length) child.stdin.write(rest)
  process.stdin.pipe(child.stdin)
  process.stdin.resume()
}

if (import.meta.url === `file://${process.argv[1]}`) main()
