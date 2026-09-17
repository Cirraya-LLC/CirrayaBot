// Server-side messages in three languages: English (default), Simplified and
// Traditional Chinese. Each entry is [en, zh-Hans, zh-Hant]; `{name}` in the
// text is replaced from `vars`.
//
// The language comes from the request (`X-Lang` header, or `?lang=` where a
// header cannot be set — <img>, WebSocket). Anything that runs without a
// request (routines, startup) speaks English.
//
// Self-test: node web/i18n.mjs

import { serverStrings } from './strings/server.mjs'
import { coreStrings } from './strings/core.mjs'

export const LANGS = ['en', 'zh-Hans', 'zh-Hant']

// server.mjs owns strings/server.mjs; the smaller modules (schedule, db,
// model, protocols) own strings/core.mjs. Keys are prefixed by area.
const M = { ...serverStrings, ...coreStrings }

/** Pick the request's language; unknown or missing means English. */
export function langOf(req, url) {
  const raw = String(req?.headers?.['x-lang'] ?? url?.searchParams?.get('lang') ?? '')
  return LANGS.includes(raw) ? raw : 'en'
}

export function tr(lang, key, vars = {}) {
  const row = M[key]
  if (!row) return key
  const text = row[Math.max(0, LANGS.indexOf(lang))] || row[0]
  return text.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m))
}

/** An error meant for a person: rendered in their language where it is sent. */
export class Say extends Error {
  constructor(key, vars = {}, status = 400) {
    super(tr('en', key, vars))
    this.key = key
    this.vars = vars
    this.status = status
  }
  text(lang) { return tr(lang, this.key, this.vars) }
}

/** The message of any error, in `lang` when it is a Say. */
export const errorText = (e, lang) => (e instanceof Say ? e.text(lang) : String(e?.message ?? e))

if (import.meta.url === `file://${process.argv[1]}`) {
  const dup = Object.keys(serverStrings).filter(k => k in coreStrings)
  if (dup.length) throw new Error(`self-test: defined twice: ${dup.join(', ')}`)
  for (const [k, v] of Object.entries(M))
    if (!Array.isArray(v) || v.length !== 3 || v.some(s => typeof s !== 'string' || !s)) throw new Error(`self-test: ${k} needs three translations`)
  console.log(`i18n.mjs self-test passed (${Object.keys(M).length} messages)`)
}
