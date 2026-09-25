// The pipeline: from an episode's script to its cut, who has to do what next.
//
// Nobody @-s anybody to hand work over. After every change, the studio looks at the whole state of
// the project (plan()) and works out what is needed; each need is a work order with a stable key,
// so the same need never makes two orders, and an order is closed the moment its need is gone
// (the shot moved on, the reference exists, the person locked it). Agents get their orders in
// their own chat (notify.mjs delivers them); the group only sees a one-line report of who got what.
//
//   episode  draft ──(person: start)──▶ breakdown ──(director: episode.submit)──▶ breakdown_review
//            ──(person: approve)──▶ production ──(every shot approved → cut assembled)──▶ final_review
//            ──(person: approve)──▶ done            (a person sending back → the stage before)
//
//   in production, per shot:  a character / look / location it needs has no references → art
//                             references but not locked → a person (the Bible)
//                             everything it needs locked, shot planned → cinematographer (prompt + gen)
//                             takes ready → reviewer;  rejected → the route's owner (prompt → cinematographer,
//                             asset → art, then cinematographer; plan → director); 3rd rejection → a person
//
// needs() is pure (a snapshot in, orders out) and self-tested; plan() reads the snapshot and writes.
//
// Self-test: node studio/pipeline.mjs
import { REJECTS_TO_HUMAN } from './shots.mjs'
let dbm = null
const dbx = async () => (dbm ??= await import('./db.mjs'))

