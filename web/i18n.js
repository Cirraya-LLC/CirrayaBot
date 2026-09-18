// Interface text in three languages: English (default), Simplified and
// Traditional Chinese. Each entry is [en, zh-Hans, zh-Hant]; `{name}` in the
// text is replaced from `vars`.
//
// Static markup uses data-i18n="key" (text), data-i18n-placeholder,
// data-i18n-title and data-i18n-aria-label; applyDom() fills them in.

export const LANGS = ['en', 'zh-Hans', 'zh-Hant']
export const LANG_NAMES = { en: 'English', 'zh-Hans': '简体中文', 'zh-Hant': '繁體中文' }

const M = {
  // shared
  'common.save': ['Save', '保存', '儲存'],
  'common.cancel': ['Cancel', '取消', '取消'],
  'common.delete': ['Delete', '删除', '刪除'],
  'common.close': ['Close', '关闭', '關閉'],
  'common.new': ['＋ New', '＋ 新的', '＋ 新增'],
  'common.import': ['Import', '导入', '匯入'],
  'common.edit': ['Edit', '编辑', '編輯'],
  'common.editNamed': ['Edit “{name}”', '编辑「{name}」', '編輯「{name}」'],
  'common.saving': ['Saving…', '保存中…', '儲存中…'],
  'common.sep': [', ', '、', '、'],
  'common.quote': ['“{s}”', '「{s}」', '「{s}」'],
  'common.language': ['Language', '语言', '語言'],
  'err.backend': ['Cannot reach the backend: {msg}', '连不上后端：{msg}', '無法連線到後端：{msg}'],

  // left column
  'side.search': ['Search', '搜索', '搜尋'],
  'side.newGroup': ['New group', '新建群聊', '新增群組'],
  'side.newAgent': ['New Agent', '新建 Agent', '新增 Agent'],
  'side.providers': ['Model providers', '模型上游', '模型上游'],
  'side.noMatch': ['No matching conversations', '没有匹配的会话', '沒有符合的對話'],
  'side.noMessages': ['No messages yet', '还没说过话', '還沒有訊息'],

  // header / composer
  'head.pick': ['Pick a conversation', '选一个会话', '選擇一個對話'],
  'head.pickSub': ['Click one on the left, or ＋ to start a group', '左边点一个，或者点 ＋ 拉个群', '點選左邊的對話，或按 ＋ 建立群組'],
  'head.groupSub': ['{members} — they see each other’s messages and hand off with @', '{members} — 他们看得到彼此说的话，会互相 @ 接力', '{members} — 他們看得到彼此的訊息，會互相 @ 接力'],
  'head.toggle': ['Toggle right panel', '收起右栏', '收合右側欄'],
  'comp.memory': ['Memory', '记忆', '記憶'],
  'comp.pick': ['Pick a conversation to start typing', '选一个会话再说话', '先選擇一個對話再輸入'],
  'comp.toGroup': ['Message {name}', '发到 {name}', '傳送到 {name}'],
  'comp.toAgent': ['Message {name}', '发给 {name}', '傳送給 {name}'],
  'empty.groupMembers': ['{members} are in this group.', '{members} 在这个群里。', '{members} 在這個群組裡。'],
  'empty.groupHow': ['They see what everyone says and @ whoever should take over — moving things forward like colleagues.', '他们看得到彼此说了什么，谁该接手就 @ 谁 —— 像同事一样往下推进。', '他們看得到彼此說了什麼，該誰接手就 @ 誰 —— 像同事一樣往下推進。'],
  'empty.agentRecall': ['They remember what you talked about in groups.', '他记得你们在群里聊过什么。', '他記得你們在群組裡聊過什麼。'],

  // messages
  'msg.you': ['Me', '你', '你'],
  'tool.exec': ['ran', '执行', '執行'],
  'tool.read': ['Read {path}', '读 {path}', '讀取 {path}'],
  'tool.write': ['Write {path}', '写 {path}', '寫入 {path}'],
  'tool.screenshot': ['Screenshot', '截图', '螢幕截圖'],
  'note.retry': ['{name} retrying: {reason}', '{name} 重试一次：{reason}', '{name} 重試一次：{reason}'],
  'note.trim': ['Context was too long; dropped the {n} oldest messages', '上下文放不下，省掉了最早的 {n} 条', '上下文放不下，省略了最早的 {n} 則'],

  // browser actions
  'ba.prefix': ['Browser · ', '浏览器 · ', '瀏覽器 · '],
  'ba.open': ['Open {url}', '打开 {url}', '開啟 {url}'],
  'ba.read': ['Read page', '读页面', '讀取頁面'],
  'ba.back': ['Back', '后退', '上一頁'],
  'ba.click': ['Click {target}', '点 {target}', '點擊 {target}'],
  'ba.type': ['Type {text} into #{index}', '在 #{index} 填{text}', '在 #{index} 輸入{text}'],
  'ba.enter': [' + Enter', ' 回车', ' Enter'],
  'ba.press': ['Press {key}', '按 {key}', '按 {key}'],
  'ba.scroll': ['Scroll', '滚动', '捲動'],
  'ba.eval': ['Run JS', '执行 JS', '執行 JS'],

  // right column
  's2.members': ['Members', '成员', '成員'],
  's2.addMember': ['Add member', '添加成员', '新增成員'],
  's2.lead': ['Lead', '负责人', '負責人'],
  's2.remove': ['Remove', '移出', '移出'],
  's2.browser': ['Browser', '浏览器', '瀏覽器'],
  's2.routines': ['Scheduled tasks', '定时任务', '排程任務'],
  's2.addRoutine': ['New scheduled task', '新建定时任务', '新增排程任務'],
  's2.exportChat': ['Export chat', '导出聊天记录', '匯出聊天紀錄'],
  'mem.title': ['Memory', '记忆', '記憶'],
  'mem.groupTitle': ['Group memory of {name} — everyone in the group reads it', '{name} 的群记忆 — 群里每个人都读得到', '{name} 的群組記憶 — 群組裡每個人都讀得到'],
  'mem.agentTitle': ['{name}’s memory — carried in DMs and in every group they’re in', '{name} 的记忆 — 私聊和他在的群里都带着', '{name} 的記憶 — 私訊和他所在的群組都會帶著'],
  'mem.groupPh': ['Long-term notes for this group; everyone reads them every turn', '写给这个群的长期备忘，群里每个人每一轮都会读到', '寫給這個群組的長期備忘，群組裡每個人每一輪都會讀到'],
  'mem.agentPh': ['Long-term notes for them; read every turn', '写给他的长期备忘，每一轮都会读到', '寫給他的長期備忘，每一輪都會讀到'],
  'mem.failed': ['Not saved: {msg}', '没保存上：{msg}', '沒有儲存成功：{msg}'],
  'mem.offline': ['Cannot reach the server', '连不上服务器', '無法連線到伺服器'],
  'mem.saved': ['Saved {time}', '已保存 {time}', '已儲存 {time}'],

  // import / export
  'x.notJson': ['This file is not JSON', '这个文件不是 JSON', '這個檔案不是 JSON'],
  'x.append': ['Append {n} messages after the existing history of “{where}”?', '把 {n} 条追加到「{where}」现有记录的后面？', '把 {n} 則追加到「{where}」現有紀錄的後面？'],
  'x.replace': ['Replace instead: delete all current history of “{where}” and use these {n} messages?', '改成替换：删掉「{where}」现在的全部记录，换成这 {n} 条？', '改成取代：刪除「{where}」目前的全部紀錄，換成這 {n} 則？'],

  // group dialog
  'g.new': ['New group', '新建群聊', '新增群組'],
  'g.namePh': ['Group name, e.g. “Product team”', '群名字，比如「产品小组」', '群組名稱，例如「產品小組」'],
  'g.leadHint': ['Lead: when you don’t @ anyone they answer first, split the work among colleagues and report back to you.', '负责人：你没点名的时候由他先接话，拆活、分给同事、最后汇总给你。', '負責人：你沒點名時由他先接話、拆分工作、分派給同事，最後彙整給你。'],
  'g.noLead': ['None (whoever is listed first answers first)', '不指定（排在最前面的先接话）', '不指定（排在最前面的先接話）'],
  'g.disband': ['Disband', '解散', '解散'],
  'g.create': ['Create', '创建', '建立'],
  'g.invalid': ['A group needs a name and at least two members', '群要有名字，而且至少两个成员', '群組需要名稱，且至少兩位成員'],
  'g.confirmDisband': ['Disband “{name}”? Files in the shared drive are kept.', '解散「{name}」？共享盘里的文件不会删。', '解散「{name}」？共用空間裡的檔案不會刪除。'],

  // agent dialog
  'b.new': ['New Agent', '新建 Agent', '新增 Agent'],
  'b.edit': ['Edit {name}', '编辑 {name}', '編輯 {name}'],
  'b.namePh': ['Name, e.g. “Lin”', '名字，比如「小林」', '名字，例如「小林」'],
  'b.descPh': ['One-line role (the small tag in the list)', '一句话职责（列表里那个小标签）', '一句話職責（列表裡的小標籤）'],
  'b.personaPh': ['Who they are, what they own, how they work, and what they must not decide alone.\nThe more specific, the more human.', '他是谁、负责什么、怎么工作、哪些事不能自己拍板。\n写得越具体，他越像个人。', '他是誰、負責什麼、怎麼工作、哪些事不能自己決定。\n寫得越具體，他越像個人。'],
  'b.provTitle': ['Which model provider to use', '用哪个模型上游', '使用哪個模型上游'],
  'b.modelTitle': ['Which model to use (listed from the provider’s /models)', '用哪个模型（从上游的 /models 列出来）', '使用哪個模型（從上游的 /models 列出）'],
  'b.modelPh': ['This provider gives no model list — type the model name', '这个上游不给模型列表，手填模型名', '這個上游不提供模型列表，請手動輸入模型名稱'],
  'b.defaultProv': ['Default provider', '默认上游', '預設上游'],
  'b.defaultProvNamed': ['Default provider ({name})', '默认上游（{name}）', '預設上游（{name}）'],
  'b.loadingModels': ['Asking the provider for models…', '正在问上游有哪些模型…', '正在向上游查詢模型…'],
  'b.unlisted': [' (no longer listed)', '（上游已不列出）', '（上游已不再列出）'],
  'b.needName': ['Name and persona are both required', '名字和人设都要填', '名字和人設都必須填寫'],
  'b.needModel': ['Pick a model', '要选一个模型', '請選擇一個模型'],
  'b.confirmDelete': ['Delete {name}? What they made stays in their own container.', '删掉 {name}？他做过的东西留在自己的容器里。', '刪除 {name}？他做過的東西會留在自己的容器裡。'],

  // provider dialog
  'p.title': ['Model providers', '模型上游', '模型上游'],
  'p.add': ['Add a provider', '加一个上游', '新增上游'],
  'p.namePh': ['Any name, e.g. “Company gateway”', '名字，随便起，比如「公司网关」', '名稱，隨意取，例如「公司閘道」'],
  'p.protoTitle': ['Which API the provider speaks', '上游说的是哪种接口', '上游使用哪種介面'],
  'p.urlPh': ['API base URL up to /v1, e.g. https://api.openai.com/v1', '接口地址，到 /v1 为止，比如 https://api.openai.com/v1', '介面網址，到 /v1 為止，例如 https://api.openai.com/v1'],
  'p.keyPh': ['API Key (leave empty when editing = unchanged)', 'API Key（编辑时留空 = 不改）', 'API Key（編輯時留空 = 不變更）'],
  'p.keySaved': ['Saved {hint} (empty = unchanged)', '已保存 {hint}（留空 = 不改）', '已儲存 {hint}（留空 = 不變更）'],
  'p.ctxAuto': ['Context: auto', '上下文自动', '上下文自動'],
  'p.ctxManual': ['Manual', '手动', '手動'],
  'p.test': ['Test connection', '测试连接', '測試連線'],
  'p.hint': ['Models are picked in “Edit Agent”. Auto context = ask /models for each Agent’s model, falling back to guessing from the model name.', '模型在「编辑 Agent」里选。上下文自动＝按每个 Agent 选的模型去问 /models，问不到按模型名推断。', '模型在「編輯 Agent」裡選擇。上下文自動＝依每個 Agent 選的模型查詢 /models，查不到就依模型名稱推斷。'],
  'p.empty': ['No providers yet — add one below so Agents can talk.', '还没有上游 —— 在下面加一个，Agent 才能说话。', '還沒有上游 —— 在下方新增一個，Agent 才能說話。'],
  'p.inUse': ['In use', '正在用', '使用中'],
  'p.makeDefault': ['Click to make default', '点这里设为默认', '點這裡設為預設'],
  'p.auto': ['auto context', '上下文自动', '上下文自動'],
  'p.ctxTokens': ['Context {n} tokens — {src}', '上下文 {n} tokens — {src}', '上下文 {n} tokens — {src}'],
  'p.connecting': ['Connecting…', '连接中…', '連線中…'],
  'p.ok': ['Connected in {ms}ms, {models} models listed, tried {model} and it replied “{reply}”', '通了，{ms}ms，列出 {models} 个模型，拿 {model} 试了一句，回「{reply}」', '連線成功，{ms}ms，列出 {models} 個模型，用 {model} 試了一句，回覆「{reply}」'],
  'p.fail': ['Cannot connect: {error}', '连不上：{error}', '無法連線：{error}'],
  'p.needFields': ['Name and API URL are both required', '名字和接口地址都要填', '名稱和介面網址都必須填寫'],
  'p.saveFailed': ['Save failed', '保存失败', '儲存失敗'],
  'p.saved': ['Saved — {info}', '已保存 — {info}', '已儲存 — {info}'],
  'p.ctxShort': ['context {n} tokens', '上下文 {n} tokens', '上下文 {n} tokens'],
  'p.confirmDelete': ['Delete provider “{name}”?', '删掉上游「{name}」？', '刪除上游「{name}」？'],
  'p.first': ['Configure a model provider first so Agents can talk.', '先配一个模型上游，Agent 才能说话。', '請先設定一個模型上游，Agent 才能說話。'],

  // browser takeover
  'bw.back': ['← Back', '← 返回', '← 返回'],
  'bw.urlPh': ['URL, press Enter to open', '网址，回车打开', '網址，按 Enter 開啟'],
  'bw.nav': ['Back', '后退', '上一頁'],
  'bw.reload': ['Reload', '刷新', '重新整理'],
  'bw.alt': ['Browser view', '浏览器画面', '瀏覽器畫面'],
  'bw.altNamed': ['{name}’s browser', '{name} 的浏览器', '{name} 的瀏覽器'],
  'bw.takeOver': ['Open to take over', '点开接手', '點開接手'],
  'bw.notOpen': ['Their browser isn’t open yet', '他还没打开浏览器', '他還沒開啟瀏覽器'],
  'bw.open': ['Open', '打开', '開啟'],
  'bw.note': ['Click the view to hand the keyboard to the browser · you and {name} share the same browser', '点一下画面，键盘就交给浏览器 · 你和 {name} 用的是同一个浏览器', '點一下畫面，鍵盤就交給瀏覽器 · 你和 {name} 使用同一個瀏覽器'],
  'bw.offNote': ['Their browser isn’t open yet — enter a URL above to open it; they’ll use it too.', '他还没打开浏览器 —— 在上面输入网址打开，他之后也会用这个。', '他還沒開啟瀏覽器 —— 在上方輸入網址開啟，他之後也會使用這個。'],

  // scheduled tasks
  'r.new': ['New scheduled task', '新建定时任务', '新增排程任務'],
  'r.namePh': ['Name, e.g. “Morning brief”', '名字，比如「每日早报」', '名稱，例如「每日晨報」'],
  'r.promptPh': ['What to send when it fires, e.g.:\nLook at the files in /work changed yesterday and write a three-line progress note.', '到点时发给他的话，比如：\n看一下 /work 里昨天改过的文件，写一份三行的进展。', '時間到時傳給他的話，例如：\n看一下 /work 裡昨天改過的檔案，寫一份三行的進度。'],
  'r.kindDaily': ['Every day / fixed time on chosen weekdays', '每天 / 每周几的固定时间', '每天 / 每週幾的固定時間'],
  'r.kindInterval': ['Every so often', '每隔一段时间', '每隔一段時間'],
  'r.kindOnce': ['Once', '只一次', '只執行一次'],
  'r.everyUnit': ['minutes (at least 5)', '分钟一次（至少 5 分钟）', '分鐘一次（至少 5 分鐘）'],
  'r.enabled': ['Enabled', '启用', '啟用'],
  'r.runNow': ['Run now', '现在跑一次', '立即執行一次'],
  'r.who': ['Fires into “{name}” as if you sent this message here.', '到点时发到「{name}」，就像你在这里发了这条消息。', '時間到時傳到「{name}」，就像你在這裡傳了這則訊息。'],
  'r.whoGroup': [' To choose who answers first, @ them in the text.', '想指定谁先接，就在里面 @ 他。', '想指定誰先接，就在裡面 @ 他。'],
  'r.whoCost': [' It spends model money even when nobody is watching.', '没人看着的时候它也在花模型的钱。', '沒人看著的時候它也在花模型的錢。'],
  'r.lastRun': ['Last run {time}: {result}', '上次运行 {time}：{result}', '上次執行 {time}：{result}'],
  'r.failedWith': ['failed — {err}', '失败 — {err}', '失敗 — {err}'],
  'r.ok': ['succeeded', '成功', '成功'],
  'r.never': ['Never run yet', '还没运行过', '還沒執行過'],
  'r.running': ['Running', '运行中', '執行中'],
  'r.lastFailed': ['Last run failed', '上次失败', '上次失敗'],
  'r.paused': ['Paused', '已暂停', '已暫停'],
  'r.next': [' · next {when}', ' · 下次 {when}', ' · 下次 {when}'],
  'r.everyHours': ['Every {n} h', '每 {n} 小时', '每 {n} 小時'],
  'r.everyMinutes': ['Every {n} min', '每 {n} 分钟', '每 {n} 分鐘'],
  'r.onceAt': ['Once at {when}', '{when} 一次', '{when} 一次'],
  'r.tz': [' ({tz})', '（{tz}）', '（{tz}）'],
  'r.daily': ['Every day', '每天', '每天'],
  'r.weekdays': ['Weekdays', '工作日', '平日'],
  'r.weekends': ['Weekends', '周末', '週末'],
  'r.weekly': ['Every {days}', '每{days}', '每{days}'],
  'r.confirmDelete': ['Delete scheduled task “{name}”?', '删掉定时任务「{name}」？', '刪除排程任務「{name}」？'],
}

const stored = (() => { try { return localStorage.getItem('ma_lang') } catch { return null } })()
export const lang = LANGS.includes(stored) ? stored : 'en'
document.documentElement.lang = lang

export function t(key, vars = {}) {
  const row = M[key]
  if (!row) return key
  const text = row[LANGS.indexOf(lang)] || row[0]
  return text.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m))
}

/** Switching reloads the page: every string is read once, when it is drawn. */
export function setLang(next) {
  if (!LANGS.includes(next) || next === lang) return
  try { localStorage.setItem('ma_lang', next) } catch {}
  location.reload()
}

export function applyDom(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n)
  for (const [attr, prop] of [['placeholder', 'i18nPlaceholder'], ['title', 'i18nTitle'], ['aria-label', 'i18nAriaLabel']])
    for (const el of root.querySelectorAll(`[data-i18n-${attr}]`)) el.setAttribute(attr, t(el.dataset[prop]))
}

/** Every key has three non-empty translations. Run from the console: check() */
export function check() {
  const bad = Object.entries(M).filter(([, v]) => !Array.isArray(v) || v.length !== 3 || v.some(s => !s))
  return bad.length ? bad.map(([k]) => k) : 'ok'
}
