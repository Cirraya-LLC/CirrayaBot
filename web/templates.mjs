// Templates: agents and skills to start from. Shipped ones live in templates/ (agents/*.json, skills/*.md); any
// agent can be exported as a template file and imported elsewhere. A template carries what makes the agent
// itself — name, job, persona, how it asks, its setup script, its skills, its goals — and never an upstream, a
// model, a memory or a secret: the person picks the model, and the rest belongs to the deployment it came from.
//
// Pure apart from loading the shipped files. `node web/templates.mjs` is the self-test.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkSkill, parseSkillMd } from './skill.mjs'
import { APPROVAL_MODES } from './approve.mjs'
import { CHECKIN_EVERY, GOALS_MAX } from './tasks.mjs'

export const FORMAT = 'cirrayabot-agent'
export const LANGS = ['en', 'zh-Hans', 'zh-Hant']
const SETUP_MAX = 20_000
const MAX_SKILLS = 20

/** A localized field ({en, zh-Hans, zh-Hant}) or a plain string, in one language (English when it has none). */
export const pick = (v, lang = 'en') => typeof v === 'string' ? v : String(v?.[lang] ?? v?.en ?? Object.values(v ?? {})[0] ?? '')

/** The shipped skill templates: {id (file name), name, description, body}. */
export function loadSkillTemplates(dir) {
  const out = []
  for (const f of safeList(dir).filter(f => f.endsWith('.md')).sort()) {
    try { out.push({ id: f.replace(/\.md$/, ''), ...checkSkill(parseSkillMd(readFileSync(join(dir, f), 'utf8'))) }) }
    catch (e) { console.warn(`[templates] skipping skills/${f}: ${e.message}`) }
  }
  return out
}

/** The shipped agent templates, checked, their skill names resolved against the skill templates. */
export function loadAgentTemplates(dir, skills) {
  const out = []
  for (const f of safeList(dir).filter(f => f.endsWith('.json')).sort()) {
    try { out.push(checkTemplate(JSON.parse(readFileSync(join(dir, f), 'utf8')), skills)) }
    catch (e) { console.warn(`[templates] skipping agents/${f}: ${e.message}`) }
  }
  return out
}
const safeList = dir => { try { return readdirSync(dir) } catch { return [] } }

/**
 * A template — shipped or from a file someone imported — checked and tidied. Throws Error(field) when it isn't one.
 * Skills may be names of shipped skill templates (resolved against `known`) or {name, description, body}.
 */
export function checkTemplate(doc, known = []) {
  const bad = what => { throw Object.assign(new Error(what), { field: what }) }
  if (!doc || typeof doc !== 'object' || doc.format !== FORMAT) bad('format')
  if (!(Number(doc.version) >= 1)) bad('version')
  const localized = v => typeof v === 'string' ? v.trim()
    : v && typeof v === 'object' ? Object.fromEntries(LANGS.filter(l => typeof v[l] === 'string').map(l => [l, v[l].trim()])) : ''
  const name = localized(doc.name)
  if (!pick(name)) bad('name')
  if (pick(name).length > 40) bad('name')
  const persona = String(doc.persona ?? '').trim()
  if (!persona) bad('persona')
  const setup = String(doc.setup ?? '').replace(/\r\n?/g, '\n')
  if (setup.length > SETUP_MAX) bad('setup')
  const goals = String(doc.goals ?? '').trim()
  if (goals.length > GOALS_MAX) bad('goals')
  const checkin_every = Number(doc.checkin_every ?? 0)
  if (!CHECKIN_EVERY.includes(checkin_every)) bad('checkin_every')
  const approval = String(doc.approval ?? '')
  if (approval && !APPROVAL_MODES.includes(approval)) bad('approval')
  const autonomy = String(doc.autonomy ?? '')
  if (autonomy && !['auto', 'manual'].includes(autonomy)) bad('autonomy')
  const color = /^#[0-9a-fA-F]{6}$/.test(String(doc.color ?? '')) ? doc.color : null
  if (!Array.isArray(doc.skills ?? []) || (doc.skills ?? []).length > MAX_SKILLS) bad('skills')
  const skills = (doc.skills ?? []).map(s => {
    if (typeof s === 'string') {
      const k = known.find(x => x.id === s || x.name === s)
      if (!k) bad('skills')
      return { name: k.name, description: k.description, body: k.body }
    }
    try { return checkSkill(s) } catch { bad('skills') }
  })
  return {
    format: FORMAT, version: 1, ...doc.id ? { id: String(doc.id) } : {},
    name, description: localized(doc.description), ...doc.note ? { note: localized(doc.note) } : {},
    persona, color, approval, autonomy, setup: setup.trim() ? setup : '', goals, checkin_every, skills,
  }
}

