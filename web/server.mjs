// The Multi-Agent web server.
//
// All state lives in PostgreSQL (web/db.mjs); agents work in their own containers (one per agent);
// model upstreams are configured in the UI — several of them, switchable at any time — not hard-coded in .env.
//
// Auth: put ?k=<ACCESS_TOKEN> in the URL once, then a cookie carries it. Without a token we only listen on 127.0.0.1.
import { env, ROOT } from './env.mjs'
import * as db from './db.mjs'
import { fitContext, listModels, probeContext } from './model.mjs'
import { callUpstream, normProtocol, normEffort, EFFORTS, PROTOCOLS } from './protocols.mjs'
import { checkSchedule, nextRun } from './schedule.mjs'
import { checkSkill, parseSkillMd, toSkillMd } from './skill.mjs'
import { addNote, NOTE_MAX_CHARS } from './memory.mjs'
import { langOf, tr, Say, errorText } from './i18n.mjs'
import { createServer } from 'node:http'
import { readFile, mkdir } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'

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
  // Money is micro-dollars everywhere in the API (1 dollar = 1e6); null = no cap of its own.
  daily_cap_micro: r.daily_cap_micro == null ? null : Number(r.daily_cap_micro),
  // How hard this agent's model should think. '' = say nothing, which is what it did before.
  effort: r.effort ?? '',
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

const MAX_HANDOFFS = 5       // max handoffs between agents in one round, so they can't chat forever
const FETCH_MAX = 300        // how many candidate rows to pull from the DB; the real trimming is by context budget

/**
 * The group discussions an agent remembers — every group he's in, not just the current one.
 * Fed to him in direct chats too: a real employee doesn't forget this morning's group chat just because the window changed.
 */
async function groupRecallFor(bot) {
  const groups = (await db.listGroups()).filter(g => g.members.includes(bot.id))
  const chunks = []
  for (const g of groups) {
    const log = await db.recent('group', g.id, 30)
    if (log.length) chunks.push(`[Group: ${g.name}]\n` + log.map(e => `[${modelSpeaker(e.speaker)}] ${e.content}`).join('\n'))
  }
  return chunks.join('\n\n')
}

