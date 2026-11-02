#!/usr/bin/env node
/**
 * wb-acp.mjs — 让 AIROOM 能指挥 WorkBuddy 干活的 ACP 适配器
 *
 * 背景：WorkBuddy 没有命令行，AIROOM 也不支持自定义 MCP 服务器。
 * 但 AIROOM 支持「自己添加执行端」——只要那个程序会讲 ACP 协议
 * （Agent Client Protocol：换行分隔的 JSON-RPC 2.0，跑在 stdio 上）。
 *
 * 所以这里做一个 ACP 服务端，把 AIROOM 派来的任务转成 bridge 任务：
 *
 *   AIROOM ──ACP──▶ 本脚本 ──CLI──▶ CodexBridge.exe ──文件信箱──▶ WorkBuddy
 *                       ▲                                          │
 *                       └──────────── 轮询结果，回传 ──────────────┘
 *                                            （WorkBuddy 用 MCP 领活/交活）
 *
 * 在 AIROOM 里这样注册（设置与连接 → 添加连接）：
 *   程序路径：本文件的完整路径，例如 C:\...\bridge\wb-acp.mjs
 *   启动参数：（留空）
 *   环境变量：（可选，每行一个 名称=值）
 *     WB_CONV=airoom            任务放在哪个对话里（默认 airoom）
 *     WB_POLL_MS=3000           轮询间隔毫秒
 *     WB_TIMEOUT_MS=7200000     单个任务最长等多久（默认 2 小时）
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_DIR = process.env.WB_BRIDGE_DIR || HERE;
const EXE = process.env.WB_BRIDGE_EXE || path.join(BRIDGE_DIR, 'CodexBridge.exe');
const CONV = process.env.WB_CONV || 'airoom';
const POLL_MS = Number(process.env.WB_POLL_MS || 3000);
const TIMEOUT_MS = Number(process.env.WB_TIMEOUT_MS || 2 * 60 * 60 * 1000);

const STATUS_CN = {
  pending: '等待 WorkBuddy 领取', in_progress: 'WorkBuddy 正在执行',
  needs_review: '已提交，等审核', rejected: '被打回，WorkBuddy 要重做',
  approved: '已通过', blocked: '卡住了，需要人工介入', cancelled: '已取消',
};

function logToStderr(text) {
  // stdout 只放 JSON-RPC 帧，日志一律走 stderr
  try { process.stderr.write('[wb-acp] ' + text + '\n'); } catch {}
}

/* ---------------------------------------------------------------- 调用 bridge */

