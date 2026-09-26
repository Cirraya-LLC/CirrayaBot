// Who may do what in the studio. This is the permission spec from studio/crew/README.md,
// enforced here — outside every model — because a persona line saying "you don't approve
// shots" stops nothing (CLAUDE.md 2.3).
//
// The caller's identity comes from the platform, never from the model: the app holds
// STUDIO_TOKEN and says which agent it is acting for (x-studio-actor). An agent never sees
// the token, so it cannot claim to be someone else.
//
// Self-test: node studio/roles.mjs

export const ROLES = ['director', 'art', 'cinematographer', 'reviewer']

// Reading is everyone's: a crew that can't look at the shot list can't coordinate.
export const READ = new Set([
  'project.list', 'project.current', 'project.info', 'project.use',
  'char.list', 'char.show', 'char.refs',
  'loc.list', 'loc.show', 'loc.refs',
  'asset.show', 'scene.list', 'scene.show', 'shot.show', 'review.history',
  'episode.list', 'episode.show',
  // Your own work orders: list them, close the kind only you can close (actions.mjs checks the role).
  'order.list', 'order.done',
])

// What each role may change. `project.use` is in READ on purpose: it only moves the caller's
// own "current project" pointer and changes no shared state.
const WRITE = {
  director: ['scene.add', 'shot.plan', 'shot.lock', 'episode.submit', 'episode.assemble'],
  art: ['char.add', 'char.edit', 'char.voice', 'look.add', 'look.edit', 'loc.add', 'loc.edit',
    'asset.gen', 'asset.edit', 'asset.save', 'asset.tag'],
  cinematographer: ['shot.prompt', 'shot.gen'],
  reviewer: ['shot.sheet', 'shot.approve', 'shot.reject'],
}

// Only a person. Locking is "this is final": the look everybody else must match. Letting an
// agent do it — even after a human clicks approve — would mean its token can do it, and a
// token that can do it can be talked into doing it.
export const HUMAN_ONLY = new Set([
  'char.lock', 'char.unlock', 'loc.lock', 'loc.unlock',
  'project.create', 'project.edit', 'scene.edit', 'crew.set', 'crew.list',
  // The script is a person's, and so are the gates of the pipeline: starting an episode, passing
  // its breakdown and its cut, and handing a shot rejected three times back to the crew.
  'episode.add', 'episode.edit', 'episode.start', 'episode.review', 'shot.reopen', 'project.bgm',
  // Model keys. Not even a hint of one is readable by an agent.
  'keys.get', 'keys.set', 'keys.test',
  // The workbench's views (the web UI). Reading, but shaped for a screen, not for a model's context.
  'project.board', 'shot.detail',
])

export const ACTIONS = new Set([...READ, ...Object.values(WRITE).flat(), ...HUMAN_ONLY])

/** x-studio-actor header → {kind:'human'} | {kind:'agent', id} | null */
export function parseActor(raw) {
  const s = String(raw ?? '').trim()
  if (s === 'human') return { kind: 'human' }
  const m = /^agent:([a-z0-9][a-z0-9-]{0,62})$/.exec(s)
  return m ? { kind: 'agent', id: m[1] } : null
}

/**
 * May this actor (with this role; null = not on the crew) do this action?
 * Returns null when allowed, otherwise a short English reason the agent can act on.
 */
export function deny(actor, role, action) {
  if (!ACTIONS.has(action)) return `unknown action ${action}`
  if (actor?.kind === 'human') return null
  if (actor?.kind !== 'agent') return 'no actor'
  if (!role) return `agent ${actor.id} is not on the studio crew; a person has to give it a role first`
  if (HUMAN_ONLY.has(action)) return `${action} can only be done by a person — ask the user`
  if (READ.has(action)) return null
  if (WRITE[role]?.includes(action)) return null
  return `${action} is not part of the ${role}'s job`
}

