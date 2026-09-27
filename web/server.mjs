// The CirrayaBot web server.
//
// All state lives in PostgreSQL (web/db.mjs); agents work in their own containers (one per agent);
// model upstreams are configured in the UI — several of them, switchable at any time — not hard-coded in .env.
//
// Auth: deployments may use a password-only browser session; otherwise ?k=<ACCESS_TOKEN> sets the auth cookie.
import { env, ROOT } from './env.mjs'
import * as db from './db.mjs'
import { fitContext, listModels, probeContext, estimateUsage } from './model.mjs'
import { callUpstream, normProtocol, normEffort, EFFORTS, PROTOCOLS } from './protocols.mjs'
import { checkSchedule, nextRun } from './schedule.mjs'
import { checkSkill, parseSkillMd, toSkillMd } from './skill.mjs'
import { isPasswordHash, makePasswordSession, SESSION_MAX_AGE, verifyPassword, verifyPasswordSession } from './password.mjs'
import { addNote, NOTE_MAX_CHARS } from './memory.mjs'
import { APPROVAL_MODES, RISKY, needsApproval, toolSubject } from './approve.mjs'
import { runArgs, decide, groupsLabel, INSPECT_FORMAT, READ_SCRIPT, WRITE_SCRIPT } from './sandbox.mjs'
import { langOf, tr, Say, errorText } from './i18n.mjs'
import * as studio from './studio.mjs'
import * as crews from './crews.mjs'
import * as mcp from './mcp.mjs'
import { RUNTIMES, RUNTIME_IDS, GROK_ENV, turnArgs, grokMcpBlock, reader, needsLogin,
  loginArgs, logoutArgs, statusArgs, statusOf, loginPrompt, plain } from './cli.mjs'
