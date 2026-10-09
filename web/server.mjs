// The CirrayaBot web server.
//
// All state lives in PostgreSQL (web/db.mjs); agents work in their own containers (one per agent);
// model upstreams are configured in the UI — several of them, switchable at any time — not hard-coded in .env.
//
// Auth: put ?k=<ACCESS_TOKEN> in the URL once, then a cookie carries it. Without a token we only listen on 127.0.0.1.
import { env, ROOT } from './env.mjs'
import * as db from './db.mjs'
import { fitContext, listModels, modelInfo, guessContext } from './model.mjs'
import { callUpstream, normProtocol, normEffort, EFFORTS, PROTOCOLS } from './protocols.mjs'
import { checkSchedule, nextRun } from './schedule.mjs'
import { checkSkill, parseSkillMd, toSkillMd } from './skill.mjs'
import { addNote, NOTE_MAX_CHARS } from './memory.mjs'
import { APPROVAL_MODES, RISKY, gate, toolSubject } from './approve.mjs'
import { AUTONOMY_MODES, normAutonomy, resolveAutonomy, limitsFor, checkPlan, planText, openSteps, nudgeFor } from './autonomy.mjs'
import { OPEN, isOpen, MAX_OPEN_PER_CONVERSATION, MAX_PER_SESSION, QUESTION_MAX, RESULT_MAX, checkTaskInput, pickAssignee,
  taskOpening, eventForModel, wakes, taskLine, frontSection, taskSection, clipText } from './tasks.mjs'
import { runArgs, decide, groupsLabel, INSPECT_FORMAT, READ_SCRIPT, WRITE_SCRIPT, PATH_GUARD, EGRESS_SCRIPT, AGENT_UID } from './sandbox.mjs'
import { MB, mimeOf, kindOf, servedHeaders, safeName, uniqueName, sizeText, attachmentNote, sendablePath,
  VISION_MIMES, VISION_MAX, VISION_COUNT, INLINE_TEXT_MAX, INLINE_TEXT_TOTAL } from './files.mjs'
import { langOf, tr, Say, errorText } from './i18n.mjs'
import { checkSecret, NEEDS, seal, open as unseal, parseKey, newKey, redact, headerFor, isPrivateAddress } from './secrets.mjs'
import { createServer } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { lookup as dnsLookup } from 'node:dns'
import { isIP } from 'node:net'
import { readFile, writeFile, mkdir, readdir, rm, rename, realpath, open as openFile, copyFile } from 'node:fs/promises'
import { existsSync, statSync, createReadStream, createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { join, extname, posix } from 'node:path'
import { spawn } from 'node:child_process'
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'

const WEB = join(ROOT, 'web')
const WORKROOT = join(ROOT, 'workspace')

const CFG = {
  token: env.ACCESS_TOKEN || '',
  port:  Number(env.WEB_PORT || 8080),
  host:  env.BIND_HOST || (env.ACCESS_TOKEN ? '0.0.0.0' : '127.0.0.1'),
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
  // Tried in order when its own model keeps failing. [{provider_id, model}], '' = the default upstream.
  fallbacks: Array.isArray(r.fallbacks) ? r.fallbacks : [],
  // Money is micro-dollars everywhere in the API (1 dollar = 1e6); null = no cap of its own.
  daily_cap_micro: r.daily_cap_micro == null ? null : Number(r.daily_cap_micro),
  // How hard this agent's model should think. '' = say nothing, which is what it did before.
  effort: r.effort ?? '',
  // When this one has to ask before acting. '' = follow the platform setting.
  approval: r.approval ?? '',
  // How far it goes on its own. '' = follow the platform setting.
  autonomy: r.autonomy ?? '',
  // Capability tags reflect the tools the backend actually grants, not what the persona says —
  // a tag claiming bash that can't actually run it is worse than no tag.
  tools: (CFG.tools ? ['shell', 'files', 'browser', 'sandbox'] : ['chatOnly']).map(k => tr(lang, `bot.tool.${k}`)),
})
const loadBots = async (lang = 'en') => (await db.listAgents()).map(r => toBot(r, lang))

