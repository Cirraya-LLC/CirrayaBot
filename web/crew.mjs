// The film crew, built in: with the studio on, the platform has exactly four crew members —
// director, art director, cinematographer, reviewer — from studio/crew/ (the spec), from the first
// start on. The boss (2026-09-27): "把角色固定为导演、美术、摄影、审片，配好对应技能和默认参数，尽量简化做成开箱即用".
//
// - Seeded on start, only what is missing: an agent a person renamed, gave another persona or
//   another model is left as it is. `studio/crew/import.mjs` is still there to bring the text up
//   to the spec's latest.
// - The group and the skills are made once per database (settings `crew.group`); a group a person
//   later deleted is not brought back.
// - The four can't be deleted and the roles can't be moved (the studio's crew.set is no longer a
//   panel action): the pipeline hands work to a role, and a role nobody holds stalls every episode.
// - A member with no model gets the first of its candidates the upstream lists (pickModel), saved
//   on the agent so the editor shows it. A person's choice always wins, because it is only ever
//   filled when empty.
//
// Self-test: node web/crew.mjs
import { loadSpec } from '../studio/crew/import.mjs'

export const CREW_GROUP_NAME = '剧组'
const ID = /^crew-(director|art|cinematographer|reviewer)$/
export const isCrew = id => ID.test(String(id ?? ''))

let spec = null
/** The parsed spec, or null when the files are missing (a checkout without studio/crew/). */
export async function crewSpec() {
  if (spec === null) spec = await loadSpec().catch(e => { console.error(`Crew spec unreadable, no crew seeded: ${e.message}`); return false })
  return spec || null
}

/** The candidates for a crew member, in order ([] for anyone else). */
export async function candidatesFor(id) {
  if (!isCrew(id)) return []
  return (await crewSpec())?.agents.find(a => a.id === id)?.models ?? []
}

/** The same, synchronously, once the spec has been read (it is at startup when the studio is on). */
export const candidatesSync = id => (isCrew(id) && spec ? spec.agents.find(a => a.id === id)?.models ?? [] : [])

const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '')
/**
 * The first candidate the upstream has. Exact id first; otherwise a listed id that contains it once
 * punctuation is ignored ("anthropic/claude-opus-5.5" for claude-opus-5-5), the shortest such — a
 * relay's "-thinking" / dated variants are longer. Null when none is there: guessing a model the
 * upstream doesn't serve would only turn "pick a model" into a 404 later.
 */
export function pickModel(candidates, models) {
  if (!Array.isArray(models) || !models.length) return null
  for (const c of candidates) {
    if (models.includes(c)) return c
    const n = norm(c)
    const hits = models.filter(m => norm(m).includes(n)).sort((a, b) => a.length - b.length || a.localeCompare(b))
    if (hits.length) return hits[0]
  }
  return null
}

/**
 * Make sure the crew exists. `db` is web/db.mjs. → {created: [names], skills: n, group: id|null}
 */
export async function ensureCrew(db) {
  const s = await crewSpec()
  if (!s) return { created: [], skills: 0, group: null }
  const created = []
  const taken = new Set((await db.listAgents()).map(a => a.name.toLowerCase()))
  for (const [i, a] of s.agents.entries()) {
    if (await db.getAgent(a.id)) continue
    // A person may already have someone by this name; the crew member yields, the id is what counts.
    const name = taken.has(a.name.toLowerCase()) ? `${a.name}（${a.job.replace(/（.*$/, '')}）` : a.name
    await db.upsertAgent({ id: a.id, name, description: a.job, persona: a.persona, ord: i, color: db.nextColor(i),
      model: '', effort: a.effort, max_steps: a.max_steps })
    taken.add(name.toLowerCase()); created.push(name)
  }
  const ids = s.agents.map(a => a.id)

  // Once per database: the skills installed, the group made. Someone uninstalling a skill or
  // disbanding the group later is a choice, not damage to repair on every start.
  if (await db.getSetting('crew.seeded')) return { created, skills: 0, group: await db.getSetting('crew.group') }
  let skills = 0
  for (const k of s.skills) {
    const on = s.agents.filter(a => a.skills.includes(k.name)).map(a => a.id)
    const cur = await db.skillByName(k.name)
    if (!cur) await db.saveSkill({ id: `k${Date.now().toString(36)}${skills}`, name: k.name, description: k.description, body: k.body, agents: on, source: 'human' })
    else if (on.some(id => !cur.agents.includes(id))) await db.saveSkill({ ...cur, agents: [...new Set([...cur.agents, ...on])] })
    else continue
    skills++
  }
  const lead = s.agents.find(a => a.lead)?.id ?? null
  // An earlier `import.mjs` run made a 剧组 already: adopt it rather than making a second one.
  let g = (await db.listGroups()).find(x => x.name === CREW_GROUP_NAME && ids.every(id => x.members.includes(id)))
  if (!g) g = await db.saveGroup({ id: `g${Date.now().toString(36)}`, name: CREW_GROUP_NAME, members: ids, lead, shared_machine: true })
  await db.setSetting('crew.group', g.id)
  await db.setSetting('crew.seeded', new Date().toISOString())
  return { created, skills, group: g.id }
}

