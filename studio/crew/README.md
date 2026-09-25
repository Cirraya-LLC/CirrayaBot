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
4. **密钥不进 agent 容器。** Seedance / GPT 图像 / ComfyUI 的 key 只在 studio 服务里，
   agent 用按角色限权的 `STUDIO_TOKEN`。

## 成员

| 名字 | 职位 | 建议上游 | Skills |
| --- | --- | --- | --- |
| 顾衡 | 导演（组长） | Claude，推理强度高 | studio-basics, shot-breakdown |
| 苏棠 | 美术指导 | GPT | studio-basics, character-bible |
| 林野 | 摄影指导 | Claude，推理强度中 | studio-basics, shot-prompting |
| 严青 | 审片 / 场记 | Claude，推理强度高，**必须支持图片输入** | studio-basics, footage-review |

## 接力流程

```
人类 → 顾衡（拆场次、出镜头表）
         ├→ 苏棠（缺角色/场景资产时补齐）→ @顾衡
         └→ 林野（写 prompt、发起生成）
                  → studio 批量生成、初筛、出对比图
                  → studio 事件通知 → @严青（审片）
                        ├ 通过 → @顾衡
                        ├ 打回（prompt 问题）→ @林野
                        ├ 打回（资产问题）→ @苏棠
                        └ 同镜头第 3 次打回 → @人类
顾衡 → 整场过审后向人类汇报
```

## Token 权限（studio 侧实现）

| Agent | 可用命令 |
| --- | --- |
| 顾衡 | 全部读；`shot plan`；`shot lock`；`project`（只读） |
| 苏棠 | 全部读；`asset gen/edit/save`；`char *`；`loc *` |
| 林野 | 全部读；`shot gen`；`shot prompt` |
| 严青 | 全部读；`shot sheet`；`shot approve`；`shot reject`；`review *` |

`char lock` / `loc lock`（定稿）和项目设定修改只有人类能做，走平台的执行前审批。

## 导入方式

`bots/` 只在首次启动时作为种子，之后改它无效。已部署的实例请在 Web UI 里新建 agent，
把 `agents/*.md` 的「性格描述」部分粘进去；skill 放进技能库。
