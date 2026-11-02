/**
 * workbuddy.mjs — 让 AIROOM 里的成员把活派给 WorkBuddy（那个 GUI 的 AI）
 *
 * 走的是我们那套 bridge：
 *   成员 → 建任务 → WorkBuddy 通过 MCP 领活 → 干活 → 交活 → 成员拿回结果
 *
 * 环境变量（写在那条连接的环境变量里，可选）：
 *   WB_BRIDGE_DIR=...     桥接目录，默认 C:\Users\<你的用户名>\WorkBuddy AI\2026-10-15-19-35-38\bridge
 *   WB_CONV=airoom        任务放在哪个会话
 *   WB_WAIT_SECONDS=300   默认等多久
 *
 * 前提：WorkBuddy 里要能调用 codex-bridge 这个 MCP（已经配在 ~/.workbuddy-ai/mcp.json），
 * 并且它得真的去「领活」—— 所以派完活之后，记得在 WorkBuddy 里说一句「去 bridge 看看有没有活」。
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const title = 'WorkBuddy 派活';

const BRIDGE = process.env.WB_BRIDGE_DIR
  || 'C:\\Users\\<你的用户名>\\WorkBuddy AI\\2026-10-15-19-35-38\\bridge';
const EXE = path.join(BRIDGE, 'CodexBridge.exe');
const CONV = process.env.WB_CONV || 'airoom';
const WAIT = Number(process.env.WB_WAIT_SECONDS || 300);

const STATUS_CN = {
  pending: '等 WorkBuddy 领取',
  in_progress: 'WorkBuddy 正在执行',
  needs_review: '已提交，等审核',
  rejected: '被打回，要重做',
  approved: '已通过',
  blocked: '卡住了，需要人工介入',
  cancelled: '已取消',
};

function run(args, timeoutMs) {
  return new Promise((resolve) => {
    if (!fs.existsSync(EXE)) return resolve({ code: -1, out: '', err: '找不到 ' + EXE });
    const child = spawn(EXE, ['--cli', ...args], { cwd: BRIDGE, windowsHide: true });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs || 120000);
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: String(e) }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readIfExists(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

export const tools = [
  {
    name: 'ask_workbuddy',
    description: '把一件需要动手的活派给 WorkBuddy（另一个 AI，有自己的界面和工具），等它做完把结果拿回来。'
      + '适合：写/改文件、跑脚本、做图、整理资料这类"落在硬盘上"的任务。派完记得在 WorkBuddy 里让它去领活。',
    kind: 'execute',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '要它做什么，写具体：要交付什么、放在哪、什么算完成' },
        acceptance: { type: 'string', description: '可选，验收标准' },
        workdir: { type: 'string', description: '可选，在哪个目录里干（绝对路径）' },
        wait_seconds: { type: 'number', description: '最多等多久，默认 300 秒' },
      },
      required: ['task'],
    },
    async run(args, ctx) {
      const task = String(args.task || '').trim();
      if (!task) return '[错误] 要给 task。';

      const title = task.split('\n')[0].slice(0, 60);
      const specFile = path.join(os.tmpdir(), 'wb-task-' + randomUUID() + '.md');
      fs.writeFileSync(specFile, task, 'utf8');

      const cli = ['new', '--title', title, '--spec-file', specFile,
        '--handler', 'workbuddy', '--conv', CONV];

      let acceptance = String(args.acceptance || '').trim();
      if (acceptance) {
        const af = path.join(os.tmpdir(), 'wb-accept-' + randomUUID() + '.md');
        fs.writeFileSync(af, acceptance, 'utf8');
        cli.push('--acceptance-file', af);
      }
      const workdir = String(args.workdir || '').trim();
      if (workdir) cli.push('--workdir', workdir);

      const created = await run(cli, 60000);
      try { fs.unlinkSync(specFile); } catch {}
      const m = created.out.match(/TASK_ID=(\S+)/);
      if (!m) return '[派活失败] ' + (created.err || created.out || '未知错误').slice(0, 400);
      const id = m[1];
      ctx.log('已派活 ' + id + ' -> ' + title);

      const deadline = Date.now() + Math.min(Number(args.wait_seconds || WAIT), 1800) * 1000;
      let last = '';
      while (Date.now() < deadline) {
        await sleep(3000);
        const shown = await run(['show', id], 60000);
        let t;
        try { t = JSON.parse(shown.out); } catch { continue; }
        if (t.status !== last) {
          last = t.status;
          ctx.log('任务 ' + id + ' -> ' + t.status);
        }
        if (t.status === 'approved') {
          const body = readIfExists(path.join(BRIDGE, 'results', id + '.md'));
          return '[WorkBuddy 已完成，共尝试 ' + (t.attempt || 0) + ' 次]\n\n' + (body || '(结果文件为空)').slice(0, 6000);
        }
        if (t.status === 'blocked' || t.status === 'cancelled') {
          const rev = readIfExists(path.join(BRIDGE, 'reviews', id + '.md'));
          return '[任务 ' + (STATUS_CN[t.status] || t.status) + ']\n' + (rev || '').slice(0, 2000);
        }
      }

      return '[已派活，但还没等到结果]\n任务号：' + id + '（当前：' + (STATUS_CN[last] || last || '未知') + '）\n'
        + '去 WorkBuddy 里说一句「去 bridge 领活」，它领了就会开始做。\n'
        + '做完之后你可以再问我一次，或者直接用 workbuddy_status 查。';
    },
  },
  {
    name: 'workbuddy_status',
    description: '查一个已派给 WorkBuddy 的任务现在什么状态（不等待）。',
    kind: 'read',
    parameters: {
      type: 'object',
      properties: { task_id: { type: 'string', description: '任务号，派活时返回的那个' } },
      required: ['task_id'],
    },
    async run(args) {
      const id = String(args.task_id || '').trim();
      if (!id) return '[错误] 要给 task_id。';
      const shown = await run(['show', id], 60000);
      let t;
      try { t = JSON.parse(shown.out); } catch { return '[查不到] ' + (shown.err || shown.out).slice(0, 300); }
      const lines = [
        '任务 ' + id,
        '标题：' + (t.title || ''),
        '状态：' + (STATUS_CN[t.status] || t.status) + '（' + t.status + '）',
        '尝试：' + (t.attempt || 0) + ' 次',
      ];
      if (t.status === 'approved') {
        const body = readIfExists(path.join(BRIDGE, 'results', id + '.md'));
        if (body) lines.push('', '结果：', body.slice(0, 4000));
      }
      return lines.join('\n');
    },
  },
];
