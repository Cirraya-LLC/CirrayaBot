// Secrets an agent can use without its model ever seeing them: an API key sent as a header, a
// password typed into a login page. Pure — server.mjs stores them, sends the requests and asks the
// person. `node web/secrets.mjs` is the self-test.
//
// What this is, plainly: the value never enters a model request, a stored message or an API
// response, and any tool output that echoes it is masked before the model reads it. What it is
// not: a wall against an agent that has been talked into exfiltrating — one that encodes the
// value, or sends it to a site of its own with curl from its machine, gets it out. Approvals
// (2.27) and the egress rules (2.36) are the controls for that.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { isIP } from 'node:net'

export const KINDS = ['header', 'login']
export const NAME_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/
export const VALUE_MAX = 8192
const HEADER_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/

/** A key from SECRET_KEY (64 hex characters, or base64 of 32 bytes). null = not a usable key. */
export function parseKey(text) {
  const t = String(text ?? '').trim()
  if (/^[0-9a-fA-F]{64}$/.test(t)) return Buffer.from(t, 'hex')
  const b = Buffer.from(t, 'base64')
  return t && b.length === 32 ? b : null
}
export const newKey = () => randomBytes(32).toString('hex')

/** AES-256-GCM: iv(12) | tag(16) | ciphertext, as base64. */
export function seal(key, value) {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([c.update(String(value), 'utf8'), c.final()])
  return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64')
}
export function open(key, sealed) {
  const b = Buffer.from(String(sealed), 'base64')
  const d = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12))
  d.setAuthTag(b.subarray(12, 28))
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8')
}

/** "https://api.github.com/x" → "https://api.github.com". Only https: a credential never goes over plain http. */
export function originOf(text) {
  let u
  try { u = new URL(String(text ?? '').trim()) } catch { return null }
  if (u.protocol !== 'https:' || !u.hostname) return null
  return u.origin
}

/** What a rejected secret is missing, for the agent (tool results are English); the API translates the code. */
export const NEEDS = {
  name: 'a name: letters, digits, _ . -, starting with a letter, at most 64',
  kind: `a kind: ${KINDS.join(' or ')}`,
  origin: 'the https site it may be used on, e.g. https://api.github.com',
  header: 'a header name, e.g. Authorization or X-Api-Key',
  format: 'a format containing {value}, e.g. "Bearer {value}" or just "{value}"',
  value: 'the value',
  shape: 'a value without line breaks, at most 8 KB',
}

/**
 * A secret as the person (or the agent's request) describes it. Returns the clean fields, or
 * { need } — a key of NEEDS — saying what's wrong. `value` is only required when `needValue`.
 */
export function checkSecret(b, { needValue = true } = {}) {
  const name = String(b?.name ?? '').trim()
  if (!NAME_RE.test(name)) return { need: 'name' }
  const kind = String(b?.kind ?? 'header').trim()
  if (!KINDS.includes(kind)) return { need: 'kind' }
  const origin = originOf(b?.origin)
  if (!origin) return { need: 'origin' }
  const header = String(b?.header || 'Authorization').trim()
  if (kind === 'header' && !HEADER_RE.test(header)) return { need: 'header' }
  const format = String(b?.format || 'Bearer {value}')
  if (kind === 'header' && (!format.includes('{value}') || format.length > 200 || /[\r\n]/.test(format))) return { need: 'format' }
  const value = b?.value == null ? '' : String(b.value)
  if (needValue && !value) return { need: 'value' }
  if (value.length > VALUE_MAX || /[\r\n]/.test(kind === 'header' ? value : '')) return { need: 'shape' }
  return { name, kind, origin, header: kind === 'header' ? header : '', format: kind === 'header' ? format : '', value }
}

/** The header a request carries for this secret. */
export const headerFor = (s, value) => [s.header, s.format.replace('{value}', value)]

/**
 * Mask every secret value that shows up in text the model is about to read. Short values are left
 * alone: masking every "1234" in a log would make tool output unreadable and protect nothing.
 */
export function redact(text, secrets) {
  if (typeof text !== 'string' || !secrets?.length) return text
  let out = text
  for (const s of secrets) if (s.value && s.value.length >= 6) out = out.split(s.value).join(`[secret ${s.name}]`)
  return out
}

