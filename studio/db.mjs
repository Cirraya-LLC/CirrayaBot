// The studio's metadata: its own PostgreSQL schema (`studio`), reached through its own role.
//
// Same database server as the app, separate role on purpose: that role owns this schema and
// has no grants on the app's tables — so a bug in the part of the system that talks to
// Seedance / GPT image / ComfyUI and parses whatever they send back can't read `providers`
// (every LLM key) or the chat history. The app creates the role (web/db.mjs provisionStudio),
// because only it holds the superuser password.
//
// Files are not in here — only their sha256 (store.mjs). Rows point at bytes; bytes never change.
import pg from 'pg'

pg.types.setTypeParser(1184, v => Date.parse(v))   // timestamptz → ms, same as the app
pg.types.setTypeParser(20, v => Number(v))          // bigint counts/sizes fit in a double here

const url = process.env.STUDIO_DATABASE_URL
export const pool = new pg.Pool({ connectionString: url, max: 8, options: '-c search_path=studio' })
export const q = (sql, params) => pool.query(sql, params)

// Every project-owned row carries project_id: two films must never see each other's
// characters, shots or files, and "which project" is checked in SQL, not remembered by a model.
//
// ⚠️ No "create schema if not exists studio" here: Postgres checks CREATE on the DATABASE
// before it looks whether the schema exists, so even the no-op form fails for this role
// ("permission denied for database"). The app creates the schema (provisionStudio).
export const SCHEMA = `
create table if not exists projects (
  id          text primary key,                 -- slug, what "project use <slug>" takes
  name        text not null,
  -- world, style, tone, taboos, pass_line, model routing… everything "project info" shows.
  -- jsonb because the crew's skills read it as a whole and the fields will keep growing.
  info        jsonb not null default '{}',
  notify_group text not null default '',        -- the platform group studio posts to
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  check (id ~ '^[a-z0-9][a-z0-9-]{0,39}$')
);

-- Which agent does which job. Keyed by the platform's agent id, not its name: names change.
create table if not exists crew (
  agent_id   text primary key,
  role       text not null check (role in ('director','art','cinematographer','reviewer')),
  updated_at timestamptz not null default now()
);

-- "project use" is per caller: the director switching films must not switch the reviewer.
create table if not exists actor_project (
  actor      text primary key,                  -- 'agent:<id>' or 'human'
  project_id text not null references projects(id) on delete cascade
);

create table if not exists characters (
  id          text primary key,
  project_id  text not null references projects(id) on delete cascade,
  name        text not null,
  card        jsonb not null default '{}',       -- identity card: looks, height, palette hex, marks
  forbidden   text[] not null default '{}',      -- the "never change" list reviewers veto on
  status      text not null default 'draft' check (status in ('draft','locked')),
  locked_at   timestamptz,
  created_by  text not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index if not exists characters_name on characters (project_id, lower(name));

create table if not exists looks (
  id           text primary key,
  character_id text not null references characters(id) on delete cascade,
  name         text not null,
  card         jsonb not null default '{}',
  status       text not null default 'draft' check (status in ('draft','locked')),
  locked_at    timestamptz,
  created_by   text not null default '',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create unique index if not exists looks_name on looks (character_id, lower(name));

create table if not exists locations (
  id          text primary key,
  project_id  text not null references projects(id) on delete cascade,
  name        text not null,
  card        jsonb not null default '{}',
  status      text not null default 'draft' check (status in ('draft','locked')),
  locked_at   timestamptz,
  created_by  text not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index if not exists locations_name on locations (project_id, lower(name));

-- A scene is a slice of the script. The director cuts the script into scenes; the text in
-- \`script\` is the human's words and only a person may edit it (scene.edit is HUMAN_ONLY).
-- locked = the director's "shot lock": every shot in it passed, it goes to editing.
create table if not exists scenes (
  id          text primary key,
  project_id  text not null references projects(id) on delete cascade,
  code        text not null,                      -- S03
  title       text not null default '',
  script      text not null default '',
  ord         int  not null default 0,
  locked      bool not null default false,
  locked_at   timestamptz,
  created_by  text not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index if not exists scenes_code on scenes (project_id, lower(code));

create table if not exists shots (
  id            text primary key,
  project_id    text not null references projects(id) on delete cascade,
  scene_id      text not null references scenes(id) on delete cascade,
  code          text not null,                    -- S03-SH004
  ord           int  not null default 0,
  def           jsonb not null,                   -- the shot JSON from the shot-breakdown skill
  priority      text not null default 'normal' check (priority in ('hero','normal','filler')),
  status        text not null default 'planned'
                check (status in ('planned','prompted','generating','review','approved','rejected','locked')),
  prompt_version int not null default 0,
  pick_asset_id text,
  reject_count  int  not null default 0,          -- the third rejection goes to a person
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index if not exists shots_code on shots (project_id, lower(code));

-- Every prompt ever saved for a shot. The cinematographer changes one variable at a time;
-- without the old versions nobody can tell which change helped.
create table if not exists shot_prompts (
  id            bigserial primary key,
  shot_id       text not null references shots(id) on delete cascade,
  version       int  not null,
  text          text not null,
  ref_asset_ids text[] not null default '{}',
  note          text not null default '',
  created_by    text not null default '',
  created_at    timestamptz not null default now(),
  unique (shot_id, version)
);

-- Lineage. One row per call to a model: what was asked, with what, how long it took, what
-- came out. A file with no generation row was uploaded by someone.
create table if not exists generations (
  id              text primary key,
  project_id      text not null references projects(id) on delete cascade,
  shot_id         text references shots(id) on delete set null,
  engine          text not null check (engine in ('seedance','gpt-image','comfy')),
  model           text not null default '',
  kind            text not null check (kind in ('image','video')),
  prompt          text not null default '',
  prompt_version  int,
  ref_asset_ids   text[] not null default '{}',
  params          jsonb not null default '{}',
  status          text not null default 'queued'
                  check (status in ('queued','running','succeeded','failed','cancelled')),
  remote_id       text not null default '',       -- the upstream's task id
  error           text not null default '',
  usage           jsonb not null default '{}',
  output_asset_ids text[] not null default '{}',
  requested_by    text not null default '',
  created_at      timestamptz not null default now(),
  started_at      timestamptz,
  finished_at     timestamptz,
  duration_ms     int
);
create index if not exists generations_recent on generations (engine, created_at);
create index if not exists generations_shot on generations (shot_id);

create table if not exists assets (
  id            text primary key,
  project_id    text not null references projects(id) on delete cascade,
  sha256        text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  mime          text not null,
  bytes         bigint not null,
  width         int,
  height        int,
  duration_ms   int,
  kind          text not null,                    -- turnaround, expression, location, video, sheet…
  character_id  text references characters(id) on delete set null,
  look_id       text references looks(id) on delete set null,
  location_id   text references locations(id) on delete set null,
  shot_id       text references shots(id) on delete set null,
  tags          text[] not null default '{}',     -- angle / expression / light / shot size: how refs are found
  status        text not null default 'active' check (status in ('active','deprecated')),
  generation_id text references generations(id) on delete set null,
  created_by    text not null default '',
  created_at    timestamptz not null default now()
);
create index if not exists assets_project on assets (project_id, kind);
create index if not exists assets_tags on assets using gin (tags);

-- Candidate numbers are per shot and never reused, so "candidate 3" means the same video
-- in the review, in the note and in the sheet.
create table if not exists candidates (
  id              bigserial primary key,
  shot_id         text not null references shots(id) on delete cascade,
  n               int  not null,
  generation_id   text not null references generations(id) on delete cascade,
  asset_id        text not null references assets(id) on delete cascade,
  prompt_version  int,
  prefilter_score real,
  created_at      timestamptz not null default now(),
  unique (shot_id, n)
);

create table if not exists reviews (
  id          bigserial primary key,
  shot_id     text not null references shots(id) on delete cascade,
  verdict     text not null check (verdict in ('approve','reject')),
  pick        int,
  route       text check (route in ('prompt','asset','plan')),
  reason      text not null default '',
  note        text not null default '',
  scores      jsonb not null default '{}',
  attempt     int  not null default 0,             -- 1, 2, 3… for rejections
  reviewer    text not null default '',
  created_at  timestamptz not null default now()
);
create index if not exists reviews_shot on reviews (shot_id, id);

create table if not exists loras (
  id           text primary key,
  project_id   text not null references projects(id) on delete cascade,
  character_id text references characters(id) on delete cascade,
  look_id      text references looks(id) on delete cascade,
  name         text not null,                      -- the file name ComfyUI knows it by
  trigger      text not null default '',
  strength     real not null default 1,
  params       jsonb not null default '{}',
  created_at   timestamptz not null default now()
);

-- Who did what. Refusals are recorded too: an agent trying a command outside its job is the
-- first sign that something it read has been talking to it.
create table if not exists audit (
  id      bigserial primary key,
  at      timestamptz not null default now(),
  actor   text not null,
  action  text not null,
  target  text not null default '',
  ok      bool not null,
  detail  text not null default ''
);
create index if not exists audit_at on audit (at);
`