import { createServer } from 'node:http'
import { readFile, mkdir } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'
import { spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'

const WEB = join(ROOT, 'web')
const WORKROOT = join(ROOT, 'workspace')

const CFG = {
  token: env.ACCESS_TOKEN || '',
  loginPasswordHash: env.LOGIN_PASSWORD_HASH || '',
  proxySecret: env.WEB_PROXY_SECRET || '',
  port:  Number(env.WEB_PORT || 8080),
  host:  env.BIND_HOST || (env.ACCESS_TOKEN || env.LOGIN_PASSWORD_HASH ? '0.0.0.0' : '127.0.0.1'),
  tools: env.AGENT_TOOLS === 'on',
}

// The speaker name stored on the human's messages. It is a data marker, not display text:
// existing rows and both clients (web/app.js, the Flutter app) compare against it, so it
// must never be translated. The model sees it as "User" (see modelSpeaker).
const USER_SPEAKER = db.USER_SPEAKER  // stored speaker value for the person in group logs (data, not UI text)
const modelSpeaker = s => (s === USER_SPEAKER ? 'User' : s)

// ---------- Agents ----------
// DB row → the field names the frontend uses. The frontend shouldn't care whether the column is ord or order.
const toBot = (r, lang = 'en') => ({
  id: r.id, name: r.name, description: r.description, persona: r.persona,
  order: r.ord, color: r.color, provider_id: r.provider_id ?? '', model: r.model ?? '',
  // Money is micro-dollars everywhere in the API (1 dollar = 1e6); null = no cap of its own.
  daily_cap_micro: r.daily_cap_micro == null ? null : Number(r.daily_cap_micro),
  // How hard this agent's model should think. '' = say nothing, which is what it did before.
  effort: r.effort ?? '',
  // When this one has to ask before acting. '' = follow the platform setting.
  approval: r.approval ?? '',
  // Tool steps in one turn. null = the default (MAX_STEPS). A reviewer going through a batch needs
  // about five per shot, which twelve can't hold.
  max_steps: r.max_steps ?? null,
  // '' = our own loop; otherwise the coding CLI its turns run on (web/cli.mjs).
  runtime: r.runtime ?? '',
  // Capability tags reflect the tools the backend actually grants, not what the persona says —
  // a tag claiming bash that can't actually run it is worse than no tag.
  tools: (CFG.tools ? ['shell', 'files', 'browser', 'sandbox'] : ['chatOnly']).map(k => tr(lang, `bot.tool.${k}`)),
})
const loadBots = async (lang = 'en') => (await db.listAgents()).map(r => toBot(r, lang))

// ---------- Conversation list ----------
/** Groups and direct chats mixed together, sorted by last activity — that's what an IM looks like. */
async function listConversations(lang) {
  const bots = await loadBots(lang)
  const bindings = await crews.list()
  const groups = await db.listGroups()
  const last = await db.lastMessages()
  const cut = (s, n) => String(s ?? '').replace(/\s+/g, ' ').slice(0, n)
  const items = bots.map(b => {
    const m = last.get(`dm:${b.id}`)
    return {
      kind: 'agent', id: b.id, name: b.name, tag: b.description, color: b.color,
      members: [b.id], project_id: bindings.find(c => groups.find(g => g.id === c.group_id)?.members.includes(b.id))?.project_id ?? null,
      preview: m ? (m.speaker === studio.STUDIO_SPEAKER ? tr(lang, 'conv.said', { who: tr(lang, 'conv.studio'), text: cut(m.content, 60) })
        : m.role === 'user' ? tr(lang, 'conv.youSaid', { text: cut(m.content, 60) }) : cut(m.content, 60)) : '',
      at: m?.at ?? 0,
    }
  })
  for (const g of groups) {
    const m = last.get(`group:${g.id}`)
    items.push({
      kind: 'group', id: g.id, name: g.name, tag: tr(lang, 'conv.members', { n: g.members.length }), lead: g.lead ?? '',
      members: g.members, project_id: bindings.find(c => c.group_id === g.id)?.project_id ?? null,
      colors: g.members.map(id => bots.find(b => b.id === id)?.color).filter(Boolean),
      preview: m ? tr(lang, 'conv.said', {
        who: m.speaker === USER_SPEAKER ? tr(lang, 'conv.user') : m.speaker === studio.STUDIO_SPEAKER ? tr(lang, 'conv.studio') : m.speaker,
        text: cut(m.content, 52) }) : '',
      at: m?.at ?? (+g.created_at || 0),
    })
  }
  return items.sort((a, b) => b.at - a.at)
}

/**
 * One transcript line for the UI. A tool row carries JSON, so unpack it here rather than
 * making both frontends parse it; a row that somehow isn't JSON is dropped to text.
 */
function transcriptRow(m, text) {
  if (m.role !== 'tool') return { role: m.role, at: m.at, ...text }
  try {
    const { name, args, output } = JSON.parse(m.content)
    return { role: 'tool', speaker: m.speaker, at: m.at, name, args: args ?? {}, output: output ?? '' }
  } catch { return { role: m.role, at: m.at, ...text } }
}

const MAX_HANDOFFS = 5       // max handoffs between agents in one round, so they can't chat forever
const DEFAULT_STEPS = 12     // tool steps per turn unless the agent has its own max_steps
const FETCH_MAX = 300        // how many candidate rows to pull from the DB; the real trimming is by context budget
const TOOL_TRACE = 400       // how much tool output the transcript keeps, same as the live stream sends

// Approvals. The research behind this product is blunt about it: a persona saying "you may not change
// production config" stops nothing, so the boundary has to be outside the model. An agent asks before
// acting when the platform (or its own setting) says so; the answer comes back over the open stream.
// Approvals. The rule lives in approve.mjs so it can be checked on its own; here we only resolve
// the policy and wait for the human.
async function approvalPolicy() {
  const s = await db.getSetting('approvals', null)
  return {
    mode: APPROVAL_MODES.includes(s?.mode) ? s.mode : 'match',
    patterns: Array.isArray(s?.patterns) ? s.patterns.filter(x => String(x).trim()) : RISKY,
  }
}

// id -> the function that answers it. A pending approval only exists while its stream is open.
const pendingApprovals = new Map()

/**
 * Ask, and wait. Nothing times out on its own: the client hanging up aborts the turn, which is the
 * only way an interactive approval can end unanswered. A scheduled task has nobody to ask, so it is
 * refused straight away rather than stalling a task nobody is watching.
 */
function askApproval(ctx, onTool, name, args) {
  if (ctx.unattended) return Promise.resolve(false)
  const id = randomUUID()
  onTool?.({ phase: 'ask', id, name, args })
  return new Promise(resolve => {
    const answer = ok => {
      if (!pendingApprovals.delete(id)) return
      ctx.signal?.removeEventListener('abort', onAbort)
      onTool?.({ phase: 'answered', id, name, args, ok })
      resolve(ok)
    }
    const onAbort = () => answer(false)
    pendingApprovals.set(id, answer)
    ctx.signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * The group discussions an agent remembers — every group he's in, not just the current one.
 * Fed to him in direct chats too: a real employee doesn't forget this morning's group chat just because the window changed.
 */
async function groupRecallFor(bot) {
  const bound = await crews.forAgent(bot.id)
  const groups = (await db.listGroups()).filter(g => g.members.includes(bot.id) && (!bound || g.id === bound.group_id))
  const chunks = []
  for (const g of groups) {
    const log = await db.recent('group', g.id, 30)
    if (log.length) chunks.push(`[Group: ${g.name}]\n` + log.map(e => `[${modelSpeaker(e.speaker)}] ${e.content}`).join('\n'))
  }
  return chunks.join('\n\n')
}

async function projectIdentity(bot) {
  const c = await crews.forAgent(bot.id)
  return c ? `\n\n当前唯一项目编号：${c.project_id}。你只属于这个项目的独立剧组，Studio 已限制项目访问；无需让用户选择项目。` : ''
}

function systemFor(bot, memory, peers, box, recall, skills = [], lead = null, studioRole = null, shared = null) {
  const parts = [bot.persona]
  parts.push(`

--- Language ---
Reply in the language the user writes in.`)
  if (box && shared) parts.push(`

--- Your work environment ---
You share one machine (a container) with the rest of "${shared}": the working directory /work is the group's desk,
and everyone in the group works in it — what you leave there, they see; what they leave, you see. Put your work in a
folder named for the job (e.g. /work/E01/S02) and don't delete what isn't yours.
You are root. Commands have a ${EXEC_TIMEOUT / 1000}-second limit; past that we stop waiting (though it may still be running).
You also have a browser (the browser tool) — shared too: someone else may have a page open in it.`)
  else if (box) parts.push(`

--- Your work environment ---
You have your own machine (a container) with working directory /work; only you can get in.
You are root — install and write whatever you like; it stays on your own machine.${peers?.length ? `
In group chats there is a ./group directory: the group's shared drive, visible to everyone in the group —
to hand something to a colleague, \`cp x group/\`; what colleagues give you is there too.` : ''}
Commands have a ${EXEC_TIMEOUT / 1000}-second limit; past that we stop waiting (though it may still be running).
You also have your own browser (the browser tool): open pages, click buttons, fill forms, take screenshots to see the page.`)
  if (peers?.length) {
    parts.push(`

--- This is a group chat ---
These colleagues are also in the group:
${peers.map(p => `- ${p.name}: ${p.description}`).join('\n')}

Messages show who said them: "[name] content"; "[User]" is the human.
${!lead ? '' : lead.id === bot.id ? `
**You are this group's lead.** When the user hasn't named anyone, you speak first: think the matter through, break it into
pieces that can be handed out, @ the right colleague to do each, keep track of progress, and finally summarize the result for the user.
Don't grind away alone on work you could hand out.` : `
**This group's lead is ${lead.name}.** When your part is done, when you're stuck, or when you're unsure who should pick it up next, @${lead.name}.`}

**This group is turn-based — this rule matters most:**
Only one person talks at a time. After you finish, the person you @ starts working; when they finish,
it comes back around to you. You are not processes running concurrently.

Two consequences:
- **Hand off only with @name.** Don't use the shell to write files, send messages or leave notes for colleagues — they don't read those,
  and doing so just wastes your own turn.
- **Never wait for a colleague.** Don't sleep, don't poll group/ for a file to appear, don't write loops like
  "for i in $(seq ...); do test -f ...". You can't wait for them — they only start once you've finished.
  @ the work out, and then your turn is over.

Other rules:
- Speak only for your own part. Don't speak for colleagues, and don't make up things they said.
- Don't repeat what's already been said; if a colleague got it right, build on it instead of restating it.
- @ only one person at a time, on its own line at the end of your reply.
- When the matter is done and nobody needs to follow up, don't @ anyone — that is what stops the group chat.
- People are watching you, so don't treat "I've done X" as a figure of speech: if you didn't do it, say so.`)
  }
  if (studioRole) parts.push(`

--- The studio ---
You are on the film crew as the ${studioRole}. You work in the studio through the studio tool; your skills say which
actions to use. The studio decides what your role may do and refuses the rest — don't try to get around a refusal.
Messages from "[Studio]" are the studio itself. Work reaches you as numbered work orders in your own chat; do them — the studio
sees the work in its own state and closes each order by itself, so you don't @ a colleague to hand work over and you don't
report every step in the group. Speak in the group when you need a colleague's judgment or a person's decision.`)
  if (skills.length) parts.push(box ? `

--- Your skills ---
These are the skills installed for you: the name and when to use it. When a task matches, first read the full procedure with read_skill, then follow it.
${skills.map(k => `- ${k.name}: ${k.description}`).join('\n')}` : `

--- Your skills ---
When a task matches, follow the procedure below.
${skills.map(k => `### ${k.name}\nWhen to use: ${k.description}\n\n${k.body}`).join('\n\n')}`)
  if (memory.own?.trim()) parts.push(`\n\n--- Your memory (maintained by humans, only you can read it) ---\n${memory.own.trim()}`)
  if (memory.self?.trim()) parts.push(`

--- Notes you kept yourself ---
You wrote these with the remember tool, so they may be wrong or out of date: when you can check
something, trust what you check over what is written here. Keep adding to them as you learn.
${memory.self.trim()}`)
  if (memory.group?.trim()) parts.push(`\n\n--- This group's memory (everyone in the group can read it; maintained by humans) ---\n${memory.group.trim()}`)
  if (recall?.trim()) parts.push(`

--- Group discussions you remember ---
These are group chats you took part in. This is a private conversation now, but of course you remember them:
${recall.trim()}`)
  return parts.join('')
}

// ---------- Containers: one per agent — that's real isolation ----------
//
// ⚠️ Tools are OFF by default (only on with AGENT_TOOLS=on). Once on, every agent can run arbitrary
// commands in its own container — exactly the "hands-on like a real employee" we want, but it also means
// whoever holds ACCESS_TOKEN = holds a shell in a container, and any outside text an agent reads
// (web pages, logs, colleagues' messages) may be a prompt injection.
//
// What a container sees and may do is decided in sandbox.mjs: its own desk at /work, one mount per
// group it belongs to at /groups/<gid> (in a group chat /work/group points at the current one), a
// network of ours with container-to-container traffic off, and a short capability list.
// The platform's code and .env aren't in there; it can't reach them.
const CLI = env.CONTAINER_CLI || 'docker'
const IMAGE = env.AGENT_IMAGE || 'multi-agent-worker:1'
const EXEC_TIMEOUT = Number(env.AGENT_EXEC_TIMEOUT || 120) * 1000
const OUT_MAX = 12_000
// Container names are global on the whole host. Two deployments on the same machine that don't change the prefix
// fight over the same ma-agent-chief — the mount check makes each side delete and recreate the other's container.
const PREFIX = env.AGENT_PREFIX || 'ma'
const cname = id => `${PREFIX}-agent-${id}`
const NETWORK = `${PREFIX}-agents`

// ⚠️ When starting sibling containers, the left side of -v is a HOST path, not a path inside our own container.
// When we run in a container WORKROOT is /app/workspace, while on the host it's somewhere else —
// using WORKROOT would mount the agent's container on an empty directory, with no error at all.
const HOSTWORK = env.WORKSPACE_HOST_PATH || WORKROOT

function cliRun(argv, input, timeout = EXEC_TIMEOUT) {
  return new Promise(done => {
    const p = spawn(CLI, argv, { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = '', err = ''
    const timer = setTimeout(() => { p.kill('SIGKILL'); done({ code: 124, out, err: err + '\n(timed out)' }) }, timeout)
    p.stdout.on('data', d => { out += d })
    p.stderr.on('data', d => { err += d })
    p.on('close', code => { clearTimeout(timer); done({ code, out, err }) })
    p.on('error', e => { clearTimeout(timer); done({ code: 127, out, err: String(e.message) }) })
    p.stdin.end(input ?? '')
  })
}

let imageReady = false
/**
 * Make sure the worker image exists; build it on the spot if not.
 *
 * This is for "one-command deploy": otherwise the first line of the deploy docs would be "docker build
 * an image yourself first" — exactly the step most likely to be skipped, and skipping it only errors on the first chat.
 * The Dockerfile is read from deploy/agent.Dockerfile and fed on stdin — no second copy in the code.
 */
let imageBuild = null
// Two conversations speaking for the first time at once would each build the same image — share one promise.
function ensureImage() {
  if (imageReady) return Promise.resolve()
  imageBuild ??= buildImage().finally(() => { imageBuild = null })
  return imageBuild
}
async function buildImage() {
  if ((await cliRun(['image', 'inspect', IMAGE], null, 30_000)).code === 0) { imageReady = true; return }
  const df = await readFile(join(ROOT, 'deploy', 'agent.Dockerfile'), 'utf8')
  console.log(`First run: building the agent image ${IMAGE} (a minute or two, only once)…`)
  const r = await cliRun(['build', '-t', IMAGE, '-'], df, 900_000)
  if (r.code !== 0) throw new Say('container.buildFailed', { image: IMAGE, detail: (r.err || r.out).slice(-500) }, 500)
  console.log(`Image ${IMAGE} is ready`)
  imageReady = true
}

let networkReady = null
/**
 * The agents' own bridge, with inter-container traffic off: on Docker's default bridge every agent
 * could reach every other agent's ports. Made once; podman's bridge doesn't take the option, and
 * there the network is made without it (with a warning) rather than not at all.
 */
function ensureNetwork() {
  networkReady ??= (async () => {
    if ((await cliRun(['network', 'inspect', NETWORK], null, 30_000)).code === 0) return
    let r = await cliRun(['network', 'create', '--driver', 'bridge',
      '-o', 'com.docker.network.bridge.enable_icc=false', NETWORK], null, 60_000)
    if (r.code !== 0 && !/already exists/i.test(r.err)) {
      console.warn(`[sandbox] could not make ${NETWORK} with container-to-container traffic off (${(r.err || r.out).trim()}); ` +
        'making it without — agents on this engine can reach each other')
      r = await cliRun(['network', 'create', NETWORK], null, 60_000)
    }
    if (r.code !== 0 && !/already exists/i.test(r.err))
      throw new Say('container.startFailed', { id: NETWORK, detail: (r.err || r.out).slice(0, 300) }, 500)
  })().catch(e => { networkReady = null; throw e })
  return networkReady
}

// name -> the sandbox it was checked against (work|image|groups). A change in any of them — above all
// the agent's group memberships — makes the next turn inspect it again, and recreate it if needed.
const containerReady = new Map()

/**
 * One agent does one thing at a time.
 *
 * ⚠️ The /work/group symlink is shared by the WHOLE container: while he runs tools in group A,
 * if group B (or a direct chat) also reaches him, ensureContainer repoints the symlink to B — and his later
 * `cp x group/` in A lands in B's shared drive (the cross-group leak from 2.14, triggered by concurrency).
 * Two conversations calling him for the first time would also each run `docker run --name` and collide. One lock stops both.
 */
const agentLocks = new Map()
function withAgent(id, fn) {
  const prev = agentLocks.get(id) ?? Promise.resolve()
  const run = prev.catch(() => {}).then(fn)
  const tail = run.catch(() => {})
  agentLocks.set(id, tail)
  tail.then(() => { if (agentLocks.get(id) === tail) agentLocks.delete(id) })
  return run
}

/** One relay per group at a time — the same chaining as withAgent, keyed by group. */
const groupLocks = new Map()
function withGroup(id, fn) {
  const prev = groupLocks.get(id) ?? Promise.resolve()
  const run = prev.catch(() => {}).then(fn)
  const tail = run.catch(() => {})
  groupLocks.set(id, tail)
  tail.then(() => { if (groupLocks.get(id) === tail) groupLocks.delete(id) })
  return run
}

/** Run a command in a container. If someone deleted the container from outside, drop the "ready" cache so the next round recreates it. */
async function execIn(c, argv, input) {
  const r = await cliRun(['exec', ...argv], input)
  if (/No such container/i.test(r.err)) containerReady.delete(c)
  return r
}

/**
 * Which machine an agent works on. Normally its own. Weak isolation (2.31): a member of a group
 * marked shared_machine works on the group's machine, whose /work IS the group's drive — the
 * film crew hands files over by leaving them on the desk. (A member of two such groups gets the
 * older one.) Different groups, and everyone else, stay apart as before.
 */
async function machineOf(botId) {
  const g = (await db.listGroups()).find(x => x.shared_machine && x.members.includes(botId))
  return g ? { name: `${PREFIX}-group-${g.id}`, gid: g.id } : { name: cname(botId), gid: null }
}

/** The name of the group whose machine this agent shares, for the system prompt; null = its own. */
async function sharedName(botId) {
  const m = await machineOf(botId)
  return m.gid ? (await db.listGroups()).find(g => g.id === m.gid)?.name ?? null : null
}

/**
 * Make sure this agent's machine is running with the right mounts (sandbox.mjs decides what those
 * are), and point /work/group at the current group. A shared group machine gets the same rules —
 * own network, short capability list — with the group's drive as its desk and no other group.
 */
async function ensureContainer(botId, groupId) {
  await ensureImage()
  const m = await machineOf(botId)
  const name = m.name
  // Only the groups it is in right now. A group it isn't in has no mount, so it doesn't exist in there.
  const mine = (await db.listGroups()).filter(g => g.members.includes(botId)).map(g => g.id)
  if (groupId && !mine.includes(groupId)) throw new Say('err.noGroup', {}, 404)
  const groups = m.gid ? [] : mine
  const desk = m.gid ? join('groups', m.gid) : join('agents', botId)
  const work = join(HOSTWORK, desk)
  const want = { work, image: IMAGE, groups: groupsLabel(groups) }
  const sig = `${want.work}|${want.image}|${want.groups}`
  if (containerReady.get(name) !== sig) {
    // The host directories have to exist first, or docker makes them itself, owned by root.
    await mkdir(join(WORKROOT, desk), { recursive: true })
    for (const g of groups) await mkdir(join(WORKROOT, 'groups', g), { recursive: true })
    // Containers are long-lived, and what they should see changes: WORKSPACE_HOST_PATH moves, the image is
    // upgraded, the sandbox rules change, the agent joins or leaves a group. A container that is wrong in any
    // of these looks perfectly fine from inside — so it is checked here, every time the answer could differ.
    const { out } = await cliRun(['inspect', '-f', INSPECT_FORMAT, name], null, 30_000)
    const d = decide(out, want)
    if (d.action === 'recreate') {
      console.log(`${name} is ${d.why}; recreating it (files in /work and the group drives are kept)`)
      await cliRun(['rm', '-f', name], null, 60_000)
    }
    if (d.action === 'start') await cliRun(['start', name], null, 60_000)
    if (d.action === 'create' || d.action === 'recreate') {
      await ensureNetwork()
      const r = await cliRun(runArgs({ name, image: IMAGE, hostWork: HOSTWORK, botId, groups, network: NETWORK, desk,
        memory: env.AGENT_MEMORY || '2g', cpus: env.AGENT_CPUS || '2' }), null, 120_000)
      if (r.code !== 0) throw new Say('container.startFailed', { id: botId, detail: (r.err || r.out).slice(0, 300) }, 500)
    }
    containerReady.set(name, sig)
  }
  // On a shared machine /work already is the group's drive; there is no ./group to point anywhere.
  if (m.gid) return name
  // Reset the group symlink every time — otherwise it keeps pointing at the previous group (CLAUDE.md 2.14)
  await cliRun(['exec', name, 'bash', '-lc',
    groupId ? `rm -f /work/group && ln -s /groups/${groupId} /work/group` : 'rm -f /work/group'],
    null, 30_000)
  return name
}

/**
 * Someone left a group (or it was disbanded): take their container down now rather than on their next
 * turn, so nothing they left running in the background keeps a hand in that group's drive. After the
 * turn in progress, if any — the next one recreates it with the mounts it should have.
 */
function dropContainersOf(botIds) {
  for (const id of new Set(botIds)) withAgent(id, () => removeContainer(id)).catch(e =>
    console.warn(`[sandbox] could not remove ${cname(id)}: ${e.message}`))
}

/** A shared group machine goes when its group does, or stops sharing — nobody would ever use it again. */
function dropGroupMachine(gid) {
  const name = `${PREFIX}-group-${gid}`
  containerReady.delete(name)
  cliRun(['rm', '-f', name], null, 60_000).catch(() => {})
}

async function removeContainer(botId) {
  const name = cname(botId)             // its own machine only — a shared one belongs to the group
  containerReady.delete(name)
  await cliRun(['rm', '-f', name], null, 60_000)
}

const TOOL_SPECS = [
  { type: 'function', function: {
    name: 'read_skill',
    description: 'Read the full procedure of a skill installed for you (the names are listed in the "Your skills" section of the system prompt). When a task matches, read first, then act.',
    parameters: { type: 'object', required: ['name'], properties: {
      name: { type: 'string', description: 'Skill name' } } } } },
  { type: 'function', function: {
    name: 'save_skill',
    description: 'Save a procedure as a skill so similar tasks follow it later. Use it when the user asks you to "remember this process" or "save it as a skill", ' +
      'or when you have just worked out a procedure you will need again and the user agrees to save it. It is installed only for you; a skill with the same name that you wrote yourself is updated.',
    parameters: { type: 'object', required: ['name', 'description', 'body'], properties: {
      name: { type: 'string', description: 'A short name, e.g. "weekly report"' },
      description: { type: 'string', description: 'When to use it — this sentence is how you will recall it later, so describe the triggering situation clearly' },
      body: { type: 'string', description: 'The full procedure (Markdown): steps, decision rules, expected output, what to ask a human first. Write it so someone else could follow it' } } } } },
  { type: 'function', function: {
    name: 'remember',
    description: 'Keep one short fact in your own notes, so you still know it next time. Use it when you learn something about the user, their setup or how they want things done. ' +
      'Keep it short — one fact per call, one sentence. Only things that will still be true later, not what is only true in this conversation. ' +
      'Never store secrets (passwords, keys, tokens). Don\'t store something that is already written in one of your skills — a procedure belongs in save_skill, a fact belongs here. ' +
      'These notes are yours alone; the memory a human wrote for you is separate and you cannot change it.',
    parameters: { type: 'object', required: ['fact'], properties: {
      fact: { type: 'string', description: 'One short fact worth keeping, e.g. "Deploys go through ./start.sh, never docker compose directly"' } } } } },
  { type: 'function', function: {
    name: 'browser',
    description: 'Drive the browser on your own machine. It is stateful: open pages, half-filled forms and logins all persist (logins survive container restarts too). ' +
      'Workflow: open a URL → read the page text, which also numbers the elements you can click or fill → click / type by number → screenshot to see what the page looks like. ' +
      'If you only need data, prefer calling the API with curl; use the browser when you need to log in, click buttons, fill forms or see how a page looks. ' +
      'When you hit a CAPTCHA, a password or two-factor prompt, stop and ask the user to open your browser on the right side of the UI and do it themselves (they can see your browser and click and type in it directly); ' +
      'continue once they tell you they are done — don\'t guess and don\'t make things up.',
    parameters: { type: 'object', required: ['action'], properties: {
      action: { type: 'string', enum: ['open', 'read', 'click', 'type', 'press', 'scroll', 'back', 'screenshot', 'eval'] },
      url: { type: 'string', description: 'For open' },
      index: { type: 'integer', description: 'For click / type: the element number listed by read' },
      text: { type: 'string', description: 'For type: the text to enter; for click you may also give the text on the button' },
      submit: { type: 'boolean', description: 'Press Enter after type' },
      key: { type: 'string', description: 'For press, e.g. Enter, Tab, Escape' },
      dy: { type: 'integer', description: 'For scroll: positive scrolls down, default 600' },
      js: { type: 'string', description: 'For eval: a JS expression to run in the page; its value is returned to you' },
      full_page: { type: 'boolean', description: 'For screenshot: capture the whole page, not just the current viewport' } } } } },
  { type: 'function', function: {
    name: 'bash',
    description: 'Run a shell command in the working directory; returns stdout / stderr / exit code. Use it for inspecting, building, testing, installing and running.',
    parameters: { type: 'object', required: ['command'], properties: {
      command: { type: 'string', description: 'The command to run; pipes and redirects are fine' } } } } },
  { type: 'function', function: {
    name: 'read_file',
    description: 'Read the contents of a file.',
    parameters: { type: 'object', required: ['path'], properties: {
      path: { type: 'string', description: 'A path relative to the working directory, or an absolute path' } } } } },
  { type: 'function', function: {
    name: 'write_file',
    description: 'Write a file (overwrites). Parent directories are created automatically.',
    parameters: { type: 'object', required: ['path', 'content'], properties: {
      path: { type: 'string' }, content: { type: 'string' } } } } },
]

const clip = (t, max = OUT_MAX) => t.length > max ? `${t.slice(0, max)}\n… (truncated, ${t.length} characters in total)` : t

// The browser daemon (deploy/browserd.py) isn't in the image: it's pushed into the container before each use and
// swapped and restarted when its content changes. So changing it needs no image rebuild, and there's no
// "this agent's container is still running the old version".
const BROWSERD = await readFile(join(ROOT, 'deploy', 'browserd.py'), 'utf8')
// ⚠️ Can't use pkill -f browserd: this script's own command line contains that word, so it would kill itself (2.9.5)
const BROWSERD_UP = `
cat > /tmp/browserd.new
if ! cmp -s /tmp/browserd.new /opt/browserd.py; then
  mv /tmp/browserd.new /opt/browserd.py
  if [ -f /tmp/browserd.pid ]; then kill "$(cat /tmp/browserd.pid)" 2>/dev/null; sleep 1; fi
  rm -f /tmp/browserd.pid
fi
curl -sf http://127.0.0.1:9230/ >/dev/null && exit 0
command -v chromium >/dev/null || { echo "this machine's image has no browser (old image)"; exit 3; }
setsid nohup python3 /opt/browserd.py >/tmp/browserd.log 2>&1 </dev/null &
echo $! > /tmp/browserd.pid
for i in $(seq 60); do curl -sf http://127.0.0.1:9230/ >/dev/null && exit 0; sleep 0.5; done
tail -n 20 /tmp/browserd.log; exit 1
`

// ── A human watching / taking over an agent's browser ──
// Watching (screenshots) only works when his browser is already open: just looking shouldn't start chromium for him.
// Taking over (actions) starts it when needed — the human has to log in first so the agent can carry on.
// Doesn't take the withAgent lock: the human must be able to watch while the agent works; locking would mean waiting until he's done.
const HUMAN_ACTIONS = ['open', 'back', 'reload', 'click_xy', 'type_raw', 'press', 'wheel']

async function browserAlive(c) {
  return (await cliRun(['exec', c, 'curl', '-sf', 'http://127.0.0.1:9230/'], null, 10_000)).code === 0
}

async function browserPost(c, args, lang = 'en') {
  const r = await cliRun(['exec', '-i', c, 'curl', '-s', '--max-time', '60', '-X', 'POST',
    '-H', 'content-type: application/json', '--data-binary', '@-', 'http://127.0.0.1:9230/'], JSON.stringify(args), 70_000)
  try { return JSON.parse(r.out) } catch { return { ok: false, error: tr(lang, 'browser.noResponse', { detail: (r.err || r.out).trim().slice(0, 200) }) } }
}

async function humanBrowserAct(botId, args, lang) {
  if (!CFG.tools) throw new Say('browser.toolsOff')
  if (!HUMAN_ACTIONS.includes(args.action)) throw new Say('browser.badAction', { action: args.action })
  const c = (await machineOf(botId)).name
  if ((await cliRun(['inspect', '-f', '{{.State.Running}}', c], null, 10_000)).out.trim() !== 'true')
    await withAgent(botId, () => ensureContainer(botId, null))
  // Always go through BROWSERD_UP: start it if it isn't running, swap in new daemon code if it changed (the human actions were added later)
  const up = await execIn(c, ['-i', c, 'bash', '-c', BROWSERD_UP], BROWSERD)
  if (up.code !== 0) return { ok: false, error: tr(lang, 'browser.cantStart', { detail: (up.out + up.err).trim().slice(-300) }) }
  return browserPost(c, args, lang)
}

/** Run one browser action. Screenshots return {text, image}; everything else returns text. */
async function runBrowser(c, args, ctx) {
  const up = await execIn(c, ['-i', c, 'bash', '-c', BROWSERD_UP], BROWSERD)
  if (up.code !== 0) return `The browser would not start: ${(up.out + up.err).trim().slice(-600)}`
  const r = await execIn(c, ['-i', c, 'curl', '-s', '--max-time', '90', '-X', 'POST',
    '-H', 'content-type: application/json', '--data-binary', '@-', 'http://127.0.0.1:9230/'], JSON.stringify(args))
  let j
  try { j = JSON.parse(r.out) } catch { return `The browser did not respond: ${(r.err || r.out).trim().slice(0, 300)}` }
  if (!j.ok) return `Browser error: ${j.error}`
  const head = `Page: ${j.title || '(no title)'}  ${j.url}`
  if (j.image) return ctx.noImages
    ? `${head}\nScreenshot taken, but the current model can't see images — use action=read to read the page text.`
    : { text: `${head}\nThe screenshot is attached to the next message.`, image: `data:image/jpeg;base64,${j.image}` }
  if (args.action === 'read')
    return clip(`${head}\n\n--- Page text ---\n${j.text}\n\n--- Interactive elements (use the number for click / type) ---\n${j.elements.join('\n')}`, 20_000)
  if (args.action === 'eval') return clip(`${head}\n${j.result}`)
  return `${head}\nDone. Use read or screenshot to see the result.`
}

// The file tools all run inside the container, so path semantics are uniform (/work in the container, not a host path).
// write_file goes over stdin instead of building a command line — quotes, newlines and $ in the content can't break anything.
async function runTool(name, args, ctx) {
  const c = ctx.container
  if (name === 'studio') return studio.runTool(args, ctx, { readFile: c ? (path, max) => readAgentFile(c, path, max) : null })
  if (name === 'browser') return runBrowser(c, args, ctx)
  if (name === 'read_skill') {
    const mine = await db.skillsFor(ctx.bot.id)
    const k = mine.find(x => x.name.toLowerCase() === String(args.name ?? '').trim().toLowerCase())
    return k ? `# ${k.name}\nWhen to use: ${k.description}\n\n${k.body}`
      : `You have no skill named "${args.name}". Installed for you: ${mine.map(x => x.name).join(', ') || '(none)'}`
  }
  if (name === 'save_skill') return saveSkillFromAgent(ctx.bot, args)
  if (name === 'remember') return rememberFromAgent(ctx.bot, args.fact)
  if (name === 'bash') {
    const { code, out, err } = await execIn(c, ['-w', '/work', c, 'bash', '-lc', args.command])
    const killed = code === 124 ? `\n(over ${EXEC_TIMEOUT / 1000}s — we stopped waiting; the command may still be running in the container)` : ''
    return clip([out, err && `--- stderr ---\n${err}`, `--- exit ${code} ---${killed}`]
      .filter(Boolean).join('\n')) || `(no output, exit ${code})`
  }
  if (name === 'read_file') {
    const { code, out, err } = await execIn(c, ['-w', '/work', c, 'bash', '-c', READ_SCRIPT, '_', String(args.path ?? '')])
    return code === 0 ? clip(out) : `Could not read: ${(err || '').trim() || `exit ${code}`}`
  }
  if (name === 'write_file') {
    const body = args.content ?? ''
    const { code, err } = await execIn(c,
      ['-i', '-w', '/work', c, 'bash', '-c', WRITE_SCRIPT, '_', String(args.path ?? '')],
      body)
    return code === 0 ? `Wrote ${args.path} (${body.length} characters)` : `Could not write: ${(err || '').trim()}`
  }
  return `Unknown tool ${name}`
}

// ---------- what it costs ----------
// Every model call leaves a row, and every call is checked against the agent's daily cap
// first. Without this a routine looping unattended can spend a night's budget in silence.

/** Micro-dollars as a person reads them. Small amounts need more decimals or they all show as $0.00. */
const money = m => '$' + (Number(m) / db.MICRO).toFixed(Math.abs(Number(m)) < 10_000 ? 4 : 2)

/** This agent's cap: its own, else the platform default. null = uncapped. */
async function capFor(bot) {
  if (bot.daily_cap_micro != null) return Number(bot.daily_cap_micro)
  const d = await db.defaultCap()
  return d == null ? null : Number(d)
}

/**
 * Refuse the turn when today's spend is already at the cap. Checked before EVERY model call,
 * not once per turn: a turn using tools is a dozen calls, and the cap is meant to stop the
 * dozenth. An upstream with no prices can't be measured, so it can't be capped — the UI says
 * so next to the field instead of letting people think a cap is guarding them.
 */
async function checkCap(bot, p) {
  if (!db.isPriced(p)) return
  const cap = await capFor(bot)
  if (cap == null) return
  const spent = await db.spentToday(bot.id)
  if (spent < cap) return
  throw Object.assign(new Say('spend.capped', { name: bot.name, cap: money(cap), spent: money(spent) }, 402),
    { capped: true })
}

/**
 * Write down what a call cost. Deliberately not awaited: the reply is still streaming and a
 * database round-trip per step would be felt. A row that cannot be written is logged — it may
 * be lost, but never silently.
 */
function noteUsage(ctx, p, usage) {
  if (!usage) return Promise.resolve()
  return db.recordUsage({
    agent_id: ctx.bot.id, scope: ctx.scope ?? 'dm', scope_id: ctx.scopeId ?? ctx.bot.id,
    provider_id: p.id ?? '', model: p.model ?? '',
    prompt_tokens: usage.prompt, completion_tokens: usage.completion,
    cost_micro: db.costOf(p, usage.prompt, usage.completion), estimated: usage.estimated === true,
  }).catch(e => console.error(`usage row lost for ${ctx.bot.id}:`, e.message))
}

/** Call the model once. Protocol translation and stream parsing live in protocols.mjs; here we only decide which tools to send. */
function callModel(p, messages, onDelta, { bare = false, signal, tools } = {}) {
  const list = bare ? null : tools !== undefined ? tools : CFG.tools ? TOOL_SPECS : null
  return callUpstream(p, messages, list?.length ? list : null, onDelta, signal)
}

/**
 * The tools this agent gets this turn: the machine tools when AGENT_TOOLS is on, plus `studio` if
 * the studio has it on the crew. A film crew works without shells — the studio tool needs none.
 */
async function toolsFor(bot) {
  const list = CFG.tools ? [...TOOL_SPECS] : []
  if (await studio.roleOf(bot.id).catch(() => null)) list.push(studio.TOOL)
  return list
}

/** A file on the agent's own machine, for the studio tool (asset.save, shot.plan from a file). */
async function readAgentFile(c, path, max) {
  const r = await execIn(c, ['-w', '/work', c, 'bash', '-lc', 'test -f "$1" || { echo "No such file" >&2; exit 2; }; ' +
    `s=$(stat -c %s -- "$1"); [ "$s" -le ${max} ] || { echo "larger than ${max} bytes" >&2; exit 3; }; base64 -w0 -- "$1"`, '_', path])
  if (r.code !== 0) return { error: (r.err || `exit ${r.code}`).trim().slice(0, 200) }
  return { buf: Buffer.from(r.out.trim(), 'base64') }
}

// Upstream failures come from protocols.mjs flagged with `upstream` / `upstreamStatus`.
const isUpstreamError = e => e?.upstream === true
const upstreamStatus = e => Number(e?.upstreamStatus) || 0

/**
 * One full turn for an agent: talk → use tools → look at results → keep talking, until it needs no more tools.
 * This is the difference between "like a real employee" and "a chat box".
 *
 * Re-trim to the context window before every model call — tool output grows the context within the turn,
 * and trimming only at the entrance would overflow by step three or four.
 */
async function runAgent(p, messages, onDelta, onTool, ctx) {
  if (p.runtime) return runCli(p, messages, onDelta, onTool, ctx)
  const MAX_STEPS = ctx.maxSteps ?? DEFAULT_STEPS
  const lang = ctx.lang ?? 'en'
  let text = ''
  for (let step = 0; step < MAX_STEPS; step++) {
    await checkCap(ctx.bot, p)
    const fit = fitContext(messages, p.context_tokens)
    if (fit.dropped) onTool?.({ phase: 'trim', dropped: fit.dropped })
    // Retry. Relay gateways hit bad channels at random (200 then an error inside the stream), and in a group chat
    // one silent empty turn means "the relay died on this person".
    //
    // ⚠️ Must back off before retrying. In group relays the first person reliably succeeded and the second reliably
    // failed — not random, the two calls were too close together and got rate-limited; retrying immediately guarantees another hit.
    let r
    for (const wait of [0, 2000, 6000]) {
      if (wait) await new Promise(t => setTimeout(t, wait))
      try { r = await callModel(p, fit.messages, onDelta, { signal: ctx.signal, tools: ctx.tools }); break }
      catch (e) {
        // Rejected with a 4xx while carrying a screenshot: most likely this model doesn't accept images. Drop them and carry on,
        // and stop sending screenshots afterwards — otherwise a model that can't see images fails the whole turn on the browser
        // ⚠️ Not 408/409/429: those are "slow down", not "can't see images". Treating a rate limit as a
        // refusal quietly blinded the reviewer for the rest of the turn — it went on judging a sheet it
        // never saw. Those go through the ordinary backoff below.
        const st = upstreamStatus(e)
        if (isUpstreamError(e) && st >= 400 && st < 500 && ![408, 409, 429].includes(st) && dropImages(messages)) {
          ctx.noImages = true
          onTool?.({ phase: 'retry', reason: tr(lang, 'chat.noImages') })
          r = null; break
        }
        if (ctx.signal?.aborted || !isUpstreamError(e) || wait === 6000) throw e
        onTool?.({ phase: 'retry', reason: errorText(e, lang).slice(0, 120) })
      }
    }
    if (!r) { step--; continue }
    const { content, calls, usage, reasoning } = r
    noteUsage(ctx, p, usage)
    if (content) text = content
    // The caller stores the final answer's reasoning with it (DeepSeek wants it back next turn too)
    ctx.reasoning = reasoning ?? ''
    if (!calls.length) return text

    messages.push({
      role: 'assistant',
      content: content || null,
      ...reasoning ? { reasoning_content: reasoning } : {},
      tool_calls: calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args } })),
    })
    const shots = []
    for (const c of calls) {
      if (ctx.signal?.aborted) throw new Say('chat.aborted')
      let args = {}
      try { args = JSON.parse(c.args || '{}') } catch { args = {} }
      const { out, image } = await execTool(c.name, args, ctx, onTool)
      if (image) shots.push(image)
      messages.push({ role: 'tool', tool_call_id: c.id, content: out })
    }
    // An image can't go into a tool result (Chat protocol tool messages only take text), so it follows as a user message.
    // Keep only the newest step's images (at most 4): ten screenshots in a turn would each be paid for at every step,
    // and the old ones are useless. Several in one step is real — a reviewer compares a sheet with a reference.
    if (shots.length) {
      dropImages(messages, '(an image was here; it has been replaced by a newer one)')
      messages.push({ role: 'user', content: '(the image(s) your last tool call returned)', images: shots.slice(-4) })
    }
  }
  return text || '(hit the tool-use limit; stopping here for now)'
}

// ---------- Agents on a coding CLI (web/cli.mjs) ----------
// Claude Code, Codex and Grok Build run in the cli module's container, one process per turn,
// signed in once with a person's own account in that container's home — which every agent
// shares. The CLI is the model loop; the tools are still ours: served over MCP at /mcp on this
// port, they go through execTool like on our own loop (approval, transcript row, the agent's own
// container). Every built-in tool of the CLI is switched off — see cli.mjs for why that matters.

const CLIMOD = { container: env.CLI_CONTAINER || '', mcpUrl: env.CLI_MCP_URL || `http://app:${CFG.port}/mcp` }
// How much of the conversation goes into a CLI turn. Each CLI compacts on its own, but it starts
// every turn from what we give it; this keeps a year-long chat from arriving whole.
const CLI_CONTEXT = 150_000
// bearer token → the running turn's tools. A token exists only while its turn runs.
const cliTurns = new Map()

/**
 * The conversation as one prompt. A CLI starts fresh every turn: the history — a DM's, or the
 * group log with everyone's names — lives in our database, as it does for every other agent.
 */
function cliPrompt(messages) {
  const rest = messages.slice(1).filter(m => (m.role === 'user' || m.role === 'assistant') && m.content)
  const line = m => m.role === 'assistant' ? `[You] ${m.content}`
    : /^\[[^\]\n]{1,60}\] /.test(m.content) ? m.content : `[User] ${m.content}`
  const last = rest.pop()
  const earlier = rest.map(line).join('\n\n')
  return (earlier ? `The conversation so far, oldest first ([You] is you):\n\n${earlier}\n\n---\nThe newest message — answer this now:\n\n` : '')
    + (last ? line(last) : '')
}

/**
 * One turn on a CLI. The shell wrapper records the CLI's pid inside the container (killing the
 * `docker exec` client does not kill what it started — 2.22.1), writes the system prompt to a
 * file, keeps Grok's MCP entry current, and moves into this agent's own directory so each
 * agent's CLI state stays apart.
 */
async function runCli(p, messages, onDelta, onTool, ctx) {
  // A stream can close while the database/context is loading, before this listener exists.
  if (ctx.signal?.aborted) throw new Say('chat.aborted')
  if (!CLIMOD.container) throw new Say('cli.off')
  const rt = p.runtime
  const spec = RUNTIMES[rt]
  if (!spec) throw new Say('cli.unknown', { id: rt })
  // Grok reads a tool's image as text: it would get a base64 blob. Tell our tools to say so instead.
  if (!spec.images) ctx.noImages = true
  const fit = fitContext(messages, p.context_tokens)
  if (fit.dropped) onTool?.({ phase: 'trim', dropped: fit.dropped })
  const system = fit.messages[0]?.role === 'system' ? fit.messages[0].content : ''
  const id = randomBytes(8).toString('hex')
  const token = randomBytes(24).toString('base64url')
  cliTurns.set(token, {
    tools: ctx.tools ?? [],
    call: (name, args) => {
      if (ctx.signal?.aborted) throw new Say('chat.aborted')
      return execTool(name, args, ctx, onTool)
    },
  })
  const argv = turnArgs(rt, { model: p.model, effort: p.effort, maxTurns: ctx.maxSteps ?? DEFAULT_STEPS,
    system, systemFile: `/tmp/ma-${id}.sys`, mcp: { url: CLIMOD.mcpUrl, token } })
  const envs = { MA_TURN_TOKEN: token, MA_SYSTEM: system, MCP_TOOL_TIMEOUT: '86400000', ...rt === 'grok' ? GROK_ENV : {} }
  const block = rt === 'grok' ? grokMcpBlock(CLIMOD.mcpUrl) : ''
  const script = 'echo $$ > "/tmp/ma-$1.pid"; printf %s "$MA_SYSTEM" > "/tmp/ma-$1.sys"; unset MA_SYSTEM; ' +
    'if [ -n "$3" ]; then f="$HOME/.grok/config.toml"; mkdir -p "$HOME/.grok"; ' +
    '[ "$(sed -n "/^# >>> cirrayabot/,/^# <<< cirrayabot/p" "$f" 2>/dev/null)" = "$3" ] || ' +
    '{ sed -i "/^# >>> cirrayabot/,/^# <<< cirrayabot/d" "$f" 2>/dev/null; printf "\\n%s\\n" "$3" >> "$f"; }; fi; ' +
    'mkdir -p "$2" && cd "$2" && shift 3 && exec "$@"'
  const args = ['exec', '-i', ...Object.entries(envs).flatMap(([k, v]) => ['-e', `${k}=${v}`]), CLIMOD.container,
    'sh', '-c', script, '_', id, `/home/node/work/${ctx.bot.id}`, block ? `# >>> cirrayabot${block}# <<< cirrayabot` : '', ...argv]
  const child = spawn(CLI, args, { stdio: ['pipe', 'pipe', 'pipe'] })
  const rd = reader(rt)
  let err = '', buf = ''
  // Kill inside the container first, and only then the client: the cleanup below removes the pid
  // file, and started together the two execs raced — the kill found no pid, the CLI lived on.
  let killing = null
  const stop = () => {
    killing = cliRun(['exec', CLIMOD.container, 'sh', '-c', `kill $(cat /tmp/ma-${id}.pid) 2>/dev/null; true`], null, 10_000)
      .finally(() => child.kill())
  }
  ctx.signal?.addEventListener('abort', stop, { once: true })
  child.stdout.on('data', d => {
    buf += d
    for (let i; (i = buf.indexOf('\n')) >= 0;) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      for (const ev of rd.feed(line)) if (ev.delta) onDelta?.(ev.delta)
    }
  })
  child.stderr.on('data', d => { err = (err + d).slice(-4000) })
  child.stdin.on('error', () => {})
  child.stdin.end(cliPrompt(fit.messages))
  let code
  try {
    code = await new Promise(done => {
      child.on('close', done)
      child.on('error', e => { err += e.message; done(127) })
    })
  } finally {
    cliTurns.delete(token)
    ctx.signal?.removeEventListener('abort', stop)
    await killing
    cliRun(['exec', CLIMOD.container, 'rm', '-f', `/tmp/ma-${id}.pid`, `/tmp/ma-${id}.sys`], null, 10_000)
  }
  if (buf.trim()) for (const ev of rd.feed(buf)) if (ev.delta) onDelta?.(ev.delta)
  if (ctx.signal?.aborted) throw new Say('chat.aborted')
  // A subscription has no per-token price: the row keeps the tokens, and the cost stays unknown.
  const u = rd.usage()
  if (u) noteUsage(ctx, { id: p.id, model: p.model || rt }, u)
  ctx.reasoning = ''
  const answer = rd.answer()
  if (answer) return answer
  const why = plain(rd.error() || err.trim().split('\n').slice(-3).join(' ') || `exit ${code}`).slice(0, 300)
  if (needsLogin(why)) throw new Say('cli.login', { name: spec.name })
  throw new Say('cli.failed', { name: spec.name, detail: why })
}