/**
 * Addresses a request from the server must never reach: the server's own network (the database
 * container, the docker host, the LAN), loopback, link-local (cloud metadata at 169.254.169.254),
 * carrier-grade NAT, multicast, unspecified. The server can reach places an agent's machine can't.
 */
export function isPrivateAddress(ip) {
  const v = isIP(ip)
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number)
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) || a >= 224
  }
  if (v === 6) {
    const x = ip.toLowerCase()
    if (x === '::' || x === '::1') return true
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x)
    if (mapped) return isPrivateAddress(mapped[1])
    return /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || /^ff/.test(x)
  }
  return true            // not an address at all: refuse
}

// ---------- self-test ----------
if (import.meta.url === `file://${process.argv[1]}`) {
  const { strict: a } = await import('node:assert')
  const key = parseKey(newKey())
  a.equal(key.length, 32)
  a.equal(parseKey(Buffer.alloc(32, 7).toString('base64')).length, 32)
  a.equal(parseKey('short'), null)
  const sealed = seal(key, 'ghp_secret value ✓')
  a.notEqual(sealed.includes('ghp_secret'), true)
  a.equal(open(key, sealed), 'ghp_secret value ✓')
  a.throws(() => open(parseKey(newKey()), sealed), 'another key cannot open it')
  a.throws(() => open(key, sealed.slice(0, -4) + 'AAAA'), 'tampering is caught')

  a.equal(originOf('https://api.github.com/repos?x=1'), 'https://api.github.com')
  a.equal(originOf('https://example.com:443/'), 'https://example.com')
  a.equal(originOf('http://example.com'), null, 'never plain http')
  a.equal(originOf('github.com'), null)

  const ok = checkSecret({ name: 'GITHUB_TOKEN', origin: 'https://api.github.com/', value: 'ghp_x' })
  a.deepEqual(ok, { name: 'GITHUB_TOKEN', kind: 'header', origin: 'https://api.github.com', header: 'Authorization', format: 'Bearer {value}', value: 'ghp_x' })
  a.deepEqual(checkSecret({ name: '1bad', origin: 'https://x.com', value: 'v' }), { need: 'name' })
  a.deepEqual(checkSecret({ name: 'K', origin: 'https://x.com', value: 'a\nb' }), { need: 'shape' }, 'no header injection')
  a.deepEqual(checkSecret({ name: 'K', origin: 'https://x.com', value: 'v', format: 'Bearer' }), { need: 'format' })
  a.deepEqual(checkSecret({ name: 'K', origin: 'https://x.com', value: 'v', header: 'Bad Header' }), { need: 'header' })
  a.deepEqual(checkSecret({ name: 'K', origin: 'http://x.com', value: 'v' }), { need: 'origin' })
  a.equal(checkSecret({ name: 'PW', kind: 'login', origin: 'https://x.com', value: 'p\nw' }).value, 'p\nw', 'a password may be anything')
  a.deepEqual(checkSecret({ name: 'K', origin: 'https://x.com' }), { need: 'value' }, 'a value is needed')
  a.equal(checkSecret({ name: 'K', origin: 'https://x.com' }, { needValue: false }).name, 'K')
  for (const k of Object.keys(NEEDS)) a.ok(NEEDS[k])
  a.deepEqual(headerFor({ header: 'X-Api-Key', format: '{value}' }, 'abc'), ['X-Api-Key', 'abc'])

  const s = [{ name: 'TOKEN', value: 'ghp_abcdef123' }, { name: 'PIN', value: '1234' }]
  a.equal(redact('token is ghp_abcdef123, again ghp_abcdef123', s), 'token is [secret TOKEN], again [secret TOKEN]')
  a.equal(redact('pin 1234', s), 'pin 1234', 'short values are not masked')

  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.5', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', '224.0.0.1', 'db'])
    a.equal(isPrivateAddress(ip), true, ip)
  for (const ip of ['8.8.8.8', '140.82.112.3', '172.32.0.1', '2606:4700::1111'])
    a.equal(isPrivateAddress(ip), false, ip)
  console.log('secrets: all checks pass')
}
