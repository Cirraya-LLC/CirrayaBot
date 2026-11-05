// MCP: tools from servers the person connects to an agent. Two kinds:
//   remote — an https URL speaking MCP's Streamable HTTP transport, with no auth, a token, or OAuth (sign in once);
//   local  — a command run inside the agent's own machine, speaking JSON-RPC over stdio (as the agent's user, so it
//            reaches what the agent reaches and nothing of the host).
// Each tool the server lists becomes a tool the model can call, named mcp__<server>__<tool>, and each has a mode the
// person sets: auto (runs), ask (a person approves each call), off (not offered). A tool the server marks read-only
// starts on auto, everything else on ask — an outside tool that sends, deletes or pays is what approvals are for.
//
// What a server returns is data from outside, like a web page: never instructions.
// Pure except the two client classes, which are handed their I/O. `node web/mcp.mjs` is the self-test.
import { createHash, randomBytes } from 'node:crypto'

export const PROTOCOL = '2025-06-18'
export const KINDS = ['remote', 'local']
export const AUTHS = ['none', 'token', 'oauth']
export const MODES = ['auto', 'ask', 'off']
export const MAX_TOOLS = 64                       // offered per agent; more than this confuses models more than it helps
export const LIMITS = { name: 40, url: 2000, command: 2000, header: 64, envKeys: 30, description: 1000, schema: 16_000 }
const CLIENT = { name: 'CirrayaBot', version: '1' }

const sha = s => createHash('sha256').update(String(s)).digest('hex')

/** The server's part of a tool name: lower-case letters, digits and _, at most 16. */
export function slug(name) {
  const s = String(name ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 16)
  return s || `s${sha(name).slice(0, 6)}`
}

/** mcp__<server>__<tool>, within the 64 characters (and the character set) every model API accepts. */
export function toolName(serverSlug, tool) {
  const t = String(tool ?? '').replace(/[^A-Za-z0-9_-]+/g, '_') || 'tool'
  const head = `mcp__${serverSlug}__`
  return head.length + t.length <= 64 ? head + t : `${head}${t.slice(0, 64 - head.length - 7)}_${sha(tool).slice(0, 6)}`
}

export const isMcp = name => typeof name === 'string' && name.startsWith('mcp__')

/** What a call is about, in one line: "mcp <server>/<tool> {args}". Approvals and never-allowed rules match against it. */
export function subject(name, args = {}) {
  const [, server = '', ...rest] = String(name).split('__')
  let a = ''
  try { a = JSON.stringify(args ?? {}) } catch {}
  return `mcp ${server}/${rest.join('__')} ${a.length > 300 ? `${a.slice(0, 300)}…` : a}`.trim()
}

/**
 * What a server may be, checked. `cur` = the stored one when editing. Throws an Error whose `field` names what is wrong.
 * Secrets (a token, environment values, an OAuth client secret) are not checked here and never returned by it.
 */
export function checkServer(b, cur = null) {
  const bad = field => { throw Object.assign(new Error(field), { field }) }
  const kind = cur?.kind ?? String(b.kind ?? '')
  if (!KINDS.includes(kind)) bad('kind')
  const name = String(b.name ?? cur?.name ?? '').replace(/\s+/g, ' ').trim()
  if (!name || name.length > LIMITS.name) bad('name')
  const out = { kind, name, enabled: b.enabled ?? cur?.enabled ?? true }
  if (kind === 'remote') {
    const raw = String(b.url ?? cur?.url ?? '').trim()
    let u
    try { u = new URL(raw) } catch { bad('url') }
    if (!['https:', 'http:'].includes(u.protocol) || raw.length > LIMITS.url || u.username || u.password) bad('url')
    out.url = u.href
    out.auth = String(b.auth ?? cur?.auth ?? 'none')
    if (!AUTHS.includes(out.auth)) bad('auth')
    out.header = String(b.header ?? cur?.header ?? '').trim() || 'Authorization'
    if (!/^[A-Za-z0-9-]{1,64}$/.test(out.header)) bad('header')
  } else {
    out.command = String(b.command ?? cur?.command ?? '').trim()
    if (!out.command || out.command.length > LIMITS.command || /[\0]/.test(out.command)) bad('command')
  }
  return out
}

