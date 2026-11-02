#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ui.py — Codex 协作台（零依赖浏览器界面）

为什么不用 pywebview / CodexBridge.exe：
    本机 bundled Python 里既没有 webview 也没有 PyInstaller，
    源码模式启动不了、exe 也重打包不了。所以界面改成「本地 HTTP 服务 +
    浏览器」——只用标准库，任何 Python 都能跑，不存在打不开的问题。

跑起来：
    python ui.py                 # 起服务并自动打开浏览器
    python ui.py --port 8899     # 指定端口
    python ui.py --no-browser    # 只起服务，不自动开浏览器
"""

import json
import os
import socket
import subprocess
import sys
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

# 路径与「再启动自己」交给 _rt：打包成 exe 后 __file__ 与 sys.executable 都不能直接用
from _rt import BASE_DIR, child_env, cli_cmd, engine_cmd, no_window

ORCH_PY = os.path.join(BASE_DIR, "orchestrator.py")
BRIDGE_PY = os.path.join(BASE_DIR, "bridge.py")
STATE_PATH = os.path.join(BASE_DIR, ".orchestrator_state.json")
LOCK_PATH = os.path.join(BASE_DIR, ".orchestrator.lock")
MODE_PATH = os.path.join(BASE_DIR, ".engine_mode")

TASKS_DIR = os.path.join(BASE_DIR, "tasks")
RESULTS_DIR = os.path.join(BASE_DIR, "results")
REVIEWS_DIR = os.path.join(BASE_DIR, "reviews")
MESSAGES_DIR = os.path.join(BASE_DIR, "messages")
LOG_DIR = os.path.join(BASE_DIR, "logs")

_proc = None
_proc_lock = threading.Lock()

STATUS_CN = {
    "pending": "待执行", "in_progress": "执行中", "needs_review": "待审核",
    "rejected": "已打回", "approved": "已通过", "blocked": "已阻塞",
    "cancelled": "已取消",
}


# ------------------------------------------------------------------ 小工具

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


def write_text(path, text):
    try:
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
    except Exception:
        pass


def read_jsonl(path):
    out = []
    if not os.path.exists(path):
        return out
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    out.sort(key=lambda m: m.get("at", ""))
    return out


def process_alive(pid):
    try:
        p = subprocess.run(["tasklist", "/FI", "PID eq %d" % int(pid), "/NH"],
                           capture_output=True, text=True, timeout=15)
        return str(pid) in (p.stdout or "")
    except Exception:
        return False


def engine_status():
    """返回 (是否在跑, pid, 状态字典)"""
    global _proc
    pid = None
    with _proc_lock:
        if _proc is not None and _proc.poll() is None:
            pid = _proc.pid
    if pid is None:
        lock = read_json(LOCK_PATH, {}) or {}
        cand = lock.get("pid")
        if cand and process_alive(cand):
            pid = int(cand)
    st = read_json(STATE_PATH, {}) or {}
    return (pid is not None), pid, st


def run_bridge(args, timeout=90):
    try:
        p = subprocess.run(cli_cmd(*args), capture_output=True, text=True,
                           encoding="utf-8", errors="replace",
                           cwd=BASE_DIR, timeout=timeout, env=child_env())
        return p.returncode, p.stdout or "", p.stderr or ""
    except Exception as e:
        return 1, "", "%s: %s" % (type(e).__name__, e)


# no_window() 现在来自 _rt（打包成 exe 后同样适用）


# ------------------------------------------------------------------ 引擎控制

# 运行模式 -> 传给 orchestrator 的参数
ENGINE_MODES = {
    # 全自动：Codex 负责规划 + 执行 + 审核
    "auto": [],
    # 只规划 + 审核，执行交给 WorkBuddy / 人工（任务自动标成 handler=workbuddy）
    "review": ["--only", "intake,review", "--default-handler", "workbuddy"],
}

MODE_LABEL = {"auto": "全自动（Codex 执行）", "review": "只审核（WorkBuddy 执行）"}


def engine_start(mode="auto"):
    global _proc
    mode = mode if mode in ENGINE_MODES else "auto"
    alive, pid, _ = engine_status()
    if alive:
        return {"ok": True, "note": "已在运行", "pid": pid,
                "mode": (read_text(MODE_PATH).strip() or "auto")}
    os.makedirs(LOG_DIR, exist_ok=True)
    logf = open(os.path.join(LOG_DIR, "engine.out.log"), "a", encoding="utf-8")
    logf.write(chr(10) + "===== 引擎启动 " + time.strftime("%Y-%m-%d %H:%M:%S")
               + "  模式=" + mode + " =====" + chr(10))
    logf.flush()
    try:
        with _proc_lock:
            _proc = subprocess.Popen(engine_cmd(*ENGINE_MODES[mode]),
                                     cwd=BASE_DIR, stdin=subprocess.DEVNULL,
                                     stdout=logf, stderr=subprocess.STDOUT,
                                     env=child_env(), creationflags=no_window())
            pid = _proc.pid
    except Exception as e:
        return {"ok": False, "error": "%s: %s" % (type(e).__name__, e)}
    write_text(MODE_PATH, mode)
    time.sleep(1.2)
    alive, pid2, _ = engine_status()
    if not alive:
        return {"ok": False, "error": "引擎启动后立刻退出了，请看 logs/engine.out.log"}
    return {"ok": True, "pid": pid2, "mode": mode}


def engine_stop():
    global _proc
    alive, pid, _ = engine_status()
    if not alive:
        with _proc_lock:
            _proc = None
        return {"ok": True, "note": "本来就没在跑"}
    try:
        if os.name == "nt":
            subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"],
                           capture_output=True, timeout=20)
        else:
            os.kill(int(pid), 15)
    except Exception as e:
        return {"ok": False, "error": str(e)}
    with _proc_lock:
        _proc = None
    try:
        if os.path.exists(LOCK_PATH):
            os.remove(LOCK_PATH)
    except OSError:
        pass
    return {"ok": True}


def engine_once():
    """跑一轮就退出（脱离本进程，避免阻塞 HTTP）。"""
    alive, pid, _ = engine_status()
    if alive:
        return {"ok": False, "error": "全自动引擎正在运行，它本来就在不停跑；不必手动跑一轮。"}
    os.makedirs(LOG_DIR, exist_ok=True)
    logf = open(os.path.join(LOG_DIR, "engine.out.log"), "a", encoding="utf-8")
    logf.write("\n===== 单轮 %s =====\n" % time.strftime("%Y-%m-%d %H:%M:%S"))
    logf.flush()
    try:
        subprocess.Popen(engine_cmd("--once", "--allow-multiple"),
                         cwd=BASE_DIR, stdin=subprocess.DEVNULL,
                         stdout=logf, stderr=subprocess.STDOUT,
                         env=child_env(), creationflags=no_window())
    except Exception as e:
        return {"ok": False, "error": str(e)}
    return {"ok": True}


# ------------------------------------------------------------------ API

CONV_FILE = os.path.join(BASE_DIR, "conversations.json")
AGENTS_FILE = os.path.join(BASE_DIR, "agents.json")
CONFIG_FILE = os.path.join(BASE_DIR, "config.json")
UPLOADS_DIR = os.path.join(BASE_DIR, "uploads")
DEFAULT_CONV = "main"
MAX_UPLOAD_MB = 64


def list_convs():
    data = read_json(CONV_FILE, {}) or {}
    convs = [c for c in (data.get("conversations") or [])
             if isinstance(c, dict) and c.get("id")]
    return convs or [{"id": DEFAULT_CONV, "title": "默认对话"}]


def list_agents():
    data = read_json(AGENTS_FILE, {}) or {}
    ags = [a for a in (data.get("agents") or []) if isinstance(a, dict) and a.get("id")]
    return ags or [{"id": "codex", "name": "Codex", "kind": "cli"},
                   {"id": "workbuddy", "name": "WorkBuddy", "kind": "mcp"}]


def agent_runnable(a):
    return bool((a.get("cmd") or "").strip()) or a.get("id") == "codex"


def mcp_snippet(aid):
    return {
        "mcpServers": {
            "codex-bridge-" + aid: {
                "command": os.path.join(BASE_DIR, "CodexBridge.exe").replace("\\", "/"),
                "args": ["--mcp"],
                "env": {"BRIDGE_AGENT": aid},
            }
        }
    }


def api_state(conv=None):
    convs = list_convs()
    agents = list_agents()
    ids = [c["id"] for c in convs]
    conv = conv if conv in ids else ids[0]
    msgs = {}
    for a in agents:
        msgs[a["id"]] = read_jsonl(os.path.join(MESSAGES_DIR, conv, a["id"] + ".jsonl"))
    tasks = []
    if os.path.isdir(TASKS_DIR):
        for fn in sorted(os.listdir(TASKS_DIR)):
            if fn.endswith(".json"):
                t = read_json(os.path.join(TASKS_DIR, fn))
                if isinstance(t, dict) and t.get("id"):
                    tasks.append(t)
    tasks.sort(key=lambda x: x.get("created_at", ""))
    alive, pid, st = engine_status()
    cfg = read_json(CONFIG_FILE, {}) or {}
    return {
        "conv": conv,
        "convs": convs,
        "agents": [dict(a, runnable=agent_runnable(a)) for a in agents],
        "roles": cfg.get("roles") or {},
        "default_handler": cfg.get("default_handler") or "engine",
        "messages": msgs,
        "tasks": tasks,
        "base_dir": BASE_DIR,
        "home": os.path.expanduser("~"),
        "now": time.strftime("%H:%M:%S"),
        "engine": {
            "running": alive,
            "pid": pid,
            "busy": bool(st.get("busy")),
            "phase": st.get("phase") or "",
            "current": st.get("current") or "",
            "stats": st.get("stats") or {},
            "mode": (read_text(MODE_PATH).strip() or "auto") if alive else "",
            "codex": st.get("codex") or "",
            "started_at": st.get("started_at") or "",
            "updated": st.get("updated") or "",
        },
    }


def api_detail(tid):
    t = read_json(os.path.join(TASKS_DIR, tid + ".json"), {}) or {}
    tdir = os.path.join(LOG_DIR, tid)
    execs, reviews = [], []
    if os.path.isdir(tdir):
        for fn in sorted(os.listdir(tdir)):
            if fn.endswith("-exec.md"):
                execs.append(read_text(os.path.join(tdir, fn), 9000))
            elif fn.endswith("-review.md"):
                reviews.append(read_text(os.path.join(tdir, fn), 9000))
    return {
        "task": t,
        "result": read_text(os.path.join(RESULTS_DIR, tid + ".md"), 14000),
        "reviews": read_text(os.path.join(REVIEWS_DIR, tid + ".md"), 14000),
        "exec_logs": execs,
        "review_logs": reviews,
        "engine_log": read_text(os.path.join(LOG_DIR, "orchestrator.log"), 9000),
    }


def api_send(channel, text, conv=DEFAULT_CONV, files=None):
    ids = [a["id"] for a in list_agents()]
    if channel not in ids:
        return {"ok": False, "error": "未知频道: " + str(channel)}
    text = (text or "").strip()
    files = [f for f in (files or []) if isinstance(f, str) and f.strip()]
    if not text and not files:
        return {"ok": False, "error": "空消息"}
    args = ["post", channel, "--role", "user", "--conv", conv or DEFAULT_CONV,
            "--text", text or "（见附件）"]
    if files:
        # 走文件传路径，避免路径里有逗号/空格就崩
        d = os.path.join(BASE_DIR, ".tmp")
        try:
            os.makedirs(d, exist_ok=True)
            ff = os.path.join(d, "ui-files-" + os.urandom(4).hex() + ".txt")
            with open(ff, "w", encoding="utf-8") as f:
                f.write("\n".join(files))
            args += ["--files-file", ff]
        except OSError as e:
            return {"ok": False, "error": "写附件清单失败: %r" % e}
    rc, out, err = run_bridge(args, timeout=30)
    return {"ok": rc == 0, "error": err.strip(), "out": out.strip()}


def api_action(action, payload):
    payload = payload or {}
    tid = payload.get("task_id", "")
    m = {
        "approve": ["review", tid, "--by", "codex", "--verdict", "approve",
                    "--comment", payload.get("comment") or "人工审核通过"],
        "reject": ["review", tid, "--by", "codex", "--verdict", "reject",
                   "--comment", payload.get("comment") or "(未填原因)"],
        "block": ["block", tid, "--by", "codex", "--reason", payload.get("comment") or "人工标记阻塞"],
        "retry": ["retry", tid, "--by", "codex", "--reason", payload.get("comment") or "人工重新入队"],
        "cancel": ["cancel", tid, "--by", "codex", "--reason", payload.get("comment") or "人工取消"],
    }
    if action not in m:
        return {"ok": False, "error": "未知动作: " + str(action)}
    rc, out, err = run_bridge(m[action], timeout=60)
    return {"ok": rc == 0, "out": out.strip(), "error": err.strip()}


def api_conv(action, cid="", title="", wipe_tasks=False):
    if action == "new":
        args = ["conv", "new"] + (["--title", title] if title else [])
    elif action == "rename":
        args = ["conv", "rename", cid, "--title", title]
    elif action == "clear":
        args = ["conv", "clear", cid] + (["--tasks"] if wipe_tasks else [])
    elif action == "delete":
        args = ["conv", "delete", cid]
    else:
        return {"ok": False, "error": "未知会话操作: " + str(action)}
    rc, out, err = run_bridge(args, timeout=60)
    new_id = ""
    for ln in out.splitlines():
        if ln.strip().startswith("CONV_ID="):
            new_id = ln.strip().split("=", 1)[1]
    return {"ok": rc == 0, "conv": new_id, "out": out.strip(), "error": err.strip()}


def api_agent(action, aid="", name="", kind="mcp", desc="", cmd="", model="", effort=""):
    if action == "add":
        if not (aid or "").strip():
            return {"ok": False, "error": "请填一个标识（比如 claude）"}
        args = ["agent", "add", aid.strip(), "--name", name, "--kind", kind, "--desc", desc]
        if cmd:
            args += ["--cmd", cmd]
        if model:
            args += ["--model", model]
        if effort:
            args += ["--effort", effort]
    elif action == "remove":
        args = ["agent", "remove", aid]
    else:
        return {"ok": False, "error": "未知参与者操作: " + str(action)}
    rc, out, err = run_bridge(args, timeout=60)
    res = {"ok": rc == 0, "out": out.strip(), "error": err.strip()}
    if rc == 0 and action == "add":
        res["snippet"] = json.dumps(mcp_snippet(aid.strip()), ensure_ascii=False, indent=2)
        res["agent"] = aid.strip()
    return res


def api_roles(role, aid):
    if not role or not aid:
        return {"ok": False, "error": "缺少参数"}
    rc, out, err = run_bridge(["roles", "set", role, aid], timeout=60)
    return {"ok": rc == 0, "out": out.strip(), "error": err.strip()}


def api_fs(path=""):
    path = (path or "").strip().strip('"') or os.path.expanduser("~")
    path = os.path.abspath(path)
    if not os.path.isdir(path):
        return {"ok": False, "error": "目录不存在: " + path}
    try:
        names = sorted(os.listdir(path))
    except OSError as e:
        return {"ok": False, "error": "读不了这个目录: %s" % e}
    entries = []
    for n in names[:1500]:
        if n.startswith("$"):
            continue
        fp = os.path.join(path, n)
        try:
            isdir = os.path.isdir(fp)
            size = 0 if isdir else os.path.getsize(fp)
            mt = time.strftime("%m-%d %H:%M", time.localtime(os.path.getmtime(fp)))
        except OSError:
            continue
        entries.append({"name": n, "path": fp, "dir": isdir, "size": size, "mt": mt})
    entries.sort(key=lambda e: (not e["dir"], e["name"].lower()))
    drives = []
    if os.name == "nt":
        import string
        drives = [d + ":\\" for d in string.ascii_uppercase if os.path.exists(d + ":\\")]
    parent = os.path.dirname(path.rstrip("\\/")) or path
    return {"ok": True, "path": path, "parent": parent,
            "entries": entries, "drives": drives}


def api_upload(conv, name, data_b64):
    import base64
    name = os.path.basename((name or "").strip()) or ("upload-" + str(int(time.time())))
    if len(data_b64 or "") * 3 // 4 > MAX_UPLOAD_MB * 1024 * 1024:
        return {"ok": False, "error": "文件太大（上限 %d MB）" % MAX_UPLOAD_MB}
    try:
        blob = base64.b64decode(data_b64 or "")
    except Exception as e:
        return {"ok": False, "error": "数据解码失败: %r" % e}
    d = os.path.join(UPLOADS_DIR, conv or DEFAULT_CONV)
    try:
        os.makedirs(d, exist_ok=True)
    except OSError as e:
        return {"ok": False, "error": "建目录失败: %r" % e}
    dst = os.path.join(d, name)
    i = 1
    while os.path.exists(dst):
        stem, ext = os.path.splitext(name)
        dst = os.path.join(d, "%s-%d%s" % (stem, i, ext))
        i += 1
    try:
        with open(dst, "wb") as f:
            f.write(blob)
    except OSError as e:
        return {"ok": False, "error": "写入失败: %r" % e}
    return {"ok": True, "path": dst, "name": os.path.basename(dst), "size": len(blob)}


# ------------------------------------------------------------------ HTTP

HTML = r'''<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>Codex 协作台</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  :root{--bg:#f4f5f7;--panel:#fff;--bd:#e3e6ea;--tx:#1f2328;--dim:#6b7280;
        --acc:#2f6fed;--ok:#10b981;--bad:#ef4444;--warn:#f59e0b;--cx:#7c3aed}
  html,body{height:100%}
  body{font-family:"Microsoft YaHei UI","Microsoft YaHei","PingFang SC","Segoe UI",sans-serif;
       background:var(--bg);color:var(--tx);overflow:hidden;font-size:14px}
  #app{display:flex;height:100vh}
  /* ---------- 侧栏 ---------- */
  #sidebar{width:286px;min-width:286px;background:var(--panel);border-right:1px solid var(--bd);
           display:flex;flex-direction:column}
  #brand{padding:14px 16px 10px}
  #brand h1{font-size:15px}
  #brand p{font-size:11px;color:var(--dim);margin-top:3px}
  #convbar{display:flex;gap:6px;padding:0 12px 10px}
  #conv-sel{flex:1;min-width:0;padding:7px 8px;border:1px solid var(--bd);border-radius:7px;
            font-size:12.5px;background:#fff;color:var(--tx);cursor:pointer}
  .icobtn{border:1px solid var(--bd);background:#fff;border-radius:7px;width:32px;height:33px;
          cursor:pointer;font-size:14px;color:var(--tx);line-height:1}
  .icobtn:hover{background:#eef1f5}
  .sect{padding:8px 14px 4px;font-size:10.5px;color:var(--dim);font-weight:700;letter-spacing:.5px}
  #agent-list{overflow-y:auto;flex:0 1 auto;padding:0 8px 6px}
  .ag{display:flex;align-items:center;gap:9px;padding:8px 10px;border-radius:8px;cursor:pointer;
      margin-bottom:3px}
  .ag:hover{background:#f0f2f5}
  .ag.active{background:#e8f0fe}
  .avatar{width:32px;height:32px;border-radius:8px;flex:0 0 32px;display:flex;align-items:center;
          justify-content:center;color:#fff;font-weight:700;font-size:12px}
  .ag .meta{flex:1;min-width:0}
  .ag .nm{font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .ag .sub{font-size:10.5px;color:var(--dim);white-space:nowrap;overflow:hidden;
           text-overflow:ellipsis;margin-top:1px}
  .ag .badge{background:var(--acc);color:#fff;font-size:10px;font-weight:700;border-radius:9px;
             padding:1px 6px}
  .ag .role{font-size:9.5px;color:var(--cx);font-weight:700}
  #side-foot{padding:8px 12px 10px;border-top:1px solid var(--bd);margin-top:auto}
  .card{background:#f7f9fc;border:1px solid var(--bd);border-radius:9px;padding:10px;margin-bottom:8px}
  .card .ct{font-size:12px;font-weight:700;margin-bottom:6px}
  select.wide{width:100%;padding:6px 7px;border:1px solid var(--bd);border-radius:6px;
              font-size:12.5px;background:#fff;color:var(--tx);cursor:pointer;margin-bottom:6px}
  #eng-text{font-size:11px;color:var(--dim)}
  #eng-text.on{color:#0d9488;font-weight:700}
  #eng-text.busy{color:#d97706;font-weight:700}
  #eng-phase{font-size:10.5px;color:var(--dim);margin-top:4px;line-height:1.5;word-break:break-all}
  .btnrow{display:flex;gap:6px;margin-top:7px}
  .btnrow button{flex:1;padding:6px 4px;border:1px solid var(--bd);background:#fff;border-radius:6px;
                 cursor:pointer;font-size:11.5px;color:var(--tx)}
  .btnrow button:hover{background:#eef1f5}
  #stats{font-size:10.5px;color:var(--dim);line-height:1.6;word-break:break-all}
  /* ---------- 主区 ---------- */
  #main{flex:1;display:flex;flex-direction:column;min-width:0}
  #header{height:56px;background:var(--panel);border-bottom:1px solid var(--bd);display:flex;
          align-items:center;padding:0 20px;gap:12px}
  .hname{font-weight:600;font-size:15px}
  .hsub{font-size:11.5px;color:var(--dim)}
  #status-pill{margin-left:auto;font-size:12px;padding:4px 10px;border-radius:12px;
               background:#eef2f7;color:var(--dim)}
  #messages{flex:1;overflow-y:auto;padding:18px 22px;display:flex;flex-direction:column;gap:12px}
  .row{display:flex;gap:9px;align-items:flex-start}
  .row.user{flex-direction:row-reverse}
  .bav{width:30px;height:30px;border-radius:8px;flex:0 0 30px;display:flex;align-items:center;
       justify-content:center;color:#fff;font-weight:700;font-size:12px}
  .bubble{max-width:70%;padding:9px 13px;border-radius:12px;line-height:1.55;white-space:pre-wrap;
          word-break:break-word;box-shadow:0 1px 2px rgba(0,0,0,.05)}
  .row.user .bubble{background:var(--acc);color:#fff;border-bottom-right-radius:4px}
  .row.other .bubble{background:#fff;border:1px solid var(--bd);border-bottom-left-radius:4px}
  .bubble .who{font-size:10.5px;opacity:.85;margin-bottom:4px;font-weight:700}
  .bubble .tm{font-size:10px;opacity:.55;margin-top:5px}
  .taskref{display:inline-block;font-size:10.5px;margin-top:5px;padding:1px 6px;border-radius:5px;
           background:rgba(127,127,127,.18);font-family:Consolas,monospace}
  .fchips{margin-top:6px;display:flex;flex-wrap:wrap;gap:5px}
  .fchip{font-size:10.5px;padding:2px 7px;border-radius:5px;background:rgba(127,127,127,.16);
         font-family:Consolas,monospace;word-break:break-all}
  .row.user .fchip{background:rgba(255,255,255,.22);color:#fff}
  .taskcard{border:1px solid var(--bd);border-left:4px solid var(--acc);background:#fff;
            border-radius:10px;padding:12px 15px;max-width:80%;cursor:pointer;
            box-shadow:0 1px 3px rgba(0,0,0,.06);align-self:flex-start}
  .taskcard:hover{box-shadow:0 3px 10px rgba(0,0,0,.1)}
  .tc-head{display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap}
  .tc-title{font-weight:700;font-size:14px}
  .tc-id{font-family:Consolas,monospace;font-size:11px;color:var(--dim);background:#f0f2f5;
         padding:1px 6px;border-radius:4px;margin-left:auto}
  .tc-spec{font-size:13px;color:#374151;margin:6px 0;white-space:pre-wrap}
  .tc-meta{font-size:11.5px;color:var(--dim);border-top:1px dashed var(--bd);padding-top:7px;margin-top:7px}
  .pill{font-size:11px;font-weight:700;padding:2px 9px;border-radius:10px;color:#fff}
  .pill.pending{background:var(--warn)} .pill.in_progress{background:var(--acc)}
  .pill.needs_review{background:var(--cx)} .pill.rejected{background:var(--bad)}
  .pill.approved{background:var(--ok)} .pill.blocked{background:#6b7280}
  .pill.cancelled{background:#9ca3af}
  .empty{color:var(--dim);text-align:center;margin:auto;font-size:13px;line-height:1.9}
  /* ---------- 输入 ---------- */
  #composer{background:var(--panel);border-top:1px solid var(--bd);padding:10px 20px 12px}
  #attbox{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:7px}
  .att{display:flex;align-items:center;gap:6px;background:#eef2f7;border:1px solid var(--bd);
       border-radius:7px;padding:3px 7px;font-size:11.5px;font-family:Consolas,monospace;
       max-width:340px}
  .att span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .att b{cursor:pointer;color:var(--dim);font-weight:700}
  .att b:hover{color:var(--bad)}
  .cbox{display:flex;gap:9px;align-items:flex-end}
  #input{flex:1;resize:none;border:1px solid var(--bd);border-radius:9px;padding:10px 13px;
         font-size:14px;font-family:inherit;line-height:1.5;max-height:130px;min-height:42px;
         outline:none;color:var(--tx)}
  #input:focus{border-color:var(--acc)}
  #send{padding:10px 20px;background:var(--acc);color:#fff;border:none;border-radius:9px;
        cursor:pointer;font-size:14px;font-weight:600;height:42px}
  #send:hover{background:#1f5fd8}
  #attach-btn{width:42px;height:42px;border:1px solid var(--bd);background:#fff;border-radius:9px;
              cursor:pointer;font-size:17px}
  #attach-btn:hover{background:#eef1f5}
  /* ---------- 弹层 ---------- */
  #mask{position:fixed;inset:0;background:rgba(15,20,30,.34);display:none;z-index:60}
  #mask.on{display:block}
  #modal{position:fixed;top:8vh;left:50%;transform:translateX(-50%);width:660px;max-width:94vw;
         max-height:84vh;background:#fff;border-radius:13px;box-shadow:0 16px 50px rgba(0,0,0,.26);
         display:none;flex-direction:column;z-index:61;overflow:hidden}
  #modal.on{display:flex}
  #modal-hd{padding:14px 18px;border-bottom:1px solid var(--bd);display:flex;align-items:center;
            gap:10px}
  #modal-hd h3{font-size:15px;flex:1}
  #modal-bd{padding:16px 18px;overflow-y:auto}
  #modal-ft{padding:12px 18px;border-top:1px solid var(--bd);display:flex;gap:8px;
            justify-content:flex-end}
  .btn{padding:7px 15px;border:1px solid var(--bd);background:#fff;border-radius:7px;
       cursor:pointer;font-size:13px;color:var(--tx)}
  .btn:hover{background:#eef1f5}
  .btn.pri{background:var(--acc);color:#fff;border-color:var(--acc)}
  .btn.pri:hover{background:#1f5fd8}
  .btn.bad{background:var(--bad);color:#fff;border-color:var(--bad)}
  .field{margin-bottom:11px}
  .field label{display:block;font-size:12px;color:var(--dim);margin-bottom:4px}
  .field input,.field select,.field textarea{width:100%;padding:8px 10px;border:1px solid var(--bd);
       border-radius:7px;font-size:13px;font-family:inherit;color:var(--tx);background:#fff}
  .field textarea{min-height:62px;resize:vertical;font-family:Consolas,monospace;font-size:12px}
  .tabs{display:flex;gap:6px;margin-bottom:12px}
  .tab{padding:6px 13px;border:1px solid var(--bd);border-radius:7px;cursor:pointer;font-size:12.5px;
       background:#fff}
  .tab.on{background:var(--acc);color:#fff;border-color:var(--acc)}
  .crumb{font-family:Consolas,monospace;font-size:12px;color:var(--dim);word-break:break-all;
         margin-bottom:9px;line-height:1.5}
  #fslist{border:1px solid var(--bd);border-radius:9px;max-height:44vh;overflow-y:auto}
  .fitem{display:flex;align-items:center;gap:9px;padding:7px 11px;border-bottom:1px solid #f1f3f5;
         cursor:pointer;font-size:13px}
  .fitem:last-child{border-bottom:none}
  .fitem:hover{background:#f5f7fa}
  .fitem.dir .nm{font-weight:600;color:#1f4e9c}
  .fitem .nm{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .fitem .sz{font-size:10.5px;color:var(--dim);font-family:Consolas,monospace}
  .pre{background:#f7f8fa;border:1px solid var(--bd);border-radius:8px;padding:11px 13px;
       font-size:12.5px;line-height:1.6;white-space:pre-wrap;word-break:break-word;max-height:300px;
       overflow:auto;font-family:Consolas,"Microsoft YaHei UI",monospace}
  .hintline{font-size:11.5px;color:var(--dim);line-height:1.7;margin:-4px 0 10px}
  .kvs{display:flex;align-items:center;gap:9px;margin-bottom:9px}
  .kvs label{width:104px;font-size:12.5px;flex:0 0 104px}
  .kvs select{flex:1;padding:7px 9px;border:1px solid var(--bd);border-radius:7px;font-size:12.5px;
              background:#fff}
  .kvs .tag{font-size:10.5px;color:var(--dim);width:66px;flex:0 0 66px;text-align:right}
  #toast{position:fixed;bottom:86px;left:50%;transform:translateX(-50%);background:#1f2328;
         color:#fff;padding:10px 18px;border-radius:8px;font-size:13px;opacity:0;
         transition:opacity .25s;pointer-events:none;z-index:99;max-width:70%}
  #toast.show{opacity:.95}
</style>
</head>
<body>
<div id="app">
  <div id="sidebar">
    <div id="brand"><h1>Codex 协作台</h1><p>多 AI 分工 · 规划 → 执行 → 审核 → 打回循环</p></div>
    <div id="convbar">
      <select id="conv-sel" onchange="switchConv()"></select>
      <button class="icobtn" title="新建对话" onclick="newConv()">＋</button>
      <button class="icobtn" title="会话管理" onclick="openConvMenu()">⋯</button>
    </div>
    <div class="sect">参与者</div>
    <div id="agent-list"></div>
    <div class="sect" style="padding-top:2px">
      <button class="icobtn" style="width:100%;height:28px;font-size:11.5px" onclick="openAddAgent()">＋ 添加 AI</button>
    </div>
    <div id="side-foot">
      <div class="card">
        <div class="ct">协作台引擎</div>
        <select class="wide" id="eng-mode" onchange="setEngine()">
          <option value="off">关闭 · 手动模式</option>
          <option value="auto">全自动 · 按分工自动跑</option>
          <option value="review">只审核 · 执行交给别人</option>
        </select>
        <div id="eng-text">未运行</div>
        <div id="eng-phase">引擎没开时，任务只会排队等人工处理。</div>
        <div class="btnrow">
          <button onclick="openRoles()">分工设置</button>
          <button onclick="runOnce()">跑一轮</button>
        </div>
        <div class="btnrow">
          <button onclick="openFolder()">数据目录</button>
        </div>
      </div>
      <div id="stats"></div>
    </div>
  </div>
  <div id="main">
    <div id="header">
      <div><div class="hname" id="h-name">你 ↔ Codex</div><div class="hsub" id="h-sub">下达需求 · 审核结果</div></div>
      <div id="status-pill">连接中…</div>
    </div>
    <div id="messages"></div>
    <div id="composer">
      <div id="attbox"></div>
      <div class="cbox">
        <textarea id="input" placeholder="说一句需求，回车发送。例：写一个计算器网页，支持四则运算和键盘输入"></textarea>
        <button id="attach-btn" title="加图片或文件" onclick="openFiles()">＋</button>
        <button id="send" onclick="sendMsg()">发送</button>
      </div>
    </div>
  </div>
</div>
<div id="mask" onclick="closeModal()"></div>
<div id="modal">
  <div id="modal-hd"><h3 id="modal-title"></h3></div>
  <div id="modal-bd"></div>
  <div id="modal-ft"></div>
</div>
<div id="toast"></div>
<script>
var S = {convs:[],agents:[],messages:{},tasks:[],engine:{},roles:{}};
var actConv = '', actAgent = '', attachments = [], enginePending = false, booted = false;
var seen = {}, fsPath = '', fsSel = [];
var ROLE_NAME = {user:'你'};
var ST_CN = {pending:'待执行', in_progress:'执行中', needs_review:'待审核', rejected:'已打回',
             approved:'已通过', blocked:'已阻塞', cancelled:'已取消'};
var KIND = {task:' · 任务', progress:' · 进度', result:' · 结果', review:' · 审核', system:' · 系统'};
var ROLE_CN = {planner:'规划（拆任务卡）', executor:'执行（动手干活）', reviewer:'审核（判定）',
               planner_channel:'规划/审核消息播报', executor_channel:'执行进度播报'};
var AGENT_COL = ['#7c3aed','#0d9488','#2f6fed','#d97706','#db2777','#0891b2','#65a30d','#9333ea'];

function esc(s){ return (s==null?'':String(s)).replace(/[&<>"]/g, function(c){
  return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }
function tm(iso){ var m = String(iso||'').match(/T(\d\d:\d\d:\d\d)/); return m?m[1]:(iso||''); }
function $(id){ return document.getElementById(id); }
function colorOf(aid){
  var i = (S.agents||[]).map(function(a){return a.id;}).indexOf(aid);
  return i < 0 ? '#888' : AGENT_COL[i % AGENT_COL.length];
}
function nameOf(aid){
  var a = (S.agents||[]).filter(function(x){return x.id===aid;})[0];
  return a ? (a.name||aid) : aid;
}
function baseName(p){ var s = String(p||'').replace(/[\/]+$/,''); var i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/')); return i<0?s:s.slice(i+1); }
function fmtSize(n){ n = n||0; return n<1024 ? n+' B' : (n<1048576 ? (n/1024).toFixed(1)+' KB' : (n/1048576).toFixed(1)+' MB'); }

/* ---------------- 会话 ---------------- */
function renderConvs(){
  var sel = $('conv-sel'), cur = S.conv;
  sel.innerHTML = '';
  (S.convs||[]).forEach(function(c){
    var o = document.createElement('option');
    var nt = (S.tasks||[]).filter(function(t){return (t.conv||'main')===c.id;}).length;
    o.value = c.id;
    o.textContent = (c.title||c.id) + (nt ? ('  · '+nt+' 个任务') : '');
    if(c.id === cur) o.selected = true;
    sel.appendChild(o);
  });
}
function switchConv(){
  actConv = $('conv-sel').value;
  seen = {};
  closeModal();
  refresh();
}
function newConv(){
  var t = prompt('新对话的名字（留空自动命名）：', '');
  if(t === null) return;
  post('/api/conv', {action:'new', title:t}).then(function(r){
    if(r && r.ok){ actConv = r.conv || ''; seen = {}; toast('已新建对话'); refresh(); }
    else toast('失败：'+((r&&r.error)||'未知'));
  });
}
function openConvMenu(){
  var c = (S.convs||[]).filter(function(x){return x.id===S.conv;})[0] || {};
  openModal('对话管理 · ' + esc(c.title||S.conv), ''
    + '<div class="hintline">当前对话：<b>' + esc(c.title||c.id) + '</b>（' + esc(c.id) + '）<br>'
    + '每个对话有独立的聊天记录和自己的任务。</div>'
    + '<div class="field"><label>改名字</label><input id="cv-name" value="' + esc(c.title||'') + '"></div>'
    + '<div class="field"><label>清空历史</label>'
    + '<label style="font-size:12.5px;color:var(--tx)"><input type="checkbox" id="cv-tasks" style="width:auto"> 连同这个对话里的任务一起删掉</label>'
    + '</div>',
    '<button class="btn" onclick="renameConv()">保存名字</button>'
    + '<button class="btn" onclick="clearConv()">清空聊天记录</button>'
    + '<button class="btn bad" onclick="deleteConv()">删除整个对话</button>');
}
function renameConv(){
  var t = $('cv-name').value.trim();
  if(!t) return toast('名字不能为空');
  post('/api/conv', {action:'rename', id:S.conv, title:t}).then(function(r){
    toast(r && r.ok ? '已改名' : ('失败：'+((r&&r.error)||'未知')));
    closeModal(); refresh();
  });
}
function clearConv(){
  var also = $('cv-tasks').checked;
  if(!confirm(also ? '清空当前对话的聊天记录，并删除它名下的所有任务？' : '清空当前对话的聊天记录？（任务会保留）')) return;
  post('/api/conv', {action:'clear', id:S.conv, tasks:also}).then(function(r){
    toast(r && r.ok ? '已清空' : ('失败：'+((r&&r.error)||'未知')));
    closeModal(); seen = {}; refresh();
  });
}
function deleteConv(){
  if(!confirm('删除整个对话？聊天记录和它名下的任务都会消失，不可恢复。')) return;
  post('/api/conv', {action:'delete', id:S.conv}).then(function(r){
    if(r && r.ok){ toast('已删除'); actConv = ''; seen = {}; closeModal(); refresh(); }
    else toast('失败：'+((r&&r.error)||'未知'));
  });
}

/* ---------------- 参与者 ---------------- */
function renderAgents(){
  var el = $('agent-list'); el.innerHTML = '';
  var roles = S.roles || {};
  (S.agents||[]).forEach(function(a){
    var ms = (S.messages||{})[a.id] || [];
    var un = 0;
    if(seen[a.id] === undefined) seen[a.id] = ms.length;
    un = Math.max(0, ms.length - seen[a.id]);
    var my = [];
    ['planner','executor','reviewer'].forEach(function(k){ if(roles[k] === a.id) my.push(ROLE_CN[k].slice(0,2)); });
    var d = document.createElement('div');
    d.className = 'ag' + (a.id===actAgent ? ' active' : '');
    d.onclick = function(){ switchAgent(a.id); };
    d.innerHTML = '<div class="avatar" style="background:' + colorOf(a.id) + '">'
      + esc((a.name||a.id).slice(0,2)) + '</div>'
      + '<div class="meta"><div class="nm">' + esc(a.name||a.id)
      + (my.length ? ' <span class="role">' + esc(my.join('·')) + '</span>' : '') + '</div>'
      + '<div class="sub">' + esc(a.desc || (a.kind==='mcp'?'通过 MCP 领活':(a.kind==='cli'?'命令行':'人工')))
      + '</div></div>'
      + (un ? '<div class="badge">' + un + '</div>' : '');
    el.appendChild(d);
  });
}
function switchAgent(id){
  actAgent = id;
  seen[id] = ((S.messages||{})[id]||[]).length;
  $('h-name').textContent = '你 ↔ ' + nameOf(id);
  $('h-sub').textContent = ((S.agents||[]).filter(function(a){return a.id===id;})[0]||{}).desc || '';
  renderAgents(); renderMessages();
}

/* ---------------- 消息 & 任务 ---------------- */
function renderMessages(){
  var box = $('messages');
  var ms = (S.messages||{})[actAgent] || [];
  var tasks = (S.tasks||[]).filter(function(t){ return (t.conv||'main') === S.conv; });
  box.innerHTML = '';
  if(!ms.length && !tasks.length){
    box.innerHTML = '<div class="empty">这个对话还是空的。<br>'
      + '在下面输入一句需求，再打开左下角的引擎，剩下的交给它。</div>';
    return;
  }
  ms.forEach(function(m){ box.appendChild(bubble(m)); });
  var open = tasks.filter(function(t){ return t.status!=='approved' && t.status!=='cancelled'; });
  var done = tasks.filter(function(t){ return t.status==='approved'; });
  open.forEach(function(t){ box.appendChild(card(t)); });
  if(actAgent === (S.roles||{}).planner || actAgent === 'codex'){
    done.slice(-3).forEach(function(t){ box.appendChild(card(t)); });
  }
  box.scrollTop = box.scrollHeight;
}
function bubble(m){
  var r = document.createElement('div');
  var isUser = m.role === 'user';
  r.className = 'row ' + (isUser?'user':'other');
  var col = isUser ? '#2f6fed' : colorOf(m.role);
  var nm = isUser ? '你' : nameOf(m.role);
  var tag = (m.kind && m.kind!=='chat') ? (KIND[m.kind]||'') : '';
  var files = (m.files||[]).map(function(f){ return '<span class="fchip">' + esc(baseName(f)) + '</span>'; }).join('');
  r.innerHTML = '<div class="bav" style="background:' + col + '">' + esc(nm.slice(0,2)) + '</div>'
    + '<div class="bubble"><div class="who">' + esc(nm) + esc(tag) + '</div>'
    + '<div>' + esc(m.text) + '</div>'
    + (files ? '<div class="fchips">' + files + '</div>' : '')
    + '<div class="tm">' + esc(tm(m.at)) + '</div>'
    + (m.task_id ? '<span class="taskref">#' + esc(m.task_id) + '</span>' : '') + '</div>';
  return r;
}
function card(t){
  var d = document.createElement('div');
  d.className = 'taskcard';
  d.onclick = function(){ showDetail(t.id); };
  var spec = (t.spec||''); if(spec.length>200) spec = spec.slice(0,200)+' …';
  var acc = (t.acceptance||''); if(acc.length>150) acc = acc.slice(0,150)+' …';
  d.innerHTML = '<div class="tc-head"><span class="pill ' + esc(t.status) + '">'
    + esc(ST_CN[t.status]||t.status) + '</span>'
    + '<span class="tc-title">' + esc(t.title) + '</span>'
    + '<span class="tc-id">#' + esc(t.id) + '</span></div>'
    + '<div class="tc-spec">' + esc(spec) + '</div>'
    + (acc ? '<div class="tc-spec" style="color:#6b7280;font-size:12px">验收：' + esc(acc) + '</div>' : '')
    + '<div class="tc-meta">尝试 ' + esc(t.attempt||0) + ' 次 · 待办方 ' + esc(t.owner||'-')
    + ' · 执行方 ' + esc(t.handler||'engine') + ' · 点击看详情</div>';
  return d;
}
function showDetail(tid){
  fetch('/api/detail?id=' + encodeURIComponent(tid)).then(function(r){return r.json();}).then(function(d){
    var t = d.task||{};
    var h = '<div style="font-size:12px;color:#6b7280;margin-bottom:10px">#' + esc(tid) + ' · '
      + esc(ST_CN[t.status]||t.status) + ' · 尝试 ' + esc(t.attempt||0) + ' 次 · 待办方 '
      + esc(t.owner||'-') + '</div>';
    if(t.status==='needs_review'){
      h += '<div style="display:flex;gap:8px;margin-bottom:12px">'
        + '<button class="btn pri" onclick="act(\'approve\',\'' + tid + '\')">人工通过</button>'
        + '<button class="btn bad" onclick="act(\'reject\',\'' + tid + '\')">人工打回</button></div>';
    }
    if(t.status==='blocked' || t.status==='cancelled'){
      h += '<div style="margin-bottom:12px"><button class="btn pri" onclick="act(\'retry\',\'' + tid + '\')">重新入队</button></div>';
    }
    h += '<h4 style="font-size:13px;margin:14px 0 6px">需求</h4><div class="pre">' + esc(t.spec||'(空)') + '</div>';
    h += '<h4 style="font-size:13px;margin:14px 0 6px">验收标准</h4><div class="pre">' + esc(t.acceptance||'(未写)') + '</div>';
    if((t.files||[]).length) h += '<h4 style="font-size:13px;margin:14px 0 6px">附件</h4><div class="pre">' + esc(t.files.join('\n')) + '</div>';
    h += '<h4 style="font-size:13px;margin:14px 0 6px">执行结果</h4><div class="pre">' + esc(d.result||'(还没有提交结果)') + '</div>';
    h += '<h4 style="font-size:13px;margin:14px 0 6px">审核意见（逐轮累加）</h4><div class="pre">' + esc(d.reviews||'(还没有审核)') + '</div>';
    if(d.exec_logs && d.exec_logs.length)
      h += '<h4 style="font-size:13px;margin:14px 0 6px">执行日志（最近一轮）</h4><div class="pre">' + esc(d.exec_logs[d.exec_logs.length-1]) + '</div>';
    if(d.review_logs && d.review_logs.length)
      h += '<h4 style="font-size:13px;margin:14px 0 6px">审核日志（最近一轮）</h4><div class="pre">' + esc(d.review_logs[d.review_logs.length-1]) + '</div>';
    openModal('任务详情', h, '<button class="btn" onclick="closeModal()">关闭</button>');
  });
}

/* ---------------- 发送 ---------------- */
function renderAtt(){
  var box = $('attbox'); box.innerHTML = '';
  attachments.forEach(function(p, i){
    var d = document.createElement('div');
    d.className = 'att';
    d.innerHTML = '<span title="' + esc(p) + '">' + esc(baseName(p)) + '</span>'
      + '<b onclick="delAtt(' + i + ')">×</b>';
    box.appendChild(d);
  });
}
function delAtt(i){ attachments.splice(i,1); renderAtt(); }
function sendMsg(){
  var i = $('input'), text = i.value.trim();
  if(!text && !attachments.length) return;
  i.value = ''; i.style.height = 'auto';
  var files = attachments.slice();
  attachments = []; renderAtt();
  post('/api/send', {channel:actAgent, text:text, conv:S.conv, files:files}).then(function(r){
    if(r && r.ok) refresh(); else toast('发送失败：'+((r&&r.error)||'未知'));
  });
}
function act(a, tid, extra){
  var comment = null;
  if(a==='reject'||a==='block'||a==='cancel'){
    comment = prompt(a==='reject'?'打回原因（写清楚，执行方要照着改）':'原因：','');
    if(comment===null) return;
  } else if(a==='approve'){
    comment = prompt('通过意见（可留空）：','人工审核通过');
    if(comment===null) return;
  }
  var body = Object.assign({task_id:tid}, extra||{});
  if(comment!==null) body.comment = comment;
  post('/api/action', {action:a, payload:body}).then(function(r){
    if(r && r.ok){ toast('完成'); refresh(); }
    else toast('失败：'+((r&&r.error||r.out)||'未知'));
  });
}

/* ---------------- 文件 ---------------- */
function openFiles(){
  fsSel = [];
  openModal('加附件', ''
    + '<div class="tabs"><div class="tab on" id="tab-local" onclick="tabFiles(\'local\')">本机文件</div>'
    + '<div class="tab" id="tab-up" onclick="tabFiles(\'up\')">上传文件</div></div>'
    + '<div id="pane-local"><div class="crumb" id="fs-crumb">…</div><div id="fslist"></div>'
    + '<div class="hintline" style="margin-top:9px">点文件夹进去，点文件选中；可以多选。选完点「加入附件」。</div></div>'
    + '<div id="pane-up" style="display:none">'
    + '<div class="field"><label>选一个或多个文件，会上传到协作台的 uploads 目录，再作为附件交给 AI</label>'
    + '<input type="file" id="up-input" multiple></div>'
    + '<div class="hintline">单个文件上限 64 MB。大文件建议直接用「本机文件」引用，不复制。</div></div>',
    '<button class="btn" onclick="closeModal()">取消</button>'
    + '<button class="btn" id="fs-add" onclick="addPicked()">加入附件</button>'
    + '<button class="btn pri" id="up-go" style="display:none" onclick="doUpload()">上传并加入</button>');
  loadFs(S.home || '');
}
function tabFiles(which){
  $('tab-local').className = 'tab' + (which==='local'?' on':'');
  $('tab-up').className = 'tab' + (which==='up'?' on':'');
  $('pane-local').style.display = which==='local' ? '' : 'none';
  $('pane-up').style.display = which==='up' ? '' : 'none';
  $('fs-add').style.display = which==='local' ? '' : 'none';
  $('up-go').style.display = which==='up' ? '' : 'none';
}
function loadFs(path){
  fetch('/api/fs?path=' + encodeURIComponent(path)).then(function(r){return r.json();}).then(function(d){
    if(!d || !d.ok){ toast('打不开：'+((d&&d.error)||'未知')); return; }
    fsPath = d.path;
    $('fs-crumb').textContent = d.path;
    var el = $('fslist'); el.innerHTML = '';
    var up = document.createElement('div');
    up.className = 'fitem dir';
    up.innerHTML = '<div class="nm">⬆ ..</div>';
    up.onclick = function(){ loadFs(d.parent); };
    el.appendChild(up);
    (d.entries||[]).forEach(function(e){
      var it = document.createElement('div');
      it.className = 'fitem' + (e.dir?' dir':'');
      it.innerHTML = '<div class="nm">' + (e.dir?'📁 ':'📄 ') + esc(e.name) + '</div>'
        + '<div class="sz">' + (e.dir ? '' : esc(fmtSize(e.size))) + '</div>'
        + '<div class="sz">' + esc(e.mt) + '</div>';
      it.onclick = function(){
        if(e.dir){ loadFs(e.path); }
        else {
          var i = fsSel.indexOf(e.path);
          if(i >= 0){ fsSel.splice(i,1); it.style.background=''; }
          else { fsSel.push(e.path); it.style.background='#e8f0fe'; }
        }
      };
      el.appendChild(it);
    });
  });
}
function addPicked(){
  if(!fsSel.length) return toast('还没选文件');
  fsSel.forEach(function(p){ if(attachments.indexOf(p)<0) attachments.push(p); });
  renderAtt(); closeModal(); toast('已加入 ' + fsSel.length + ' 个');
}
function doUpload(){
  var inp = $('up-input');
  if(!inp.files || !inp.files.length) return toast('还没选文件');
  var list = Array.prototype.slice.call(inp.files);
  var done = 0;
  list.forEach(function(f){
    if(f.size > 64*1024*1024){ toast(f.name + ' 超过 64MB，跳过'); return; }
    var fr = new FileReader();
    fr.onload = function(){
      var b64 = String(fr.result).split(',')[1] || '';
      post('/api/upload', {conv:S.conv, name:f.name, data:b64}).then(function(r){
        if(r && r.ok){ if(attachments.indexOf(r.path)<0) attachments.push(r.path); renderAtt(); }
        else toast('上传失败：'+((r&&r.error)||'未知'));
        if(++done >= list.length) closeModal();
      });
    };
    fr.readAsDataURL(f);
  });
  toast('正在上传 ' + list.length + ' 个文件…');
}

/* ---------------- 参与者 / 分工 ---------------- */
function openAddAgent(){
  openModal('添加一个 AI 一起来干活', ''
    + '<div class="hintline">加完之后，把一个角色（规划/执行/审核）交给它，或者让它通过 MCP 来领活。<br>'
    + '不需要改任何代码，也不需要装 Python。</div>'
    + '<div class="kvs"><label>标识</label><input id="ag-id" placeholder="claude" style="flex:1;padding:7px 9px;border:1px solid #e3e6ea;border-radius:7px"></div>'
    + '<div class="kvs"><label>显示名</label><input id="ag-name" placeholder="Claude" style="flex:1;padding:7px 9px;border:1px solid #e3e6ea;border-radius:7px"></div>'
    + '<div class="kvs"><label>它怎么干活</label><select id="ag-kind">'
    + '<option value="cli">命令行（能自动调用，用来分工）</option>'
    + '<option value="mcp">通过 MCP 领活（它主动来拿）</option>'
    + '<option value="human">人工</option></select></div>'
    + '<div class="kvs"><label>负责什么</label><input id="ag-desc" placeholder="规划 + 审美" style="flex:1;padding:7px 9px;border:1px solid #e3e6ea;border-radius:7px"></div>'
    + '<div class="field"><label>命令行模板（选「命令行」时填）</label>'
    + '<textarea id="ag-cmd" placeholder="claude -p < {prompt_file} > {out_file}"></textarea>'
    + '<div class="hintline" style="margin-top:6px">可用占位符：<b>{prompt_file}</b> <b>{out_file}</b> <b>{workdir}</b> <b>{model}</b> <b>{effort}</b>'
    + '（路径会自动加引号，不用自己写）。不同 CLI 的写法不一样，按它的文档填。</div></div>',
    '<button class="btn" onclick="closeModal()">取消</button>'
    + '<button class="btn pri" onclick="submitAgent()">添加</button>');
}
function submitAgent(){
  var body = {action:'add', id:$('ag-id').value.trim(), name:$('ag-name').value.trim(),
              kind:$('ag-kind').value, desc:$('ag-desc').value.trim(), cmd:$('ag-cmd').value.trim()};
  if(!body.id) return toast('标识必填');
  post('/api/agent', body).then(function(r){
    if(r && r.ok){
      var extra = '';
      if(body.kind === 'mcp' && r.snippet){
        extra = '<div class="hintline" style="margin-top:12px">'
          + '把这个粘到「' + esc(body.name||body.id) + '」的 MCP 配置里，它就能用 bridge_inbox / bridge_claim / bridge_submit 来领活交活了：</div>'
          + '<div class="pre">' + esc(r.snippet) + '</div>';
      } else if(body.kind === 'cli'){
        extra = '<div class="hintline" style="margin-top:12px">现在去「分工设置」把它安排到某一环上。</div>';
      }
      openModal('已添加 ' + esc(body.name||body.id), extra
        + '<div style="margin-top:12px"><button class="btn pri" onclick="closeModal();openRoles()">去设分工</button></div>',
        '<button class="btn" onclick="closeModal()">好</button>');
      refresh();
    } else toast('失败：'+((r&&r.error)||'未知'));
  });
}
function openRoles(){
  var opts = (S.agents||[]).map(function(a){
    var can = a.runnable ? '' : '（不能自动调用）';
    return '<option value="' + esc(a.id) + '">' + esc(a.name||a.id) + ' ' + esc(can) + '</option>';
  }).join('');
  function row(role, cur, needRunnable){
    var o = needRunnable
      ? (S.agents||[]).filter(function(a){return a.runnable;}).map(function(a){
          return '<option value="' + esc(a.id) + '"' + (cur===a.id?' selected':'') + '>'
            + esc(a.name||a.id) + '</option>'; }).join('')
      : (S.agents||[]).map(function(a){
          return '<option value="' + esc(a.id) + '"' + (cur===a.id?' selected':'') + '>'
            + esc(a.name||a.id) + '</option>'; }).join('');
    var chat = ['planner_channel','executor_channel'].indexOf(role) >= 0 ? ' style="margin-top:14px"' : '';
    return '<div class="kvs"' + chat + '><label>' + esc(ROLE_CN[role]) + '</label>'
      + '<select id="role-' + role + '">' + (needRunnable ? o : ('<option value="">（不指定）</option>' + o)) + '</select>'
      + '<div class="tag">' + (needRunnable ? '要能自动调用' : '消息频道') + '</div></div>';
  }
  var r = S.roles || {};
  openModal('分工设置', ''
    + '<div class="hintline">换人就是换模型 —— 这样可以把 token 花在刀刃上。<br>'
    + '比如：规划交给擅长审美的那家，审核交给擅长挑错的，执行交给便宜快的那家。</div>'
    + row('planner', r.planner || 'codex', true)
    + row('executor', r.executor || 'codex', true)
    + row('reviewer', r.reviewer || 'codex', true)
    + row('planner_channel', r.planner_channel || 'codex', false)
    + row('executor_channel', r.executor_channel || 'workbuddy', false)
    + '<div class="hintline" style="margin-top:14px">改完要**重启引擎**才生效（引擎启动时读一次配置）。</div>',
    '<button class="btn" onclick="closeModal()">取消</button>'
    + '<button class="btn pri" onclick="saveRoles()">保存</button>');
}
function saveRoles(){
  var roles = ['planner','executor','reviewer','planner_channel','executor_channel'];
  var jobs = [];
  roles.forEach(function(k){
    var el = $('role-' + k);
    if(!el) return;
    jobs.push(post('/api/roles', {role:k, agent:el.value}).then(function(r){
      if(!(r && r.ok)) throw new Error(k + ': ' + ((r&&r.error)||'失败'));
    }));
  });
  Promise.all(jobs).then(function(){
    toast('分工已保存'); closeModal(); refresh();
  }).catch(function(e){ toast('保存失败：' + e.message); });
}

/* ---------------- 引擎 ---------------- */
async function setEngine(){
  var v = $('eng-mode').value;
  var body = (v === 'off') ? {enable:false} : {enable:true, mode:v};
  enginePending = true;
  try {
    var r = await post('/api/engine', body);
    enginePending = false;
    if(r && r.ok) toast(v==='off' ? '已关闭引擎' :
      (v==='review' ? '已开启：只审核，执行交给别的 AI' : '已开启：按分工自动跑'));
    else toast('失败：'+((r&&r.error)||'未知'));
  } catch(e){ enginePending = false; toast('请求失败'); }
  refresh();
}
function runOnce(){
  post('/api/engine', {once:true}).then(function(r){
    toast(r && r.ok ? '已启动单轮处理' : ('失败：'+((r&&r.error)||'未知')));
  });
}
function openFolder(){
  post('/api/open', {}).then(function(){ toast('已打开数据目录'); });
}
function renderEngine(){
  var e = S.engine||{};
  if(!enginePending){
    var want = e.running ? (e.mode === 'review' ? 'review' : 'auto') : 'off';
    if($('eng-mode').value !== want) $('eng-mode').value = want;
  }
  var el = $('eng-text'), ph = $('eng-phase');
  el.className = '';
  if(e.running && e.busy){ el.className='busy'; el.textContent = '运行中 · 正在忙'; }
  else if(e.running){ el.className='on'; el.textContent = '运行中 · 待命中'; }
  else { el.textContent = '未运行'; }
  if(e.running){
    var p = {intake:'正在规划任务', execute:'执行方正在干活', review:'正在审核'}[e.phase]||'待命';
    var md2 = (e.mode === 'review') ? ' · 只审核' : ' · 全自动';
    ph.textContent = p + (e.current?('（'+e.current+'）'):'') + md2 + ' · PID ' + (e.pid||'-');
  } else {
    ph.textContent = '引擎没开时，任务只会排队等人工处理。';
  }
  var st = e.stats||{};
  $('stats').innerHTML = '累计：规划 '+esc(st.intake||0)+' · 执行 '+esc(st.executed||0)
    + ' · 通过 '+esc(st.approved||0)+' · 打回 '+esc(st.rejected||0)+' · 阻塞 '+esc(st.blocked||0);
}

/* ---------------- 通用 ---------------- */
function post(path, obj){
  return fetch(path, {method:'POST', headers:{'Content-Type':'application/json'},
                      body:JSON.stringify(obj)}).then(function(r){ return r.json(); });
}
function openModal(title, body, footer){
  $('modal-title').textContent = title;
  $('modal-bd').innerHTML = body;
  $('modal-ft').innerHTML = footer || '';
  $('mask').classList.add('on');
  $('modal').classList.add('on');
}
function closeModal(){
  $('mask').classList.remove('on');
  $('modal').classList.remove('on');
}
function toast(m){
  var t = $('toast'); t.textContent = m; t.classList.add('show');
  setTimeout(function(){ t.classList.remove('show'); }, 2600);
}
function refresh(){
  var q = S.conv ? ('?conv=' + encodeURIComponent(S.conv)) : '';
  fetch('/api/state' + q).then(function(r){return r.json();}).then(function(s){
    S = s;
    if(!actConv) actConv = s.conv;
    if(!actAgent || !(s.agents||[]).some(function(a){return a.id===actAgent;})){
      actAgent = (s.roles||{}).planner || ((s.agents||[])[0]||{}).id || 'codex';
    }
    var pend = (s.tasks||[]).filter(function(t){
      return t.status==='pending'||t.status==='rejected'||t.status==='needs_review'; }).length;
    $('status-pill').textContent = '对话 ' + (s.convs||[]).length + ' · 任务 '
      + (s.tasks||[]).length + ' · 待办 ' + pend + ' · ' + s.now;
    renderConvs(); renderAgents(); renderEngine(); renderMessages();
    if(!booted){ booted = true; switchAgent(actAgent); }
  }).catch(function(){ $('status-pill').textContent = '读取中…'; });
}
var inp = $('input');
inp.addEventListener('keydown', function(e){
  if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); sendMsg(); }
});
inp.addEventListener('input', function(){
  inp.style.height='auto'; inp.style.height = Math.min(inp.scrollHeight,130)+'px';
});
document.addEventListener('keydown', function(e){ if(e.key==='Escape') closeModal(); });
inp.addEventListener('paste', function(e){
  var items = (e.clipboardData||{}).items || [];
  for(var i=0;i<items.length;i++){
    if(items[i].type && items[i].type.indexOf('image') === 0){
      var f = items[i].getAsFile();
      if(!f) continue;
      var fr = new FileReader();
      fr.onload = function(){
        var b64 = String(fr.result).split(',')[1] || '';
        post('/api/upload', {conv:S.conv, name:'paste-'+Date.now()+'.png', data:b64}).then(function(r){
          if(r && r.ok){ attachments.push(r.path); renderAtt(); toast('已粘贴截图'); }
        });
      };
      fr.readAsDataURL(f);
    }
  }
});
refresh(); setInterval(refresh, 2000);
</script>
</body>
</html>
'''


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _send(self, body, ctype="application/json; charset=utf-8", code=200):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionAbortedError):
            pass

    def _body(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
            return json.loads(self.rfile.read(n).decode("utf-8")) if n else {}
        except Exception:
            return {}

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if u.path in ("/", "/index.html"):
            return self._send(HTML, "text/html; charset=utf-8")
        if u.path == "/api/state":
            return self._send(json.dumps(api_state((q.get("conv") or [""])[0]),
                                         ensure_ascii=False))
        if u.path == "/api/detail":
            return self._send(json.dumps(api_detail((q.get("id") or [""])[0]),
                                         ensure_ascii=False))
        if u.path == "/api/fs":
            return self._send(json.dumps(api_fs((q.get("path") or [""])[0]),
                                         ensure_ascii=False))
        return self._send(json.dumps({"ok": False, "error": "not found"}),
                          code=404)

    def do_POST(self):
        u = urlparse(self.path)
        d = self._body()
        if u.path == "/api/send":
            return self._send(json.dumps(
                api_send(d.get("channel"), d.get("text"),
                         d.get("conv") or DEFAULT_CONV, d.get("files")),
                ensure_ascii=False))
        if u.path == "/api/conv":
            return self._send(json.dumps(
                api_conv(d.get("action"), d.get("id") or "", d.get("title") or "",
                         bool(d.get("tasks"))), ensure_ascii=False))
        if u.path == "/api/agent":
            return self._send(json.dumps(
                api_agent(d.get("action"), d.get("id") or "", d.get("name") or "",
                          d.get("kind") or "mcp", d.get("desc") or "",
                          d.get("cmd") or "", d.get("model") or "", d.get("effort") or ""),
                ensure_ascii=False))
        if u.path == "/api/roles":
            return self._send(json.dumps(
                api_roles(d.get("role"), d.get("agent")), ensure_ascii=False))
        if u.path == "/api/upload":
            return self._send(json.dumps(
                api_upload(d.get("conv") or DEFAULT_CONV, d.get("name"), d.get("data")),
                ensure_ascii=False))
        if u.path == "/api/action":
            return self._send(json.dumps(api_action(d.get("action"), d.get("payload")),
                                         ensure_ascii=False))
        if u.path == "/api/engine":
            if d.get("once"):
                r = engine_once()
            elif d.get("enable"):
                r = engine_start(d.get("mode") or "auto")
            else:
                r = engine_stop()
            return self._send(json.dumps(r, ensure_ascii=False))
        if u.path == "/api/open":
            try:
                os.startfile(BASE_DIR)
                return self._send(json.dumps({"ok": True}))
            except Exception as e:
                return self._send(json.dumps({"ok": False, "error": str(e)}))
        return self._send(json.dumps({"ok": False, "error": "not found"}), code=404)


def free_port(preferred):
    for p in range(preferred, preferred + 60):
        s = socket.socket()
        try:
            s.bind(("127.0.0.1", p))
            s.close()
            return p
        except OSError:
            continue
        finally:
            try:
                s.close()
            except Exception:
                pass
    return 0


def main():
    port = 8765
    no_browser = "--no-browser" in sys.argv
    if "--port" in sys.argv:
        try:
            port = int(sys.argv[sys.argv.index("--port") + 1])
        except Exception:
            pass
    port = free_port(port)
    if not port:
        print("[错误] 找不到可用端口")
        return 1
    os.makedirs(MESSAGES_DIR, exist_ok=True)
    os.makedirs(TASKS_DIR, exist_ok=True)
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    url = "http://127.0.0.1:%d/" % port
    print("=" * 58)
    print("  Codex 协作台已启动")
    print("  " + url)
    print("  数据目录: " + BASE_DIR)
    print("  按 Ctrl+C 停止（引擎是独立进程，不受影响）")
    print("=" * 58)
    if not no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止界面服务。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