/** A template in one language, for a list or an editor to start from. */
export const forLang = (t, lang) => ({ ...t, name: pick(t.name, lang), description: pick(t.description, lang),
  ...t.note ? { note: pick(t.note, lang) } : {} })

/** An agent as a template file: what makes it itself, never its model, memory or secrets. */
export function templateOf(agent, skills) {
  return {
    format: FORMAT, version: 1,
    name: agent.name, description: agent.description ?? '', persona: agent.persona ?? '', color: agent.color ?? null,
    approval: agent.approval ?? '', autonomy: agent.autonomy ?? '', setup: agent.setup ?? '',
    goals: agent.goals ?? '', checkin_every: Number(agent.checkin_every) || 0,
    skills: skills.map(s => ({ name: s.name, description: s.description, body: s.body })),
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { strict: a } = await import('node:assert')
  const root = new URL('../templates/', import.meta.url).pathname
  const skills = loadSkillTemplates(join(root, 'skills'))
  const agents = loadAgentTemplates(join(root, 'agents'), skills)
  a.ok(skills.length >= 6 && agents.length >= 6, 'the shipped templates all load')
  for (const t of agents) {
    a.ok(t.skills.length && t.skills.every(s => s.body), `${t.id}: skills resolved`)
    for (const l of LANGS) a.ok(pick(t.name, l) && pick(t.description, l), `${t.id}: name and description in ${l}`)
    a.ok(!('model' in t) && !('provider_id' in t), 'never a model')
  }
  a.equal(forLang(agents.find(t => t.id === 'researcher'), 'zh-Hans').name, '研究员')

  // Files someone imports
  const throwsField = (doc, field) => a.throws(() => checkTemplate(doc, skills), e => e.field === field)
  throwsField({ format: 'other' }, 'format')
  throwsField({ format: FORMAT, version: 1, persona: 'x' }, 'name')
  throwsField({ format: FORMAT, version: 1, name: 'X' }, 'persona')
  throwsField({ format: FORMAT, version: 1, name: 'X', persona: 'p', checkin_every: 45 }, 'checkin_every')
  throwsField({ format: FORMAT, version: 1, name: 'X', persona: 'p', skills: ['no-such-skill'] }, 'skills')
  throwsField({ format: FORMAT, version: 1, name: 'X', persona: 'p', skills: [{ name: 'k' }] }, 'skills')
  const t = checkTemplate({ format: FORMAT, version: 1, name: 'Kim', persona: 'You are Kim.', model: 'gpt-x', provider_id: 'p1',
    skills: ['web-research', { name: 'mine', description: 'When asked', body: 'Do it.' }] }, skills)
  a.ok(!('model' in t) && !('provider_id' in t), 'a model in a file is dropped')
  a.deepEqual(t.skills.map(s => s.name), ['web-research', 'mine'])

  // Export → import gives the same agent back.
  const agent = { name: 'Kim', description: 'Job', persona: 'P', color: '#123456', approval: 'match', autonomy: '', setup: 'echo hi',
    goals: 'Watch x', checkin_every: 240, model: 'secret-model', provider_id: 'p' }
  const doc = templateOf(agent, [{ name: 'mine', description: 'When asked', body: 'Do it.', agents: ['kim'] }])
  a.ok(!JSON.stringify(doc).includes('secret-model'), 'export carries no model')
  const back = checkTemplate(JSON.parse(JSON.stringify(doc)))
  a.deepEqual([back.name, back.persona, back.setup, back.goals, back.checkin_every, back.skills[0].body], ['Kim', 'P', 'echo hi', 'Watch x', 240, 'Do it.'])
  console.log('templates: all checks pass')
}
