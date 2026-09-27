// Import the film crew into a running deployment: 4 agents, 5 skills, one group, the studio roles.
//
//   docker compose exec app node studio/crew/import.mjs              # inside the app container
//   docker compose exec app node studio/crew/import.mjs --dry-run    # print the plan, change nothing
//   node studio/crew/import.mjs --url http://host:8080 --token <ACCESS_TOKEN>   # from anywhere
//   options: --group <name> (default 剧组)
//
// It goes through the platform's HTTP API — the same validation as the UI, nothing written behind
// its back. Safe to run again: agents are matched by id (crew-<role>) and only their name, job and
// persona are updated — **never the upstream or model a person chose**; skills are matched by name.
// The platform already seeds this crew on its first start with the studio on (web/crew.mjs); this
// script is for bringing an existing crew up to the spec's latest text. Agents are created without a
// model: the platform picks the first of the spec's candidates the upstream lists, until a person
// picks one.
//
// Self-test: node studio/crew/import.mjs --self-test (parses the spec files next to it)
import { readFile, readdir } from 'node:fs/promises'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSkillMd } from '../../web/skill.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROLES = ['director', 'art', 'cinematographer', 'reviewer']

/** One agents/<role>.md → {role, name, job, persona, skills, lead, upstream}. */
export function parseAgent(md, role) {
  const head = md.match(/^#\s+(.+?)\s+—\s+(.+)$/m)
  if (!head) throw new Error(`${role}.md: the first heading must be "# <name> — <job>"`)
  const field = k => (md.match(new RegExp(`^-\\s*\\*\\*${k}\\*\\*[:：]\\s*(.+)$`, 'm'))?.[1] ?? '').trim()
  const start = md.search(/^##\s+性格描述/m)
  if (start < 0) throw new Error(`${role}.md has no "## 性格描述" section`)
  const rest = md.slice(start).split('\n').slice(1).join('\n')
  const end = rest.search(/^##\s/m)
  const persona = (end < 0 ? rest : rest.slice(0, end)).trim()
  if (!persona) throw new Error(`${role}.md: the persona section is empty`)
  const list = s => s.split(/[,，、]/).map(x => x.trim()).filter(Boolean)
  const effort = field('推理强度')
  if (effort && !['low', 'medium', 'high'].includes(effort)) throw new Error(`${role}.md: 推理强度 must be low / medium / high`)
  const steps = field('步数上限')
  if (steps && !(Number(steps) >= 1 && Number(steps) <= 60)) throw new Error(`${role}.md: 步数上限 must be 1–60`)
  return {
    role, id: `crew-${role}`, name: head[1].trim(), job: head[2].trim(), persona,
    skills: list(field('Skills')),
    lead: field('群角色') === '组长', upstream: field('建议上游'),
    // Defaults a new member starts with; a person's later choice always wins.
    models: list(field('模型候选')), effort, max_steps: steps ? Number(steps) : null,
  }
}

export async function loadSpec(dir = HERE) {
  const agents = []
  for (const role of ROLES) agents.push(parseAgent(await readFile(join(dir, 'agents', `${role}.md`), 'utf8'), role))
  const skills = []
  for (const d of (await readdir(join(dir, 'skills'), { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name).sort()) {
    const text = await readFile(join(dir, 'skills', d, 'SKILL.md'), 'utf8')
    const k = parseSkillMd(text)
    skills.push({ ...k, name: k.name || d, text })
  }
  for (const a of agents) for (const s of a.skills)
    if (!skills.some(k => k.name === s)) throw new Error(`${a.name} lists the skill "${s}", but skills/${s}/SKILL.md doesn't exist`)
  return { agents, skills }
}

function args(argv) {
  const o = { dryRun: false, group: '剧组' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') o.dryRun = true
    else if (a === '--self-test') o.selfTest = true
    else if (['--url', '--token', '--group'].includes(a)) o[a.slice(2)] = argv[++i]
    else throw new Error(`unknown option ${a}`)
  }
  o.url = (o.url || `http://127.0.0.1:${process.env.WEB_PORT || 8080}`).replace(/\/+$/, '')
  o.token = o.token ?? process.env.ACCESS_TOKEN ?? ''
  return o
}

async function main(o) {
  const { agents, skills } = await loadSpec()
  const call = async (method, path, body) => {
    const res = await fetch(`${o.url}${path}${o.token ? `${path.includes('?') ? '&' : '?'}k=${encodeURIComponent(o.token)}` : ''}`, {
      method, headers: { 'content-type': 'application/json', 'x-lang': 'zh-Hans' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await res.text()
    let j; try { j = JSON.parse(text) } catch { j = text }
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${j?.error ?? text}`.slice(0, 400))
    return j
  }
  const plan = []
  const act = async (what, fn) => { plan.push(what); if (!o.dryRun) await fn() }

  // ---- agents ----
  const bots = await call('GET', '/api/bots')
  for (const a of agents) {
    const clash = bots.find(b => b.name.toLowerCase() === a.name.toLowerCase() && b.id !== a.id)
    if (clash) throw new Error(`an agent named ${a.name} already exists (id ${clash.id}) and isn't the crew's ${a.role}; rename or delete it first`)
    const cur = bots.find(b => b.id === a.id)
    if (cur) await act(`update agent ${a.name} (${a.id}): name, job, persona — upstream and model kept`, () =>
      call('PATCH', `/api/bots/${a.id}`, { name: a.name, description: a.job, persona: a.persona }))
    else await act(`create agent ${a.name} (${a.id}) — effort ${a.effort || '—'}, ${a.max_steps ?? 12} steps, model picked from: ${a.models.join(', ')}`, () =>
      call('POST', '/api/bots', { id: a.id, name: a.name, description: a.job, persona: a.persona, model: '', effort: a.effort, max_steps: a.max_steps }))
  }

  // ---- skills, installed on whoever lists them ----
  const have = await call('GET', '/api/skills')
  for (const k of skills) {
    const on = agents.filter(a => a.skills.includes(k.name)).map(a => a.id)
    const cur = have.find(x => x.name.toLowerCase() === k.name.toLowerCase())
    if (cur) await act(`update skill ${k.name}, installed on ${on.join(', ')}`, () =>
      call('PATCH', `/api/skills/${cur.id}`, { description: k.description, body: k.body, agents: [...new Set([...cur.agents, ...on])] }))
    else await act(`add skill ${k.name}, installed on ${on.join(', ')}`, () =>
      call('POST', '/api/skills/import', { text: k.text, name: k.name, agents: on }))
  }

  // ---- the group, with the director as its lead ----
  const ids = agents.map(a => a.id)
  const lead = agents.find(a => a.lead)?.id ?? null
  const g = (await call('GET', '/api/groups')).find(x => x.name === o.group)
  let groupId = g?.id ?? '(new)'
  if (g) await act(`update group ${o.group}: add the crew, lead ${lead}`, () =>
    call('PATCH', `/api/groups/${g.id}`, { members: [...new Set([...g.members, ...ids])], lead }))
  // A new crew group shares one machine (the crew passes files all day). An existing group keeps
  // whatever a person set — like the models, it is theirs to choose.
  else await act(`create group ${o.group} with the crew, lead ${lead}, one shared machine`, async () => {
    groupId = (await call('POST', '/api/groups', { name: o.group, members: ids, lead, shared_machine: true })).id
  })

  // ---- studio roles ----
  const studio = await call('GET', '/api/studio/status')
  if (studio.enabled) for (const a of agents)
    await act(`studio role: ${a.name} → ${a.role}`, () => call('POST', '/api/studio/call', { action: 'crew.set', args: { agent_id: a.id, role: a.role } }))
  else plan.push('studio not configured on this deployment — roles skipped (rerun after it is up)')

  console.log(`${o.dryRun ? 'Would do' : 'Done'}:\n${plan.map(p => `  - ${p}`).join('\n')}`)
  console.log(`\nGroup: ${o.group} (${groupId})`)
  console.log('\nA member without a model gets the first of its candidates that its upstream lists; pick another in Edit Agent any time:')
  for (const a of agents) console.log(`  - ${a.name}: ${a.models.join(' → ') || '—'} (${a.upstream || '—'})`)
}

// ---------- self-test ----------
async function selfTest() {
  const a = await import('node:assert/strict')
  const { agents, skills } = await loadSpec()
  a.deepEqual(agents.map(x => [x.name, x.role]), [['顾衡', 'director'], ['苏棠', 'art'], ['林野', 'cinematographer'], ['严青', 'reviewer']])
  a.deepEqual(agents.map(x => x.job), ['导演（组长）', '美术指导', '摄影指导', '审片 / 场记'])
  a.deepEqual(agents.filter(x => x.lead).map(x => x.name), ['顾衡'], 'the director is the group lead')
  a.deepEqual(agents.map(x => x.skills), [['studio-basics', 'shot-breakdown'], ['studio-basics', 'character-bible'],
    ['studio-basics', 'shot-prompting'], ['studio-basics', 'footage-review']])
  for (const x of agents) {
    a.ok(x.persona.startsWith(`你是${x.name}`), `${x.name}: the persona is the pasted part, starting "你是${x.name}"`)
    a.ok(!/建议上游|Skills/.test(x.persona), `${x.name}: the header lines are not part of the persona`)
    a.ok(x.persona.includes('协作规则'), `${x.name}: the collaboration rules are kept`)
  }
  a.match(agents[3].upstream, /图片输入/, 'the reviewer\'s "must accept images" note is surfaced')
  a.deepEqual(skills.map(k => k.name), ['character-bible', 'footage-review', 'shot-breakdown', 'shot-prompting', 'studio-basics'])
  for (const k of skills) { a.ok(k.description.length > 20 && k.description.length <= 300); a.ok(k.body.length > 200) }
  // The spec says what was built: the studio tool, not a CLI in the container; the 3rd rejection is the studio's.
  const basics = skills.find(k => k.name === 'studio-basics').body
  a.match(basics, /`studio` 工具/); a.doesNotMatch(basics, /容器里的 `studio` 命令/)
  a.match(basics, /scene add/)
  a.doesNotMatch(agents[3].persona, /直接 @ 人类/)
  // Work reaches people as work orders (2.31): nobody is told to hand work over with an @.
  a.match(basics, /片场工单/); a.match(basics, /episode submit/)
  for (const x of agents) a.doesNotMatch(x.persona, /@(苏棠|林野|顾衡|严青)/, `${x.name}: no @-relay handoffs left in the persona`)
  for (const k of skills) a.doesNotMatch(k.body, /@(苏棠|林野|顾衡|严青)/, `${k.name}: no @-relay handoffs left in the skill`)
  const breakdown = skills.find(k => k.name === 'shot-breakdown').body
  a.match(breakdown, /"dialogue"/); a.match(breakdown, /onscreen[\s\S]*offscreen[\s\S]*narration/)
  a.deepEqual(agents.map(x => [x.effort, x.max_steps]), [['high', 30], ['medium', 30], ['medium', 40], ['high', 40]])
  a.deepEqual(agents.map(x => x.models[0]), ['claude-opus-5-5', 'gpt-5.6-sol', 'claude-sonnet-5', 'claude-opus-5-5'])
  a.ok(!agents[3].models.includes('deepseek-flash'), 'the reviewer is never given a model nobody has seen judge a sheet')
  a.throws(() => parseAgent('# A — B\n- **推理强度**：max\n## 性格描述\nx', 'x'), /low \/ medium \/ high/)
  a.throws(() => parseAgent('no heading', 'x'), /first heading/)
  a.throws(() => parseAgent('# A — B\n- **Skills**：x\n', 'x'), /性格描述/)
  console.log('import.mjs: all checks passed')
}

// Imports only load the specification; migrations and the built-in seeder share it.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const o = args(process.argv.slice(2))
  if (o.selfTest) await selfTest()
  else await main(o).catch(e => { console.error(`Import failed: ${e.message}`); process.exit(1) })
}
