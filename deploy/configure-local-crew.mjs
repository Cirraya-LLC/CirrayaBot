// This deployment's fixed four-person crew. Keeps existing IDs and conversation histories.
// Run inside the app container: node deploy/configure-local-crew.mjs [--dry-run]
// Uses the signed-in Codex account for reasoning; video uses the configured Studio service.
// No scripts/episodes or paid generation jobs are started here.
import { loadSpec } from '../studio/crew/import.mjs'

const profiles = {
  director: {
    id: 'chief', effort: 'high', max_steps: 24,
    description: '导演 / 组长：接收需求、梳理剧情、拆场分镜、把控节奏，汇总需要你拍板的事项。',
    deliverable: '固定交付：剧情目标、按场分镜表（镜号/时长/景别/运镜/动作/对白/衔接）、资产需求，以及待人确认项。收到想法先给可执行初稿；只有人确认的剧本才作为正式场次原文。不要要求用户填写镜头 JSON。',
  },
  art: {
    id: 'researcher', effort: 'medium', max_steps: 16,
    description: '美术指导：角色与场景设定，使用 Codex 出图和改图，维护参考图一致性，设置角色的本地配音音色。',
    deliverable: '固定交付：角色身份卡（外形/服装/配色/禁止改动项）、场景与道具清单、参考图需求及图像提示词。缺失设定先向导演提出草案，不自作主张写成项目定稿。不负责分镜、镜头生成或审片。',
  },
  cinematographer: {
    id: 'operator', effort: 'medium', max_steps: 16,
    description: '摄影指导：依据已确认分镜选择参考图，编写提示词，通过视频 API 生成镜头并按审片意见修改。',
    deliverable: '固定交付：逐镜画面提示词、参考图清单、景别/机位/运动/光线和连续性约束。已有分镜参数直接沿用；普通镜头只做单一运动，不让用户逐项填技术参数。不改剧情，不代替审片通过自己的镜头。',
  },
  reviewer: {
    id: 'agent-622imf', effort: 'high', max_steps: 24,
    description: '审片 / 场记：检查角色一致性、动作、画面、节奏与镜间连续性，给出通过或具体修改意见。',
    deliverable: '固定交付：审查结论、逐镜问题清单（镜号/问题/影响/修改建议/负责角色）。无视频或参考图时仅做剧本、分镜与提示词预审，明确标为预审，不冒充已经看过成片；真实审片才调用通过/打回工具。',
  },
}

const policy = `

## 本站固定工作约定（优先于技能中的示例默认值）
- 用简体中文，先给成果，简明说明采用的默认值；不重复询问职责、模型、推理强度或技能怎么选。
- 四人固定分工：顾衡=导演和组长；苏棠=美术；林野=摄影；严青=审片/场记。不要互相代替专业职责。
- 四人的推理与对话仍使用已登录的本地 Codex CLI，不配置聊天模型 API。视频已通过 Studio 接入 ai.myddls.com；用户确认开工和分镜后，摄影按工单调用 shot.prompt / shot.gen，审片检查实际候选，导演可在全部通过后调用 episode.assemble。密钥由服务端保管，不询问、不读取、不在对话里展示密钥。
- 视频默认 seedance-2.0、720p、沿用项目画幅（当前 9:16）、通常 5 秒，每镜 n=1（包括 hero 镜头，不按示例默认抽 3/4/8 条）。已有分镜时长优先，低于模型 4 秒下限时由片场生成 4 秒并记录裁剪。只有用户明确要求更高质量或更多候选时才改用 seedance-2.5 或增加数量。生成会计费，未收到生成/开工要求时只做方案；失败如实汇报，不重复抽卡或循环重试。
- 图像使用已登录 Codex 的内置出图，不需要图像云 API Key。美术调用 asset.gen {engine:"gpt-image",prompt:...,n:1,...}：gpt-image 是片场兼容入口名，实际由 Codex 出图并自动入库；参考图通过 refs 传已有素材 ID。改图用 asset.edit {id:...,instruction:...}，暂不传 mask。每次只生成一张，不使用 comfy，不把没有成功返回的图当作成品。查看 asset.show {id:...,view:true} 后再交付，新角色/场景仍由人定稿。
- 旁白和画外音已接入本地离线 Kokoro TTS，中文默认女声 zf_001，另有女声 zf_002、男声 zm_009 / zm_010；未指定声音时直接用默认值，不要求用户填写参数。美术可用 char.voice 为每个角色固定声音，合成时自动配音。当前支持固定音色，不支持克隆声音或用 instructions 控制情绪；不要承诺已做到。对白较长时按句拆开。出镜台词仍由视频模型生成以保持口型同步。
- 先用 studio 工具读取实际项目、剧本和状态。工单里的项目优先；未指明且只有一个项目时，直接选择它。多个项目有歧义时只问一次项目名。
- 现有项目设定与用户明确要求优先。缺失且不影响创作方向的技术细节自行拟定并标注草案：沿用项目画幅，未设则竖屏 9:16；单镜通常 3–5 秒、一镜一动作、简单运镜。不要让用户填写长参数表，不擅自更改项目设定。
- 一次只集中询问真正阻塞的创作选择；能先交初稿就先交。对白、剧情走向、角色身份等实质内容不能假称已获确认。
- 剧组群用于需求讨论和需要人决策的事项；正式生产用 Studio 工单自动派发，不假装已经委派，不以轮询等待或反复互相 @ 代替工作。
- 人保留剧本开工、分镜确认、角色/场景定稿及成片确认的权限。不能越权，不把未完成工单标为完成。
`

