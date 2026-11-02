#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
bridge.py — Codex <-> WorkBuddy 文件信箱桥接工具

一套基于文件系统的任务协作协议，让 Codex（下发/审核方）与 WorkBuddy
（执行方）通过读写 JSON 文件完成闭环协作，无需网络、无需常驻进程。

任务生命周期：
    pending        Codex 下发，等待 WorkBuddy 领取
    in_progress    WorkBuddy 已领取，正在执行
    needs_review   WorkBuddy 已提交结果，等待 Codex 审核
    rejected       Codex 审核不通过，带反馈意见退回（可再次被领取）
    approved       审核通过，任务关闭
    blocked        执行受阻，需要 Codex/用户介入
    cancelled      任务取消

用法：
    python bridge.py init
    python bridge.py new  --title "..." --spec "..." [--from codex] [--priority high]
    python bridge.py list [--status pending] [--assignee workbuddy]
    python bridge.py show TASK_ID
    python bridge.py claim TASK_ID --by workbuddy
    python bridge.py submit TASK_ID --by workbuddy --summary "..." [--artifacts a,b] [--file path]
    python bridge.py review TASK_ID --by codex --verdict approve|reject [--comment "..."]
    python bridge.py block TASK_ID --by workbuddy --reason "..."
    python bridge.py cancel TASK_ID --by codex --reason "..."
    python bridge.py status
    python bridge.py inbox --by codex        # 待 Codex 处理（需审核）
    python bridge.py inbox --by workbuddy    # 待 WorkBuddy 处理（待执行）
    python bridge.py history TASK_ID
    python bridge.py archive
