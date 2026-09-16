// PostgreSQL persistence.
//
// Before this, state was scattered across files: Agents in two ymls under bots/<id>/,
// DMs in workspace/dm/*.json, groups in workspace/groups/<id>/{group,log}.json, memory
// in MEMORY.md. Fine for a single-machine script, not for a product others deploy — no
// transactions, no concurrency safety, backups meant remembering five paths, and data
// scattered as soon as a container was removed.
//
// Now there is one source of truth: this database. bots/ is demoted to a FIRST-START SEED,
// and old workspace files are imported once on first start (so upgrades lose nothing).
import './env.mjs'
import pg from 'pg'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

// timestamptz comes back as milliseconds: the frontend and sorting both want numbers,
// and leaving each caller to +new Date(x) will miss one sooner or later.
pg.types.setTypeParser(1184, v => Date.parse(v))
pg.types.setTypeParser(1114, v => Date.parse(v + 'Z'))

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 8,
})
const q = (sql, params) => pool.query(sql, params)

const SCHEMA = `
create table if not exists agents (
  id          text primary key,
  name        text not null,
  description text not null default '',
  persona     text not null default '',
  ord         int  not null default 99,
  color       text not null default '#4f8cff',
  created_at  timestamptz not null default now()
);

create table if not exists groups (
  id         text primary key,
  name       text not null,
  members    text[] not null default '{}',
  created_at timestamptz not null default now()
);

-- DMs and group chats are the same thing: who said what in a conversation. Two tables
-- would turn "conversation list sorted by recent activity" into two queries plus a merge.
create table if not exists messages (
  id       bigserial primary key,
  scope    text not null check (scope in ('dm','group')),
  scope_id text not null,
  role     text not null check (role in ('user','assistant')),
  speaker  text not null default '',
  content  text not null,
  at       timestamptz not null default now()
);
create index if not exists messages_scope_idx on messages (scope, scope_id, id);

create table if not exists settings (
  key   text primary key,
  value jsonb not null
);

create table if not exists providers (
  id             text primary key,
  name           text not null,
  base_url       text not null,
  api_key        text not null default '',
  model          text not null,
  context_tokens int  not null default 128000,
  auto_context   bool not null default true,
  ctx_source     text not null default '',
  is_default     bool not null default false,
  created_at     timestamptz not null default now()
);
-- Only one "default upstream". Enforced by a partial unique index, not app-level discipline:
-- two concurrent "set as default" requests can't be stopped in the app.
-- Old-database upgrade: protocol was added later. chat = OpenAI Chat Completions,
-- responses = OpenAI Responses, messages = Anthropic Messages.
alter table providers add column if not exists protocol text not null default 'chat'
  check (protocol in ('chat','responses','messages'));
create unique index if not exists providers_one_default on providers (is_default) where is_default;
-- Each Agent can use its own upstream and model. Both empty = follow the default upstream.
alter table agents add column if not exists provider_id text;
alter table agents add column if not exists model text not null default '';
-- The group's lead: speaks first when the user @-mentions no one, splits the work, sums up. Empty = first by order (old behavior)
alter table groups add column if not exists lead text;
-- The model is chosen per Agent; an upstream only says where to connect, with which key, in which protocol.
-- providers.model is now only a migration source for old data (fillAgentModels); new upstreams store ''.
alter table providers alter column model set default '';
`

/** Wait for the database — in compose the app is often ready before postgres. */
export async function connect({ tries = 30, waitMs = 2000 } = {}) {
  for (let i = 1; ; i++) {
    try { await q('select 1'); return }
    catch (e) {
      if (i >= tries) throw new Error(
        `Cannot connect to PostgreSQL (tried ${i} times): ${e.message}\n` +
        'If the password is wrong, another deployment on this machine most likely owns containers and volumes with the same names —\n' +
        'set COMPOSE_PROJECT_NAME in .env to something else and run up again.')
      if (i === 1) console.log('Waiting for PostgreSQL…')
      await new Promise(r => setTimeout(r, waitMs))
    }
  }
}