/** Environment for a local server: {KEY: value}, names as a shell takes them. Empty values keep what was stored. */
export function checkEnv(env, stored = {}) {
  if (env == null) return stored
  if (typeof env !== 'object' || Array.isArray(env)) throw Object.assign(new Error('env'), { field: 'env' })
  const out = {}
  for (const [k, v] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k)) throw Object.assign(new Error('env'), { field: 'env' })
    const val = String(v ?? '')
    if (/[\0]/.test(val) || val.length > 4000) throw Object.assign(new Error('env'), { field: 'env' })
    if (val) out[k] = val
    else if (stored[k] != null) out[k] = stored[k]
  }
  if (Object.keys(out).length > LIMITS.envKeys) throw Object.assign(new Error('env'), { field: 'env' })
  return out
}

/** A tool's input schema as the model APIs take it: an object schema, not too big. */
export function cleanSchema(s) {
  const fallback = { type: 'object', properties: {} }
  if (!s || typeof s !== 'object' || Array.isArray(s)) return fallback
  const { $schema, ...rest } = s
  if (rest.type !== 'object') return fallback
  let json = ''
  try { json = JSON.stringify(rest) } catch { return fallback }
  if (json.length > LIMITS.schema) return { type: 'object', properties: {}, additionalProperties: true }
  return { ...rest, properties: rest.properties && typeof rest.properties === 'object' ? rest.properties : {} }
}

/**
 * The tools a server listed, merged with what the person already chose: a tool that stays keeps its mode, a new one
 * starts on auto when the server says it only reads, otherwise on ask. Tools no longer listed are dropped.
 */
export function mergeTools(old = [], listed = []) {
  const prev = new Map((old ?? []).map(t => [t.name, t]))
  const out = []
  for (const t of Array.isArray(listed) ? listed : []) {
    if (!t || typeof t.name !== 'string' || !t.name || out.some(x => x.name === t.name)) continue
    const ann = t.annotations && typeof t.annotations === 'object' ? t.annotations : {}
    const readOnly = ann.readOnlyHint === true
    const was = prev.get(t.name)
    out.push({
      name: t.name.slice(0, 128),
      title: String(t.title ?? ann.title ?? '').slice(0, 120),
      description: String(t.description ?? '').replace(/\s+/g, ' ').trim().slice(0, LIMITS.description),
      schema: cleanSchema(t.inputSchema),
      read_only: readOnly,
      destructive: ann.destructiveHint === true,
      mode: MODES.includes(was?.mode) ? was.mode : readOnly ? 'auto' : 'ask',
    })
  }
  return out
}

/** The model-facing specs of one server, and a map from each spec's name back to {server, tool}. */
export function specsOf(server, tools = server.tools) {
  const s = slug(server.name)
  const specs = [], map = new Map()
  for (const t of tools ?? []) {
    if (t.mode === 'off') continue
    const name = toolName(s, t.name)
    if (map.has(name)) continue
    map.set(name, { server: server.id, tool: t.name, readOnly: !!t.read_only, mode: t.mode })
    specs.push({ type: 'function', function: {
      name,
      description: `[${server.name}] ${t.description || t.title || t.name}`.slice(0, LIMITS.description + 40),
      parameters: t.schema ?? { type: 'object', properties: {} },
    } })
  }
  return { specs, map }
}

