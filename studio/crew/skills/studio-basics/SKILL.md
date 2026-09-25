---
name: studio-basics
description: 使用 studio 片场服务的基础规则和完整 CLI 命令表。剧组里任何成员在执行涉及项目、镜头、角色、场景、素材、生成、审片的操作之前都必须先读这个技能；只要任务里出现镜头号、角色名、"生成""出图""审片""入库""项目"等字眼，就使用它。
---

# Studio 基础

studio 是剧组的片场服务：资产库、镜头状态机、模型调用、预处理都在里面。
你通过容器里的 `studio` 命令访问它。所有命令默认输出 JSON，加 `--human` 输出可读格式。

## 开工第一步：确认项目

剧组同时服务多部片子。**每次接到任务先执行：**

```bash
studio project current          # 当前项目
studio project info             # 世界观、画风、基调、禁忌
```

任务里提到的项目和当前项目不一致时，先 `studio project use <slug>`，并在回复里说明切换了项目。
不要凭记忆假设项目设定，每次以 `project info` 为准。

## 命令表

### 项目
| 命令 | 作用 |
| --- | --- |
| `studio project list / current / use <slug> / info` | 项目切换与设定查询 |

### 角色 / 场景资产
| 命令 | 作用 |
| --- | --- |
| `studio char list` | 当前项目所有角色 |
| `studio char show <角色> [--look <造型>]` | 身份卡、禁止改动项、可用 look |
| `studio char refs <角色> --look <造型> [--angle 正/3-4/侧/背] [--expr <表情>] [--light <光照>] [--shot <景别>]` | 按条件匹配参考图 |
| `studio char add / look add` | 新建角色 / 造型（草稿态） |
| `studio loc list / show / refs / add` | 场景，参数同角色 |
| `studio asset gen --engine gpt-image\|comfy --prompt ... [--ref <asset_id>...]` | 生成图像素材 |
| `studio asset edit <asset_id> --instruction ... [--mask ...]` | 改图 |
| `studio asset save <文件> --kind <类型> --link <char/loc/look id> --tags ...` | 入库 |
| `studio asset show <asset_id>` | 素材详情和血缘 |

### 镜头
| 命令 | 作用 |
| --- | --- |
| `studio scene list / show <场次>` | 场次和镜头列表 |
| `studio shot plan <场次> --file <shots.json>` | 写入镜头表 |
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
3. **定稿态只读。** `locked` 状态的角色、造型、场景不能改，需要改请 @ 人类。
4. **生成是异步的。** `shot gen` 返回任务 id 就结束，不要轮询。完成后 studio 会在群里通知审片。
5. **命令报错如实汇报**，附原始错误信息，不要换个方式绕过权限。

## 交接格式

发言结尾 @ 下一个人，并附一行摘要，方便对方直接接手：

```
@林野 交接：S03 共 8 镜，镜头表已写入。重点 SH004、SH007（有打斗）。
```

没有后续工作时不要 @ 任何人。