// ---------- Conversation list ----------
/** Groups and direct chats mixed together, sorted by last activity — that's what an IM looks like. */
async function listConversations(lang) {
  const bots = await loadBots(lang)
  const last = await db.lastMessages()
  const cut = (s, n) => String(s ?? '').replace(/\s+/g, ' ').slice(0, n)
  const items = bots.map(b => {
    const m = last.get(`dm:${b.id}`)
    return {
      kind: 'agent', id: b.id, name: b.name, tag: b.description, color: b.color,
      members: [b.id],
      preview: m ? (m.role === 'user' ? tr(lang, 'conv.youSaid', { text: cut(m.content, 60) }) : cut(m.content, 60)) : '',
      at: m?.at ?? 0,
    }
  })
  for (const g of await db.listGroups()) {
    const m = last.get(`group:${g.id}`)
    items.push({
      kind: 'group', id: g.id, name: g.name, tag: tr(lang, 'conv.members', { n: g.members.length }), lead: g.lead ?? '',
      members: g.members,
      colors: g.members.map(id => bots.find(b => b.id === id)?.color).filter(Boolean),
      preview: m ? tr(lang, 'conv.said', {
        who: m.speaker === USER_SPEAKER ? tr(lang, 'conv.user') : m.speaker, text: cut(m.content, 52) }) : '',
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
  // id: a search hit jumps to its message, so the transcript has to say which row is which.
  if (m.role === 'event') {
    // Something that happened to a background task: the clients draw it as a card, not as speech.
    try { return { id: Number(m.id), role: 'event', speaker: m.speaker, at: m.at, event: JSON.parse(m.content) } }
    catch { return { id: Number(m.id), role: 'assistant', at: m.at, ...text } }
  }
  const files = (m.files ?? []).map(fileView)
  if (m.role !== 'tool') return { id: Number(m.id), role: m.role, at: m.at, ...text, files }
  try {
    const { name, args, output, file } = JSON.parse(m.content)
    return { id: Number(m.id), role: 'tool', speaker: m.speaker, at: m.at, name, args: args ?? {}, output: output ?? '',
      ...file ? { file: fileView(file) } : {} }
  } catch { return { id: Number(m.id), role: m.role, at: m.at, ...text, files } }
}

// ---------- Sessions ----------
// A conversation (a DM, a group) holds several sessions; the model only sees the current one.

const scopeOf = kind => (kind === 'group' ? 'group' : 'dm')

/**
 * The session a turn goes into. An id must belong to this conversation — a session is not a
 * way to read another agent's history. 'new' starts one (so an unused "New session" leaves
 * nothing behind); nothing at all carries on in the most recent, or starts the first.
 */
async function sessionFor(scope, scopeId, want) {
  if (want && want !== 'new') {
    const s = await db.getSession(want)
    if (!s || s.scope !== scope || s.scope_id !== scopeId) throw new Say('session.none', {}, 404)
    return s.id
  }
  if (!want) {
    const s = await db.latestSession(scope, scopeId)
    if (s) return s.id
  }
  return (await db.createSession(scope, scopeId)).id
}

// Sessions a turn is running in right now. Deleting one of those would leave the turn writing
// into a session that no longer exists, so it is refused until the turn ends.
const liveSessions = new Map()
const holdSession = id => liveSessions.set(id, (liveSessions.get(id) ?? 0) + 1)
const releaseSession = id => { const n = (liveSessions.get(id) ?? 1) - 1; n > 0 ? liveSessions.set(id, n) : liveSessions.delete(id) }

/** A session's transcript, tool rows included. Without a session, the most recent one. */
async function historyOf(scope, scopeId, want) {
  const s = want ? await db.getSession(want) : await db.latestSession(scope, scopeId)
  if (!s || s.scope !== scope || s.scope_id !== scopeId) {
    if (want) throw new Say('session.none', {}, 404)
    return []
  }
  return db.recent(scope, scopeId, FETCH_MAX, { tools: true, session: s.id })
}

/** About 140 characters around the first match, so a hit in a long reply still shows why it matched. */
function snippetAround(content, text) {
  const flat = String(content).replace(/\s+/g, ' ')
  const at = flat.toLowerCase().indexOf(text.toLowerCase())
  if (at < 0) return flat.slice(0, 140)
  const from = Math.max(0, at - 50)
  return (from > 0 ? '…' : '') + flat.slice(from, from + 140) + (from + 140 < flat.length ? '…' : '')
}

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

// id -> the function that answers it: (ok, always) => Promise. A pending approval only exists while
// its stream is open (or, for a background task, while the process lives).
const pendingApprovals = new Map()

// "Always allow": standing allowances, per agent. [{id, agent, tool, pattern, example, at}] in settings;
// pattern null = the whole tool (made from an "all"-mode card). Listed in the approval settings, where
// each can be taken back — an allowance nobody can see is how permission prompts stop meaning anything.
const ALLOW_KEY = 'approvals.allow'
const allowList = async () => { const v = await db.getSetting(ALLOW_KEY, []); return Array.isArray(v) ? v : [] }
const allowedFor = async agentId => (await allowList()).filter(r => r.agent === agentId)
function addAllowances(agentId, allow, example) {
  return withLock('settings:allow', async () => {
    const list = await allowList()
    for (const r of allow)
      if (!list.some(x => x.agent === agentId && x.tool === r.tool && x.pattern === r.pattern))
        list.push({ id: randomUUID().slice(0, 8), agent: agentId, tool: r.tool, pattern: r.pattern,
          example: String(example).slice(0, 200), at: Date.now() })
    await db.setSetting(ALLOW_KEY, list)
  })
}
const dropAllowances = test => withLock('settings:allow', async () =>
  db.setSetting(ALLOW_KEY, (await allowList()).filter(r => !test(r))))

/**
 * Ask, and wait. Nothing times out on its own: the client hanging up aborts the turn, which is the
 * only way an interactive approval can end unanswered. A scheduled task has nobody to ask, so it is
 * refused straight away rather than stalling a task nobody is watching.
 */
function askApproval(ctx, onTool, name, args, allow = []) {
  // Nobody to ask: a scheduled task, or an auto-mode run whose page was closed. A background task is
  // different: nobody watches it either, but its card waits in the conversation for whenever they look.
  if (!ctx.task && (ctx.unattended || ctx.run?.detached)) return Promise.resolve(false)
  const id = randomUUID()
  // `always`: what an "always allow" answer would cover, so the card can say it before anyone clicks.
  const always = allow.map(r => r.pattern ?? '')
  onTool?.({ phase: 'ask', id, name, args, always })
  if (ctx.task) taskWaitsForApproval(ctx.task, { id, name, args, always }).catch(e => console.error('[task] approval card:', e.message))
  return new Promise(resolve => {
    const answer = async (ok, forever = false) => {
      if (!pendingApprovals.delete(id)) return
      ctx.run?.asking.delete(id)
      ctx.signal?.removeEventListener('abort', onAbort)
      // Written before the turn carries on: the next call in this very turn must already see it.
      if (ok && forever && allow.length) await addAllowances(ctx.bot.id, allow, toolSubject(name, args))
      onTool?.({ phase: 'answered', id, name, args, ok })
      if (ctx.task) db.updateTask(ctx.task.id, { status: 'running', approval: null }, { from: ['waiting'] }).catch(() => {})
      resolve(ok)
    }
    const onAbort = () => answer(false)
    pendingApprovals.set(id, answer)
    ctx.run?.asking.add(id)
    ctx.signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * The group discussions an agent remembers — every group he's in, not just the current one.
 * Fed to him in direct chats too: a real employee doesn't forget this morning's group chat just because the window changed.
 */
async function groupRecallFor(bot) {
  const groups = (await db.listGroups()).filter(g => g.members.includes(bot.id))
  const chunks = []
  for (const g of groups) {
    const log = await db.recent('group', g.id, 30, { events: false })
    if (log.length) chunks.push(`[Group: ${g.name}]\n` + log.map(e => `[${modelSpeaker(e.speaker)}] ${e.content}`).join('\n'))
  }
  return chunks.join('\n\n')
}

/**
 * The system prompt. Three kinds of turn get one:
 *   the front of a conversation (a DM, or whoever speaks in a group) — talks to the person, hands work out as tasks;
 *   a background task (`task`) — works on its own until done, asks the person through ask_user;
 *   tools off — no machine, no tasks.
 */
function systemFor(bot, memory, { peers = null, box = null, recall = '', skills = [], lead = null, auto = false,
  groupId = null, task = null, byName = '', open = [], nameOf = id => id, secrets = [] } = {}) {
  const parts = [bot.persona]
  parts.push(`

--- Language ---
Reply in the language the user writes in.`)
  if (box) parts.push(`

--- Your work environment ---
You have your own machine (a container) with working directory /work; only you can get in.
You work there as an ordinary user. System packages (apt) are installed for you with install_packages;
pip and npm install into your home, /work. What you install stays on your own machine.${groupId ? `
This group's shared drive is /groups/${groupId}: everyone in the group sees it. To hand a colleague a file,
put it there; what colleagues give you is there too. (Other directories under /groups belong to your other groups.)` : ''}
Commands have a ${EXEC_TIMEOUT / 1000}-second limit; past that we stop waiting (though it may still be running).
You also have your own browser (the browser tool): open pages, click buttons, fill forms, take screenshots to see the page.
Files the user sends are copied to ${groupId ? `/groups/${groupId}/inbox` : '/work/inbox'} (the message says where each one is).
To give the user a file — a report, an image, a document, an archive — make it, then send it with send_file;
they can preview it right in the conversation. Don't paste a long file into your reply when you can send it.`)
  if (box) parts.push(`

--- Secrets ---
You are never given passwords, keys or tokens in the clear; you use them by name, and they only work on the site
each was saved for.${secrets.length ? '\n' + secrets.map(s => s.kind === 'login'
    ? `- ${s.name}: a login for ${s.origin} — type it with the browser's fill_secret`
    : `- ${s.name}: sent as the ${s.header} header to ${s.origin} — use http_request with secret "${s.name}"`).join('\n') : ''}
${task ? 'If you need one you don\'t have, ask the user (ask_user) to add it under your Secrets in the side panel.'
    : 'If you need one you don\'t have, ask with request_secret.'} Never ask for a password, key or code in the chat.`)
  if (task) parts.push(taskSection({ t: task, byName, groupDir: groupId && box ? `/groups/${groupId}` : '' }))
  else {
    if (auto && box) parts.push(`

--- How you work: on your own, until it's done ---
Nobody is going to push you along. Take the task all the way to done.
- Don't stop to ask whether to continue, and don't end with offers like "Shall I …?" — if the next step is clear, take it.
- For routine choices, make a sensible assumption and mention it in your report instead of asking.
- Anything with more than a couple of steps: write a plan with update_plan first and keep it current as you go.
  You are not finished while a step in it is still open — but a step handed out as a background task is in hand:
  mark it in_progress and end your turn; you'll hear back when it reports.
- Check your own work — run it, test it, look at the result. "It should work" is not done.
- Stop only when it is done, or when you are truly blocked on something only the user can give you (a password,
  a login, a decision about what they want). Then mark that step blocked and say exactly what you need.
- What your role says to ask a person about first (irreversible actions and the like) you still ask about — that is the right kind of stop.
- If a command is refused, don't retry it: find another way, or say why it can't be done.`)
    // Tasks need something to run on: a machine, or colleagues. A DM with tools off has neither.
    if (box || peers?.length) parts.push(frontSection({ group: !!peers?.length, open, nameOf }))
  }
  if (peers?.length) {
    const coordinating = lead?.id === bot.id
    parts.push(`

--- This is a group chat ---
These colleagues are also in the group:
${peers.map(p => `- ${p.name}: ${p.description}`).join('\n')}

Messages show who said them: "[name] content"; "[User]" is the human; "[Platform]" lines are news about background tasks.
${!lead ? '' : coordinating ? `**You coordinate this group.** When the user hasn't named anyone, it is you who answers.
Think the request through, and hand the pieces to the right colleagues as background tasks (start_task with their name) —
they work in parallel, each on their own machine, and report back here. Then check what came back and tell the user.
Don't grind away alone on work you could hand out.` : `**${lead.name} coordinates this group.** The user addressed you directly, so answer for your part.`}

- Only one of you speaks per message. Writing @name in a reply is only a mention — it doesn't make anyone speak.
  To get a colleague working, give them a task with start_task.
- Speak only for your own part. Don't speak for colleagues, and don't make up things they said.
- Don't repeat what's already been said; build on it.
- People are watching, so don't treat "I've done X" as a figure of speech: if you didn't do it, say so.`)
  }
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
// group it belongs to at /groups/<gid>, a
// network of ours with container-to-container traffic off, and a short capability list.
// The platform's code and .env aren't in there; it can't reach them.
const CLI = env.CONTAINER_CLI || 'docker'
// The agent image. :1 and :2 (agents ran as root) are named in older .env files; they are taken as
// the current one, since the container rules now assume the image's `agent` account.
const IMAGE = !env.AGENT_IMAGE || /^multi-agent-worker:[12]$/.test(env.AGENT_IMAGE) ? 'multi-agent-worker:3' : env.AGENT_IMAGE
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
// The same directories as this process sees them: in compose HOSTWORK is mounted at WORKROOT; run
// straight on the host, HOSTWORK is right there (and WORKROOT is some other, unmounted directory).
const LOCALWORK = existsSync(HOSTWORK) ? HOSTWORK : WORKROOT

function cliRun(argv, input, timeout = EXEC_TIMEOUT) {
  return new Promise(done => {
    const p = spawn(CLI, argv, { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = '', err = ''
    const timer = setTimeout(() => { p.kill('SIGKILL'); done({ code: 124, out, err: err + '\n(timed out)' }) }, timeout)
    p.stdout.on('data', d => { out += d })
    p.stderr.on('data', d => { err += d })
    p.on('close', code => { clearTimeout(timer); done({ code, out, err }) })
    p.on('error', e => { clearTimeout(timer); done({ code: 127, out, err: String(e.message) }) })
    // ⚠️ A command that exits without reading its input (docker inspect, a container that's gone)
    // makes this write fail with EPIPE — and an 'error' nobody listens for takes the whole server down.
    p.stdin.on('error', () => {})
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
  const mirror = env.AGENT_APT_MIRROR ? ['--build-arg', `APT_MIRROR=${env.AGENT_APT_MIRROR}`] : []
  const r = await cliRun(['build', ...mirror, '-t', IMAGE, '-'], df, 1_800_000)
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
    if ((await cliRun(['network', 'inspect', NETWORK], null, 30_000)).code !== 0) {
      let r = await cliRun(['network', 'create', '--driver', 'bridge',
        '-o', 'com.docker.network.bridge.enable_icc=false', NETWORK], null, 60_000)
      if (r.code !== 0 && !/already exists/i.test(r.err)) {
        console.warn(`[sandbox] could not make ${NETWORK} with container-to-container traffic off (${(r.err || r.out).trim()}); ` +
          'making it without — agents on this engine can reach each other')
        r = await cliRun(['network', 'create', NETWORK], null, 60_000)
      }
      if (r.code !== 0 && !/already exists/i.test(r.err))
        throw new Say('container.startFailed', { id: NETWORK, detail: (r.err || r.out).slice(0, 300) }, 500)
    }
    // Every time this process starts, not only when the network is new: the rules live in the host's
    // kernel and are gone after a reboot, while the network and the containers are still there.
    await guardEgress()
  })().catch(e => { networkReady = null; throw e })
  return networkReady
}

/**
 * Keep the agents off the host and the LAN (AGENT_EGRESS=internet, the default), or let them reach
 * everything (open). The rules are made by a short-lived root container on the host's network, matching
 * only this deployment's bridge. Where that can't be done (rootless podman, no iptables on the host) the
 * agents still run, and the log says plainly that the host and the LAN are reachable from them.
 */
async function guardEgress() {
  const mode = env.AGENT_EGRESS === 'open' ? 'off' : 'on'
  const id = (await cliRun(['network', 'inspect', '-f', '{{.Id}}', NETWORK], null, 30_000)).out.trim()
  if (!id) return
  const bridge = `br-${id.slice(0, 12)}`
  const chain = `MAE-${PREFIX}`.slice(0, 24)
  const r = await cliRun(['run', '--rm', '--network', 'host', '--user', '0', '--cap-drop', 'ALL', '--cap-add', 'NET_ADMIN',
    '--cap-add', 'NET_RAW', '--entrypoint', 'bash', IMAGE, '-c', EGRESS_SCRIPT, '_', bridge, chain, mode], null, 120_000)
  if (r.code === 0) console.log(`[sandbox] ${r.out.trim()}`)
  else console.warn(`[sandbox] could not set the egress rules for ${bridge} (${(r.err || r.out).trim().slice(-300)}); ` +
    'agents on this engine can reach the host and the LAN')
}

// name -> the sandbox it was checked against (work|image|groups). A change in any of them — above all
// the agent's group memberships — makes the next turn inspect it again, and recreate it if needed.
const containerReady = new Map()

/**
 * Promise-chain locks by key: what is queued behind a key runs in order, one at a time.
 *   agent:<id>    an agent's front turns — it answers one conversation at a time
 *   task:<id>     an agent's background tasks — one at a time, they share its machine
 *   session:<id>  turns in one session — a second message waits for the first instead of racing it
 *   box:<id>      creating an agent's container — two first calls would both `docker run --name`
 * An agent's front turn and its current task do run side by side: like a person with two windows
 * open, they share the files and the browser. Nothing is shared that one of them changes under the
 * other's feet — there used to be a /work/group symlink repointed on every turn (CLAUDE.md 2.14),
 * and it is gone for exactly that reason: group drives are reached by their own path, /groups/<gid>.
 */
const locks = new Map()
function withLock(key, fn) {
  const prev = locks.get(key) ?? Promise.resolve()
  const run = prev.catch(() => {}).then(fn)
  const tail = run.catch(() => {})
  locks.set(key, tail)
  tail.then(() => { if (locks.get(key) === tail) locks.delete(key) })
  return run
}
const withAgent = (id, fn) => withLock(`agent:${id}`, fn)

/** Run a command in a container. If someone deleted the container from outside, drop the "ready" cache so the next round recreates it. */
async function execIn(c, argv, input) {
  const r = await cliRun(['exec', ...argv], input)
  if (/No such container/i.test(r.err)) containerReady.delete(c)
  return r
}

/** Make sure this agent's container is running with the right mounts (and that it is in `groupId`, if given). */
function ensureContainer(botId, groupId) {
  return withLock(`box:${botId}`, () => ensureContainerNow(botId, groupId))
}
async function ensureContainerNow(botId, groupId) {
  await ensureImage()
  const name = cname(botId)
  // Only the groups it is in right now. A group it isn't in has no mount, so it doesn't exist in there.
  const groups = (await db.listGroups()).filter(g => g.members.includes(botId)).map(g => g.id)
  if (groupId && !groups.includes(groupId)) throw new Say('err.noGroup', {}, 404)
  const work = join(HOSTWORK, 'agents', botId)
  const want = { work, image: IMAGE, groups: groupsLabel(groups) }
  const sig = `${want.work}|${want.image}|${want.groups}`
  if (containerReady.get(name) !== sig) {
    await ensureNetwork()                  // once per process: the network, and the egress rules on it
    // The host directories have to exist first, or docker makes them itself, owned by root.
    await mkdir(join(LOCALWORK, 'agents', botId), { recursive: true })
    for (const g of groups) await mkdir(join(LOCALWORK, 'groups', g), { recursive: true })
    // Containers are long-lived, and what they should see changes: WORKSPACE_HOST_PATH moves, the image is
    // upgraded, the sandbox rules change, the agent joins or leaves a group. A container that is wrong in any
    // of these looks perfectly fine from inside — so it is checked here, every time the answer could differ.
    const { out } = await cliRun(['inspect', '-f', INSPECT_FORMAT, name], null, 30_000)
    const d = decide(out, want)
    if (d.action === 'recreate') {
      console.log(`${botId}'s container is ${d.why}; recreating it (files in /work and the group drives are kept)`)
      await cliRun(['rm', '-f', name], null, 60_000)
    }
    if (d.action === 'start') await cliRun(['start', name], null, 60_000)
    if (d.action === 'create' || d.action === 'recreate') {
      const r = await cliRun(runArgs({ name, image: IMAGE, hostWork: HOSTWORK, botId, groups, network: NETWORK,
        memory: env.AGENT_MEMORY || '2g', cpus: env.AGENT_CPUS || '2' }), null, 120_000)
      if (r.code !== 0) throw new Say('container.startFailed', { id: botId, detail: (r.err || r.out).slice(0, 300) }, 500)
    }
    // The agent works as uid 1000: its desk and its group drives must be its own — they may have been
    // made by this server (as root) or by an agent from before it stopped running as root. And containers
    // from before group drives were reached by path still have the old symlink, pointing at whichever
    // group used it last, so it goes.
    if (d.action !== 'reuse')
      await cliRun(['exec', '-u', '0', name, 'sh', '-c', 'rm -f /work/group; chown -R "$0:$0" /work "$@"', AGENT_UID,
        ...groups.map(g => `/groups/${g}`)], null, 300_000)
    containerReady.set(name, sig)
  }
  return name
}

/**
 * Someone left a group (or it was disbanded): take their container down now rather than on their next
 * turn, so nothing they left running in the background keeps a hand in that group's drive. After the
 * turn in progress, if any — the next one recreates it with the mounts it should have.
 */
function dropContainersOf(botIds) {
  for (const id of new Set(botIds)) withAgent(id, () => withLock(`task:${id}`, () => removeContainer(id))).catch(e =>
    console.warn(`[sandbox] could not remove ${cname(id)}: ${e.message}`))
}

async function removeContainer(botId) {
  const name = cname(botId)
  containerReady.delete(name)
  await cliRun(['rm', '-f', name], null, 60_000)
}

// ---------- Files: sent by people and by agents ----------
// The bytes are stored once, at <workspace>/files/<id>, a directory no agent container mounts. A
// message carries the list it needs to draw them. Moving a file into or out of an agent's machine
// goes through its container (docker exec), never through the host path of its desk: a link the
// agent planted in /work resolves inside the container, where it can only reach what the agent could.
const FILES_DIR = join(LOCALWORK, 'files')
const UPLOAD_MAX = Math.max(1, Number(env.UPLOAD_MAX_MB || 50)) * MB
const newFileId = () => randomUUID().replace(/-/g, '').slice(0, 24)

/** What a client gets for a file. */
const fileView = f => ({ id: f.id, name: f.name, mime: f.mime, size: Number(f.size) || 0, kind: kindOf(f.mime, f.name),
  ...f.by_agent ? { by: f.by_agent } : {} })

/** Remove the bytes of deleted rows. Best effort: an orphaned blob wastes disk, it leaks nothing. */
async function dropBlobs(ids) {
  for (const id of ids ?? []) await rm(join(FILES_DIR, id), { force: true }).catch(() => {})
}

/** Count bytes as they pass, and stop the moment there are too many. */
const capped = (max, onSize) => async function* (src) {
  let n = 0
  for await (const c of src) {
    n += c.length
    if (n > max) throw new Say('file.tooBig', { max: sizeText(max) }, 413)
    onSize(n)
    yield c
  }
}

/** A person's upload, streamed to disk. It belongs to one conversation and to no message yet. */
async function storeUpload(req, scope, scopeId, name, given) {
  const declared = Number(req.headers['content-length'])
  if (declared > UPLOAD_MAX) throw new Say('file.tooBig', { max: sizeText(UPLOAD_MAX) }, 413)
  const id = newFileId(), tmp = join(FILES_DIR, `${id}.part`)
  let size = 0
  uploading.add(`${id}.part`)
  try {
    await pipeline(req, capped(UPLOAD_MAX, n => { size = n }), createWriteStream(tmp, { flags: 'wx' }))
    if (!size) throw new Say('file.empty')
    await rename(tmp, join(FILES_DIR, id))
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {})
    throw e
  } finally { uploading.delete(`${id}.part`) }
  const clean = safeName(name)
  return db.createFile({ id, scope, scope_id: scopeId, name: clean, mime: mimeOf(clean, given), size })
}

/**
 * Send a stored file. Ranges are honoured — a browser seeking in a video asks for one, and without
 * it the video plays but can't be skipped through. The headers (servedHeaders) decide what it may be
 * shown as: nothing that would run on our origin.
 */
async function serveFile(req, res, f, download) {
  const path = join(FILES_DIR, f.id)
  let size
  try { size = statSync(path).size } catch { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('gone') }
  const headers = { ...servedHeaders(f, download), 'accept-ranges': 'bytes' }
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''))
  let start = 0, end = size - 1, status = 200
  if (range && (range[1] || range[2])) {
    if (range[1]) { start = Number(range[1]); if (range[2]) end = Math.min(Number(range[2]), size - 1) }
    else start = Math.max(0, size - Number(range[2]))          // "the last N bytes"
    if (start > end || start >= size) { res.writeHead(416, { 'content-range': `bytes */${size}` }); return res.end() }
    status = 206
    headers['content-range'] = `bytes ${start}-${end}/${size}`
  }
  headers['content-length'] = end - start + 1
  res.writeHead(status, headers)
  if (req.method === 'HEAD') return res.end()
  createReadStream(path, { start, end }).on('error', () => res.destroy()).pipe(res)
}

/** Uploads never sent, swept after a day; half-written ones from before a restart, at once. */
async function sweepUploads() {
  await dropBlobs(await db.dropStaleUploads(24))
  for (const n of await readdir(FILES_DIR).catch(() => [])) if (n.endsWith('.part') && !uploading.has(n))
    await rm(join(FILES_DIR, n), { force: true }).catch(() => {})
}
const uploading = new Set()

/** Run something in a container with a file on its stdin, or with its stdout into a file. */
function execStream(argv, { from = null, to = null, max = Infinity } = {}) {
  return new Promise(done => {
    const p = spawn(CLI, ['exec', ...from ? ['-i'] : [], ...argv], { stdio: ['pipe', 'pipe', 'pipe'] })
    let err = '', out = '', size = 0, over = false
    const timer = setTimeout(() => p.kill('SIGKILL'), 300_000)
    const sink = to ? createWriteStream(to) : null
    p.stdout.on('data', d => {
      size += d.length
      if (size > max) { over = true; p.kill('SIGKILL'); return }
      sink ? sink.write(d) : out += d
    })
    p.stderr.on('data', d => { err += d })
    p.on('error', e => { err += e.message })
    p.stdin.on('error', () => {})                     // EPIPE when it exits first; see cliRun
    p.on('close', code => {
      clearTimeout(timer)
      const finish = () => done({ code: over ? 413 : code, out, err: err.trim(), size })
      sink ? sink.end(finish) : finish()
    })
    if (from) createReadStream(from).on('error', () => p.stdin.end()).pipe(p.stdin)
    else p.stdin.end()
  })
}

// Put a file in the inbox under a name not taken yet ("a.pdf", then "a (2).pdf"…). The guard is the
// same one write_file uses: inside a group drive, a planted link can't redirect the write elsewhere.
const INBOX_SCRIPT = `set -e
dir=$1 name=$2
base=$name ext=
case "$name" in ?*.*) base=\${name%.*} ext=.\${name##*.};; esac
p="$dir/$name" i=2
while [ -e "$p" ] || [ -L "$p" ]; do p="$dir/$base ($i)$ext"; i=$((i+1)); done
set -- "$p"
${PATH_GUARD}mkdir -p -- "$(dirname -- "$p")" && cat > "$p" && printf '%s' "$p"`

/**
 * Copy what the person sent into the agent's machine, so its tools can open it: /work/inbox in a DM,
 * the group drive's inbox in a group (every member sees it). Returns the files with the path each
 * landed at — the model is told it. With tools off there's no machine, and nothing to copy.
 */
async function deliverToInbox(files, bot, groupId) {
  if (!CFG.tools || !files.length) return files
  // The message matters more than the copies: a machine that won't start costs the inbox, not the message.
  const c = await ensureContainer(bot.id, groupId).catch(e => { console.warn(`[files] no inbox for ${bot.id}: ${e.message}`); return null })
  if (!c) return files
  const dir = groupId ? `/groups/${groupId}/inbox` : '/work/inbox'
  const out = []
  for (const f of files) {
    const r = await execStream(['-w', '/work', c, 'bash', '-c', INBOX_SCRIPT, '_', dir, f.name], { from: join(FILES_DIR, f.id) })
    if (r.code !== 0) console.warn(`[files] could not put ${f.name} in ${bot.id}'s inbox: ${r.err.slice(0, 200)}`)
    out.push(r.code === 0 && r.out ? { ...f, path: r.out } : f)
  }
  return out
}

// Read a file out of the agent's machine. Links are followed inside the container, and the place it
// really is must still be the agent's desk or this conversation's group drive.
const SEND_SCRIPT = `${PATH_GUARD}case "$p/" in /work/*) ;; /groups/$2/*) [ -n "$2" ] || { echo "only files in /work can be sent" >&2; exit 5; };;
  *) echo "$1 is really $p, outside what can be sent" >&2; exit 5;; esac
[ -f "$p" ] || { echo "there is no file at $1" >&2; exit 4; }
exec cat -- "$p"`

/** send_file: the agent hands the person a file. It shows up in the conversation, previewable. */
async function sendFromAgent(ctx, args) {
  if (!ctx.container) return 'You have no machine to send files from.'
  const groupId = ctx.scope === 'group' ? ctx.scopeId : null
  const where = sendablePath(args.path, { groupId })
  if (typeof where === 'string') return `Not sent: ${where}.`
  const id = newFileId(), dest = join(FILES_DIR, id)
  const r = await execStream(['-w', '/work', ctx.container, 'bash', '-c', SEND_SCRIPT, '_', where.path, groupId ?? ''],
    { to: dest, max: UPLOAD_MAX })
  if (r.code !== 0 || !r.size) {
    await rm(dest, { force: true }).catch(() => {})
    return `Not sent: ${r.code === 413 ? `over the ${sizeText(UPLOAD_MAX)} limit` : !r.size && r.code === 0 ? 'the file is empty' : r.err || `exit ${r.code}`}.`
  }
  const name = safeName(posix.basename(where.path))
  const row = await db.createFile({ id, scope: ctx.scope, scope_id: ctx.scopeId, session_id: ctx.session,
    name, mime: mimeOf(name), size: r.size, by_agent: ctx.bot.id })
  const file = fileView(row)
  ;(ctx.sent ??= []).push(file)
  return { text: `Sent ${name} (${sizeText(r.size)}) to the user; they can open or preview it in the conversation.`, file }
}

/**
 * A stored message as the model reads it, attachments included. Every file gets a line (name, type,
 * where it is). A message not answered yet — the turn being taken now — also gets its images (for a
 * model that can see) and the text of its text files: later turns only get the line, since every step
 * resends the whole history and the images would be paid for again each time.
 */
async function withAttachments(text, files, fresh, budget) {
  if (!files?.length) return { content: text }
  const notes = [], images = []
  for (const f of files) {
    notes.push(attachmentNote(f))
    if (!fresh) continue
    const kind = kindOf(f.mime, f.name), path = join(FILES_DIR, f.id)
    try {
      if (VISION_MIMES.has(f.mime) && f.size <= VISION_MAX && budget.images < VISION_COUNT) {
        images.push(`data:${f.mime};base64,${(await readFile(path)).toString('base64')}`)
        budget.images++
      } else if ((kind === 'text' || kind === 'markdown') && budget.text < INLINE_TEXT_TOTAL) {
        const room = Math.min(INLINE_TEXT_MAX, INLINE_TEXT_TOTAL - budget.text)
        const fh = await openFile(path, 'r')
        let body
        try { const { buffer, bytesRead } = await fh.read(Buffer.alloc(room * 4), 0, room * 4, 0); body = buffer.subarray(0, bytesRead).toString('utf8') }
        finally { await fh.close() }
        const cut = body.length > room || f.size > room * 4
        body = body.slice(0, room)
        budget.text += body.length
        notes.push(`--- ${f.name} ---\n${body}${cut ? `\n… (cut here; the whole file is${f.path ? ` at ${f.path}` : ' longer'})` : ''}\n--- end of ${f.name} ---`)
      }
    } catch (e) { console.warn(`[files] could not read ${f.id} for the model: ${e.message}`) }
  }
  return { content: [text, ...notes].filter(Boolean).join('\n\n'), ...images.length ? { images } : {} }
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
    name: 'update_plan',
    description: 'Write down your plan for this task and keep it current: the whole list every time, each step with its status. ' +
      'Use it for anything with more than a couple of steps. Exactly one step is in_progress while you work; mark steps completed as you finish them, ' +
      'and blocked (saying why in your reply) when only the user can unblock them. Your turn is not over while a step is still pending or in_progress.',
    parameters: { type: 'object', required: ['plan'], properties: {
      plan: { type: 'array', items: { type: 'object', required: ['step', 'status'], properties: {
        step: { type: 'string', description: 'One step, a few words' },
        status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'blocked'] } } } } } } } },
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
      action: { type: 'string', enum: ['open', 'read', 'click', 'type', 'press', 'scroll', 'back', 'screenshot', 'eval', 'fill_secret'] },
      url: { type: 'string', description: 'For open' },
      index: { type: 'integer', description: 'For click / type: the element number listed by read' },
      text: { type: 'string', description: 'For type: the text to enter; for click you may also give the text on the button' },
      submit: { type: 'boolean', description: 'Press Enter after type' },
      key: { type: 'string', description: 'For press, e.g. Enter, Tab, Escape' },
      dy: { type: 'integer', description: 'For scroll: positive scrolls down, default 600' },
      js: { type: 'string', description: 'For eval: a JS expression to run in the page; its value is returned to you' },
      full_page: { type: 'boolean', description: 'For screenshot: capture the whole page, not just the current viewport' },
      secret: { type: 'string', description: 'For fill_secret: the name of one of your login secrets. It is typed into element `index` ' +
        'only while the page is on the site it was saved for — you never see it. submit presses Enter after.' } } } } },
  { type: 'function', function: {
    name: 'http_request',
    description: 'An HTTPS request sent by the platform — the way to call an API with one of your secrets (secret = its name): the ' +
      'platform adds the credential, only for the site it was saved for, and you never see it. Without a secret it is a plain ' +
      'request (curl on your machine does the same). Redirects are not followed; internal addresses are refused.',
    parameters: { type: 'object', required: ['url'], properties: {
      method: { type: 'string', enum: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] },
      url: { type: 'string', description: 'https only' },
      headers: { type: 'object', description: 'Extra request headers, as name: value' },
      body: { type: 'string', description: 'The request body (send JSON as a string, with a content-type header)' },
      secret: { type: 'string', description: 'The name of one of your header secrets to authenticate with' } } } } },
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
  { type: 'function', function: {
    name: 'send_file',
    description: 'Send a file from your machine to the user. It appears in the conversation, where they can preview it ' +
      '(images, video, audio, PDF, Markdown, text) or download it. Use it for anything you made for them — a report, a chart, ' +
      'a screenshot, a document, an archive. Only files in /work, or in this group\'s shared drive, can be sent.',
    parameters: { type: 'object', required: ['path'], properties: {
      path: { type: 'string', description: 'The file, e.g. /work/report.pdf, or report.pdf (relative to /work)' } } } } },
  { type: 'function', function: {
    name: 'install_packages',
    description: 'Install Debian packages (apt) on your machine. You work as an ordinary user, so this is how system packages ' +
      'get installed — ffmpeg, build-essential, poppler-utils and the like. Python and Node packages you install yourself ' +
      '(pip install / npm install -g), into your home.',
    parameters: { type: 'object', required: ['packages'], properties: {
      packages: { type: 'array', items: { type: 'string' }, description: 'Package names, e.g. ["ffmpeg"]' } } } } },
]

