# bridge —— AI 成员的适配层

这个目录让 AIROOM 能把**各种 AI** 接成"成员"。每个成员最终都是一个 **ACP（Agent Client Protocol）** 进程，AIROOM 通过 stdio + JSON-RPC 和它对话。

## 目录里有什么

| 文件 | 作用 |
| --- | --- |
| `api-acp.mjs` | **主适配器**：把任何 OpenAI 兼容接口变成 ACP 成员。支持 `chat` / `responses` / `anthropic` 三种协议，自带工具循环、插件、会话记忆、上下文压缩 |
| `wb-acp.mjs` | WorkBuddy 适配器 |
| `plugins/image-gen.mjs` | `generate_image`（文生图）+ `edit_image`（图生图） |
| `plugins/web-search.mjs` | `web_search`：Bing → 360 → 百度 三级回退 |
| `plugins/memory.mjs` | `remember` / `recall` / `forget`：跨会话记忆 |
| `plugins/workbuddy.mjs` | `ask_workbuddy` / `workbuddy_status`：把活派给 WorkBuddy |
| `mcp-tools.mjs` | **MCP 服务**：把上面这些工具暴露给 OpenCode 等支持 MCP 的运行时 |
| `生图.mjs` | 命令行生图 / 图生图（给 DSH、Codex 这类能跑命令的成员） |
| `渲染视频.mjs` | 分镜图 + 运镜 + 字幕 → mp4（ffmpeg，确定性强） |

## 快速开始：让一个 OpenAI 兼容接口变成成员

在 AIROOM 里：**设置与连接 → 添加连接 → 程序**

```
程序路径：<本目录>/api-acp.mjs
启动参数：（留空）
环境变量：
  API_BASE=https://your-relay.example/v1
  API_KEY=sk-xxxx
  API_MODEL=your-model-id
  API_STYLE=chat
```

**`API_STYLE` 怎么选**：

| 值 | 什么时候用 |
| --- | --- |
| `chat`（默认） | 绝大部分中转站 / OpenAI 兼容接口，**支持工具** |
| `responses` | OpenAI Responses API、Codex 本机代理（`127.0.0.1:15721`），**也支持工具** |
| `anthropic` | Claude Messages API（工具未实现） |

## 工具

`api-acp.mjs` 自带 11 个内置工具（读写文件、跑命令、glob/grep、抓网页等），加上插件共 **18 个**。

**插件是按需加载的**：删掉某个 `plugins/*.mjs`，对应工具就不出现。

## 生图 / 图生图配置

生图插件读 `~/.workbuddy-ai/mcp-servers/avemujica-image/config.json`：

```json
{
  "base_url": "https://your-image-api.example",
  "api_key": "sk-xxxx",
  "default_model": "gpt-image-2",
  "default_size": "1024x1024"
}
```

也可以用环境变量 `IMAGE_BASE` / `IMAGE_KEY` / `IMAGE_MODEL` 覆盖。

命令行版本（`生图.mjs`）同样读这份配置：

```bash
# 文生图
node 生图.mjs --prompt "描述" --out "out.png" --size 1536x1024

# 图生图
node 生图.mjs --image "原图.png" --prompt "改成黄昏色调" --out "new.png"
```

## 让 OpenCode 也用上这些工具

`mcp-tools.mjs` 是个标准 MCP 服务，注册到 OpenCode 的配置里即可：

```json
{
  "mcp": {
    "airoom-tools": {
      "type": "local",
      "command": ["node", "<本目录>/mcp-tools.mjs"],
      "enabled": true
    }
  }
}
```

## 注意

- 这个目录里的 `*.json`、`*.log`、`.api-acp-sessions/` 都是**运行期数据**，不要提交。
- 密钥由 AIROOM 用 Windows DPAPI 加密保存，**不会**写进这里的文件。