// Messages for server code: key -> ['English', '简体', '繁體']. See ../i18n.mjs.
export const serverStrings = {
  // Capability tags on an agent card
  'bot.tool.shell':    ['shell', 'shell', 'shell'],
  'bot.tool.files':    ['read/write files', '读写文件', '讀寫檔案'],
  'bot.tool.browser':  ['browser', '浏览器', '瀏覽器'],
  'bot.tool.sandbox':  ['own sandbox', '自己的沙箱', '自己的沙箱'],
  'bot.tool.chatOnly': ['chat only', '只能对话', '只能對話'],

  // Conversation list
  'conv.youSaid': ['You: {text}', '你：{text}', '你：{text}'],
  'conv.said':    ['{who}: {text}', '{who}：{text}', '{who}：{text}'],
  'conv.user':    ['You', '你', '你'],
  'conv.members': ['{n} members', '{n} 人', '{n} 人'],

  // Not found
  'err.noAgent':    ['No such agent', '没有这个 Agent', '沒有這個 Agent'],
  'err.noGroup':    ['No such group', '没有这个群', '沒有這個群組'],
  'err.noSkill':    ['No such skill', '没有这个技能', '沒有這個技能'],
  'err.noRoutine':  ['No such scheduled task', '没有这个定时任务', '沒有這個排程任務'],
  'err.noProvider': ['No such upstream', '没有这个上游', '沒有這個上游'],

  'auth.needToken': ['An access token is required: add ?k=<your ACCESS_TOKEN> to the URL',
    '需要访问令牌：在地址后面加 ?k=<你的 ACCESS_TOKEN>',
    '需要存取權杖：在網址後面加上 ?k=<你的 ACCESS_TOKEN>'],
  'body.notJson':   ['The request body is not valid JSON', '请求体不是合法的 JSON', '請求內容不是有效的 JSON'],
  'body.notObject': ['The request body must be a JSON object', '请求体要是一个 JSON 对象', '請求內容必須是一個 JSON 物件'],

  // Containers
  'container.buildFailed': ['Failed to build {image}: {detail}', '构建 {image} 失败：{detail}', '建置 {image} 失敗：{detail}'],
  'container.startFailed': ['Could not start the container for {id}: {detail}', '起不了 {id} 的容器：{detail}', '無法啟動 {id} 的容器：{detail}'],

  // Browser (human side)
  'browser.toolsOff':   ['Tools are off (AGENT_TOOLS), so agents have no browser', '工具没开（AGENT_TOOLS），Agent 没有浏览器', '工具未開啟（AGENT_TOOLS），Agent 沒有瀏覽器'],
  'browser.badAction':  ['Unsupported action {action}', '不支持的动作 {action}', '不支援的動作 {action}'],
  'browser.cantStart':  ['The browser would not start: {detail}', '浏览器起不来：{detail}', '瀏覽器無法啟動：{detail}'],
  'browser.noResponse': ['The browser did not respond: {detail}', '浏览器没有回应：{detail}', '瀏覽器沒有回應：{detail}'],
  'browser.noShot':     ['Could not take a screenshot', '截不到图', '擷取不到畫面'],

  // Chat stream
  'chat.needTarget':  ['Pick an agent or a group, and do not send an empty message', '要选一个 Agent 或一个群，并且不能发空消息', '請選一個 Agent 或一個群組，而且不能傳送空白訊息'],
  'chat.noImages':    ['This model does not accept images; screenshots are now sent as text', '这个模型不收图片，截图改成文字', '這個模型不接受圖片，截圖改成文字'],
  'chat.aborted':     ['Stopped', '已停止', '已停止'],
  'run.queued':       ['Still working on the previous message in this session — this one is next', '这个会话还在处理上一条消息 —— 这条排在它后面', '這個會話還在處理上一則訊息 —— 這則排在它後面'],
  'run.none':         ['Nothing is running there', '那里没有正在进行的任务', '那裡沒有正在進行的任務'],
  'group.tooSmall':   ['"{name}" has only {n} member(s) left — add people in the group settings first (at least two)',
    '「{name}」只剩 {n} 个成员了，先在群设置里加人（至少两个）',
    '「{name}」只剩 {n} 位成員了，請先在群組設定裡加人（至少兩位）'],

  // Background tasks
  'task.none':        ['There is no such task', '没有这个任务', '沒有這個任務'],
  'task.notOpen':     ['That task has already ended', '这个任务已经结束了', '這個任務已經結束了'],
  'task.answerEmpty': ['Write an answer first', '先写下回答', '請先寫下回答'],
  'task.notAsking':   ['That task is not waiting for an answer any more', '这个任务已经不在等回答了', '這個任務已經不在等回答了'],

  // Agents
  'agent.nameEmpty':    ['Name cannot be empty', '名字不能为空', '名稱不能為空'],
  'agent.nameLong':     ['Names are at most 40 characters', '名字最多 40 个字', '名稱最多 40 個字'],
  'agent.nameReserved': ['"{name}" is a reserved name', '「{name}」是保留名字', '「{name}」是保留名稱'],
  'agent.exists':       ['There is already an agent named "{name}"', '已经有一个叫「{name}」的 Agent 了', '已經有一個叫「{name}」的 Agent 了'],
  'agent.idExists':     ['An agent with id {id} already exists', '已经有一个叫 {id} 的 Agent', '已經有一個 id 為 {id} 的 Agent'],
  'agent.personaEmpty': ['The role description cannot be empty', '职责说明不能为空', '職責說明不能為空'],
  'agent.color':        ['Color must be #RRGGBB', '颜色要是 #RRGGBB', '顏色必須是 #RRGGBB'],
  'agent.order':        ['order must be an integer', 'order 要是整数', 'order 必須是整數'],
  'agent.effort':       ['Reasoning effort must be empty or one of {list}', '推理强度只能留空，或者是 {list}', '推理強度只能留空，或是 {list}'],
  'agent.approval':     ['The approval mode must be empty or one of {list}', '审批模式只能留空，或者是 {list}', '審批模式只能留空，或是 {list}'],
  'agent.autonomy':     ['The autonomy setting must be empty or one of {list}', '自主模式只能留空，或者是 {list}', '自主模式只能留空，或是 {list}'],
  'approval.gone':      ['That request is no longer waiting for an answer', '这条请求已经不在等待回答了', '這條請求已經不在等待回答了'],
  'agent.modelRequired': ['Pick a model', '要选一个模型', '請選一個模型'],
  'agent.modelLong':    ['The model name is too long', '模型名太长了', '模型名稱太長了'],

  // Groups
  'group.nameRequired':  ['The group needs a name', '群要有名字', '群組需要名稱'],
  'group.membersArray':  ['members must be an array of agent ids', 'members 要是 Agent id 的数组', 'members 必須是 Agent id 的陣列'],
  'group.tooFew':        ['A group needs at least two members — a group of one is a direct chat', '群至少要两个成员 —— 一个人的群就是私聊', '群組至少要兩位成員——一個人的群組就是私訊'],
  'group.leadNotMember': ['The lead must be a member of this group', '负责人要是这个群里的成员', '負責人必須是這個群組的成員'],

  // Skills
  'skill.exists':      ['There is already a skill named "{name}"', '已经有一个叫「{name}」的技能了', '已經有一個叫「{name}」的技能了'],
  'skill.agentsArray': ['agents must be an array of agent ids', 'agents 要是 Agent id 的数组', 'agents 必須是 Agent id 的陣列'],

  // Scheduled tasks
  'routine.nameRequired':   ['The task needs a name', '任务要有个名字', '任務需要一個名稱'],
  'routine.promptRequired': ['Say clearly what it should do', '要写清楚让他做什么', '請寫清楚要他做什麼'],
  'routine.target':         ['The target must be an agent or a group', '发给谁：要是一个 Agent 或一个群', '發給誰：必須是一個 Agent 或一個群組'],
  'routine.enabled':        ['enabled must be true or false', 'enabled 要是 true / false', 'enabled 必須是 true / false'],
  'routine.running':        ['It is running now; wait for this run to finish', '它正在跑，等这次跑完', '它正在執行，請等這次跑完'],
  'routine.tripped':        ['Failed {n} times in a row; paused automatically. Last error: {error}',
    '连续失败 {n} 次，已自动暂停。最后一次：{error}', '連續失敗 {n} 次，已自動暫停。最後一次：{error}'],

  // Upstreams
  'provider.none':      ['No model upstream configured yet — click "Model upstreams" at the bottom left and add one (name / endpoint / key)',
    '还没配模型上游 —— 点左下角的「模型上游」加一个（名字 / 接口地址 / 密钥）',
    '還沒設定模型上游——點左下角的「模型上游」新增一個（名稱 / 介面位址 / 金鑰）'],
  'provider.gone':      ['The upstream chosen for {name} no longer exists — pick another in "Edit agent"',
    '{name} 指定的上游已经不存在了，去「编辑 Agent」里重新选一个',
    '{name} 指定的上游已經不存在了，請到「編輯 Agent」裡重新選一個'],
  'provider.noModel':   ['{name} has no model selected — pick one in "Edit agent"',
    '{name} 还没选模型 —— 去「编辑 Agent」里选一个', '{name} 還沒選模型——請到「編輯 Agent」裡選一個'],
  'provider.ctxAuto':   ['Detected per agent model; 128k when detection fails', '按每个 Agent 选的模型自动探测，探不到按 128k', '依每個 Agent 選的模型自動偵測，偵測不到以 128k 計'],
  'provider.ctxManual': ['Set manually', '手动填写', '手動填寫'],
  'provider.nameUrl':   ['Both the name and the endpoint URL are required', '名字和接口地址都要填', '名稱和介面位址都要填'],
  'provider.urlScheme': ['The endpoint must start with http:// or https://', '接口地址要以 http:// 或 https:// 开头', '介面位址必須以 http:// 或 https:// 開頭'],
  'provider.protocol':  ['Protocol must be one of {list}', '协议只能是 {list}', '協定只能是 {list}'],
  'provider.inUse':     ['{names} still use this upstream — switch them to another one in "Edit agent" first',
    '{names} 还在用这个上游，先在「编辑 Agent」里给他们换一个', '{names} 還在使用這個上游，請先在「編輯 Agent」裡幫他們換一個'],
  'provider.last':      ['This is the last upstream; deleting it would leave nothing to chat with', '这是最后一个上游了，删掉就没法对话了', '這是最後一個上游了，刪掉就無法對話了'],
  'provider.noModels':  ['This upstream does not answer /models (wrong URL, key or protocol, or it simply does not provide a list)',
    '这个上游不回答 /models（地址、密钥或协议不对，或者它就是不提供列表）',
    '這個上游不回應 /models（位址、金鑰或協定不對，或者它本來就不提供清單）'],
  'provider.testNoModels': ['Could not get this upstream\'s model list, so there is no model to try (wrong URL, key or protocol?)',
    '问不到这个上游的模型列表，没法挑一个来试（地址、密钥或协议不对？）',
    '取得不到這個上游的模型清單，沒辦法挑一個來測試（位址、金鑰或協定不對？）'],
  'provider.testEmpty': ['Connected, but nothing came back this time (usually a bad relay channel — try again)',
    '连上了，但这次一个字都没返回（多半是中转的坏通道，再试一次）',
    '連上了，但這次一個字都沒有回傳（多半是中繼的壞通道，再試一次）'],

  // Spending
  'spend.capped': [
    '{name} has reached today\u2019s spend cap of {cap} (already {spent}). Raise it in "Edit agent", or wait until tomorrow.',
    '{name} 已经达到今天的花费上限 {cap}（已花 {spent}）。要么在「编辑 Agent」里调高，要么等明天。',
    '{name} 已達到今天的花費上限 {cap}（已花 {spent}）。請在「編輯 Agent」裡調高，或等明天。'],
  'spend.badCap': ['The daily cap must be a number, or empty for no cap', '每日上限要是一个数字，留空表示不限', '每日上限必須是數字，留空表示不限制'],
  'spend.badPrice': ['A price must be a number, or empty when you don\u2019t know it', '价格要是一个数字，不知道就留空', '價格必須是數字，不知道就留空'],

  // Chat history import
  'import.badFile': ['This is not a chat history file exported by this app', '不是本产品导出的聊天记录文件', '不是本產品匯出的聊天紀錄檔案'],
  'session.none':     ['No such session', '没有这个会话', '沒有這個會話'],
  'session.busy':     ['A reply is still being written in this session; delete it once it finishes', '这个会话里还有回复在进行，等它结束再删', '這個會話裡還有回覆在進行，等它結束再刪'],
  'session.titleLong':['A session name can be at most 80 characters', '会话名最多 80 个字', '會話名稱最多 80 個字'],
  'session.imported': ['Imported: {name}', '导入：{name}', '匯入：{name}'],
  'import.badRow':  ['Message {n} is malformed (it needs role and content)', '第 {n} 条格式不对（要有 role 和 content）', '第 {n} 則格式不對（需要 role 和 content）'],
}
