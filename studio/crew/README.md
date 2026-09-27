# Studio Crew — CirrayaBot 剧组配置

CirrayaBot 上的 AI 剧组：4 个 agent + 5 个 skill，配合 `studio` 片场服务使用。

## 设计原则

1. **剧组通用，片子可换。** agent 的性格和 skill 里不写任何具体片子的内容。
   片子的世界观、画风、角色全部存在 studio 的项目库里，用 `studio project use <slug>` 切换。
   新开一部片 = 在 studio 里建一个项目，剧组不用改。
2. **agent 负责判断，studio 负责苦力。** 抽卡、下载、抽帧、相似度初筛由 studio 批量完成，
   agent 不逐张操作文件。
3. **studio 是唯一真源。** 角色包、镜头状态、审片记录只存在 studio 里。
   agent 的 `remember` 只记工作心得，不记设定。
4. **密钥不进 agent 容器。** Seedance / GPT 图像 / ComfyUI / MiniMax 语音的 key 只在 studio 服务里，
   agent 通过平台的 `studio` 工具访问，平台替它标明身份，studio 按岗位限权。

## 成员

四个岗位是固定的：启用片场后第一次启动就自动建好这四个人、装好技能、建好「剧组」群、分好岗位，
不用跑任何命令。他们可以改名、换模型、改性格描述，但不能删，岗位也不能转给别人。

| 名字 | 职位 | 模型候选（按顺序，取上游里第一个有的） | 推理强度 | 步数上限 | Skills |
| --- | --- | --- | --- | --- | --- |
| 顾衡 | 导演（组长） | claude-opus-5-5 → deepseek-flash | 高 | 30 | studio-basics, shot-breakdown |
| 苏棠 | 美术指导 | gpt-5.6-sol → deepseek-flash | 中 | 30 | studio-basics, character-bible |
| 林野 | 摄影指导 | claude-sonnet-5 → deepseek-flash | 中 | 40 | studio-basics, shot-prompting |
| 严青 | 审片 / 场记 | claude-opus-5-5 → gpt-5.6-sol（**必须能看图**） | 高 | 40 | studio-basics, footage-review |

这些默认值写在 `agents/<岗位>.md` 的头部（`模型候选` / `推理强度` / `步数上限`）。
成员没选模型时，平台从它的上游的模型列表里挑第一个候选（转发站的写法如 `anthropic/claude-opus-5.5` 也认），
并存到成员身上，「编辑剧组成员」里看得到、随时能换；**人选过的模型永远不会被自动覆盖**。
上游里一个候选都没有时，第一次对话会提示去选模型。

为什么这样配：
- **导演**读整集剧本、拆结构、写带对白的镜头 JSON，最吃推理和中文表达；工单少，单价高无所谓。
  deepseek-flash 有 1M 上下文、中文原生，是很好的省钱选择。
- **美术**的产出是给 GPT 图像的提示词，并要自己看生成的参考图（`asset.show` 看图），用 GPT 系列最顺。
  角色的配音声音也是美术定：`voice list` 看 MiniMax 账号里的声音，`char voice` 设定。
- **摄影**的工单最多（每个镜头、每次打回都有一张），要稳、要便宜，中等推理足够。
- **审片**是唯一必须看图的岗位，判断错一次就是一轮白生成，所以给最强的看图模型。
  deepseek-flash 现在原生支持图片、走我们自己的循环也能把对比图发给它，
  **但没有用真 key 验证过它看对比图的水平**，所以不在审片的候选里（手动选可以）。

DeepSeek 在「模型上游」里加一个 Chat Completions 上游即可（`https://api.deepseek.com`，模型 `deepseek-flash`），
不再需要单独的 DeepSeek Harness。

## 工作流程：工单，不是接力

一部剧 = 若干集。每一集按固定的流程走，片场随时看着状态，算出下一步谁该做什么，
把**工单**发到那个人**自己的对话**里；剧组群里只有片场的一行「📋 工单 → 某人：…」和需要人拍板的事。
没有人需要 @ 谁来交接。

```
人：写一集剧本 → 开工
  → 顾衡（工单：拆镜头）按场切分、出镜头表、对白写进镜头 → episode submit
人：确认拆解（通过 / 写意见退回 → 顾衡再拆）
  → 苏棠（工单：补参考图）缺什么补什么
人：定稿（设定库里锁定）
  → 林野（工单：写提示词并生成）只派给所需角色、场景都已定稿的镜头
       出镜台词由片场自动加进提示词、打开声音（口型同步）
  → 严青（工单：审片）
       通过；或打回 → 按 route 给林野 / 苏棠（修完再给林野）/ 顾衡派单
       同一镜头第 3 次打回 → 交给人（人可以直接选一条通过，或写意见交回剧组）
  全部镜头通过 → 片场自动合成成片：竖屏 9:16、按镜头时长剪、旁白和画外音用 MiniMax 配音、字幕烧进画面 + .srt
人：看成片 → 通过（或把某个镜头打回，这一集回到制作中，修好后自动重新合成）
```

一张工单两次都没做成（比如成员没选模型、上游报错），会标成「卡住」并在群里交给人。

## 岗位权限（studio 侧实现）

| Agent | 可用命令 |
| --- | --- |
| 顾衡 | 全部读；`scene add`；`shot plan`；`shot lock`；`episode submit / assemble`；`project`（只读） |
| 苏棠 | 全部读；`asset gen/edit/save/tag`；`char *`（含 `char voice`）；`loc *` |
| 林野 | 全部读；`shot gen`；`shot prompt` |
| 严青 | 全部读；`shot sheet`；`shot approve`；`shot reject`；`review *` |

所有人都能 `order list` 看自己的工单、用 `order done` 关掉片场看不到的活（比如修参考图）。

只有人类能做：`char lock` / `loc lock`（定稿）、项目设定、分集的剧本和开工、确认拆解、看成片通过、
把打回 3 次的镜头交回剧组（`shot reopen`）。都在 Web UI 的片场工作台里：「分集」「设定库」「项目设置」，
镜头页也能直接通过 / 打回。

## 更新到最新的配置

平台启动时只补**缺的**（缺哪个成员补哪个），不会覆盖人改过的名字、性格和模型。
这里的文字（性格描述、skill）更新之后，想让已有的剧组用上新版，运行导入脚本：

```bash
docker compose exec app node studio/crew/import.mjs            # 更新 4 个成员的名字、职位、性格描述和 5 个 skill
docker compose exec app node studio/crew/import.mjs --dry-run  # 只看会做什么
```

它**不动你选的上游和模型**；skill 按名字更新。
