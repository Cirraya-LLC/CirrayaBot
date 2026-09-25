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
// Agents are created WITHOUT a model: which upstream each one runs on is the person's call
// (README "建议上游"), and the first chat says so until one is picked.
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
  return {
    role, id: `crew-${role}`, name: head[1].trim(), job: head[2].trim(), persona,
    skills: field('Skills').split(/[,，、]/).map(s => s.trim()).filter(Boolean),
    lead: field('群角色') === '组长', upstream: field('建议上游'),
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
    else await act(`create agent ${a.name} (${a.id}) — no model yet`, () =>
      call('POST', '/api/bots', { id: a.id, name: a.name, description: a.job, persona: a.persona, model: '' }))
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
  else await act(`create group ${o.group} with the crew, lead ${lead}`, async () => {
    groupId = (await call('POST', '/api/groups', { name: o.group, members: ids, lead })).id
  })

  // ---- studio roles ----
  const studio = await call('GET', '/api/studio/status')
  if (studio.enabled) for (const a of agents)
    await act(`studio role: ${a.name} → ${a.role}`, () => call('POST', '/api/studio/call', { action: 'crew.set', args: { agent_id: a.id, role: a.role } }))
  else plan.push('studio not configured on this deployment — roles skipped (rerun after it is up)')

  console.log(`${o.dryRun ? 'Would do' : 'Done'}:\n${plan.map(p => `  - ${p}`).join('\n')}`)
  console.log(`\nGroup: ${o.group} (${groupId})`)
  console.log('\nNext, by hand (these are yours to choose):')
  for (const a of agents) console.log(`  - Edit Agent ${a.name}: pick an upstream and a model — suggested: ${a.upstream || '—'}`)
  console.log(`  - Workbench → Project settings: create the project, set its notice group to "${o.group}" and its notice language`)
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
  a.throws(() => parseAgent('no heading', 'x'), /first heading/)
  a.throws(() => parseAgent('# A — B\n- **Skills**：x\n', 'x'), /性格描述/)
  console.log('import.mjs: all checks passed')
}

const o = args(process.argv.slice(2))
if (o.selfTest) await selfTest()
else await main(o).catch(e => { console.error(`Import failed: ${e.message}`); process.exit(1) })