// The front of a conversation hands work out with these. In a DM a task is always the agent itself,
// so `agent` only exists in a group.
const fn = (name, description, properties = {}, required = []) =>
  ({ type: 'function', function: { name, description, parameters: { type: 'object', required, properties } } })
const taskRef = { task: { type: 'integer', description: 'The task number, e.g. 3 for #3' } }
const frontSpecs = group => [
  fn('start_task', 'Hand a piece of work to a background task. It runs on its own — same machine, same tools — while you stay free to talk, ' +
    'and reports back in this conversation when it finishes, fails, or needs something only the user can give. ' +
    (group ? 'Give it to a colleague by name and they work on it in parallel with the others; leave agent empty to take it yourself. ' : '') +
    'Write the brief for someone who has not read this conversation: the goal, what you already know, constraints, what to hand back.',
  { title: { type: 'string', description: 'A few words: what the task is' },
    brief: { type: 'string', description: 'Everything needed to do it without this conversation' },
    ...group ? { agent: { type: 'string', description: 'The colleague to give it to, by name. Empty = yourself' } } : {} },
  ['title', 'brief']),
  fn('list_tasks', 'Where this conversation\'s background tasks stand: number, who, status, and what a waiting one is asking.'),
  fn('answer_task', 'Pass the user\'s answer on to a task that is waiting for one (it asked a question). The task picks up from there.',
    { ...taskRef, answer: { type: 'string', description: 'The answer, as complete as the user gave it' } }, ['task', 'answer']),
  fn('cancel_task', 'Stop a background task that is no longer wanted.', taskRef, ['task']),
]
// A background task reports with these. It cannot start tasks of its own: one level is enough to keep track of.
const TASK_TOOLS = [
  fn('ask_user', 'Ask the user something only they can answer — a password, a login, a decision about what they want. ' +
    'Your work pauses here and their answer comes back as the next message. One clear question; say why you need it.',
    { question: { type: 'string' } }, ['question']),
  fn('finish_task', 'Report back and end the task: what you did, where the results are, what the user should check. ' +
    'If you could not do it, say exactly why.',
    { result: { type: 'string', description: 'Your report' } }, ['result']),
]
// Asking the person for a credential: only where a person can answer right away (not a background task).
const REQUEST_SECRET = fn('request_secret', 'Ask the user for a credential you need — an API key, a token, a password — instead of ' +
  'asking for it in the chat. They type it into a protected field; it is stored for you and you never see it. Then use it by name: ' +
  'http_request (kind header) or the browser\'s fill_secret (kind login).',
{ name: { type: 'string', description: 'A name for it, e.g. GITHUB_TOKEN' },
  purpose: { type: 'string', description: 'One sentence the user reads: what you need it for' },
  origin: { type: 'string', description: 'The https site it will be used on, e.g. https://api.github.com — it can be used nowhere else' },
  kind: { type: 'string', enum: ['header', 'login'], description: 'header: sent with API requests; login: typed into a login page' },
  header: { type: 'string', description: 'For header: which header, default Authorization' },
  format: { type: 'string', description: 'For header: how the value is written, default "Bearer {value}"' } },
['name', 'purpose', 'origin'])

// What each kind of turn may call. Tools off means no machine: only the task tools, which need none.
const specsFor = ({ task = false, group = false, dispatch = true } = {}) => [
  ...CFG.tools ? TOOL_SPECS : [],
  ...CFG.tools && !task ? [REQUEST_SECRET] : [],
  ...task ? TASK_TOOLS : dispatch ? frontSpecs(group) : [],
]

const clip = (t, max = OUT_MAX) => t.length > max ? `${t.slice(0, max)}\n… (truncated, ${t.length} characters in total)` : t