export async function migrate() { await q(SCHEMA) }

// ---------- Agent ----------
const COLORS = ['#4f8cff', '#3ecf8e', '#ffb454', '#c678dd', '#e06c75', '#56b6c2', '#d19a66']

export async function listAgents() {
  const { rows } = await q('select * from agents order by ord, created_at')
  return rows
}

export async function getAgent(id) {
  return (await q('select * from agents where id = $1', [id])).rows[0] ?? null
}

export async function upsertAgent(a) {
  const { rows } = await q(`
    insert into agents (id, name, description, persona, ord, color, provider_id, model)
    values ($1,$2,$3,$4,$5,$6,$7,$8)
    on conflict (id) do update set
      name = excluded.name, description = excluded.description,
      persona = excluded.persona, ord = excluded.ord, color = excluded.color,
      provider_id = excluded.provider_id, model = excluded.model
    returning *`,
    [a.id, a.name, a.description ?? '', a.persona ?? '', a.ord ?? 99,
     a.color ?? COLORS[Math.floor(Math.random() * COLORS.length)],
     a.provider_id || null, a.model ?? ''])
  return rows[0]
}

/** Group logs identify people by name; a rename must follow, or their past words become "someone else's". */
export async function renameSpeaker(from, to) {
  await q('update messages set speaker = $2 where speaker = $1', [from, to])
}

export async function deleteAgent(id) {
  // Remove them from group member arrays too — otherwise the group shows a name that can't be opened
  await q(`update groups set members = array_remove(members, $1)`, [id])
  await q(`update groups set lead = null where lead = $1`, [id])
  await q(`delete from messages where scope = 'dm' and scope_id = $1`, [id])
  await q('delete from agents where id = $1', [id])
  await q('delete from settings where key = $1', [memKey('agent', id)])
}

export const nextColor = n => COLORS[n % COLORS.length]

// ---------- groups ----------
export async function listGroups() {
  const { rows } = await q('select * from groups order by created_at')
  return rows
}

export async function saveGroup(g) {
  const { rows } = await q(`
    insert into groups (id, name, members, lead) values ($1,$2,$3,$4)
    on conflict (id) do update set name = excluded.name, members = excluded.members, lead = excluded.lead
    returning *`, [g.id, g.name, g.members ?? [], g.lead || null])
  return rows[0]
}

export async function deleteGroup(id) {
  await q(`delete from messages where scope = 'group' and scope_id = $1`, [id])
  await q('delete from groups where id = $1', [id])
  await q('delete from settings where key = $1', [memKey('group', id)])
}

// ---------- messages ----------
export async function addMessage(scope, scopeId, { role, speaker = '', content }) {
  await q('insert into messages (scope, scope_id, role, speaker, content) values ($1,$2,$3,$4,$5)',
    [scope, scopeId, role, speaker, content])
}

/** The latest `limit` messages, returned oldest first (the model wants old to new). */
export async function recent(scope, scopeId, limit = 200) {
  const { rows } = await q(
    'select role, speaker, content, at from messages where scope = $1 and scope_id = $2 order by id desc limit $3',
    [scope, scopeId, limit])
  return rows.reverse()
}

/** Import in one transaction: a failure halfway leaves no half-written history. */
export async function importMessages(scope, scopeId, rows, { replace = false } = {}) {
  const c = await pool.connect()
  try {
    await c.query('begin')
    if (replace) await c.query('delete from messages where scope = $1 and scope_id = $2', [scope, scopeId])
    for (const m of rows)
      await c.query(`insert into messages (scope, scope_id, role, speaker, content, at)
                     values ($1,$2,$3,$4,$5, coalesce($6::timestamptz, now()))`,
        [scope, scopeId, m.role, m.speaker, m.content, m.at])
    await c.query('commit')
  } catch (e) { await c.query('rollback'); throw e }
  finally { c.release() }
}

export async function agentsUsingProvider(id) {
  return (await q('select name from agents where provider_id = $1', [id])).rows.map(r => r.name)
}

