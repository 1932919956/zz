# 更新日志

## v0.1.1 —— 托管模式

### 新增

- **托管模式**（项目会议室右上角「⚡ 托管模式」）：
  - 方案待确认 → 自动确认，并把每轮 `requiresUserAcceptance` 设成 `false`（负责人自验）
  - 轮次成品就绪且整合检查通过 → 自动验收
  - **决策卡 / 检查不通过 / 任务失败 → 停下等人**，不代你决定方向
  - 每一步记在顶部横带，可展开看全部记录
  - 开关状态存 `localStorage`，按项目隔离

### 说明

- 实现方式：前端定时器（1.2 秒）轮询快照状态，复用「确认方案」「通过」按钮背后的同一套 RPC，**不改后端**
- 已知局限：依赖窗口开着；最后一轮仍强制人工验收

---

## v0.1.0 —— 增强分支首个版本

基于 [tonyAmadeus/offAice](https://github.com/tonyAmadeus/offAice) 修改。

### 新增

**`bridge/` 适配层（本分支的核心）**

- `bridge/api-acp.mjs` —— 把任意 OpenAI 兼容接口变成 ACP 成员。支持 `chat` / `responses` / `anthropic` 三种协议，自带工具循环、插件、会话记忆、上下文压缩、失败重试
- `bridge/plugins/image-gen.mjs` —— `generate_image`（文生图）、`edit_image`（图生图）
- `bridge/plugins/web-search.mjs` —— `web_search`，Bing → 360 → 百度 三级回退
- `bridge/plugins/memory.mjs` —— `remember` / `recall` / `forget`
- `bridge/plugins/workbuddy.mjs` —— `ask_workbuddy` / `workbuddy_status`
- `bridge/mcp-tools.mjs` —— 把上述 7 个工具通过 **MCP** 暴露给 OpenCode 等运行时
- `bridge/生图.mjs` —— 命令行文生图 / 图生图（给 DSH、Codex 这类能跑命令的成员）
- `bridge/渲染视频.mjs` —— 分镜图 + 运镜 + 字幕 → mp4（ffmpeg）

**AIROOM 本体**

- **方案确认页逐任务改负责人**：新增 `projectFlow.plan.retarget`，纯改数据不调模型
- **执行端「免密钥」登录方式**：目录里加 `opencode-free`，选中后不注入 provider 配置，让 OpenCode 用它自带的免费模型
- **剪贴板粘贴**：会议 / 工位支持粘贴图片和文字，含 Ctrl+V 兜底和右键菜单
- **上下文压缩保留任务**：压缩时永远保留第一条用户消息

### 修改

- **工作副本 / 还原点 / 成果清单的上限**：单文件 128 MB → **512 MB**，总量 1 GB → **2 GB**
- **菜单栏**：`setMenuBarVisibility(false)` → `autoHideMenuBar: true`（前者会杀掉键盘快捷键）
- **附件上限**：`ATTACHMENT_MAX_BYTES` 调整
- **报告页**：非工作项目不再误开

### 修复

- **免密钥登录方式被误判**：`auth.secretKeys?.every(...)` 在没有 secretKeys 时返回 `undefined`，取反后把可用的登录方式判成"未填 Key"，选完立刻被切回上一个
- **免密钥时崩** `Cannot read properties of undefined (reading '0')`：`secretKeys![0]` 在没有 secretKeys 时抛错
- **上下文压缩把任务本体压丢**：原来从 `messages[0]` 开始切，任务就在第 0 条；现在永远保留
- **枚举校验误判顶层 `kind`**：`kind` 在不同层级含义不同（顶层是 `integration-check`，findings 里才是 `verified|suspected|suggestion`），加了跳过名单
- **`responses` 协议下工具被关闭**：`useTools()` 原来只允许 `chat`
- **命令证据匹配不上**：提示词里加了"必须逐字复制实际执行的 command"
- **HTTP 头脏字符**：`API_KEY` 里混进 `←` 这类非 Latin-1 字符时，提前给出可读的错误
- **重试包装**：`API_RETRIES` 默认 5 次，退避 3 → 6 → 12 → 24 → 30 秒

### 文档

- README 新增「这个分支多了什么」「快速开始（从源码运行）」
- 新增 `docs/本分支改动.md`（本文的详细版）
- 新增 `bridge/README.md`（适配层与各插件用法）
- 源码里的个人绝对路径与中转站示例改为中性占位