// The browser daemon (deploy/browserd.py) isn't in the image: it's pushed into the container before each use and
// swapped and restarted when its content changes. So changing it needs no image rebuild, and there's no
// "this agent's container is still running the old version".
const BROWSERD = await readFile(join(ROOT, 'deploy', 'browserd.py'), 'utf8')
// ⚠️ Can't use pkill -f browserd: this script's own command line contains that word, so it would kill itself (2.9.5)
const BROWSERD_UP = `
cat > /tmp/browserd.new
if ! cmp -s /tmp/browserd.new /tmp/browserd.py; then
  mv /tmp/browserd.new /tmp/browserd.py
  if [ -f /tmp/browserd.pid ]; then kill "$(cat /tmp/browserd.pid)" 2>/dev/null; sleep 1; fi
  rm -f /tmp/browserd.pid
fi
curl -sf http://127.0.0.1:9230/ >/dev/null && exit 0
command -v chromium >/dev/null || { echo "this machine's image has no browser (old image)"; exit 3; }
setsid nohup python3 /tmp/browserd.py >/tmp/browserd.log 2>&1 </dev/null &
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
  const c = cname(botId)
  if ((await cliRun(['inspect', '-f', '{{.State.Running}}', c], null, 10_000)).out.trim() !== 'true')
    await ensureContainer(botId, null)
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


/**
 * apt-get install, run as root in the agent's container — the one thing it can't do itself any more.
 * Names only (optionally =version): nothing that reads as an option or a path gets to apt.
 */
async function installPackages(c, args) {
  const names = (Array.isArray(args.packages) ? args.packages : []).map(x => String(x).trim()).filter(Boolean)
  if (!names.length || names.length > 30 || names.some(n => !/^[a-z0-9][a-z0-9+.-]{0,62}(=[A-Za-z0-9.+~:-]{1,40})?$/.test(n)))
    return 'Not installed: give Debian package names, e.g. ["ffmpeg", "poppler-utils"] (at most 30).'
  const r = await cliRun(['exec', '-u', '0', '-e', 'DEBIAN_FRONTEND=noninteractive', c, 'bash', '-c',
    'apt-get update -qq >/dev/null 2>&1; apt-get install -y -q --no-install-recommends -- "$@" 2>&1 | tail -n 15', '_', ...names], null, 900_000)
  return clip(`${r.out}${r.err ? `\n--- stderr ---\n${r.err}` : ''}\n--- exit ${r.code} ---`, 4000)
}

// ---------- Secrets: used by name, never seen ----------
// The rules are in secrets.mjs. Sealed with SECRET_KEY, else with a key generated into the workspace on
// first use — a directory no agent's container mounts. Lose the key and every stored secret is lost with
// it (they can't be opened), so backups take the workspace along with the database.
let secretKeyCache = null
async function secretKey() {
  if (secretKeyCache) return secretKeyCache
  if (env.SECRET_KEY) {
    const k = parseKey(env.SECRET_KEY)
    if (!k) throw new Say('secret.badKey', {}, 500)
    return (secretKeyCache = k)
  }
  const file = join(LOCALWORK, '.secret-key')
  let text = await readFile(file, 'utf8').catch(() => null)
  if (!text) {
    await mkdir(LOCALWORK, { recursive: true })
    try { text = newKey(); await writeFile(file, text, { mode: 0o600, flag: 'wx' }) }
    catch (e) { if (e.code !== 'EEXIST') throw e; text = await readFile(file, 'utf8') }
  }
  const k = parseKey(text)
  if (!k) throw new Say('secret.badKey', {}, 500)
  return (secretKeyCache = k)
}

/** The agent's secret values, opened once per turn: what tool output is masked against. */
async function secretValues(ctx) {
  if (!ctx.bot) return []
  if (!ctx.secretValues) {
    const rows = await db.secretsWithValues(ctx.bot.id)
    const key = rows.length ? await secretKey() : null
    ctx.secretValues = rows.map(r => { try { return { name: r.name, value: unseal(key, r.value_enc) } } catch { return null } }).filter(Boolean)
  }
  return ctx.secretValues
}

async function storeSecret(agentId, s) {
  return db.saveSecret({ id: randomUUID().replace(/-/g, '').slice(0, 16), agent_id: agentId, name: s.name, kind: s.kind,
    origin: s.origin, header: s.header, format: s.format, value_enc: seal(await secretKey(), s.value) })
}

// Origins an operator lets http_request reach although they resolve to internal addresses (a service on
// the LAN). https only, comma-separated. Nothing else internal is ever reached from the server.
const HTTP_ALLOW = new Set(String(env.HTTP_REQUEST_ALLOW ?? '').split(',').map(x => x.trim()).filter(Boolean)
  .map(x => { try { return new URL(x).origin } catch { return '' } }).filter(Boolean))
const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']
const HTTP_BODY_MAX = 256 * 1024

/** Resolve, and refuse an internal address at connect time — checking first and connecting later could be fooled by DNS. */
function guardedLookup(hostname, opts, cb) {
  dnsLookup(hostname, { ...opts, all: true }, (err, list) => {
    if (err) return cb(err)
    const bad = list.find(a => isPrivateAddress(a.address))
    if (bad) return cb(Object.assign(new Error(`${hostname} is an internal address (${bad.address}) — refused`), { code: 'EINTERNAL' }))
    return opts?.all ? cb(null, list) : cb(null, list[0].address, list[0].family)
  })
}

function sendHttps(url, { method, headers, body }) {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, { method, headers, timeout: 30_000, ...HTTP_ALLOW.has(url.origin) ? {} : { lookup: guardedLookup } }, res => {
      const chunks = []
      let size = 0
      res.on('data', d => { if (size < HTTP_BODY_MAX) chunks.push(d); size += d.length })
      res.on('end', () => resolve({ status: res.statusCode, statusText: res.statusMessage, headers: res.headers,
        body: Buffer.concat(chunks).subarray(0, HTTP_BODY_MAX), size }))
      res.on('error', reject)
    })
    req.on('timeout', () => req.destroy(new Error('no answer within 30 s')))
    req.on('error', reject)
    req.end(body)
  })
}

async function httpRequest(ctx, args) {
  const method = String(args.method || 'GET').toUpperCase()
  if (!HTTP_METHODS.includes(method)) return `Not sent: the method must be one of ${HTTP_METHODS.join(', ')}.`
  let url
  try { url = new URL(String(args.url ?? '')) } catch { return 'Not sent: that is not a URL.' }
  if (url.protocol !== 'https:') return 'Not sent: only https URLs.'
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(host) && isPrivateAddress(host) && !HTTP_ALLOW.has(url.origin)) return `Not sent: ${host} is an internal address.`
  const headers = {}
  for (const [k, v] of Object.entries(args.headers && typeof args.headers === 'object' ? args.headers : {}))
    if (/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/.test(k) && typeof v === 'string' && !/[\r\n]/.test(v)) headers[k] = v
  let secret = null
  if (args.secret) {
    secret = await db.secretByName(ctx.bot.id, String(args.secret))
    if (!secret) {
      const mine = (await db.listSecrets(ctx.bot.id)).map(s => s.name)
      return `Not sent: you have no secret called "${args.secret}". Yours: ${mine.join(', ') || '(none)'} — ask for one with request_secret.`
    }
    if (secret.kind !== 'header') return `Not sent: "${secret.name}" is a login — it is for the browser's fill_secret.`
    if (url.origin !== secret.origin) return `Not sent: "${secret.name}" may only be sent to ${secret.origin}, not ${url.origin}.`
    for (const k of Object.keys(headers)) if (k.toLowerCase() === secret.header.toLowerCase()) delete headers[k]
    const [h, v] = headerFor(secret, unseal(await secretKey(), secret.value_enc))
    headers[h] = v
  }
  const body = method === 'GET' || method === 'HEAD' ? undefined : String(args.body ?? '')
  let r
  try { r = await sendHttps(url, { method, headers, body }) }
  catch (e) { return `Request failed: ${e.message}` }
  if (secret) db.touchSecret(secret.id).catch(() => {})
  const type = String(r.headers['content-type'] ?? '')
  const textual = !type || /^text\/|json|xml|javascript|x-www-form-urlencoded|csv/i.test(type)
  const head = [`HTTP ${r.status} ${r.statusText ?? ''}`.trim(), type && `content-type: ${type}`,
    r.headers.location && `location: ${r.headers.location} (redirects are not followed)`].filter(Boolean).join('\n')
  if (method === 'HEAD' || !r.size) return `${head}\n(no body)`
  if (!textual) return `${head}\n(${r.size} bytes of ${type} — not text)`
  return clip(`${head}\n\n${r.body.toString('utf8')}${r.size > HTTP_BODY_MAX ? `\n… (cut at ${HTTP_BODY_MAX} of ${r.size} bytes)` : ''}`, 20_000)
}

// id -> { agent, spec, resolve }: a card in the conversation with a password field, until it is answered.
const pendingSecrets = new Map()

/** Ask the person for a credential. Waits on the card like an approval does; the value never comes back here. */
async function requestSecret(ctx, args) {
  const spec = checkSecret(args, { needValue: false })
  if (spec.need) return `Not asked: give ${NEEDS[spec.need]}.`
  if (ctx.task || ctx.unattended || ctx.run?.detached)
    return `Nobody is here to type it right now. Tell the user to add a secret named ${spec.name} for ${spec.origin} under your ` +
      'Secrets in the side panel, and carry on with what does not need it.'
  const id = randomUUID()
  const purpose = String(args.purpose ?? '').trim().slice(0, 300)
  const answer = await new Promise(resolve => {
    const done = v => {
      if (!pendingSecrets.delete(id)) return
      ctx.run?.asking.delete(id)
      ctx.signal?.removeEventListener('abort', onAbort)
      ctx.onTool?.({ phase: 'secret_done', id, ok: v === 'saved' })
      resolve(v)
    }
    const onAbort = () => done('aborted')
    pendingSecrets.set(id, { agent: ctx.bot.id, spec, resolve: done })
    ctx.run?.asking.add(id)
    ctx.signal?.addEventListener('abort', onAbort, { once: true })
    ctx.onTool?.({ phase: 'secret', id, name: spec.name, purpose, origin: spec.origin, kind: spec.kind })
  })
  if (answer === 'saved') {
    ctx.secretValues = null
    return `Saved as ${spec.name}. Use it by name — ${spec.kind === 'login' ? 'the browser\'s fill_secret' : 'http_request with secret: "' + spec.name + '"'} — ` +
      'it only works on ' + spec.origin + '. You will never see the value; don\'t ask for it.'
  }
  if (answer === 'aborted') return 'Stopped before the user answered.'
  return 'The user did not give it. Do not ask for it in the chat; carry on without it, or say plainly what you cannot do.'
}

/** Type a login secret into the page — only while the page is on the secret's site (the daemon checks, under its own lock). */
async function fillSecret(c, args, ctx) {
  const s = args.secret ? await db.secretByName(ctx.bot.id, String(args.secret)) : null
  if (!s) return `You have no secret called "${args.secret ?? ''}". Ask for one with request_secret (kind login).`
  if (s.kind !== 'login') return `"${s.name}" is for API requests (http_request), not for typing into a page.`
  const up = await execIn(c, ['-i', c, 'bash', '-c', BROWSERD_UP], BROWSERD)
  if (up.code !== 0) return `The browser would not start: ${(up.out + up.err).trim().slice(-600)}`
  const j = await browserPost(c, { action: 'fill_secret', index: args.index, selector: args.selector, submit: !!args.submit,
    origin: s.origin, text: unseal(await secretKey(), s.value_enc) })
  if (!j.ok) return `Not typed: ${j.error}`
  db.touchSecret(s.id).catch(() => {})
  return `Typed ${s.name} into element ${args.index}${args.submit ? ' and pressed Enter' : ''}. Page: ${j.title || '(no title)'}  ${j.url}`
}

// The file tools all run inside the container, so path semantics are uniform (/work in the container, not a host path).
// write_file goes over stdin instead of building a command line — quotes, newlines and $ in the content can't break anything.
/**
 * Run one tool call. Whatever comes back is read by the model, so a secret's value that shows up in
 * it — echoed by a command, an API, a page — is masked first.
 */
async function runTool(name, args, ctx) {
  const res = await runToolRaw(name, args, ctx)
  const secrets = await secretValues(ctx)
  if (!secrets.length) return res
  if (typeof res === 'string') return redact(res, secrets)
  return res?.text ? { ...res, text: redact(res.text, secrets) } : res
}

async function runToolRaw(name, args, ctx) {
  const c = ctx.container
  // Only what this turn was offered: a model that names a tool it wasn't given doesn't get to use it.
  if (ctx.specs && !ctx.specs.some(s => s.function.name === name)) return `You have no tool called ${name}.`
  if (TASK_TOOL_NAMES.has(name)) return runTaskTool(name, args, ctx)
  if (name === 'http_request') return httpRequest(ctx, args)
  if (name === 'install_packages') return installPackages(c, args)
  if (name === 'request_secret') return requestSecret(ctx, args)
  if (name === 'browser' && args.action === 'fill_secret') return fillSecret(c, args, ctx)
  if (name === 'browser') return runBrowser(c, args, ctx)
  if (name === 'read_skill') {
    const mine = await db.skillsFor(ctx.bot.id)
    const k = mine.find(x => x.name.toLowerCase() === String(args.name ?? '').trim().toLowerCase())
    return k ? `# ${k.name}\nWhen to use: ${k.description}\n\n${k.body}`
      : `You have no skill named "${args.name}". Installed for you: ${mine.map(x => x.name).join(', ') || '(none)'}`
  }
  if (name === 'save_skill') return saveSkillFromAgent(ctx.bot, args)
  if (name === 'send_file') return sendFromAgent(ctx, args)
  if (name === 'remember') return rememberFromAgent(ctx.bot, args.fact)
  if (name === 'update_plan') {
    const plan = checkPlan(args.plan)
    if (typeof plan === 'string') return `Plan not saved: ${plan}`
    ctx.plan = plan
    const open = openSteps(plan).length
    return `Plan saved:\n${planText(plan)}\n${open ? `${open} step${open > 1 ? 's' : ''} to go.` : 'Every step is done or blocked.'}`
  }
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
  if (!usage) return
  db.recordUsage({
    agent_id: ctx.bot.id, scope: ctx.scope ?? 'dm', scope_id: ctx.scopeId ?? ctx.bot.id,
    provider_id: p.id ?? '', model: p.model ?? '',
    prompt_tokens: usage.prompt, completion_tokens: usage.completion,
    cost_micro: db.costOf(p, usage.prompt, usage.completion), estimated: usage.estimated === true,
  }).catch(e => console.error(`usage row lost for ${ctx.bot.id}:`, e.message))
}

/** Call the model once. Protocol translation and stream parsing live in protocols.mjs; here we only decide which tools to send. */
function callModel(p, messages, onDelta, { bare = false, signal, specs = null } = {}) {
  const tools = bare ? null : specs ?? (CFG.tools ? TOOL_SPECS : null)
  return callUpstream(p, messages, tools?.length ? tools : null, onDelta, signal)
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
  ctx.onTool = onTool                          // tools that talk to the person (request_secret) need the stream
  const limits = limitsFor(ctx.autonomy)
  const lang = ctx.lang ?? 'en'
  let text = '', nudged = 0
  for (let step = 0; step < limits.steps; step++) {
    // The person said something while this turn was working: it reaches the model now, before the
    // next call — not after the whole turn has finished. Already stored when it arrived.
    const said = ctx.run?.inbox?.splice(0) ?? []
    if (said.length) {
      const budget = { images: 0, text: 0 }
      for (const m of said)
        messages.push({ role: 'user', ...await withAttachments(ctx.peers ? `[User] ${m.text}` : m.text, m.files, true, budget) })
      onTool?.({ phase: 'interject', n: said.length })
    }
    await checkCap(ctx.bot, p)
    const fit = fitContext(messages, p.context_tokens)
    if (fit.dropped) onTool?.({ phase: 'trim', dropped: fit.dropped })
    // Retry. Relay gateways hit bad channels at random (200 then an error inside the stream), and in a group chat
    // one silent empty turn means "the relay died on this person".
    //
    // ⚠️ Must back off before retrying. In group relays the first person reliably succeeded and the second reliably
    // failed — not random, the two calls were too close together and got rate-limited; retrying immediately guarantees another hit.
    let r
    for (const [i, wait] of RETRY_WAITS.entries()) {
      if (wait) await new Promise(t => setTimeout(t, wait))
      try { r = await callModel(p, fit.messages, onDelta, { signal: ctx.signal, specs: ctx.specs }); break }
      catch (e) {
        if (ctx.signal?.aborted) throw new Say('chat.aborted')
        // Rejected with a 4xx while carrying a screenshot: most likely this model doesn't accept images. Drop them and carry on,
        // and stop sending screenshots afterwards — otherwise a model that can't see images fails the whole turn on the browser
        if (isUpstreamError(e) && upstreamStatus(e) >= 400 && upstreamStatus(e) < 500 && dropImages(messages)) {
          ctx.noImages = true
          onTool?.({ phase: 'retry', reason: tr(lang, 'chat.noImages') })
          r = null; break
        }
        // Out of retries (or not worth one): a backup model, if the agent has one left. The rest of this
        // turn stays on it; the next turn starts from the agent's own model again.
        if (!isUpstreamError(e) || i === RETRY_WAITS.length - 1) {
          ctx.fallbacks ??= await fallbacksFor(ctx.bot)
          const next = worthFallingBack(e) && ctx.fallbacks.shift()
          if (!next) throw e
          console.warn(`[fallback] ${ctx.bot.name}: ${p.model} failed (${errorText(e, 'en').slice(0, 160)}); trying ${next.model}`)
          onTool?.({ phase: 'retry', reason: tr(lang, 'chat.fallback', { from: p.model, model: next.model }) })
          p = next
          r = null; break
        }
        onTool?.({ phase: 'retry', reason: errorText(e, lang).slice(0, 120) })
      }
    }
    if (!r) { step--; continue }
    const { content, calls, usage } = r
    noteUsage(ctx, p, usage)
    if (content) text = content
    if (!calls.length) {
      // Done — but the person said something meanwhile. This answer is kept as it is, and the turn
      // goes on to the new message instead of leaving it for a turn of its own.
      if (ctx.run?.inbox?.length) {
        if (content) { await ctx.saveReply?.(content); messages.push({ role: 'assistant', content }); text = '' }
        continue
      }
      // Stopped with its own plan unfinished: in auto mode that is a pause, not the end. Send it back,
      // a few times at most — an agent that keeps stopping has a reason, and it should say it.
      // A front thread with work out in background tasks is waiting for news, not stopped: sending it
      // back to its plan would only make it poll.
      const waiting = ctx.dispatched || (ctx.front && await db.openTaskCount(ctx.scope, ctx.scopeId) > 0)
      const nudge = waiting ? null : nudgeFor(ctx.plan, nudged, limits)
      if (!nudge) return text
      nudged++
      if (content) messages.push({ role: 'assistant', content })
      messages.push({ role: 'user', content: nudge })
      onTool?.({ phase: 'nudge', open: openSteps(ctx.plan).length })
      continue
    }

    messages.push({
      role: 'assistant',
      content: content || null,
      tool_calls: calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args } })),
    })
    let shot = null
    for (const c of calls) {
      if (ctx.signal?.aborted) throw new Say('chat.aborted')
      let args = {}
      try { args = JSON.parse(c.args || '{}') } catch { args = {} }
      onTool?.({ phase: 'run', name: c.name, args })
      const need = gate(c.name, args, ctx.approval ?? { mode: 'off' }, await allowedFor(ctx.bot.id))
      const allowed = !need || await askApproval(ctx, onTool, c.name, args, need.allow)
      // Hanging up while a card waits is not a refusal — recording one would leave the transcript
      // saying the user said no to something they never saw an answer for.
      if (ctx.signal?.aborted) throw new Say('chat.aborted')
      // The refusal goes back as the tool result so the agent adapts instead of retrying: it is the
      // only thing it will ever see about this call.
      const res = allowed
        ? await runTool(c.name, args, ctx).catch(e => `Tool error: ${errorText(e, 'en')}`)
        : `Refused${ctx.task ? ' by the user' : ctx.unattended ? ' (this ran as a scheduled task, with nobody there to approve it)'
          : ctx.run?.detached ? ' (the user closed the page, so nobody was there to approve it)' : ' by the user'}: ${toolSubject(c.name, args)}
Do not try this again. Do it another way, or say why you cannot.`
      const out = typeof res === 'string' ? res : res.text
      if (res?.image) shot = res.image
      // Send the screenshot to the UI too: people need to see what the agent saw. Only through this stream, never stored.
      // A file the agent sent rides on the same card, and is stored with it: that card is where the person sees it.
      onTool?.({ phase: 'done', name: c.name, args, output: out, ...res?.image ? { image: res.image } : {}, ...res?.file ? { file: res.file } : {} })
      // Keep the call in the transcript, cut to the same length the live stream shows — reopening a
      // conversation should show the same cards, not more and not fewer.
      // A background task keeps its own trace instead: its commands aren't part of the conversation.
      const step = { name: c.name, args, output: (out ?? '').slice(0, TOOL_TRACE), ...res?.file ? { file: res.file } : {} }
      if (ctx.task) await db.traceTask(ctx.task.id, { ...step, at: Date.now() })
      else if (ctx.scope) await db.addTool(ctx.scope, ctx.scopeId, ctx.session, ctx.bot?.name ?? '', step)
      messages.push({ role: 'tool', tool_call_id: c.id, content: out })
    }
    // A screenshot can't go into a tool result (Chat protocol tool messages only take text), so it follows as a user message.
    // Keep only the newest one: ten screenshots in a turn would each be paid for at every step, and the old ones are useless
    if (shot) {
      dropImages(messages, '(a screenshot was here; it has been replaced by a newer one)')
      messages.push({ role: 'user', content: '(this is the page captured by the browser screenshot just now)', images: [shot] })
    }
    // Every tool call has its result now: a consistent point to save a background task at.
    await ctx.onStep?.(messages)
    // ask_user / finish_task end the run here; the task's runner takes it from there.
    if (ctx.halt) return text
  }
  if (text) return text
  // Said nothing at all before the limit: say that, live as well as in the stored transcript
  const limit = `(hit the limit of ${limits.steps} steps in one turn; stopping here for now)`
  onDelta?.(limit)
  return limit
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