// Signing a CLI in: its own flow, run in the cli container, finished by a person in a browser.
// id → { rt, child, out, state }. One sign-in per CLI at a time; a new one replaces the old.
const cliLogins = new Map()
const LOGIN_TIMEOUT = 15 * 60_000

function startLogin(rt) {
  for (const [id, l] of cliLogins) if (l.rt === rt) { stopLogin(id) }
  const id = randomUUID()
  const child = spawn(CLI, ['exec', '-i', CLIMOD.container, 'sh', '-c', 'echo $$ > "/tmp/ma-login-$1.pid"; shift; exec "$@"', '_', rt,
    ...loginArgs(rt)], { stdio: ['pipe', 'pipe', 'pipe'] })
  const l = { rt, child, out: '', state: 'running' }
  const add = d => { l.out = (l.out + d).slice(-20_000) }
  child.stdout.on('data', add)
  child.stderr.on('data', add)
  child.stdin.on('error', () => {})
  child.on('close', code => { if (l.state === 'running') l.state = code === 0 ? 'done' : 'failed' })
  child.on('error', e => { add(e.message); l.state = 'failed' })
  l.timer = setTimeout(() => { if (l.state === 'running') { add('\n(timed out)'); stopLogin(id, 'failed') } }, LOGIN_TIMEOUT)
  cliLogins.set(id, l)
  return id
}

