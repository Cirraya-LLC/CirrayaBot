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
  role     text not null check (role in ('user','assistant','tool')),
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

-- Routines: when due, it is as if someone sent a message in that conversation. Frequency semantics live in web/schedule.mjs.
create table if not exists routines (
  id            text primary key,
  name          text not null,
  target_kind   text not null check (target_kind in ('agent','group')),
  target_id     text not null,
  prompt        text not null,
  kind          text not null check (kind in ('interval','daily','once')),
  every_minutes int  not null default 0,
  at_time       text not null default '',
  weekdays      int[] not null default '{}',
  run_at        timestamptz,
  tz            text not null default 'Asia/Shanghai',
  enabled       bool not null default true,
  next_run_at   timestamptz,
  last_run_at   timestamptz,
  last_status   text not null default '',
  last_error    text not null default '',
  failures      int  not null default 0,
  created_at    timestamptz not null default now()
);
create index if not exists routines_due_idx on routines (next_run_at) where enabled;

-- Skills: a "how to do this kind of job" note, same format as dsh / Claude Code SKILL.md (name + when to use + body).
-- agents = who it is installed on. source = 'human' or 'agent:<id>' (saved by the Agent itself; the UI must mark it).
create table if not exists skills (
  id          text primary key,
  name        text not null,
  description text not null default '',
  body        text not null,
  agents      text[] not null default '{}',
  source      text not null default 'human',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index if not exists skills_name_idx on skills (lower(name));

-- What every model call cost. One row per call, so a turn that used tools leaves several.
-- cost_micro is null when the upstream has no prices: "we don't know" and "it was free"
-- are different answers, and a 0 here would quietly become a 0 on the bill.
-- estimated = the upstream reported no token counts and we counted them ourselves.
create table if not exists usage (
  id                bigserial primary key,
  at                timestamptz not null default now(),
  agent_id          text not null,
  scope             text not null check (scope in ('dm','group')),
  scope_id          text not null,
  provider_id       text not null default '',
  model             text not null default '',
  prompt_tokens     int  not null default 0,
  completion_tokens int  not null default 0,
  cost_micro        bigint,
  estimated         bool not null default false
);
create index if not exists usage_agent_idx on usage (agent_id, at);

-- Prices per million tokens, in micro-dollars ($3/M = 3000000). Null = we were never told,
-- so calls on this upstream record tokens with no cost and cannot be capped.
alter table providers add column if not exists price_in_micro  bigint;
alter table providers add column if not exists price_out_micro bigint;
-- Daily spend cap, micro-dollars. Null = fall back to the platform default in settings.
alter table agents add column if not exists daily_cap_micro bigint;

-- Reasoning effort, per agent: '' (send nothing, what every model did before this existed)
-- or low / medium / high. Three levels on purpose: each provider spells it differently and a
-- per-provider vocabulary would need updating every time one of them moves.
alter table agents add column if not exists effort text not null default '';

-- When this agent has to ask before acting: '' (follow the platform setting),
-- 'off', 'match' (only commands the pattern list catches) or 'all'.
alter table agents add column if not exists approval text not null default '';

-- A tool call is a message too, so reopening a conversation still shows which commands ran.
-- Its content is JSON {name, args, output}; only the model's own history filters them out.
alter table messages drop constraint if exists messages_role_check;
alter table messages add constraint messages_role_check check (role in ('user','assistant','tool'));
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
    insert into agents (id, name, description, persona, ord, color, provider_id, model, daily_cap_micro, effort, approval)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    on conflict (id) do update set
      name = excluded.name, description = excluded.description,
      persona = excluded.persona, ord = excluded.ord, color = excluded.color,
      provider_id = excluded.provider_id, model = excluded.model,
      daily_cap_micro = excluded.daily_cap_micro, effort = excluded.effort,
      approval = excluded.approval
    returning *`,
    [a.id, a.name, a.description ?? '', a.persona ?? '', a.ord ?? 99,
     a.color ?? COLORS[Math.floor(Math.random() * COLORS.length)],
     a.provider_id || null, a.model ?? '', a.daily_cap_micro ?? null, a.effort ?? '', a.approval ?? ''])
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
  await q('delete from settings where key = any($1)', [[memKey('agent', id), selfMemKey(id)]])
  await q(`delete from routines where target_kind = 'agent' and target_id = $1`, [id])
  await q(`update skills set agents = array_remove(agents, $1)`, [id])
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
  await q(`delete from routines where target_kind = 'group' and target_id = $1`, [id])
}

// ---------- messages ----------
export async function addMessage(scope, scopeId, { role, speaker = '', content }) {
  await q('insert into messages (scope, scope_id, role, speaker, content) values ($1,$2,$3,$4,$5)',
    [scope, scopeId, role, speaker, content])
}

/** A finished tool call, kept so the transcript still shows the work after a reload. */
export async function addTool(scope, scopeId, speaker, { name, args, output }) {
  await q('insert into messages (scope, scope_id, role, speaker, content) values ($1,$2,$3,$4,$5)',
    [scope, scopeId, 'tool', speaker, JSON.stringify({ name, args, output })])
}

/**
 * The latest `limit` messages, returned oldest first (the model wants old to new).
 * Tool rows are for the transcript only: the model builds its own tool messages inside a turn,
 * and feeding these back would hand it a second, malformed copy of its own work.
 */
export async function recent(scope, scopeId, limit = 200, { tools = false } = {}) {
  const { rows } = await q(
    `select role, speaker, content, at from messages
     where scope = $1 and scope_id = $2 ${tools ? '' : "and role <> 'tool'"}
     order by id desc limit $3`,
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
    from messages where role <> 'tool' order by scope, scope_id, id desc`)
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

