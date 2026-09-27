---
name: studio-basics
description: 使用 studio 片场服务的基础规则和完整 CLI 命令表。剧组里任何成员在执行涉及项目、镜头、角色、场景、素材、生成、审片的操作之前都必须先读这个技能；只要任务里出现镜头号、角色名、"生成""出图""审片""入库""项目"等字眼，就使用它。
---

# Studio 基础

studio 是剧组的片场服务：资产库、镜头状态机、模型调用、预处理都在里面。
你通过 `studio` 工具访问它：下面命令表里的每一行，就是一次工具调用 `{action, args}`，
比如 `studio char refs 蛮吉 --look 战斗装 --angle 3-4` 就是
`{"action": "char.refs", "args": {"name": "蛮吉", "look": "战斗装", "angle": "3-4"}}`。结果是 JSON。

## 开工第一步：确认项目

剧组同时服务多部片子。**每次接到任务先执行：**

```bash
studio project current          # 当前项目
studio project info             # 世界观、画风、基调、禁忌
```

任务里提到的项目和当前项目不一致时，先 `studio project use <slug>`，并在回复里说明切换了项目。
不要凭记忆假设项目设定，每次以 `project info` 为准。

## 命令表

### 项目与分集
| 命令 | 作用 |
| --- | --- |
| `studio project list / current / use <slug> / info` | 项目切换与设定查询（项目 = 一部剧，默认竖屏 9:16） |
| `studio episode list / show <集>` | 分集、每集剧本、所处阶段、合成情况 |
| `studio episode submit <集>` | 导演：整集拆完，提交给人确认 |
| `studio episode assemble <集>` | 导演：整集已全部通过时重新合成一次 |

### 工单
| 命令 | 作用 |
| --- | --- |
| `studio order list` | 你手上的工单 |
| `studio order done <编号> --note ...` | 只用于片场看不到的活（比如「修参考图」），写明改了什么 |

### 角色 / 场景资产
| 命令 | 作用 |
| --- | --- |
| `studio char list` | 当前项目所有角色 |
| `studio char show <角色> [--look <造型>]` | 身份卡、禁止改动项、可用 look |
| `studio char refs <角色> --look <造型> [--angle 正/3-4/侧/背] [--expr <表情>] [--light <光照>] [--shot <景别>]` | 按条件匹配参考图 |
| `studio char add / look add` | 新建角色 / 造型（草稿态） |
| `studio voice list [--query <关键词>]` | 配音账号（MiniMax）里可用的声音：voice_id、名字、描述 |
| `studio char voice <角色> --voice <voice_id> [--emotion happy/sad/angry/fearful/disgusted/surprised/calm/fluent/whisper]` | 角色的配音声音（画外音 / 旁白用 MiniMax 配），定稿后也能改 |
| `studio loc list / show / refs / add` | 场景，参数同角色 |
| `studio asset gen --engine gpt-image\|comfy --prompt ... [--ref <asset_id>...]` | 生成图像素材 |
| `studio asset edit <asset_id> --instruction ... [--mask ...]` | 改图 |
| `studio asset save <文件> --kind <类型> --link <char/loc/look id> --tags ...` | 入库 |
| `studio asset show <asset_id>` | 素材详情和血缘 |

### 镜头
| 命令 | 作用 |
| --- | --- |
| `studio scene list / show <场次>` | 场次和镜头列表 |
| `studio scene add <场次> --episode <集> --title ... --script <该场剧本原文>` | 导演把一集剧本切成场次入库（原文照抄，之后只有人类能改） |
| `studio shot plan <场次> --file <shots.json>` | 写入镜头表（每个镜头带对白，见 shot-breakdown） |
| `studio shot show <镜头>` | 镜头定义、状态、候选、审片历史 |
| `studio shot prompt <镜头> --text ... --refs <id>...` | 保存生成方案 |
| `studio shot gen <镜头> --model seedance-2.0\|seedance-2.5 --n <数量>` | 异步批量生成 |
| `studio shot sheet <镜头>` | 生成候选对比图（contact sheet），返回图片 |
| `studio shot approve <镜头> --pick <候选号> --note ...` | 通过 |
| `studio shot reject <镜头> --reason ... --route prompt\|asset\|plan` | 打回 |
| `studio shot lock <场次>` | 导演锁定整场 |
| `studio review history <镜头>` | 审片记录 |

## 硬规则

1. **不直接碰文件路径。** 素材一律用 asset id 引用；本地文件要先 `asset save` 才算存在。
2. **不在对话里写设定。** 角色外形、世界观规则只存在 studio 里。发现设定缺失或矛盾，
   报告给导演，不要自己补一个版本。
3. **定稿态只读。** `locked` 状态的角色、造型、场景不能改，需要改请在剧组群里说明，由人决定。
4. **生成是异步的。** `shot gen` 返回就结束，不要轮询。完成后片场会给审片派单。
5. **命令报错如实汇报**，附原始错误信息，不要换个方式绕过权限。

## 工单：活怎么到你手上

活不靠群里 @ 来交接。片场随时看着每一集、每个镜头的状态，算出下一步谁该做什么，
把「片场工单」发到那个人**自己的对话**里，每项带编号：

```
〔片场工单 · 2 项。片场看到活干完会自动关单；做不了的在回复里说明原因。〕
#12 S01-SH002：写 Seedance 提示词（shot.prompt）并生成（shot.gen）。
#13 S01-SH003 被打回（第 1 次）：…
```

- **照单做完就行。** 片场在自己的状态里看到活干完（镜头进入生成、参考图入库…）会自动关单，
  并给下一个人派单。不用 @ 任何人，不用在群里逐条汇报。
- 做不了的，在回复里说明原因。同一张单两次都没完成，片场会交给人。
- 只有写着「用 order.done 关单」的活才需要你自己关单（片场看不到你修好了参考图）。
- 剧组群里片场会发一行「📋 工单 → 某人：…」，大家都看得到谁在做什么。群里说话，
  用于需要同事判断或人来决定的事。