function stopLogin(id, state = 'cancelled') {
  const l = cliLogins.get(id)
  if (!l) return
  clearTimeout(l.timer)
  if (l.state === 'running') {
    l.state = state
    cliRun(['exec', CLIMOD.container, 'sh', '-c', `kill $(cat /tmp/ma-login-${l.rt}.pid) 2>/dev/null; true`], null, 10_000)
    l.child.kill()
  }
  // Keep a finished one around for a minute so the page can read how it ended.
  setTimeout(() => { if (cliLogins.get(id) === l) cliLogins.delete(id) }, 60_000)
}

const loginView = l => ({ runtime: l.rt, state: l.state, ...loginPrompt(l.out),
  output: plain(l.out).split('\n').filter(x => x.trim()).slice(-12).join('\n') })

async function cliStatus() {
  if (!CLIMOD.container) return { enabled: false, runtimes: [] }
  const runtimes = await Promise.all(RUNTIME_IDS.map(async rt => {
    const r = await cliRun(['exec', CLIMOD.container, ...statusArgs(rt)], null, 20_000)
    const running = /No such container|is not running/i.test(r.err) ? false : true
    return { id: rt, name: RUNTIMES[rt].name, running, ...statusOf(rt, r.code, r.out),
      agents: (await db.listAgents()).filter(a => a.runtime === rt).map(a => a.name) }
  }))
  return { enabled: true, runtimes }
}

/** One tool call, from asking to recording. Returns what the model gets back, and an image if there is one. */
async function execTool(name, args, ctx, onTool) {
  onTool?.({ phase: 'run', name, args })
  const allowed = !needsApproval(name, args, ctx.approval ?? { mode: 'off' })
    || await askApproval(ctx, onTool, name, args)
  // Hanging up while a card waits is not a refusal — recording one would leave the transcript
  // saying the user said no to something they never saw an answer for.
  if (ctx.signal?.aborted) throw new Say('chat.aborted')
  // The refusal goes back as the tool result so the agent adapts instead of retrying: it is the
  // only thing it will ever see about this call.
  const res = allowed
    ? await runTool(name, args, ctx).catch(e => `Tool error: ${errorText(e, 'en')}`)
    : `Refused${ctx.unattended ? ' (this ran as a scheduled task, with nobody there to approve it)' : ' by the user'}: ${toolSubject(name, args)}
Do not try this again. Do it another way, or say why you cannot.`
  const out = typeof res === 'string' ? res : res.text
  // Send the screenshot to the UI too: people need to see what the agent saw. Only through this stream, never stored
  onTool?.({ phase: 'done', name, args, output: out, ...res?.image ? { image: res.image } : {} })
  // Keep the call in the transcript, cut to the same length the live stream shows — reopening a
  // conversation should show the same cards, not more and not fewer.
  if (ctx.scope) await db.addTool(ctx.scope, ctx.scopeId, ctx.bot?.name ?? '',
    { name, args, output: (out ?? '').slice(0, TOOL_TRACE) })
  return { out, image: res?.image ?? null }
}

/**
 * An agent saving a skill by itself. Installed only for itself, source recorded as agent:<id>, and flagged in the UI —
 * skills change how it works from then on, and a web page it read could make it save one, so humans need to see it.
 * It cannot overwrite a same-named skill written by someone else (a human or another agent).
 */
async function saveSkillFromAgent(bot, args) {
  let k
  try { k = checkSkill(args) } catch (e) { return `Not saved: ${errorText(e, 'en')}` }
  const source = `agent:${bot.id}`
  const cur = await db.skillByName(k.name)
  if (cur && cur.source !== source)
    return `There is already a skill named "${cur.name}" that you didn't write, so you can't change it. Pick another name, or ask the user to edit it in the skill library.`
  await db.saveSkill({ id: cur?.id ?? 'k' + Date.now().toString(36), ...k, source,
    agents: [...new Set([...(cur?.agents ?? []), bot.id])] })
  return `${cur ? 'Updated' : 'Saved'} the skill "${k.name}", installed only for you. Next time you get a "${k.description}" kind of task, read_skill first, then do it.`
}

/**
 * An agent writing its own long-term memory. It can only ever reach its own notes —
 * never the memory a human wrote for it, never a group's, never another agent's.
 *
 * When the cap pushes old notes out we say exactly which ones: an agent that quietly
 * forgot something is worse than one that never remembered it.
 */
async function rememberFromAgent(bot, fact) {
  const r = addNote(await db.getSelfMemory(bot.id), fact)
  if (r.empty) return 'Nothing to remember: give the fact as one short sentence.'
  if (r.tooLong) return `Too long (at most ${NOTE_MAX_CHARS} characters). One short fact per call — if it is a procedure, save_skill is the place for it.`
  if (r.duplicate) return 'You already have that in your notes; nothing was added.'
  await db.setSelfMemory(bot.id, r.text)
  const forgot = r.dropped.length
    ? ` Your notes were full, so the oldest ${r.dropped.length} ${r.dropped.length === 1 ? 'is' : 'are'} gone: ${r.dropped.map(d => `"${d}"`).join('; ')}.`
    : ''
  const kept = r.text.split('\n').length
  return `Remembered — you now keep ${kept} note${kept === 1 ? '' : 's'}.${forgot}`
}

/** Strip every screenshot from the history (in place). Returns true if at least one was removed. */
function dropImages(messages, note = '(a screenshot was here; the current model can\'t see images, so it was removed)') {
  let n = 0
  for (const m of messages) if (m.images) { delete m.images; m.content = `${m.content ?? ''}\n${note}`; n++ }
  return n > 0
}

// One-on-one
function askSolo(p, bot, text, memory, onDelta, onTool, signal, lang, gate, from = USER_SPEAKER) {
  return withAgent(bot.id, async () => {
    const prior = (await db.recent('dm', bot.id, FETCH_MAX))
      .map(m => ({ role: m.role, content: m.content, ...m.role === 'assistant' && m.reasoning ? { reasoning_content: m.reasoning } : {} }))
    // Store first, then start the container: if the container won't start, what the user said shouldn't vanish with it
    await db.addMessage('dm', bot.id, { role: 'user', speaker: from, content: text })
    // With tools off there's no use for a container — and don't tell the persona it "has its own machine"
    const container = CFG.tools ? await ensureContainer(bot.id, null) : null
    const tools = await toolsFor(bot)
    const ctx = { container, signal, bot, lang, scope: 'dm', scopeId: bot.id, tools, maxSteps: bot.max_steps ?? undefined, ...gate }
    const full = await runAgent(p,
      [{ role: 'system', content: systemFor(bot, memory, null, CFG.tools ? '/work' : null, await groupRecallFor(bot), await db.skillsFor(bot.id), null, await studio.roleOf(bot.id).catch(() => null), await sharedName(bot.id)) + await projectIdentity(bot) },
       ...prior, { role: 'user', content: text }],
      onDelta, onTool, ctx)
    await db.addMessage('dm', bot.id, { role: 'assistant', speaker: bot.name, content: full, reasoning: ctx.reasoning })
    return full
  })
}

// One person speaking once in a group chat: he sees the WHOLE group log, with other people's words prefixed by name
function askInGroup(p, bot, peers, lead, memory, onDelta, onTool, groupId, signal, lang, gate) {
  return withAgent(bot.id, async () => {
    const container = CFG.tools ? await ensureContainer(bot.id, groupId) : null
    const tools = await toolsFor(bot)
    const messages = [{ role: 'system', content: systemFor(bot, memory, peers, CFG.tools ? '/work' : null, '', await db.skillsFor(bot.id), lead, await studio.roleOf(bot.id).catch(() => null), await sharedName(bot.id)) + await projectIdentity(bot) }]
    for (const e of await db.recent('group', groupId, FETCH_MAX)) {
      messages.push(e.speaker === bot.name
        ? { role: 'assistant', content: e.content, ...e.reasoning ? { reasoning_content: e.reasoning } : {} }   // what he said himself
        : { role: 'user', content: `[${modelSpeaker(e.speaker)}] ${e.content}` })     // what others and the user said
    }
    const ctx = { container, signal, bot, lang, scope: 'group', scopeId: groupId, tools, maxSteps: bot.max_steps ?? undefined, ...gate }
    const text = await runAgent(p, messages, onDelta, onTool, ctx)
    return { text, reasoning: ctx.reasoning ?? '' }
  })
}

/**
 * Find the colleague @-mentioned in a reply. Only the last @ counts, because the rule is one @ at a time.
 *
 * ⚠️ Do NOT add `\b` after the name. `\b` judges word boundaries by [A-Za-z0-9_];
 * CJK characters aren't \w, so after "@<Chinese name>" there is never a word boundary and it never matches —
 * and Chinese names are this product's main use case. It bit us for real: Chief wrote @<name>,
 * the group chat just stopped, which looked like "he didn't want to hand off" but was really the regex not matching.
 *
 * Longer names are tried first so that a longer name isn't stolen by a shorter one that is its prefix.
 */