const LANGS = ['en', 'zh-Hans', 'zh-Hant']
const T = {
  breakdown: [
    'Episode {ep}{title} is ready to be broken down. Read it (episode.show {ep}); cut it into scenes (scene.add with episode: "{ep}", the text copied exactly) and plan every shot with its dialogue (shot.plan). When the whole episode is planned, submit it (episode.submit {ep}) — a person checks the breakdown before production starts.{note}',
    '第 {ep} 集{title}可以拆了。先读剧本（episode.show {ep}），按场切分（scene.add，带 episode: "{ep}"，原文一字不改），再给每场出镜头表，对白写进镜头（shot.plan）。整集拆完后提交（episode.submit {ep}）——人确认拆解后才开拍。{note}',
    '第 {ep} 集{title}可以拆了。先讀劇本（episode.show {ep}），按場切分（scene.add，帶 episode: "{ep}"，原文一字不改），再給每場出鏡頭表，對白寫進鏡頭（shot.plan）。整集拆完後提交（episode.submit {ep}）——人確認拆解後才開拍。{note}'],
  note: ['\nThe person\'s note on the last version: {note}', '\n上一版人给的意见：{note}', '\n上一版人給的意見：{note}'],
  bdreview: ['{ep}: the breakdown is ready for you — Workbench → Episodes (approve it, or send it back with a note).',
    '{ep} 的镜头拆解好了，等你确认——工作台 → 分集（通过，或者写上意见退回）。',
    '{ep} 的鏡頭拆解好了，等你確認——工作台 → 分集（通過，或者寫上意見退回）。'],
  asset: ['{item} is needed by {shots} and has no reference images yet. Create it if it is missing (char.add / look.add / loc.add), then make its references (asset.gen or asset.save — a turnaround for a character). A person locks it once it looks right.',
    '{shots} 要用到 {item}，但它还没有参考图。缺就先建（char.add / look.add / loc.add），再出参考图（asset.gen 或 asset.save；角色要三视图）。看着对了由人来定稿。',
    '{shots} 要用到 {item}，但它還沒有參考圖。缺就先建（char.add / look.add / loc.add），再出參考圖（asset.gen 或 asset.save；角色要三視圖）。看著對了由人來定稿。'],
  lock: ['{item} has references and is waiting for you to lock it — Workbench → Bible. Shots waiting on it: {shots}.',
    '{item} 已有参考图，等你定稿——工作台 → 设定库。等它的镜头：{shots}。',
    '{item} 已有參考圖，等你定稿——工作台 → 設定庫。等它的鏡頭：{shots}。'],
  prompt: ['{shot}: write the Seedance prompt (shot.prompt) and generate (shot.gen).{talk}{failed}',
    '{shot}：写 Seedance 提示词（shot.prompt）并生成（shot.gen）。{talk}{failed}',
    '{shot}：寫 Seedance 提示詞（shot.prompt）並生成（shot.gen）。{talk}{failed}'],
  talk: [' It has on-camera dialogue: the studio adds the lines to the prompt and turns sound on — don\'t paste them yourself.',
    '这个镜头有出镜对白：片场会自动把台词加进提示词并打开声音，不用自己贴。',
    '這個鏡頭有出鏡對白：片場會自動把台詞加進提示詞並打開聲音，不用自己貼。'],
  failed: [' The last round failed: {errors}', '上一轮全部失败：{errors}', '上一輪全部失敗：{errors}'],
  fixprompt: ['{shot} was rejected (#{n}{by}): {reason} — write a new prompt version that fixes exactly this, then generate.',
    '{shot} 被打回（第 {n} 次{by}）：{reason}——写一个只改这一点的新版提示词，再生成。',
    '{shot} 被打回（第 {n} 次{by}）：{reason}——寫一個只改這一點的新版提示詞，再生成。'],
  fixasset: ['{shot} was rejected for its references (#{n}{by}): {reason} — fix the assets (a new reference, deprecate the wrong one), then close this order with order.done and a note on what changed. The cinematographer re-prompts after that.',
    '{shot} 因参考图被打回（第 {n} 次{by}）：{reason}——修好资产（补新参考图，把错的标成弃用），然后用 order.done 关掉这张工单，备注改了什么。之后摄影会重写提示词。',
    '{shot} 因參考圖被打回（第 {n} 次{by}）：{reason}——修好資產（補新參考圖，把錯的標成棄用），然後用 order.done 關掉這張工單，備註改了什麼。之後攝影會重寫提示詞。'],
  afterasset: ['{shot}: the references were fixed ({note}). Write a new prompt version with them, then generate. The rejection was: {reason}',
    '{shot}：参考图已修好（{note}）。用新参考图写新版提示词再生成。当时打回的理由：{reason}',
    '{shot}：參考圖已修好（{note}）。用新參考圖寫新版提示詞再生成。當時打回的理由：{reason}'],
  afterplan: ['{shot} was redefined after its rejection ({reason}). Write the prompt for the new design and generate.',
    '{shot} 打回后已重新定义（{reason}）。按新设计写提示词并生成。',
    '{shot} 打回後已重新定義（{reason}）。按新設計寫提示詞並生成。'],
  replan: ['{shot} was rejected for its design (#{n}{by}): {reason} — redefine it (shot.plan with the scene; split it if it needs to be).',
    '{shot} 因镜头设计被打回（第 {n} 次{by}）：{reason}——重新定义这个镜头（shot.plan，必要时拆成几个）。',
    '{shot} 因鏡頭設計被打回（第 {n} 次{by}）：{reason}——重新定義這個鏡頭（shot.plan，必要時拆成幾個）。'],
  byHuman: [', by a person', '，人工打回', '，人工打回'],
  reopened: [', a person reopened it', '，人重新交回', '，人重新交回'],
  review: ['{shot}: new takes are ready. Review them (shot.sheet, then shot.approve or shot.reject).',
    '{shot}：新候选已就绪。请审片（shot.sheet，然后 shot.approve 或 shot.reject）。',
    '{shot}：新候選已就緒。請審片（shot.sheet，然後 shot.approve 或 shot.reject）。'],
  final: ['{ep} is cut ({secs} s). Watch it in Workbench → Episodes and approve it, or send shots back.',
    '{ep} 已经剪好（{secs} 秒）。去工作台 → 分集看片，通过，或者把镜头打回。',
    '{ep} 已經剪好（{secs} 秒）。去工作台 → 分集看片，通過，或者把鏡頭打回。'],
  asmFailed: ['{ep}: putting the cut together failed — {error}', '{ep} 合成失败：{error}', '{ep} 合成失敗：{error}'],
}
export const say = (key, lang, vars = {}) => T[key][Math.max(0, LANGS.indexOf(lang))]
  .replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m))

const lc = s => String(s ?? '').trim().toLowerCase()
const OPEN_SHOT = ['planned', 'prompted']
const PAST_REVIEW = ['approved', 'locked']

/** What a shot needs from the bible: [{type:'char'|'loc', name, look}] */
export function itemsOf(def) {
  const out = []
  for (const c of Array.isArray(def?.characters) ? def.characters : []) {
    if (c?.name) out.push({ type: 'char', name: String(c.name).trim(), look: c.look ? String(c.look).trim() : '' })
  }
  if (def?.location) out.push({ type: 'loc', name: String(def.location).trim(), look: '' })
  return out
}
const itemKey = i => `${i.type}:${lc(i.name)}${i.look ? `/${lc(i.look)}` : ''}`
const itemLabel = i => `${i.name}${i.look ? ` / ${i.look}` : ''}`

