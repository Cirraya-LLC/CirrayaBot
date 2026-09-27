// Password hashing and short-lived browser sessions for the optional web login.
// Format and work factor are versioned so they can be upgraded without ambiguity.
import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scryptAsync = promisify(scrypt)
const N = 2 ** 14
const R = 8
const P = 5
const KEY_BYTES = 64
const MAXMEM = 64 * 1024 * 1024
export const SESSION_MAX_AGE = 7 * 24 * 60 * 60

function parsePasswordHash(encoded) {
  const m = /^scrypt\.v1\.16384\.8\.5\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(String(encoded ?? ''))
  if (!m) return null
  const salt = Buffer.from(m[1], 'base64url')
  const key = Buffer.from(m[2], 'base64url')
  if (salt.length !== 16 || salt.toString('base64url') !== m[1] ||
      key.length !== KEY_BYTES || key.toString('base64url') !== m[2]) return null
  return { salt, key }
}

export function isPasswordHash(encoded) {
  return parsePasswordHash(encoded) !== null
}

export async function hashPassword(password, salt = randomBytes(16)) {
  const key = await scryptAsync(String(password), salt, KEY_BYTES, { N, r: R, p: P, maxmem: MAXMEM })
  return `scrypt.v1.${N}.${R}.${P}.${salt.toString('base64url')}.${Buffer.from(key).toString('base64url')}`
}

export async function verifyPassword(password, encoded) {
  const parsed = parsePasswordHash(encoded)
  if (!parsed || typeof password !== 'string' || password.length > 1024) return false
  const actual = Buffer.from(await scryptAsync(password, parsed.salt, KEY_BYTES, { N, r: R, p: P, maxmem: MAXMEM }))
  return timingSafeEqual(parsed.key, actual)
}

const sessionMac = (payload, secret) => createHmac('sha256', secret)
  .update(`cirrayabot-web-session-v1:${payload}`)
  .digest('base64url')

export function makePasswordSession(passwordHash, now = Date.now()) {
  const issued = String(Math.floor(now / 1000))
  const nonce = randomBytes(24).toString('base64url')
  const payload = `${issued}.${nonce}`
  return `${payload}.${sessionMac(payload, passwordHash)}`
}

export function verifyPasswordSession(value, passwordHash, now = Date.now()) {
  if (!passwordHash) return false
  const m = /^(\d{10})\.([A-Za-z0-9_-]{32})\.([A-Za-z0-9_-]{43})$/.exec(String(value ?? ''))
  if (!m) return false
  const issuedAt = Number(m[1])
  const nowSeconds = Math.floor(now / 1000)
  if (!Number.isSafeInteger(issuedAt) || issuedAt > nowSeconds + 30 || nowSeconds - issuedAt > SESSION_MAX_AGE) return false
  const payload = `${m[1]}.${m[2]}`
  const actual = Buffer.from(m[3], 'base64url')
  const expected = Buffer.from(sessionMac(payload, passwordHash), 'base64url')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const a = (condition, label) => { if (!condition) throw new Error(`password self-test failed: ${label}`) }
  const salt = Buffer.alloc(16, 7)
  const hash = await hashPassword('test-password-with-enough-entropy', salt)
  a(isPasswordHash(hash), 'hash format')
  a(await verifyPassword('test-password-with-enough-entropy', hash), 'correct password')
  a(!(await verifyPassword('wrong-password', hash)), 'wrong password')
  const now = 1_800_000_000_000
  const session = makePasswordSession(hash, now)
  a(verifyPasswordSession(session, hash, now), 'valid session')
  a(!verifyPasswordSession(session, hash + 'changed', now), 'session invalidated after password rotation')
  a(!verifyPasswordSession(session, hash, now + (SESSION_MAX_AGE + 1) * 1000), 'expired session')
  console.log('password.mjs self-test passed')
}