function findMention(text, peers) {
  let hit
  for (const p of [...peers].sort((a, b) => b.name.length - a.name.length)) {
    const re = new RegExp(`@\\s*${p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'gi')
    let m
    while ((m = re.exec(text)) !== null) {
      if (!hit || m.index > hit.index) hit = { index: m.index, bot: p }
    }
  }
  return hit?.bot
}

/**
 * One conversation: a message comes in; in a direct chat that person replies, in a group the relay runs until nobody is @-ed.
 * Sending from the UI and a scheduled task firing both go through this one function — two implementations would drift apart.
 * Errors aren't thrown; they're reported via emit('error') (the UI shows them, scheduled tasks record them).
 */
async function converse(bots, groupId, providers, text, emit, signal, lang = 'en',
  { unattended = false, from = USER_SPEAKER, first = null } = {}) {
  try {
    const policy = await approvalPolicy()
    // Per agent: its own setting wins, otherwise the platform's. Resolved here so one turn can't
    // change its mind halfway through because someone saved the settings dialog.
    const gateFor = b => ({ unattended, approval: { ...policy, mode: b.approval || policy.mode } })
    if (!groupId && bots.length === 1) {
      const bot = bots[0]
      emit('start', { botId: bot.id })
      await askSolo(providers.get(bot.id), bot, text,
        { own: await db.getMemory('agent', bot.id), self: await db.getSelfMemory(bot.id) },
        d => emit('delta', { botId: bot.id, text: d }),
        t => emit('tool', { botId: bot.id, ...t, output: t.output?.slice(0, TOOL_TRACE) }), signal, lang, gateFor(bot), from)
      emit('end', { botId: bot.id })
    } else {
      // Group chat: colleagues relay. Who speaks first — whoever the caller names (an event), whoever the user
      // @-ed; if nobody, the group's lead; if no lead is set, whoever sorts first (Chief of Staff is 0).
      const gid = groupId ?? 'main'
      // One relay per group at a time. A person typing while the studio's "candidates ready" wakes the reviewer
      // would otherwise run two relays over one log, each reading the other's half-finished turns.
      await withGroup(gid, async () => {
      await db.addMessage('group', gid, { role: 'user', speaker: from, content: text })
      const g = (await db.listGroups()).find(x => x.id === gid)
      const lead = bots.find(b => b.id === g?.lead) ?? null
      let speaker = first ?? findMention(text, bots) ?? lead ?? bots[0]
      const spoken = new Map()
      for (let turn = 0; turn <= MAX_HANDOFFS && !signal.aborted; turn++) {
        const peers = bots.filter(b => b.id !== speaker.id)
        emit('start', { botId: speaker.id, turn })
        let reply = '', reasoning = ''
        try {
          ;({ text: reply, reasoning } = await askInGroup(providers.get(speaker.id), speaker, peers, lead,
            { own: await db.getMemory('agent', speaker.id), self: await db.getSelfMemory(speaker.id),
              group: await db.getMemory('group', gid) },
            d => emit('delta', { botId: speaker.id, text: d }),
            t => emit('tool', { botId: speaker.id, ...t, output: t.output?.slice(0, TOOL_TRACE) }),
            gid, signal, lang, gateFor(speaker)))
        } catch (e) {
          emit('error', { botId: speaker.id, message: errorText(e, lang).slice(0, 300), capped: e?.capped === true })
          break
        }
        await db.addMessage('group', gid, { role: 'assistant', speaker: speaker.name, content: reply, reasoning })
        emit('end', { botId: speaker.id })

        const next = findMention(reply, peers)
        if (!next) break                                   // nobody @-ed = the matter is done
        const count = (spoken.get(next.id) ?? 0) + 1
        spoken.set(next.id, count)
        if (count > 2) { emit('note', { text: tr(lang, 'chat.spokenEnough', { name: next.name, n: count - 1 }) }); break }
        // The last turn still @-ed someone: the relay limit is reached. Without saying so the UI shows "A → @B" and B never speaks
        if (turn === MAX_HANDOFFS) { emit('note', { text: tr(lang, 'chat.relayLimit', { max: MAX_HANDOFFS, name: next.name }) }); break }
        emit('handoff', { from: speaker.id, to: next.id })
        speaker = next
      }
      })
    }
  } catch (e) {
    emit('error', { botId: bots[0].id, message: errorText(e, lang).slice(0, 300), capped: e?.capped === true })
  }
}

// ---------- Scheduled tasks ----------
// When one is due, it's treated as someone sending a message in that conversation, through exactly the same converse as the UI.
// It spends money and runs commands in containers while nobody is watching, so: minimum interval 5 minutes (schedule.mjs),
// it stops itself after 5 consecutive failures, and the same task never runs overlapping.

/** Conversation target → who is in this conversation. A group short on members or a missing agent is explained here. */
async function resolveTarget(kind, id) {
  const all = await loadBots()
  if (kind === 'group') {
    const g = (await db.listGroups()).find(x => x.id === id)
    if (!g) throw new Say('err.noGroup')
    const bots = all.filter(b => g.members.includes(b.id))
    if (bots.length < 2) throw new Say('group.tooSmall', { name: g.name, n: bots.length })
    return { bots, groupId: g.id, name: g.name }
  }
  const bot = all.find(b => b.id === id)
  if (!bot) throw new Say('err.noAgent')
  return { bots: [bot], groupId: null, name: bot.name }
}

const MAX_ROUTINE_FAILURES = 5
const routineRunning = new Set()

const routineView = r => ({
  ...r, running: routineRunning.has(r.id),
})

/** Run a task once. Never throws: the result is written back to the task's row, visible in the UI. */
async function runRoutine(r) {
  if (routineRunning.has(r.id)) return false
  routineRunning.add(r.id)
  const startedAt = Date.now()
  let error = '', capped = false
  try {
    const { bots, groupId } = await resolveTarget(r.target_kind, r.target_id)
    const providers = new Map()
    for (const b of bots) providers.set(b.id, await providerFor(b))
    // The opening line tells the agent this isn't a human talking live, so the result must be written out for when they come back
    const text = `[Scheduled task "${r.name}", sent automatically — nobody is watching live. When you're done, write up the result clearly.]\n${r.prompt}`
    await converse(bots, groupId, providers, text,
      (ev, d) => { if (ev === 'error' && !error) { error = d.message; capped = d.capped === true } },
      new AbortController().signal, 'en', { unattended: true })
  } catch (e) {
    error = errorText(e, 'en').slice(0, 300)
  } finally {
    routineRunning.delete(r.id)
  }
  // Re-read it: someone may have edited it during these minutes (changed the time, paused it); those edits must not be overwritten here
  const cur = await db.getRoutine(r.id)
  if (!cur) return true
  // Hitting the spend cap is not the task misbehaving — the reason is recorded, but it must not
  // count towards the crash-loop counter, or a cap would disable the task it was only meant to pause.
  const failures = capped ? cur.failures : error ? cur.failures + 1 : 0
  const tripped = failures >= MAX_ROUTINE_FAILURES
  await db.saveRoutine({ ...cur, last_run_at: startedAt, last_status: capped ? 'capped' : error ? 'failed' : 'ok',
    last_error: tripped ? tr('en', 'routine.tripped', { n: failures, error }) : error,
    failures, enabled: cur.enabled && !tripped })
  if (error) console.log(`Scheduled task "${r.name}" ${capped ? 'stopped at the spend cap' : 'failed'}: ${error}`)
  return true
}

/** One tick of the scheduler. Write the next run time before starting — otherwise a process dying midway would rerun it after restart. */
async function tickRoutines() {
  for (const r of await db.dueRoutines()) {
    if (routineRunning.has(r.id)) continue
    const next = nextRun(r, Date.now())
    await db.saveRoutine({ ...r, next_run_at: next, enabled: next != null })
    runRoutine(r)
  }
}

// A validation error from schedule.mjs / skill.mjs: pass Say through, turn anything else into a 400.
const asBadRequest = e => (e instanceof Say ? e : Object.assign(new Error(e.message), { status: 400 }))

/** The skill form: three fields + who it's installed for. The name can't clash with another skill (case-insensitive). */
async function checkSkillBody(b, selfId = null) {
  let k
  try { k = checkSkill(b) } catch (e) { throw asBadRequest(e) }
  const clash = await db.skillByName(k.name)
  if (clash && clash.id !== selfId) throw new Say('skill.exists', { name: clash.name })
  if (!Array.isArray(b.agents ?? []) || (b.agents ?? []).some(a => typeof a !== 'string')) throw new Say('skill.agentsArray')
  const known = new Set((await db.listAgents()).map(a => a.id))
  return { ...k, agents: [...new Set(b.agents ?? [])].filter(a => known.has(a)) }
}

/** Form → task fields. On PATCH, fields not sent keep their old values. */
async function checkRoutine(b, cur = null) {
  const name = str(b.name ?? cur?.name).trim()
  if (!name) throw new Say('routine.nameRequired')
  const prompt = str(b.prompt ?? cur?.prompt).trim()
  if (!prompt) throw new Say('routine.promptRequired')
  const target_kind = b.target_kind ?? cur?.target_kind
  const target_id = str(b.target_id ?? cur?.target_id)
  if (!['agent', 'group'].includes(target_kind)) throw new Say('routine.target')
  await resolveTarget(target_kind, target_id)
  let sched
  try {
    sched = checkSchedule(cur ? { kind: cur.kind, every_minutes: cur.every_minutes, at_time: cur.at_time,
      weekdays: cur.weekdays, run_at: cur.run_at, tz: cur.tz, ...b } : b)
  } catch (e) { throw asBadRequest(e) }
  const enabled = b.enabled ?? cur?.enabled ?? true
  if (typeof enabled !== 'boolean') throw new Say('routine.enabled')
  return { name: name.slice(0, 60), prompt: prompt.slice(0, 4000), target_kind, target_id, ...sched, enabled }
}

// ---------- Upstreams ----------
// api_key never goes back to the browser; we only say whether it's set and what its tail is.
const safeProvider = (p, lang = 'en') => ({
  id: p.id, name: p.name, base_url: p.base_url, protocol: p.protocol,
  // Prices per million tokens, micro-dollars. null = never set, so calls here cost "unknown", not 0.
  price_in_micro: p.price_in_micro == null ? null : Number(p.price_in_micro),
  price_out_micro: p.price_out_micro == null ? null : Number(p.price_out_micro),
  context_tokens: p.context_tokens, auto_context: p.auto_context,
  ctx_source: tr(lang, p.auto_context ? 'provider.ctxAuto' : 'provider.ctxManual'), is_default: p.is_default,
  key_hint: p.api_key ? `••••${p.api_key.slice(-4)}` : '',
})

async function requireProvider() {
  const p = await db.activeProvider()
  if (!p) throw new Say('provider.none')
  return p
}

// The context window is a property of the model, and the model now follows the agent, so probe per (upstream, model), cached for an hour.
// Only cache real answers: caching the fallback would mean never asking again after the upstream is fixed.
const ctxCache = new Map()
async function contextFor(base, model) {
  if (!base.auto_context) return base.context_tokens
  const key = `${base.id}|${base.base_url}|${model}`
  const hit = ctxCache.get(key)
  if (hit && hit.until > Date.now()) return hit.tokens
  const r = await probeContext({ ...base, model })
  if (r.tokens) ctxCache.set(key, { tokens: r.tokens, until: Date.now() + 3600_000 })
  return r.tokens ?? 128_000
}

/** Which upstream and model this agent uses. Without its own upstream it follows the default; the model must be its own choice. */
async function providerFor(bot) {
  // On a coding CLI there is no upstream of ours: the CLI's own account (or config) is the upstream,
  // and an empty model means that account's default.
  if (bot.runtime) {
    const effort = normEffort(bot.effort) || normEffort(await db.defaultEffort())
    return { runtime: bot.runtime, id: `cli:${bot.runtime}`, name: RUNTIMES[bot.runtime]?.name ?? bot.runtime,
      model: bot.model ?? '', effort, context_tokens: CLI_CONTEXT }
  }
  const base = bot.provider_id ? await db.getProvider(bot.provider_id) : await requireProvider()
  if (!base) throw new Say('provider.gone', { name: bot.name })
  if (!bot.model) throw new Say('provider.noModel', { name: bot.name })
  // An agent's own effort wins; empty means "whatever the platform says", and the
  // platform's own empty means send nothing — what every model got before this existed.
  const effort = normEffort(bot.effort) || normEffort(await db.defaultEffort())
  return { ...base, model: bot.model, effort, context_tokens: await contextFor(base, bot.model) }
}

/**
 * A price field from a form: a number in micro-dollars per million tokens, or null when the
 * box is empty. Empty means "we were never told", which is not the same as free — calls on
 * such an upstream record tokens with no cost, and cannot be capped.
 */
function priceField(v, fallback) {
  if (v === undefined) return fallback ?? null
  if (v === null || v === '') return null
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) throw new Say('spend.badPrice')
  return Math.round(n)
}

/** Save an upstream. Auto = probe per agent's chosen model at chat time; manual = every model on this upstream uses the number given. */
async function saveProviderWithContext(row, { auto, tokens }) {
  if (auto) {
    row.context_tokens = 128_000
    row.ctx_source = tr('en', 'provider.ctxAuto')
    row.auto_context = true
  } else {
    row.context_tokens = Math.max(2000, Number(tokens) || 128_000)
    row.ctx_source = tr('en', 'provider.ctxManual')
    row.auto_context = false
  }
  return db.saveProvider(row)
}

/** Request body → an upstream we can call: id means a saved one (empty = default), form fields override it (empty key = keep the stored one). */
async function providerFromBody(b) {
  const id = str(b.id).trim()
  const cur = id ? await db.getProvider(id) : (b.base_url ? null : await db.activeProvider())
  if (id && !cur) return null
  const base_url = String(b.base_url || cur?.base_url || '').trim().replace(/\/+$/, '')
  if (!base_url) return null
  const def = cur && (await db.activeProvider())?.id === cur.id
  const inUse = cur && (await db.listAgents())
    .find(a => a.model && (a.provider_id ? a.provider_id === cur.id : def))?.model
  return {
    base_url, api_key: b.api_key || cur?.api_key || '',
    protocol: normProtocol(b.protocol ?? cur?.protocol), context_tokens: 128_000,
    inUse: inUse || cur?.model || '',
  }
}

// ---------- Events from the studio ----------
/**
 * A studio notice into a group: stored under the speaker "Studio", and — if `wake` names an agent
 * who is in the group — that agent takes it from there, exactly as if a person had @-ed them.
 * Unattended: there is no stream for an approval card, so anything gated is refused, not left waiting.
 * Answers at once (202); the relay runs in the background, queued behind anything already running
 * in that group.
 */
async function postEvent(req, gid) {
  const want = Buffer.from(env.STUDIO_EVENT_TOKEN || '')
  const got = Buffer.from(String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''))
  if (!want.length || got.length !== want.length || !timingSafeEqual(got, want)) return [401, { error: 'bad event token' }]
  const b = await readBody(req)
  const text = str(b.text).trim().slice(0, 8000)
  if (!text) return [400, { error: 'empty text' }]
  const g = (await db.listGroups()).find(x => x.id === gid)
  if (!g) return [404, { error: `no group ${gid}` }]
  const bots = (await loadBots()).filter(x => g.members.includes(x.id))
  const first = (Array.isArray(b.wake) ? b.wake : []).map(id => bots.find(x => x.id === id)).find(Boolean) ?? null
  const content = first ? `@${first.name} ${text}` : text
  if (!first || bots.length < 2) {
    await withGroup(gid, () => db.addMessage('group', gid, { role: 'user', speaker: studio.STUDIO_SPEAKER, content }))
    return [202, { woke: null }]
  }
  const providers = new Map()
  try { for (const x of bots) providers.set(x.id, await providerFor(x)) }
  catch (e) {
    // Nobody can answer (an agent without a model, say): the notice is still kept, and the reason logged.
    await withGroup(gid, () => db.addMessage('group', gid, { role: 'user', speaker: studio.STUDIO_SPEAKER, content }))
    console.error(`Studio event for ${g.name} stored but nobody woken: ${errorText(e, 'en')}`)
    return [202, { woke: null, error: errorText(e, 'en') }]
  }
  converse(bots, gid, providers, content, (ev, d) => {
    if (ev === 'error') console.error(`Studio event relay in ${g.name}: ${d.message}`)
  }, new AbortController().signal, 'en', { unattended: true, from: studio.STUDIO_SPEAKER, first })
  return [202, { woke: first.id }]
}

/**
 * A studio work order for one crew member, run in that member's own chat (the pipeline's way of
 * handing work over — not an @ in the group). Stored under the speaker "Studio" so the member and
 * a person reading the chat both see where it came from. The group gets one line (`report`, with
 * {agent} filled in) so everyone can see who has what. Unattended, like a scheduled task: anything
 * that needs a person's approval is refused rather than left waiting.
 *
 * Answers when the turn is over, so the studio can look at what changed and decide whether the
 * order is done; {ok:false, error} when the turn failed (no model, the upstream refused, the cap…).
 */
async function postOrder(req) {
  const want = Buffer.from(env.STUDIO_EVENT_TOKEN || '')
  const got = Buffer.from(String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''))
  if (!want.length || got.length !== want.length || !timingSafeEqual(got, want)) return [401, { error: 'bad event token' }]
  const b = await readBody(req)
  const text = str(b.text).trim().slice(0, 20_000)
  if (!text) return [400, { error: 'empty text' }]
  // The studio knows roles, not groups: of the agents with this role, the one in the project's
  // group gets it (a second film's crew is a second group); otherwise the studio's first choice.
  const g = str(b.group) ? (await db.listGroups()).find(x => x.id === str(b.group)) : null
  const binding = g && await crews.forGroup(g.id)
  if (binding && b.project !== binding.project_id) return [400, { ok: false, error: 'work order project/crew mismatch' }]
  const known = new Set((await db.listAgents()).map(a => a.id))
  const ids = (Array.isArray(b.candidates) ? b.candidates : []).filter(x => typeof x === 'string' && known.has(x))
  // A missing member is an error, never a fallback to another project's same-role member.
  const pick = g ? ids.find(id => g.members.includes(id)) : null
  const bot = pick ? await db.getAgent(pick) : null
  if (!bot) return [404, { ok: false, error: 'none of the crew members with this role exists on the platform' }]
  if (g && str(b.report)) await withGroup(g.id, () => db.addMessage('group', g.id,
    { role: 'user', speaker: studio.STUDIO_SPEAKER, content: str(b.report).replaceAll('{agent}', bot.name).slice(0, 2000) }))
  let error = ''
  try {
    let p
    // A member who can't run (no model chosen, say) still gets the order in their chat, so a person
    // reading it sees what was asked — then the studio is told why nothing happened.
    try { p = await providerFor(bot) }
    catch (e) { await db.addMessage('dm', bot.id, { role: 'user', speaker: studio.STUDIO_SPEAKER, content: text }); throw e }
    const providers = new Map([[bot.id, p]])
    await converse([bot], null, providers, text, (ev, d) => { if (ev === 'error' && !error) error = d.message },
      new AbortController().signal, 'en', { unattended: true, from: studio.STUDIO_SPEAKER })
  } catch (e) { error = errorText(e, 'en') }
  if (error) console.error(`Studio work order for ${bot.name}: ${error}`)
  return [200, error ? { ok: false, agent: bot.id, error: error.slice(0, 500) } : { ok: true, agent: bot.id }]
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }

// Compared as hashes of equal length, so the time taken says nothing about how much of a guess was right.
const digest = v => createHash('sha256').update(String(v)).digest()
const sameToken = v => !!CFG.token && v != null && timingSafeEqual(digest(v), digest(CFG.token))
const cookieValue = (req, name) => {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()) } catch { return null }
    }
  }
  return null
}
const cookieToken = req => cookieValue(req, 'ma_token')
const passwordSession = req => cookieValue(req, '__Host-ma_session')
const secureRequest = req => req.socket.encrypted || (CFG.proxySecret && req.headers['x-forwarded-proto'] === 'https' &&
  req.headers['x-login-proxy-token'] != null && timingSafeEqual(digest(req.headers['x-login-proxy-token']), digest(CFG.proxySecret)))
const LOGIN_WINDOW_MS = 15 * 60_000
const LOGIN_MAX_FAILURES = 5
const loginFailures = new Map()
const loginIp = req => String(req.headers['x-forwarded-for'] ?? '').split(',').map(s => s.trim()).filter(Boolean).at(-1)
  || req.socket.remoteAddress || 'unknown'
function loginBlockedFor(ip, now = Date.now()) {
  const entry = loginFailures.get(ip)
  if (!entry) return 0
  if (now - entry.startedAt >= LOGIN_WINDOW_MS) { loginFailures.delete(ip); return 0 }
  return entry.failures >= LOGIN_MAX_FAILURES ? LOGIN_WINDOW_MS - (now - entry.startedAt) : 0
}
function recordLoginFailure(ip, now = Date.now()) {
  const entry = loginFailures.get(ip)
  if (!entry || now - entry.startedAt >= LOGIN_WINDOW_MS) loginFailures.set(ip, { startedAt: now, failures: 1 })
  else entry.failures++
  if (loginFailures.size > 4096) loginFailures.delete(loginFailures.keys().next().value)
}
function authed(req, url) {
  if (CFG.loginPasswordHash) {
    if (verifyPasswordSession(passwordSession(req), CFG.loginPasswordHash)) return true
    // Keep the native client/API credential working, but never let a pasted token link open the browser UI.
    return url.pathname.startsWith('/api/') && sameToken(url.searchParams.get('k'))
  }
  if (!CFG.token) return true                       // no guard when only listening locally
  return sameToken(url.searchParams.get('k')) || sameToken(cookieToken(req))
}

const readBody = async req => {
  let b = ''
  for await (const c of req) b += c
  if (!b) return {}
  let v
  try { v = JSON.parse(b) } catch { throw new Say('body.notJson') }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Say('body.notObject')
  return v
}
const readLoginBody = async req => {
  let size = 0, tooLarge = false
  const chunks = []
  for await (const c of req) {
    size += c.length
    if (size > 4096) tooLarge = true
    else chunks.push(c)
  }
  if (tooLarge) throw Object.assign(new Error('request too large'), { status: 413 })
  let v
  try { v = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw Object.assign(new Error('invalid request'), { status: 400 }) }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw Object.assign(new Error('invalid request'), { status: 400 })
  return v
}
const str = v => (typeof v === 'string' ? v : '')