/**
 * Where an item stands: 'missing' (no row, or no references), 'draft' (references, not locked),
 * 'locked'. A look stands on its own; a character without a look is locked when the character is.
 */
export function itemState(i, bible) {
  if (i.type === 'loc') {
    const l = bible.locs[lc(i.name)]
    if (!l || !l.refs) return 'missing'
    return l.status === 'locked' ? 'locked' : 'draft'
  }
  const c = bible.chars[lc(i.name)]
  if (!c) return 'missing'
  if (i.look) {
    const k = c.looks[lc(i.look)]
    if (!k || !k.refs) return 'missing'
    return k.status === 'locked' || c.status === 'locked' && k.status === 'locked' ? 'locked' : 'draft'
  }
  if (!c.refs) return 'missing'
  return c.status === 'locked' ? 'locked' : 'draft'
}

/**
 * The orders this state needs, the episode moves it implies, and the cuts to make.
 * snap: {lang, episodes, shots, bible, orders: Map(key → {status, note}), assemblies: Map(episode_id → latest)}
 */
export function needs(snap) {
  const { lang = 'en' } = snap
  const orders = [], moves = [], cuts = []
  const want = o => orders.push(o)
  const by = r => (r?.reviewer === 'human' ? say('byHuman', lang) : '')

  for (const ep of snap.episodes) {
    const title = ep.title ? (lang === 'en' ? ` "${ep.title}"` : `《${ep.title}》`) : ''
    if (ep.stage === 'breakdown') want({ role: 'director', kind: 'breakdown', episode_id: ep.id, subject: ep.code,
      key: `breakdown:${lc(ep.code)}:${ep.rev}`,
      body: say('breakdown', lang, { ep: ep.code, title, note: ep.note ? say('note', lang, { note: ep.note }) : '' }) })
    if (ep.stage === 'breakdown_review') want({ role: 'human', kind: 'bdreview', episode_id: ep.id, subject: ep.code,
      key: `bdreview:${lc(ep.code)}:${ep.rev}`, body: say('bdreview', lang, { ep: ep.code }) })
    if (ep.stage !== 'production' && ep.stage !== 'final_review') continue
    const shots = snap.shots.filter(s => s.episode_id === ep.id)

    if (ep.stage === 'production') {
      // The bible first: what these shots need, and what state it is in.
      const needers = new Map()
      for (const s of shots) {
        if (PAST_REVIEW.includes(s.status)) continue
        for (const i of itemsOf(s.def)) {
          const k = itemKey(i)
          if (!needers.has(k)) needers.set(k, { item: i, shots: [] })
          needers.get(k).shots.push(s.code)
        }
      }
      for (const [k, { item, shots: codes }] of needers) {
        const st = itemState(item, snap.bible)
        const list = codes.slice(0, 6).join(', ') + (codes.length > 6 ? ` +${codes.length - 6}` : '')
        if (st === 'missing') want({ role: 'art', kind: 'asset', episode_id: ep.id, subject: itemLabel(item),
          key: `asset:${k}`, body: say('asset', lang, { item: itemLabel(item), shots: list }) })
        if (st === 'draft') want({ role: 'human', kind: 'lock', episode_id: ep.id, subject: itemLabel(item),
          key: `lock:${k}`, body: say('lock', lang, { item: itemLabel(item), shots: list }) })
      }
      // Shots whose bible is all locked, waiting for a prompt. A shot that was rejected is the
      // rejection's business (below), not this.
      for (const s of shots) {
        if (!OPEN_SHOT.includes(s.status) || s.reject_count) continue
        if (!itemsOf(s.def).every(i => itemState(i, snap.bible) === 'locked')) continue
        const talk = (s.def?.dialogue ?? []).some(l => l.kind === 'onscreen') ? say('talk', lang) : ''
        const failed = s.failed_errors?.length ? say('failed', lang, { errors: [...new Set(s.failed_errors)].join('; ').slice(0, 300) }) : ''
        want({ role: 'cinematographer', kind: 'prompt', episode_id: ep.id, subject: s.code,
          key: `prompt:${lc(s.code)}:${s.prompt_version}:${s.rounds}`, body: say('prompt', lang, { shot: s.code, talk, failed }) })
      }
    }

    // Every shot approved: the cut. The same set of takes is cut once.
    if (shots.length && shots.every(s => PAST_REVIEW.includes(s.status) && s.pick)) {
      const sig = shots.map(s => `${s.code}=${s.pick}`).join(',')
      const a = snap.assemblies.get(ep.id)
      if (!a || a.sig !== sig) cuts.push({ episode_id: ep.id, sig })
      else if (a.status === 'done') {
        if (ep.stage === 'production') moves.push({ id: ep.id, to: 'final_review' })
        want({ role: 'human', kind: 'final', episode_id: ep.id, subject: ep.code, key: `final:${lc(ep.code)}:${a.id}`,
          body: say('final', lang, { ep: ep.code, secs: Math.round((a.duration_ms ?? 0) / 1000) }) })
      } else if (a.status === 'failed')
        want({ role: 'human', kind: 'asmfailed', episode_id: ep.id, subject: ep.code, key: `asmfailed:${lc(ep.code)}:${a.id}`,
          body: say('asmFailed', lang, { ep: ep.code, error: String(a.error).slice(0, 300) }) })
    } else if (ep.stage === 'final_review') moves.push({ id: ep.id, to: 'production' })   // a shot was sent back
  }

  // Review and rejections, for every shot — with or without an episode.
  for (const s of snap.shots) {
    if (s.status === 'review') want({ role: 'reviewer', kind: 'review', episode_id: s.episode_id, subject: s.code,
      key: `review:${lc(s.code)}:${s.last_round}`, body: say('review', lang, { shot: s.code }) })
    // A rejected shot stays the rejection's business until it is generated again: rejected (fix
    // it), then planned / prompted (the fix is under way, the cinematographer still has to generate).
    const r = s.last_review
    if (!r || r.verdict === 'approve' || !['rejected', 'prompted', 'planned'].includes(s.status)) continue
    // The 3rd rejection belongs to a person (notify.mjs tells them); a person reopening it gives it back.
    if (r.verdict === 'reject' && r.attempt >= REJECTS_TO_HUMAN) continue
    const n = r.verdict === 'reopen' ? `r${r.id}` : r.attempt
    const k = `fix:${lc(s.code)}:${n}`
    const how = r.verdict === 'reopen' ? say('reopened', lang) : by(r)
    const vars = { shot: s.code, n: r.verdict === 'reopen' ? s.reject_count : r.attempt, by: how, reason: String(r.reason).slice(0, 600) }
    const cine = (key, body) => want({ role: 'cinematographer', kind: 'fixprompt', episode_id: s.episode_id, subject: s.code, key, body })
    if (r.route === 'prompt') cine(k, say('fixprompt', lang, vars))
    if (r.route === 'plan') {
      if (s.status === 'rejected') want({ role: 'director', kind: 'replan', episode_id: s.episode_id, subject: s.code, key: k, body: say('replan', lang, vars) })
      else cine(`${k}:prompt`, say('afterplan', lang, vars))
    }
    if (r.route === 'asset') {
      const fixed = snap.orders.get(k)
      if (fixed?.status === 'done' || s.status !== 'rejected') cine(`${k}:prompt`, say('afterasset', lang, { ...vars, note: fixed?.note || '—' }))
      else want({ role: 'art', kind: 'fixasset', episode_id: s.episode_id, subject: s.code, key: k, body: say('fixasset', lang, vars) })
    }
  }
  return { orders, moves, cuts }
}