/** A tools/call result as the agent reads it: text, plus the first image when there is one. */
export function resultOf(r) {
  if (!r || typeof r !== 'object') return { text: String(r ?? '') }
  const parts = [], images = []
  for (const c of Array.isArray(r.content) ? r.content : []) {
    if (c?.type === 'text') parts.push(String(c.text ?? ''))
    else if (c?.type === 'image' && typeof c.data === 'string') images.push(`data:${c.mimeType || 'image/png'};base64,${c.data}`)
    else if (c?.type === 'resource' && c.resource) parts.push(c.resource.text != null ? String(c.resource.text) : `[resource ${c.resource.uri ?? ''}]`)
    else if (c?.type === 'resource_link') parts.push(`[link ${c.name ?? ''} ${c.uri ?? ''}]`.trim())
    else if (c?.type === 'audio') parts.push('[audio]')
  }
  if (!parts.length && r.structuredContent != null) parts.push(JSON.stringify(r.structuredContent))
  let text = parts.join('\n') || (images.length ? '(an image)' : '(no output)')
  if (r.isError) text = `The tool reported an error:\n${text}`
  return images.length ? { text, image: images[0] } : { text }
}

/** Server-sent events in a body read so far: the `data` of each complete event (a blank line ends one). */
export function sseData(text) {
  const out = []
  for (const block of String(text).replace(/\r\n/g, '\n').split('\n\n').slice(0, -1)) {
    const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, ''))
    if (data.length) out.push(data.join('\n'))
  }
  return out
}

const parseJson = s => { try { return JSON.parse(s) } catch { return undefined } }

/** The JSON-RPC response with this id in a body (plain JSON — a message or a batch — or an SSE stream), or undefined. */
export function findResponse(body, contentType, id) {
  const msgs = /text\/event-stream/i.test(contentType ?? '') ? sseData(body).map(parseJson) : [parseJson(body)]
  for (const m of msgs.flat()) if (m && typeof m === 'object' && m.id === id && ('result' in m || 'error' in m)) return m
  return undefined
}

export class McpError extends Error {
  constructor(message, { status = 0, auth = null, code = null } = {}) {
    super(message)
    this.status = status
    this.auth = auth                       // a 401's WWW-Authenticate, parsed — the way to sign in
    this.code = code
  }
}
const rpcError = e => new McpError(`${e?.message ?? 'error'}${e?.code != null ? ` (${e.code})` : ''}`, { code: e?.code })

/**
 * A remote server over Streamable HTTP. `send(url, {method, headers, body, until})` makes the request and returns
 * {status, headers, body}; `until(bodySoFar)` lets it stop reading once the answer is in (an SSE stream may stay open).
 * `auth()` gives the headers to add (a token, a fresh OAuth access token) on every request.
 */
export class RemoteClient {
  constructor({ url, send, auth = async () => ({}), timeout = 120_000 }) {
    Object.assign(this, { url, send, auth, timeout, session: null, version: PROTOCOL, ready: null, n: 0 })
  }

  async post(message, until) {
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      'mcp-protocol-version': this.version, ...this.session ? { 'mcp-session-id': this.session } : {}, ...await this.auth() }
    const r = await this.send(this.url, { method: 'POST', headers, body: JSON.stringify(message), until, timeout: this.timeout })
    if (r.status === 401) throw new McpError('the server wants you to sign in (401)', { status: 401, auth: parseWwwAuthenticate(r.headers?.['www-authenticate']) })
    return r
  }

  async raw(method, params) {
    const id = ++this.n
    const done = body => findResponse(body, 'text/event-stream', id) !== undefined
    const r = await this.post({ jsonrpc: '2.0', id, method, ...params !== undefined ? { params } : {} }, done)
    if (r.status === 404 && this.session) { const e = new McpError('session expired', { status: 404 }); e.expired = true; throw e }
    if (r.status < 200 || r.status >= 300) throw new McpError(`HTTP ${r.status}: ${String(r.body ?? '').slice(0, 200)}`, { status: r.status })
    const m = findResponse(r.body, r.headers?.['content-type'], id)
    if (!m) throw new McpError(`no answer to ${method} in what the server sent: ${String(r.body ?? '').slice(0, 200)}`)
    if (m.error) throw rpcError(m.error)
    return { result: m.result, headers: r.headers }
  }

  init() {
    this.ready ??= (async () => {
      this.session = null
      this.version = PROTOCOL
      const { result, headers } = await this.raw('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: CLIENT })
      this.session = headers?.['mcp-session-id'] ?? null
      if (typeof result?.protocolVersion === 'string') this.version = result.protocolVersion
      this.serverInfo = result?.serverInfo ?? null
      await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }).catch(() => {})
    })().catch(e => { this.ready = null; throw e })
    return this.ready
  }

  /** A request after initialize; a session the server has forgotten is started again once. */
  async request(method, params) {
    await this.init()
    try { return (await this.raw(method, params)).result }
    catch (e) {
      if (!e.expired) throw e
      this.ready = null
      await this.init()
      return (await this.raw(method, params)).result
    }
  }

  async listTools() { return listAll(c => this.request('tools/list', c ? { cursor: c } : {})) }
  callTool(name, args) { return this.request('tools/call', { name, arguments: args ?? {} }) }
  close() {
    if (this.session) this.send(this.url, { method: 'DELETE', headers: { 'mcp-session-id': this.session }, timeout: 5000 }).catch(() => {})
    this.ready = null
  }
}

