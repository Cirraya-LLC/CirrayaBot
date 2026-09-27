// Production smoke test using disposable, precisely tracked project IDs. Media never
// requested; close each stream at the first start event, before the crew does any work.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { pool } from '../web/db.mjs'
import * as studio from '../web/studio.mjs'
const keys = []
const freshKey = () => { const k=randomUUID(); keys.push(k); return k }
const api = (path,body,signal) => fetch(`http://127.0.0.1:8080${path}?k=${encodeURIComponent(process.env.ACCESS_TOKEN)}`, {
  method:'POST',headers:{'content-type':'application/json','x-lang':'zh-Hans'},body:JSON.stringify(body),signal })
const chat = async (group,text) => {
  const ac=new AbortController()
  const r=await api('/api/chat',{target:{type:'group',id:group},text,request_id:freshKey()},AbortSignal.any([ac.signal,AbortSignal.timeout(85000)]))
  assert.equal(r.status,200)
  let buffer='', created=null, started=false
  const reader=r.body.getReader(), decoder=new TextDecoder()
  try {
    while (!started) {
      const chunk=await reader.read(); if(chunk.done)break
      buffer+=decoder.decode(chunk.value,{stream:true})
      const parts=buffer.split('\n\n'); buffer=parts.pop()
      for(const part of parts) {
        const event=part.match(/^event: (.+)$/m)?.[1]
        const data=JSON.parse(part.match(/^data: (.+)$/m)?.[1]??'{}')
        if(event==='error')throw new Error(data.message)
        if(event==='crew')created=data.conversation
        if(event==='start'){ started=true; break }
      }
    }
    assert(started,'stream must reach selected crew')
    return created
  } finally { ac.abort(); await reader.cancel().catch(()=>{}) }
}
try {
  const manual=await api('/api/crews',{name:'验收专用咖啡广告',request_id:freshKey()}).then(r=>r.json())
  assert(manual.project_id)
  assert.equal(await chat(manual.group_id,'做一支咖啡广告，清晨咖啡馆，15秒。仅讨论方案，不生成素材，不派工作单。'),null,
    'first brief after manual creation stays in that crew')
  assert.equal(await chat(manual.group_id,'把这个咖啡广告的字幕改短一点，其余不变。仅讨论，不生成素材。'),null,
    'local Codex recognizes a follow-up')
  const auto=await chat(manual.group_id,'我想拍一部30秒海底科幻短片：深海潜艇遇到发光外星生物，悬疑氛围。仅讨论方案，不生成任何素材，不派工作单。')
  assert(auto?.project_id && auto.project_id!==manual.project_id,'local Codex identifies a separate creative brief')
  const explicit=await chat(manual.group_id,'新项目：验收专用森林短片。仅讨论方案，不生成任何素材，不派工作单。')
  assert(explicit?.project_id && explicit.project_id!==manual.project_id)
  const own=(await pool.query('select g.members from project_crews c join groups g on g.id=c.group_id where c.project_id=$1',[manual.project_id])).rows[0]
  const denied=await studio.call(`agent:${own.members[0]}`,'project.info',{project:auto.project_id})
  assert.equal(denied.status,403)
  console.log('PASS: manual first brief, local-Codex follow-up, semantic new-project detection, explicit command, cross-project refusal')
} finally {
  // Let disconnected turns observe cancellation and release their agent/group locks.
  await delay(3000)
  const c=await pool.connect()
  try {
    await c.query('begin')
    const rows=(await c.query('select c.*,g.members from project_crews c join groups g on g.id=c.group_id where request_id=any($1)',[keys])).rows
    const projects=rows.map(r=>r.project_id), groups=rows.map(r=>r.group_id), members=rows.flatMap(r=>r.members)
    assert(!projects.includes('chuzhong'),'never clean existing user data')
    assert.equal((await c.query('select * from studio.generations where project_id=any($1)',[projects])).rowCount,0,'no media calls allowed')
    await c.query('delete from project_crews where project_id=any($1)',[projects])
    await c.query('delete from messages where scope_id=any($1)',[[...groups,...members]])
    await c.query('delete from skills where agents && $1::text[]',[members])
    await c.query('delete from studio.crew where agent_id=any($1)',[members])
    await c.query('delete from studio.projects where id=any($1)',[projects])
    await c.query('delete from groups where id=any($1)',[groups])
    await c.query('delete from agents where id=any($1)',[members])
    await c.query('delete from usage where scope_id=any($1)',[[...groups,...members]])
    await c.query('commit')
    console.log(`Cleaned only ${projects.length} disposable test projects; original project/history preserved; no media generated.`)
  } catch(e) { await c.query('rollback'); throw e }
  finally { c.release(); await pool.end() }
}
