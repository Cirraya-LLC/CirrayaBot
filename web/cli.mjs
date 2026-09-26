// Running an agent's turn on a coding CLI instead of our own loop: Claude Code, Codex, Grok Build,
// each signed in with a person's own subscription (or whatever its own config says) in the `cli`
// module's container, whose home — and so the login — every agent shares.
//
// What this file knows: how to start each one for a turn, how to read what it prints, and how to
// sign it in. What it does not do: run anything — server.mjs spawns, and serves the tools.
//
// The rule that shapes all of it (the lesson of DeepSeek Harness, 2.29): **a CLI's built-in tools
// would bypass everything we route** — the approval gate, the transcript, the agent's own
// container, and the login sitting next to the CLI. So every built-in is switched off and the
// model's only hands are our tools, served over MCP by the app (web/mcp.mjs) and run by the same
// code as on our own loop. Verified against each CLI with a recording fake upstream: the request's
// tool list holds our tools and nothing that touches the CLI's machine.
//
// `node web/cli.mjs` is the self-test (argv and the three stream formats, from captured output).

export const RUNTIMES = {
  claude: { name: 'Claude Code', bin: 'claude', images: true },
  codex: { name: 'Codex', bin: 'codex', images: true },
  // Grok Build hands MCP tool results to the model as text only (its ACP init says
  // promptCapabilities.image = false), so a screenshot would arrive as a base64 blob.
  grok: { name: 'Grok Build', bin: 'grok', images: false },
}
export const RUNTIME_IDS = Object.keys(RUNTIMES)

/** The MCP server's name as the CLIs see it; tools show up as mcp__cirrayabot__bash and the like. */
export const MCP_NAME = 'cirrayabot'

// Codex features that put a tool of its own in front of the model. The shell and apply_patch go
// with shell_tool / unified_exec; the rest would reach the network or the machine the login is on.
const CODEX_OFF = ['shell_tool', 'unified_exec', 'view_image', 'apps', 'browser_use', 'browser_use_external',
  'computer_use', 'image_generation', 'multi_agent', 'plugins', 'goals', 'in_app_browser', 'sleep_tool',
  'tool_suggest', 'skill_search', 'memories']

// Grok reads Claude's and Cursor's rules, skills, MCPs and hooks as well as its own. None of them
// belong in a turn of ours — and a rules file is exactly how the parent CLAUDE.md with its
// credentials would ride along (§0).
export const GROK_ENV = {
  GROK_DISABLE_AUTOUPDATER: '1', GROK_TELEMETRY_ENABLED: '0', GROK_FEEDBACK_ENABLED: '0', GROK_MEMORY: '0',
  GROK_SUBAGENTS: '0', GROK_WEB_FETCH: '0', GROK_WORKFLOWS: '0',
  GROK_CLAUDE_RULES_ENABLED: '0', GROK_CLAUDE_MCPS_ENABLED: '0', GROK_CLAUDE_SKILLS_ENABLED: '0',
  GROK_CLAUDE_AGENTS_ENABLED: '0', GROK_CLAUDE_HOOKS_ENABLED: '0', GROK_CURSOR_RULES_ENABLED: '0',
  GROK_CURSOR_MCPS_ENABLED: '0', GROK_CURSOR_SKILLS_ENABLED: '0', GROK_CURSOR_AGENTS_ENABLED: '0',
  GROK_CURSOR_HOOKS_ENABLED: '0',
}

const toml = s => JSON.stringify(String(s))   // a TOML basic string is a JSON string for our values

/**
 * The command line for one turn. The prompt goes in on stdin (an argument is capped at 128 KB
 * by Linux and a long conversation passes that); the system prompt is a file for the two that
 * take one, an argument for Grok.
 *
 * `mcp` = { url, token }. Claude gets the token in its --mcp-config; Codex and Grok read it from
 * MA_TURN_TOKEN (bearer_token_env_var), which the caller puts in the environment.
 */