async function listAll(page) {
  const tools = []
  let cursor
  for (let i = 0; i < 20; i++) {
    const r = await page(cursor)
    tools.push(...Array.isArray(r?.tools) ? r.tools : [])
    cursor = r?.nextCursor
    if (!cursor) break
  }
  return tools
}

/**
 * A local server: JSON-RPC, one message per line, over a child process's stdin/stdout (in our case `docker exec -i`
 * into the agent's machine). Requests the server makes of us are answered: ping, and "not supported" for the rest.
 */
export class StdioClient {
  constructor(child, { timeout = 120_000 } = {}) {
    Object.assign(this, { child, timeout, n: 0, pending: new Map(), buf: '', stderr: '', closed: false, ready: null })
    child.stdout.setEncoding?.('utf8')
    child.stdout.on('data', d => this.feed(String(d)))
    child.stderr?.on('data', d => { this.stderr = (this.stderr + d).slice(-4000) })
    child.stdin.on('error', () => {})
    const end = why => {
      if (this.closed) return
      this.closed = true
      const tail = this.stderr.trim().split('\n').slice(-6).join('\n')
      for (const [, p] of this.pending) p.reject(new McpError(`the server stopped (${why})${tail ? `:\n${tail}` : ''}`))
      this.pending.clear()
    }
    child.on('exit', code => end(`exit ${code}`))
    child.on('error', e => end(e.message))
  }

  feed(chunk) {
    this.buf += chunk
    if (this.buf.length > 8 * 1024 * 1024) { this.buf = ''; return }
    let i
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim()
      this.buf = this.buf.slice(i + 1)
      if (!line) continue
      const m = parseJson(line)
      if (!m || typeof m !== 'object') continue          // a log line on stdout: not ours to read
      if ('id' in m && ('result' in m || 'error' in m)) {
        const p = this.pending.get(m.id)
        if (!p) continue
        this.pending.delete(m.id)
        m.error ? p.reject(rpcError(m.error)) : p.resolve(m.result)
      } else if (m.method && 'id' in m) {
        this.write(m.method === 'ping' ? { jsonrpc: '2.0', id: m.id, result: {} }
          : { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `${m.method} is not supported by this client` } })
      }
    }
  }

  write(m) { if (!this.closed) this.child.stdin.write(`${JSON.stringify(m)}\n`) }

  raw(method, params) {
    if (this.closed) return Promise.reject(new McpError('the server is not running'))
    const id = ++this.n
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new McpError(`no answer to ${method} within ${this.timeout / 1000} s`)) }, this.timeout)
      this.pending.set(id, { resolve: v => { clearTimeout(timer); resolve(v) }, reject: e => { clearTimeout(timer); reject(e) } })
      this.write({ jsonrpc: '2.0', id, method, ...params !== undefined ? { params } : {} })
    })
  }

  init() {
    this.ready ??= (async () => {
      const r = await this.raw('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: CLIENT })
      this.serverInfo = r?.serverInfo ?? null
      this.write({ jsonrpc: '2.0', method: 'notifications/initialized' })
    })()
    return this.ready
  }

  async request(method, params) { await this.init(); return this.raw(method, params) }
  async listTools() { return listAll(c => this.request('tools/list', c ? { cursor: c } : {})) }
  callTool(name, args) { return this.request('tools/call', { name, arguments: args ?? {} }) }
  /**
   * End of input first: an MCP server exits when its stdin closes. Killing `docker exec` alone would leave the process
   * inside the container running — so the kill only comes if it hasn't gone in a few seconds.
   */
  close() {
    this.closed = true
    try { this.child.stdin.end() } catch {}
    const t = setTimeout(() => { try { this.child.kill('SIGTERM') } catch {} }, 3000)
    t.unref?.()
    this.child.once?.('exit', () => clearTimeout(t))
  }
}

