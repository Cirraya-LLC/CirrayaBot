/// Strings for the settings area (setup, providers, skills):
/// key -> ['English', '简体', '繁體'].
library;

const Map<String, List<String>> settingsStrings = {
  // Setup
  'setup.intro': [
    'Connect to the server you deployed. Paste the whole address it printed on\nstartup (the one with ?k=) and both fields fill themselves.',
    '连到你自己部署的服务器。把启动时打印的那个带 ?k= 的地址\n整条粘进来就行，两个框会自己填好。',
    '連到你自己部署的伺服器。把啟動時印出的那個帶 ?k= 的位址\n整條貼進來就行，兩個欄位會自己填好。',
  ],
  'setup.urlHint': [
    'Server address, e.g. http://192.168.1.10:8080',
    '服务器地址，比如 http://192.168.1.10:8080',
    '伺服器位址，例如 http://192.168.1.10:8080',
  ],
  'setup.tokenHint': [
    'Access token (ACCESS_TOKEN in the server\'s .env)',
    '访问令牌（服务端 .env 里的 ACCESS_TOKEN）',
    '存取權杖（伺服器 .env 裡的 ACCESS_TOKEN）',
  ],
  'setup.connecting': ['Connecting…', '连接中…', '連線中…'],
  'setup.ok': ['Connected, {n} conversations', '通了，{n} 个会话', '連上了，{n} 個對話'],
  'setup.test': ['Test connection', '测试连接', '測試連線'],
  'setup.connect': ['Connect', '连接', '連線'],
  'setup.footer': [
    'This client stores no chats — Agents, groups and history live in the\nserver\'s database, so another computer sees the same thing.',
    '这个客户端不存任何聊天内容 —— Agent、群、记录都在服务器的\n数据库里，换台电脑打开还是同一份。',
    '這個用戶端不存任何聊天內容 —— Agent、群組、紀錄都在伺服器的\n資料庫裡，換台電腦打開還是同一份。',
  ],

  // Providers
  'prov.title': ['Model upstreams', '模型上游', '模型上游'],
  'prov.ctxManual': ['context {n} tokens — {source}', '上下文 {n} tokens — {source}', '上下文 {n} tokens — {source}'],
  'prov.connecting': ['Connecting…', '连接中…', '連線中…'],
  'prov.testOk': [
    'Works: {ms}ms, lists {models} models, tried {model} and got “{reply}”',
    '通了，{ms}ms，列出 {models} 个模型，拿 {model} 试了一句，回「{reply}」',
    '連上了，{ms}ms，列出 {models} 個模型，拿 {model} 試了一句，回「{reply}」',
  ],
  'prov.testFail': ["Can't connect: {error}", '连不上：{error}', '連不上：{error}'],
  'prov.needFields': [
    'Both a name and an endpoint are required',
    '名字和接口地址都要填',
    '名稱和介面位址都要填',
  ],
  'prov.saving': ['Saving…', '保存中…', '儲存中…'],
  'prov.savedAuto': ['Saved — {source}', '已保存 — {source}', '已儲存 — {source}'],
  'prov.savedManual': [
    'Saved — context {n} tokens',
    '已保存 — 上下文 {n} tokens',
    '已儲存 — 上下文 {n} tokens',
  ],
  'prov.deleteTitle': ['Delete “{name}”?', '删除「{name}」？', '刪除「{name}」？'],
  'prov.deleteBody': [
    'Its API key goes too; you would have to enter it again.',
    '它的 API Key 也一起删掉，要用得重新填。',
    '它的 API Key 也一併刪除，要用得重新填。',
  ],
  'prov.deleting': ['Deleting…', '删除中…', '刪除中…'],
  'prov.deleted': ['Deleted “{name}”', '已删除「{name}」', '已刪除「{name}」'],
  'prov.switching': ['Switching…', '切换中…', '切換中…'],
  'prov.nowUsing': ['Now using “{name}”', '现在用「{name}」', '現在用「{name}」'],
  'prov.none': [
    'No upstreams yet — add one below so Agents can talk.',
    '还没有上游 —— 在下面加一个，Agent 才能说话。',
    '還沒有上游 —— 在下面加一個，Agent 才能說話。',
  ],
  'prov.addTitle': ['Add an upstream', '加一个上游', '新增一個上游'],
  'prov.editTitle': ['Edit “{name}”', '编辑「{name}」', '編輯「{name}」'],
  'prov.nameHint': [
    'Name, anything you like, e.g. “Company gateway”',
    '名字，随便起，比如「公司网关」',
    '名稱，隨意取，例如「公司閘道」',
  ],
  'prov.urlHint': ['Endpoint, up to /v1', '接口地址，到 /v1 为止', '介面位址，到 /v1 為止'],
  'prov.keySaved': [
    'Saved {hint} (leave empty = unchanged)',
    '已保存 {hint}（留空 = 不改）',
    '已儲存 {hint}（留空 = 不改）',
  ],
  'prov.ctxAuto': ['Auto context', '上下文自动', '上下文自動'],
  'prov.priceIn': ['Input \$/M tokens', '输入 \$/百万 tokens', '輸入 \$/百萬 tokens'],
  'prov.priceOut': ['Output \$/M tokens', '输出 \$/百万 tokens', '輸出 \$/百萬 tokens'],
  'prov.priceHint': [
    'Leave the prices empty if you don’t know them: calls are still counted in tokens, but they have no cost and no cap can hold them.',
    '不知道价格就留空：调用照样按 token 记，但没有金额，上限也拦不住。',
    '不知道價格就留空：呼叫照樣以 token 計，但沒有金額，上限也攔不住。'],
  'prov.badPrice': ['A price must be a number of dollars, or empty', '价格要填美元金额，或者留空', '價格請填美元金額，或留空'],
  'prov.defaultCap': ['Default daily cap \$ (all Agents)', '默认每日上限 \$（所有 Agent）', '預設每日上限 \$（所有 Agent）'],
  'prov.capSaved': ['Default daily cap: {cap}', '默认每日上限：{cap}', '預設每日上限：{cap}'],
  'prov.noCap': ['no cap', '不限', '不限制'],
  'prov.ctxManualLabel': ['Manual', '手动', '手動'],
  'prov.new': ['+ New', '＋ 新的', '＋ 新的'],
  'prov.inUse': ['In use', '正在用', '使用中'],
  'prov.makeDefault': ['Click to make default', '点这里设为默认', '點這裡設為預設'],

  // Skills
  'skills.title': ['Skills', '技能库', '技能庫'],
  'skills.savedByHint': [
    '{name} saved this himself. Once you edit it, it is yours and he can no longer overwrite it.',
    '这是 {name} 自己存的。你一改它就算你的了，他以后不能再覆盖。',
    '這是 {name} 自己存的。你一改它就算你的了，他以後不能再覆蓋。',
  ],
  'skills.fileError': ['File read/write failed: {detail}', '文件读写失败：{detail}', '檔案讀寫失敗：{detail}'],
  'skills.saving': ['Saving…', '保存中…', '儲存中…'],
  'skills.saved': ['Saved', '已保存', '已儲存'],
  'skills.deleteTitle': ['Delete skill “{name}”?', '删掉技能「{name}」？', '刪除技能「{name}」？'],
  'skills.deleteBody': [
    'Agents that have it installed will stop working this way.',
    '装了它的 Agent 以后就不会这么做了。',
    '裝了它的 Agent 以後就不會這麼做了。',
  ],
  'skills.deleting': ['Deleting…', '删除中…', '刪除中…'],
  'skills.deleted': ['Deleted “{name}”', '已删除「{name}」', '已刪除「{name}」'],
  'skills.exporting': ['Exporting…', '导出中…', '匯出中…'],
  'skills.exported': ['Exported to {path}', '已导出到 {path}', '已匯出到 {path}'],
  'skills.importing': ['Importing…', '导入中…', '匯入中…'],
  'skills.imported': ['Imported “{name}”', '已导入「{name}」', '已匯入「{name}」'],
  'skills.intro': [
    'A skill = how to do one kind of job: steps, decision rules, what to deliver, what to ask a person first. '
        'An Agent it is installed on reads it before doing a matching job. '
        'Same format as Claude Code / dsh SKILL.md files, which import directly.',
    '一个技能 = 一类活怎么干：步骤、判断规则、产出要求、哪些事要先问人。装给哪个 Agent，他碰到对得上的活就会先读它再做。'
        '格式和 Claude Code / dsh 的 SKILL.md 一样，可以直接导入。',
    '一個技能 = 一類工作怎麼做：步驟、判斷規則、產出要求、哪些事要先問人。裝給哪個 Agent，他碰到對得上的工作就會先讀它再做。'
        '格式和 Claude Code / dsh 的 SKILL.md 一樣，可以直接匯入。',
  ],
  'skills.none': [
    'No skills yet — write one below, or import a SKILL.md.',
    '还没有技能 —— 在下面写一个，或者导入 SKILL.md。',
    '還沒有技能 —— 在下面寫一個，或者匯入 SKILL.md。',
  ],
  'skills.newTitle': ['Write a skill', '写一个技能', '寫一個技能'],
  'skills.editTitle': ['Edit “{name}”', '编辑「{name}」', '編輯「{name}」'],
  'skills.nameHint': ['Name, e.g. “Weekly report”', '名字，比如「周报」', '名稱，例如「週報」'],
  'skills.descHint': [
    'When to use it — the Agent recalls it by this line, e.g. “when the user asks for a weekly report or summary”',
    '什么时候用 —— Agent 靠这句话想起它，比如「用户要周报、周总结的时候」',
    '什麼時候用 —— Agent 靠這句話想起它，例如「使用者要週報、週總結的時候」',
  ],
  'skills.bodyHint': [
    'How to do it (Markdown):\n1. First…\n2. If… then…\nDeliver: …\nAsk a person first about: …',
    '怎么做（Markdown）：\n1. 先……\n2. 如果……就……\n产出：……\n这些事要先问人：……',
    '怎麼做（Markdown）：\n1. 先……\n2. 如果……就……\n產出：……\n這些事要先問人：……',
  ],
  'skills.installOn': ['Install on', '装给谁', '裝給誰'],
  'skills.importMd': ['Import SKILL.md', '导入 SKILL.md', '匯入 SKILL.md'],
  'skills.new': ['+ New', '＋ 新的', '＋ 新的'],
  'skills.nobody': ['not installed on anyone yet', '还没装给任何人', '還沒裝給任何人'],
  'skills.listSep': [', ', '、', '、'],
  'skills.savedBy': [' · saved by {name}', ' · {name} 自己存的', ' · {name} 自己存的'],

  // Approvals, platform-wide
  'ap.title': ['Asking before acting', '动手前先问', '動手前先問'],
  'ap.modeOff': ['Never ask', '从不询问', '從不詢問'],
  'ap.modeMatch': ['Ask when a command matches the list', '命中下面的清单就问', '命中下面的清單就問'],
  'ap.modeAll': [
    'Ask before every command, write and browser action',
    '每条命令、每次写文件和浏览器操作都问',
    '每條命令、每次寫檔案與瀏覽器操作都問',
  ],
  'ap.patterns': ['Patterns, one per line', '规则，一行一条', '規則，一行一條'],
  'ap.hint': [
    'Patterns are regular expressions, matched against the command itself \u2014 not against file '
        'contents. An Agent can override this for itself. Scheduled tasks have nobody to ask, so '
        'anything that would ask is refused there.',
    '规则是正则表达式，只匹配命令本身，不匹配文件内容。单个 Agent 可以自己覆盖这个设置。'
        '定时任务没人可问，所以在那里会直接拒绝。',
    '規則是正規表示式，只比對命令本身，不比對檔案內容。單個 Agent 可以自己覆寫這個設定。'
        '定時任務沒人可問，所以在那裡會直接拒絕。',
  ],
  'ap.saved': ['Approval settings saved', '审批设置已保存', '審批設定已儲存'],
};