/**
 * Run a turn; if it is stopped, leave a line in the transcript saying so. Otherwise a conversation
 * reopened later shows the question and the commands that ran, and then nothing — which reads as
 * "it's still thinking" or "it crashed", not "someone pressed Stop".
 */
async function stopNoted(write, signal, fn) {
  try { return await fn() } catch (e) {
    if (signal?.aborted) await write('(Stopped before finishing.)').catch(() => {})
    throw e
  }
}

/**
 * A conversation's stored history as the model reads it. Task news ("[Platform] …") reads as a user
 * message: it is something the front thread is being told, not something it said. In a group (`self`
 * given) everyone else's words come prefixed with their name.
 */
async function forModel(rows, self = null) {
  // Messages nobody has answered yet are this turn's: they get their attachments in full (withAttachments).
  const answered = rows.reduce((n, m) => m.role === 'assistant' ? Math.max(n, Number(m.id)) : n, 0)
  const budget = { images: 0, text: 0 }
  const out = []
  for (const m of [...rows].reverse()) {                      // newest first, so the budget goes to the latest
    if (m.role === 'event') {
      try { out.push({ role: 'user', content: eventForModel(JSON.parse(m.content)) }) } catch {}
      continue
    }
    const mine = !self || (m.speaker === self.name && m.role === 'assistant')
    const text = mine ? m.content : `[${modelSpeaker(m.speaker)}] ${m.content}`
    const role = self ? (mine ? 'assistant' : 'user') : m.role     // a DM: the agent is the only one answering
    out.push({ role, ...await withAttachments(text, m.files, Number(m.id) > answered, budget) })
  }
  return out.reverse()
}

/** Model messages as kept for a restart: no screenshots (they are never stored). */
const storable = messages => messages.map(({ images, ...m }) =>
  images ? { ...m, content: `${m.content ?? ''}\n(a screenshot was here)` } : m)

const RESTART_NOTE = '[Platform] The server restarted while you were working on this turn. What you did before that is above; ' +
  'a command that was running may or may not have finished. Check where things stand before redoing anything, then carry on.'

/**
 * The model messages for a front turn, and how to save it after every step. A fresh turn reads the
 * session's history; a resumed one (after a restart) reads it only as far as it had then, adds what the
 * turn had done (`tail`), and a note saying the server restarted. `history` is that history as rows.
 */
function frontTurn(system, history, rowsRead, { session, scope, scopeId, speaker, resume, later = [] }) {
  const read_upto = resume ? Number(resume.read_upto) : Number(rowsRead.at(-1)?.id ?? 0)
  // Said during the turn but after its last saved step: not in the tail, so not lost either.
  const tail = resume?.tail ?? []
  const missed = later.filter(m => !tail.some(t => t.role === 'user' && t.content === m.content))
  const messages = [{ role: 'system', content: system }, ...history,
    ...resume ? [...tail, { role: 'user', content: RESTART_NOTE }, ...missed] : []]
  const base = 1 + history.length
  const save = msgs => db.saveFrontRun({ session, scope, scope_id: scopeId, speaker, read_upto, tail: storable(msgs.slice(base)) })
  return { messages, save }
}

// session -> the newest message id its last front turn read. News that lands mid-turn (a quick task
// can finish before the turn that started it has replied) is newer than that, so it still wakes it.
const frontRead = new Map()
function readHistory(rows, session) {
  if (rows.length) frontRead.set(session, Number(rows.at(-1).id))
  return rows
}

/** The open tasks a front thread is told about: this session's, since that's where their news arrives. */
async function openTasksIn(scope, scopeId, session) {
  const all = await db.listAgents()
  const names = new Map(all.map(a => [a.id, a.name]))
  const open = (await db.listTasks(scope, scopeId, 100)).filter(t => t.session_id === session && isOpen(t)).reverse()
  return { open, nameOf: id => names.get(id) ?? id }
}

// One-on-one. The user's message is already stored (converse does that before waiting its turn).
function askSolo(p, bot, memory, onDelta, onTool, signal, lang, gate, session, resume = null) {
  return withAgent(bot.id, async () => {
    // Only this session's history: a new session is a clean slate for the model, not a new view of the old one.
    // Resumed after a restart: only as far as the turn had read when it started.
    const rows = readHistory(await db.recent('dm', bot.id, FETCH_MAX, { session, upto: resume?.read_upto ?? null }), session)
    const history = await forModel(rows)
    // With tools off there's no use for a container — and don't tell the persona it "has its own machine"
    const container = CFG.tools ? await ensureContainer(bot.id, null) : null
    const { open, nameOf } = await openTasksIn('dm', bot.id, session)
    const system = systemFor(bot, memory, { box: CFG.tools ? '/work' : null, recall: await groupRecallFor(bot),
      skills: await db.skillsFor(bot.id), auto: gate.autonomy === 'auto', open, nameOf, secrets: await db.listSecrets(bot.id) })
    const write = content => db.addMessage('dm', bot.id, session, { role: 'assistant', speaker: bot.name, content })
    const later = resume ? await forModel((await db.recent('dm', bot.id, FETCH_MAX, { session }))
      .filter(m => m.role === 'user' && Number(m.id) > Number(resume.read_upto))) : []
    const turn = frontTurn(system, history, rows, { session, scope: 'dm', scopeId: bot.id, speaker: bot.id, resume, later })
    await turn.save(turn.messages)
    const full = await stopNoted(write, signal, () => runAgent(p, turn.messages,
      onDelta, onTool, { container, signal, bot, lang, scope: 'dm', scopeId: bot.id, session, front: true,
        specs: specsFor({ dispatch: CFG.tools }), saveReply: write, onStep: turn.save, ...gate }))
    await write(full)
    return full
  })
}

// One person speaking once in a group chat: he sees the session's whole log, other people's words prefixed by name
function askInGroup(p, bot, peers, lead, memory, onDelta, onTool, groupId, signal, lang, gate, session, resume = null) {
  return withAgent(bot.id, async () => {
    const container = CFG.tools ? await ensureContainer(bot.id, groupId) : null
    const { open, nameOf } = await openTasksIn('group', groupId, session)
    const system = systemFor(bot, memory, { peers, box: CFG.tools ? '/work' : null, skills: await db.skillsFor(bot.id),
      lead, auto: gate.autonomy === 'auto', groupId, open, nameOf, secrets: await db.listSecrets(bot.id) })
    const rows = readHistory(await db.recent('group', groupId, FETCH_MAX, { session, upto: resume?.read_upto ?? null }), session)
    const later = resume ? await forModel((await db.recent('group', groupId, FETCH_MAX, { session }))
      .filter(m => m.role === 'user' && Number(m.id) > Number(resume.read_upto)), bot) : []
    const turn = frontTurn(system, await forModel(rows, bot), rows, { session, scope: 'group', scopeId: groupId, speaker: bot.id, resume, later })
    await turn.save(turn.messages)
    const write = content => db.addMessage('group', groupId, session, { role: 'assistant', speaker: bot.name, content })
    const reply = await stopNoted(write, signal, () => runAgent(p, turn.messages, onDelta, onTool,
      { container, signal, bot, peers, lang, scope: 'group', scopeId: groupId, session, front: true,
        specs: specsFor({ group: true }), saveReply: write, onStep: turn.save, ...gate }))
    await write(reply)
    return reply
  })
}

/**
 * Find the colleague @-mentioned in a message. Only the last @ counts.
 *
 * ⚠️ Do NOT add `\b` after the name. `\b` judges word boundaries by [A-Za-z0-9_];
 * CJK characters aren't \w, so after "@<Chinese name>" there is never a word boundary and it never matches —
 * and Chinese names are this product's main use case.
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

// Messages waiting for their session's previous turn to end. Stop reaches these too.
const waitingRuns = new Set()

/**
 * One turn of a conversation: a message comes in, and one agent answers it — in a DM that agent, in a
 * group whoever the user @-ed, else the coordinator (the lead, else the first by order). Colleagues
 * work through background tasks the answering agent starts; they no longer take turns speaking.
 *
 * `text` null = no new message: the front thread was woken because a task reported back (wakeFront).
 * Sending from the UI, a scheduled task firing and a wake-up all go through this one function.
 * Errors aren't thrown; they're reported via emit('error') (the UI shows them, scheduled tasks record them).
 */
async function converse(bots, groupId, providers, text, emit, controller, lang = 'en',
  { unattended = false, session: want = null, run = newRun(), wake = null, files: fileIds = [], interject = false,
    resume = null } = {}) {
  const signal = controller.signal
  const scope = groupId || bots.length > 1 ? 'group' : 'dm'
  const scopeId = groupId ?? (bots.length > 1 ? 'main' : bots[0].id)
  let session = null
  const waiting = { abort: () => controller.abort() }
  try {
    // Which session this goes into, said first: a client that asked for a new one learns its id
    // before the first word arrives, and switches its session list over to it.
    session = await sessionFor(scope, scopeId, want)
    holdSession(session)
    emit('session', { id: session })
    // Stored before waiting its turn: the message was sent now, even if the agent is still on the last one.
    // Its attachments become this session's, and are copied into the agent's machine (any member's will
    // do in a group: they all mount its drive); the message keeps where each one landed.
    if (text != null) {
      const files = await deliverToInbox((await db.attachFiles(fileIds, scope, scopeId, session)).map(fileView),
        bots[0], scope === 'group' ? scopeId : null)
      await db.addMessage(scope, scopeId, session, { role: 'user', speaker: USER_SPEAKER, content: text, files })
      // Interjecting: the turn at work in this session takes it at its next step. With none at work
      // any more (it just ended), a turn of its own answers it — nobody waits on this request for it.
      if (interject) {
        const live = runs.get(session)
        if (live) {
          live.inbox.push({ text, files })
          emit('note', { text: tr(lang, 'run.interjected') })
        } else {
          followUp(bots, groupId, providers, session)
          emit('note', { text: tr(lang, 'run.interjectedLate') })
        }
        return
      }
    }
    const key = `session:${session}`
    // One turn per session at a time — a second message would race the first for the same history. It waits instead.
    if (locks.has(key) && text != null) emit('note', { text: tr(lang, 'run.queued') })
    Object.assign(waiting, { session, scope, scopeId })
    waitingRuns.add(waiting)
    await withLock(key, async () => {
      waitingRuns.delete(waiting)
      wake?.started()
      if (signal.aborted) throw new Say('chat.aborted')
      // Woken for news a turn in between has already read: nothing to say.
      if (wake && !await db.unseenTaskNews(session, frontRead.get(session) ?? null)) return
      Object.assign(run, { session, scope, scopeId, abort: () => controller.abort(), startedAt: Date.now() })
      runs.set(session, run)
      try { await turn() } finally {
        if (runs.get(session) === run) runs.delete(session)
        // Finished one way or another (answered, failed, stopped): nothing for a restart to pick up.
        await db.dropFrontRun(session).catch(e => console.warn(`[resume] could not clear ${session}: ${e.message}`))
      }
      // Something arrived after the turn's last look at its inbox: answer it rather than drop it.
      // Not after Stop — that stops what was sent along with it.
      if (run.inbox.length && !signal.aborted) { run.inbox.length = 0; followUp(bots, groupId, providers, session) }
    })
  } catch (e) {
    emit('error', { botId: bots[0].id, message: errorText(e, lang).slice(0, 300), capped: e?.capped === true })
  } finally {
    waitingRuns.delete(waiting)
    if (session) releaseSession(session)
  }

  async function turn() {
    const policy = await approvalPolicy()
    const platform = await db.defaultAutonomy()
    // Per agent: its own setting wins, otherwise the platform's. Resolved here so one turn can't
    // change its mind halfway through because someone saved the settings dialog.
    const gateFor = b => ({ unattended, run, autonomy: resolveAutonomy(b.autonomy, platform),
      approval: { ...policy, mode: b.approval || policy.mode } })
    const tool = id => t => emit('tool', { botId: id, ...t, output: t.output?.slice(0, TOOL_TRACE) })
    if (scope === 'dm') {
      const bot = bots[0]
      run.speaker = bot.id
      emit('start', { botId: bot.id })
      const reply = await askSolo(providers.get(bot.id), bot,
        { own: await db.getMemory('agent', bot.id), self: await db.getSelfMemory(bot.id) },
        d => emit('delta', { botId: bot.id, text: d }), tool(bot.id), signal, lang, gateFor(bot), session, resume)
      emit('end', { botId: bot.id })
      notify({ kind: 'reply', conv: { kind: 'agent', id: bot.id, name: bot.name }, session, agent: bot.name, text: reply })
      return
    }
    const g = (await db.listGroups()).find(x => x.id === scopeId)
    // Someone always coordinates a group: the lead, else whoever sorts first (Chief of Staff is 0).
    const coordinator = bots.find(b => b.id === g?.lead) ?? bots[0]
    // Woken by a task: whoever started it hears the news, if they're still here.
    const speaker = (resume && bots.find(b => b.id === resume.speaker)) || (wake && bots.find(b => b.id === wake.speaker)) ||
      (text != null && findMention(text, bots)) || coordinator
    run.speaker = speaker.id
    emit('start', { botId: speaker.id })
    const reply = await askInGroup(providers.get(speaker.id), speaker, bots.filter(b => b.id !== speaker.id), coordinator,
      { own: await db.getMemory('agent', speaker.id), self: await db.getSelfMemory(speaker.id),
        group: await db.getMemory('group', scopeId) },
      d => emit('delta', { botId: speaker.id, text: d }), tool(speaker.id),
      scopeId, signal, lang, gateFor(speaker), session, resume)
    notify({ kind: 'reply', conv: { kind: 'group', id: scopeId, name: g?.name ?? scopeId }, session, agent: speaker.name, text: reply })
    emit('end', { botId: speaker.id })
  }
}