function bridge(args, timeoutMs = 120000) {
  return new Promise((resolve) => {
    if (!fs.existsSync(EXE)) {
      return resolve({ code: -1, out: '', err: '找不到 ' + EXE + '（可用 WB_BRIDGE_EXE 指定）' });
    }
    const child = spawn(EXE, ['--cli', ...args], { cwd: BRIDGE_DIR, windowsHide: true });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: String(e) }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

async function readTask(id) {
  const r = await bridge(['show', id], 60000);
  try { return JSON.parse(r.out); } catch { return null; }
}

function readFileIfExists(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

/* ---------------------------------------------------------------- ACP 传输层 */

function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function fail(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }
function notify(method, params) { send({ jsonrpc: '2.0', method, params }); }

function update(sessionId, sessionUpdate, extra) {
  notify('session/update', { sessionId, update: Object.assign({ sessionUpdate }, extra || {}) });
}
function say(sessionId, text) {
  if (text) update(sessionId, 'agent_message_chunk', { content: { type: 'text', text } });
}
function note(sessionId, text) {
  if (text) update(sessionId, 'agent_thought_chunk', { content: { type: 'text', text } });
}
function toolCall(sessionId, toolCallId, title, status, kind) {
  update(sessionId, 'tool_call', {
    toolCallId, title, kind: kind || 'other',
    status: status || 'in_progress', rawInput: {},
  });
}

const sessions = new Map();
const cancelled = new Set();

function promptText(prompt) {
  if (typeof prompt === 'string') return prompt;
  if (!Array.isArray(prompt)) return '';
  return prompt.map((part) => {
    if (typeof part === 'string') return part;
    if (part && part.type === 'text') return part.text || '';
    if (part && typeof part.text === 'string') return part.text;
    return '';
  }).join('\n');
}

function firstLine(text) {
  const line = String(text || '').split('\n').map((s) => s.trim()).find((s) => s.length > 0) || '';
  return line.replace(/^[#>*\-\s]+/, '').slice(0, 60);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------------------------------------- 核心：派活 + 等结果 */

async function runTask(sessionId, cwd, text) {
  const title = firstLine(text) || 'AIROOM 派来的任务';

  // spec 走文件，避免命令行长度和引号问题
  const specFile = path.join(os.tmpdir(), 'wb-acp-' + randomUUID() + '.md');
  fs.writeFileSync(specFile, text, 'utf8');

  const args = [
    'new', '--title', title,
    '--spec-file', specFile,
    '--acceptance', '由 WorkBuddy 完成并提交，AIROOM 的审核方按任务要求验收',
    '--handler', 'workbuddy',
    '--conv', CONV,
  ];
  if (cwd && path.isAbsolute(cwd)) args.push('--workdir', cwd);

  const created = await bridge(args, 120000);
  try { fs.unlinkSync(specFile); } catch {}

  const m = created.out.match(/TASK_ID=(\S+)/);
  if (!m) {
    say(sessionId, '派单失败：' + (created.err || created.out || '未知错误'));
    logToStderr('建任务失败 ' + created.code + ' ' + created.err);
    return 'end_turn';
  }
  const id = m[1];
  say(sessionId, '已把任务派给 WorkBuddy（任务号 ' + id + '）。\n接下来等它在自己的界面里领活、干活、交活。\n');
  logToStderr('派单 ' + id + ' cwd=' + cwd);

  const started = Date.now();
  let lastStatus = '';
  let rounds = 0;

  while (Date.now() - started < TIMEOUT_MS) {
    await sleep(POLL_MS);

    if (cancelled.has(sessionId)) {
      cancelled.delete(sessionId);
      await bridge(['cancel', id, '--by', 'codex', '--reason', '用户在 AIROOM 里中止了这次执行'], 60000);
      say(sessionId, '已按你的要求中止。');
      return 'cancelled';
    }

    const task = await readTask(id);
    if (!task) continue;

    if (task.status !== lastStatus) {
      lastStatus = task.status;
      const label = STATUS_CN[task.status] || task.status;
      rounds = Math.max(rounds, Number(task.attempt || 0));
      toolCall(sessionId, 'task-' + id, 'WorkBuddy · ' + label + '（第 ' + (task.attempt || 0) + ' 次尝试）',
               task.status === 'approved' ? 'completed' : 'in_progress', 'other');
      if (task.status === 'rejected') {
        const rev = readFileIfExists(path.join(BRIDGE_DIR, 'reviews', id + '.md'));
        const tail = rev.split('\n').filter(Boolean).slice(-6).join('\n');
        say(sessionId, '审核打回了，WorkBuddy 会看到这些意见并重做：\n' + tail + '\n');
      }
      logToStderr('任务 ' + id + ' -> ' + task.status);
    }

    if (task.status === 'approved') {
      const body = readFileIfExists(path.join(BRIDGE_DIR, 'results', id + '.md'));
      say(sessionId, '✅ 完成，共尝试 ' + (task.attempt || 0) + ' 次。\n\n' + body);
      return 'end_turn';
    }
    if (task.status === 'blocked') {
      const rev = readFileIfExists(path.join(BRIDGE_DIR, 'reviews', id + '.md'));
      say(sessionId, '⛔ 任务卡住了，需要人工处理。\n\n' + rev.slice(-1500));
      return 'end_turn';
    }
    if (task.status === 'cancelled') {
      say(sessionId, '任务已被取消。');
      return 'end_turn';
    }
  }

  const mins = Math.max(1, Math.round(TIMEOUT_MS / 60000));
  say(sessionId, '等了太久（超过 ' + mins + ' 分钟）还没完成，先不等了。\n'
    + '任务号 ' + id + '，你可以稍后在协作台里看它。');
  return 'end_turn';
}

/* ---------------------------------------------------------------- 请求分发 */

async function handle(msg) {
  const id = msg && msg.id;
  const method = msg && msg.method;
  const params = (msg && msg.params) || {};

  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: 1,           // AIROOM 写死了只认 1
      agentCapabilities: { loadSession: false },
      sessionCapabilities: {},
      authMethods: [],
    });
  }

  if (method === 'session/new') {
    const sessionId = 'wb-' + randomUUID().slice(0, 8);
    sessions.set(sessionId, { cwd: params.cwd || process.cwd() });
    return reply(id, { sessionId });
  }

  if (method === 'session/prompt') {
    const sessionId = params.sessionId;
    const context = sessions.get(sessionId) || { cwd: process.cwd() };
    const text = promptText(params.prompt);
    if (!text.trim()) { say(sessionId, '收到的是空任务。'); return reply(id, { stopReason: 'end_turn' }); }
    const stopReason = await runTask(sessionId, context.cwd, text);
    return reply(id, { stopReason });
  }

  if (method === 'session/cancel') { cancelled.add(params.sessionId); return; }
  if (method === 'session/close') { return reply(id, {}); }

  if (id !== undefined) return fail(id, -32601, '不支持的方法：' + method);
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { logToStderr('收到非法 JSON 帧'); continue; }
    Promise.resolve(handle(msg)).catch((error) => {
      logToStderr('处理出错：' + (error && error.stack || error));
      if (msg && msg.id !== undefined) fail(msg.id, -32603, String(error && error.message || error));
    });
  }
});
process.stdin.on('end', () => process.exit(0));

logToStderr('已启动。bridge=' + BRIDGE_DIR + '  对话=' + CONV);
