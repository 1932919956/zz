#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
bridge_app.py — Codex 协作台的唯一入口

一个程序，四种模式：

    bridge_app.py                      打开图形界面（本地网页，零依赖）
    bridge_app.py --engine [选项]      跑全自动闭环引擎
    bridge_app.py --mcp                跑 MCP 服务（给 WorkBuddy 用）
    bridge_app.py --cli <子命令> ...   跑协议命令行（等价于原来的 bridge.py）

打包成 exe 之后，这四种模式就都在这一个文件里，靠参数切换。
引擎和命令行子任务都是「再启动一次自己」，所以 exe 不需要外部 Python。
"""

import os
import sys

# 打包时必须能被静态分析到，所以这里是顶层 import（不能藏在函数里）
import _rt          # noqa: F401
import bridge       # noqa: F401
import bridge_mcp   # noqa: F401
import orchestrator  # noqa: F401
import ui           # noqa: F401


USAGE = """Codex 协作台 — 用法

  bridge_app                      打开图形界面（默认）
  bridge_app --engine [选项]      跑全自动闭环引擎
  bridge_app --mcp                跑 MCP 服务（给 WorkBuddy 用）
  bridge_app --cli <子命令> ...   协议命令行

引擎常用选项：
  --only intake,execute,review    只跑某些环节
  --only intake,review            只规划+审核（执行交给 WorkBuddy）
  --default-handler workbuddy     新任务默认交给 WorkBuddy
  --once                          各环节跑一轮就退出
  --status                        看状态
  --reset-state                   清掉已处理消息记录
"""


def _fix_console():
    """让 Windows 控制台能正确显示中文。

    默认控制台用 OEM 代码页（936），而我们输出的是 UTF-8，
    双击 exe 时中文就会变成乱码。把控制台代码页切成 UTF-8 即可。
    """
    if os.name == "nt":
        try:
            import ctypes
            ctypes.windll.kernel32.SetConsoleOutputCP(65001)
            ctypes.windll.kernel32.SetConsoleCP(65001)
        except Exception:
            pass
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def main():
    _fix_console()
    argv = sys.argv[1:]
    mode = argv[0] if argv else ""
    rest = argv[1:]

    if mode in ("-h", "--help", "help"):
        sys.stdout.write(USAGE)
        return 0

    if mode == "--engine":
        sys.argv = ["orchestrator.py"] + rest
        return orchestrator.main()

    if mode == "--mcp":
        return bridge_mcp.main()

    if mode == "--cli":
        sys.argv = ["bridge.py"] + rest
        return bridge.main()

    if mode in ("--ui", "ui"):
        sys.argv = ["ui.py"] + rest
        return ui.main()

    # 默认：图形界面
    sys.argv = ["ui.py"]
    return ui.main()


if __name__ == "__main__":
    sys.exit(main())