/** The crew group's id, if it still exists. */
export async function crewGroup(db) {
  const id = await db.getSetting('crew.group')
  return id && (await db.listGroups()).some(g => g.id === id) ? id : null
}

// ---------- self-test ----------
if (import.meta.url === `file://${process.argv[1]}`) {
  const a = (await import('node:assert/strict')).default
  a.equal(pickModel(['claude-opus-5-5', 'deepseek-flash'], ['deepseek-flash', 'claude-opus-5-5']), 'claude-opus-5-5', 'order is the spec\'s, not the list\'s')
  a.equal(pickModel(['claude-opus-5-5', 'deepseek-flash'], ['gpt-6-astra', 'deepseek-flash']), 'deepseek-flash', 'the budget one when the first is missing')
  a.equal(pickModel(['claude-opus-5-5'], ['anthropic/claude-opus-5.5', 'anthropic/claude-opus-5.5-thinking']), 'anthropic/claude-opus-5.5', 'a relay\'s spelling, the plain variant')
  a.equal(pickModel(['gpt-5.6-sol'], ['gpt-5.6-sol-2026-08-01', 'gpt-5.6']), 'gpt-5.6-sol-2026-08-01')
  a.equal(pickModel(['claude-sonnet-5'], ['gpt-5.5']), null, 'nothing that matches → nothing guessed')
  a.equal(pickModel(['x'], null), null, 'an upstream that doesn\'t list models')
  a.equal(isCrew('crew-director'), true); a.equal(isCrew('crew-directorx'), false); a.equal(isCrew('chief'), false)
  a.deepEqual(await candidatesFor('crew-reviewer'), ['claude-opus-5-5', 'gpt-5.6-sol'])
  a.deepEqual(await candidatesFor('chief'), [])

  // ensureCrew against an in-memory db with the functions it uses
  const mem = { agents: [], groups: [], skills: [], settings: {} }
  const db = {
    listAgents: async () => mem.agents, getAgent: async id => mem.agents.find(x => x.id === id) ?? null,
    upsertAgent: async x => { mem.agents = mem.agents.filter(y => y.id !== x.id).concat(x); return x }, nextColor: () => '#000000',
    getSetting: async k => mem.settings[k] ?? null, setSetting: async (k, v) => { mem.settings[k] = v },
    skillByName: async n => mem.skills.find(k => k.name.toLowerCase() === n.toLowerCase()) ?? null,
    saveSkill: async k => { mem.skills = mem.skills.filter(y => y.id !== k.id).concat(k); return k },
    listGroups: async () => mem.groups, saveGroup: async g => { mem.groups.push(g); return g },
  }
  mem.agents.push({ id: 'someone', name: '严青' })          // a person already has a 严青
  mem.skills.push({ id: 'k0', name: 'studio-basics', agents: ['someone'] })
  const r1 = await ensureCrew(db)
  a.deepEqual(r1.created, ['顾衡', '苏棠', '林野', '严青（审片 / 场记）'])
  const dir = mem.agents.find(x => x.id === 'crew-director')
  a.equal(dir.model, ''); a.equal(dir.effort, 'high'); a.equal(dir.max_steps, 30); a.match(dir.persona, /^你是顾衡/)
  a.equal(mem.groups.length, 1); a.equal(mem.groups[0].lead, 'crew-director'); a.equal(mem.groups[0].shared_machine, true)
  a.deepEqual(mem.skills.find(k => k.name === 'studio-basics').agents, ['someone', 'crew-director', 'crew-art', 'crew-cinematographer', 'crew-reviewer'], 'an existing skill is installed on the crew too, keeping who had it')
  a.deepEqual(mem.skills.find(k => k.name === 'footage-review').agents, ['crew-reviewer'])
  // A person's edits survive a restart; a deleted group isn't brought back.
  dir.name = '老顾'; dir.model = 'my-model'; mem.groups.length = 0
  const r2 = await ensureCrew(db)
  a.deepEqual(r2.created, []); a.equal(dir.name, '老顾'); a.equal(dir.model, 'my-model'); a.equal(mem.groups.length, 0)
  a.equal(await crewGroup(db), null)
  // A member deleted behind the platform's back (straight in the database) comes back.
  mem.agents = mem.agents.filter(x => x.id !== 'crew-art')
  a.deepEqual((await ensureCrew(db)).created, ['苏棠'])
  console.log('crew.mjs: all checks passed')
}