// ---------- OAuth (MCP authorization: OAuth 2.1, PKCE, discovery, dynamic client registration) ----------

/** `Bearer resource_metadata="…", scope="…", error="…"` → {resource_metadata, scope, error}; null when not Bearer. */
export function parseWwwAuthenticate(h) {
  const s = String(h ?? '')
  if (!/^\s*bearer\b/i.test(s)) return null
  const out = {}
  for (const m of s.matchAll(/([a-z_]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/gi)) out[m[1].toLowerCase()] = (m[2] ?? m[3]).replace(/\\(.)/g, '$1')
  return out
}

/** Where a server's protected-resource metadata may be (RFC 9728): with the path, then at the root. */
export function resourceMetadataUrls(mcpUrl, hinted) {
  const u = new URL(mcpUrl)
  const path = u.pathname.replace(/\/+$/, '')
  return [...new Set([hinted, path && path !== '/' ? `${u.origin}/.well-known/oauth-protected-resource${path}` : null,
    `${u.origin}/.well-known/oauth-protected-resource`].filter(Boolean))]
}

/** Where an authorization server's metadata may be (RFC 8414, then OpenID Connect discovery). */
export function authServerMetadataUrls(issuer) {
  const u = new URL(issuer)
  const path = u.pathname.replace(/\/+$/, '')
  return [...new Set(path && path !== '/'
    ? [`${u.origin}/.well-known/oauth-authorization-server${path}`, `${u.origin}/.well-known/openid-configuration${path}`,
      `${u.origin}${path}/.well-known/openid-configuration`]
    : [`${u.origin}/.well-known/oauth-authorization-server`, `${u.origin}/.well-known/openid-configuration`])]
}

/** An authorization server's endpoints, from its metadata, or — a server from before discovery — the usual paths. */
export function endpointsOf(meta, issuer) {
  const base = new URL(issuer).origin
  return {
    issuer: meta?.issuer ?? base,
    authorize: meta?.authorization_endpoint ?? `${base}/authorize`,
    token: meta?.token_endpoint ?? `${base}/token`,
    register: meta?.registration_endpoint ?? (meta ? null : `${base}/register`),
    scopes: Array.isArray(meta?.scopes_supported) ? meta.scopes_supported : [],
  }
}

const b64url = buf => Buffer.from(buf).toString('base64url')
/** A PKCE pair: the verifier kept here, the S256 challenge sent with the sign-in. */
export function pkce() {
  const verifier = b64url(randomBytes(48))
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) }
}

/** The URL the person opens to sign in. `resource` (RFC 8707) binds the token to this server. */
export function authorizeUrl(ep, { clientId, redirectUri, challenge, state, resource, scope }) {
  const u = new URL(ep.authorize)
  const q = { response_type: 'code', client_id: clientId, redirect_uri: redirectUri, code_challenge: challenge,
    code_challenge_method: 'S256', state, resource, ...scope ? { scope } : {} }
  for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v)
  return u.href
}

/** The canonical resource identifier of an MCP server: its URL without fragment (RFC 8707). */
export const resourceOf = url => { const u = new URL(url); u.hash = ''; return u.href }

