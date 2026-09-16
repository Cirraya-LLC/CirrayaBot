/// Strings for the editors area: key -> ['English', '简体', '繁體'].
library;

const Map<String, List<String>> editorStrings = {
  // Agent editor
  'ed.needNamePersona': ['Name and responsibilities are both required', '名字和职责说明都要填', '名字和職責說明都要填'],
  'ed.modelsLoading': ['Still asking the provider for its models — one moment', '还在问上游有哪些模型，等一下', '還在詢問上游有哪些模型，請稍候'],
  'ed.pickModel': ['Pick a model', '要选一个模型', '要選一個模型'],
  'ed.deleteAgentQ': ['Delete "{name}"?', '删除「{name}」？', '刪除「{name}」？'],
  'ed.deleteAgentBody': [
    'Their DMs and container are deleted too; what they said in groups and the files in their work folder stay.',
    '私聊记录和他的容器会一起删掉；他在群里说过的话和工作目录里的文件还在。',
    '私訊紀錄和他的容器會一起刪除；他在群組裡說過的話和工作目錄裡的檔案都還在。',
  ],
  'ed.editTitle': ['Edit "{name}"', '编辑「{name}」', '編輯「{name}」'],
  'ed.nameHint': ['Name, e.g. "Lin"', '名字，比如「小林」', '名字，例如「小林」'],
  'ed.descHint': [
    'One-line job, e.g. "Copywriting — all outward-facing text is theirs"',
    '一句话职位，比如「写文案、对外的字都归他」',
    '一句話職位，例如「寫文案、對外的文字都歸他」',
  ],
  'ed.personaHint': [
    "Responsibilities: what they own, how they work, what isn't theirs.\nThis is their persona; they read it every turn.",
    '职责说明：他负责什么、怎么干活、什么事不归他管。\n这段就是他的人设，每一轮都会读到。',
    '職責說明：他負責什麼、怎麼工作、什麼事不歸他管。\n這段就是他的人設，每一輪都會讀到。',
  ],
  'ed.provider': ['Model provider', '模型上游', '模型上游'],
  'ed.defaultProvider': ['Default provider', '默认上游', '預設上游'],
  'ed.defaultProviderNamed': ['Default provider ({name})', '默认上游（{name}）', '預設上游（{name}）'],
  'ed.model': ['Model', '模型', '模型'],
  'ed.askingProvider': ['Asking the provider…', '正在问上游…', '正在詢問上游…'],
  'ed.manualModelHint': ['This provider gives no list — type it', '这个上游不给列表，手填', '這個上游不提供清單，請手動填寫'],
  'ed.create': ['Create', '创建', '建立'],
  // Group editor
  'ed.groupNeeds': ['A group needs a name and at least two members', '群要有名字，而且至少两个成员', '群組要有名稱，而且至少兩位成員'],
  'ed.disbandQ': ['Disband "{name}"?', '解散「{name}」？', '解散「{name}」？'],
  'ed.disbandBody': [
    'The group chat is deleted; files in the shared folder stay.',
    '群聊记录会删掉；群共享盘里的文件不动。',
    '群組聊天紀錄會刪除；群組共用資料夾裡的檔案不受影響。',
  ],
  'ed.groupNameHint': ['Group name, e.g. "Product team"', '群名，比如「产品小组」', '群組名稱，例如「產品小組」'],
  'ed.membersMin': ['Members (at least two)', '成员（至少两个）', '成員（至少兩位）'],
  'ed.noAgents': ['No Agents yet — create a few first.', '还没有 Agent，先建几个。', '還沒有 Agent，先建立幾個。'],
  'ed.lead': ['Lead', '负责人', '負責人'],
  'ed.noLead': ['None (the first in order speaks first)', '不指定（排在最前面的先接话）', '不指定（排在最前面的先接話）'],
  'ed.leadHelp': [
    "When you don't name anyone, they answer first, split the work among colleagues and report back to you.",
    '你没点名的时候由他先接话，拆活、分给同事、最后汇总给你。',
    '你沒點名的時候由他先接話，拆分工作、分給同事、最後彙整給你。',
  ],
  'ed.disband': ['Disband', '解散', '解散'],
};