/** Agent field validation. On PATCH only the fields sent are checked. */
async function checkAgent(b, selfId = null) {
  const out = {}
  if (b.name !== undefined || !selfId) {
    const name = str(b.name).trim()
    if (!name) throw new Say('agent.nameEmpty')
    if (name.length > 40) throw new Say('agent.nameLong')
    // Group logs identify people by name: duplicate names make two agents take each other's words as their own,
    // and one named like the user marker (or "User", as the model sees it) would take the human's words as its own
    if ([USER_SPEAKER, studio.STUDIO_SPEAKER].some(r => r.toLowerCase() === name.toLowerCase())) throw new Say('agent.nameReserved', { name })
    const existing = selfId ? await db.getAgent(selfId) : null
    if (existing && await crews.forAgent(selfId) && name !== existing.name)
      throw Object.assign(new Error('独立剧组的固定成员名称不能更改。'), { status: 400 })
    const clash = existing?.name === name ? null : (await db.listAgents()).find(a => a.id !== selfId && a.name.toLowerCase() === name.toLowerCase())
    if (clash) throw new Say('agent.exists', { name: clash.name })
    out.name = name
  }
  if (b.persona !== undefined || !selfId) {
    const persona = str(b.persona).trim()
    if (!persona) throw new Say('agent.personaEmpty')
    out.persona = persona
  }
  if (b.description !== undefined) out.description = str(b.description).trim().slice(0, 200)
  if (b.color !== undefined) {
    if (!/^#[0-9a-fA-F]{6}$/.test(str(b.color))) throw new Say('agent.color')
    out.color = b.color
  }
  if (b.order !== undefined) {
    if (!Number.isInteger(b.order)) throw new Say('agent.order')
    out.ord = b.order
  }
  // Empty = follow the default upstream / use the upstream's own model
  if (b.provider_id !== undefined) {
    const pid = str(b.provider_id).trim()
    if (pid && !await db.getProvider(pid)) throw new Say('err.noProvider')
    out.provider_id = pid
  }
  // Micro-dollars, or null for "no cap of its own" (then the platform default applies).
  if (b.daily_cap_micro !== undefined) {
    const v = b.daily_cap_micro
    if (v !== null && v !== '' && !(Number.isFinite(Number(v)) && Number(v) >= 0)) throw new Say('spend.badCap')
    out.daily_cap_micro = v === null || v === '' ? null : Math.round(Number(v))
  }
  // '' = send nothing (the default, and what models that don't know the parameter want anyway)
  if (b.effort !== undefined) {
    const e = str(b.effort).trim()
    if (e && !EFFORTS.includes(e)) throw new Say('agent.effort', { list: EFFORTS.join(' / ') })
    out.effort = e
  }
  // '' = follow the platform setting; see APPROVAL_MODES.
  if (b.approval !== undefined) {
    const a = str(b.approval).trim()
    if (a && !APPROVAL_MODES.includes(a)) throw new Say('agent.approval', { list: APPROVAL_MODES.join(' / ') })
    out.approval = a
  }
  // null / '' = the default. Capped so a looping agent can't run a hundred paid steps in one turn.
  if (b.max_steps !== undefined) {
    const v = b.max_steps
    if (v === null || v === '') out.max_steps = null
    else if (!Number.isInteger(Number(v)) || Number(v) < 1 || Number(v) > 60) throw new Say('agent.maxSteps')
    else out.max_steps = Number(v)
  }
  // Creating with an explicitly empty model is allowed: that is the state agents seeded from bots/
  // start in, and the crew importer uses it — which upstream and model each person runs on is the
  // person's choice, and the first chat says "no model chosen yet". Omitting the field on create,
  // or emptying it on an edit, is still an error.
  // '' = our own loop. A CLI needs the cli module; an agent already on one keeps working as far as
  // this check goes, and its turn says what is missing instead.
  if (b.runtime !== undefined) {
    const r = str(b.runtime).trim()
    if (r && !RUNTIME_IDS.includes(r)) throw new Say('agent.runtime', { list: RUNTIME_IDS.join(' / ') })
    if (r && !CLIMOD.container) throw new Say('cli.off')
    out.runtime = r
  }
  // On a CLI the model is optional: empty = whatever that CLI (and the account it is signed in
  // with) uses by default. On our own loop an upstream needs a model.
  const onCli = !!(out.runtime ?? (selfId ? (await db.getAgent(selfId))?.runtime : ''))
  if (b.model !== undefined || !selfId) {
    const model = str(b.model).trim()
    if (!model && !onCli && (selfId || b.model !== '')) throw new Say('agent.modelRequired')
    if (model.length > 200) throw new Say('agent.modelLong')
    out.model = model
  }
  return out
}

/** Group field validation: members must be real agents, deduplicated, at least two. */
async function checkGroup(b, cur = null) {
  const out = {}
  if (b.name !== undefined || !cur) {
    const name = str(b.name).trim()
    if (!name) throw new Say('group.nameRequired')
    out.name = name.slice(0, 40)
  }
  if (b.members !== undefined || !cur) {
    if (!Array.isArray(b.members) || b.members.some(m => typeof m !== 'string')) throw new Say('group.membersArray')
    const known = new Set((await db.listAgents()).map(a => a.id))
    const members = [...new Set(b.members)].filter(m => known.has(m))
    if (members.length < 2) throw new Say('group.tooFew')
    const fixed = cur && await crews.forGroup(cur.id)
    if (fixed && (members.length !== cur.members.length || members.some(id => !cur.members.includes(id))))
      throw Object.assign(new Error('项目剧组固定四个岗位；新项目请新建独立剧组。'), { status: 400 })
    for (const id of members) {
      const bound = await crews.forAgent(id)
      if (bound && bound.group_id !== cur?.id)
        throw Object.assign(new Error('该成员属于独立项目，不能加入其他剧组。请新建项目 / 剧组。'), { status: 400 })
    }
    out.members = members
  }
  // The lead must be in the group. If members changed and the lead was removed, fall back to "not set"
  const members = out.members ?? cur?.members ?? []
  if (b.lead !== undefined) {
    const lead = str(b.lead).trim()
    if (lead && !members.includes(lead)) throw new Say('group.leadNotMember')
    out.lead = lead || null
  } else if (cur?.lead && !members.includes(cur.lead)) out.lead = null
  if (b.shared_machine !== undefined) out.shared_machine = b.shared_machine === true
  return out
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  const lang = langOf(req, url)
  const t = (key, vars) => tr(lang, key, vars)
  const send = (code, body, type = 'application/json; charset=utf-8') =>
    { res.writeHead(code, { 'content-type': type }); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)) }

  // The health check skips auth: compose / k8s probes have no token, and blocking them leaves the container
  // unhealthy forever — a lying health status costs more than no health check.
  // It only returns {ok:true} and leaks no data.
  if (url.pathname === '/healthz') {
    try { await db.pool.query('select 1'); return send(200, { ok: true }) }
    catch (e) { return send(503, { ok: false, error: String(e.message ?? e) }) }
  }
  // The studio telling a group something ("candidates ready"). Its own token, not ACCESS_TOKEN: the
  // studio must not hold the key to every container shell just to post a notice.
  const evm = url.pathname.match(/^\/api\/events\/(?:group\/([\w-]+)|(order))$/)
  if (evm && req.method === 'POST') {
    try { return send(...await (evm[2] ? postOrder(req) : postEvent(req, evm[1]))) }
    catch (e) { return send(e.status ?? 500, { error: e instanceof Say ? e.text('en') : String(e.message ?? e) }) }
  }
  // Our tools for a CLI turn (web/mcp.mjs). Not behind ACCESS_TOKEN: the CLI holds only its turn's
  // bearer token, which opens that turn's tools and nothing else, and dies with the turn. Without a
  // valid token the answers are empty, never a 401 — a 401 sends MCP clients off looking for OAuth.
  if (url.pathname === '/mcp') {
    if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }); return res.end() }
    let msg
    let raw = ''
    for await (const c of req) { raw += c; if (raw.length > 20_000_000) break }
    try { msg = JSON.parse(raw) }
    catch { return send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) }
    const turn = cliTurns.get(String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')) ?? null
    const replies = (await Promise.all((Array.isArray(msg) ? msg : [msg]).map(m => mcp.handle(m, turn)))).filter(Boolean)
    if (!replies.length) { res.writeHead(202); return res.end() }
    return send(200, Array.isArray(msg) ? replies : replies[0])
  }
  if (CFG.loginPasswordHash && url.pathname === '/api/auth/login' && req.method === 'POST') {
    res.setHeader('cache-control', 'no-store')
    if (!secureRequest(req)) return send(426, { error: 'https_required' })
    if (!/^application\/json\b/i.test(String(req.headers['content-type'] ?? ''))) return send(415, { error: 'json_required' })
    const origin = req.headers.origin
    if (origin) {
      try {
        const parsed = new URL(origin)
        if (parsed.protocol !== 'https:' || parsed.host.toLowerCase() !== String(req.headers.host ?? '').toLowerCase())
          return send(403, { error: 'same_origin_required' })
      } catch { return send(403, { error: 'same_origin_required' }) }
    }
    let body
    try { body = await readLoginBody(req) }
    catch (e) { return send(e.status ?? 400, { error: 'invalid_request' }) }
    const ip = loginIp(req), wait = loginBlockedFor(ip)
    if (wait) {
      res.setHeader('retry-after', String(Math.ceil(wait / 1000)))
      return send(429, { error: 'rate_limited' })
    }
    const password = str(body.password)
    const ok = password.length > 0 && password.length <= 1024 && await verifyPassword(password, CFG.loginPasswordHash)
    if (!ok) {
      recordLoginFailure(ip)
      const retry = loginBlockedFor(ip)
      if (retry) res.setHeader('retry-after', String(Math.ceil(retry / 1000)))
      return send(retry ? 429 : 401, { error: retry ? 'rate_limited' : 'invalid_password' })
    }
    loginFailures.delete(ip)
    const cookie = `__Host-ma_session=${makePasswordSession(CFG.loginPasswordHash)}; Path=/; Max-Age=${SESSION_MAX_AGE}; HttpOnly; Secure; SameSite=Lax`
    res.setHeader('set-cookie', [cookie, 'ma_token=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax'])
    return send(200, { ok: true })
  }
  if (CFG.loginPasswordHash && url.pathname === '/api/auth/logout' && req.method === 'POST') {
    res.setHeader('cache-control', 'no-store')
    res.setHeader('set-cookie', `__Host-ma_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`)
    return send(200, { ok: true })
  }
  if (CFG.loginPasswordHash && req.method === 'GET' &&
      (url.pathname === '/' || url.pathname === '/index.html') && url.searchParams.has('k')) {
    const langArg = url.searchParams.get('lang')
    res.writeHead(303, { location: langArg ? `/?lang=${encodeURIComponent(langArg)}` : '/', 'cache-control': 'no-store' })
    return res.end()
  }
  if (CFG.loginPasswordHash && !authed(req, url)) {
    res.setHeader('cache-control', 'no-store')
    if (req.method === 'GET' && url.pathname === '/login.js')
      return send(200, await readFile(join(WEB, 'login.js'), 'utf8'), MIME['.js'])
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      if (url.pathname === '/index.html') {
        const langArg = url.searchParams.get('lang')
        res.writeHead(303, { location: langArg ? `/?lang=${encodeURIComponent(langArg)}` : '/', 'cache-control': 'no-store' })
        return res.end()
      }
      return send(200, await readFile(join(WEB, 'login.html'), 'utf8'), MIME['.html'])
    }
    return send(401, { error: 'login_required' })
  }
  if (!CFG.loginPasswordHash && !authed(req, url)) return send(401, t('auth.needToken'), 'text/plain; charset=utf-8')
  // HttpOnly: no script on the page can read it. Lax, not Strict: Strict would drop it when the page is
  // opened from a link in another app, and every write here is a POST/PUT/PATCH/DELETE, which Lax
  // already keeps from other sites. Secure when a TLS proxy in front says the request was https.
  if (!CFG.loginPasswordHash && CFG.token && sameToken(url.searchParams.get('k'))) {
    const https = req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted
    res.setHeader('set-cookie', `ma_token=${encodeURIComponent(CFG.token)}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax${https ? '; Secure' : ''}`)
  }

  try {
    if (url.pathname === '/api/conversations') return send(200, await listConversations(lang))

    // Direct chat history: the frontend wants {role, content, at}
    const dm = url.pathname.match(/^\/api\/dm\/([a-z0-9-]+)$/)
    if (dm && req.method === 'GET')
      return send(200, (await db.recent('dm', dm[1], FETCH_MAX, { tools: true }))
        .map(m => transcriptRow(m, { content: m.content, ...m.speaker === studio.STUDIO_SPEAKER ? { speaker: m.speaker } : {} })))
    if (dm && req.method === 'DELETE') { await db.clearMessages('dm', dm[1]); return send(200, { ok: true }) }

    if (url.pathname === '/api/bots' && req.method === 'GET') return send(200, await loadBots(lang))

    if (url.pathname === '/api/bots' && req.method === 'POST') {
      const b = await readBody(req)
      // Spread what checkAgent returned: a hand-copied field list here silently drops
      // anything added to the editor later (daily_cap_micro did exactly that).
      const checked = await checkAgent(b)
      const { name } = checked
      const id = str(b.id)
      // The id is an internal identifier (container name, mount directory); people see the name.
      // Chinese names can't produce a valid slug, which is fine — just generate one; don't bother the user about it.
      let slug = id.trim() || name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
      if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) slug = 'agent-' + Math.random().toString(36).slice(2, 8)
      if (await db.getAgent(slug)) return send(409, { error: t('agent.idExists', { id: slug }) })
      const n = (await db.listAgents()).length
      await db.upsertAgent({ description: '', provider_id: '', model: '', effort: '', approval: '', runtime: '', ...checked, id: slug, ord: n + 1, color: db.nextColor(n) })
      return send(200, { id: slug })
    }

    const bm = url.pathname.match(/^\/api\/bots\/([a-z0-9-]+)$/)
    if (bm && req.method === 'PATCH') {
      const cur = await db.getAgent(bm[1])
      if (!cur) return send(404, { error: t('err.noAgent') })
      const body = await readBody(req)
      // A client that doesn't know about runtimes (the desktop app, so far) always sends an upstream
      // and a model picked from that upstream's list; applied to an agent on a CLI, that would quietly
      // hand the CLI another provider's model name. Such a client can't change what it can't see.
      if (cur.runtime && body.runtime === undefined) { delete body.provider_id; delete body.model }
      const patch = await checkAgent(body, cur.id)
      await db.upsertAgent({ ...cur, ...patch })
      // Group logs identify people by name. Without syncing a rename, what he said in groups would become "someone else's"
      if (patch.name && patch.name !== cur.name) await db.renameSpeaker(cur.name, patch.name)
      return send(200, { ok: true })
    }
    if (bm && req.method === 'DELETE') {
      if (!await db.getAgent(bm[1])) return send(404, { error: t('err.noAgent') })
      if (await crews.forAgent(bm[1])) return send(400, { error: '固定剧组成员不能单独删除，旧项目及记录会保留。' })
      await db.deleteAgent(bm[1])
      // Delete the container too — an ownerless container only wastes memory,
      // and his work is still in workspace/agents/<id>/ (a directory on the host)
      await removeContainer(bm[1]).catch(() => {})
      return send(200, { ok: true })
    }

    // .../self is the second store: the notes the agent writes himself (memory.mjs). Agents only —
    // groups have no self-notes, because only a person can write a group's memory.
    const mm = url.pathname.match(/^\/api\/memory\/(agent|group)\/([\w-]+)(\/self)?$/)
    if (mm) {
      const [, kind, id, own] = mm
      const exists = kind === 'agent'
        ? (await db.listAgents()).some(a => a.id === id)
        : (await db.listGroups()).some(g => g.id === id)
      if (!exists || (own && kind !== 'agent')) return send(404, { error: t(kind === 'agent' ? 'err.noAgent' : 'err.noGroup') })
      if (req.method === 'GET') return send(200, { text: own ? await db.getSelfMemory(id) : await db.getMemory(kind, id) })
      if (req.method === 'PUT') {
        const text = str((await readBody(req)).text)
        await (own ? db.setSelfMemory(id, text) : db.setMemory(kind, id, text))
        return send(200, { ok: true })
      }
    }

    // ---- An agent's browser: a human watching, a human taking over ----
    const bw = url.pathname.match(/^\/api\/browser\/([a-z0-9-]+)\/(shot|act|stream)$/)
    if (bw) {
      if (!await db.getAgent(bw[1])) return send(404, { error: t('err.noAgent') })
      const c = (await machineOf(bw[1])).name
      // Live view: relay the daemon's MJPEG as-is (Chromium screencast; a frame only when the page changes).
      // Screenshot polling (shot) stays as the fallback: for when the stream drops or the daemon is still an old version
      if (bw[2] === 'stream' && req.method === 'GET') {
        if (!CFG.tools || !await browserAlive(c)) { res.writeHead(204); return res.end() }
        // Upgrade the daemon to the streaming version while we're at it (a no-op if unchanged)
        await execIn(c, ['-i', c, 'bash', '-c', BROWSERD_UP], BROWSERD)
        // ⚠️ Killing the docker exec client does NOT kill the curl inside the container: nobody reads its output any more,
        // the heartbeat fills the pipe and it hangs forever while the daemon keeps encoding frames for it. So record its pid in the container and kill it ourselves on the way out
        const pidFile = `/tmp/stream-${process.pid}-${Date.now().toString(36)}.pid`
        const child = spawn(CLI, ['exec', c, 'sh', '-c', `echo $$ > ${pidFile}; exec curl -sN http://127.0.0.1:9230/stream`],
          { stdio: ['ignore', 'pipe', 'ignore'] })
        res.writeHead(200, { 'content-type': 'multipart/x-mixed-replace; boundary=frame', 'cache-control': 'no-store' })
        child.stdout.pipe(res)
        res.on('close', () => {
          child.kill('SIGKILL')
          cliRun(['exec', c, 'sh', '-c', `kill $(cat ${pidFile}) 2>/dev/null; rm -f ${pidFile}`], null, 10_000)
        })
        child.on('close', () => res.end())
        return
      }
      if (bw[2] === 'shot' && req.method === 'GET') {
        // Not open → 204: the UI shows "he hasn't opened a browser yet"
        if (!CFG.tools || !await browserAlive(c)) { res.writeHead(204); return res.end() }
        const j = await browserPost(c, { action: 'screenshot' }, lang)
        if (!j.ok || !j.image) return send(502, { error: j.error ?? t('browser.noShot') })
        res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store',
          'x-page-url': encodeURIComponent(j.url ?? ''), 'x-page-title': encodeURIComponent(j.title ?? '') })
        return res.end(Buffer.from(j.image, 'base64'))
      }
      if (bw[2] === 'act' && req.method === 'POST') return send(200, await humanBrowserAct(bw[1], await readBody(req), lang))
    }

    // ---- Skill library ----
    if (url.pathname === '/api/skills' && req.method === 'GET') return send(200, await db.listSkills())
    if (url.pathname === '/api/skills' && req.method === 'POST') {
      const row = await checkSkillBody(await readBody(req))
      return send(200, await db.saveSkill({ id: 'k' + Date.now().toString(36), ...row, source: 'human' }))
    }
    // Import a SKILL.md (the dsh / Claude Code skill format). If the file has no name, use the one the caller gave
    if (url.pathname === '/api/skills/import' && req.method === 'POST') {
      const b = await readBody(req)
      const md = parseSkillMd(str(b.text))
      const row = await checkSkillBody({ ...md, name: md.name || b.name, agents: b.agents ?? [] })
      return send(200, await db.saveSkill({ id: 'k' + Date.now().toString(36), ...row, source: 'human' }))
    }
    const km = url.pathname.match(/^\/api\/skills\/([\w-]+)(\/export)?$/)
    if (km) {
      const cur = await db.getSkill(km[1])
      if (!cur) return send(404, { error: t('err.noSkill') })
      if (km[2] && req.method === 'GET') return send(200, toSkillMd(cur), 'text/markdown; charset=utf-8')
      if (!km[2] && req.method === 'PATCH') {
        const b = await readBody(req)
        const row = await checkSkillBody({ name: b.name ?? cur.name, description: b.description ?? cur.description,
          body: b.body ?? cur.body, agents: b.agents ?? cur.agents }, cur.id)
        // A skill a human edited is the human's: the UI stops marking it "written by agent X", and the agent can no longer overwrite it with save_skill
        const edited = b.body !== undefined || b.description !== undefined || b.name !== undefined
        return send(200, await db.saveSkill({ ...cur, ...row, source: edited ? 'human' : cur.source }))
      }
      if (!km[2] && req.method === 'DELETE') { await db.deleteSkill(cur.id); return send(200, { ok: true }) }
    }

    // ---- Scheduled tasks ----
    if (url.pathname === '/api/routines' && req.method === 'GET') {
      const kind = url.searchParams.get('kind'), id = url.searchParams.get('id')
      return send(200, (await db.listRoutines(kind ? { kind, id } : {})).map(routineView))
    }
    if (url.pathname === '/api/routines' && req.method === 'POST') {
      const r = await checkRoutine(await readBody(req))
      const row = await db.saveRoutine({ id: 'r' + Date.now().toString(36), ...r,
        next_run_at: r.enabled ? nextRun(r) : null, last_status: '', last_error: '', failures: 0 })
      return send(200, routineView(row))
    }
    const rm = url.pathname.match(/^\/api\/routines\/([\w-]+)(\/run)?$/)
    if (rm) {
      const cur = await db.getRoutine(rm[1])
      if (!cur) return send(404, { error: t('err.noRoutine') })
      if (rm[2] && req.method === 'POST') {
        // A manual run doesn't change the next run time: "try it now" shouldn't move tomorrow's 9 a.m. run
        if (routineRunning.has(cur.id)) return send(409, { error: t('routine.running') })
        runRoutine(cur)
        return send(202, routineView({ ...cur, running: true }))
      }
      if (!rm[2] && req.method === 'PATCH') {
        const r = await checkRoutine(await readBody(req), cur)
        // Reset the failure count when re-enabling, otherwise a single failure pauses it again
        const revived = r.enabled && !cur.enabled
        const row = await db.saveRoutine({ ...cur, ...r, next_run_at: r.enabled ? nextRun(r) : null,
          failures: revived ? 0 : cur.failures, last_error: revived ? '' : cur.last_error })
        return send(200, routineView(row))
      }
      if (!rm[2] && req.method === 'DELETE') { await db.deleteRoutine(cur.id); return send(200, { ok: true }) }
    }

    // ---- Spending ----
    // One call answers both the sidebar total and the open conversation's panel: it polls
    // every 15s, and two endpoints would be two round-trips for one screen.
    if (url.pathname === '/api/usage' && req.method === 'GET') {
      const [rows, agents, providers, fallback] = await Promise.all([
        db.spendSummary(), db.listAgents(), db.listProviders(), db.defaultCap()])
      const byId = new Map(rows.map(r => [r.agent_id, r]))
      const def = providers.find(p => p.is_default) ?? providers[0] ?? null
      const zero = { tokens: 0, cost_micro: 0, calls: 0, unpriced: 0 }
      const per = agents.map(a => {
        const p = (a.provider_id ? providers.find(x => x.id === a.provider_id) : def) ?? null
        const u = byId.get(a.id)
        return { id: a.id, name: a.name,
          day: u?.day ?? zero, month: u?.month ?? zero,
          // The cap actually in force, and whether it can be enforced at all.
          cap_micro: a.daily_cap_micro != null ? Number(a.daily_cap_micro) : (fallback == null ? null : Number(fallback)),
          own_cap: a.daily_cap_micro != null,
          priced: db.isPriced(p) }
      })
      // The total sums the raw rows, not the per-agent list: spend by an agent deleted
      // mid-month was still spent, and a month total that quietly shrinks is the kind of
      // lie this whole feature exists to prevent.
      const add = k => rows.reduce((t, a) => ({
        tokens: t.tokens + a[k].tokens,
        cost_micro: t.cost_micro + (a[k].cost_micro ?? 0),
        calls: t.calls + a[k].calls,
        unpriced: t.unpriced + a[k].unpriced,
      }), { ...zero })
      return send(200, { agents: per, day: add('day'), month: add('month'),
        default_cap_micro: fallback == null ? null : Number(fallback) })
    }
    // The platform-wide daily cap, for every agent that has none of its own.
    if (url.pathname === '/api/usage/cap' && req.method === 'PUT') {
      const v = (await readBody(req)).daily_cap_micro
      if (v !== null && v !== '' && !(Number.isFinite(Number(v)) && Number(v) >= 0)) return send(400, { error: t('spend.badCap') })
      const micro = v === null || v === '' ? null : Math.round(Number(v))
      await db.setDefaultCap(micro)
      return send(200, { default_cap_micro: micro })
    }

    // The platform-wide reasoning effort, for every agent that has none of its own.
    if (url.pathname === '/api/settings/effort' && req.method === 'GET')
      return send(200, { effort: normEffort(await db.defaultEffort()), levels: EFFORTS })

    if (url.pathname === '/api/settings/effort' && req.method === 'PUT') {
      const e = str((await readBody(req)).effort).trim()
      if (e && !EFFORTS.includes(e)) return send(400, { error: t('agent.effort', { list: EFFORTS.join(' / ') }) })
      await db.setDefaultEffort(e)
      return send(200, { effort: e })
    }

    // ---- Approvals ----
    // The platform default, and the pattern list "match" uses.
    if (url.pathname === '/api/approvals/policy' && req.method === 'GET')
      return send(200, { ...await approvalPolicy(), modes: APPROVAL_MODES, seeded: RISKY })

    if (url.pathname === '/api/approvals/policy' && req.method === 'PUT') {
      const b = await readBody(req)
      const mode = str(b.mode).trim()
      if (!APPROVAL_MODES.includes(mode)) return send(400, { error: t('agent.approval', { list: APPROVAL_MODES.join(' / ') }) })
      const patterns = (Array.isArray(b.patterns) ? b.patterns : String(b.patterns ?? '').split('\n'))
        .map(x => String(x).trim()).filter(Boolean).slice(0, 200)
      const policy = { mode, patterns }
      await db.setSetting('approvals', policy)
      return send(200, policy)
    }

    // Answering one. The id only exists while the stream that asked is still open, so a stale
    // click is a 404 rather than a silent yes.
    const ap = url.pathname.match(/^\/api\/approvals\/([\w-]+)$/)
    if (ap && req.method === 'POST') {
      const answer = pendingApprovals.get(ap[1])
      if (!answer) return send(404, { error: t('approval.gone') })
      answer((await readBody(req)).ok === true)
      return send(200, { ok: true })
    }

    // ---- Model upstreams ----
    if (url.pathname === '/api/providers' && req.method === 'GET')
      return send(200, (await db.listProviders()).map(p => safeProvider(p, lang)))

    if (url.pathname === '/api/providers' && req.method === 'POST') {
      const b = await readBody(req)
      const base = String(b.base_url ?? '').trim().replace(/\/+$/, '')
      if (!b.name?.trim() || !base)
        return send(400, { error: t('provider.nameUrl') })
      if (!/^https?:\/\//.test(base)) return send(400, { error: t('provider.urlScheme') })
      if (b.protocol !== undefined && !PROTOCOLS.includes(b.protocol))
        return send(400, { error: t('provider.protocol', { list: PROTOCOLS.join(' / ') }) })
      const first = !(await db.listProviders()).length
      const row = await saveProviderWithContext({
        id: 'p' + Date.now().toString(36), name: b.name.trim(), base_url: base,
        api_key: b.api_key ?? '', model: '', is_default: first,
        protocol: normProtocol(b.protocol),
        price_in_micro: priceField(b.price_in_micro), price_out_micro: priceField(b.price_out_micro),
      }, { auto: b.auto_context !== false, tokens: b.context_tokens })
      return send(200, safeProvider(row, lang))
    }

    const pm = url.pathname.match(/^\/api\/providers\/([\w-]+)$/)
    if (pm && req.method === 'PATCH') {
      const cur = await db.getProvider(pm[1])
      if (!cur) return send(404, { error: t('err.noProvider') })
      const b = await readBody(req)
      if (b.protocol !== undefined && !PROTOCOLS.includes(b.protocol))
        return send(400, { error: t('provider.protocol', { list: PROTOCOLS.join(' / ') }) })
      const row = await saveProviderWithContext({
        ...cur,
        name: b.name?.trim() || cur.name,
        base_url: (b.base_url?.trim().replace(/\/+$/, '')) || cur.base_url,
        protocol: b.protocol ? normProtocol(b.protocol) : cur.protocol,
        // Empty key = leave the old one. Otherwise every rename would mean pasting the key again.
        api_key: b.api_key ? b.api_key : cur.api_key,
        price_in_micro: priceField(b.price_in_micro, cur.price_in_micro),
        price_out_micro: priceField(b.price_out_micro, cur.price_out_micro),
      }, { auto: b.auto_context ?? cur.auto_context, tokens: b.context_tokens ?? cur.context_tokens })
      return send(200, safeProvider(row, lang))
    }
    if (pm && req.method === 'DELETE') {
      const users = await db.agentsUsingProvider(pm[1])
      if (users.length) return send(409, { error: t('provider.inUse', { names: users.join(lang === 'en' ? ', ' : '、') }) })
      const list = await db.listProviders()
      if (list.length <= 1) return send(400, { error: t('provider.last') })
      await db.deleteProvider(pm[1])
      if (!(await db.listProviders()).some(p => p.is_default))
        await db.makeDefault((await db.listProviders())[0].id)
      return send(200, { ok: true })
    }
    const pd = url.pathname.match(/^\/api\/providers\/([\w-]+)\/default$/)
    if (pd && req.method === 'POST') {
      if (!await db.getProvider(pd[1])) return send(404, { error: t('err.noProvider') })
      await db.makeDefault(pd[1])
      return send(200, { ok: true })
    }
    // Which models an upstream has: the model dropdown in the agent editor and "Test connection" in the upstream form both rely on it.
    // Send an id (or nothing = the default upstream) to ask a saved one; send form fields to ask one not yet saved.
    if (url.pathname === '/api/providers/models' && req.method === 'POST') {
      const p = await providerFromBody(await readBody(req))
      if (!p) return send(404, { error: t('err.noProvider') })
      const models = await listModels(p)
      return models
        ? send(200, { models, suggested: models.includes(p.inUse) ? p.inUse : '' })
        : send(200, { models: [], error: t('provider.noModels') })
    }
    // Really call the upstream once: whether it connects and whether the key is right is known here,
    // not half an hour later as "some agent won't talk"
    if (url.pathname === '/api/providers/test' && req.method === 'POST') {
      const b = await readBody(req)
      const p = await providerFromBody(b)
      if (!p) return send(404, { error: t('err.noProvider') })
      const t0 = Date.now()
      // Upstreams no longer carry a model. What we try, in order: the one the caller gave, the one an agent using this upstream picked,
      // the one old data stored on the upstream, the first one /models lists (lists often contain models this endpoint can't serve, so it's last)
      const models = await listModels(p)
      p.model = str(b.model).trim() || p.inUse || models?.[0] || ''
      if (!p.model) return send(200, { ok: false, ms: Date.now() - t0, error: t('provider.testNoModels') })
      try {
        let got = ''
        await callModel(p, [{ role: 'user', content: 'Reply with one word: OK' }], d => { got += d }, { bare: true })
        // Connected but not a single character back must be said too — that's usually a bad relay channel,
        // and reporting it as "connected" would send people debugging elsewhere with an upstream that doesn't work
        return got.trim()
          ? send(200, { ok: true, ms: Date.now() - t0, reply: got.slice(0, 80), model: p.model, models: models?.length ?? 0 })
          : send(200, { ok: false, ms: Date.now() - t0, error: t('provider.testEmpty') })
      } catch (e) {
        return send(200, { ok: false, ms: Date.now() - t0, error: errorText(e, lang).slice(0, 300) })
      }
    }

    if (url.pathname === '/api/chat' && req.method === 'POST') {
      // target: {type:'agent'|'group', id}. botIds is the old field, kept for compatibility.
      const { target, botIds = [], text = '', request_id = randomUUID() } = await readBody(req)
      if (typeof text !== 'string' || text.length > 20000) return send(400, { error: '消息最多 20000 字。' })
      const all = await loadBots()
      let bots, groupId = null
      if (target?.type === 'group') {
        const g = (await db.listGroups()).find(x => x.id === target.id)
        if (!g) return send(404, { error: t('err.noGroup') })
        groupId = g.id
        bots = all.filter(b => g.members.includes(b.id))
        if (bots.length < 2) return send(400, { error: t('group.tooSmall', { name: g.name, n: bots.length }) })
      } else if (target?.type === 'agent') {
        bots = all.filter(b => b.id === target.id)
      } else {
        bots = all.filter(b => botIds.includes(b.id))
      }
      if (!bots?.length || !text.trim()) return send(400, { error: t('chat.needTarget') })
      if (!groupId && bots.length > 1) {
        for (const b of bots) if (await crews.forAgent(b.id))
          return send(400, { error: '独立项目成员只能在所属剧组或单独私聊中工作。' })
      }

      // Resolve everyone's upstream first: if one is missing, say so before opening the stream, not halfway through a group relay
      const providers = new Map()
      try { for (const b of bots) providers.set(b.id, await providerFor(b)) }
      catch (e) { return send(400, { error: errorText(e, lang) }) }

      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' })
      const emit = (ev, d) => { if (!res.destroyed) res.write(`event: ${ev}\ndata: ${JSON.stringify(d)}\n\n`) }
      // The client closed the page / lost the network: stop. Otherwise a group relay would keep spending
      // 6 people × 12 steps of upstream calls and keep running commands in containers with nobody watching.
      const ac = new AbortController()
      res.on('close', () => { if (!res.writableEnded) ac.abort() })
      const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': keep-alive\n\n') }, 15000)
      try {
        const bound = groupId && await crews.forGroup(groupId)
        if (bound && await crews.enabled()) {
          let decision
          const p = (await db.pool.query('select name,info from studio.projects where id=$1', [bound.project_id])).rows[0]
          if (crews.explicitNew(text)) decision = { intent: 'new', name: crews.titleOf(text.replace(/^.*?(?:项目|剧组|作品)\s*[：:，,]?\s*/u, '')) }
          else if (/^(?:好[的]?|可以|继续|确认|收到|谢谢|进度[？?]?|你好|在吗)[。！!？?]?$/u.test(text.trim())) decision = { intent: 'continue' }
          else if (p.info?.awaiting_brief) {
            // A manually created empty crew receives its first brief, not a second new crew.
            decision = { intent: 'continue' }
            await db.pool.query("update studio.projects set info=info || $2::jsonb where id=$1",
              [bound.project_id, JSON.stringify({ origin_brief: text, awaiting_brief: false })])
          }
          else {
            emit('note', { text: '正在识别本次需求是否需要独立项目…' })
            const signal = AbortSignal.any([ac.signal, AbortSignal.timeout(45000)])
            // No persona, history, memories, skills, or tools reach this separate routing turn.
            const lead = bots[0]
            const provider = { ...providers.get(lead.id), effort: 'low' }
            const messages = [{ role: 'system', content: crews.ROUTER_SYSTEM }, { role: 'user', content: JSON.stringify({
              current: { name: p.name, brief: String(p.info?.origin_brief ?? '').slice(0, 800) }, message: text }) }]
            let raw
            if (provider.runtime) raw = await runCli(provider, messages, null, null,
              { bot: { id: `router-${groupId}` }, signal, tools: [], scope: 'group', scopeId: groupId, lang, maxSteps: 1 })
            else raw = (await callModel(provider, messages, null, { bare: true, signal })).content
            decision = crews.routingResult(raw)
          }
          if (ac.signal.aborted) return res.end()
          if (decision.intent === 'new') {
            const made = await crews.create({ name: decision.name, brief: text, request_id })
            studio.forgetCrew()
            groupId = made.group_id
            const g = (await db.listGroups()).find(g => g.id === groupId)
            bots = (await loadBots(lang)).filter(b => g.members.includes(b.id))
            providers.clear()
            for (const b of bots) providers.set(b.id, await providerFor(b))
            emit('crew', { conversation: (await listConversations(lang)).find(c => c.kind === 'group' && c.id === groupId), bots })
            emit('note', { text: '已创建独立项目和四岗位剧组，当前上下文为空；旧剧组记录保留。' })
          }
        }
        await converse(bots, groupId, providers, text, emit, ac.signal, lang)
      } catch (e) {
        emit('error', { message: `${errorText(e, lang)}；如需新项目，可点“新建项目 / 剧组”或发送“新项目：需求”。` })
      } finally { clearInterval(heartbeat) }
      emit('done', {})
      return res.end()
    }

    if (url.pathname === '/api/crews' && req.method === 'POST') {
      const b = await readBody(req)
      const made = await crews.create({ name: b.name, request_id: b.request_id })
      studio.forgetCrew()
      return send(200, made)
    }

    // Groups: an entity with a name and members
    if (url.pathname === '/api/groups' && req.method === 'GET') return send(200, await db.listGroups())

    if (url.pathname === '/api/groups' && req.method === 'POST') {
      const { name, members, lead, shared_machine } = await checkGroup(await readBody(req))
      return send(200, await db.saveGroup({ id: `g${Date.now().toString(36)}`, name, members, lead, shared_machine }))
    }

    const gm = url.pathname.match(/^\/api\/groups\/([\w-]+)$/)
    if (gm && req.method === 'PATCH') {          // rename / add or remove members
      const g = (await db.listGroups()).find(x => x.id === gm[1])
      if (!g) return send(404, { error: t('err.noGroup') })
      const patch = await checkGroup(await readBody(req), g)
      const saved = await db.saveGroup({ ...g, ...patch })
      if (patch.members) dropContainersOf(g.members.filter(id => !patch.members.includes(id)))
      if (g.shared_machine && patch.shared_machine === false) dropGroupMachine(g.id)
      return send(200, saved)
    }
    if (gm && req.method === 'DELETE') {         // disband; files in the shared drive are left alone
      if (await crews.forGroup(gm[1])) return send(400, { error: '独立剧组和项目记录会保留；新作品请新建项目 / 剧组。' })
      const g = (await db.listGroups()).find(x => x.id === gm[1])
      await db.deleteGroup(gm[1])
      if (g) dropContainersOf(g.members)
      if (g?.shared_machine) dropGroupMachine(g.id)
      return send(200, { ok: true })
    }
    // Export / import a conversation's chat history. The format is defined here; an exported file imports back as-is.
    const xm = url.pathname.match(/^\/api\/(export|import)\/(dm|group)\/([\w-]+)$/)
    if (xm) {
      const [, op, scope, id] = xm
      const conv = scope === 'dm' ? await db.getAgent(id) : (await db.listGroups()).find(g => g.id === id)
      if (!conv) return send(404, { error: t(scope === 'dm' ? 'err.noAgent' : 'err.noGroup') })
      if (op === 'export' && req.method === 'GET') {
        const messages = await db.recent(scope, id, 1_000_000)
        return send(200, { format: 'multi-agent-chat', version: 1, kind: scope === 'dm' ? 'agent' : 'group',
          id, name: conv.name, exported_at: new Date().toISOString(),
          messages: messages.map(m => ({ role: m.role, speaker: m.speaker, content: m.content, at: new Date(m.at).toISOString() })) })
      }
      if (op === 'import' && req.method === 'POST') {
        const b = await readBody(req)
        const doc = b.doc ?? b
        if (doc.format !== 'multi-agent-chat' || !Array.isArray(doc.messages))
          return send(400, { error: t('import.badFile') })
        const rows = []
        for (const m of doc.messages) {
          if (!m || !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string')
            return send(400, { error: t('import.badRow', { n: rows.length + 1 }) })
          const ts = m.at == null ? NaN : new Date(m.at).getTime()      // accepts an ISO string or milliseconds
          const at = Number.isNaN(ts) ? null : new Date(ts).toISOString()
          rows.push({ role: m.role, speaker: str(m.speaker) || (m.role === 'user' ? USER_SPEAKER : conv.name),
            content: m.content, at })
        }
        await db.importMessages(scope, id, rows, { replace: b.replace === true })
        return send(200, { imported: rows.length })
      }
    }

    const gr = url.pathname.match(/^\/api\/groups\/([\w-]+)\/messages$/)
    if (gr && req.method === 'GET')
      return send(200, (await db.recent('group', gr[1], FETCH_MAX, { tools: true }))
        .map(m => transcriptRow(m, { speaker: m.speaker, text: m.content })))
    if (gr && req.method === 'DELETE') { await db.clearMessages('group', gr[1]); return send(200, { ok: true }) }


    // ---- The studio workbench (web UI): a person setting up projects and the crew, locking, reviewing ----
    // Coding CLIs as agent runtimes: which are signed in, and signing them in (web/cli.mjs).
    if (url.pathname.startsWith('/api/cli')) {
      if (!CLIMOD.container) return send(url.pathname === '/api/cli' ? 200 : 400,
        url.pathname === '/api/cli' ? { enabled: false, runtimes: [] } : { error: t('cli.off') })
      if (url.pathname === '/api/cli' && req.method === 'GET') return send(200, await cliStatus())
      if ((url.pathname === '/api/cli/login' || url.pathname === '/api/cli/logout') && req.method === 'POST') {
        const rt = str((await readBody(req)).runtime)
        if (!RUNTIME_IDS.includes(rt)) return send(400, { error: t('cli.unknown', { id: rt }) })
        if (url.pathname === '/api/cli/logout') {
          const r = await cliRun(['exec', CLIMOD.container, ...logoutArgs(rt)], null, 30_000)
          return send(200, { ok: r.code === 0, output: plain(r.out + r.err).trim().slice(-500) })
        }
        const id = startLogin(rt)
        // Give the flow a moment to print its link, so the first answer usually carries it.
        for (let i = 0; i < 30 && cliLogins.get(id)?.state === 'running' && !loginPrompt(cliLogins.get(id).out).url; i++)
          await new Promise(r => setTimeout(r, 200))
        return send(200, { id, ...loginView(cliLogins.get(id)) })
      }
      const lm = url.pathname.match(/^\/api\/cli\/login\/([\w-]+)(\/input)?$/)
      if (lm) {
        const l = cliLogins.get(lm[1])
        if (!l) return send(404, { error: t('cli.noLogin') })
        if (!lm[2] && req.method === 'GET') return send(200, { id: lm[1], ...loginView(l) })
        if (!lm[2] && req.method === 'DELETE') { stopLogin(lm[1]); return send(200, { ok: true }) }
        if (lm[2] && req.method === 'POST') {
          if (l.state !== 'running') return send(409, { error: t('cli.noLogin') })
          const text = str((await readBody(req)).text).trim()
          if (!text || text.length > 4000 || /[\r\n]/.test(text)) return send(400, { error: t('body.notObject') })
          l.child.stdin.write(text + '\n')
          return send(200, { ok: true })
        }
      }
    }

    if (url.pathname === '/api/studio/status' && req.method === 'GET') return send(200, { enabled: studio.enabled() })
    if (url.pathname === '/api/studio/call' && req.method === 'POST') {
      const { action, args = {} } = await readBody(req)
      if (!studio.PANEL_ACTIONS.has(action)) return send(400, { error: t('studio.notPanel', { action: String(action) }) })
      if (action === 'project.create' && await crews.enabled()) {
        const made = await crews.create({ name: args.name, id: args.id, info: args.info, request_id: args.request_id })
        studio.forgetCrew()
        const r = await studio.call('human', 'project.info', { project: made.project_id })
        return send(r.ok ? 200 : 502, r.ok ? r.result : { error: r.error?.message })
      }
      if (action === 'project.edit') {
        const bound = (await crews.list()).find(c => c.project_id === args.project)
        if (bound && args.notify_group !== undefined && args.notify_group !== bound.group_id)
          return send(400, { error: '一个项目固定一个独立剧组，不能改派到其他剧组。' })
      }
      if (action === 'crew.set' && await crews.forAgent(args.agent_id))
        return send(400, { error: '独立剧组已固定四个职责，不需要重新分配岗位。' })
      const r = await studio.call('human', action, args)
      if (action === 'crew.set') studio.forgetCrew()      // a new role takes effect on the next turn, not in 30 s
      return r.ok ? send(200, r.result) : send(r.status || 502, { error: r.error?.message ?? 'studio error', code: r.error?.code })
    }
    const sf = url.pathname.match(/^\/api\/studio\/file\/([\w-]{1,60})$/)
    if (sf && req.method === 'GET') {
      // Images and takes for the workbench, streamed: a take is tens of MB, and a <video> seeks with
      // Range requests, which pass through to the studio and come back as 206.
      const r = await studio.fileStream(sf[1], req.headers.range).catch(() => null)
      const mime = r?.headers.get('content-type') ?? ''
      // Pictures, takes, cuts, speech and subtitles — nothing a browser would run.
      if (!r || (r.status !== 200 && r.status !== 206 && r.status !== 416) || !/^(image|video|audio)\/|^application\/x-subrip/.test(mime) && r.status !== 416) {
        r?.body?.cancel().catch(() => {})
        return send(404, { error: t('studio.noFile') })
      }
      const head = { 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff',
        ...mime.startsWith('application/x-subrip') ? { 'content-disposition': `attachment; filename="${sf[1]}.srt"` } : {} }
      for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag']) {
        const v = r.headers.get(h); if (v) head[h] = v
      }
      res.writeHead(r.status, head)
      if (!r.body) return res.end()
      const { Readable } = await import('node:stream')
      const body = Readable.fromWeb(r.body)
      res.on('close', () => body.destroy())              // the viewer seeked or left: stop reading
      return body.pipe(res)
    }

    // Static files
    const p = url.pathname === '/' ? '/index.html' : url.pathname
    const file = join(WEB, p.replace(/\.\./g, ''))
    if (!existsSync(file) || !statSync(file).isFile()) return send(404, 'not found', 'text/plain')
    return send(200, await readFile(file, 'utf8'), MIME[extname(file)] ?? 'application/octet-stream')
  } catch (e) {
    if (e instanceof Say && e.status < 500) return send(e.status, { error: e.text(lang) })
    if (e.status === 400) return send(400, { error: e.message })
    console.error(e)
    return send(500, { error: errorText(e, lang) })
  }
})