export function turnArgs(rt, { model = '', effort = '', maxTurns = null, system = '', systemFile, mcp }) {
  if (rt === 'claude') {
    const cfg = { mcpServers: { [MCP_NAME]: { type: 'http', url: mcp.url, headers: { Authorization: `Bearer ${mcp.token}` } } } }
    return ['claude', '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--tools', '', '--strict-mcp-config', '--mcp-config', JSON.stringify(cfg), '--allowedTools', `mcp__${MCP_NAME}`,
      '--system-prompt-file', systemFile, '--setting-sources', '', '--no-session-persistence',
      ...model ? ['--model', model] : [], ...effort ? ['--effort', effort] : [],
      ...maxTurns ? ['--max-turns', String(maxTurns)] : []]
  }
  if (rt === 'codex') {
    const server = `{url=${toml(mcp.url)},bearer_token_env_var="MA_TURN_TOKEN",tool_timeout_sec=86400,startup_timeout_sec=60,default_tools_approval_mode="approve"}`
    return ['codex', 'exec', '--json', '--skip-git-repo-check', '--ephemeral', '--ignore-rules', '-s', 'read-only',
      '-c', `mcp_servers.${MCP_NAME}=${server}`, '-c', 'web_search="disabled"',
      '-c', `model_instructions_file=${toml(systemFile)}`, '-c', 'project_doc_max_bytes=0',
      ...CODEX_OFF.flatMap(f => ['--disable', f]),
      ...model ? ['-m', model] : [], ...effort ? ['-c', `model_reasoning_effort=${toml(effort)}`] : [], '-']
  }
  if (rt === 'grok') {
    // search_tool / use_tool are how Grok reaches MCP tools at all; everything else built in is off.
    return ['grok', '--prompt-file', '/dev/stdin', '--output-format', 'streaming-json', '--no-auto-update',
      '--disable-web-search', '--no-subagents', '--no-plan', '--tools', 'search_tool,use_tool', '--always-approve',
      '--system-prompt-override', system,
      ...model ? ['-m', model] : [], ...effort ? ['--reasoning-effort', effort] : [],
      ...maxTurns ? ['--max-turns', String(maxTurns)] : []]
  }
  throw new Error(`unknown runtime ${rt}`)
}

/**
 * Grok takes MCP servers only from its user config (an overlay can't set them, and a project
 * config is skipped in an untrusted folder), so this block is kept in the shared ~/.grok/config.toml.
 * The URL is fixed per deployment; the per-turn token comes from the environment.
 */
export function grokMcpBlock(url) {
  return `\n# Added by CirrayaBot: its tools, for agents running on Grok Build. The token is per turn.\n` +
    `[mcp_servers.${MCP_NAME}]\nurl = ${toml(url)}\nbearer_token_env_var = "MA_TURN_TOKEN"\ntool_timeout_sec = 86400\n`
}

/**
 * A reader for one runtime's stdout, line by line. `feed(line)` returns what to do now:
 * { delta } text for the live bubble; { cut: true } a tool call started (the next text is a new
 * bubble, and it is the one that counts as the answer); { usage }; { error }.
 * `answer()` is the turn's final reply — the text after the last tool call, like our own loop.
 */
