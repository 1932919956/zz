#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
bridge_mcp.py — Codex 协作台的 MCP 出口（stdio transport，零第三方依赖）

目的：让 WorkBuddy（或任何支持 MCP 的客户端）能够直接领活 / 干活 / 交活，
参与进 Codex 的协作闭环：

    你在 WorkBuddy 里说「处理 bridge 待办」
        -> WorkBuddy 调 bridge_inbox   看到有哪些任务、验收标准是什么
        -> WorkBuddy 调 bridge_show    看某个任务的完整需求 + 上一轮打回意见
        -> WorkBuddy 调 bridge_claim   领取（同时把工作目录告诉它）
        -> WorkBuddy 用它自己的文件/命令工具真的把活干出来
        -> WorkBuddy 调 bridge_submit  交结果
        -> 协作台的 Codex 审核引擎自动审核
           ├─ 通过 -> 结束
           └─ 打回 -> 任务变 rejected，下一轮 bridge_inbox 会再次出现，
                      并带上「上一轮为什么被打回」，照着改就行

设计上和参考服务（avemujica-image）保持完全一致的协议实现：
  - stdout 只放 JSON-RPC 帧（换行分隔），日志一律走 stderr
  - 不 import 任何第三方包
"""

import json
import os
import subprocess
import sys
import time

# 路径与「再启动自己」都交给 _rt（打包成 exe 后 sys.executable 是 exe 自己）
from _rt import BASE_DIR, child_env, cli_cmd

BRIDGE_PY = os.path.join(BASE_DIR, "bridge.py")

# 我是谁：在那个 AI 的 mcp.json 条目的 env 里用 BRIDGE_AGENT 指定。
# 同一个 MCP 服务可以被多个 AI 共用，各报身份、各领各的活。
# 不填就默认 workbuddy（向后兼容）。
MY_AGENT = (os.environ.get("BRIDGE_AGENT") or "workbuddy").strip()
AGENTS_FILE = os.path.join(BASE_DIR, "agents.json")

TASKS_DIR = os.path.join(BASE_DIR, "tasks")
RESULTS_DIR = os.path.join(BASE_DIR, "results")
REVIEWS_DIR = os.path.join(BASE_DIR, "reviews")
TMP_DIR = os.path.join(BASE_DIR, ".tmp")

STATUS_CN = {
    "pending": "待执行", "in_progress": "执行中", "needs_review": "待审核",
    "rejected": "已打回（要重做）", "approved": "已通过", "blocked": "已阻塞",
    "cancelled": "已取消",
}


def log(*parts):
    print("[bridge-mcp]", *parts, file=sys.stderr, flush=True)


# ------------------------------------------------------------------ 底层读写

def read_json(path, default=None):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def read_text(path, limit=None):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            t = f.read()
        return t[-limit:] if limit else t
    except Exception:
        return ""


def list_tasks():
    rows = []
    if os.path.isdir(TASKS_DIR):
        for fn in sorted(os.listdir(TASKS_DIR)):
            if fn.endswith(".json"):
                t = read_json(os.path.join(TASKS_DIR, fn))
                if isinstance(t, dict) and t.get("id"):
                    rows.append(t)
    rows.sort(key=lambda x: x.get("created_at", ""))
    return rows


def load_task(tid):
    return read_json(os.path.join(TASKS_DIR, tid + ".json"))


def run_bridge(args, timeout=120):
    try:
        p = subprocess.run(cli_cmd(*args), capture_output=True, text=True,
                           encoding="utf-8", errors="replace",
                           cwd=BASE_DIR, timeout=timeout, env=child_env())
        return p.returncode, (p.stdout or "").strip(), (p.stderr or "").strip()
    except Exception as e:
        return 1, "", "%s: %s" % (type(e).__name__, e)


def tail(text, n):
    text = (text or "").strip()
    return text if len(text) <= n else "…" + text[-n:]


def agent_known():
    data = read_json(AGENTS_FILE, {}) or {}
    return any(a.get("id") == MY_AGENT for a in (data.get("agents") or []))


def resolve_workdir(t):
    """任务在哪个目录干活（和 orchestrator 的规则保持一致）。"""
    wd = (t.get("workdir") or "").strip()
    if wd:
        return wd if os.path.isabs(wd) else os.path.abspath(os.path.join(BASE_DIR, wd))
    return os.path.join(os.path.dirname(BASE_DIR), "workspace", t["id"])


# ------------------------------------------------------------------ 工具的公共渲染

def render_task_brief(t, verbose=False):
    tid = t["id"]
    lines = []
    head = "[%s] %s" % (tid, t.get("title", "(无标题)"))
    lines.append(head)
    lines.append("    状态：%s · 第 %s 次尝试 · 执行方：%s"
                 % (STATUS_CN.get(t.get("status"), t.get("status")),
                    t.get("attempt", 0), t.get("handler", "engine")))
    lines.append("    工作目录：%s" % resolve_workdir(t))
    if verbose:
        lines.append("    需求：")
        for ln in (t.get("spec") or "(空)").splitlines():
            lines.append("        " + ln)
        lines.append("    验收标准（审核方就按这个判，必须逐条满足）：")
        for ln in (t.get("acceptance") or "(任务没写验收标准)").splitlines():
            lines.append("        " + ln)
    else:
        acc = (t.get("acceptance") or "").replace("\n", " ")
        lines.append("    验收标准：%s" % (acc[:160] + ("…" if len(acc) > 160 else "")))
    return "\n".join(lines)


def last_review_tail(tid, n=900):
    p = os.path.join(REVIEWS_DIR, tid + ".md")
    if not os.path.exists(p):
        return ""
    txt = read_text(p)
    # 只取最近一轮（从最后一个二级标题开始）
    idx = txt.rfind("\n## ")
    return tail(txt[idx:] if idx >= 0 else txt, n)


# ------------------------------------------------------------------ 各工具实现

def do_inbox(args):
    if not agent_known():
        return True, (
            "我这个 MCP 服务是用标识「%s」启动的，但协作台的参与者列表里没有它。\n"
            "请让用户在协作台里添加这个参与者，或在命令行跑：\n"
            "    CodexBridge.exe --cli agent add %s --name \"显示名\" --kind mcp\n"
            "并确认 mcp.json 里这一项的 env 是 {\"BRIDGE_AGENT\": \"%s\"}。"
            % (MY_AGENT, MY_AGENT, MY_AGENT)
        )
    include_engine = bool(args.get("include_engine"))
    mine, others = [], []
    for t in list_tasks():
        if t.get("status") not in ("pending", "rejected"):
            continue
        h = t.get("handler") or "engine"
        if h == MY_AGENT:
            mine.append(t)
        elif include_engine:
            others.append(t)

    if not mine and not others:
        waiting = [t for t in list_tasks() if t.get("status") == "needs_review"]
        out = ["现在没有等待执行的任务。"]
        if waiting:
            out.append("有 %d 个任务正在等 Codex 审核（不用你管）：%s"
                       % (len(waiting), ", ".join(x["id"] for x in waiting)))
        else:
            out.append("也没有待审核的任务 —— 整条流水线是空的。")
        out.append("")
        out.append("如果用户是想让你接手新活，可以让他在协作台里先生成一个任务"
                   "（把任务标成 handler=workbuddy），或者直接用 bridge_show 看某个任务 ID。")
        return False, "\n".join(out)

    lines = []
    if mine:
        lines.append("等待你（%s）处理的任务：%d 个" % (MY_AGENT, len(mine)))
        lines.append("")
        for t in mine:
            block = [render_task_brief(t)]
            if t.get("status") == "rejected":
                rv = last_review_tail(t["id"])
                if rv:
                    block.append("    ! 上一轮被打回的原因（必须解决）：")
                    for ln in rv.splitlines():
                        if ln.strip():
                            block.append("        " + ln.strip())
            lines.append("\n".join(block))
            lines.append("")
    if others:
        lines.append("另外还有 %d 个任务归别人 / 引擎执行（不用你管）：%s"
                     % (len(others), ", ".join(x["id"] for x in others)))
        lines.append("")

    lines.append("下一步：对你想做的那个任务调 bridge_show(task_id) 看完整需求，"
                 "然后 bridge_claim(task_id) 领取并开始干活。")
    return False, "\n".join(lines)


def do_show(args):
    tid = (args.get("task_id") or "").strip()
    if not tid:
        return True, "缺少参数 task_id"
    t = load_task(tid)
    if not t:
        return True, "找不到任务 %s。可以先用 bridge_inbox 看有哪些任务。" % tid

    parts = [render_task_brief(t, verbose=True)]
    parts.append("")
    parts.append("整份需求原文：")
    parts.append(t.get("spec") or "(空)")
    parts.append("")
    parts.append("整份验收标准原文：")
    parts.append(t.get("acceptance") or "(任务没写验收标准，请按需求自行把握)")

    hist = t.get("history") or []
    if hist:
        parts.append("")
        parts.append("流转历史：")
        for e in hist[-12:]:
            note = (e.get("note") or "").replace("\n", " ")
            parts.append("    %s  [%s] %s %s" % (e.get("at", ""), e.get("actor", ""),
                                                e.get("action", ""), note[:140]))

    rv = read_text(os.path.join(REVIEWS_DIR, tid + ".md"))
    if rv:
        parts.append("")
        parts.append("以往每一轮的审核意见（逐轮累加）：")
        parts.append(rv)

    res = read_text(os.path.join(RESULTS_DIR, tid + ".md"))
    if res:
        parts.append("")
        parts.append("上一次提交的结果（如果被打回了，说明这份不合格）：")
        parts.append(tail(res, 4000))

    return False, "\n".join(parts)


def do_claim(args):
    tid = (args.get("task_id") or "").strip()
    if not tid:
        return True, "缺少参数 task_id"
    t = load_task(tid)
    if not t:
        return True, "找不到任务 %s" % tid

    wd = (args.get("workdir") or "").strip()
    if wd:
        rc, out, err = run_bridge(["set", tid, "--workdir", wd, "--by", MY_AGENT])
        if rc != 0:
            return True, "记录工作目录失败：%s" % (err or out)
        t = load_task(tid) or t

    rc, out, err = run_bridge(["claim", tid, "--by", MY_AGENT])
    if rc != 0:
        return True, "领取失败：%s" % (err or out)

    t = load_task(tid) or t
    lines = [
        "已领取任务 [%s] %s（第 %s 次尝试）" % (tid, t.get("title", ""), t.get("attempt", 1)),
        "",
        "工作目录：%s" % resolve_workdir(t),
        "需求：",
        t.get("spec") or "(空)",
        "",
        "验收标准（做完请逐条自查，审核方按这个判定）：",
        t.get("acceptance") or "(没写，按需求把握)",
        "",
    ]
    rv = last_review_tail(tid)
    if rv and t.get("attempt", 1) > 1:
        lines.append("本次必须解决的上一轮打回意见：")
        lines.append(rv)
        lines.append("")
    lines.append("现在请真的动手把活干出来：在工作目录里创建/修改文件，能跑的命令就跑一遍。")
    lines.append("干完后调 bridge_submit(task_id, summary, body) 交结果。")
    lines.append("body 里请写清楚：做了什么 / 动了哪些文件 / 逐条对照验收标准的自查结果。")
    return False, "\n".join(lines)


def do_submit(args):
    tid = (args.get("task_id") or "").strip()
    if not tid:
        return True, "缺少参数 task_id"
    if not load_task(tid):
        return True, "找不到任务 %s" % tid
    body = (args.get("body") or "").strip()
    summary = (args.get("summary") or "").strip()
    if not body and not summary:
        return True, "至少要给 summary 或 body，否则审核方没有东西可看。"

    os.makedirs(TMP_DIR, exist_ok=True)
    bf = os.path.join(TMP_DIR, "mcp-submit-%s-%d.txt" % (tid, int(time.time())))
    with open(bf, "w", encoding="utf-8") as f:
        f.write(body or summary)

    cmd = ["submit", tid, "--by", MY_AGENT, "--summary", summary or body[:120], "--file", bf]
    arts = (args.get("artifacts") or "").strip()
    if arts:
        cmd += ["--artifacts", arts]
    rc, out, err = run_bridge(cmd)
    try:
        os.remove(bf)
    except OSError:
        pass
    if rc != 0:
        return True, "提交失败：%s" % (err or out)

    t = load_task(tid) or {}
    return False, (
        "已提交任务 [%s]，现在状态是「待审核」。\n\n"
        "接下来协作台的 Codex 审核引擎会按验收标准逐条核对，然后：\n"
        "  - 通过 -> 任务结束，你不用再管；\n"
        "  - 打回 -> 任务会重新出现在 bridge_inbox 里，并带上打回原因，"
        "你再领一次、照着改就行。\n\n"
        "如果你希望现在就推进，可以再调一次 bridge_inbox 看看有没有被打回的。"
        % tid
    )


def do_block(args):
    tid = (args.get("task_id") or "").strip()
    reason = (args.get("reason") or "").strip()
    if not tid:
        return True, "缺少参数 task_id"
    if not reason:
        return True, "请给 reason，说清为什么做不了。"
    rc, out, err = run_bridge(["block", tid, "--by", MY_AGENT, "--reason", reason])
    if rc != 0:
        return True, "标记阻塞失败：%s" % (err or out)
    return False, "已把任务 [%s] 标记为阻塞，原因已记录。人类会看到并决定怎么处理。" % tid


def do_status(args):
    rows = list_tasks()
    if not rows:
        return False, "协作台里还没有任何任务。"
    counts = {}
    for t in rows:
        counts[t.get("status")] = counts.get(t.get("status"), 0) + 1
    lines = ["协作台任务总览（共 %d 个）" % len(rows)]
    for k in ("pending", "in_progress", "needs_review", "rejected",
              "approved", "blocked", "cancelled"):
        if counts.get(k):
            lines.append("    %-24s %d" % (STATUS_CN.get(k, k), counts[k]))
    lines.append("")
    for t in rows:
        if t.get("status") in ("approved", "cancelled"):
            continue
        lines.append("    %s  %s  %s" % (
            t["id"], STATUS_CN.get(t.get("status"), t.get("status")),
            t.get("title", "")))
    return False, "\n".join(lines)


HANDLERS = {
    "bridge_inbox": do_inbox,
    "bridge_show": do_show,
    "bridge_claim": do_claim,
    "bridge_submit": do_submit,
    "bridge_block": do_block,
    "bridge_status": do_status,
}


# ------------------------------------------------------------------ MCP 协议

TOOL_DEFS = [
    {
        "name": "bridge_inbox",
        "description": (
            "列出 Codex 协作台里分配给你的、等待执行的任务。当用户说「处理 bridge 待办」「看看有什么活」"
            "「有没有任务给我」「bridge 里被谁打回了」时调用它。\n"
            "返回每个任务的 id、标题、状态、第几次尝试、工作目录、验收标准，"
            "以及被打回时必须解决的打回原因。任务由 Codex 下发，带明确验收标准。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "include_engine": {
                    "type": "boolean",
                    "description": "是否连协作台引擎自己负责的任务也列出来（默认 false，只看归你做的）。",
                },
            },
        },
    },
    {
        "name": "bridge_show",
        "description": (
            "读取某个协作台任务的完整内容：需求全文、验收标准全文、流转历史、"
            "以往每一轮的审核意见、上一次提交的结果。"
            "在 bridge_claim 之前先调它，确保你真的理解了要做什么、以及上一轮为什么被打回。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "task_id": {"type": "string", "description": "任务 id，例如 7c40a6f8。"},
            },
            "required": ["task_id"],
        },
    },
    {
        "name": "bridge_claim",
        "description": (
            "领取一个任务并开始执行。必须先领取再干活，否则协作台会认为没人接手。\n"
            "调用后会返回工作目录、完整需求、验收标准和打回意见。"
            "接着请真的动手：在工作目录里创建/修改文件，能验证就跑一遍，"
            "最后调 bridge_submit 交结果。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "task_id": {"type": "string", "description": "任务 id。"},
                "workdir": {
                    "type": "string",
                    "description": (
                        "可选。你实际在哪个目录干活（绝对路径）。"
                        "如果不填，就用任务自己记录的工作目录。"
                        "如果用户是在某个项目里跟你说话，把那个项目路径传进来，"
                        "协作台会记录下来，审核方也会去那里核对。"
                    ),
                },
            },
            "required": ["task_id"],
        },
    },
    {
        "name": "bridge_submit",
        "description": (
            "把任务做完了的成果提交回协作台，交给 Codex 审核。\n"
            "body 是给审核方看的执行报告，务必写清楚三件事："
            "1) 你做了什么；2) 动了哪些文件（相对工作目录的路径）；"
            "3) 逐条对照验收标准的自查结果（每条写「满足/不满足 + 依据」）。\n"
            "审核方手里有工作目录的真实文件内容，写虚的会被抓出来打回。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "task_id": {"type": "string", "description": "任务 id。"},
                "summary": {"type": "string", "description": "一句话摘要，会显示在协作台聊天里。"},
                "body": {"type": "string", "description": "详细的执行报告（Markdown 也行）。"},
                "artifacts": {
                    "type": "string",
                    "description": "产物文件路径，相对工作目录，逗号分隔。例如 src/sort.py,tests/test_sort.py",
                },
            },
            "required": ["task_id"],
        },
    },
    {
        "name": "bridge_block",
        "description": (
            "确实做不了时把它标记为阻塞，避免任务卡在那里。"
            "比如需求自相矛盾、缺少必要权限、外部依赖挂了。reason 要写清具体卡在哪。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "task_id": {"type": "string", "description": "任务 id。"},
                "reason": {"type": "string", "description": "为什么做不了，具体一点。"},
            },
            "required": ["task_id", "reason"],
        },
    },
    {
        "name": "bridge_status",
        "description": "看协作台的整体情况：各状态各有多少任务、还有哪些没结束。用户问「进度怎么样」时用它。",
        "inputSchema": {"type": "object", "properties": {}},
    },
]


def send(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def send_result(req_id, result):
    send({"jsonrpc": "2.0", "id": req_id, "result": result})


def send_error(req_id, code, message):
    send({"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": message}})


def handle(msg):
    method = msg.get("method")
    req_id = msg.get("id")

    if method == "initialize":
        client_ver = (msg.get("params") or {}).get("protocolVersion") or "2024-11-05"
        send_result(req_id, {
            "protocolVersion": client_ver,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": "codex-bridge", "version": "1.0.0"},
        })
        return

    if method in ("notifications/initialized", "notifications/cancelled"):
        return

    if method == "ping":
        send_result(req_id, {})
        return

    if method == "tools/list":
        send_result(req_id, {"tools": TOOL_DEFS})
        return

    if method == "tools/call":
        params = msg.get("params") or {}
        name = params.get("name")
        args = params.get("arguments") or {}
        handler = HANDLERS.get(name)
        if handler is None:
            send_error(req_id, -32602, "Unknown tool: %s" % name)
            return
        try:
            is_error, text = handler(args)
        except Exception as exc:
            log("tool crashed", repr(exc))
            is_error, text = True, "工具内部出错：%r" % exc
        send_result(req_id, {
            "content": [{"type": "text", "text": text}],
            "isError": bool(is_error),
        })
        return

    if req_id is not None:
        send_error(req_id, -32601, "Method not found: %s" % method)


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8", newline="\n")
        sys.stdin.reconfigure(encoding="utf-8")
    except Exception:
        pass

    log("server started; bridge dir =", BASE_DIR)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception as exc:
            log("bad json frame:", exc)
            continue
        try:
            handle(msg)
        except Exception as exc:
            log("handler error:", repr(exc))


if __name__ == "__main__":
    main()