// ---------- Startup ----------
if (!env.DATABASE_URL) {
  console.error(`DATABASE_URL is missing.

Start a complete setup (with its own PostgreSQL):
    ./start.sh
or point it at an existing database:
    DATABASE_URL=postgres://user:pass@host:5432/multiagent node web/server.mjs`)
  process.exit(1)
}

if (CFG.loginPasswordHash && !isPasswordHash(CFG.loginPasswordHash)) {
  console.error('LOGIN_PASSWORD_HASH has an unsupported or invalid format; refusing to start.')
  process.exit(1)
}
if (CFG.loginPasswordHash && !CFG.proxySecret) {
  console.error('WEB_PROXY_SECRET is required when password login is enabled; refusing to start.')
  process.exit(1)
}

// No auth + listening publicly = a (possibly shell-capable) backend exposed on the internet.
// That combination can only be a misconfiguration, so refuse to start rather than print a warning nobody reads.
if (!CFG.token && !CFG.loginPasswordHash && !['127.0.0.1', 'localhost', '::1'].includes(CFG.host)) {
  console.error(`Refusing to start: BIND_HOST=${CFG.host} listens publicly, but ACCESS_TOKEN is not set.
Set one in .env (./start.sh generates it), or change BIND_HOST back to 127.0.0.1.`)
  process.exit(1)
}

