// One-time, non-destructive adoption of this deployment's existing film crew.
// Run in the app container AFTER both schema migrations. Re-running never replaces
// the frozen template, existing records, or user-edited personas.
import assert from 'node:assert/strict'
import * as db from '../web/db.mjs'
import { TEMPLATE_KEY, POLICY } from '../web/crews.mjs'

const c = await db.pool.connect()
try {
  await c.query('begin')
  await c.query("select pg_advisory_xact_lock(hashtext('project-crew-create'))")
  const g = (await c.query('select * from groups where id=$1', ['gmuj777qy'])).rows[0]
  const p = (await c.query('select * from studio.projects where id=$1', ['chuzhong'])).rows[0]
  assert(g && p && p.notify_group === g.id, 'Existing project/crew changed; inspect before adoption')
  const agents = (await c.query('select a.*,c.role from agents a join studio.crew c on c.agent_id=a.id where a.id=any($1) order by a.ord', [g.members])).rows
  assert.deepEqual(agents.map(a => a.role).sort(), ['art','cinematographer','director','reviewer'])
  const skills = (await c.query('select * from skills where name=any($1)', [
    ['studio-basics','shot-breakdown','character-bible','shot-prompting','footage-review']])).rows
  assert.equal(skills.length, 5)
  assert.equal((await c.query('select id from groups where id<>$1 and members && $2::text[]', [g.id,g.members])).rowCount, 0,
    'Existing crew members are shared with another group; inspect first')
  assert.equal((await c.query('select id from studio.projects where id<>$1 and notify_group=$2', [p.id,g.id])).rowCount, 0)
  await c.query('insert into settings (key,value) values ($1,$2) on conflict (key) do nothing',
    [TEMPLATE_KEY, { agents, skills }])
  await c.query('insert into project_crews (project_id,group_id) values ($1,$2) on conflict (project_id) do nothing', [p.id,g.id])
  await c.query('update studio.crew set project_id=$1 where agent_id=any($2)', [p.id,g.members])
  for (const a of agents) {
    await c.query('insert into studio.actor_project (actor,project_id) values ($1,$2) on conflict (actor) do update set project_id=excluded.project_id', [`agent:${a.id}`,p.id])
    if (!a.persona.includes('## 项目独立剧组规则')) await c.query('update agents set persona=persona || $2 where id=$1', [a.id,POLICY])
  }
  await c.query('commit')
  console.log('Existing crew bound to chuzhong; frozen four-role/five-skill template saved. No history or memory deleted.')
} catch (e) { await c.query('rollback'); throw e }
finally { c.release(); await db.pool.end() }