/** A token endpoint's answer as we keep it. `now` in ms. */
export function tokensFrom(j, now = Date.now(), prev = {}) {
  if (!j || typeof j.access_token !== 'string' || !j.access_token) return null
  return { access_token: j.access_token, refresh_token: j.refresh_token ?? prev.refresh_token ?? null,
    expires_at: Number(j.expires_in) > 0 ? now + Number(j.expires_in) * 1000 : null, scope: j.scope ?? prev.scope ?? null }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { strict: a } = await import('node:assert')
  const { EventEmitter } = await import('node:events')
  const { PassThrough } = await import('node:stream')

  a.equal(slug('GitHub (work)'), 'github_work')
  a.match(slug('天气'), /^s[0-9a-f]{6}$/, 'a name with no latin letters still gets one')
  a.equal(toolName('github', 'create_issue'), 'mcp__github__create_issue')
  const long = toolName('github_work_more', 'x'.repeat(80))
  a.ok(long.length <= 64 && /^[A-Za-z0-9_-]+$/.test(long) && long !== toolName('github_work_more', 'x'.repeat(81)), 'long names stay distinct')
  a.equal(toolName('s', 'a.b/c'), 'mcp__s__a_b_c')
  a.equal(subject('mcp__github__create_issue', { title: 'x' }), 'mcp github/create_issue {"title":"x"}')

  const throwsField = (b, field, cur) => a.throws(() => checkServer(b, cur), e => e.field === field)
  throwsField({ kind: 'ftp', name: 'x' }, 'kind')
  throwsField({ kind: 'remote', name: '' , url: 'https://a.test/mcp' }, 'name')
  throwsField({ kind: 'remote', name: 'x', url: 'ftp://a.test' }, 'url')
  throwsField({ kind: 'remote', name: 'x', url: 'https://u:p@a.test/' }, 'url')
  throwsField({ kind: 'remote', name: 'x', url: 'https://a.test/', auth: 'magic' }, 'auth')
  throwsField({ kind: 'remote', name: 'x', url: 'https://a.test/', header: 'X Bad' }, 'header')
  throwsField({ kind: 'local', name: 'x', command: '' }, 'command')
  a.deepEqual(checkServer({ kind: 'remote', name: ' GH ', url: 'https://api.test/mcp' }),
    { kind: 'remote', name: 'GH', enabled: true, url: 'https://api.test/mcp', auth: 'none', header: 'Authorization' })
  a.equal(checkServer({ name: 'New' }, { kind: 'local', name: 'Old', command: 'npx srv' }).command, 'npx srv', 'edits keep what is not sent')
  a.deepEqual(checkEnv({ TOKEN: '', MODE: 'x' }, { TOKEN: 'kept' }), { TOKEN: 'kept', MODE: 'x' }, 'an empty value keeps the stored one')
  a.throws(() => checkEnv({ 'BAD-NAME': 'x' }), e => e.field === 'env')

  a.deepEqual(cleanSchema(null), { type: 'object', properties: {} })
  a.deepEqual(cleanSchema({ $schema: 'x', type: 'object', properties: { q: { type: 'string' } }, required: ['q'] }),
    { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] })
  a.deepEqual(cleanSchema({ type: 'string' }), { type: 'object', properties: {} })

  const listed = [
    { name: 'get_weather', description: 'Weather', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
    { name: 'create_issue', description: 'Make an issue', annotations: { destructiveHint: false } },
    { name: 'get_weather' }, null, { name: '' },
  ]
  const merged = mergeTools([], listed)
  a.deepEqual(merged.map(t => [t.name, t.mode]), [['get_weather', 'auto'], ['create_issue', 'ask']], 'read-only runs, the rest asks')
  const kept = mergeTools([{ name: 'create_issue', mode: 'auto' }, { name: 'gone', mode: 'off' }], listed)
  a.deepEqual(kept.map(t => [t.name, t.mode]), [['get_weather', 'auto'], ['create_issue', 'auto']], 'a chosen mode stays; a vanished tool goes')
  const { specs, map } = specsOf({ id: 's1', name: 'Weather', tools: [...merged, { name: 'x', mode: 'off' }] })
  a.deepEqual(specs.map(s => s.function.name), ['mcp__weather__get_weather', 'mcp__weather__create_issue'], 'off is not offered')
  a.equal(specs[0].function.description, '[Weather] Weather')
  a.deepEqual(map.get('mcp__weather__get_weather'), { server: 's1', tool: 'get_weather', readOnly: true, mode: 'auto' })

  a.deepEqual(resultOf({ content: [{ type: 'text', text: 'hi' }, { type: 'image', data: 'AAA', mimeType: 'image/jpeg' }] }),
    { text: 'hi', image: 'data:image/jpeg;base64,AAA' })
  a.equal(resultOf({ content: [], structuredContent: { t: 21 } }).text, '{"t":21}')
  a.match(resultOf({ isError: true, content: [{ type: 'text', text: 'nope' }] }).text, /reported an error:\nnope/)
  a.equal(resultOf({ content: [] }).text, '(no output)')

  a.deepEqual(sseData('event: message\ndata: {"a":1}\n\ndata: {"b"\ndata: :2}\n\ndata: {"c":3}'), ['{"a":1}', '{"b"\n:2}'], 'only complete events')
  a.deepEqual(findResponse('data: {"jsonrpc":"2.0","method":"notifications/progress"}\n\ndata: {"jsonrpc":"2.0","id":2,"result":{"ok":1}}\n\n',
    'text/event-stream', 2), { jsonrpc: '2.0', id: 2, result: { ok: 1 } })
  a.equal(findResponse('{"jsonrpc":"2.0","id":3,"result":{}}', 'application/json', 4), undefined)
  a.deepEqual(findResponse('[{"jsonrpc":"2.0","id":5,"result":7}]', 'application/json', 5).result, 7, 'a batch')

  // A remote server, scripted: session id, SSE answers, an expired session started again, 401 parsed.
  const seen = []
  let sessions = 0, expireOnce = true
  const remote = new RemoteClient({ url: 'https://mcp.test/mcp', auth: async () => ({ authorization: 'Bearer T' }), send: async (url, req) => {
    const m = JSON.parse(req.body)
    seen.push([m.method, req.headers['mcp-session-id'] ?? null, req.headers.authorization])
    if (m.method === 'initialize') return { status: 200, headers: { 'content-type': 'application/json', 'mcp-session-id': `S${++sessions}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: PROTOCOL, serverInfo: { name: 'w' } } }) }
    if (!m.id) return { status: 202, headers: {}, body: '' }
    if (m.method === 'tools/call' && expireOnce) { expireOnce = false; return { status: 404, headers: {}, body: '' } }
    const result = m.method === 'tools/list' ? (m.params.cursor ? { tools: [{ name: 'b' }] } : { tools: [{ name: 'a' }], nextCursor: 'c2' })
      : { content: [{ type: 'text', text: `called ${m.params.name}` }] }
    const body = `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: m.id, result })}\n\n`
    a.ok(req.until(body), 'the reader can stop once the answer is in')
    return { status: 200, headers: { 'content-type': 'text/event-stream' }, body }
  } })
  a.deepEqual((await remote.listTools()).map(t => t.name), ['a', 'b'], 'pages followed')
  a.deepEqual(await remote.callTool('a', {}), { content: [{ type: 'text', text: 'called a' }] })
  a.equal(sessions, 2, 'a forgotten session is started again')
  a.deepEqual(seen.slice(0, 3), [['initialize', null, 'Bearer T'], ['notifications/initialized', 'S1', 'Bearer T'], ['tools/list', 'S1', 'Bearer T']])
  const locked = new RemoteClient({ url: 'https://mcp.test/', send: async () => ({ status: 401,
    headers: { 'www-authenticate': 'Bearer resource_metadata="https://mcp.test/.well-known/oauth-protected-resource", scope="read write"' }, body: '' }) })
  await a.rejects(locked.listTools(), e => e.status === 401 && e.auth.resource_metadata === 'https://mcp.test/.well-known/oauth-protected-resource' && e.auth.scope === 'read write')

  // A local server over stdio: requests answered by id, a ping from it answered, a log line ignored, the exit reported.
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() {} })
  const stdio = new StdioClient(child, { timeout: 2000 })
  child.stdin.setEncoding('utf8')
  const lines = []
  child.stdin.on('data', d => {
    for (const l of String(d).split('\n').filter(Boolean)) {
      const m = JSON.parse(l); lines.push(m)
      if (m.method === 'initialize') child.stdout.write(`starting up…\n{"jsonrpc":"2.0","id":${m.id},"result":{"protocolVersion":"${PROTOCOL}"}}\n`)
      if (m.method === 'tools/list') child.stdout.write(`{"jsonrpc":"2.0","id":99,"method":"ping"}\n{"jsonrpc":"2.0","id":${m.id},"result":{"tools":[{"name":"x"}]}}\n`)
      if (m.method === 'tools/call' && !lines.some(x => x.method === 'tools/call' && x.id < m.id))     // the second one gets no answer
        child.stdout.write(`{"jsonrpc":"2.0","id":${m.id},"error":{"code":-32602,"message":"bad args"}}\n`)
    }
  })
  a.deepEqual((await stdio.listTools()).map(t => t.name), ['x'])
  await a.rejects(stdio.callTool('x', {}), /bad args \(-32602\)/)
  a.ok(lines.some(m => m.id === 99 && m.result), 'its ping is answered')
  const waiting = stdio.callTool('x', {})
  child.stderr.write('Error: missing API key\n')
  await new Promise(r => setTimeout(r, 10))
  child.emit('exit', 1)
  await a.rejects(waiting, /stopped \(exit 1\):\nError: missing API key/)

  a.deepEqual(parseWwwAuthenticate('Bearer error="invalid_token", resource_metadata="https://x/.well-known/oauth-protected-resource"'),
    { error: 'invalid_token', resource_metadata: 'https://x/.well-known/oauth-protected-resource' })
  a.equal(parseWwwAuthenticate('Basic realm="x"'), null)
  a.deepEqual(resourceMetadataUrls('https://api.test/v1/mcp'), ['https://api.test/.well-known/oauth-protected-resource/v1/mcp',
    'https://api.test/.well-known/oauth-protected-resource'])
  a.deepEqual(authServerMetadataUrls('https://auth.test'), ['https://auth.test/.well-known/oauth-authorization-server',
    'https://auth.test/.well-known/openid-configuration'])
  a.equal(authServerMetadataUrls('https://auth.test/tenant1')[0], 'https://auth.test/.well-known/oauth-authorization-server/tenant1')
  a.deepEqual(endpointsOf(null, 'https://mcp.test/mcp'), { issuer: 'https://mcp.test', authorize: 'https://mcp.test/authorize',
    token: 'https://mcp.test/token', register: 'https://mcp.test/register', scopes: [] }, 'a server from before discovery')
  a.equal(endpointsOf({ authorization_endpoint: 'https://a/x', token_endpoint: 'https://a/t' }, 'https://a').register, null)
  const { verifier, challenge } = pkce()
  a.ok(verifier.length >= 43 && challenge === createHash('sha256').update(verifier).digest('base64url'))
  const au = new URL(authorizeUrl({ authorize: 'https://a/authorize?tenant=1' }, { clientId: 'c', redirectUri: 'https://bot/oauth/callback',
    challenge, state: 's', resource: 'https://mcp.test/mcp', scope: 'read' }))
  a.deepEqual([au.searchParams.get('tenant'), au.searchParams.get('code_challenge_method'), au.searchParams.get('resource')],
    ['1', 'S256', 'https://mcp.test/mcp'])
  a.deepEqual(tokensFrom({ access_token: 'A', expires_in: 60 }, 1000, { refresh_token: 'R' }),
    { access_token: 'A', refresh_token: 'R', expires_at: 61_000, scope: null }, 'a refresh that sends no new refresh token keeps the old one')
  a.equal(tokensFrom({ error: 'invalid_grant' }), null)
  console.log('mcp: all checks pass')
}