// ---------- Notifications ----------
// One feed for everything a person may want to hear about while not looking: a reply finished, a
// task asks something, a command waits for approval. The server doesn't know who is looking —
// a phone locked mid-reply still has its stream open — so every client gets every notice and
// decides itself (the web page: hidden, or another conversation open; Android: app not in front).
// Kept in memory, the last NOTICE_KEEP, so a client that reconnects gets what it missed
// (SSE Last-Event-ID, or ?after=); a restart forgets them.
const NOTICE_KEEP = 300
const notices = []
const noticeSubs = new Set()
let noticeSeq = Date.now()            // ids keep growing across restarts, so a client's "after" stays meaningful

/** Plain text for a notification: no code fences, Markdown marks or long whitespace. */
const noticeText = t => String(t ?? '').replace(/```[\s\S]*?```/g, ' [code] ').replace(/[*_`#>|]/g, '')
  .replace(/\s+/g, ' ').trim().slice(0, 180)

function notify(n) {
  const notice = { id: ++noticeSeq, at: Date.now(), ...n, text: noticeText(n.text) }
  notices.push(notice)
  if (notices.length > NOTICE_KEEP) notices.shift()
  for (const send of noticeSubs) send(notice)
}

const noticesAfter = after => notices.filter(x => x.id > after)

// ---------- Background tasks ----------
// The rules are in tasks.mjs. A task runs as its agent, on its machine, one at a time per agent
// (lock task:<agent>), side by side with other agents' tasks and with the agent's own front turns.
// It never holds the process while it waits for a person: ask_user ends the run with the task at
// 'waiting', and the answer queues it again with its saved transcript. An approval is the exception —
// the card waits in memory, holding that agent's queue (a restart turns it into "it was not run").

const TASK_TOOL_NAMES = new Set(['start_task', 'list_tasks', 'answer_task', 'cancel_task', 'ask_user', 'finish_task'])
const taskAborts = new Map()      // task id -> its AbortController, while it runs
const taskQueued = new Set()      // ids queued in this process, so one isn't queued twice

/** What the clients see of a task. The approval's arguments stay on the server; its one-line subject is enough. */
const taskView = t => ({
  id: Number(t.id), session: t.session_id, agent_id: t.agent_id, by_agent: t.by_agent, title: t.title, brief: t.brief,
  status: t.status, question: t.question,
  approval: t.approval ? { id: t.approval.id, name: t.approval.name, subject: toolSubject(t.approval.name, t.approval.args ?? {}),
    always: t.approval.always ?? [] } : null,
  result: t.result, created_at: t.created_at, updated_at: t.updated_at, finished_at: t.finished_at,
})

function enqueueTask(t) {
  const id = String(t.id)
  if (taskQueued.has(id)) return
  taskQueued.add(id)
  withLock(`task:${t.agent_id}`, () => { taskQueued.delete(id); return runTask(id) })
    .catch(e => console.error(`[task #${id}]`, e))
}

/** Something happened to a task: a card in its conversation, and — for news — a turn for the front thread. */
async function taskEvent(t, kind, text = '', extra = {}) {
  const agent = (await db.getAgent(t.agent_id))?.name ?? t.agent_id
  await db.addEvent(t.scope, t.scope_id, t.session_id, agent,
    { task: Number(t.id), kind, agent, agent_id: t.agent_id, title: t.title, text: clipText(text, RESULT_MAX), ...extra })
  if (wakes(kind)) wakeFront(t)
  // What only the person can unblock is worth a notification of its own; a task finishing is told by
  // the front thread's reply (the wake-up), which notifies like any reply.
  if (kind === 'asked' || kind === 'approval') {
    const conv = t.scope === 'group'
      ? { kind: 'group', id: t.scope_id, name: (await db.listGroups()).find(g => g.id === t.scope_id)?.name ?? t.scope_id }
      : { kind: 'agent', id: t.scope_id, name: agent }
    notify({ kind, conv, session: t.session_id, agent, task: Number(t.id), text })
  }
}

/**
 * Stop a task. Whichever lands first — this or the runner finishing — wins; the other changes nothing.
 * `quiet`: no card (the conversation it would go into is being deleted).
 */
async function stopTask(t, by = '', { quiet = false } = {}) {
  if (!await db.updateTask(t.id, { status: 'stopped', approval: null, finished_at: new Date() }, { from: OPEN })) return false
  taskAborts.get(String(t.id))?.abort()
  if (!quiet) await taskEvent(t, 'stopped', '', by ? { by } : {})
  return true
}

/** The person's answer to a task's question: it queues again and carries on from where it asked. */
async function resumeTask(t, answer) {
  if (!await db.updateTask(t.id, { status: 'queued', question: '', pending: answer }, { from: ['waiting'] })) return false
  enqueueTask(t)
  return true
}

async function taskWaitsForApproval(t, approval) {
  await db.updateTask(t.id, { status: 'waiting', approval }, { from: ['running'] })
  await taskEvent(t, 'approval', toolSubject(approval.name, approval.args), { approval: approval.id })
}

/** A task's model conversation as stored: no system prompt (rebuilt every run), no screenshots. */
const forStorage = messages => messages.slice(1).map(({ images, ...m }) =>
  images ? { ...m, content: `${m.content ?? ''}\n(a screenshot was here)` } : m)

async function runTask(id) {
  const t = await db.getTask(id, { full: true })
  if (!t || t.status !== 'queued') return
  const ac = new AbortController()
  taskAborts.set(id, ac)
  try {
    const all = await loadBots()
    const bot = all.find(b => b.id === t.agent_id)
    if (!bot) throw new Say('err.noAgent')
    const groupId = t.scope === 'group' ? t.scope_id : null
    const p = await providerFor(bot)
    const byName = t.by_agent && t.by_agent !== bot.id ? all.find(b => b.id === t.by_agent)?.name ?? '' : ''
    const convo = Array.isArray(t.transcript) && t.transcript.length ? t.transcript : [{ role: 'user', content: taskOpening(t, byName) }]
    if (t.pending) convo.push({ role: 'user', content: `[The user's answer] ${t.pending}` })
    if (!await db.updateTask(id, { status: 'running', pending: null, transcript: convo }, { from: ['queued'] })) return
    const container = CFG.tools ? await ensureContainer(bot.id, groupId) : null
    const system = systemFor(bot, {
      own: await db.getMemory('agent', bot.id), self: await db.getSelfMemory(bot.id),
      group: groupId ? await db.getMemory('group', groupId) : '',
    }, { box: CFG.tools ? '/work' : null, skills: await db.skillsFor(bot.id), groupId, task: t, byName,
      secrets: await db.listSecrets(bot.id) })
    const policy = await approvalPolicy()
    // Always the auto limits: a background task has nobody to push it along by definition.
    const ctx = { container, signal: ac.signal, bot, lang: 'en', scope: t.scope, scopeId: t.scope_id, session: t.session_id,
      task: t, specs: specsFor({ task: true }), autonomy: 'auto', approval: { ...policy, mode: bot.approval || policy.mode },
      onStep: messages => db.updateTask(id, { transcript: forStorage(messages) }) }
    const text = await runAgent(p, [{ role: 'system', content: system }, ...convo], null, null, ctx)
    if (ctx.question) {
      if (await db.updateTask(id, { status: 'waiting', question: ctx.question }, { from: ['running', 'waiting'] }))
        await taskEvent(t, 'asked', ctx.question)
    } else {
      // Ended without finish_task: what it said last is the report. Files it sent go with the report.
      const result = ctx.result ?? clipText(text || '(finished without a report)', RESULT_MAX)
      if (await db.updateTask(id, { status: 'done', result, approval: null, finished_at: new Date() }, { from: ['running', 'waiting'] }))
        await taskEvent(t, 'done', result, ctx.sent?.length ? { files: ctx.sent } : {})
    }
  } catch (e) {
    if (ac.signal.aborted) return     // stopped: stopTask already wrote the status and the card
    const message = errorText(e, 'en').slice(0, 500)
    if (await db.updateTask(id, { status: 'failed', result: message, approval: null, finished_at: new Date() }, { from: OPEN }))
      await taskEvent(t, 'failed', message)
  } finally {
    taskAborts.delete(id)
  }
}

/**
 * A turn nobody is streaming, for messages already stored in `session` and not answered yet (an
 * interjection that came just too late for the turn it was meant for). Shows up as a run, with Stop.
 */
function followUp(bots, groupId, providers, session) {
  const run = newRun()
  run.detached = true
  converse(bots, groupId, providers, null,
    (ev, d) => { if (ev === 'error') console.warn(`[interject] follow-up turn in ${session} failed: ${d.message}`) },
    new AbortController(), 'en', { session, run })
    .catch(e => console.warn(`[interject] follow-up turn in ${session}: ${errorText(e, 'en')}`))
}

// A session's front thread waking up to tell the person what a task reported. Several pieces of news
// arriving while it is busy make one wake-up, not several: the flag clears when the turn actually starts.
const wakeQueued = new Set()
async function wakeFront(t) {
  const session = t.session_id
  if (!session || wakeQueued.has(session)) return
  wakeQueued.add(session)
  let started = false
  try {
    const { bots, groupId } = await resolveTarget(t.scope === 'group' ? 'group' : 'agent', t.scope_id)
    const providers = new Map()
    for (const b of bots) providers.set(b.id, await providerFor(b))
    // Nobody is necessarily watching: like a page that was closed. The run shows up as "working", with Stop.
    const run = newRun()
    run.detached = true
    await converse(bots, groupId, providers, null,
      (ev, d) => { if (ev === 'error') console.warn(`[task] waking the front of ${t.scope}:${t.scope_id} failed: ${d.message}`) },
      new AbortController(), 'en',
      { session, run, wake: { speaker: t.by_agent, started: () => { started = true; wakeQueued.delete(session) } } })
  } catch (e) {
    console.warn(`[task] could not wake ${t.scope}:${t.scope_id}: ${errorText(e, 'en')}`)
  } finally {
    if (!started) wakeQueued.delete(session)
  }
}

/** The task tools: the front thread's four, and the two a task reports with. */
async function runTaskTool(name, args, ctx) {
  if (name === 'ask_user') {
    const question = String(args.question ?? '').trim()
    if (!question) return 'The question was empty; nothing was sent.'
    ctx.question = clipText(question, QUESTION_MAX)
    ctx.halt = true
    return 'Question sent to the user. Your work pauses here; their answer will come back as the next message.'
  }
  if (name === 'finish_task') {
    ctx.result = clipText(String(args.result ?? '').trim() || '(no report)', RESULT_MAX)
    ctx.halt = true
    return 'Reported. The task is done.'
  }
  const { nameOf } = await openTasksIn(ctx.scope, ctx.scopeId, ctx.session)
  if (name === 'list_tasks') {
    const rows = (await db.listTasks(ctx.scope, ctx.scopeId, 20)).filter(t => t.session_id === ctx.session)
    return rows.length ? rows.map(t => taskLine(t, nameOf) +
      (t.status === 'done' || t.status === 'failed' ? `\n  report: ${clipText(t.result, 300)}` : '')).join('\n')
      : 'No tasks in this conversation yet.'
  }
  if (name === 'start_task') return startTaskFrom(ctx, args)
  const t = await db.getTask(args.task)
  if (!t || t.scope !== ctx.scope || t.scope_id !== ctx.scopeId) return `There is no task #${args.task} in this conversation.`
  if (name === 'cancel_task')
    return await stopTask(t, ctx.bot.name) ? `Stopped task #${t.id}.` : `Task #${t.id} is already ${t.status}.`
  if (name === 'answer_task') {
    const answer = String(args.answer ?? '').trim()
    if (!answer) return 'The answer was empty; nothing was sent.'
    if (t.status !== 'waiting') return `Task #${t.id} isn't waiting for an answer (it is ${t.status}).`
    if (t.approval) return `Task #${t.id} is waiting for the user to approve a command — only they can, on the card in this conversation.`
    return await resumeTask(t, answer) ? `Passed on to task #${t.id}; it carries on from here.`
      : `Task #${t.id} moved on in the meantime; nothing was sent.`
  }
  return `Unknown tool ${name}`
}

async function startTaskFrom(ctx, args) {
  const input = checkTaskInput(args)
  if (typeof input === 'string') return `Not started: ${input}.`
  const who = ctx.peers?.length ? pickAssignee(args.agent, ctx.bot, ctx.peers) : ctx.bot
  if (!who) return `Not started: nobody in this group is called "${args.agent}". Members: ${[ctx.bot, ...ctx.peers].map(b => b.name).join(', ')}.`
  if (await db.openTaskCount(ctx.scope, ctx.scopeId) >= MAX_OPEN_PER_CONVERSATION)
    return `Not started: ${MAX_OPEN_PER_CONVERSATION} tasks are already open in this conversation. Wait for one to report back, or cancel one.`
  if (await db.sessionTaskCount(ctx.session) >= MAX_PER_SESSION)
    return `Not started: this session has already started ${MAX_PER_SESSION} tasks, which looks like a loop. Tell the user where things stand instead.`
  const ahead = (await db.tasksWithStatus(['queued', 'running'])).filter(x => x.agent_id === who.id).length
  const t = await db.createTask({ scope: ctx.scope, scope_id: ctx.scopeId, session_id: ctx.session,
    agent_id: who.id, by_agent: ctx.bot.id, ...input })
  ctx.dispatched = true
  enqueueTask(t)
  const self = who.id === ctx.bot.id
  return `Started task #${t.id}${self ? '' : ` for ${who.name}`}: "${t.title}"` +
    (ahead ? ` — queued behind ${ahead} other task${ahead > 1 ? 's' : ''} of ${self ? 'yours' : 'theirs'}` : '') +
    '. It reports back here when it is done or needs something; don\'t wait for it.'
}

/**
 * After a restart: a task that was running carries on from its last saved step, and one that was
 * waiting for an approval learns it was not run (that card's answer lived in memory). Queued ones queue.
 */
/**
 * After a restart: a conversation turn that was at work carries on from its last saved step, as a run
 * nobody is streaming (it shows as "still working", with Stop). One whose agent or group is gone is dropped.
 */
async function recoverFrontRuns() {
  for (const row of await db.listFrontRuns()) {
    try {
      const { bots, groupId } = await resolveTarget(row.scope === 'group' ? 'group' : 'agent', row.scope_id)
      const providers = new Map()
      for (const b of bots) providers.set(b.id, await providerFor(b))
      const run = newRun()
      run.detached = true
      console.log(`Carrying on with the turn in session ${row.session_id} after the restart`)
      converse(bots, groupId, providers, null,
        (ev, d) => { if (ev === 'error') console.warn(`[resume] ${row.session_id}: ${d.message}`) },
        new AbortController(), 'en', { session: row.session_id, run, resume: row })
        .catch(e => console.warn(`[resume] ${row.session_id}: ${errorText(e, 'en')}`))
    } catch (e) {
      console.warn(`[resume] dropping the turn in ${row.session_id}: ${errorText(e, 'en')}`)
      await db.dropFrontRun(row.session_id)
    }
  }
}

async function recoverTasks() {
  let n = 0
  for (const t of await db.tasksWithStatus(OPEN)) {
    if (t.status === 'running' || (t.status === 'waiting' && t.approval)) {
      const full = await db.getTask(t.id, { full: true })
      const why = t.status === 'running' ? 'while this task was running'
        : `while this task was waiting for approval of: ${toolSubject(t.approval.name, t.approval.args ?? {})} — that was not run`
      await db.updateTask(t.id, { status: 'queued', approval: null, transcript: [...full.transcript ?? [],
        { role: 'user', content: `[Platform] The server restarted ${why}. Check where things stand before redoing anything.` }] })
      t.status = 'queued'
    }
    if (t.status === 'queued') { enqueueTask(t); n++ }
  }
  if (n) console.log(`Picked up ${n} background task(s) after the restart`)
}

// ---------- Runs ----------
// A message being worked on, by session. In auto mode a run outlives the page that started it —
// the point of auto mode is that nobody has to sit and watch — so it has to be findable (which
// conversations are still working) and stoppable from anywhere, not just by closing a tab.
const runs = new Map()

/**
 * detached: the page that started it is gone. asking: approval cards open right now.
 * inbox: messages sent to the session while this turn works — fed into it at its next step.
 */
function newRun() { return { detached: false, asking: new Set(), inbox: [] } }

/** The page is gone. Cards still waiting can't be answered by anyone, so they are refused now. */
function detachRun(run) {
  run.detached = true
  for (const id of [...run.asking]) { pendingApprovals.get(id)?.(false); pendingSecrets.get(id)?.resolve('declined') }
}

/** What a client needs to show "still working" and a Stop button. */
const runView = r => ({ session: r.session, kind: r.scope === 'dm' ? 'agent' : 'group', id: r.scopeId,
  speaker: r.speaker ?? '', started_at: r.startedAt, detached: r.detached })

/** Whether a new message to these agents would run in auto mode — decided before the stream opens. */
async function runsAuto(bots, groupId) {
  const platform = await db.defaultAutonomy()
  let who = bots[0]
  if (groupId) {
    const g = (await db.listGroups()).find(x => x.id === groupId)
    who = bots.find(b => b.id === g?.lead) ?? bots[0]
  }
  return resolveAutonomy(who?.autonomy, platform) === 'auto'
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
    // A session of its own, named after the task: its runs line up together instead of landing in
    // the middle of whatever the person was talking about. Recreated if someone deleted it.
    const scope = groupId ? 'group' : 'dm', scopeId = groupId ?? bots[0].id
    let session = r.session_id ? await db.getSession(r.session_id) : null
    if (!session || session.scope !== scope || session.scope_id !== scopeId) {
      session = await db.createSession(scope, scopeId, r.name)
      await db.setRoutineSession(r.id, session.id)
    }
    await converse(bots, groupId, providers, text,
      (ev, d) => { if (ev === 'error' && !error) { error = d.message; capped = d.capped === true } },
      new AbortController(), 'en', { unattended: true, session: session.id })
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

// What the upstream's /models says about a model — its context window, and its price when it lists
// one. A property of the model, and the model follows the agent, so per (upstream, model). Answers
// are kept an hour; "it said nothing" ten minutes, so a fixed upstream is asked again soon but a
// silent one isn't asked on every turn.
const infoCache = new Map()
const infoKey = (base, model) => `${base.id}|${base.base_url}|${model}`
async function infoFor(base, model) {
  const key = infoKey(base, model)
  const hit = infoCache.get(key)
  if (hit && hit.until > Date.now()) return hit.info
  const info = await modelInfo({ ...base, model })
  infoCache.set(key, { info, until: Date.now() + (info.tokens || info.price ? 3600_000 : 600_000) })
  return info
}
/** Only what is already known — for the usage panel, polled every 15 s, which must not wait on an upstream. */
function infoKnown(base, model) {
  const hit = infoCache.get(infoKey(base, model))
  if (!hit || hit.until <= Date.now()) infoFor(base, model).catch(() => {})
  return hit?.info ?? null
}

async function contextFor(base, model) {
  if (!base.auto_context) return base.context_tokens
  return (await infoFor(base, model)).tokens ?? guessContext(model) ?? 128_000
}

/**
 * The price a call is charged at: what the upstream's /models lists for this model, else the prices
 * typed on the upstream, else none. A listed price wins because it is per model — one price typed on
 * an upstream with several models is right for one of them at best. Nothing is ever built in.
 */
function priceFor(base, info) {
  if (info?.price) return { price_in_micro: info.price.in, price_out_micro: info.price.out, price_source: 'upstream' }
  return { price_source: db.isPriced(base) ? 'manual' : '' }
}

/** Which upstream and model this agent uses. Without its own upstream it follows the default; the model must be its own choice. */
async function providerFor(bot, choice = bot) {
  const base = choice.provider_id ? await db.getProvider(choice.provider_id) : await requireProvider()
  if (!base) throw new Say('provider.gone', { name: bot.name })
  if (!choice.model) throw new Say('provider.noModel', { name: bot.name })
  // An agent's own effort wins; empty means "whatever the platform says", and the
  // platform's own empty means send nothing — what every model got before this existed.
  const effort = normEffort(bot.effort) || normEffort(await db.defaultEffort())
  const context_tokens = await contextFor(base, choice.model)
  return { ...base, model: choice.model, effort, context_tokens, ...priceFor(base, await infoFor(base, choice.model)) }
}

const MAX_FALLBACKS = 3
// How long to wait before each try of one model call. MODEL_RETRY_WAITS exists for the tests, which
// can't sit through eight seconds of backoff per failing call.
const RETRY_WAITS = (env.MODEL_RETRY_WAITS ?? '0,2000,6000').split(',').map(Number).filter(n => n >= 0)

/** The agent's backup models, resolved, in order. One whose upstream has since gone is skipped, with a line in the log. */
async function fallbacksFor(bot) {
  const out = []
  for (const f of bot.fallbacks ?? []) {
    try { out.push(await providerFor(bot, f)) }
    catch (e) { console.warn(`[fallback] ${bot.name}: skipping ${f.model} — ${errorText(e, 'en')}`) }
  }
  return out
}

/**
 * Worth trying a backup model for: the upstream is down, overloaded, refusing this key or this
 * model, or answered nothing. Not a request it rejected as malformed or too big (400 / 413 / 422) —
 * the backup would get the same request. Not our own refusals either (the daily cap).
 */
function worthFallingBack(e) {
  if (e?.capped) return false
  if (isUpstreamError(e)) return ![400, 413, 422].includes(upstreamStatus(e))
  // fetch itself failing: connection refused, DNS, TLS, reset
  return e?.name === 'TypeError' && /fetch failed/i.test(String(e.message))
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

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }

// Compared as hashes of equal length, so the time taken says nothing about how much of a guess was right.
const digest = v => createHash('sha256').update(String(v)).digest()
const sameToken = v => v != null && timingSafeEqual(digest(v), digest(CFG.token))
const cookieToken = req => {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === 'ma_token') return decodeURIComponent(part.slice(i + 1).trim())
  }
  return null
}
function authed(req, url) {
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
const str = v => (typeof v === 'string' ? v : '')

/** Agent field validation. On PATCH only the fields sent are checked. */
async function checkAgent(b, selfId = null, cur = null) {
  const out = {}
  if (b.name !== undefined || !selfId) {
    const name = str(b.name).trim()
    if (!name) throw new Say('agent.nameEmpty')
    if (name.length > 40) throw new Say('agent.nameLong')
    // Group logs identify people by name: duplicate names make two agents take each other's words as their own,
    // and one named like the user marker (or "User", as the model sees it) would take the human's words as its own
    if (name.toLowerCase() === USER_SPEAKER.toLowerCase()) throw new Say('agent.nameReserved', { name })
    const clash = (await db.listAgents()).find(a => a.id !== selfId && a.name.toLowerCase() === name.toLowerCase())
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
  // '' = follow the platform setting; see AUTONOMY_MODES.
  if (b.autonomy !== undefined) {
    const a = str(b.autonomy).trim()
    if (a && !normAutonomy(a)) throw new Say('agent.autonomy', { list: AUTONOMY_MODES.join(' / ') })
    out.autonomy = a
  }
  if (b.model !== undefined || !selfId) {
    const model = str(b.model).trim()
    if (!model) throw new Say('agent.modelRequired')
    if (model.length > 200) throw new Say('agent.modelLong')
    out.model = model
  }
  // Backup models: the person's own picks from their own upstreams, tried in order. Not the main
  // model again — "falling back" to the thing that just failed would only fail twice.
  if (b.fallbacks !== undefined) {
    const bad = new Say('agent.fallbacks', { max: MAX_FALLBACKS })
    if (!Array.isArray(b.fallbacks) || b.fallbacks.length > MAX_FALLBACKS) throw bad
    const main = `${out.provider_id ?? cur?.provider_id ?? ''}|${out.model ?? cur?.model ?? ''}`
    const seen = new Set([main])
    out.fallbacks = []
    for (const f of b.fallbacks) {
      const provider_id = str(f?.provider_id).trim(), model = str(f?.model).trim()
      if (!model || model.length > 200 || seen.has(`${provider_id}|${model}`)) throw bad
      if (provider_id && !await db.getProvider(provider_id)) throw new Say('err.noProvider')
      seen.add(`${provider_id}|${model}`)
      out.fallbacks.push({ provider_id, model })
    }
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
    out.members = members
  }
  // The lead must be in the group. If members changed and the lead was removed, fall back to "not set"
  const members = out.members ?? cur?.members ?? []
  if (b.lead !== undefined) {
    const lead = str(b.lead).trim()
    if (lead && !members.includes(lead)) throw new Say('group.leadNotMember')
    out.lead = lead || null
  } else if (cur?.lead && !members.includes(cur.lead)) out.lead = null
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
  if (!authed(req, url)) return send(401, t('auth.needToken'), 'text/plain; charset=utf-8')
  // HttpOnly: no script on the page can read it. Lax, not Strict: Strict would drop it when the page is
  // opened from a link in another app, and every write here is a POST/PUT/PATCH/DELETE, which Lax
  // already keeps from other sites. Secure when a TLS proxy in front says the request was https.
  if (CFG.token && sameToken(url.searchParams.get('k'))) {
    const https = req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted
    res.setHeader('set-cookie', `ma_token=${encodeURIComponent(CFG.token)}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax${https ? '; Secure' : ''}`)
  }

  try {
    if (url.pathname === '/api/conversations') return send(200, await listConversations(lang))

    // Direct chat history: the frontend wants {role, content, at}. ?session= picks one; without it,
    // the most recent (what an old client, which knows nothing of sessions, would expect to see).
    const dm = url.pathname.match(/^\/api\/dm\/([a-z0-9-]+)$/)
    if (dm && req.method === 'GET')
      return send(200, (await historyOf('dm', dm[1], url.searchParams.get('session')))
        .map(m => transcriptRow(m, { content: m.content })))

    // Sessions of one conversation: ?kind=agent|group&id=
    if (url.pathname === '/api/sessions' && req.method === 'GET') {
      const kind = url.searchParams.get('kind'), id = url.searchParams.get('id') ?? ''
      return send(200, await db.listSessions(scopeOf(kind), id))
    }
    const sm = url.pathname.match(/^\/api\/sessions\/([\w-]+)$/)
    if (sm) {
      const s = await db.getSession(sm[1])
      if (!s) return send(404, { error: t('session.none') })
      if (req.method === 'PATCH') {
        const title = str((await readBody(req)).title).replace(/\s+/g, ' ').trim()
        if (title.length > 80) return send(400, { error: t('session.titleLong') })
        await db.renameSession(s.id, title)
        return send(200, { ok: true })
      }
      if (req.method === 'DELETE') {
        if (liveSessions.has(s.id)) return send(409, { error: t('session.busy') })
        // Its tasks go with it; stop the ones still going first, or they'd report into a session that's gone.
        for (const x of await db.listTasks(s.scope, s.scope_id, 1000))
          if (x.session_id === s.id && isOpen(x)) await stopTask(x, '', { quiet: true })
        await dropBlobs(await db.deleteSession(s.id))
        frontRead.delete(s.id)
        return send(200, { ok: true })
      }
    }

    // Search what was said: ?q= plus ?kind=&id= for one conversation (all its sessions), or everywhere
    if (url.pathname === '/api/search' && req.method === 'GET') {
      const text = (url.searchParams.get('q') ?? '').trim()
      if (!text) return send(200, [])
      const kind = url.searchParams.get('kind'), id = url.searchParams.get('id')
      const rows = await db.searchMessages(text.slice(0, 200), kind ? { scope: scopeOf(kind), scopeId: id } : {})
      return send(200, rows.map(r => ({
        id: Number(r.id), session: r.session_id, kind: r.scope === 'group' ? 'group' : 'agent', conv: r.scope_id,
        role: r.role, speaker: r.speaker === USER_SPEAKER ? '' : r.speaker, at: r.at,
        snippet: snippetAround(r.content, text),
      })))
    }

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
      await db.upsertAgent({ description: '', provider_id: '', model: '', effort: '', approval: '', ...checked, id: slug, ord: n + 1, color: db.nextColor(n) })
      return send(200, { id: slug })
    }

    const bm = url.pathname.match(/^\/api\/bots\/([a-z0-9-]+)$/)
    if (bm && req.method === 'PATCH') {
      const cur = await db.getAgent(bm[1])
      if (!cur) return send(404, { error: t('err.noAgent') })
      const patch = await checkAgent(await readBody(req), cur.id, cur)
      await db.upsertAgent({ ...cur, ...patch })
      // Group logs identify people by name. Without syncing a rename, what he said in groups would become "someone else's"
      if (patch.name && patch.name !== cur.name) await db.renameSpeaker(cur.name, patch.name)
      return send(200, { ok: true })
    }
    if (bm && req.method === 'DELETE') {
      if (!await db.getAgent(bm[1])) return send(404, { error: t('err.noAgent') })
      for (const x of await db.tasksWithStatus(OPEN))
        if (x.agent_id === bm[1] || (x.scope === 'dm' && x.scope_id === bm[1])) await stopTask(x, '', { quiet: true })
      await dropBlobs(await db.deleteAgent(bm[1]))
      await dropAllowances(r => r.agent === bm[1])
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
      const c = cname(bw[1])
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
        const base = (a.provider_id ? providers.find(x => x.id === a.provider_id) : def) ?? null
        const p = base && { ...base, ...priceFor(base, a.model ? infoKnown(base, a.model) : null) }
        const u = byId.get(a.id)
        return { id: a.id, name: a.name,
          day: u?.day ?? zero, month: u?.month ?? zero,
          // The cap actually in force, and whether it can be enforced at all.
          cap_micro: a.daily_cap_micro != null ? Number(a.daily_cap_micro) : (fallback == null ? null : Number(fallback)),
          own_cap: a.daily_cap_micro != null,
          priced: db.isPriced(p),
          // Where the price comes from ('upstream': its model list, 'manual': typed on the upstream) and what it is.
          price_source: p?.price_source ?? '',
          price_in_micro: db.isPriced(p) ? Number(p.price_in_micro) : null,
          price_out_micro: db.isPriced(p) ? Number(p.price_out_micro) : null }
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

    // The platform-wide autonomy, for every agent that has none of its own. Never set = auto.
    if (url.pathname === '/api/settings/autonomy' && req.method === 'GET')
      return send(200, { autonomy: resolveAutonomy('', await db.defaultAutonomy()), modes: AUTONOMY_MODES })

    if (url.pathname === '/api/settings/autonomy' && req.method === 'PUT') {
      const m = str((await readBody(req)).autonomy).trim()
      if (!normAutonomy(m)) return send(400, { error: t('agent.autonomy', { list: AUTONOMY_MODES.join(' / ') }) })
      await db.setDefaultAutonomy(m)
      return send(200, { autonomy: m })
    }

    // ---- Runs: what is still being worked on, and stopping it ----
    if (url.pathname === '/api/runs' && req.method === 'GET') return send(200, [...runs.values()].map(runView))

    if (url.pathname === '/api/runs/stop' && req.method === 'POST') {
      // By session, or every run in one conversation ({kind, id}) — the Stop button knows the conversation for sure.
      const b = await readBody(req)
      const scope = b.kind === 'group' ? 'group' : 'dm'
      // Messages still waiting behind the one running go too: Stop means stop, not "next".
      const hit = [...runs.values(), ...waitingRuns].filter(r => b.session ? r.session === str(b.session) : r.scope === scope && r.scopeId === str(b.id))
      if (!hit.length) return send(404, { error: t('run.none') })
      for (const r of hit) r.abort()
      return send(200, { stopped: hit.length })
    }

    // ---- Files ----
    // Upload: the raw bytes as the body, ?kind=agent|group&id=<conversation>&name=<file name>. No
    // multipart to parse; the content-type header is the type, and the extension decides when it says nothing.
    if (url.pathname === '/api/files' && req.method === 'POST') {
      const kind = url.searchParams.get('kind'), id = url.searchParams.get('id') ?? ''
      const conv = kind === 'group' ? (await db.listGroups()).find(g => g.id === id) : await db.getAgent(id)
      if (!conv) return send(404, { error: t(kind === 'group' ? 'err.noGroup' : 'err.noAgent') })
      const row = await storeUpload(req, scopeOf(kind), id, url.searchParams.get('name') ?? '', req.headers['content-type'])
      return send(200, fileView(row))
    }
    const fm = url.pathname.match(/^\/api\/files\/([\w-]+)$/)
    if (fm) {
      const f = await db.getFile(fm[1])
      if (!f) return send(404, { error: t('file.none') })
      // Taking back an upload before sending it. A sent file goes with its session, not on its own.
      if (req.method === 'DELETE') {
        if (f.session_id) return send(409, { error: t('file.sent') })
        await dropBlobs(await db.dropUpload(f.id))
        return send(200, { ok: true })
      }
      if (req.method === 'GET' || req.method === 'HEAD') return serveFile(req, res, f, url.searchParams.get('download') === '1')
    }

    // ---- Notifications ----
    // The feed: SSE, every notice as `event: notice` with its id. Reconnecting with Last-Event-ID (or
    // ?after=) replays what was missed. A comment line every 25s keeps proxies and phones from
    // taking the quiet connection for a dead one.
    if (url.pathname === '/api/notifications/stream' && req.method === 'GET') {
      const after = Number(req.headers['last-event-id'] ?? url.searchParams.get('after') ?? 0) || 0
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' })
      const send = n => { if (!res.destroyed) res.write(`id: ${n.id}\nevent: notice\ndata: ${JSON.stringify(n)}\n\n`) }
      // the newest id first, so a client that missed nothing knows where it stands
      res.write(`event: hello\ndata: ${JSON.stringify({ last: noticeSeq })}\n\n`)
      if (after) for (const n of noticesAfter(after)) send(n)
      noticeSubs.add(send)
      const ping = setInterval(() => { if (!res.destroyed) res.write(': ping\n\n') }, 25_000)
      res.on('close', () => { clearInterval(ping); noticeSubs.delete(send) })
      return
    }
    if (url.pathname === '/api/notifications' && req.method === 'GET')
      return send(200, { last: noticeSeq, notices: noticesAfter(Number(url.searchParams.get('after')) || 0) })

    // ---- Background tasks ----
    // A conversation's tasks, newest first: ?kind=agent|group&id=
    if (url.pathname === '/api/tasks' && req.method === 'GET') {
      const kind = url.searchParams.get('kind'), id = url.searchParams.get('id') ?? ''
      return send(200, (await db.listTasks(scopeOf(kind), id, 100)).map(taskView))
    }
    const tk = url.pathname.match(/^\/api\/tasks\/(\d+)(?:\/(answer|stop))?$/)
    if (tk) {
      const task = await db.getTask(tk[1])
      if (!task) return send(404, { error: t('task.none') })
      // One task with what it ran, for the expanded card.
      if (!tk[2] && req.method === 'GET') return send(200, { ...taskView(task), trace: task.trace ?? [] })
      if (tk[2] === 'stop' && req.method === 'POST')
        return await stopTask(task) ? send(200, { ok: true }) : send(409, { error: t('task.notOpen') })
      // The person answering a task's question straight from its card. The answer goes to the task only:
      // the card in the conversation says it was answered, not what — it may be a password.
      if (tk[2] === 'answer' && req.method === 'POST') {
        const text = str((await readBody(req)).text).trim()
        if (!text) return send(400, { error: t('task.answerEmpty') })
        if (task.status !== 'waiting' || task.approval || !await resumeTask(task, text))
          return send(409, { error: t('task.notAsking') })
        await taskEvent(task, 'answered')
        return send(200, { ok: true })
      }
    }

    // ---- Secrets: an agent's, by name; the value goes in and never comes out ----
    const sx = url.pathname.match(/^\/api\/bots\/([a-z0-9-]+)\/secrets(?:\/([\w-]+))?$/)
    if (sx) {
      if (!await db.getAgent(sx[1])) return send(404, { error: t('err.noAgent') })
      if (!sx[2] && req.method === 'GET') return send(200, await db.listSecrets(sx[1]))
      if (!sx[2] && req.method === 'POST') {
        const s = checkSecret(await readBody(req))
        if (s.need) return send(400, { error: t(`secret.need.${s.need}`) })
        return send(200, await storeSecret(sx[1], s))
      }
      if (sx[2] && req.method === 'DELETE')
        return await db.deleteSecret(sx[1], sx[2]) ? send(200, { ok: true }) : send(404, { error: t('secret.none') })
    }
    // Answering an agent's request_secret card: the value (stored, never shown to anyone), or no.
    const sr = url.pathname.match(/^\/api\/secrets\/requests\/([\w-]+)$/)
    if (sr && req.method === 'POST') {
      const p = pendingSecrets.get(sr[1])
      if (!p) return send(404, { error: t('approval.gone') })
      const b = await readBody(req)
      if (b.decline === true) { p.resolve('declined'); return send(200, { ok: true }) }
      // What it is for and where it may go are the agent's request, shown on the card; the person only types the value.
      const s = checkSecret({ ...p.spec, value: b.value })
      if (s.need) return send(400, { error: t(`secret.need.${s.need}`) })
      await storeSecret(p.agent, s)
      p.resolve('saved')
      return send(200, { ok: true })
    }

    // ---- Approvals ----
    // The platform default, and the pattern list "match" uses.
    if (url.pathname === '/api/approvals/policy' && req.method === 'GET') {
      const names = new Map((await db.listAgents()).map(a => [a.id, a.name]))
      const allow = (await allowList()).map(r => ({ ...r, agent_name: names.get(r.agent) ?? r.agent }))
      return send(200, { ...await approvalPolicy(), modes: APPROVAL_MODES, seeded: RISKY, allow })
    }
    // Taking back one "always allow".
    const al = url.pathname.match(/^\/api\/approvals\/allow\/([\w-]+)$/)
    if (al && req.method === 'DELETE') {
      if (!(await allowList()).some(r => r.id === al[1])) return send(404, { error: t('approval.noAllowance') })
      await dropAllowances(r => r.id === al[1])
      return send(200, { ok: true })
    }

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
      const b = await readBody(req)
      await answer(b.ok === true, b.ok === true && b.always === true)
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
      const { target, botIds = [], text = '', session = null, files: fileIds = [], interject = false } = await readBody(req)
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
      // Attachments must be this conversation's own uploads, not sent before. A message may be only files.
      const ids = Array.isArray(fileIds) ? [...new Set(fileIds.map(String))].slice(0, 20) : []
      if (bots?.length && ids.length) {
        const scope = groupId || bots.length > 1 ? 'group' : 'dm', scopeId = groupId ?? (bots.length > 1 ? 'main' : bots[0].id)
        const rows = await db.getFiles(ids)
        if (rows.length !== ids.length || rows.some(f => f.scope !== scope || f.scope_id !== scopeId || f.session_id))
          return send(400, { error: t('file.notYours') })
      }
      if (!bots?.length || (!str(text).trim() && !ids.length)) return send(400, { error: t('chat.needTarget') })

      // Resolve everyone's upstream first: if one is missing, say so before opening the stream, not halfway through a group relay
      const providers = new Map()
      try { for (const b of bots) providers.set(b.id, await providerFor(b)) }
      catch (e) { return send(400, { error: errorText(e, lang) }) }

      // A second message to a session still working on the first waits its turn inside converse.
      const want = str(session) || null
      const auto = await runsAuto(bots, groupId)

      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' })
      const emit = (ev, d) => { if (!res.destroyed) res.write(`event: ${ev}\ndata: ${JSON.stringify(d)}\n\n`) }
      // A comment line every so often: long tool runs send nothing for minutes, and proxies (and the
      // client's own silence timer) take a quiet connection for a dead one.
      const ping = setInterval(() => { if (!res.destroyed) res.write(': ping\n\n') }, 25_000)
      // The client closed the page / lost the network. In manual mode that stops the run — a group relay
      // would otherwise keep spending upstream calls with nobody watching. In auto mode nobody watching
      // is the point: the run carries on, and the conversation shows it as still working, with a Stop button.
      const ac = new AbortController()
      const run = newRun()
      res.on('close', () => { if (!res.writableEnded) auto ? detachRun(run) : ac.abort() })

      try {
        await converse(bots, groupId, providers, str(text), emit, ac, lang, { session: want, run, files: ids, interject: interject === true })
      } finally { clearInterval(ping) }
      emit('done', {})
      return res.end()
    }

    // Groups: an entity with a name and members
    if (url.pathname === '/api/groups' && req.method === 'GET') return send(200, await db.listGroups())

    if (url.pathname === '/api/groups' && req.method === 'POST') {
      const { name, members, lead } = await checkGroup(await readBody(req))
      return send(200, await db.saveGroup({ id: `g${Date.now().toString(36)}`, name, members, lead }))
    }

    const gm = url.pathname.match(/^\/api\/groups\/([\w-]+)$/)
    if (gm && req.method === 'PATCH') {          // rename / add or remove members
      const g = (await db.listGroups()).find(x => x.id === gm[1])
      if (!g) return send(404, { error: t('err.noGroup') })
      const patch = await checkGroup(await readBody(req), g)
      const saved = await db.saveGroup({ ...g, ...patch })
      if (patch.members) {
        const gone = g.members.filter(id => !patch.members.includes(id))
        // Someone who left the group stops working for it: their open tasks here are stopped (with a card saying so).
        for (const x of await db.listTasks('group', g.id, 1000))
          if (gone.includes(x.agent_id) && isOpen(x)) await stopTask(x)
        dropContainersOf(gone)
      }
      return send(200, saved)
    }
    if (gm && req.method === 'DELETE') {         // disband; files in the shared drive are left alone
      const g = (await db.listGroups()).find(x => x.id === gm[1])
      for (const x of await db.listTasks('group', gm[1], 1000)) if (isOpen(x)) await stopTask(x, '', { quiet: true })
      await dropBlobs(await db.deleteGroup(gm[1]))
      if (g) dropContainersOf(g.members)
      return send(200, { ok: true })
    }
    // Export / import a conversation's chat history. The format is defined here; an exported file imports back as-is.
    const xm = url.pathname.match(/^\/api\/(export|import)\/(dm|group)\/([\w-]+)$/)
    if (xm) {
      const [, op, scope, id] = xm
      const conv = scope === 'dm' ? await db.getAgent(id) : (await db.listGroups()).find(g => g.id === id)
      if (!conv) return send(404, { error: t(scope === 'dm' ? 'err.noAgent' : 'err.noGroup') })
      if (op === 'export' && req.method === 'GET') {
        // One session — the one asked for, else the most recent. It is what's on screen when someone presses Export.
        const want = url.searchParams.get('session')
        const sess = want ? await db.getSession(want) : await db.latestSession(scope, id)
        if (want && (!sess || sess.scope !== scope || sess.scope_id !== id)) return send(404, { error: t('session.none') })
        const messages = sess ? await db.recent(scope, id, 1_000_000, { session: sess.id, events: false }) : []
        const title = sess ? (await db.listSessions(scope, id)).find(x => x.id === sess.id)?.title ?? '' : ''
        return send(200, { format: 'multi-agent-chat', version: 1, kind: scope === 'dm' ? 'agent' : 'group',
          id, name: conv.name, session: title, exported_at: new Date().toISOString(),
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
        // Always into a session of its own: appending someone else's history to the one on screen
        // would make the model read two unrelated threads as one.
        const title = str(doc.session).trim().slice(0, 80) || t('session.imported', { name: str(doc.name) || conv.name })
        const session = await db.importMessages(scope, id, rows, title)
        return send(200, { imported: rows.length, session })
      }
    }

    const gr = url.pathname.match(/^\/api\/groups\/([\w-]+)\/messages$/)
    if (gr && req.method === 'GET')
      return send(200, (await historyOf('group', gr[1], url.searchParams.get('session')))
        .map(m => transcriptRow(m, { speaker: m.speaker, text: m.content })))

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

// No auth + listening publicly = a (possibly shell-capable) backend exposed on the internet.
// That combination can only be a misconfiguration, so refuse to start rather than print a warning nobody reads.
if (!CFG.token && !['127.0.0.1', 'localhost', '::1'].includes(CFG.host)) {
  console.error(`Refusing to start: BIND_HOST=${CFG.host} listens publicly, but ACCESS_TOKEN is not set.
Set one in .env (./start.sh generates it), or change BIND_HOST back to 127.0.0.1.`)
  process.exit(1)
}

await db.connect()
await db.migrate()
const s = await db.seed(ROOT)
if (s.seeded) console.log(`First start, imported from files: ${s.agents} agents, ${s.groups} groups, ${s.messages} messages`)
if (await db.seedProviderFromEnv(env)) console.log('Created the default upstream from .env (change it later in the UI ⚙)')
{ const n = await db.fillAgentModels(); if (n) console.log(`${n} agent(s) took over the model name from their upstream`) }

await mkdir(join(LOCALWORK, 'agents'), { recursive: true })
await mkdir(join(LOCALWORK, 'groups'), { recursive: true })
await mkdir(FILES_DIR, { recursive: true })
await recoverTasks()
await recoverFrontRuns()

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
  const c = cname(m[1]), pending = []
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
      await ensureContainer(m[1], null)
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
setInterval(() => sweepUploads().catch(e => console.warn('[files] sweep failed:', e.message)), 3_600_000)
sweepUploads().catch(e => console.warn('[files] sweep failed:', e.message))
tickRoutines().catch(e => console.error('Scheduled task dispatch failed', e))

server.listen(CFG.port, CFG.host, () => {
  console.log(`CirrayaBot  http://${CFG.host}:${CFG.port}${CFG.token ? `/?k=${CFG.token}` : ''}`)
  if (!CFG.token) console.log('(ACCESS_TOKEN not set; only listening on 127.0.0.1)')
  if (!CFG.tools) console.log('(AGENT_TOOLS is off; agents can only talk, not act)')
})