function systemFor(bot, memory, peers, box, recall, skills = [], lead = null) {
  const parts = [bot.persona]
  parts.push(`

--- Language ---
Reply in the language the user writes in.`)
  if (box) parts.push(`

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
// A container mounts only two directories:
//   /work    ← workspace/agents/<id>   its own desk
//   /groups  ← workspace/groups        every group's shared drive (in group chats /work/group is symlinked there)
// The platform's code and .env aren't in there; it can't reach them.
const CLI = env.CONTAINER_CLI || 'docker'
const IMAGE = env.AGENT_IMAGE || 'multi-agent-worker:1'
const EXEC_TIMEOUT = Number(env.AGENT_EXEC_TIMEOUT || 120) * 1000
const OUT_MAX = 12_000
// Container names are global on the whole host. Two deployments on the same machine that don't change the prefix
// fight over the same ma-agent-chief — the mount check makes each side delete and recreate the other's container.
const PREFIX = env.AGENT_PREFIX || 'ma'
const cname = id => `${PREFIX}-agent-${id}`

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

const containerReady = new Set()

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

/** Run a command in a container. If someone deleted the container from outside, drop the "ready" cache so the next round recreates it. */
async function execIn(c, argv, input) {
  const r = await cliRun(['exec', ...argv], input)
  if (/No such container/i.test(r.err)) containerReady.delete(c)
  return r
}

/** Make sure this agent's container is running, and point /work/group at the current group. */
async function ensureContainer(botId, groupId) {
  await ensureImage()
  const name = cname(botId)
  if (!containerReady.has(name)) {
    const work = join(HOSTWORK, 'agents', botId)
    await mkdir(join(WORKROOT, 'agents', botId), { recursive: true })
    await mkdir(join(WORKROOT, 'groups'), { recursive: true })
    // Also ask where /work is mounted: containers are long-lived, and WORKSPACE_HOST_PATH changes
    // (upgrades, moving the repo, editing compose). A wrongly mounted container looks perfectly fine —
    // commands succeed, ls shows files — but the output lands in a directory nobody looks at.
    // Same shape as 2.14's "symlink still pointing at the previous group", so it must be checked here.
    const { out } = await cliRun(['inspect', '-f',
      '{{.State.Running}} {{.Config.Image}} {{range .Mounts}}{{if eq .Destination "/work"}}{{.Source}}{{end}}{{end}}', name],
      null, 30_000)
    let [state, image, mounted] = out.trim().split(' ')
    if (mounted && mounted !== work) {
      console.log(`${botId}'s container is still mounted on the old path ${mounted}; recreating on ${work} (old files stay where they are)`)
      await cliRun(['rm', '-f', name], null, 60_000)
    } else if (mounted && image !== IMAGE) {
      // The image was upgraded (e.g. a browser was added): old containers don't switch images by themselves.
      // /work is on the host, so recreating only loses what he apt-installed himself
      console.log(`${botId}'s container is still on the old image ${image}; recreating on ${IMAGE} (files in /work are kept)`)
      await cliRun(['rm', '-f', name], null, 60_000)
      mounted = ''
    }
    else if (state === 'true') { /* already running */ }
    else if (state === 'false') await cliRun(['start', name], null, 60_000)
    if (!mounted || mounted !== work) {
      const r = await cliRun(['run', '-d', '--name', name,
        '--memory', env.AGENT_MEMORY || '2g', '--cpus', env.AGENT_CPUS || '2',
        '--pids-limit', '512',
        '-v', `${join(HOSTWORK, 'agents', botId)}:/work`,
        '-v', `${join(HOSTWORK, 'groups')}:/groups`,
        '-w', '/work', IMAGE, 'sleep', 'infinity'], null, 120_000)
      if (r.code !== 0) throw new Say('container.startFailed', { id: botId, detail: (r.err || r.out).slice(0, 300) }, 500)
    }
    containerReady.add(name)
  }
  // The group directory has to really exist on the host first. Group info now lives in the DB, so nobody creates
  // this directory anymore — without it the symlink points nowhere, `cp report.md group/` just fails,
  // and the failure only shows up in some agent's tool output.
  if (groupId) await mkdir(join(WORKROOT, 'groups', groupId), { recursive: true })
  // Reset the group symlink every time — otherwise it keeps pointing at the previous group (CLAUDE.md 2.14)
  await cliRun(['exec', name, 'bash', '-lc',
    groupId ? `rm -f /work/group && ln -s /groups/${groupId} /work/group` : 'rm -f /work/group'],
    null, 30_000)
  return name
}

