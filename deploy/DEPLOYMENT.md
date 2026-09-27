# bot.myddls.com 部署记录

更新于 2026-09-27。本目录记录服务器上已验收的部署定制，不包含运行数据或凭据。
部署定制基于 `feat/studio` 的 `8b06eb7`；同步时保留远端后续提交。

## 本次同步与远端更新

`440146b` 保存了本机已部署代码的完整快照（凭据和运行数据除外）。本次合并保留了
远端 `8fd3d27` 的内置剧组与 MiniMax 功能，并为已配置的本地 Kokoro 保留独立路由，
本地失败不会回退云服务。已有项目剧组模板时，启动不会再创建第二套通用四人剧组。

同步操作只提交/推送代码，没有重启线上容器或把远端的新功能自动部署到生产。
生产运行版本仍对应 `440146b` 快照；合并后的分支版本应按正常升级流程验收后部署。

## 运行拓扑

| 组件 | 当前配置 |
| --- | --- |
| 域名 / 服务器 | `https://bot.myddls.com` / `151.241.129.73` |
| 工作目录 | `/root/cirrayabot` |
| HTTPS | 宿主机 Caddy，反向代理到 `127.0.0.1:8082` |
| Compose | `multi-agent`；`docker-compose.yml:docker-compose.local-media.yml` |
| 启用模块 | `studio,cli`；Agent shell 工具关闭 |
| 服务 | `app`、`db`、`studio`、`cli`、`codex-image`、`local-tts` |
| 剧组推理 | 已登录的 Codex CLI 订阅；四个成员均使用 `runtime=codex`，无需聊天模型 API Key |
| 图片 | Codex 原生生成/编辑，经内部 Images API 兼容桥接；每次一张 |
| 视频 | `https://ai.myddls.com`；Seedance `seedance-2.0` / `seedance-2.5` |
| 配音 | 离线 CPU Kokoro 中文 TTS；默认 `zf_001`，其他音色 `zf_002`、`zm_009`、`zm_010` |

Studio、Codex、图像桥接和 TTS 均不发布公网端口。TTS 运行于 Docker internal 网络，
不访问云服务。出镜对白仍由视频模型生成；旁白和画外音使用本地 TTS。

## 登录与秘密管理

- 网页使用密码登录；服务器保存 scrypt 密码哈希，浏览器使用 Secure / HttpOnly 会话。
- 反代通过私有 `WEB_PROXY_SECRET` 传递可信 HTTPS 标识。实际 Caddyfile 留在宿主机，
  不上传包含密钥的配置。
- `.env` 权限为 `600`；含数据库密码、内部服务令牌和登录哈希，不能提交。
- 视频及内部媒体连接密钥在 Studio 配置中；Codex 登录态在 Docker `clihome` 卷中。
- `.env.example` 只有变量名和空值。`workspace/` 的聊天导出、测试图片、音频、截图，
  PostgreSQL 备份和 Docker 数据卷都不属于本次代码同步。
- 部署中还保留原生客户端的访问令牌认证；`/?k=...` 不绕过浏览器密码登录。

## 固定四岗与项目隔离

顾衡负责导演统筹，苏棠负责美术，林野负责摄影与视频提示词，严青负责审片/场记。
岗位、Skill、默认画幅、单镜数量和本地媒体约定已配置，用户不必填写长参数表。

一个项目对应一个独立剧组、四个独立成员 ID、独立 Skill 副本和工作目录。
新剧组不复制旧聊天、记忆、素材或任务；旧项目及记录保留。

- 打开网站默认进入剧组聊天。
- 手动「新建项目 / 剧组」只填写作品名称，第一条需求落在该剧组。
- `新项目：需求` 直接创建；其他消息先经过不读取旧聊天的本地 Codex 分类。
- 修改、确认、追问留在原剧组；明确的新作品创建独立团队并切换。
- Studio 在服务端固定成员所属项目，拒绝跨项目读取、切换和写入。
- 自动建项目不等于批准付费生成；原来的开工、定稿和成片确认仍保留。

详细说明：[项目剧组](PROJECT_CREWS.md)、[本地图片与配音](LOCAL_MEDIA.md)。
`configure-local-crew.mjs` / `configure-project-crews.mjs` 是这个部署的显式迁移工具，
包含已知的成员与项目 ID；不要在其他数据库上盲目执行。

## 运维与恢复

在已经配置好秘密和 Studio 连接参数的本机：

```bash
docker compose config --quiet
docker compose build app studio cli local-tts
docker compose up -d
docker compose ps
docker compose exec -T app node deploy/test-project-crews.mjs
```

不要为获取诊断信息输出完整 `docker compose config`、环境变量或 Codex auth 文件。
升级前备份 PostgreSQL；迁移只增加表/字段，不删除现有聊天或项目。
恢复时需要数据库、`studiodata`、`clihome`、工作目录和服务器私有 `.env` / 反代配置；
Git 仓库本身不是运行数据备份。

## 验收

- HTTPS 与密码会话、桌面与手机聊天入口检查通过。
- 两个事务内临时项目的八名成员、岗位、Skill、空历史和空记忆相互独立。
- 真正调用本地 Codex 验证：手动新建后首条需求、普通追问、不同题材新作品、显式新建。
- 验证跨项目读取/切换/写入返回拒绝；三个临时验收项目已清理，原项目未改动。
- 图像生成及参考图编辑、本地两种音色已验证，记录见 LOCAL_MEDIA.md。
- 剧组路由验收未调用图像或收费视频生成接口。

`check-crew-ui.mjs` 是本机只读浏览器验收脚本，需提供已安装的 Playwright；
`e2e-project-routing.mjs` 会建立并清理专用临时项目、消耗少量 Codex 订阅额度，
只应由管理员在无生产任务的维护时段主动运行。