await db.connect()
await db.migrate()
// The studio can't start without its role — but the chat must not go down with it (an external
// DATABASE_URL whose user can't create roles is the likely case). Say it loudly and carry on.
try { if (await db.provisionStudio(env.STUDIO_DB_PASSWORD)) console.log('Studio database role is ready') }
catch (e) { console.error(`Could not create the studio's database role, so the studio won't start: ${e.message}`) }
const s = await db.seed(ROOT)
if (s.seeded) console.log(`First start, imported from files: ${s.agents} agents, ${s.groups} groups, ${s.messages} messages`)
if (await db.seedProviderFromEnv(env)) console.log('Created the default upstream from .env (change it later in the UI ⚙)')
{ const n = await db.deepseekKeyToProvider(); if (n != null) console.log(`DeepSeek key moved from the Keys panel to the upstream "DeepSeek" (${n} crew member(s) now use it)`) }
{ const n = await db.fillAgentModels(); if (n) console.log(`${n} agent(s) took over the model name from their upstream`) }

await mkdir(join(WORKROOT, 'agents'), { recursive: true })
await mkdir(join(WORKROOT, 'groups'), { recursive: true })

// Keep idle keep-alive connections for 65 seconds (Node's default is 5). Connections in a client's pool
// outlive the server's, so the next request lands on a socket that's already been closed.
server.keepAliveTimeout = 65_000
server.headersTimeout = 66_000
// ---------- A human driving an agent's browser directly: a WebSocket input channel ----------
// Mouse move/down/up/wheel, keys, typed text — one message per event, passed as-is to the input port of the daemon in the container
// (9231, one JSON per line). With one HTTP request per event, dragging, hovering and typing couldn't keep up.
// Node's standard library has no WebSocket server, so only the small part we need is here: handshake, unmasking client frames, close, ping.
const INPUT_TYPES = new Set(['move', 'down', 'up', 'wheel', 'keydown', 'keyup', 'press', 'text'])

function cleanInput(raw) {
  let e
  try { e = JSON.parse(raw) } catch { return null }
  if (!e || !INPUT_TYPES.has(e.t)) return null
  const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0)
  const out = { t: e.t, x: num(e.x), y: num(e.y) }
  if (e.t === 'wheel') { out.dx = num(e.dx); out.dy = num(e.dy) }
  if (e.t === 'down' || e.t === 'up') {
    out.button = ['left', 'right', 'middle'].includes(e.button) ? e.button : 'left'
    out.count = Math.min(3, Math.max(1, num(e.count) || 1))
  }
  if (['keydown', 'keyup', 'press'].includes(e.t)) {
    if (typeof e.key !== 'string' || !e.key || e.key.length > 40) return null
    out.key = e.key
  }
  if (e.t === 'text') {
    if (typeof e.text !== 'string' || !e.text) return null
    out.text = e.text.slice(0, 4000)
  }
  return JSON.stringify(out)
}

server.on('upgrade', async (req, socket) => {
  const url = new URL(req.url, 'http://x')
  const m = url.pathname.match(/^\/api\/browser\/([a-z0-9-]+)\/input$/)
  const refuse = code => socket.end(`HTTP/1.1 ${code}\r\nconnection: close\r\n\r\n`)
  socket.on('error', () => {})
  if (!m || !req.headers['sec-websocket-key']) return refuse('404 Not Found')
  if (!authed(req, url)) return refuse('401 Unauthorized')
  if (!CFG.tools || !await db.getAgent(m[1])) return refuse('404 Not Found')
  const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ${accept}\r\n\r\n`)

  // The channel connects in the background; events arriving before that are queued, not dropped
  const c = (await machineOf(m[1])).name, pending = []
  let child = null, closed = false
  const pidFile = `/tmp/input-${process.pid}-${Date.now().toString(36)}.pid`
  const send = line => { if (child) child.stdin.write(line + '\n'); else pending.push(line) }
  const close = () => {
    if (closed) return
    closed = true
    // Send a close frame before disconnecting: a bare disconnect shows up on the client as a "connection error"
    try { socket.end(Buffer.from([0x88, 0])) } catch {}
    if (child) { child.stdin.end(); child.kill('SIGKILL') }
    // Same as the stream: killing the docker exec client doesn't kill the process in the container
    cliRun(['exec', c, 'sh', '-c', `kill $(cat ${pidFile}) 2>/dev/null; rm -f ${pidFile}`], null, 10_000)
  }
  ;(async () => {
    if ((await cliRun(['inspect', '-f', '{{.State.Running}}', c], null, 10_000)).out.trim() !== 'true')
      await withAgent(m[1], () => ensureContainer(m[1], null))
    const up = await execIn(c, ['-i', c, 'bash', '-c', BROWSERD_UP], BROWSERD)
    if (up.code !== 0 || closed) return close()
    // After exec, cat keeps bash's pid, so $$ is the one to kill
    child = spawn(CLI, ['exec', '-i', c, 'bash', '-c', `echo $$ > ${pidFile}; exec 3<>/dev/tcp/127.0.0.1/9231; exec cat >&3`],
      { stdio: ['pipe', 'ignore', 'ignore'] })
    child.on('close', close)
    child.stdin.on('error', () => {})
    for (const line of pending.splice(0)) child.stdin.write(line + '\n')
  })().catch(close)

  let buf = Buffer.alloc(0)
  socket.on('data', d => {
    buf = Buffer.concat([buf, d])
    for (;;) {
      if (buf.length < 2) return
      const op = buf[0] & 0x0f, masked = buf[1] & 0x80
      let len = buf[1] & 0x7f, off = 2
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4 }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10 }
      if (len > 1 << 20) return close()                     // no input event is 1 MB
      const mask = masked ? buf.subarray(off, off + 4) : null
      if (masked) off += 4
      if (buf.length < off + len) return
      const payload = Buffer.from(buf.subarray(off, off + len))
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3]
      buf = buf.subarray(off + len)
      if (op === 8) return close()
      if (op === 9) { socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload])); continue }
      if (op === 1) { const line = cleanInput(payload.toString()); if (line) send(line) }
    }
  })
  socket.on('close', close)
})

// Scheduled tasks: runs missed while down are made up only once after startup (next_run_at in the past → due on this tick)
setInterval(() => tickRoutines().catch(e => console.error('Scheduled task dispatch failed', e)), 20_000)
tickRoutines().catch(e => console.error('Scheduled task dispatch failed', e))


server.listen(CFG.port, CFG.host, () => {
  console.log(`CirrayaBot  http://${CFG.host}:${CFG.port}${CFG.loginPasswordHash ? ' (password login enabled)' : CFG.token ? `/?k=${CFG.token}` : ''}`)
  if (!CFG.token && !CFG.loginPasswordHash) console.log('(ACCESS_TOKEN not set; only listening on 127.0.0.1)')
  if (!CFG.tools) console.log('(AGENT_TOOLS is off; agents can only talk, not act)')
})