async function removeContainer(botId) {
  const name = cname(botId)
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
  const c = cname(botId)
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
    const { code, out, err } = await execIn(c, ['-w', '/work', c, 'cat', '--', args.path])
    return code === 0 ? clip(out) : `Could not read: ${(err || '').trim() || `exit ${code}`}`
  }
  if (name === 'write_file') {
    const body = args.content ?? ''
    const { code, err } = await execIn(c,
      ['-i', '-w', '/work', c, 'bash', '-lc', `mkdir -p "$(dirname -- "$1")" && cat > "$1"`, '_', args.path],
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

/** Call the model once. Protocol translation and stream parsing live in protocols.mjs; here we only decide whether to send tools. */
function callModel(p, messages, onDelta, { bare = false, signal } = {}) {
  return callUpstream(p, messages, CFG.tools && !bare ? TOOL_SPECS : null, onDelta, signal)
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
  const MAX_STEPS = 12
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
      try { r = await callModel(p, fit.messages, onDelta, { signal: ctx.signal }); break }
      catch (e) {
        // Rejected with a 4xx while carrying a screenshot: most likely this model doesn't accept images. Drop them and carry on,
        // and stop sending screenshots afterwards — otherwise a model that can't see images fails the whole turn on the browser
        if (isUpstreamError(e) && upstreamStatus(e) >= 400 && upstreamStatus(e) < 500 && dropImages(messages)) {
          ctx.noImages = true
          onTool?.({ phase: 'retry', reason: tr(lang, 'chat.noImages') })
          r = null; break
        }
        if (ctx.signal?.aborted || !isUpstreamError(e) || wait === 6000) throw e
        onTool?.({ phase: 'retry', reason: errorText(e, lang).slice(0, 120) })
      }
    }
    if (!r) { step--; continue }
    const { content, calls, usage } = r
    noteUsage(ctx, p, usage)
    if (content) text = content
    if (!calls.length) return text

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
      const res = await runTool(c.name, args, ctx).catch(e => `Tool error: ${errorText(e, 'en')}`)
      const out = typeof res === 'string' ? res : res.text
      if (res?.image) shot = res.image
      // Send the screenshot to the UI too: people need to see what the agent saw. Only through this stream, never stored
      onTool?.({ phase: 'done', name: c.name, args, output: out, ...res?.image ? { image: res.image } : {} })
      messages.push({ role: 'tool', tool_call_id: c.id, content: out })
    }
    // A screenshot can't go into a tool result (Chat protocol tool messages only take text), so it follows as a user message.
    // Keep only the newest one: ten screenshots in a turn would each be paid for at every step, and the old ones are useless
    if (shot) {
      dropImages(messages, '(a screenshot was here; it has been replaced by a newer one)')
      messages.push({ role: 'user', content: '(this is the page captured by the browser screenshot just now)', images: [shot] })
    }
  }
  return text || '(hit the tool-use limit; stopping here for now)'
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
function askSolo(p, bot, text, memory, onDelta, onTool, signal, lang) {
  return withAgent(bot.id, async () => {
    const prior = (await db.recent('dm', bot.id, FETCH_MAX))
      .map(m => ({ role: m.role, content: m.content }))
    // Store first, then start the container: if the container won't start, what the user said shouldn't vanish with it
    await db.addMessage('dm', bot.id, { role: 'user', speaker: USER_SPEAKER, content: text })
    // With tools off there's no use for a container — and don't tell the persona it "has its own machine"
    const container = CFG.tools ? await ensureContainer(bot.id, null) : null
    const full = await runAgent(p,
      [{ role: 'system', content: systemFor(bot, memory, null, CFG.tools ? '/work' : null, await groupRecallFor(bot), await db.skillsFor(bot.id)) },
       ...prior, { role: 'user', content: text }],
      onDelta, onTool, { container, signal, bot, lang, scope: 'dm', scopeId: bot.id })
    await db.addMessage('dm', bot.id, { role: 'assistant', speaker: bot.name, content: full })
    return full
  })
}

