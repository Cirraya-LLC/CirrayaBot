/// Strings for the settings area (setup, providers):
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
  'prov.ctxManualLabel': ['Manual', '手动', '手動'],
  'prov.new': ['+ New', '＋ 新的', '＋ 新的'],
  'prov.inUse': ['In use', '正在用', '使用中'],
  'prov.makeDefault': ['Click to make default', '点这里设为默认', '點這裡設為預設'],
};