// An Agent's self-notes: a second, separate store, the only memory it can write itself
// (the `remember` tool). The memory above stays human-only — an agent must never be able to
// rewrite what a person wrote for it. See web/memory.mjs.
export const selfMemKey = id => `${memKey('agent', id)}:self`
export const getSelfMemory = id => getSetting(selfMemKey(id), '')
export const setSelfMemory = (id, text) => setSetting(selfMemKey(id), text)

// ---------- skills ----------
export async function listSkills() {
  return (await q('select * from skills order by lower(name)')).rows
}

export async function getSkill(id) {
  return (await q('select * from skills where id = $1', [id])).rows[0] ?? null
}

export async function skillByName(name) {
  return (await q('select * from skills where lower(name) = lower($1)', [name])).rows[0] ?? null
}

/** The skills installed on an Agent */
export async function skillsFor(agentId) {
  return (await q('select * from skills where $1 = any(agents) order by lower(name)', [agentId])).rows
}

export async function saveSkill(k) {
  const { rows } = await q(`
    insert into skills (id, name, description, body, agents, source)
    values ($1,$2,$3,$4,$5,$6)
    on conflict (id) do update set name = excluded.name, description = excluded.description,
      body = excluded.body, agents = excluded.agents, updated_at = now()
    returning *`, [k.id, k.name, k.description ?? '', k.body, k.agents ?? [], k.source ?? 'human'])
  return rows[0]
}

export async function deleteSkill(id) {
  await q('delete from skills where id = $1', [id])
}

// ---------- routines ----------
export async function listRoutines({ kind, id } = {}) {
  const { rows } = kind
    ? await q('select * from routines where target_kind = $1 and target_id = $2 order by created_at', [kind, id])
    : await q('select * from routines order by created_at')
  return rows
}

export async function getRoutine(id) {
  return (await q('select * from routines where id = $1', [id])).rows[0] ?? null
}

export async function saveRoutine(r) {
  const cols = ['id', 'name', 'target_kind', 'target_id', 'prompt', 'kind', 'every_minutes', 'at_time',
    'weekdays', 'run_at', 'tz', 'enabled', 'next_run_at', 'last_run_at', 'last_status', 'last_error', 'failures']
  const ts = v => (v == null ? null : new Date(v))
  const vals = cols.map(c => ['run_at', 'next_run_at', 'last_run_at'].includes(c) ? ts(r[c]) : r[c])
  const { rows } = await q(`
    insert into routines (${cols.join(',')}) values (${cols.map((_, i) => `$${i + 1}`).join(',')})
    on conflict (id) do update set ${cols.slice(1).map(c => `${c} = excluded.${c}`).join(', ')}
    returning *`, vals)
  return rows[0]
}

export async function deleteRoutine(id) {
  await q('delete from routines where id = $1', [id])
}