"""

import argparse
import json
import os
import shutil
import sys
import uuid
from datetime import datetime, timezone, timedelta

# ---------------------------------------------------------------- 基础配置

# 路径统一由 _rt 决定：打包成 exe 后 __file__ 会指向临时解包目录，不能用它
from _rt import BASE_DIR

TASKS_DIR = os.path.join(BASE_DIR, "tasks")
RESULTS_DIR = os.path.join(BASE_DIR, "results")
REVIEWS_DIR = os.path.join(BASE_DIR, "reviews")
ARCHIVE_DIR = os.path.join(BASE_DIR, "archive")
MESSAGES_DIR = os.path.join(BASE_DIR, "messages")
LOGS_DIR = os.path.join(BASE_DIR, "logs")
UPLOADS_DIR = os.path.join(BASE_DIR, "uploads")
CONV_FILE = os.path.join(BASE_DIR, "conversations.json")

# 会话（对话）：每个会话有独立的聊天记录和自己的任务
DEFAULT_CONV = "main"

# 参与者（AI）注册表。频道不再写死，每个参与者自动获得一个频道。
# 要接入新的 AI：bridge.py agent add <id> --name ... --kind cli|mcp|human
AGENTS_FILE = os.path.join(BASE_DIR, "agents.json")

BUILTIN_AGENTS = [
    {"id": "codex", "name": "Codex", "kind": "cli", "builtin": True,
     "desc": "规划 + 审核（调用本机 codex exec）", "cmd": ""},
    {"id": "workbuddy", "name": "WorkBuddy", "kind": "mcp", "builtin": True,
     "desc": "执行：在 WorkBuddy 里通过 MCP 领活/交活", "cmd": ""},
]

AGENT_KINDS = ("cli", "mcp", "human")

# 消息角色
ROLE_USER = "user"          # 用户（你）
ROLE_CODEX = "codex"        # Codex
ROLE_WORKBUDDY = "workbuddy"  # WorkBuddy

# 消息类型
MSG_CHAT = "chat"            # 普通聊天
MSG_TASK = "task"            # 任务下发（携带 task_id）
MSG_PROGRESS = "progress"    # 进度更新
MSG_RESULT = "result"        # 执行结果提交
MSG_REVIEW = "review"        # 审核结论
MSG_SYSTEM = "system"        # 系统提示

STATUS_PENDING = "pending"
STATUS_IN_PROGRESS = "in_progress"
STATUS_NEEDS_REVIEW = "needs_review"
STATUS_REJECTED = "rejected"
STATUS_APPROVED = "approved"
STATUS_BLOCKED = "blocked"
STATUS_CANCELLED = "cancelled"

ALL_STATUS = [
    STATUS_PENDING, STATUS_IN_PROGRESS, STATUS_NEEDS_REVIEW,
    STATUS_REJECTED, STATUS_APPROVED, STATUS_BLOCKED, STATUS_CANCELLED,
]

# 每个状态对应的「下一步由谁处理」
OWNER_BY_STATUS = {
    STATUS_PENDING: "workbuddy",
    STATUS_IN_PROGRESS: "workbuddy",
    STATUS_NEEDS_REVIEW: "codex",
    STATUS_REJECTED: "workbuddy",
    STATUS_APPROVED: "-",
    STATUS_BLOCKED: "codex",
    STATUS_CANCELLED: "-",
}

CST = timezone(timedelta(hours=8))


# ---------------------------------------------------------------- 工具函数

def now_iso():
    return datetime.now(CST).isoformat(timespec="seconds")


def ensure_dirs():
    for d in (TASKS_DIR, RESULTS_DIR, REVIEWS_DIR, ARCHIVE_DIR,
              MESSAGES_DIR, LOGS_DIR, UPLOADS_DIR):
        os.makedirs(d, exist_ok=True)
    _migrate_messages()
    os.makedirs(conv_dir(DEFAULT_CONV), exist_ok=True)
    load_convs()          # 保证至少存在一个会话


def _migrate_messages():
    """旧版消息放在 messages/<频道>.jsonl，现在改成 messages/<会话>/<频道>.jsonl。

    这个函数是幂等的：只有发现旧文件时才搬一次。
    """
    legacy = [os.path.join(MESSAGES_DIR, f"{ch}.jsonl") for ch in channels()]
    if not any(os.path.exists(p) for p in legacy):
        return
    dest = conv_dir(DEFAULT_CONV)
    os.makedirs(dest, exist_ok=True)
    for ch in channels():
        src = os.path.join(MESSAGES_DIR, f"{ch}.jsonl")
        if not os.path.exists(src):
            continue
        try:
            with open(src, "r", encoding="utf-8", errors="replace") as f:
                content = f.read()
            with open(os.path.join(dest, f"{ch}.jsonl"), "a", encoding="utf-8") as f:
                f.write(content)
            os.remove(src)
        except OSError:
            pass


# ---------------------------------------------------------------- 会话

def load_agents():
    """参与者注册表。内建参与者（Codex / WorkBuddy）永远存在。"""
    data = None
    if os.path.exists(AGENTS_FILE):
        try:
            data = read_json(AGENTS_FILE)
        except Exception:
            data = None
    if not isinstance(data, dict) or not isinstance(data.get("agents"), list):
        data = {"agents": []}
    data["agents"] = [a for a in data["agents"] if isinstance(a, dict) and a.get("id")]
    have = {a["id"] for a in data["agents"]}
    added = False
    for b in BUILTIN_AGENTS:
        if b["id"] not in have:
            data["agents"].append(dict(b))
            added = True
    # 内建排前面
    order = {a["id"]: i for i, a in enumerate(BUILTIN_AGENTS)}
    data["agents"].sort(key=lambda a: (order.get(a["id"], 99), a.get("created_at", "")))
    if added or not os.path.exists(AGENTS_FILE):
        try:
            save_agents(data)
        except OSError:
            pass
    return data


def save_agents(data):
    write_json(AGENTS_FILE, data)


def agent_ids():
    return [a["id"] for a in load_agents()["agents"]]


def agent_name(aid):
    for a in load_agents()["agents"]:
        if a["id"] == aid:
            return a.get("name") or aid
    return aid


def have_agent(aid):
    return any(a["id"] == aid for a in load_agents()["agents"])


def add_agent(aid, name="", kind="mcp", desc="", cmd="", model="", effort="", timeout=0):
    aid = (aid or "").strip()
    if not aid:
        die("缺少参与者标识（id）")
    if not all(c.isalnum() or c in "-_" for c in aid):
        die("标识只能用字母、数字、- 和 _")
    if have_agent(aid):
        die(f"参与者 {aid} 已存在")
    if kind not in AGENT_KINDS:
        die(f"类型必须是 {' / '.join(AGENT_KINDS)}")
    data = load_agents()
    data["agents"].append({
        "id": aid,
        "name": (name or "").strip() or aid,
        "kind": kind,
        "desc": (desc or "").strip(),
        "cmd": (cmd or "").strip(),
        "model": (model or "").strip(),
        "effort": (effort or "").strip(),
        "timeout": int(timeout or 0),
        "created_at": now_iso(),
    })
    save_agents(data)
    os.makedirs(conv_dir(DEFAULT_CONV), exist_ok=True)
    return aid


def remove_agent(aid):
    data = load_agents()
    target = next((a for a in data["agents"] if a["id"] == aid), None)
    if target is None:
        die(f"找不到参与者 {aid}")
    if target.get("builtin"):
        die(f"{aid} 是内建参与者，不能删除")
    data["agents"] = [a for a in data["agents"] if a["id"] != aid]
    save_agents(data)


def channels():
    """频道表：每个参与者一个频道。键是参与者标识，值是显示名。"""
    return {a["id"]: "你 ↔ " + (a.get("name") or a["id"])
            for a in load_agents()["agents"]}


def load_convs():
    data = None
    if os.path.exists(CONV_FILE):
        try:
            data = read_json(CONV_FILE)
        except Exception:
            data = None
    if not isinstance(data, dict) or not isinstance(data.get("conversations"), list):
        data = {"conversations": []}
    if not data["conversations"]:
        data["conversations"].append({
            "id": DEFAULT_CONV, "title": "默认对话",
            "created_at": now_iso(), "updated_at": now_iso(),
        })
        try:
            write_json(CONV_FILE, data)
        except OSError:
            pass
    return data


def save_convs(data):
    write_json(CONV_FILE, data)


def conv_dir(cid):
    return os.path.join(MESSAGES_DIR, cid or DEFAULT_CONV)


def new_conv(title=""):
    data = load_convs()
    cid = short_id()
    data["conversations"].append({
        "id": cid,
        "title": (title or "").strip() or ("新对话 " + now_iso()[5:16].replace("T", " ")),
        "created_at": now_iso(),
        "updated_at": now_iso(),
    })
    save_convs(data)
    os.makedirs(conv_dir(cid), exist_ok=True)
    return cid


def touch_conv(cid, title=None):
    try:
        data = load_convs()
        for c in data["conversations"]:
            if c.get("id") == cid:
                c["updated_at"] = now_iso()
                if title:
                    c["title"] = title
        save_convs(data)
    except OSError:
        pass


def clear_conv(cid, also_tasks=False):
    """清空一个会话：聊天记录一定清；--tasks 时连它的任务一起删。"""
    d = conv_dir(cid)
    if os.path.isdir(d):
        for fn in os.listdir(d):
            if fn.endswith(".jsonl"):
                try:
                    os.remove(os.path.join(d, fn))
                except OSError:
                    pass
    killed = 0
    if also_tasks:
        for t in list_tasks():
            if (t.get("conv") or DEFAULT_CONV) == cid:
                try:
                    os.remove(task_path(t["id"]))
                    killed += 1
                except OSError:
                    pass
    return killed


def delete_conv(cid):
    if cid == DEFAULT_CONV:
        die("默认对话不能删除，只能清空")
    clear_conv(cid, also_tasks=True)
    data = load_convs()
    data["conversations"] = [c for c in data["conversations"] if c.get("id") != cid]
    save_convs(data)
    shutil.rmtree(conv_dir(cid), ignore_errors=True)
    shutil.rmtree(os.path.join(UPLOADS_DIR, cid), ignore_errors=True)


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


def task_path(task_id):
    return os.path.join(TASKS_DIR, f"{task_id}.json")


def read_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def write_json(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def die(msg, code=1):
    print(f"[错误] {msg}", file=sys.stderr)
    sys.exit(code)


def ok(msg):
    print(f"[OK] {msg}")


def load_task(task_id):
    if not task_id:
        die("缺少任务 ID")
    tid = task_id.strip()
    p = task_path(tid)
    if not os.path.exists(p):
        # 支持短 ID 前缀匹配
        matches = [f[:-5] for f in os.listdir(TASKS_DIR)
                   if f.endswith(".json") and f[:-5].startswith(tid)]
        if len(matches) == 1:
            tid = matches[0]
            p = task_path(tid)
        elif len(matches) > 1:
            die(f"任务 ID 前缀 '{tid}' 匹配到多个任务: {', '.join(matches)}")
        else:
            die(f"找不到任务: {tid}")
    return tid, read_json(p)


def add_event(task, actor, action, note=""):
    task.setdefault("history", []).append({
        "at": now_iso(),
        "actor": actor,
        "action": action,
        "note": note,
    })


def short_id():
    return uuid.uuid4().hex[:8]


# ---------------------------------------------------------------- 消息层

def channel_path(channel, conv=DEFAULT_CONV):
    """每个会话里，每个频道一个 jsonl 文件。"""
    return os.path.join(conv_dir(conv), f"{channel}.jsonl")


def post_message(channel, role, text, kind=MSG_CHAT, task_id=None,
                 conv=DEFAULT_CONV, files=None):
    """向某个会话的某个频道追加一条消息，返回消息字典。"""
    ensure_dirs()
    if channel not in channels():
        die(f"未知频道: {channel}（可选: {', '.join(channels())}）")
    conv = conv or DEFAULT_CONV
    msg = {
        "id": short_id(),
        "at": now_iso(),
        "channel": channel,
        "role": role,
        "kind": kind,
        "text": text,
        "task_id": task_id or "",
        "conv": conv,
        "files": [str(f) for f in (files or [])],
    }
    os.makedirs(conv_dir(conv), exist_ok=True)
    p = channel_path(channel, conv)
    with open(p, "a", encoding="utf-8") as f:
        f.write(json.dumps(msg, ensure_ascii=False) + "\n")
    return msg


def read_messages(channel=None, conv=DEFAULT_CONV, since=None, limit=None):
    """读取某个会话的消息。channel 为 None 时读取该会话的全部频道。"""
    ensure_dirs()
    chans = [channel] if channel else list(channels().keys())
    out = []
    for ch in chans:
        p = channel_path(ch, conv or DEFAULT_CONV)
        if not os.path.exists(p):
            continue
        with open(p, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    out.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    # 只按时间做「稳定」排序：同频道内保留文件里的追加顺序
    # （原来用 id 做次级键，而 id 是随机 hex，会把同一秒内的消息顺序打乱）
    out.sort(key=lambda m: m.get("at", ""))
    if since:
        idx = next((i for i, m in enumerate(out) if m.get("id") == since), None)
        if idx is not None:
            out = out[idx + 1:]
    if limit:
        out = out[-limit:]
    return out


def read_paths_arg(args):
    """收集附件路径。优先用 --files-file（一行一个），这样路径里带逗号/空格都没问题。"""
    out = []
    ff = getattr(args, "files_file", "") or ""
    if ff and os.path.exists(ff):
        with open(ff, "r", encoding="utf-8", errors="replace") as f:
            out += [ln.strip() for ln in f if ln.strip()]
    out += [f.strip() for f in (getattr(args, "files", "") or "").split(",") if f.strip()]
    # 去重保序
    seen, res = set(), []
    for p in out:
        if p not in seen:
            seen.add(p)
            res.append(p)
    return res


def cmd_post(args):
    kind = getattr(args, "kind", MSG_CHAT) or MSG_CHAT
    role = args.role
    files = read_paths_arg(args)
    msg = post_message(args.channel, role, args.text, kind=kind,
                       task_id=args.task_id, conv=args.conv, files=files)
    ok(f"已发送消息 {msg['id']} → 会话 [{args.conv}] 频道 [{args.channel}]")


def cmd_messages(args):
    msgs = read_messages(channel=args.channel, conv=args.conv, limit=args.limit)
    if args.json:
        print(json.dumps(msgs, ensure_ascii=False, indent=2))
        return
    if not msgs:
        print("(暂无消息)")
        return
    for m in msgs:
        tag = f"#{m['task_id']}" if m.get("task_id") else ""
        print(f"[{m['at']}] ({m['channel']}/{m['role']}/{m['kind']}) {tag} {m['text']}")


def cmd_channels(args):
    ensure_dirs()
    print(f"{'标识':<14} {'名称':<16} {'类型':<7} {'消息':<6} 说明")
    print("-" * 92)
    for a in load_agents()["agents"]:
        n = len(read_messages(channel=a["id"], conv=getattr(args, "conv", DEFAULT_CONV)))
        print(f"{a['id']:<14} {a.get('name',''):<16} {a.get('kind',''):<7} {n:<6} {a.get('desc','')}")


# ---------------------------------------------------------------- 参与者命令

def mcp_snippet(aid):
    return {
        "codex-bridge-" + aid: {
            "command": "<bridge目录>/CodexBridge.exe",
            "args": ["--mcp"],
            "env": {"BRIDGE_AGENT": aid},
        }
    }


def cmd_agent_list(args):
    ensure_dirs()
    print(f"{'标识':<14} {'名称':<16} {'类型':<7} {'来源':<6} 说明")
    print("-" * 96)
    for a in load_agents()["agents"]:
        print(f"{a['id']:<14} {a.get('name',''):<16} {a.get('kind',''):<7} "
              f"{'内建' if a.get('builtin') else '自定义':<6} {a.get('desc','')}")
    print()
    print("要接入一个新的 AI（它不需要装 Python，也不需要改任何代码）：")
    print("  1) bridge.py agent add <标识> --name \"显示名\" --kind mcp --desc \"它负责什么\"")
    print("  2) 把打印出来的 MCP 配置粘到那个 AI 的 MCP 设置里")
    print("  3) 它调用 bridge_inbox / bridge_claim / bridge_submit 就能领活交活了")


def cmd_agent_add(args):
    aid = add_agent(args.agent_id, args.name, args.kind, args.desc, args.cmd)
    print(f"AGENT_ID={aid}")
    ok(f"已添加参与者 {aid}（{args.kind}）：{args.name or aid}")
    if args.kind == "mcp":
        print()
        print("把这个粘到那个 AI 的 MCP 配置里（记得把 <bridge目录> 换成真实路径）：")
        print(json.dumps(mcp_snippet(aid), ensure_ascii=False, indent=2))


CONFIG_FILE = os.path.join(BASE_DIR, "config.json")

ROLE_KEYS = ("planner", "executor", "reviewer")
ROLE_CHANNEL_KEYS = ("planner_channel", "executor_channel")
ROLE_CN = {
    "planner": "规划（把需求拆成任务卡）",
    "executor": "执行（真正动手干活）",
    "reviewer": "审核（按验收标准判定）",
    "planner_channel": "规划/审核消息播报到",
    "executor_channel": "执行进度播报到",
}


def load_config():
    data = None
    if os.path.exists(CONFIG_FILE):
        try:
            data = read_json(CONFIG_FILE)
        except Exception:
            data = None
    return data if isinstance(data, dict) else {}


def cmd_roles_list(args):
    cfg = load_config()
    roles = cfg.get("roles") or {}
    print("当前分工（换人就是换模型，用来控制 token 花在哪）：")
    for k in ROLE_KEYS:
        aid = roles.get(k) or "codex"
        runnable = "  ← 能自动调用" if _agent_runnable(aid) else "  ← 不能自动调用（缺命令行）"
        print("  %-10s %-26s -> %-12s%s" % (k, ROLE_CN[k], aid, runnable))
    for k in ROLE_CHANNEL_KEYS:
        print("  %-10s %-26s -> %s" % (k, ROLE_CN[k], roles.get(k) or "-"))
    print()
    print("可用参与者：")
    for a in load_agents()["agents"]:
        has = bool((a.get("cmd") or "").strip()) or a["id"] == "codex"
        print("  %-12s %-16s %-6s %-22s %s"
              % (a["id"], a.get("name", ""), a.get("kind", ""),
                 (a.get("desc") or "")[:22], "有命令行" if has else "无命令行"))
    print()
    print("改分工：  bridge.py roles set <planner|executor|reviewer> <参与者标识>")


def _agent_runnable(aid):
    for a in load_agents()["agents"]:
        if a["id"] == aid:
            return bool((a.get("cmd") or "").strip()) or aid == "codex"
    return False


def cmd_roles_set(args):
    role = args.role
    aid = args.agent_id
    if role not in ROLE_KEYS + ROLE_CHANNEL_KEYS:
        die("角色必须是：%s" % " / ".join(ROLE_KEYS + ROLE_CHANNEL_KEYS))
    if role in ROLE_KEYS:
        if not have_agent(aid):
            die("没有这个参与者：%s（先用 bridge.py agent add 加进来）" % aid)
        if not _agent_runnable(aid):
            die("参与者 %s 没有配置命令行，协作台没法自动调用它。"
                "请先 bridge.py agent add %s ... --cmd \"...\"（或换个有命令行的）" % (aid, aid))
    cfg = load_config()
    cfg.setdefault("roles", {})[role] = aid
    write_json(CONFIG_FILE, cfg)
    ok("已把「%s」交给 %s" % (ROLE_CN.get(role, role), agent_name(aid)))


def cmd_agent_remove(args):
    remove_agent(args.agent_id)
    ok(f"已移除参与者 {args.agent_id}")


# ---------------------------------------------------------------- 会话命令

def cmd_conv_list(args):
    ensure_dirs()
    tasks = list_tasks()
    print(f"{'会话ID':<10} {'标题':<22} {'消息':<6} {'任务':<6} 最近活动")
    print("-" * 78)
    for c in load_convs()["conversations"]:
        cid = c["id"]
        n = len(read_messages(conv=cid))
        nt = len([t for t in tasks if (t.get("conv") or DEFAULT_CONV) == cid])
        mark = "  ← 当前" if cid == getattr(args, "conv", DEFAULT_CONV) else ""
        print(f"{cid:<10} {c.get('title',''):<22} {n:<6} {nt:<6} "
              f"{c.get('updated_at','')}{mark}")


def cmd_conv_new(args):
    cid = new_conv(args.title)
    print(f"CONV_ID={cid}")
    ok(f"已新建会话 {cid}：{args.title or '(自动命名)'}")


def cmd_conv_rename(args):
    data = load_convs()
    if not any(c.get("id") == args.conv_id for c in data["conversations"]):
        die(f"找不到会话 {args.conv_id}")
    touch_conv(args.conv_id, title=args.title)
    ok(f"会话 {args.conv_id} 已重命名为：{args.title}")


def cmd_conv_clear(args):
    if not any(c.get("id") == args.conv_id for c in load_convs()["conversations"]):
        die(f"找不到会话 {args.conv_id}")
    killed = clear_conv(args.conv_id, also_tasks=bool(args.tasks))
    ok(f"已清空会话 {args.conv_id} 的聊天记录"
       + (f"，并删除 {killed} 个任务" if args.tasks else "（任务保留）"))


def cmd_conv_delete(args):
    delete_conv(args.conv_id)
    ok(f"已删除会话 {args.conv_id}（连同它的聊天记录和任务）")


# ---------------------------------------------------------------- 命令实现

def cmd_init(args):
    ensure_dirs()
    ok("桥接环境已就绪")
    print(f"任务目录: {TASKS_DIR}")
    print(f"结果目录: {RESULTS_DIR}")
    print(f"审核目录: {REVIEWS_DIR}")
    print(f"归档目录: {ARCHIVE_DIR}")


def cmd_new(args):
    ensure_dirs()
    tid = short_id()
    # 支持从文件读 spec / acceptance，避免 Windows 命令行长度与引号地狱
    if getattr(args, "spec_file", ""):
        with open(args.spec_file, "r", encoding="utf-8", errors="replace") as f:
            args.spec = f.read().strip()
    if getattr(args, "acceptance_file", ""):
        with open(args.acceptance_file, "r", encoding="utf-8", errors="replace") as f:
            args.acceptance = f.read().strip()
    if not args.spec:
        die("缺少 --spec 或 --spec-file")
    task = {
        "id": tid,
        "title": args.title,
        "spec": args.spec,
        "status": STATUS_PENDING,
        "owner": OWNER_BY_STATUS[STATUS_PENDING],
        "assignee": args.assignee,
        "created_by": args.sender,
        "created_at": now_iso(),
        "updated_at": now_iso(),
        "priority": args.priority,
        "attempt": 0,
        "tags": [t.strip() for t in (args.tags or "").split(",") if t.strip()],
        "constraints": args.constraints or "",
        "acceptance": args.acceptance or "",
        "workdir": (getattr(args, "workdir", "") or "").strip(),
        # 谁负责执行：engine = 协作台引擎自动跑；workbuddy = 留给 WorkBuddy/人工领。
        # 引擎只碰 handler=engine 的任务，所以两边不会抢同一个。
        "handler": (getattr(args, "handler", "") or "engine").strip(),
        "conv": (getattr(args, "conv", "") or DEFAULT_CONV),
        "files": read_paths_arg(args),
        "artifacts": [],
        "summary": "",
        "history": [],
    }
    add_event(task, args.sender, "created", f"新建任务: {args.title}")
    write_json(task_path(tid), task)
    # 自动在频道里播报一条任务卡片
    brief = args.spec if len(args.spec) <= 300 else args.spec[:300].rstrip() + " …"
    post_message("codex", ROLE_CODEX,
                 f"【新任务】{args.title}\n{brief}"
                 + (f"\n验收标准：{args.acceptance[:200]}" if args.acceptance else "")
                 + (("\n附件：" + "、".join(task["files"])) if task["files"] else ""),
                 kind=MSG_TASK, task_id=tid, conv=task["conv"])
    print(f"TASK_ID={tid}")          # 机器可读，供 orchestrator 解析
    ok(f"已创建任务 {tid}")
    print(f"标题: {args.title}")
    print(f"状态: {task['status']}  →  下一步由 {task['owner']} 处理")


def cmd_list(args):
    ensure_dirs()
    rows = []
    for fn in sorted(os.listdir(TASKS_DIR)):
        if not fn.endswith(".json"):
            continue
        t = read_json(os.path.join(TASKS_DIR, fn))
        if args.status and t["status"] != args.status:
            continue
        if args.assignee and t.get("assignee") != args.assignee:
            continue
        rows.append(t)
    if not rows:
        print("(没有匹配的任务)")
        return
    rows.sort(key=lambda x: x["created_at"])
    print(f"{'ID':<10} {'状态':<14} {'待办方':<11} {'执行方':<10} {'P':<4} {'尝试':<4} 标题")
    print("-" * 92)
    for t in rows:
        print(f"{t['id']:<10} {t['status']:<14} {t.get('owner','-'):<11} "
              f"{t.get('handler','engine'):<10} {t.get('priority','normal'):<4} "
              f"{t.get('attempt',0):<4} {t['title']}")


def cmd_show(args):
    tid, t = load_task(args.task_id)
    print(json.dumps(t, ensure_ascii=False, indent=2))


def cmd_claim(args):
    tid, t = load_task(args.task_id)
    if t["status"] not in (STATUS_PENDING, STATUS_REJECTED):
        die(f"任务 {tid} 当前状态为 {t['status']}，无法领取（仅 pending / rejected 可领取）")
    if t.get("assignee") and t["assignee"] != args.by:
        die(f"任务 {tid} 指派给 {t['assignee']}，{args.by} 无权领取")
    t["status"] = STATUS_IN_PROGRESS
    t["owner"] = OWNER_BY_STATUS[STATUS_IN_PROGRESS]
    t["attempt"] = t.get("attempt", 0) + 1
    t["updated_at"] = now_iso()
    add_event(t, args.by, "claimed", f"第 {t['attempt']} 次执行")
    write_json(task_path(tid), t)
    post_message("workbuddy",
                 ROLE_WORKBUDDY if args.by == "workbuddy" else ROLE_CODEX,
                 f"已领取任务，开始执行（第 {t['attempt']} 次尝试）",
                 kind=MSG_PROGRESS, task_id=tid, conv=t.get("conv") or DEFAULT_CONV)
    ok(f"已领取任务 {tid}（第 {t['attempt']} 次尝试），开始执行")


def cmd_submit(args):
    tid, t = load_task(args.task_id)
    if t["status"] not in (STATUS_IN_PROGRESS, STATUS_REJECTED, STATUS_PENDING):
        die(f"任务 {tid} 当前状态为 {t['status']}，无法提交结果")
    t["status"] = STATUS_NEEDS_REVIEW
    t["owner"] = OWNER_BY_STATUS[STATUS_NEEDS_REVIEW]
    t["summary"] = args.summary or ""
    if args.artifacts:
        t["artifacts"] = [a.strip() for a in args.artifacts.split(",") if a.strip()]
    t["updated_at"] = now_iso()

    # 结果详情写入 results/<id>.md
    body = args.body or ""
    if args.file:
        fp = args.file
        if not os.path.isabs(fp):
            fp = os.path.join(os.getcwd(), fp)
        if os.path.exists(fp):
            with open(fp, "r", encoding="utf-8", errors="replace") as f:
                body = (body + "\n\n" + f.read()).strip()
        else:
            print(f"[警告] 结果文件不存在，已忽略: {fp}", file=sys.stderr)

    rpath = os.path.join(RESULTS_DIR, f"{tid}.md")
    with open(rpath, "w", encoding="utf-8") as f:
        f.write(f"# 执行结果 — {t['title']}\n\n")
        f.write(f"- 任务 ID: `{tid}`\n")
        f.write(f"- 第 {t.get('attempt',1)} 次尝试\n")
        f.write(f"- 提交人: {args.by}\n")
        f.write(f"- 提交时间: {now_iso()}\n\n")
        f.write("## 摘要\n\n" + (args.summary or "(无)") + "\n\n")
        if t["artifacts"]:
            f.write("## 产物\n\n")
            for a in t["artifacts"]:
                f.write(f"- {a}\n")
            f.write("\n")
        f.write("## 详情\n\n" + (body or "(无)") + "\n")

    add_event(t, args.by, "submitted", args.summary or "")
    write_json(task_path(tid), t)
    post_message("workbuddy", ROLE_WORKBUDDY,
                 f"【提交结果】{args.summary or '(无摘要)'}"
                 + (f"\n产物：{', '.join(t['artifacts'])}" if t["artifacts"] else ""),
                 kind=MSG_RESULT, task_id=tid, conv=t.get("conv") or DEFAULT_CONV)
    ok(f"已提交任务 {tid} 的结果 → 等待 Codex 审核")
    print(f"结果文件: {rpath}")


def cmd_review(args):
    tid, t = load_task(args.task_id)
    if t["status"] not in (STATUS_NEEDS_REVIEW,):
        die(f"任务 {tid} 当前状态为 {t['status']}，无需审核（仅 needs_review 可审核）")
    if getattr(args, "comment_file", ""):
        with open(args.comment_file, "r", encoding="utf-8", errors="replace") as f:
            args.comment = f.read().strip()
    if not args.comment and getattr(args, "comment", ""):
        args.comment = args.comment
    verdict = (args.verdict or "").lower()
    if verdict in ("approve", "pass", "ok", "通过", "approved"):
        t["status"] = STATUS_APPROVED
    elif verdict in ("reject", "fail", "打回", "不通过", "rejected"):
        t["status"] = STATUS_REJECTED
    else:
        die("verdict 必须是 approve 或 reject")

    t["owner"] = OWNER_BY_STATUS[t["status"]]
    t["updated_at"] = now_iso()
    add_event(t, args.by, f"review:{verdict}", args.comment or "")

    # 审核意见写入 reviews/<id>.md（追加，保留每一轮）
    rpath = os.path.join(REVIEWS_DIR, f"{tid}.md")
    with open(rpath, "a", encoding="utf-8") as f:
        f.write(f"## 第 {t.get('attempt',1)} 次尝试 — "
                f"{'✅ 通过' if t['status']==STATUS_APPROVED else '❌ 打回'}\n\n")
        f.write(f"- 审核人: {args.by}\n- 时间: {now_iso()}\n\n")
        f.write((args.comment or "(无意见)") + "\n\n")

    if t["status"] == STATUS_APPROVED and args.artifacts:
        for a in args.artifacts.split(","):
            a = a.strip()
            if a and a not in t["artifacts"]:
                t["artifacts"].append(a)

    write_json(task_path(tid), t)
    # 频道里的气泡只放摘要，完整报告在 reviews/<id>.md 里
    brief = (args.comment or "").strip()
    if len(brief) > 400:
        brief = brief[:400].rstrip() + " …（完整意见见 reviews/" + tid + ".md）"
    if t["status"] == STATUS_APPROVED:
        post_message("codex", ROLE_CODEX,
                     f"【审核通过 ✅】\n{brief or '通过'}",
                     kind=MSG_REVIEW, task_id=tid, conv=t.get("conv") or DEFAULT_CONV)
        ok(f"任务 {tid} 审核通过 ✅ 已关闭")
    else:
        post_message("codex", ROLE_CODEX,
                     f"【打回 ❌】\n{brief or '(未说明原因)'}",
                     kind=MSG_REVIEW, task_id=tid, conv=t.get("conv") or DEFAULT_CONV)
        ok(f"任务 {tid} 已打回 ❌ → 退回给执行方修改")
    print(f"审核记录: {rpath}")


def cmd_block(args):
    tid, t = load_task(args.task_id)
    t["status"] = STATUS_BLOCKED
    t["owner"] = OWNER_BY_STATUS[STATUS_BLOCKED]
    t["updated_at"] = now_iso()
    add_event(t, args.by, "blocked", args.reason or "")
    write_json(task_path(tid), t)
    ok(f"任务 {tid} 已标记为阻塞 → 需要 Codex/用户介入")
    if args.reason:
        print(f"原因: {args.reason}")


def cmd_cancel(args):
    tid, t = load_task(args.task_id)
    t["status"] = STATUS_CANCELLED
    t["owner"] = "-"
    t["updated_at"] = now_iso()
    add_event(t, args.by, "cancelled", args.reason or "")
    write_json(task_path(tid), t)
    ok(f"任务 {tid} 已取消")


def cmd_set(args):
    """安全地改任务的几个字段（工作目录 / 执行方 / 验收标准 / 优先级）。

    直接用文本编辑器改 tasks/<id>.json 容易把状态弄坏，所以留一个正规入口。
    """
    tid, t = load_task(args.task_id)
    changed = []
    if args.workdir is not None:
        t["workdir"] = (args.workdir or "").strip()
        changed.append("workdir=" + (t["workdir"] or "(回到默认)"))
    if args.handler:
        t["handler"] = args.handler
        changed.append("handler=" + args.handler)
    if args.acceptance is not None:
        t["acceptance"] = args.acceptance
        changed.append("acceptance 已更新")
    if args.priority:
        t["priority"] = args.priority
        changed.append("priority=" + args.priority)
    if not changed:
        die("什么都没改（可用 --workdir / --handler / --acceptance / --priority）")
    t["updated_at"] = now_iso()
    add_event(t, args.by, "updated", "; ".join(changed))
    write_json(task_path(tid), t)
    ok("任务 %s 已更新: %s" % (tid, "; ".join(changed)))


def cmd_retry(args):
    """把 blocked / cancelled 的任务重新放回队列，供人工介入后重试。"""
    tid, t = load_task(args.task_id)
    if t["status"] not in (STATUS_BLOCKED, STATUS_CANCELLED, STATUS_IN_PROGRESS):
        die(f"任务 {tid} 当前状态为 {t['status']}，只有 blocked / cancelled / in_progress 需要 retry")
    t["status"] = STATUS_PENDING
    t["owner"] = OWNER_BY_STATUS[STATUS_PENDING]
    t["updated_at"] = now_iso()
    add_event(t, args.by, "retried", args.reason or "人工介入后重新入队")
    write_json(task_path(tid), t)
    post_message("workbuddy",
                 ROLE_CODEX if args.by == "codex" else ROLE_WORKBUDDY,
                 f"任务已重新入队，等待执行（此前已尝试 {t.get('attempt', 0)} 次）",
                 kind=MSG_SYSTEM, task_id=tid, conv=t.get("conv") or DEFAULT_CONV)
    ok(f"任务 {tid} 已重新入队（status=pending）")


def cmd_inbox(args):
    ensure_dirs()
    target = args.by
    rows = []
    for fn in sorted(os.listdir(TASKS_DIR)):
        if not fn.endswith(".json"):
            continue
        t = read_json(os.path.join(TASKS_DIR, fn))
        if t.get("owner") == target:
            rows.append(t)
    if not rows:
        print(f"(没有等待 {target} 处理的任务)")
        return
    rows.sort(key=lambda x: {"high": 0, "normal": 1, "low": 2}.get(x.get("priority"), 1))
    print(f"===== 等待 {target} 处理的任务（{len(rows)} 个） =====")
    for t in rows:
        flag = "★" if t.get("priority") == "high" else " "
        print(f"{flag} [{t['id']}] {t['title']}  "
              f"(状态:{t['status']}, 第{t.get('attempt',0)}次, 执行方:{t.get('handler','engine')})")
        if t["status"] == STATUS_NEEDS_REVIEW:
            print(f"    结果文件: results/{t['id']}.md")
        if t["status"] == STATUS_REJECTED:
            print(f"    上一轮审核意见见 reviews/{t['id']}.md")


def cmd_status(args):
    ensure_dirs()
    counts = {s: 0 for s in ALL_STATUS}
    for fn in os.listdir(TASKS_DIR):
        if not fn.endswith(".json"):
            continue
        t = read_json(os.path.join(TASKS_DIR, fn))
        counts[t["status"]] = counts.get(t["status"], 0) + 1
    total = sum(counts.values())
    print(f"===== 任务总览（共 {total} 个） =====")
    labels = {
        STATUS_PENDING: "待执行  (WorkBuddy)",
        STATUS_IN_PROGRESS: "执行中  (WorkBuddy)",
        STATUS_NEEDS_REVIEW: "待审核  (Codex)",
        STATUS_REJECTED: "已打回  (WorkBuddy)",
        STATUS_APPROVED: "已通过  (关闭)",
        STATUS_BLOCKED: "已阻塞  (Codex)",
        STATUS_CANCELLED: "已取消  (关闭)",
    }
    for s in ALL_STATUS:
        print(f"  {labels[s]:<24} {counts[s]}")
    wb = counts[STATUS_PENDING] + counts[STATUS_REJECTED] + counts[STATUS_IN_PROGRESS]
    cd = counts[STATUS_NEEDS_REVIEW] + counts[STATUS_BLOCKED]
    print("-" * 40)
    print(f"  WorkBuddy 待办: {wb}    Codex 待办: {cd}")


def cmd_history(args):
    tid, t = load_task(args.task_id)
    print(f"===== 任务 {tid} 历史: {t['title']} =====")
    for e in t.get("history", []):
        note = f"  — {e['note']}" if e.get("note") else ""
        print(f"{e['at']}  [{e['actor']:<10}] {e['action']}{note}")


def cmd_archive(args):
    ensure_dirs()
    moved = 0
    for fn in list(os.listdir(TASKS_DIR)):
        if not fn.endswith(".json"):
            continue
        src = os.path.join(TASKS_DIR, fn)
        t = read_json(src)
        if t["status"] in (STATUS_APPROVED, STATUS_CANCELLED):
            shutil.move(src, os.path.join(ARCHIVE_DIR, fn))
            for d in (RESULTS_DIR, REVIEWS_DIR):
                for ext in (".md",):
                    fp = os.path.join(d, f"{t['id']}{ext}")
                    if os.path.exists(fp):
                        shutil.move(fp, os.path.join(ARCHIVE_DIR, os.path.basename(fp)))
            moved += 1
    ok(f"已归档 {moved} 个已关闭任务")


# ---------------------------------------------------------------- 入口

def build_parser():
    p = argparse.ArgumentParser(
        prog="bridge.py",
        description="Codex <-> WorkBuddy 文件信箱桥接工具",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="任务生命周期: pending → in_progress → needs_review → approved / rejected(循环)",
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("init", help="初始化目录")
    sp.set_defaults(func=cmd_init)

    sp = sub.add_parser("new", help="新建任务（Codex 下发）")
    sp.add_argument("--title", required=True, help="任务标题")
    sp.add_argument("--spec", default="", help="任务详细说明/需求（超长内容请用 --spec-file）")
    sp.add_argument("--sender", "--from", default="codex", dest="sender", help="下发方，默认 codex")
    sp.add_argument("--assignee", default="workbuddy", help="执行方，默认 workbuddy")
    sp.add_argument("--priority", default="normal", choices=["high", "normal", "low"])
    sp.add_argument("--tags", default="", help="逗号分隔标签")
    sp.add_argument("--constraints", default="", help="约束条件")
    sp.add_argument("--acceptance", default="", help="验收标准（Codex 审核依据）")
    sp.add_argument("--workdir", default="", help="执行方的工作目录（绝对路径，或相对 bridge/ 的路径）")
    sp.add_argument("--handler", default="engine", choices=["engine"] + agent_ids(),
                    help="engine=协作台引擎自动执行（默认）；也可以写某个参与者的标识，交给它领取")
    sp.add_argument("--conv", default=DEFAULT_CONV, help="属于哪个会话（默认 main）")
    sp.add_argument("--files", default="", help="附件路径，逗号分隔（执行时会复制进任务工作目录）")
    sp.add_argument("--files-file", default="", help="从文件读附件路径（一行一个，避免逗号/空格问题）")
    sp.add_argument("--spec-file", default="", help="从文件读 --spec（避免超长命令行）")
    sp.add_argument("--acceptance-file", default="", help="从文件读 --acceptance")
    sp.set_defaults(func=cmd_new)

    sp = sub.add_parser("list", help="列出任务")
    sp.add_argument("--status", choices=ALL_STATUS)
    sp.add_argument("--assignee")
    sp.set_defaults(func=cmd_list)

    sp = sub.add_parser("show", help="查看任务详情(JSON)")
    sp.add_argument("task_id")
    sp.set_defaults(func=cmd_show)

    sp = sub.add_parser("claim", help="领取任务（WorkBuddy）")
    sp.add_argument("task_id")
    sp.add_argument("--by", default="workbuddy", choices=agent_ids())
    sp.set_defaults(func=cmd_claim)

    sp = sub.add_parser("submit", help="提交结果（WorkBuddy）")
    sp.add_argument("task_id")
    sp.add_argument("--by", default="workbuddy", choices=agent_ids())
    sp.add_argument("--summary", default="", help="结果摘要")
    sp.add_argument("--artifacts", default="", help="产物文件路径，逗号分隔")
    sp.add_argument("--body", default="", help="结果详情正文")
    sp.add_argument("--file", default="", help="从文件读取结果详情(如 markdown)")
    sp.set_defaults(func=cmd_submit)

    sp = sub.add_parser("review", help="审核任务（Codex）")
    sp.add_argument("task_id")
    sp.add_argument("--by", default="codex", choices=agent_ids())
    sp.add_argument("--verdict", required=True, help="approve 或 reject")
    sp.add_argument("--comment", default="", help="审核意见/打回原因（短）")
    sp.add_argument("--comment-file", default="", help="从文件读审核意见（长文本/多行）")
    sp.add_argument("--artifacts", default="", help="通过时附加产物，逗号分隔")
    sp.set_defaults(func=cmd_review)

    sp = sub.add_parser("block", help="标记阻塞（WorkBuddy）")
    sp.add_argument("task_id")
    sp.add_argument("--by", default="workbuddy", choices=agent_ids())
    sp.add_argument("--reason", default="")
    sp.set_defaults(func=cmd_block)

    sp = sub.add_parser("cancel", help="取消任务（Codex）")
    sp.add_argument("task_id")
    sp.add_argument("--by", default="codex", choices=agent_ids())
    sp.add_argument("--reason", default="")
    sp.set_defaults(func=cmd_cancel)

    sp = sub.add_parser("set", help="修改任务的工作目录/执行方/验收标准/优先级")
    sp.add_argument("task_id")
    sp.add_argument("--workdir", default=None, help="工作目录；给空字符串表示回到默认")
    sp.add_argument("--handler", choices=["engine"] + agent_ids())
    sp.add_argument("--acceptance", default=None)
    sp.add_argument("--priority", choices=["high", "normal", "low"])
    sp.add_argument("--by", default="codex", choices=agent_ids())
    sp.set_defaults(func=cmd_set)

    sp = sub.add_parser("retry", help="把 blocked/cancelled 任务重新入队")
    sp.add_argument("task_id")
    sp.add_argument("--by", default="codex", choices=agent_ids())
    sp.add_argument("--reason", default="")
    sp.set_defaults(func=cmd_retry)

    sp = sub.add_parser("inbox", help="查看某方待办")
    sp.add_argument("--by", required=True, choices=agent_ids())
    sp.set_defaults(func=cmd_inbox)

    sp = sub.add_parser("status", help="任务总览")
    sp.set_defaults(func=cmd_status)

    sp = sub.add_parser("history", help="查看任务历史")
    sp.add_argument("task_id")
    sp.set_defaults(func=cmd_history)

    sp = sub.add_parser("archive", help="归档已关闭任务")
    sp.set_defaults(func=cmd_archive)

    # ---- 消息层 ----
    sp = sub.add_parser("post", help="向频道发送一条消息")
    sp.add_argument("channel", choices=list(channels().keys()))
    sp.add_argument("--role", required=True, choices=[ROLE_USER] + agent_ids())
    sp.add_argument("--text", required=True)
    sp.add_argument("--kind", default=MSG_CHAT,
                    choices=[MSG_CHAT, MSG_TASK, MSG_PROGRESS,
                             MSG_RESULT, MSG_REVIEW, MSG_SYSTEM])
    sp.add_argument("--task-id", default=None, dest="task_id")
    sp.add_argument("--conv", default=DEFAULT_CONV, help="发到哪个会话")
    sp.add_argument("--files", default="", help="附件路径，逗号分隔")
    sp.add_argument("--files-file", default="", help="从文件读附件路径（一行一个）")
    sp.set_defaults(func=cmd_post)

    sp = sub.add_parser("messages", help="读取频道消息")
    sp.add_argument("--channel", choices=list(channels().keys()))
    sp.add_argument("--conv", default=DEFAULT_CONV, help="读哪个会话")
    sp.add_argument("--limit", type=int, default=200)
    sp.add_argument("--json", action="store_true", help="以 JSON 输出")
    sp.set_defaults(func=cmd_messages)

    sp = sub.add_parser("channels", help="列出所有参与者频道")
    sp.add_argument("--conv", default=DEFAULT_CONV, help="看哪个会话下的消息数")
    sp.set_defaults(func=cmd_channels)

    # ---- 会话管理 ----
    sp = sub.add_parser("conv", help="会话（对话）管理")
    csub = sp.add_subparsers(dest="conv_cmd", required=True)

    c = csub.add_parser("list", help="列出所有会话")
    c.add_argument("--conv", default=DEFAULT_CONV, help="标记哪个是当前会话")
    c.set_defaults(func=cmd_conv_list)

    c = csub.add_parser("new", help="新建会话")
    c.add_argument("--title", default="")
    c.set_defaults(func=cmd_conv_new)

    c = csub.add_parser("rename", help="重命名会话")
    c.add_argument("conv_id")
    c.add_argument("--title", required=True)
    c.set_defaults(func=cmd_conv_rename)

    c = csub.add_parser("clear", help="清空会话的聊天记录")
    c.add_argument("conv_id")
    c.add_argument("--tasks", action="store_true", help="连该会话的任务一起删掉")
    c.set_defaults(func=cmd_conv_clear)

    c = csub.add_parser("delete", help="删除会话（默认对话不可删）")
    c.add_argument("conv_id")
    c.set_defaults(func=cmd_conv_delete)

    # ---- 参与者（AI）管理 ----
    sp = sub.add_parser("agent", help="参与者（AI）管理：接新的 AI 进来一起干活")
    asub = sp.add_subparsers(dest="agent_cmd", required=True)

    a = asub.add_parser("list", help="列出所有参与者")
    a.set_defaults(func=cmd_agent_list)

    a = asub.add_parser("add", help="接入一个新 AI")
    a.add_argument("agent_id", help="标识，只能用字母数字-_，例如 claude")
    a.add_argument("--name", default="", help="显示名")
    a.add_argument("--kind", default="mcp", choices=list(AGENT_KINDS),
                   help="mcp=通过 MCP 领活（推荐）；cli=有命令行；human=人工")
    a.add_argument("--desc", default="", help="它负责什么")
    a.add_argument("--cmd", default="",
                   help="命令行模板。占位符 {prompt_file} {out_file} {workdir} {model} {effort}"
                        "（路径会自动加引号，不用自己写）；"
                        "例：claude -p < {prompt_file} > {out_file}")
    a.add_argument("--model", default="", help="这个参与者默认用哪个模型")
    a.add_argument("--effort", default="", help="这个参与者默认的推理强度")
    a.add_argument("--timeout", type=int, default=0, help="单次调用超时秒数")
    a.set_defaults(func=cmd_agent_add)

    a = asub.add_parser("remove", help="移除参与者（内建的不可删）")
    a.add_argument("agent_id")
    a.set_defaults(func=cmd_agent_remove)

    # ---- 分工 ----
    sp = sub.add_parser("roles", help="查看 / 设置分工：谁规划、谁执行、谁审核")
    rsub = sp.add_subparsers(dest="roles_cmd", required=True)
    r = rsub.add_parser("list", help="看当前分工")
    r.set_defaults(func=cmd_roles_list)
    r = rsub.add_parser("set", help="改分工")
    r.add_argument("role", help="planner / executor / reviewer（或 planner_channel / executor_channel）")
    r.add_argument("agent_id", help="参与者标识")
    r.set_defaults(func=cmd_roles_set)

    return p


def main():
    parser = build_parser()
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
