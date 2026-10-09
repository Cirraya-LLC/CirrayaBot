// Configuration comes only from process.env. The .env file is a FALLBACK for it, not
// the other way round — in containers values come from compose's `environment`, when
// running locally from .env; on conflict the real environment variable wins (12-factor).
//
// This module is all side effect: the moment it is imported, .env is loaded into
// process.env. db.mjs imports it too, so DATABASE_URL is set before the pool is built.
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

const file = join(ROOT, '.env')
// MA_DOTENV=off: ignore .env entirely. The end-to-end tests set it — a test run that picks up the
// real WORKSPACE_HOST_PATH or DATABASE_URL from a developer's .env writes into their real data.
if (process.env.MA_DOTENV !== 'off' && existsSync(file)) {
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!m) continue
    const v = m[2].trim().replace(/^(['"])(.*)\1$/, '$2')
    if (process.env[m[1]] === undefined || process.env[m[1]] === '') process.env[m[1]] = v
  }
}

export const env = process.env