export async function clearMessages(scope, scopeId) {
  await q('delete from messages where scope = $1 and scope_id = $2', [scope, scopeId])
}

/** The last message of each conversation. The conversation list sorts by it, in one query. */
export async function lastMessages() {
  const { rows } = await q(`
    select distinct on (scope, scope_id) scope, scope_id, role, speaker, content, at
    from messages order by scope, scope_id, id desc`)
  return new Map(rows.map(r => [`${r.scope}:${r.scope_id}`, r]))
}

// ---------- settings ----------
export async function getSetting(key, fallback = null) {
  const { rows } = await q('select value from settings where key = $1', [key])
  return rows[0] ? rows[0].value : fallback
}

export async function setSetting(key, value) {
  await q(`insert into settings (key, value) values ($1,$2)
           on conflict (key) do update set value = excluded.value`, [key, JSON.stringify(value)])
}

// ---------- memory: one per Agent, one per group ----------
// Product decision: "each person has their own memory, groups share one, and nothing is
// forgotten in DMs". An Agent's memory goes with them (their DM and every group they're in);
// a group's memory stays in that group.
export const memKey = (kind, id) => `memory:${kind}:${id}`
export const getMemory = (kind, id) => getSetting(memKey(kind, id), '')
export const setMemory = (kind, id, text) => setSetting(memKey(kind, id), text)

// ---------- model upstreams ----------
export async function listProviders() {
  const { rows } = await q('select * from providers order by is_default desc, created_at')
  return rows
}

export async function getProvider(id) {
  return (await q('select * from providers where id = $1', [id])).rows[0] ?? null
}

/** The upstream in effect. With no default, the oldest — nobody should have to click "set as default" when there is only one. */
export async function activeProvider() {
  const { rows } = await q(
    'select * from providers order by is_default desc, created_at limit 1')
  return rows[0] ?? null
}

export async function saveProvider(p) {
  const { rows } = await q(`
    insert into providers (id, name, base_url, api_key, model, context_tokens, auto_context, ctx_source, is_default, protocol)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    on conflict (id) do update set
      name = excluded.name, base_url = excluded.base_url, api_key = excluded.api_key,
      model = excluded.model, context_tokens = excluded.context_tokens,
      auto_context = excluded.auto_context, ctx_source = excluded.ctx_source,
      protocol = excluded.protocol
    returning *`,
    [p.id, p.name, p.base_url, p.api_key ?? '', p.model,
     p.context_tokens ?? 128000, p.auto_context ?? true, p.ctx_source ?? '', p.is_default ?? false,
     p.protocol ?? 'chat'])
  return rows[0]
}

/** Make it the default. Clear then set, in one transaction — failing halfway would leave zero defaults. */
export async function makeDefault(id) {
  const c = await pool.connect()
  try {
    await c.query('begin')
    await c.query('update providers set is_default = false where is_default')
    await c.query('update providers set is_default = true where id = $1', [id])
    await c.query('commit')
  } catch (e) { await c.query('rollback'); throw e }
  finally { c.release() }
}

export async function deleteProvider(id) {
  await q('delete from providers where id = $1', [id])
}

// ---------- first-start seed / legacy import ----------
//
// Runs once, only when the database is empty. After that, bots/ and the workspace json
// files are just history; editing them has no effect — the README must say so, or the
// next person will edit a file and wonder why the UI didn't change.
//
// USER_SPEAKER is the speaker recorded on a person's messages: a stored wire value that
// server.mjs and both clients compare against, not display text, so it is never translated.
export const USER_SPEAKER = 'User'