export function reader(rt) {
  let current = '', final = null, error = null, usage = null, sawTool = false
  const out = []
  const push = x => { out.push(x); return x }
  const text = t => { if (!t) return; current += t; push({ delta: t }) }
  const tool = () => { if (current || !sawTool) { current = ''; sawTool = true; push({ cut: true }) } }
  const handle = {
    claude(j) {
      if (j.type === 'stream_event') {
        const e = j.event ?? {}
        if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') text(e.delta.text)
        if (e.type === 'content_block_start' && e.content_block?.type === 'tool_use') tool()
      } else if (j.type === 'result') {
        if (j.is_error || (j.subtype && j.subtype !== 'success')) error = String(j.result || j.subtype || 'failed')
        else if (typeof j.result === 'string') final = j.result
        const u = j.usage ?? {}
        usage = { prompt: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
          completion: u.output_tokens ?? 0 }
      }
    },
    codex(j) {
      const it = j.item ?? {}
      if (j.type === 'item.started' && it.type === 'mcp_tool_call') tool()
      else if (j.type === 'item.completed' && it.type === 'agent_message') {
        // No token stream in exec mode: a message arrives whole. Several in a turn are several bubbles.
        if (current) { current = ''; push({ cut: true }) }
        text(it.text)
      } else if (j.type === 'turn.completed') {
        const u = j.usage ?? {}
        usage = { prompt: u.input_tokens ?? 0, completion: (u.output_tokens ?? 0) + (u.reasoning_output_tokens ?? 0) }
      } else if (j.type === 'turn.failed') error = String(j.error?.message ?? 'turn failed')
      else if (j.type === 'error') error = String(j.message ?? 'error')
      // item.completed of type "error" are warnings (unknown model metadata and the like), not failures
    },
    grok(j) {
      if (j.type === 'text') text(j.data)
      else if (j.type === 'tool_call') tool()
      else if (j.type === 'end') {
        const u = j.usage ?? {}
        usage = { prompt: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0), completion: u.output_tokens ?? 0 }
      } else if (j.type === 'error') error = String(j.message ?? 'error')
    },
  }[rt]
  return {
    feed(line) {
      out.length = 0
      let j
      try { j = JSON.parse(line) } catch { return [] }
      if (j && typeof j === 'object') handle(j)
      return [...out]
    },
    answer: () => (final ?? current).trim(),
    error: () => error,
    usage: () => usage,
  }
}