// Kinds only the agent can close — the studio can't see "the references are better now".
export const CLOSED_BY_AGENT = new Set(['fixasset'])

// ---------- the database side ----------
async function snapshot(db, pid) {
  const p = await db.getProject(pid)
  const episodes = (await db.q('select * from episodes where project_id = $1 order by ord, created_at', [pid])).rows
  const shots = (await db.q(`
    select s.code, s.status, s.def, s.prompt_version, s.reject_count, sc.episode_id,
           (select c.n from candidates c where c.shot_id = s.id and c.asset_id = s.pick_asset_id) as pick,
           (select count(distinct g.round)::int from generations g where g.shot_id = s.id and g.round <> '') as rounds,
           (select g.round from generations g where g.shot_id = s.id and g.round <> '' order by g.created_at desc limit 1) as last_round,
           (select json_build_object('id', r.id, 'verdict', r.verdict, 'route', r.route, 'reason', r.reason, 'attempt', r.attempt, 'reviewer', r.reviewer)
              from reviews r where r.shot_id = s.id order by r.id desc limit 1) as last_review
      from shots s join scenes sc on sc.id = s.scene_id where s.project_id = $1 order by sc.ord, s.ord`, [pid])).rows
  // The errors of a round that failed entirely, so the next prompt order can say why.
  for (const s of shots) {
    if (s.status !== 'prompted' || !s.last_round) continue
    const g = (await db.q(`select g.status, g.error from generations g join shots x on x.id = g.shot_id
      where x.project_id = $1 and lower(x.code) = lower($2) and g.round = $3`, [pid, s.code, s.last_round])).rows
    if (g.length && g.every(x => x.status === 'failed')) s.failed_errors = g.map(x => x.error)
  }
  const chars = {}, locs = {}
  for (const c of (await db.q(`select c.id, c.name, c.status,
      (select count(*)::int from assets a where a.character_id = c.id and a.status = 'active' and a.kind = 'turnaround') as refs
      from characters c where c.project_id = $1`, [pid])).rows) chars[lc(c.name)] = { ...c, looks: {} }
  for (const l of (await db.q(`select l.name, l.status, c.name as cname,
      (select count(*)::int from assets a where a.look_id = l.id and a.status = 'active' and a.kind = 'turnaround') as refs
      from looks l join characters c on c.id = l.character_id where c.project_id = $1`, [pid])).rows) chars[lc(l.cname)].looks[lc(l.name)] = l
  for (const l of (await db.q(`select l.name, l.status,
      (select count(*)::int from assets a where a.location_id = l.id and a.status = 'active' and a.kind <> 'negative') as refs
      from locations l where l.project_id = $1`, [pid])).rows) locs[lc(l.name)] = l
  const orders = new Map((await db.q('select key, status, note from orders where project_id = $1', [pid])).rows.map(o => [o.key, o]))
  const assemblies = new Map((await db.q(`select distinct on (episode_id) a.id, a.episode_id, a.sig, a.status, a.error, v.duration_ms
      from assemblies a left join assets v on v.id = a.video_asset_id where a.project_id = $1 order by episode_id, a.created_at desc`, [pid])).rows
    .map(a => [a.episode_id, a]))
  return { lang: p?.info?.lang ?? 'en', episodes, shots, bible: { chars, locs }, orders, assemblies }
}