/** Wait for the database. In compose the studio can come up before the app has created its role. */
export async function connect({ tries = 60, waitMs = 2000 } = {}) {
  if (!url) throw new Error('STUDIO_DATABASE_URL is not set')
  for (let i = 1; ; i++) {
    try { await q('select 1'); return }
    catch (e) {
      if (i >= tries) throw new Error(`Cannot connect to PostgreSQL as the studio role (tried ${i} times): ${e.message}\n` +
        'The app creates this role at startup from STUDIO_DB_PASSWORD — is the app up, and do both have the same value?')
      if (i === 1) console.log('Waiting for PostgreSQL (the app creates the studio role on its first start)…')
      await new Promise(r => setTimeout(r, waitMs))
    }
  }
}

export const migrate = () => q(SCHEMA)

export const newId = prefix => `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`

// ---------- projects ----------
export const listProjects = async () => (await q('select * from projects order by created_at')).rows
export const getProject = async id => (await q('select * from projects where id = $1', [id])).rows[0] ?? null

export async function createProject({ id, name, info = {}, notify_group = '' }) {
  const { rows } = await q(
    `insert into projects (id, name, info, notify_group) values ($1,$2,$3,$4) returning *`,
    [id, name, info, notify_group])
  return rows[0]
}

export async function updateProject(id, { name, info, notify_group }) {
  const { rows } = await q(`
    update projects set name = coalesce($2, name), info = coalesce($3, info),
      notify_group = coalesce($4, notify_group), updated_at = now()
    where id = $1 returning *`, [id, name ?? null, info ?? null, notify_group ?? null])
  return rows[0] ?? null
}

// ---------- crew and the per-caller current project ----------
export const roleOf = async agentId =>
  (await q('select role from crew where agent_id = $1', [agentId])).rows[0]?.role ?? null
export const listCrew = async () => (await q('select * from crew order by agent_id')).rows

export async function setRole(agentId, role) {
  if (!role) return q('delete from crew where agent_id = $1', [agentId])
  return q(`insert into crew (agent_id, role) values ($1,$2)
            on conflict (agent_id) do update set role = excluded.role, updated_at = now()`, [agentId, role])
}

export const currentProject = async actor =>
  (await q('select project_id from actor_project where actor = $1', [actor])).rows[0]?.project_id ?? null

export const useProject = (actor, projectId) => q(`
  insert into actor_project (actor, project_id) values ($1,$2)
  on conflict (actor) do update set project_id = excluded.project_id`, [actor, projectId])

export const audit = (actor, action, target, ok, detail = '') =>
  q('insert into audit (actor, action, target, ok, detail) values ($1,$2,$3,$4,$5)',
    [actor, action, String(target ?? ''), ok, String(detail ?? '').slice(0, 500)])
    .catch(e => console.error('audit row lost:', e.message))