/** A failure a person can act on. "Not signed in" is the common one, and each CLI words it differently. */
export function needsLogin(text) {
  return /not (signed|logged) in|please (log|sign) in|run `?(claude|codex|grok) (auth )?login|invalid api key|authentication_error|401|unauthorized|OAuth token has expired/i.test(String(text))
}

// ---------- signing in ----------
// Each CLI's own flow, run in the cli container; a person finishes it in their browser. The
// login lands in the shared home, so every agent on that CLI uses it from then on.

export function loginArgs(rt) {
  if (rt === 'claude') return ['claude', 'auth', 'login', '--claudeai']
  if (rt === 'codex') return ['codex', 'login', '--device-auth']
  if (rt === 'grok') return ['grok', 'login', '--device-auth']
  throw new Error(`unknown runtime ${rt}`)
}
export function logoutArgs(rt) {
  if (rt === 'claude') return ['claude', 'auth', 'logout']
  if (rt === 'codex') return ['codex', 'logout']
  return ['grok', 'logout']
}
/** The command whose exit status (and, for Claude, JSON) says whether it is signed in. */
export function statusArgs(rt) {
  if (rt === 'claude') return ['claude', 'auth', 'status']
  if (rt === 'codex') return ['codex', 'login', 'status']
  // Grok has no status command; its login is a file. (An API key in its own config works too,
  // and then this says "not signed in" while turns work — the panel says as much.)
  return ['sh', '-c', 'test -s "$HOME/.grok/auth.json" && echo "Signed in" || { echo "Not signed in"; exit 1; }']
}
export function statusOf(rt, code, out) {
  if (rt === 'claude') {
    try { const j = JSON.parse(out); return { loggedIn: j.loggedIn === true, detail: j.loggedIn ? (j.authMethod ?? '') : '' } }
    catch { return { loggedIn: false, detail: '' } }
  }
  return { loggedIn: code === 0 && !/not logged in|not signed in/i.test(out), detail: code === 0 ? plain(out).trim().split('\n').pop() : '' }
}

/** Colour codes out, so a URL or a code can be read from what the flows print. */
export const plain = s => String(s).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\r/g, '')

/**
 * What a login flow has printed so far → what the person needs: the page to open, the code to
 * type there (Codex, Grok), or that a code must be pasted back here (Claude).
 */
export function loginPrompt(output) {
  const t = plain(output)
  const url = (t.match(/https:\/\/[^\s)'"<>]+/g) ?? []).filter(u => !/localhost|127\.0\.0\.1/.test(u)).pop() ?? ''
  const code = t.match(/\b[A-Z0-9]{4,5}-[A-Z0-9]{4,5}\b/)?.[0] ?? ''
  return { url, code, needsPaste: /paste (the )?code/i.test(t) }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const assert = (await import('node:assert/strict')).default
  const mcp = { url: 'http://app:8080/mcp', token: 'tok' }

  // --- argv: built-ins off, our MCP server on, the prompt from stdin ---
  const c = turnArgs('claude', { model: 'opus', effort: 'high', maxTurns: 12, systemFile: '/tmp/s', mcp })
  assert.equal(c[c.indexOf('--tools') + 1], '')
  assert.ok(c.includes('--strict-mcp-config') && c.includes('--no-session-persistence'))
  assert.equal(c[c.indexOf('--setting-sources') + 1], '')
  assert.deepEqual(JSON.parse(c[c.indexOf('--mcp-config') + 1]).mcpServers.cirrayabot.headers, { Authorization: 'Bearer tok' })
  assert.deepEqual([c[c.indexOf('--model') + 1], c[c.indexOf('--effort') + 1], c[c.indexOf('--max-turns') + 1]], ['opus', 'high', '12'])
  assert.ok(!c.includes('--model') || c.indexOf('-p') === 1)
  const x = turnArgs('codex', { systemFile: '/tmp/s', mcp })
  for (const f of ['shell_tool', 'unified_exec', 'apps', 'browser_use', 'computer_use']) assert.ok(x.includes(f), f)
  assert.ok(x.includes('mcp_servers.cirrayabot={url="http://app:8080/mcp",bearer_token_env_var="MA_TURN_TOKEN",tool_timeout_sec=86400,startup_timeout_sec=60,default_tools_approval_mode="approve"}'))
  assert.equal(x.at(-1), '-'); assert.ok(!x.includes('-m'))
  const g = turnArgs('grok', { system: 'You are A.', model: 'grok-4.5', mcp })
  assert.equal(g[g.indexOf('--tools') + 1], 'search_tool,use_tool')
  assert.equal(g[g.indexOf('--system-prompt-override') + 1], 'You are A.')
  assert.ok(grokMcpBlock(mcp.url).includes('[mcp_servers.cirrayabot]\nurl = "http://app:8080/mcp"\nbearer_token_env_var = "MA_TURN_TOKEN"'))

  // --- Claude's stream-json (shape captured from claude 2.1.283) ---
  const cr = reader('claude')
  const lines = [
    { type: 'system', subtype: 'init', tools: ['mcp__cirrayabot__bash'] },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Checking.' } } },
    { type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', name: 'mcp__cirrayabot__bash' } } },
    { type: 'user', message: { content: [{ type: 'tool_result' }] } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'It is ' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'box1.' } } },
    { type: 'result', subtype: 'success', result: 'It is box1.', usage: { input_tokens: 22, cache_read_input_tokens: 5, output_tokens: 10 } },
  ].flatMap(l => cr.feed(JSON.stringify(l)))
  assert.deepEqual(lines, [{ delta: 'Checking.' }, { cut: true }, { delta: 'It is ' }, { delta: 'box1.' }])
  assert.equal(cr.answer(), 'It is box1.'); assert.deepEqual(cr.usage(), { prompt: 27, completion: 10 }); assert.equal(cr.error(), null)
  const ce = reader('claude'); ce.feed(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' }))
  assert.ok(needsLogin(ce.error()))

  // --- Codex's --json (captured from codex-cli 0.157.1) ---
  const xr = reader('codex')
  const xs = [
    { type: 'thread.started', thread_id: 't' },
    { type: 'item.completed', item: { type: 'error', message: 'Model metadata for `x` not found.' } },
    { type: 'turn.started' },
    { type: 'item.started', item: { type: 'mcp_tool_call', server: 'cirrayabot', tool: 'bash' } },
    { type: 'item.completed', item: { type: 'mcp_tool_call', status: 'completed' } },
    { type: 'item.completed', item: { type: 'agent_message', text: 'Done: box1.' } },
    { type: 'turn.completed', usage: { input_tokens: 22, output_tokens: 10, reasoning_output_tokens: 3 } },
  ].flatMap(l => xr.feed(JSON.stringify(l)))
  assert.deepEqual(xs, [{ cut: true }, { delta: 'Done: box1.' }])
  assert.equal(xr.answer(), 'Done: box1.'); assert.deepEqual(xr.usage(), { prompt: 22, completion: 13 }); assert.equal(xr.error(), null)
  const xf = reader('codex'); xf.feed(JSON.stringify({ type: 'turn.failed', error: { message: '401 Unauthorized' } }))
  assert.ok(needsLogin(xf.error()))

  // --- Grok's streaming-json (captured from grok 1.0.41) ---
  const gr = reader('grok')
  const gs = [
    { type: 'available_commands', tools: ['search_tool', 'use_tool'] },
    { type: 'tool_call', toolName: 'search_tool' },
    { type: 'tool_call_update', status: 'completed' },
    { type: 'tool_call', toolName: 'use_tool' },
    { type: 'text', data: 'Host is ' }, { type: 'text', data: 'box1.' },
    { type: 'end', stopReason: 'end_turn', usage: { input_tokens: 22, cache_read_input_tokens: 0, output_tokens: 10 } },
  ].flatMap(l => gr.feed(JSON.stringify(l)))
  assert.deepEqual(gs, [{ cut: true }, { delta: 'Host is ' }, { delta: 'box1.' }])
  assert.equal(gr.answer(), 'Host is box1.'); assert.deepEqual(gr.usage(), { prompt: 22, completion: 10 })
  const gf = reader('grok'); gf.feed('{"type":"error","message":"Not signed in. To authenticate without a browser, run:\\n  grok login --device-code"}')
  assert.ok(needsLogin(gf.error()))
  assert.deepEqual(reader('grok').feed('not json'), [])

  // --- login flows (what each actually printed) ---
  const codexOut = '\x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n\n2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m\n   \x1b[94mY9UK-AEJ4G\x1b[0m\n'
  assert.deepEqual(loginPrompt(codexOut), { url: 'https://auth.openai.com/codex/device', code: 'Y9UK-AEJ4G', needsPaste: false })
  const grokOut = 'To sign in, open this URL in your browser:\n\n  https://accounts.x.ai/oauth2/device?user_code=EHNZ-6BRZ\n\nConfirm this code in your browser:\n\n  EHNZ-6BRZ\n'
  assert.deepEqual(loginPrompt(grokOut), { url: 'https://accounts.x.ai/oauth2/device?user_code=EHNZ-6BRZ', code: 'EHNZ-6BRZ', needsPaste: false })
  const claudeOut = 'Opening browser to sign in…\nIf the browser didn\'t open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=9d&state=qy\nPaste code here if prompted > '
  const cp = loginPrompt(claudeOut)
  assert.equal(cp.url, 'https://claude.com/cai/oauth/authorize?code=true&client_id=9d&state=qy'); assert.equal(cp.needsPaste, true)
  assert.deepEqual(statusOf('claude', 0, '{"loggedIn": true, "authMethod": "claude.ai"}'), { loggedIn: true, detail: 'claude.ai' })
  assert.equal(statusOf('codex', 1, 'Not logged in').loggedIn, false)
  assert.equal(statusOf('codex', 0, 'Logged in using ChatGPT').loggedIn, true)
  console.log('cli.mjs: all checks passed')
}