const running = new Set()
/**
 * Bring a project's orders in line with its state. Safe to call often and concurrently (one pass
 * per project at a time; the unique key makes an insert race harmless). Returns what changed.
 */
export async function plan(pid, { kick = () => {} } = {}) {
  if (running.has(pid)) return null
  running.add(pid)
  const db = await dbx()
  try {
    const snap = await snapshot(db, pid)
    const { orders, moves, cuts } = needs(snap)
    const wanted = new Set(orders.map(o => o.key))
    let added = 0
    for (const o of orders) {
      const r = await db.q(`insert into orders (project_id, episode_id, role, kind, key, subject, body)
        values ($1,$2,$3,$4,$5,$6,$7) on conflict (project_id, key) do nothing`,
        [pid, o.episode_id ?? null, o.role, o.kind, o.key, o.subject, o.body])
      added += r.rowCount
    }
    // A need that is gone closes its order: done if someone was told (they did it), cancelled if
    // it went away before anyone was. Orders only an agent can close stay until it does.
    let closed = 0
    for (const [key, o] of snap.orders) {
      if (wanted.has(key) || !['open', 'sent', 'stuck'].includes(o.status)) continue
      const r = await db.q(`update orders set status = case when status = 'open' then 'cancelled' else 'done' end, done_at = now()
        where project_id = $1 and key = $2 and status in ('open','sent','stuck') and not (kind = any($3) and status = 'sent')`,
        [pid, key, [...CLOSED_BY_AGENT]])
      closed += r.rowCount
    }
    for (const m of moves) await db.q('update episodes set stage = $2, updated_at = now() where id = $1 and stage <> $2', [m.id, m.to])
    for (const c of cuts) {
      const busy = (await db.q(`select 1 from assemblies where episode_id = $1 and sig = $2`, [c.episode_id, c.sig])).rowCount
      if (!busy) { await db.q(`insert into assemblies (id, project_id, episode_id, sig, requested_by) values ($1,$2,$3,$4,'studio')`,
        [db.newId('asm'), pid, c.episode_id, c.sig]); kick() }
    }
    return { added, closed, moves: moves.length, cuts: cuts.length }
  } finally { running.delete(pid) }
}