export async function seed(root) {
  if ((await q('select 1 from agents limit 1')).rowCount) return { seeded: false }

  const imported = { agents: 0, groups: 0, messages: 0 }
  const dir = join(root, 'bots')
  const names = await readdir(dir, { withFileTypes: true })
    .then(ds => ds.filter(d => d.isDirectory()).map(d => d.name).sort())
    .catch(() => [])

  for (const [i, name] of names.entries()) {
    const meta = await readFile(join(dir, name, 'preset.yml'), 'utf8').catch(() => '')
    const comp = await readFile(join(dir, name, 'agent.cordis.yml'), 'utf8').catch(() => '')
    const field = k => (meta.match(new RegExp(`^${k}:\\s*(.+)$`, 'm'))?.[1] ?? '').trim()
    const persona = (comp.match(/text:\s*\|-?\n([\s\S]*?)(?=\n\S|\n\s*- id:|$)/)?.[1] ?? '')
      .split('\n').map(l => l.replace(/^ {6}/, '')).join('\n').trim()
    await upsertAgent({
      id: name, name: field('name') || name, description: field('description'),
      persona, ord: Number(field('order') || 99), color: nextColor(i),
    })
    imported.agents++

    for (const m of await readFile(join(root, 'workspace', 'dm', `${name}.json`), 'utf8')
      .then(JSON.parse).catch(() => [])) {
      await q(`insert into messages (scope, scope_id, role, speaker, content, at)
               values ('dm',$1,$2,$3,$4, to_timestamp($5/1000.0))`,
        [name, m.role === 'user' ? 'user' : 'assistant',
         m.role === 'user' ? USER_SPEAKER : (field('name') || name), String(m.content ?? ''),
         m.at ?? Date.now()])
      imported.messages++
    }
  }

  const gbase = join(root, 'workspace', 'groups')
  for (const d of await readdir(gbase, { withFileTypes: true }).catch(() => [])) {
    if (!d.isDirectory()) continue
    const meta = await readFile(join(gbase, d.name, 'group.json'), 'utf8').then(JSON.parse).catch(() => null)
    if (!meta) continue
    await saveGroup({ id: d.name, name: meta.name ?? d.name, members: meta.members ?? [] })
    imported.groups++
    for (const e of await readFile(join(gbase, d.name, 'log.json'), 'utf8').then(JSON.parse).catch(() => [])) {
      await q(`insert into messages (scope, scope_id, role, speaker, content, at)
               values ('group',$1,$2,$3,$4, to_timestamp($5/1000.0))`,
        [d.name, e.speaker === USER_SPEAKER ? 'user' : 'assistant', String(e.speaker ?? ''),
         String(e.text ?? ''), e.at ?? Date.now()])
      imported.messages++
    }
  }

  const mem = await readFile(join(root, 'workspace', 'MEMORY.md'), 'utf8').catch(() => '')
  if (mem.trim()) await setSetting('memory', mem)

  return { seeded: true, ...imported }
}

/**
 * The model moved from upstream to Agent: an Agent without a model gets a copy of its upstream's old model.
 * Idempotent, runs on every start — old-database upgrades and .env-seeded upstreams rely on it.
 */
export async function fillAgentModels() {
  const { rowCount } = await q(`
    update agents a set model = p.model
      from providers p
     where a.model = '' and p.model <> ''
       and p.id = coalesce(a.provider_id,
             (select id from providers order by is_default desc, created_at limit 1))`)
  return rowCount
}

/** .env configures an upstream and the database has none — an upgraded old deployment shouldn't need a trip to the UI first. */
export async function seedProviderFromEnv(env) {
  if ((await q('select 1 from providers limit 1')).rowCount) return false
  if (!env.BOT_LLM_BASE_URL || !env.BOT_LLM_MODEL) return false
  await saveProvider({
    id: 'p-env', name: env.BOT_LLM_NAME || 'Default upstream',
    base_url: env.BOT_LLM_BASE_URL.replace(/\/+$/, ''),
    api_key: env.BOT_LLM_API_KEY ?? '', model: env.BOT_LLM_MODEL,
    protocol: env.BOT_LLM_PROTOCOL || 'chat',
    context_tokens: Number(env.BOT_LLM_CONTEXT || 128000),
    auto_context: !env.BOT_LLM_CONTEXT,
    ctx_source: env.BOT_LLM_CONTEXT ? 'from .env' : 'default 128k; probe to calibrate',
    is_default: true,
  })
  return true
}