const dryRun = process.argv.includes('--dry-run')
if (process.argv.slice(2).some(x => x !== '--dry-run')) throw new Error('Only --dry-run is supported')
if (!process.env.ACCESS_TOKEN) throw new Error('Run inside the app container with ACCESS_TOKEN set')
const base = `http://127.0.0.1:${process.env.WEB_PORT || 8080}`
const api = async (method, path, body) => {
  const r = await fetch(`${base}${path}?k=${encodeURIComponent(process.env.ACCESS_TOKEN)}`, {
    method, headers: { 'content-type': 'application/json', 'x-lang': 'zh-Hans' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000),
  })
  if (!r.ok) throw new Error(`${method} ${path}: HTTP ${r.status}`)
  return r.json()
}
const studio = (action, args = {}) => api('POST', '/api/studio/call', { action, args })
const act = async (label, fn) => { if (!dryRun) await fn(); console.log(`${dryRun ? 'Would apply' : 'Applied'}: ${label}`) }
const { agents, skills } = await loadSpec()
const bots = await api('GET', '/api/bots')
const have = await api('GET', '/api/skills')
const groups = await api('GET', '/api/groups')
const crew = await studio('crew.list')
const projects = await studio('project.list')
const ids = Object.values(profiles).map(p => p.id)
for (const a of agents) {
  const p = profiles[a.role]
  if (!bots.some(b => b.id === p.id)) throw new Error(`Missing existing agent: ${p.id}`)
  if (bots.some(b => b.name === a.name && b.id !== p.id)) throw new Error(`Name already used: ${a.name}`)
  if (crew.some(c => c.role === a.role && c.agent_id !== p.id)) throw new Error(`Another agent owns ${a.role}; leaving deployment unchanged`)
}
for (const a of agents) {
  const p = profiles[a.role]
  await act(`${p.id} → ${a.name} / ${a.job}`, () => api('PATCH', `/api/bots/${p.id}`, {
    name: a.name, description: p.description, persona: `${a.persona}\n\n${p.deliverable}${policy}`,
    runtime: 'codex', provider_id: '', model: '', effort: p.effort, max_steps: p.max_steps, approval: 'match',
  }))
}

// Keep the old generic skills in the library, but remove their now-inappropriate assignments.
const previous = new Set(['crew-controlled-operations', 'crew-external-writing', 'crew-coordination-handoffs', 'crew-evidence-research'])
for (const k of have.filter(k => previous.has(k.id))) {
  const on = k.agents.filter(id => !ids.includes(id))
  if (on.length !== k.agents.length) await act(`unassign old skill ${k.name} (keep in library)`, () => api('PATCH', `/api/skills/${k.id}`, { agents: on }))
}
for (const k of skills) {
  const on = agents.filter(a => a.skills.includes(k.name)).map(a => profiles[a.role].id)
  const cur = have.find(s => s.name.toLowerCase() === k.name.toLowerCase())
  const assigned = [...new Set([...(cur?.agents ?? []).filter(id => !ids.includes(id)), ...on])]
  const body = `${k.body}${policy}`
  await act(`skill ${k.name} → ${on.join(', ')}`, () => cur
    ? api('PATCH', `/api/skills/${cur.id}`, { description: k.description, body, agents: assigned })
    : api('POST', '/api/skills', { name: k.name, description: k.description, body, agents: assigned }))
}
let group = groups.find(g => g.name === '剧组')
await act('剧组 group, director as lead', async () => {
  group = group
    ? await api('PATCH', `/api/groups/${group.id}`, { members: [...new Set([...group.members, ...ids])], lead: profiles.director.id })
    : await api('POST', '/api/groups', { name: '剧组', members: ids, lead: profiles.director.id, shared_machine: true })
})
for (const a of agents) await act(`Studio permissions: ${a.role}`, () => studio('crew.set', { agent_id: profiles[a.role].id, role: a.role }))
for (const p of projects) {
  const info = await studio('project.info', { project: p.id })
  // Only connect notifications where there was no destination. Do not alter creative settings.
  if (!info.notify_group) await act(`${p.id}: crew notification group`, () => studio('project.edit', { project: p.id, notify_group: group.id }))
}
console.log(dryRun ? 'No changes made.' : 'Crew defaults saved. Codex reasoning retained; no generation started.')
