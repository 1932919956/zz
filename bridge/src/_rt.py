#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
_rt.py — 运行时底座（所有模块共用）

解决打包成 exe 后必然遇到的两个坑：

1) 一个文件（onefile）打包的 exe，运行时会把自己解压到临时目录，
   于是 __file__ 指向临时目录而不是"用户放 exe 的那个目录"，
   按 __file__ 去找 tasks/ config.json 必然找不到。
   —— 这就是原来那个 CodexBridge.exe 在 dist/ 下界面全空的根因。

2) 打包后 sys.executable 就是 exe 自己，拿它去执行 bridge.py 会变成
   "再启动一次界面"，命令根本没跑。
   —— 这是原来 exe 里点任何按钮都只弹一个新窗口的根因。

这里给出统一答案：
   BASE_DIR  按"谁能看到 bridge.py / tasks / config.json"来决定
   self_cmd() 重新启动自己（冻结态直接就是 exe，源码态是 python bridge_app.py）
"""

import os
import sys

FROZEN = bool(getattr(sys, "frozen", False))


def _is_data_dir(d):
    """强标记：这个目录里有协作台的数据。"""
    if not d or not os.path.isdir(d):
        return False
    for marker in ("config.json", "tasks", "messages", "logs"):
        if os.path.exists(os.path.join(d, marker)):
            return True
    return False


def _is_source_dir(d):
    """弱标记：这个目录里有源码（但未必是数据目录）。"""
    if not d or not os.path.isdir(d):
        return False
    for marker in ("bridge.py", "bridge_app.py", "bridge_mcp.py"):
        if os.path.exists(os.path.join(d, marker)):
            return True
    return False


def _pick(cands):
    # 先要有数据的（config.json / tasks / messages / logs），
    # 这样即使源码被收进子目录（比如 src/），也不会把 src 当成数据目录。
    for c in cands:
        if _is_data_dir(c):
            return os.path.abspath(c)
    for c in cands:
        if _is_source_dir(c):
            return os.path.abspath(c)
    return None


def resolve_base_dir():
    env = os.environ.get("BRIDGE_DIR")
    if env and os.path.isdir(env):
        return os.path.abspath(env)

    if FROZEN:
        # 关键：冻结态下 __file__ 指向临时解包目录（_MEIPASS），
        # 那里面也有 bundle 进去的 bridge.py，会被误判成数据目录 ——
        # 于是任务被写进临时目录，程序一退出就全没了。
        # 所以冻结态**绝不**考虑 __file__，只看 exe 自己所在的目录。
        exe_dir = os.path.dirname(os.path.abspath(sys.executable))
        got = _pick([exe_dir, os.path.join(exe_dir, "bridge")])
        # 没找到就就地用 exe 所在目录（exe 可以单独丢一个空文件夹里用）
        return got or exe_dir

    here = os.path.dirname(os.path.abspath(__file__))
    parent = os.path.dirname(here)
    got = _pick([here, parent,
                 os.path.join(here, "bridge"), os.path.join(parent, "bridge")])
    return got or here


BASE_DIR = resolve_base_dir()


# 源码所在目录。它可能**不等于** BASE_DIR（数据目录）——
# 源码被收进 src/ 之后这两件事必须分清：
#   HERE     = 代码在哪（找 bridge_app.py 用它）
#   BASE_DIR = 数据在哪（找 tasks/ config.json 用它）
HERE = os.path.dirname(os.path.abspath(__file__))


def self_cmd(*args):
    """构造「再启动一个自己」的命令行。"""
    args = [str(a) for a in args]
    if FROZEN:
        return [sys.executable] + args
    return [sys.executable, "-X", "utf8", os.path.join(HERE, "bridge_app.py")] + args


def cli_cmd(*args):
    """跑一次 bridge.py 的命令行子命令。"""
    return self_cmd("--cli", *args)


def engine_cmd(*args):
    """启动协作台引擎。"""
    return self_cmd("--engine", *args)


def child_env():
    """给子进程的环境：强制 UTF-8，避免中文乱码。"""
    env = dict(os.environ)
    env["PYTHONUTF8"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    env["BRIDGE_DIR"] = BASE_DIR
    return env


def no_window():
    return getattr(__import__("subprocess"), "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
