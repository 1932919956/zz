# AIROOM · 本地多成员 AI 工作台（分享版）

AIROOM 是一个 Windows 桌面程序：把 **Codex / Claude / DSH** 这类本地 CLI，以及任意 **OpenAI 兼容接口**，统一成一个个"AI 成员"，放进「工位」「项目会议室」「茶歇室」里协作干活。成员能读写文件、执行命令、联网搜索、看图、看视频、生图，并且记得你说过的话。

- 不需要安装 Node、Python，解压即用
- API 成员免装客户端，填一个接口地址 + Key 就能聊天
- 数据全部留在本机（`%USERPROFILE%\.airoom`）

---

## 一、这个仓库里有什么

| 目录 | 内容 |
| --- | --- |
| `app/` | 分享版打包后的程序本体（Electron 主进程 / preload / worker、渲染层静态资源、运行时依赖清单） |
| `bridge/` | API 成员适配器（Node ESM + Python 源码）：`api-acp.mjs` 负责把 OpenAI 兼容接口接进 ACP 协议 |
| `bridge/plugins/` | 插件：联网搜索、生图、记忆、TTS、看视频、派活给 WorkBuddy |
| `patches/` | 相对官方 AIROOM 的源码改动补丁（`git apply` 可用） |
| `docs/` | 使用说明、更新说明、补丁说明 |

**不包含**：`node_modules`、`AIROOM.exe`（主程序 200 MB+，放不进 Git）、各类备份目录。
可执行完整包请看本仓库的 **Releases** 页面。

> 本仓库已去除所有个人隐私信息：不含本机路径、用户名、密钥。文档中的绝对路径统一写成 `C:\Users\<你的用户名>`。

---

## 二、快速开始（用发行版）

1. 从 **Releases** 下载最新的免安装包，解压到任意目录（路径里**不要有中文和空格**，例如 `D:\AIROOM`）。
2. 双击 `AIROOM.exe`。首次启动会：
   - 在 `%USERPROFILE%\.airoom\data` 建数据目录（聊天记录、密钥都在这里）
   - 常驻托盘；关窗口只是最小化，真正退出用托盘菜单
3. 左下角「设置与连接」→「连接与版本」→ 添加连接，按下面的方式配一个成员。

### 配一个 API 成员（推荐，最省事）

1. 连接类型选「API 接口（免安装）」
2. 程序路径填：`<你解压的位置>\bridge\api-acp.mjs`（例：`D:\AIROOM\bridge\api-acp.mjs`）
3. 环境变量（每行一个）：

   ```
   API_BASE=https://你的中转站/v1
   API_MODEL=模型名
   API_KEY=你的密钥
   API_STYLE=chat
   ```

4. 点环境变量框下面的 **「保存连接」**（不是对话框底部的「保存设置」）
5. 回到成员卡，起名字、挑形象，开新话题即可对话

Key 填不进去时，可以直接编辑 `bridge\api-keys.json`：

```json
{
  "https://你的中转站": "sk-你的key"
}
```

---

## 三、成员能力

- 读写文件、精确改文件、按模式找文件、按内容搜索
- 执行命令（PowerShell / cmd）
- 抓网页、联网搜索（Bing 优先，百度 / 360 兜底）
- 看图（png / jpg / webp / gif 直接给模型看）
- 看视频（自动用 ffmpeg 抽 8 帧）
- 生图（`bridge/api-keys.json` 或 `IMAGE_BASE` / `IMAGE_KEY` / `IMAGE_MODEL`）
- 长期记忆（memory 插件）

文件权限默认是**全盘**。只想让它动自己的工位目录，加环境变量：

```
API_TOOL_SCOPE=workspace
```

---

## 四、部署 / 二次开发

本仓库的 `app/dist` 是构建产物，直接改它可以看到效果；要从源码重建，按官方仓库 + 补丁的方式：

```powershell
git clone <官方 AIROOM 仓库>
cd <官方 AIROOM 仓库>
git apply ..\patches\源码改动补丁.patch
npm install
npm run build          # 产物在 dist\
```

把 `dist\` 覆盖到 `resources\app\dist` 即可生效，**不用重新打包 exe**。

要打完整安装包，再用 Electron 打包（electron-builder / electron-winstaller，见 `app/package.json` 的 `allowScripts`）。

### 目录对照

```
AIROOM.exe            主程序
resources\app\        程序本体（含界面和后台）
bridge\               API 成员适配器，必须一起带上
bridge\plugins\       插件：联网搜索、生图、记忆、派活给 WorkBuddy
bridge\api-keys.json  界面里填不了 key 时，在这里按地址填
```

---

## 五、常见坑

1. `%USERPROFILE%\.airoom\data\electron` **千万不要删**：里面是系统级加密密钥，删了已保存的 API Key 全部失效。
2. 想换干净环境：先退出 AIROOM，把 `%USERPROFILE%\.airoom` 整个改名备份，再启动；不要只删子目录。
3. 改完连接设置要**开个新话题**才生效（老话题还挂着旧进程）。
4. 房间（项目会议室 / 茶歇室）里的成员是**只读**的：能查能看，不能改文件、不能执行命令。要动手去「工位」或项目的「执行」阶段。

---

## 六、说明

- 本仓库只做分享与二次开发用途，不含官方许可证之外的内容。
- 问题 / 建议请开 Issue。