// ---------- self-test ----------
if (import.meta.url === `file://${process.argv[1]}`) {
  const a = await import('node:assert/strict')
  const agent = id => ({ kind: 'agent', id })

  // The table from studio/crew/README.md, row by row.
  a.equal(deny(agent('d'), 'director', 'shot.plan'), null)
  a.equal(deny(agent('d'), 'director', 'shot.lock'), null)
  a.equal(deny(agent('d'), 'director', 'scene.add'), null)
  a.equal(deny(agent('d'), 'director', 'episode.submit'), null)
  a.match(deny(agent('d'), 'director', 'episode.review'), /only be done by a person/, 'the director can\'t pass his own breakdown')
  a.match(deny(agent('d'), 'director', 'episode.start'), /only be done by a person/)
  a.equal(deny(agent('a'), 'art', 'char.voice'), null)
  a.match(deny(agent('c'), 'cinematographer', 'shot.reopen'), /only be done by a person/)
  a.equal(deny(agent('c'), 'cinematographer', 'order.done'), null, 'closing your own order is checked by role in the action')
  a.match(deny(agent('d'), 'director', 'shot.gen'), /not part of the director/)
  a.match(deny(agent('d'), 'director', 'project.edit'), /only be done by a person/, 'director: project is read-only')

  a.equal(deny(agent('a'), 'art', 'asset.gen'), null)
  a.equal(deny(agent('a'), 'art', 'char.add'), null)
  a.equal(deny(agent('a'), 'art', 'loc.edit'), null)
  a.match(deny(agent('a'), 'art', 'char.lock'), /only be done by a person/, '"char *" never includes lock')
  a.match(deny(agent('a'), 'art', 'shot.approve'), /not part of the art/)

  a.equal(deny(agent('c'), 'cinematographer', 'shot.gen'), null)
  a.equal(deny(agent('c'), 'cinematographer', 'shot.prompt'), null)
  a.match(deny(agent('c'), 'cinematographer', 'shot.approve'), /not part/, 'no reviewing your own shots')

  a.equal(deny(agent('r'), 'reviewer', 'shot.approve'), null)
  a.equal(deny(agent('r'), 'reviewer', 'shot.reject'), null)
  a.equal(deny(agent('r'), 'reviewer', 'shot.sheet'), null)
  a.match(deny(agent('r'), 'reviewer', 'shot.gen'), /not part/)

  // Everyone reads; nobody on the crew locks; a person does anything.
  for (const r of ROLES) {
    a.equal(deny(agent('x'), r, 'shot.show'), null)
    a.equal(deny(agent('x'), r, 'project.use'), null)
    for (const h of HUMAN_ONLY) a.notEqual(deny(agent('x'), r, h), null, `${r} must not ${h}`)
  }
  for (const act of ACTIONS) a.equal(deny({ kind: 'human' }, null, act), null)
  // Model keys: not even the hint is an agent's to read.
  for (const k of ['keys.get', 'keys.set', 'keys.test']) a.match(deny(agent('d'), 'director', k), /only be done by a person/)

  // Not on the crew = nothing at all, not even reading; a made-up action is refused for everyone.
  a.match(deny(agent('stranger'), null, 'shot.show'), /not on the studio crew/)
  a.match(deny({ kind: 'human' }, null, 'shot.delete_everything'), /unknown action/)
  a.equal(deny(null, 'director', 'shot.show'), 'no actor')

  // Actor header parsing: only the two shapes, nothing that could smuggle a path or a role.
  a.deepEqual(parseActor('human'), { kind: 'human' })
  a.deepEqual(parseActor('agent:reviewer'), { kind: 'agent', id: 'reviewer' })
  a.equal(parseActor('agent:../x'), null)
  a.equal(parseActor('agent:'), null)
  a.equal(parseActor('Human'), null)
  a.equal(parseActor(undefined), null)

  console.log('roles.mjs: all checks passed')
}