/** Every project with something in flight — the worker's tick calls this. */
export async function planAll(opts) {
  const db = await dbx()
  const { rows } = await db.q(`select id from projects p where exists (select 1 from episodes e where e.project_id = p.id and e.stage not in ('draft','done'))
    or exists (select 1 from shots s where s.project_id = p.id and s.status in ('review','rejected'))
    or exists (select 1 from orders o where o.project_id = p.id and o.status in ('open','sent','stuck'))`)
  for (const r of rows) await plan(r.id, opts).catch(e => console.error(`pipeline: ${r.id}: ${e.message}`))
}

// ---------- self-test ----------
if (import.meta.url === `file://${process.argv[1]}`) {
  const a = await import('node:assert/strict')
  const E = { id: 'e1', code: 'E01', title: '初见', stage: 'production', rev: 0, note: '' }
  const shot = (code, over = {}) => ({ code, status: 'planned', episode_id: 'e1', prompt_version: 0, reject_count: 0, rounds: 0,
    def: { characters: [{ name: '蛮吉', look: '战斗装' }], location: '断崖' }, ...over })
  const bible = (charLook, loc) => ({
    chars: { 蛮吉: { name: '蛮吉', status: 'draft', refs: 1, looks: { 战斗装: { name: '战斗装', status: charLook.status, refs: charLook.refs } } } },
    locs: loc ? { 断崖: { name: '断崖', status: loc.status, refs: loc.refs } } : {},
  })
  const snap = over => ({ lang: 'zh-Hans', episodes: [E], shots: [shot('S01-SH001')], orders: new Map(), assemblies: new Map(),
    bible: bible({ status: 'draft', refs: 0 }, null), ...over })

  // Missing references → art; nothing for the cinematographer yet.
  let n = needs(snap())
  a.deepEqual(n.orders.map(o => [o.role, o.key]), [['art', 'asset:char:蛮吉/战斗装'], ['art', 'asset:loc:断崖']])
  a.match(n.orders[0].body, /S01-SH001 要用到 蛮吉 \/ 战斗装/)
  // References exist, not locked → a person, still no prompt.
  n = needs(snap({ bible: bible({ status: 'draft', refs: 2 }, { status: 'draft', refs: 1 }) }))
  a.deepEqual(n.orders.map(o => [o.role, o.kind]), [['human', 'lock'], ['human', 'lock']])
  // All locked → the cinematographer, and the dialogue note when someone speaks on camera.
  const locked = bible({ status: 'locked', refs: 2 }, { status: 'locked', refs: 1 })
  n = needs(snap({ bible: locked, shots: [shot('S01-SH001', { def: { ...shot('x').def, dialogue: [{ kind: 'onscreen', speaker: '蛮吉', text: '走' }] } })] }))
  a.deepEqual(n.orders.map(o => [o.role, o.key]), [['cinematographer', 'prompt:s01-sh001:0:0']])
  a.match(n.orders[0].body, /出镜对白/)
  // A failed round: a new order (the key moves with the rounds) that says why.
  n = needs(snap({ bible: locked, shots: [shot('S01-SH001', { status: 'prompted', prompt_version: 1, rounds: 1, failed_errors: ['blocked', 'blocked'] })] }))
  a.equal(n.orders[0].key, 'prompt:s01-sh001:1:1'); a.match(n.orders[0].body, /上一轮全部失败：blocked$/)
  // A draft episode, or one in breakdown review, asks nothing of the crew.
  a.deepEqual(needs(snap({ episodes: [{ ...E, stage: 'draft' }] })).orders, [])
  a.deepEqual(needs(snap({ episodes: [{ ...E, stage: 'breakdown_review' }] })).orders.map(o => o.role), ['human'])
  const bd = needs(snap({ episodes: [{ ...E, stage: 'breakdown', rev: 2, note: '第二场太长' }], shots: [] })).orders[0]
  a.equal(bd.key, 'breakdown:e01:2'); a.match(bd.body, /《初见》[\s\S]*上一版人给的意见：第二场太长/)

  // Review, and rejections by route; the 3rd goes nowhere (a person has it).
  const rev = (over) => shot('S01-SH002', { status: 'rejected', reject_count: 1, last_review: { id: 7, verdict: 'reject', route: 'prompt', reason: '头发颜色不对', attempt: 1, reviewer: 'agent:r' }, ...over })
  n = needs(snap({ bible: locked, shots: [shot('S01-SH001', { status: 'review', last_round: 'rd_1' }), rev()] }))
  a.deepEqual(n.orders.map(o => [o.role, o.key]), [['reviewer', 'review:s01-sh001:rd_1'], ['cinematographer', 'fix:s01-sh002:1']])
  a.equal(needs(snap({ shots: [rev({ last_review: { id: 8, verdict: 'reject', route: 'prompt', reason: 'x', attempt: 3 } })] })).orders.filter(o => o.kind === 'fixprompt').length, 0)
  n = needs(snap({ bible: locked, shots: [rev({ last_review: { id: 9, verdict: 'reject', route: 'asset', reason: '发型不对', attempt: 2, reviewer: 'human' } })] }))
  a.deepEqual(n.orders.map(o => [o.role, o.kind]), [['art', 'fixasset']])
  a.match(n.orders[0].body, /第 2 次，人工打回/)
  n = needs(snap({ bible: locked, orders: new Map([['fix:s01-sh002:2', { status: 'done', note: '补了侧面' }]]),
    shots: [rev({ last_review: { id: 9, verdict: 'reject', route: 'asset', reason: '发型不对', attempt: 2 } })] }))
  a.deepEqual(n.orders.map(o => [o.role, o.key]), [['cinematographer', 'fix:s01-sh002:2:prompt']], 'after art closes it, the cinematographer')
  a.match(n.orders[0].body, /补了侧面/)
  n = needs(snap({ bible: locked, shots: [rev({ reject_count: 3, last_review: { id: 12, verdict: 'reopen', route: 'plan', reason: '拆成两镜', attempt: 3 } })] }))
  a.deepEqual(n.orders.map(o => [o.role, o.key]), [['director', 'fix:s01-sh002:r12']], 'a person reopening a 3-times rejected shot')
  // The fix is under way but not generated yet: still the cinematographer's, never forgotten.
  n = needs(snap({ bible: locked, shots: [rev({ status: 'prompted', prompt_version: 2 })] }))
  a.deepEqual(n.orders.map(o => [o.role, o.key]), [['cinematographer', 'fix:s01-sh002:1']])
  n = needs(snap({ bible: locked, shots: [rev({ status: 'planned', last_review: { id: 9, verdict: 'reject', route: 'plan', reason: '动作太多', attempt: 1 } })] }))
  a.deepEqual(n.orders.map(o => [o.role, o.key]), [['cinematographer', 'fix:s01-sh002:1:prompt']], 'replanned → the cinematographer')

  // Everything approved → one cut; once it's done → final review and a person told.
  const done = [shot('S01-SH001', { status: 'approved', pick: 2 }), shot('S01-SH002', { status: 'locked', pick: 1 })]
  n = needs(snap({ shots: done }))
  a.deepEqual(n.cuts, [{ episode_id: 'e1', sig: 'S01-SH001=2,S01-SH002=1' }])
  n = needs(snap({ shots: done, assemblies: new Map([['e1', { id: 'asm_1', sig: 'S01-SH001=2,S01-SH002=1', status: 'done', duration_ms: 9400 }]]) }))
  a.deepEqual(n.moves, [{ id: 'e1', to: 'final_review' }]); a.equal(n.cuts.length, 0)
  a.deepEqual(n.orders.map(o => [o.role, o.key]), [['human', 'final:e01:asm_1']]); a.match(n.orders[0].body, /9 秒/)
  // A person sends a shot back from the final review → production again, and the cut is redone later.
  n = needs(snap({ episodes: [{ ...E, stage: 'final_review' }], shots: [done[0], rev()] }))
  a.deepEqual(n.moves, [{ id: 'e1', to: 'production' }])
  a.equal(needs({ ...snap({ shots: done }), lang: 'en', assemblies: new Map([['e1', { id: 'a', sig: 'S01-SH001=2,S01-SH002=1', status: 'failed', error: 'boom' }]]) }).orders[0].body,
    'E01: putting the cut together failed — boom')

  a.deepEqual(itemsOf({ characters: [{ name: ' A ' }], location: 'L' }), [{ type: 'char', name: 'A', look: '' }, { type: 'loc', name: 'L', look: '' }])
  console.log('pipeline.mjs: all checks passed')
}
