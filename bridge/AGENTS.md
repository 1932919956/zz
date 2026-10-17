# AGENTS.md — 给 Codex 的协作协议

> **先注意一件事**：这个文件只有当你（Codex）的工作目录在 `bridge/` 里面时才会被自动加载。
> 协作台的引擎在调用内部规划器/执行方/审核方时，工作目录都在 `bridge/` **外面**
> （`../workspace/<任务ID>`、`../.agent_workdir`），所以这些内部调用**不会**看到本文，
> 不会被下面这套"你是下发方/审核方"的设定干扰。

---

## 0. 现在默认是「引擎全自动」，你通常不需要做任何事

`orchestrator.py` 已经在跑三件事：

1. **INTAKE** —— 用户发的消息 → 你（Codex）规划成任务卡 → 建任务
2. **EXECUTE** —— 执行方领活、干活、提交结果
3. **REVIEW** —— 你（Codex）按 `acceptance` 逐条核对，给 APPROVE / REJECT，打回后自动重做

所以如果你只是"被用户叫过来看看这套东西"，**先跑 `状态.cmd``「或者 `python -X utf8 orchestrator.py --status`「看看现在什么情况，
而不是急着建任务**。

---

## 1. 你作为 CLI 手动操作时，用什么

全部在 `bridge/` 目录下执行。命令是 `bridge.py`（协议内核）：

```bash
# 下发任务（务必写清 --acceptance，这是后续审核的唯一判据）
python -X utf8 bridge.py new --title "任务标题" --spec "做什么、输入输出、约束" --acceptance "可客观判断真假的验收标准"

# 长文本走文件，避免命令行长度/引号问题
python -X utf8 bridge.py new --title "标题" --spec-file spec.md --acceptance-file acc.md

# 指到真实项目目录（默认是 ../workspace/<任务ID>）
python -X utf8 bridge.py new --title "标题" --spec-file spec.md --workdir "C:/我的项目"

# 看双方待办
python -X utf8 bridge.py inbox --by codex        # 等你审核的
python -X utf8 bridge.py inbox --by workbuddy    # 等执行的

# 审核（引擎没开时你才需要手动做）
python -X utf8 bridge.py review <任务ID> --by codex --verdict approve --comment "通过理由"
python -X utf8 bridge.py review <任务ID> --by codex --verdict reject  --comment "哪条验收标准没达到 + 具体错在哪 + 期望改成什么样"
python -X utf8 bridge.py review <任务ID> --by codex --verdict reject --comment-file 意见.md

# 其他
python -X utf8 bridge.py list
python -X utf8 bridge.py show <任务ID>
python -X utf8 bridge.py history <任务ID>
python -X utf8 bridge.py retry <任务ID> --by codex --reason "原因"    # blocked/cancelled → pending
python -X utf8 bridge.py block <任务ID> --by codex --reason "原因"
python -X utf8 bridge.py cancel <任务ID> --by codex --reason "原因"
python -X utf8 bridge.py archive
```

> Windows 上如果 `python` 不在 PATH，用完整路径：
> `C:/path/to/python.exe`（把 python 装在哪就填哪）
> 或者直接用 ``「bridge.cmd``「它已经处理好了路径和 UTF-8。

---

## 2. 状态流转

```text
pending ──执行方领取──▶ in_progress ──提交──▶ needs_review
                                                  │
                                    ┌── 你打回 ───┴── 你通过 ──┐
                                    ▼                          ▼
                                rejected                   approved ✅（关闭）
                                    │
                            执行方再领取 ──▶ in_progress …
```

`needs_review` 是唯一"卡在你手上"的节点。引擎开着时这步也是自动的，
不开引擎时你就要自己 `inbox --by codex` 轮询。

| 状态 | 含义 | 下一步归谁 |
|---|---|---|
| pending | 已下发 | 执行方 |
| in_progress | 执行中 | 执行方 |
| needs_review | 已提交结果 | **Codex（你）** |
| rejected | 被打回 | 执行方 |
| approved / cancelled | 关闭 | — |
| blocked | 卡住了 | 人 |

---

## 3. 打回意见的写法（这条最重要）

打回意见会被**原样送回给执行方作为下一轮的强制要求**。所以：

- ❌ `不行，重做`
- ❌ `质量不够`
- ✅ `验收标准第 2 条不达标：hello.py 打印的是 PONG-1，要求恰好是 PONG。请改掉后缀。`
- ✅ `验收标准第 3 条不达标：README.md 里只有 python hello.py 的文字描述，没有写清工作目录。请在运行说明里补上"在本目录执行"和完整命令。`

写清「哪一条、现在是什么样、要变成什么样」三件事。

---

## 4. 文件约定

| 路径 | 内容 |
|---|---|
| `tasks/<id>.json` | 任务主数据：状态、spec、acceptance、attempt、history、workdir、artifacts |
| `results/<id>.md` | 执行方提交的结果全文（含工作目录文件清单） |
| `reviews/<id>.md` | 审核意见，**逐轮追加**，完整保留 |
| `messages/codex.jsonl` / `messages/workbuddy.jsonl` | 聊天频道，界面靠它显示 |
| `logs/<id>/attempt-N-*.md` | 第 N 轮的执行/审核原文与错误 |
| `config.json` | 引擎配置 |

消息层的格式（`messages/*.jsonl`，每行一条 JSON）：

```json
{"id":"a1b2c3d4","at":"2026-10-16T21:15:03+08:00","channel":"codex",
 "role":"codex","kind":"chat","text":"...","task_id":""}
```

- `channel`：`codex` / `workbuddy`
- `role`：`user`（人）/ `codex` / `workbuddy`
- `kind`：`chat` / `task` / `progress` / `result` / `review` / `system`

`new` / `claim` / `submit` / `review` 会自动往频道里播报对应消息，
所以一般不用手动 `post`。

---

## 5. 如果你想自己当那个"轮询的人"

引擎没开、你又想用命令行把闭环跑起来，脚本这样写：

```python
# 伪代码
while True:
    for t in inbox("codex"):                  # 等你审核的
        result = read("results/%s.md" % t.id)
        if 满足(t.acceptance, result):
            review(t.id, "approve", "通过理由")
        else:
            review(t.id, "reject", "第 N 条不达标：现在是这样，要改成那样")
    sleep(60)
```

但**更省事的做法是直接启动引擎**：`启动引擎.cmd` 或 `python -X utf8 orchestrator.py`，
它会替你干这件事，而且执行环节也一起包了。