// One person speaking once in a group chat: he sees the WHOLE group log, with other people's words prefixed by name
function askInGroup(p, bot, peers, lead, memory, onDelta, onTool, groupId, signal, lang) {
  return withAgent(bot.id, async () => {
    const container = CFG.tools ? await ensureContainer(bot.id, groupId) : null
    const messages = [{ role: 'system', content: systemFor(bot, memory, peers, CFG.tools ? '/work' : null, '', await db.skillsFor(bot.id), lead) }]
    for (const e of await db.recent('group', groupId, FETCH_MAX)) {
      messages.push(e.speaker === bot.name
        ? { role: 'assistant', content: e.content }                                   // what he said himself
        : { role: 'user', content: `[${modelSpeaker(e.speaker)}] ${e.content}` })     // what others and the user said
    }
    return runAgent(p, messages, onDelta, onTool, { container, signal, bot, lang, scope: 'group', scopeId: groupId })
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
async function converse(bots, groupId, providers, text, emit, signal, lang = 'en') {
  try {
    if (!groupId && bots.length === 1) {
      const bot = bots[0]
      emit('start', { botId: bot.id })
      await askSolo(providers.get(bot.id), bot, text,
        { own: await db.getMemory('agent', bot.id), self: await db.getSelfMemory(bot.id) },
        d => emit('delta', { botId: bot.id, text: d }),
        t => emit('tool', { botId: bot.id, ...t, output: t.output?.slice(0, 400) }), signal, lang)
      emit('end', { botId: bot.id })
    } else {
      // Group chat: colleagues relay. Who speaks first — whoever the user @-ed; if nobody, the group's lead;
      // if no lead is set, whoever sorts first (the old behavior; Chief of Staff is 0).
      const gid = groupId ?? 'main'
      await db.addMessage('group', gid, { role: 'user', speaker: USER_SPEAKER, content: text })
      const g = (await db.listGroups()).find(x => x.id === gid)
      const lead = bots.find(b => b.id === g?.lead) ?? null
      let speaker = findMention(text, bots) ?? lead ?? bots[0]
      const spoken = new Map()
      for (let turn = 0; turn <= MAX_HANDOFFS && !signal.aborted; turn++) {
        const peers = bots.filter(b => b.id !== speaker.id)
        emit('start', { botId: speaker.id, turn })
        let reply = ''
        try {
          reply = await askInGroup(providers.get(speaker.id), speaker, peers, lead,
            { own: await db.getMemory('agent', speaker.id), self: await db.getSelfMemory(speaker.id),
              group: await db.getMemory('group', gid) },
            d => emit('delta', { botId: speaker.id, text: d }),
            t => emit('tool', { botId: speaker.id, ...t, output: t.output?.slice(0, 400) }),
            gid, signal, lang)
        } catch (e) {
          emit('error', { botId: speaker.id, message: errorText(e, lang).slice(0, 300), capped: e?.capped === true })
          break
        }
        await db.addMessage('group', gid, { role: 'assistant', speaker: speaker.name, content: reply })
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
      new AbortController().signal)
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
  const base = bot.provider_id ? await db.getProvider(bot.provider_id) : await requireProvider()
  if (!base) throw new Say('provider.gone', { name: bot.name })
  if (!bot.model) throw new Say('provider.noModel', { name: bot.name })
  return { ...base, model: bot.model, effort: normEffort(bot.effort), context_tokens: await contextFor(base, bot.model) }
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
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }

function authed(req, url) {
  if (!CFG.token) return true                       // no guard when only listening locally
  if (url.searchParams.get('k') === CFG.token) return true
  return (req.headers.cookie ?? '').includes(`ma_token=${CFG.token}`)
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
async function checkAgent(b, selfId = null) {
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
  if (b.model !== undefined || !selfId) {
    const model = str(b.model).trim()
    if (!model) throw new Say('agent.modelRequired')
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
  if (CFG.token && url.searchParams.get('k') === CFG.token)
    res.setHeader('set-cookie', `ma_token=${CFG.token}; Path=/; Max-Age=2592000; SameSite=Lax`)

  try {
    if (url.pathname === '/api/conversations') return send(200, await listConversations(lang))

    // Direct chat history: the frontend wants {role, content, at}
    const dm = url.pathname.match(/^\/api\/dm\/([a-z0-9-]+)$/)
    if (dm && req.method === 'GET')
      return send(200, (await db.recent('dm', dm[1], FETCH_MAX))
        .map(m => ({ role: m.role, content: m.content, at: m.at })))
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
      await db.upsertAgent({ description: '', provider_id: '', model: '', effort: '', ...checked, id: slug, ord: n + 1, color: db.nextColor(n) })
      return send(200, { id: slug })
    }

    const bm = url.pathname.match(/^\/api\/bots\/([a-z0-9-]+)$/)
    if (bm && req.method === 'PATCH') {
      const cur = await db.getAgent(bm[1])
      if (!cur) return send(404, { error: t('err.noAgent') })
      const patch = await checkAgent(await readBody(req), cur.id)
      await db.upsertAgent({ ...cur, ...patch })
      // Group logs identify people by name. Without syncing a rename, what he said in groups would become "someone else's"
      if (patch.name && patch.name !== cur.name) await db.renameSpeaker(cur.name, patch.name)
      return send(200, { ok: true })
    }
    if (bm && req.method === 'DELETE') {
      if (!await db.getAgent(bm[1])) return send(404, { error: t('err.noAgent') })
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
      const { target, botIds = [], text = '' } = await readBody(req)
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

      await converse(bots, groupId, providers, text, emit, ac.signal, lang)
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
      return send(200, await db.saveGroup({ ...g, ...patch }))
    }
    if (gm && req.method === 'DELETE') {         // disband; files in the shared drive are left alone
      await db.deleteGroup(gm[1])
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
      return send(200, (await db.recent('group', gr[1], FETCH_MAX))
        .map(m => ({ speaker: m.speaker, text: m.content, at: m.at })))
    if (gr && req.method === 'DELETE') { await db.clearMessages('group', gr[1]); return send(200, { ok: true }) }

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
  console.log(`Multi-Agent  http://${CFG.host}:${CFG.port}${CFG.token ? `/?k=${CFG.token}` : ''}`)
  if (!CFG.token) console.log('(ACCESS_TOKEN not set; only listening on 127.0.0.1)')
  if (!CFG.tools) console.log('(AGENT_TOOLS is off; agents can only talk, not act)')
})
