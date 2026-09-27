# 本站媒体配置

`.env` 的 `COMPOSE_FILE` 加载 `docker-compose.local-media.yml`，不开放额外公网端口。

- 图片：`codex-image` 使用与 `cli` 相同的登录卷。只开放 Codex 内置出图，禁用 shell、MCP、浏览器和插件；每次一张。片场仍使用 `gpt-image` 引擎标识，但地址指向内部桥接服务，模型标识为 `codex-image`。支持生成、参考图和指令改图，不支持 mask。图片消耗 Codex 订阅额度，不需要 OpenAI API Key。
- 配音：`local-tts` 使用 CPU 上的 Kokoro v1.1 中文 ONNX int8 模型。模型在构建时下载并校验 SHA256，运行时仅连接 `internal: true` 网络，不能回退到云端。固定女声 `zf_001` / `zf_002`，男声 `zm_009` / `zm_010`；默认 `alloy` 映射到 `zf_001`。不支持声音克隆或情绪指令。
- 视频：保持 ai.myddls.com 的 Seedance 服务；与上述两个服务相互独立。

服务端内部令牌在权限 600 的 `.env` 中，对应连接参数通过片场“模型密钥”保存；不把这些令牌作为 OpenAI Key 使用，也不写入角色或 Skill。

```bash
docker compose build local-tts
docker compose up -d --no-deps codex-image local-tts studio
docker compose ps
```

角色配置脚本是本站完整预设；一般接入变更只更新相关段落，避免覆盖用户后来修改的角色内容。

## 已完成的验证（2026-09-27）

- Codex 内置出图成功，测试提示词为：`Generate a simple small square image of a blue ceramic cup on a plain white background, no text.` 不是 Python 图像 API 回退。
- 经片场 `gptimage.edit` 和内部桥接完成参考图编辑，提示词为：`Change only the blue ceramic glaze of the cup to warm red. Preserve the shape, handle position, white background, shadows, composition and lighting. No text or logo.` 已目视检查结果。
- 原图与改图分别保存在 `workspace/media-tests/codex-cup-original.png`、`workspace/media-tests/codex-cup-edited.png`，未添加到用户项目素材库。
- 本地男/女声经片场 `tts.speak` 生成 MP3，分别保存在 `workspace/media-tests/local-tts-male.mp3`、`workspace/media-tests/local-tts-female.mp3`。测试文本为“你好，这是剧组的本地配音测试。图片交给美术，镜头交给摄影，故事从这里开始。” 女声为 24 kHz 单声道、8.352 秒，已检查非静音音频。
- 两个媒体服务都拒绝无令牌访问。TTS 的运行容器已实测无法连接外网；没有发布宿主机端口。
- 旁白和画外音走本地 TTS；出镜对白仍由 Seedance 连同画面生成，保留原来的口型同步流程。此次没有创建收费视频任务。

资料：
- https://learn.chatgpt.com/docs/image-generation
- https://k2-fsa.github.io/sherpa/onnx/tts/pretrained_models/kokoro.html
- https://huggingface.co/hexgrad/Kokoro-82M-v1.1-zh
