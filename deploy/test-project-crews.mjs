// Structural isolation tests use a transaction which is ALWAYS rolled back.
// No CLI, media API or generation worker is invoked, and no test project is retained.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { pool } from '../web/db.mjs'
import { create, forAgent, explicitNew, routingResult } from '../web/crews.mjs'

for (const s of ['新项目：咖啡广告', '新建剧组', '帮我创建一个新项目：城市夜景', 'create a new project']) assert(explicitNew(s), s)
for (const s of ['不要新建项目', '这个项目改成竖屏', '新项目有什么参数？', '继续下一集']) assert(!explicitNew(s), s)
assert.equal(routingResult('{"intent":"new","name":"咖啡广告"}').name, '咖啡广告')
assert.throws(() => routingResult('{"intent":"delete"}'))
const c = await pool.connect()
try {
  await c.query('begin')
  const key = randomUUID()
  const a = await create({ name: '隔离测试甲', brief: '甲剧本', request_id: key }, { client: c })
  const repeat = await create({ name: '重复请求', request_id: key }, { client: c })
  assert.equal(repeat.project_id, a.project_id, 'retry does not create a second project')
  const b = await create({ name: '隔离测试乙', request_id: randomUUID() }, { client: c })
  const groups = (await c.query('select * from groups where id=any($1)', [[a.group_id,b.group_id]])).rows
  const ids = groups.flatMap(g => g.members)
  assert.equal(ids.length, 8); assert.equal(new Set(ids).size, 8)
  assert.equal((await c.query('select * from studio.crew where agent_id=any($1)', [ids])).rowCount, 8)
  for (const g of groups) {
    const bound = g.id === a.group_id ? a : b
    assert.equal((await forAgent(g.lead,c)).project_id, bound.project_id)
    assert.deepEqual((await c.query('select role from studio.crew where project_id=$1 order by role', [bound.project_id])).rows.map(x => x.role),
      ['art','cinematographer','director','reviewer'])
    assert.equal((await c.query('select * from skills where agents && $1::text[]', [g.members])).rowCount, 5)
  }
  assert.equal((await c.query('select * from skills where agents && $1::text[] and agents && $2::text[]', [groups[0].members,groups[1].members])).rowCount, 0)
  assert.equal((await c.query('select * from messages where scope_id=any($1)', [[...ids,a.group_id,b.group_id]])).rowCount, 0)
  assert.equal((await c.query("select * from settings where key like 'memory:%' and exists(select 1 from unnest($1::text[]) x where position(x in key)>0)", [ids])).rowCount, 0)
  assert.equal((await c.query('select * from studio.generations where project_id=any($1)', [[a.project_id,b.project_id]])).rowCount, 0)
  console.log('PASS: intent commands, retry deduplication, 8 unique members, isolated roles/skills/history/memory, no generations')
} finally { await c.query('rollback'); c.release(); await pool.end() }