/** Routines that are due. Single-process deployment; the scheduler itself tracks whether one is running. */
export async function dueRoutines() {
  const { rows } = await q('select * from routines where enabled and next_run_at <= now() order by next_run_at')
  return rows
}

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
    insert into providers (id, name, base_url, api_key, model, context_tokens, auto_context, ctx_source, is_default, protocol,
                           price_in_micro, price_out_micro)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    on conflict (id) do update set
      name = excluded.name, base_url = excluded.base_url, api_key = excluded.api_key,
      model = excluded.model, context_tokens = excluded.context_tokens,
      auto_context = excluded.auto_context, ctx_source = excluded.ctx_source,
      protocol = excluded.protocol,
      price_in_micro = excluded.price_in_micro, price_out_micro = excluded.price_out_micro
    returning *`,
    [p.id, p.name, p.base_url, p.api_key ?? '', p.model,
     p.context_tokens ?? 128000, p.auto_context ?? true, p.ctx_source ?? '', p.is_default ?? false,
     p.protocol ?? 'chat', p.price_in_micro ?? null, p.price_out_micro ?? null])
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

// ---------- spending ----------
// Money is counted in micro-dollars (1 dollar = 1e6) so it stays an integer everywhere.
// Prices are per million tokens, also in micro-dollars: $3/M is 3_000_000.

export const MICRO = 1e6

/** Both prices set? Without them nothing on this upstream can be costed, or capped. */
export const isPriced = p => p?.price_in_micro != null && p?.price_out_micro != null

/** What one call cost, or null when the upstream has no prices — never 0 as a stand-in for "unknown". */
export function costOf(provider, promptTokens, completionTokens) {
  if (!isPriced(provider)) return null
  return Math.round((Number(promptTokens) * Number(provider.price_in_micro) +
                     Number(completionTokens) * Number(provider.price_out_micro)) / 1e6)
}

export async function recordUsage(u) {
  await q(`insert into usage (agent_id, scope, scope_id, provider_id, model,
                              prompt_tokens, completion_tokens, cost_micro, estimated)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [u.agent_id, u.scope, u.scope_id, u.provider_id ?? '', u.model ?? '',
     u.prompt_tokens | 0, u.completion_tokens | 0, u.cost_micro ?? null, u.estimated === true])
}

/**
 * What this agent has spent since midnight (server time), in micro-dollars.
 * Only priced calls count: an upstream with no prices cannot be measured, so it
 * cannot be capped either — the UI says so rather than pretending the number is 0.
 */
export async function spentToday(agentId) {
  const { rows } = await q(
    `select coalesce(sum(cost_micro), 0)::bigint as spent
       from usage where agent_id = $1 and at >= date_trunc('day', now())`, [agentId])
  return Number(rows[0]?.spent ?? 0)
}

const num = v => (v == null ? null : Number(v))

/** Today and this month, per agent and in total. One query — the sidebar polls this every 15s. */
export async function spendSummary() {
  const { rows } = await q(`
    select agent_id,
           coalesce(sum(prompt_tokens + completion_tokens) filter (where at >= date_trunc('day', now())), 0)::bigint as day_tokens,
           sum(cost_micro) filter (where at >= date_trunc('day', now()))::bigint as day_cost,
           count(*) filter (where at >= date_trunc('day', now()) and cost_micro is null)::int as day_unpriced,
           count(*) filter (where at >= date_trunc('day', now()))::int as day_calls,
           coalesce(sum(prompt_tokens + completion_tokens), 0)::bigint as month_tokens,
           sum(cost_micro)::bigint as month_cost,
           count(*) filter (where cost_micro is null)::int as month_unpriced,
           count(*)::int as month_calls
      from usage where at >= date_trunc('month', now())
     group by agent_id`)
  return rows.map(r => ({
    agent_id: r.agent_id,
    day:   { tokens: Number(r.day_tokens), cost_micro: num(r.day_cost), calls: r.day_calls, unpriced: r.day_unpriced },
    month: { tokens: Number(r.month_tokens), cost_micro: num(r.month_cost), calls: r.month_calls, unpriced: r.month_unpriced },
  }))
}

// The platform-wide daily cap, used by every agent that has none of its own. Null = no cap.
const CAP_KEY = 'spend.default_cap_micro'
export const defaultCap = () => getSetting(CAP_KEY, null)
export const setDefaultCap = micro => setSetting(CAP_KEY, micro)

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
