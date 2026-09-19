// Reading and writing SKILL.md. Same format as dsh / Claude Code skills, so skills
// written elsewhere import as-is:
//
//   ---
//   name: weekly-report
//   description: Use when the user asks for a weekly report or weekly summary
//   ---
//   Body (Markdown): steps, decision rules, what to deliver, what to ask a person first
//
// Self-test: node web/skill.mjs

import { Say } from './i18n.mjs'

export const LIMITS = { name: 60, description: 300, body: 20_000 }

/** Validate a skill's three fields and return them tidied; throws a readable Say if invalid. */
export function checkSkill({ name, description, body }) {
  name = String(name ?? '').trim()
  description = String(description ?? '').trim()
  body = String(body ?? '').trim()
  if (!name) throw new Say('skill.nameRequired')
  if (name.length > LIMITS.name) throw new Say('skill.nameTooLong', { max: LIMITS.name })
  if (/[\n\r]/.test(name)) throw new Say('skill.nameNewline')
  // "When to use" is the only thing the Agent decides on whether to read the body;
  // left empty, the skill will never be remembered.
  if (!description) throw new Say('skill.descriptionRequired')
  if (description.length > LIMITS.description) throw new Say('skill.descriptionTooLong', { max: LIMITS.description })
  if (!body) throw new Say('skill.bodyRequired')
  if (body.length > LIMITS.body) throw new Say('skill.bodyTooLong', { max: LIMITS.body })
  return { name, description: description.replace(/\s+/g, ' '), body }
}

const unquote = v => {
  v = v.trim()
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
  return v
}

/** SKILL.md text → {name, description, body}. No frontmatter means body only; the caller supplies the name. */
export function parseSkillMd(text) {
  const t = String(text ?? '').replace(/^﻿/, '').replace(/\r\n/g, '\n')
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(t)
  if (!m) return { name: '', description: '', body: t.trim() }
  const meta = {}
  // Only flat `key: value` (all dsh and Claude Code skills use); a multi-line description (>- / |) is joined into one line
  let key = null
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line)
    if (kv) { key = kv[1]; meta[key] = /^[>|]-?$/.test(kv[2].trim()) ? '' : unquote(kv[2]); continue }
    if (key && /^\s+\S/.test(line)) meta[key] = `${meta[key]} ${line.trim()}`.trim()
  }
  return { name: meta.name ?? '', description: meta.description ?? '', body: m[2].trim() }
}

/** {name, description, body} → SKILL.md text. Values with colons or quotes get quoted so they read back unchanged. */
export function toSkillMd({ name, description, body }) {
  const q = v => (/[:#"'\n]|^\s|\s$/.test(v) ? JSON.stringify(v) : v)
  return `---\nname: ${q(name)}\ndescription: ${q(description)}\n---\n\n${body.trim()}\n`
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const a = (c, m) => { if (!c) throw new Error('self-test failed: ' + m) }
  const md = '---\nname: weekly-report\ndescription: "Use for: weekly reports or summaries"\n---\n\n1. Read git log\n2. Write three lines\n'
  const k = parseSkillMd(md)
  a(k.name === 'weekly-report' && k.description === 'Use for: weekly reports or summaries' && k.body === '1. Read git log\n2. Write three lines', 'basic parse')
  const back = parseSkillMd(toSkillMd(k))
  a(back.name === k.name && back.description === k.description && back.body === k.body, 'writing out and reading back must round-trip')
  const folded = parseSkillMd('---\nname: pdf\ndescription: >-\n  Handle PDF files\n  including split and merge\nlicense: MIT\n---\nbody')
  a(folded.description === 'Handle PDF files including split and merge', `multi-line description joins into one line, got "${folded.description}"`)
  a(parseSkillMd('body without a header').body === 'body without a header', 'readable without frontmatter')
  a(parseSkillMd('﻿---\r\nname: x\r\ndescription: y\r\n---\r\nz').name === 'x', 'BOM and CRLF')
  let threw = false
  try { checkSkill({ name: 'x', description: '', body: 'y' }) } catch { threw = true }
  a(threw, 'missing "when to use" must be rejected')
  console.log('skill.mjs self-test passed')
}
