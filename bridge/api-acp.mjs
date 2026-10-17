#!/usr/bin/env node
/**
 * api-acp.mjs — 把「OpenAI 兼容 API」变成 AIROOM 里一个能真正干活的成员（v2 带全套工具）
 *
 * 设计目标：让中转站上的任意模型，在 AIROOM 里具备接近命令行 AI 助手的动手能力 ——
 * 读文件、精确改文件、按模式找文件、搜内容、跑命令、抓网页、看图。
 *
 * 在 AIROOM 里注册（设置与连接 → 添加连接）：
 *   程序路径：本文件的完整路径，例如 C:\...\bridge\api-acp.mjs
 *   启动参数：（留空）
 *   环境变量：每行一个 名称=值
 *
 *   API_BASE=https://your-relay.example/v1   必填  服务地址（到 /v1 为止）
 *   API_KEY=sk-xxxx                    必填  含 KEY 会被 AIROOM 自动加密保存
 *   API_MODEL=your-model-id            必填  模型 ID
 *   API_STYLE=chat                     可选  chat（默认，支持工具）| responses | anthropic
 *   API_SYSTEM=...                     可选  自定义系统提示词（默认用内置的工程助手提示词）
 *   API_MAX_TOKENS / API_TEMPERATURE / API_TIMEOUT_MS   可选
 *
 *   API_TOOLS=1                        可选  默认开；0 = 纯聊天
 *   API_TOOL_SCOPE=workspace           可选  默认只能在会话工作目录里动；any = 放开全盘
 *   API_CMD_TIMEOUT_MS=120000          可选  单条命令超时
 *   API_MAX_STEPS=30                   可选  一次最多来回几步工具调用
 *   API_HISTORY_CHARS=120000           可选  会话历史保留的字符预算，超了从最旧的开始丢
 *
 * stdout 只放 JSON-RPC 帧，日志一律走 stderr。
 */

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * AIROOM 把带 KEY/TOKEN 的环境变量加密保存，只有它自己解密后再传给进程。
 * 万一那条链路没走通（进程里拿不到 API_KEY），这里留一条本地兜底：
 * 在本文件旁边放一个 api-keys.json，按服务地址填 key，例如
 *   { "https://relay-a.example/v1": "sk-xxxx", "https://relay-b.example/v1": "sk-yyyy" }
 * 也支持直接写 {"key":"sk-..."} 或一个纯字符串。
 */
function readKeyFile(base) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const files = [process.env.API_KEY_FILE, path.join(here, 'api-keys.json')].filter(Boolean);
  for (const file of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (typeof raw === 'string' && raw.trim()) return raw.trim();
      if (raw && typeof raw === 'object') {
        const bare = String(base || '').replace(/\/v1$/, '');
        for (const [k, v] of Object.entries(raw)) {
          if (typeof v !== 'string' || !v.trim()) continue;
          if (k === 'key') return v.trim();
          const norm = k.replace(/\/+$/, '').replace(/\/v1$/, '');
          if (norm && (norm === bare || base.startsWith(norm) || norm.startsWith(bare))) return v.trim();
        }
      }
    } catch {}
  }
  return '';
}

const cfgBase = (process.env.API_BASE || '').replace(/\/+$/, '');
const CFG = {
  base: cfgBase,
  key: process.env.API_KEY || readKeyFile(cfgBase) || '',
  model: process.env.API_MODEL || '',
  style: (process.env.API_STYLE || 'chat').toLowerCase(),
  system: process.env.API_SYSTEM || '',
  maxTokens: Number(process.env.API_MAX_TOKENS || 0) || undefined,
  temperature: (process.env.API_TEMPERATURE === undefined || process.env.API_TEMPERATURE === '')
    ? undefined : Number(process.env.API_TEMPERATURE),
  timeoutMs: Number(process.env.API_TIMEOUT_MS || 600000),
  tools: (process.env.API_TOOLS || '1') !== '0',
  // 默认全盘：AIROOM 里 Codex / Claude / DSH 这些内置成员本来就是 fileScope:"any"。
  // 想收窄成「只能在自己的工作目录里动」，设 API_TOOL_SCOPE=workspace。
  scope: (process.env.API_TOOL_SCOPE || 'any').toLowerCase(),
  cmdTimeoutMs: Number(process.env.API_CMD_TIMEOUT_MS || 120000),
  maxSteps: Number(process.env.API_MAX_STEPS || 30),
  historyChars: Number(process.env.API_HISTORY_CHARS || 120000),
};

/** 房间里要不要显示思考流：默认不显示（否则会卡死），设 API_ROOM_THINKING=1 打开。 */
const SHOW_ROOM_THINKING = (process.env.API_ROOM_THINKING || '0') === '1';

const DEFAULT_SYSTEM = [
  '你是运行在 AIROOM 工作台里的工程助手，可以读写文件、搜索、执行命令来真正完成任务。',
  '工作方式：',
  '1. 先了解现状再动手：用 list_dir / glob / grep / read_file 看清楚再改。',
  '2. 改文件优先用 edit_file 做精确替换，不要整文件重写 —— 重写又贵又容易弄坏文件。',
  '3. 改完要验证：能跑的命令就跑一遍（例如跑测试、语法检查），把真实输出贴出来。',
  '4. 不确定就说不确定；没验证过的结论要标明"未验证"，不要编造。',
  '5. 用用户的语言回答；给结论时先说结果，再说关键依据。',
  '6. 需要画图/出插画/做角色三视图时，直接用 generate_image 工具（它会真的调用生图接口，存成 png 文件并返回路径）；不要用 run_command 去调脚本绕开。',
  '7. 看图片用 read_file（会直接把画面给你看）；看视频也用 read_file（会自动抽帧）。',
].join('\n');

const OUTPUT_CAP = 30000;
const READ_CAP = 400000;

function log(text) {
  try { process.stderr.write('[api-acp] ' + text + '\n'); } catch {}
}

/* ---------------- 插件系统（未来扩展用） ----------------

   把 .mjs 文件丢进本文件旁边的 plugins\ 目录就会自动加载。每个插件长这样：

     export const title = '网页搜索';
     export const tools = [{
       name: 'web_search',
       description: '搜索网页',
       kind: 'fetch',                    // 决定 AIROOM 怎么判权限
       parameters: { type:'object', properties:{ query:{type:'string'} }, required:['query'] },
       async run(args, ctx) {            // ctx: { cwd, session, inside, cap, log, cfg }
         return '要回给模型的文字';
       },
     }];

   说明：
   - 工具名不能和内置的 10 个重名，重名会被忽略。
   - 插件里抛出的异常会被捕获成一行错误文本回给模型，不会把连接弄挂。
   - API_PLUGINS=0 可以整体关掉。
------------------------------------------------------------- */

const PLUGIN_DIR = process.env.API_PLUGIN_DIR
  || path.join(path.dirname(fileURLToPath(import.meta.url)), 'plugins');
const plugins = new Map();
const pluginToolDefs = [];
const pluginModules = [];

async function loadPlugins() {
  if ((process.env.API_PLUGINS || '1') === '0') { log('插件已按配置关闭'); return; }
  if (!fs.existsSync(PLUGIN_DIR)) { log('没有插件目录：' + PLUGIN_DIR); return; }
  let files = [];
  try { files = fs.readdirSync(PLUGIN_DIR).filter((x) => x.endsWith('.mjs')).sort(); } catch { return; }
  for (const file of files) {
    try {
      const mod = await import(pathToFileURL(path.join(PLUGIN_DIR, file)).href);
      pluginModules.push(mod);
      let added = 0;
      for (const tool of (mod.tools || [])) {
        if (!tool || !tool.name || typeof tool.run !== 'function') continue;
        if (BUILTIN_NAMES.has(tool.name) || plugins.has(tool.name)) { log('插件工具重名，已跳过：' + tool.name); continue; }
        plugins.set(tool.name, tool);
        pluginToolDefs.push({
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description || tool.name,
            parameters: tool.parameters || { type: 'object', properties: {} },
          },
        });
        added++;
      }
      log('已加载插件 ' + file + '（' + added + ' 个工具）');
    } catch (error) {
      log('插件 ' + file + ' 加载失败：' + String((error && error.message) || error));
    }
  }
}

/* ---------------- 会话持久化 ----------------
 * AIROOM 恢复旧话题时会调 session/load（或 session/resume）。
 * 之前这里没实现，所以一开旧话题就报「程序不支持恢复会话」。
 * 现在每轮结束都把历史存到磁盘，恢复时读回来接着聊。
------------------------------------------------ */
const SESSION_DIR = process.env.API_SESSION_DIR
  || path.join(path.dirname(fileURLToPath(import.meta.url)), '.api-acp-sessions');

function sessionFile(id) {
  return path.join(SESSION_DIR, String(id).replace(/[^\w.-]/g, '_') + '.json');
}
function saveSessionToDisk(id, session) {
  try {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
    fs.writeFileSync(sessionFile(id), JSON.stringify({
      id,
      cwd: session.cwd,
      at: new Date().toISOString(),
      history: (session.history || []).slice(-400),
    }), 'utf8');
  } catch (error) {
    log('保存会话失败：' + String((error && error.message) || error));
  }
}
function loadSessionFromDisk(id) {
  try {
    const raw = JSON.parse(fs.readFileSync(sessionFile(id), 'utf8'));
    if (raw && Array.isArray(raw.history)) {
      return { history: raw.history, cwd: raw.cwd || process.cwd(), aborter: null };
    }
  } catch {}
  return null;
}

/** 诊断日志：记录每次会话是新建还是恢复，出问题时一眼看出上下文为什么断。 */
const LOG_FILE = process.env.API_DEBUG_LOG
  || path.join(path.dirname(fileURLToPath(import.meta.url)), 'api-acp.log');
function trace(where, detail) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, new Date().toISOString() + '  ' + where.padEnd(14) + detail + '\n');
  } catch {}
}

/* ---------------- ACP 传输层 ---------------- */

function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function fail(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }
function notify(method, params) { send({ jsonrpc: '2.0', method, params }); }

let agentRequestId = 1;
const awaiting = new Map();
function askClient(method, params) {
  const id = 'agent-' + (agentRequestId++);
  return new Promise((resolve) => { awaiting.set(id, resolve); send({ jsonrpc: '2.0', id, method, params }); });
}

let chunkCount = 0;
function chunk(sessionId, text) {
  if (!text) return;
  chunkCount++;
  notify('session/update', { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } });
}
function toolUpdate(sessionId, toolCallId, title, status, kind, rawInput) {
  // 带上真实参数，AIROOM 里能展开看到「它到底在执行什么」
  notify('session/update', { sessionId, update: { sessionUpdate: 'tool_call', toolCallId, title, kind: kind || 'other', status: status || 'in_progress', rawInput: rawInput || {} } });
}

/* ---------------- 提示词内容（含图片） ---------------- */

function promptParts(prompt) {
  const texts = [], images = [];
  const push = (part) => {
    if (typeof part === 'string') { texts.push(part); return; }
    if (!part || typeof part !== 'object') return;
    if (part.type === 'text' && part.text) { texts.push(part.text); return; }
    if (part.type === 'image' && part.data) {
      images.push({ mime: part.mimeType || 'image/png', data: part.data });
      return;
    }
    if (part.type === 'resource' && part.resource) {
      if (typeof part.resource.text === 'string') texts.push(part.resource.text);
      else if (part.resource.uri) texts.push('[附件] ' + part.resource.uri);
      return;
    }
    if (part.type === 'resource_link' && part.uri) { texts.push('[附件] ' + (part.name || part.uri)); return; }
    if (typeof part.text === 'string') texts.push(part.text);
  };
  if (Array.isArray(prompt)) prompt.forEach(push); else push(prompt);
  return { text: texts.filter(Boolean).join('\n'), images };
}

/* ---------------- 权限 ---------------- */

const KIND_OF = {
  read_file: 'read', list_dir: 'read', glob: 'search', grep: 'search', fetch_url: 'fetch', update_plan: 'think',
  write_file: 'edit', edit_file: 'edit', delete_file: 'edit', move_file: 'edit', run_command: 'execute',
};

async function requestPermission(sessionId, toolCallId, toolName, args, title) {
  const kind = KIND_OF[toolName] || (plugins.get(toolName) && plugins.get(toolName).kind) || 'other';
  const options = [
    { optionId: 'allow', name: '允许这一次', kind: 'allow_once' },
    { optionId: 'allow-always', name: '这个会话都允许', kind: 'allow_always' },
    { optionId: 'reject', name: '拒绝', kind: 'reject_once' },
  ];
  toolUpdate(sessionId, toolCallId, title, 'in_progress', kind, args);
  const answer = await askClient('session/request_permission', {
    sessionId, toolCall: { toolCallId, kind, title, rawInput: args }, options,
  });
  const outcome = answer && answer.result && answer.result.outcome;
  const picked = outcome && outcome.outcome === 'selected' ? outcome.optionId : undefined;
  return picked === 'allow' || picked === 'allow-always';
}

/* ---------------- 工具实现 ---------------- */

function inside(session, target) {
  if (CFG.scope === 'any') return true;
  const root = path.resolve(session.cwd || process.cwd());
  const full = path.resolve(root, target);
  const rel = path.relative(root, full);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

/**
 * 从模型输出里抠出第一个完整的 JSON 对象。
 * AIROOM 的房间 / 会议协议要求「只返回一个 JSON 对象，不要在对象外输出文字」，
 * 但模型经常先寒暄一句 —— 这里把 JSON 摘出来，保证 AIROOM 一定能解析。
 */
/**
 * 从模型输出里取 JSON。
 * 不能只取第一个花括号：模型常常先写一句带花括号的解释，或者把模板回显一遍再给答案，
 * 取错了对象会让 AIROOM 的「格式补正」校验判定语义被改动，直接把流程暂停。
 * 这里收集所有顶层对象，挑「能解析且最大」的那个。
 */
function extractJsonObject(text) {
  const source = String(text || '');
  const found = [];
  let inString = false, escaped = false, depth = 0, start = -1;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') { if (depth === 0) start = i; depth++; }
    else if (ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) { found.push(source.slice(start, i + 1)); start = -1; }
      if (depth < 0) depth = 0;
    }
  }
  let best = '', bestScore = -1;
  for (const candidate of found) {
    let score = -1;
    try { JSON.parse(candidate); score = candidate.length; } catch { score = -1; }
    if (score > bestScore) { bestScore = score; best = candidate; }
  }
  return best || found[0] || '';
}

function cap(text, limit) {
  const s = String(text == null ? '' : text);
  const n = limit || OUTPUT_CAP;
  return s.length > n ? s.slice(0, n) + '\n…（内容过长，已截断）' : s;
}

function withLineNumbers(text, offset) {
  const start = offset || 1;
  return text.split('\n').map((line, i) => String(start + i).padStart(5) + '| ' + line).join('\n');
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.venv', 'venv', '.cache']);

function walkFiles(root, out, depth) {
  if (out.length >= 4000 || depth > 8) return;
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (out.length >= 4000) return;
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(root, e.name);
    if (e.isDirectory()) walkFiles(full, out, depth + 1);
    else out.push(full);
  }
}

/** 极简 glob：支持 ** / * / ? ，够用且没有依赖。 */
function globToRegExp(pattern) {
  const norm = pattern.replace(/\\/g, '/');
  let re = '';
  for (let i = 0; i < norm.length; i++) {
    const c = norm[i];
    if (c === '*') {
      if (norm[i + 1] === '*') { re += '.*'; i++; if (norm[i + 1] === '/') i++; }
      else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if ('\\^$.|+()[]{}'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp('^' + re + '$', 'i');
}

/**
 * AIROOM 项目流程协议里有些字段是固定枚举，模型很容易自己编一个近义词
 * （比如把 disposition 写成 clarified / deferred），AIROOM 就会判「处理方式无效」并暂停流程。
 * 这里只检查最容易踩的那几个，发现问题就返回一句人话，交给上层要求模型重写。
 */
const FLOW_ENUMS = {
  'meetingResponses[].disposition': ['noted', 'answered', 'in-scope-fix', 'scope-change', 'needs-user'],
  'criteriaResults[].verdict': ['pass', 'changes_requested', 'inconclusive'],
};

/**
 * 从提示词里自动找出所有「字段：值1|值2|值3」形式的枚举约束。
 * 这样不用一个个硬编码 AIROOM 的字段 —— 题目里怎么写就怎么校验。
 */
function enumRulesFromPrompt(text) {
  const rules = {};
  const source = String(text || '');
  const re = /([A-Za-z_][A-Za-z0-9_]*)\s*[:：]\s*([a-z][a-z0-9-]*(?:\s*\|\s*[a-z][a-z0-9-]*)+)/g;
  let match;
  while ((match = re.exec(source))) {
    const key = match[1];
    const values = match[2].split('|').map((v) => v.trim()).filter(Boolean);
    if (values.length >= 2 && values.length <= 12) rules[key] = values;
  }
  return rules;
}

/** 按规则检查 JSON 里的枚举值，返回第一处问题（没有就是空串） */
function enumProblem(json, rules) {
  if (!rules || !Object.keys(rules).length) return '';
  let root;
  try { root = JSON.parse(json); } catch { return ''; }
  const bad = [];
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 8) return;
    if (Array.isArray(node)) { for (const item of node) walk(item, depth + 1); return; }
    for (const [key, value] of Object.entries(node)) {
      // kind / type / role / version 这类字段在不同层级含义不同
      // （顶层 kind 是 "integration-check"，findings 里的 kind 才是 verified|suspected|suggestion），
      // 套用同一条枚举规则会误判，所以直接跳过。
      const ambiguous = ['kind', 'type', 'role', 'version', 'protocol', 'mode', 'status'];
      if (typeof value === 'string' && rules[key] && !ambiguous.includes(key) && !rules[key].includes(value)) {
        bad.push(key + ' 写成了「' + value + '」，只能是 ' + rules[key].join(' | '));
      } else {
        walk(value, depth + 1);
      }
    }
  };
  walk(root, 0);
  return bad.length ? bad[0] : '';
}

function protocolProblem(json) {
  let payload;
  try {
    const parsed = JSON.parse(json);
    payload = parsed && parsed.payload ? parsed.payload : parsed;
  } catch { return ''; }
  if (!payload || typeof payload !== 'object') return '';

  if (Array.isArray(payload.meetingResponses)) {
    const ok = FLOW_ENUMS['meetingResponses[].disposition'];
    for (const item of payload.meetingResponses) {
      const value = String((item && item.disposition) ?? '');
      if (!ok.includes(value)) {
        return 'meetingResponses 里 disposition 写成了「' + value + '」，只能是 ' + ok.join(' | ')
          + '。请按这里的取值重写完整 JSON（含义对应：回答=answered，只记录=noted，本轮顺手修=in-scope-fix，要改范围=scope-change，需要用户定=needs-user）。';
      }
    }
  }
  return '';
}

/** 能被视觉模型直接看的图片类型 */
const IMAGE_EXT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif',
};
const IMAGE_CAP = 8 * 1024 * 1024;

/** 视频：抽若干帧给模型看（"拆镜头"就靠这个）。大多数接口不接受视频本体。 */
const VIDEO_EXT = { '.mp4': 1, '.mov': 1, '.mkv': 1, '.webm': 1, '.avi': 1, '.m4v': 1, '.flv': 1 };
const VIDEO_FRAMES = Number(process.env.API_VIDEO_FRAMES || 8);
const VIDEO_WIDTH = Number(process.env.API_VIDEO_WIDTH || 720);

function findFfmpeg() {
  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) return process.env.FFMPEG_PATH;
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, exe);
    if (fs.existsSync(candidate)) return candidate;
  }
  const guesses = [
    path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links', exe),
    path.join(os.homedir(), '.workbuddy-ai', 'binaries', 'ffmpeg', exe),
    'C:\\ffmpeg\\bin\\' + exe,
  ];
  for (const guess of guesses) if (fs.existsSync(guess)) return guess;
  return '';
}

/** 用 ffmpeg 均匀抽帧，返回 [{label, data(base64 jpeg)}] */
async function extractVideoFrames(file) {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) throw new Error('没找到 ffmpeg，无法抽帧。装一个 ffmpeg 或设 FFMPEG_PATH。');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airoom-video-'));
  try {
    // 先拿时长
    let seconds = 0;
    try {
      const probe = execFileSync(ffmpeg.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1'), [
        '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file,
      ], { encoding: 'utf8', timeout: 30000 });
      seconds = Number(String(probe).trim()) || 0;
    } catch {}
    if (!seconds) seconds = 0;
    const count = Math.max(1, Math.min(VIDEO_FRAMES, 12));
    const stamps = [];
    for (let i = 0; i < count; i++) {
      const t = seconds ? (seconds * (i + 0.5)) / count : i * 5;
      stamps.push(t);
    }
    const frames = [];
    for (const t of stamps) {
      const out = path.join(dir, 'f' + frames.length + '.jpg');
      try {
        execFileSync(ffmpeg, [
          '-y', '-ss', String(Math.max(0, t)), '-i', file,
          '-frames:v', '1', '-vf', 'scale=' + VIDEO_WIDTH + ':-2', '-q:v', '4', out,
        ], { timeout: 60000, stdio: 'ignore' });
      } catch {}
      if (fs.existsSync(out) && fs.statSync(out).size > 0) {
        const mm = Math.floor(t / 60), ss = Math.floor(t % 60);
        frames.push({
          label: String(mm).padStart(2, '0') + ':' + String(ss).padStart(2, '0'),
          data: fs.readFileSync(out).toString('base64'),
        });
      }
    }
    return frames;
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

async function execTool(session, name, args) {
  const cwd = session.cwd || process.cwd();
  const rel = (p) => path.relative(cwd, p).replace(/\\/g, '/') || '.';

  if (name === 'read_file') {
    const full = path.resolve(cwd, String(args.path || ''));
    if (!inside(session, full)) return '[拒绝] 路径不在工作目录里。';
    if (!fs.existsSync(full)) return '[错误] 文件不存在：' + args.path;
    const stat = fs.statSync(full);
    if (stat.isDirectory()) return '[错误] 那是目录，用 list_dir 或 glob。';
    const imageMime = IMAGE_EXT[path.extname(full).toLowerCase()];
    if (imageMime) {
      if (stat.size > IMAGE_CAP) return '[错误] 图片太大（' + Math.round(stat.size / 1024) + ' KB），上限 ' + Math.round(IMAGE_CAP / 1024) + ' KB。';
      // 交回 runTurn：把图片作为图像内容附上，让能看图的模型真的看到
      return '[IMAGE]' + JSON.stringify({ path: full, mime: imageMime, size: stat.size });
    }
    if (VIDEO_EXT[path.extname(full).toLowerCase()]) {
      return '[VIDEO]' + JSON.stringify({ path: full, size: stat.size });
    }
    if (stat.size > READ_CAP) return '[错误] 文件太大（' + stat.size + ' 字节）。用 offset/limit 分段读。';
    const all = fs.readFileSync(full, 'utf8').split('\n');
    const offset = Math.max(1, Number(args.offset || 1));
    const limit = Math.min(Number(args.limit || 800), 2000);
    const slice = all.slice(offset - 1, offset - 1 + limit);
    return cap('共 ' + all.length + ' 行，下面是第 ' + offset + ' 行起：\n' + withLineNumbers(slice.join('\n'), offset));
  }

  if (name === 'write_file') {
    const full = path.resolve(cwd, String(args.path || ''));
    if (!inside(session, full)) return '[拒绝] 路径不在工作目录里。';
    fs.mkdirSync(path.dirname(full), { recursive: true });
    const content = String(args.content == null ? '' : args.content);
    fs.writeFileSync(full, content, 'utf8');
    return '[成功] 已写入 ' + rel(full) + '（' + content.split('\n').length + ' 行 / ' + Buffer.byteLength(content, 'utf8') + ' 字节）';
  }

  if (name === 'edit_file') {
    const full = path.resolve(cwd, String(args.path || ''));
    if (!inside(session, full)) return '[拒绝] 路径不在工作目录里。';
    if (!fs.existsSync(full)) return '[错误] 文件不存在：' + args.path;
    const oldText = String(args.old_string == null ? '' : args.old_string);
    const newText = String(args.new_string == null ? '' : args.new_string);
    if (!oldText) return '[错误] old_string 不能为空。要整文件覆盖请用 write_file。';
    const source = fs.readFileSync(full, 'utf8');
    const count = source.split(oldText).length - 1;
    if (count === 0) return '[错误] 在文件里找不到 old_string，请把原文（含缩进）复制准确。';
    if (count > 1 && !args.replace_all) return '[错误] old_string 出现了 ' + count + ' 次，不唯一。请给更长的上下文，或加 replace_all=true。';
    const next = args.replace_all ? source.split(oldText).join(newText) : source.replace(oldText, newText);
    fs.writeFileSync(full, next, 'utf8');
    return '[成功] 已修改 ' + rel(full) + '（替换 ' + (args.replace_all ? count : 1) + ' 处）';
  }

  if (name === 'delete_file') {
    const full = path.resolve(cwd, String(args.path || ''));
    if (!inside(session, full)) return '[拒绝] 路径不在工作目录里。';
    if (!fs.existsSync(full)) return '[错误] 不存在：' + args.path;
    const stat = fs.statSync(full);
    if (stat.isDirectory()) fs.rmSync(full, { recursive: true, force: true });
    else fs.unlinkSync(full);
    return '[成功] 已删除 ' + rel(full);
  }

  if (name === 'move_file') {
    const from = path.resolve(cwd, String(args.from || ''));
    const to = path.resolve(cwd, String(args.to || ''));
    if (!inside(session, from) || !inside(session, to)) return '[拒绝] 路径不在工作目录里。';
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
    return '[成功] ' + rel(from) + ' → ' + rel(to);
  }

  if (name === 'list_dir') {
    const full = path.resolve(cwd, String(args.path || '.'));
    if (!inside(session, full)) return '[拒绝] 路径不在工作目录里。';
    if (!fs.existsSync(full)) return '[错误] 目录不存在：' + (args.path || '.');
    const entries = fs.readdirSync(full, { withFileTypes: true });
    const lines = entries.slice(0, 500).map((e) => {
      let size = '';
      try { if (e.isFile()) size = ' ' + fs.statSync(path.join(full, e.name)).size + 'B'; } catch {}
      return (e.isDirectory() ? 'd ' : '  ') + e.name + size;
    });
    return cap(lines.join('\n') || '(空目录)');
  }

  if (name === 'glob') {
    const pattern = String(args.pattern || '');
    if (!pattern) return '[错误] 要给 pattern，例如 **/*.ts。';
    const root = path.resolve(cwd, String(args.path || '.'));
    if (!inside(session, root)) return '[拒绝] 路径不在工作目录里。';
    const all = [];
    walkFiles(root, all, 0);
    const re = globToRegExp(pattern);
    const hits = all.map((f) => rel(f)).filter((r) => re.test(r) || re.test(path.basename(r)));
    return cap(hits.slice(0, 300).join('\n') || '(没匹配到文件)');
  }

  if (name === 'grep') {
    const target = path.resolve(cwd, String(args.path || '.'));
    if (!inside(session, target)) return '[拒绝] 路径不在工作目录里。';
    const needle = String(args.pattern || '');
    if (!needle) return '[错误] 要给 pattern。';
    let re = null;
    try { re = new RegExp(needle); } catch {}
    const files = [];
    if (fs.existsSync(target) && fs.statSync(target).isFile()) files.push(target);
    else walkFiles(target, files, 0);
    const hits = [];
    for (const file of files) {
      if (hits.length >= 150) break;
      try {
        if (fs.statSync(file).size > READ_CAP) continue;
        const text = fs.readFileSync(file, 'utf8');
        if (!re && !text.includes(needle)) continue;
        text.split('\n').forEach((line, i) => {
          if (hits.length >= 150) return;
          const ok = re ? re.test(line) : line.includes(needle);
          if (ok) hits.push(rel(file) + ':' + (i + 1) + ': ' + line.trim().slice(0, 180));
        });
      } catch {}
    }
    return cap(hits.join('\n') || '(没找到)');
  }

  if (name === 'run_command') {
    const command = String(args.command || '');
    if (!command.trim()) return '[错误] 要给 command。';
    const timeout = Math.min(Number(args.timeout_ms || CFG.cmdTimeoutMs), 10 * 60 * 1000);
    return await new Promise((resolve) => {
      const child = spawn(command, { cwd, shell: true, windowsHide: true });
      let out = '';
      const timer = setTimeout(() => {
        try { child.kill(); } catch {}
        resolve(cap(out + '\n[超时] 命令超过 ' + timeout + 'ms 被中止'));
      }, timeout);
      child.stdout.on('data', (d) => { out += d.toString('utf8'); });
      child.stderr.on('data', (d) => { out += d.toString('utf8'); });
      child.on('close', (code) => { clearTimeout(timer); resolve(cap('[退出码 ' + code + ']\n' + out)); });
      child.on('error', (e) => { clearTimeout(timer); resolve('[错误] ' + String(e)); });
    });
  }

  if (name === 'update_plan') {
    const steps = Array.isArray(args.steps) ? args.steps : [];
    notify('session/update', {
      sessionId: session.currentSessionId,
      update: {
        sessionUpdate: 'plan',
        entries: steps.map((s) => ({ content: String(s.content || ''), status: ['pending', 'in_progress', 'completed'].includes(s.status) ? s.status : 'pending', priority: 'medium' })),
      },
    });
    return '[成功] 计划已同步（' + steps.length + ' 步）';
  }

  if (name === 'fetch_url') {
    const url = String(args.url || '');
    if (!/^https?:\/\//i.test(url)) return '[错误] 只支持 http/https 地址。';
    try {
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30000) });
      const type = res.headers.get('content-type') || '';
      const body = await res.text();
      const text = type.includes('html')
        ? body.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
              .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
              .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n')
        : body;
      return cap('[HTTP ' + res.status + ']\n' + text);
    } catch (error) {
      return '[错误] 抓取失败：' + String((error && error.message) || error);
    }
  }

  const plugin = plugins.get(name);
  if (plugin) {
    const result = await plugin.run(args, {
      cwd, session, inside: (t) => inside(session, t), cap, log, cfg: CFG, fs, path,
    });
    return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  }

  return '[错误] 不认识这个工具：' + name;
}

/* ---------------- 工具声明 ---------------- */

const str = (d) => ({ type: 'string', description: d });

const BUILTIN_NAMES = new Set([
  'read_file', 'write_file', 'edit_file', 'delete_file', 'move_file',
  'list_dir', 'glob', 'grep', 'run_command', 'fetch_url', 'update_plan',
]);

const TOOL_DEFS = [
  { type: 'function', function: { name: 'read_file', description: '读文件（带行号）；读图片（png/jpg/jpeg/webp/gif）时会直接把图片给你看。大文件用 offset/limit 分段读。', parameters: { type: 'object', properties: { path: str('相对工作目录的路径'), offset: { type: 'number', description: '起始行，从 1 开始' }, limit: { type: 'number', description: '最多读多少行，默认 800' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'write_file', description: '整文件写入（会覆盖原内容，自动建目录）。只适合新建文件或整体重写；改几行请用 edit_file。', parameters: { type: 'object', properties: { path: str('路径'), content: str('完整内容') }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'edit_file', description: '精确替换：把文件里的 old_string 换成 new_string。old_string 必须和原文完全一致（含缩进），且在文件里唯一。这是改代码的首选方式。', parameters: { type: 'object', properties: { path: str('路径'), old_string: str('要被替换的原文片段'), new_string: str('替换成什么；空字符串表示删除这段'), replace_all: { type: 'boolean', description: '是否替换所有出现' } }, required: ['path', 'old_string', 'new_string'] } } },
  { type: 'function', function: { name: 'delete_file', description: '删除文件或目录', parameters: { type: 'object', properties: { path: str('路径') }, required: ['path'] } } },
  { type: 'function', function: { name: 'move_file', description: '移动或重命名', parameters: { type: 'object', properties: { from: str('原路径'), to: str('新路径') }, required: ['from', 'to'] } } },
  { type: 'function', function: { name: 'list_dir', description: '列出目录内容', parameters: { type: 'object', properties: { path: str('目录，默认当前目录') }, required: [] } } },
  { type: 'function', function: { name: 'glob', description: '按文件名模式找文件，例如 **/*.ts、src/**/*.py', parameters: { type: 'object', properties: { pattern: str('glob 模式'), path: str('在哪个目录下找，默认工作目录') }, required: ['pattern'] } } },
  { type: 'function', function: { name: 'grep', description: '按内容搜索文本，返回 文件:行号: 内容', parameters: { type: 'object', properties: { pattern: str('要搜的文本，也可以是正则'), path: str('在哪个目录下搜') }, required: ['pattern'] } } },
  { type: 'function', function: { name: 'run_command', description: '在工作目录里执行一条命令并返回输出（Windows 上是 cmd 语法）', parameters: { type: 'object', properties: { command: str('要执行的命令'), timeout_ms: { type: 'number', description: '超时毫秒' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'fetch_url', description: '抓取一个网页或接口，返回纯文本', parameters: { type: 'object', properties: { url: str('http/https 地址') }, required: ['url'] } } },
  { type: 'function', function: { name: 'update_plan', description: '把当前的任务计划同步给用户（AIROOM 会显示成清单）。多步任务开始前先列一遍，每完成一步再更新一次。', parameters: { type: 'object', properties: { steps: { type: 'array', description: '步骤列表', items: { type: 'object', properties: { content: str('这一步做什么'), status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] } }, required: ['content', 'status'] } } }, required: ['steps'] } } },
];

/* ---------------- 调用模型 ---------------- */

// chat 和 responses 都支持工具（responses 用的是 type:function 那套形状，
// 由 toResponsesTools 转换；实测 Codex 本机代理会正常返回 function_call）。
const useTools = () => CFG.tools && (CFG.style === 'chat' || CFG.style === 'responses');

/**
 * 系统提示词。
 * structured=true 时（AIROOM 的房间/会议协议）**不注入任何自己的设定** ——
 * 那个协议要求只回一个 JSON 对象，多一句角色设定都会让模型先唠两句，导致解析失败。
 */
function systemText(structured) {
  if (structured) {
    // 房间里不能加长系统提示（会把模型带偏去说话），但可以给一条格式纪律。
    const discipline = [
      '你正在用 AIROOM 的协议回复：',
      '0. 需要的话可以先用工具读材料、查资料；但最后一条回复必须只是那个 JSON，不能有任何别的文字。',
      '1. 只输出一个 JSON 对象，不要解释、不要 markdown 代码块围栏。',
      '2. 若这是对上一次回复的「格式修正」，必须保持所有语义字段与上一次完全一致',
      '   （含 verified / resolved / verdict / rating / reason / evidence / severity / kind / disposition 等），只修格式。',
      '3. 格式修正时 criteriaResults 必须与上一次逐条一一对应：不许新增条目、不许删除条目、',
      '   不许给原本没有的条目填 verified 或 evidence、不许新增 findings。只改括号/引号/逗号这类语法问题。',
      '4. 报告 evidence 时若要引用命令，必须逐字复制你实际执行时传给 run_command 的 command 字符串',
      '   （包括 cd、&&、引号、参数顺序、空格，一个字符都不能改）；不要改写、不要补全、不要换写法、',
      '   不要把相对路径改成绝对路径。程序按命令原文匹配执行记录，改了就判「命令缺少实际完成记录」。',
      '   拿不准就把命令原样贴回来，或干脆不写命令、只写文件与行号作为依据。',
      '5. 固定枚举只能用题目里列出的值，不要自己编近义词：',
      '   disposition 只能是 noted / answered / in-scope-fix / scope-change / needs-user。',
      '5. 不要回显题目里给的模板。',
      '6. 输出尽量紧凑：不要复述材料原文、不要重复题目里的要求、不要逐条抄文件内容。',
      '   说明性文字控制在一两句；这个中转站很慢，回复越长越容易被它自己判超时。',
      '   summary / report / reason 写关键结论即可，evidence 只留最有代表性的一两条。',
    ].join('\n');
    return CFG.system ? CFG.system + '\n\n' + discipline : discipline;
  }
  const extra = [];
  for (const mod of pluginModules) {
    try { const text = typeof mod.systemExtra === 'function' ? mod.systemExtra() : ''; if (text) extra.push(text); } catch {}
  }
  return (CFG.system || DEFAULT_SYSTEM) + (extra.length ? '\n\n' + extra.join('\n\n') : '');
}

/** chat 消息 → Responses API 的 input 项 */
function toResponsesInput(messages) {
  const items = [];
  for (const m of messages) {
    if (m.role === 'user') {
      if (typeof m.content === 'string') items.push({ role: 'user', content: [{ type: 'input_text', text: m.content }] });
      else items.push({ role: 'user', content: (m.content || []).map((p) => (p.type === 'image_url'
        ? { type: 'input_image', image_url: p.image_url && p.image_url.url }
        : { type: 'input_text', text: String(p.text || '') })) });
    } else if (m.role === 'assistant') {
      if (m.tool_calls) for (const tc of m.tool_calls) items.push({ type: 'function_call', call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments || '{}' });
      if (m.content) items.push({ role: 'assistant', content: [{ type: 'output_text', text: String(m.content) }] });
    } else if (m.role === 'tool') {
      items.push({ type: 'function_call_output', call_id: m.tool_call_id, output: String(m.content) });
    }
  }
  return items;
}
function toResponsesTools(tools) {
  return (tools || []).map((t) => ({ type: 'function', name: t.function.name, description: t.function.description, parameters: t.function.parameters }));
}

function buildRequest(messages, withTools, tools, structured) {
  if (CFG.style === 'anthropic') {
    const body = {
      model: CFG.model, max_tokens: CFG.maxTokens || 8192, stream: true,
      messages: messages.filter((m) => m.role !== 'system' && m.role !== 'tool')
        .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
    };
    body.system = systemText(structured);
    if (CFG.temperature !== undefined) body.temperature = CFG.temperature;
    return { url: CFG.base + '/messages', headers: { 'content-type': 'application/json', 'x-api-key': CFG.key, 'anthropic-version': '2023-06-01' }, body };
  }
  if (CFG.style === 'responses') {
    // Responses API：input 是「项」数组，不是 chat 的 messages；工具形状也不一样。
    // 用非流式（stream:false）—— 本机代理这条路一次要 100 秒，流式事件格式还得另写解析。
    const body = { model: CFG.model, input: toResponsesInput(messages), stream: false, store: false };
    const instructions = systemText(structured);
    if (instructions) body.instructions = instructions;
    if (withTools) { body.tools = toResponsesTools(tools || TOOL_DEFS); body.tool_choice = 'auto'; }
    if (CFG.maxTokens) body.max_output_tokens = CFG.maxTokens;
    if (CFG.temperature !== undefined) body.temperature = CFG.temperature;
    return { url: CFG.base + '/responses', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (CFG.key || 'PROXY_MANAGED') }, body };
  }
  const system = systemText(structured);
  const msgs = (system ? [{ role: 'system', content: system }] : []).concat(messages);
  const body = { model: CFG.model, messages: msgs, stream: true };
  if (withTools) { body.tools = tools || TOOL_DEFS; body.tool_choice = 'auto'; }
  if (CFG.maxTokens) body.max_tokens = CFG.maxTokens;
  if (CFG.temperature !== undefined) body.temperature = CFG.temperature;
  return { url: CFG.base + '/chat/completions', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + CFG.key }, body };
}

function textOfDelta(payload) {
  const c = payload.choices && payload.choices[0];
  if (!c) return '';
  if (c.delta && typeof c.delta.content === 'string') return c.delta.content;
  if (c.message && typeof c.message.content === 'string') return c.message.content;
  return '';
}
/** 很多中转模型（DeepSeek / GLM 系）把思维链放在 reasoning_content 里。 */
function reasonOfDelta(payload) {
  const c = payload.choices && payload.choices[0];
  if (!c || !c.delta) return '';
  return c.delta.reasoning_content || c.delta.reasoning || '';
}
function textOfFull(payload) {
  const c = payload.choices && payload.choices[0];
  return (c && (c.message ? c.message.content : c.text)) || payload.output_text || '';
}

/**
 * 中转站经常抖（503 / 429 / 连接重置）。以前一次失败就等于这一轮废掉，
 * 而 AIROOM 会把它当成"回复格式不对"，进而要求格式补正、补正不成再暂停流程。
 * 这里加自动重试：只在「还没吐出任何正文」时重试，避免把内容发两遍。
 */
async function callModel(sessionId, messages, signal, silent, structured, keepTools) {
  // 中转站上游偶发 503：多给几次机会、退避拉长到 30 秒
  const attempts = Math.max(1, Math.min(Number(process.env.API_RETRIES || 5), 8));
  let last;
  for (let i = 0; i < attempts; i++) {
    if (signal && signal.aborted) throw new Error('这个任务已经被中止了。');
    const before = chunkCount;
    try {
      return await callModelOnce(sessionId, messages, signal, silent, structured, keepTools);
    } catch (error) {
      last = error;
      const aborted = error && error.name === 'AbortError';
      // 用户中止不重试；已经输出过内容也不重试（否则界面会出现两份）
      if (aborted || (!silent && chunkCount !== before)) throw error;
      if (i === attempts - 1) throw error;
      const wait = Math.min(3000 * Math.pow(2, i), 30000);
      log('调用失败，' + Math.round(wait / 1000) + ' 秒后重试（第 ' + (i + 1) + '/' + (attempts - 1) + ' 次）：'
        + String((error && error.message) || error).slice(0, 160));
      if (!silent) chunk(sessionId, '（上游接口暂时不可用，' + Math.round(wait / 1000) + ' 秒后自动重试…）');
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  throw last;
}

async function callModelOnce(sessionId, messages, signal, silent, structured, keepTools) {
  const tools = TOOL_DEFS.concat(pluginToolDefs);
  // 圆桌/会议那种纯发言不给工具（否则正文就不是干净 JSON）；
  // 项目流程要读材料，工具保留，只在最后把 JSON 摘出来。
  const request = buildRequest(messages, useTools() && (!structured || keepTools), tools, structured);
  // 接上真正的超时：以前 CFG.timeoutMs 声明了却没生效，中转站挂起时进程会一直挂着。
  // 慢站（首字 30 秒、总耗时 90 秒）也能过，默认 10 分钟。
  // 请求头只能是 Latin-1。API_KEY 里混进「←」「留空」这类字符时，
  // fetch 会抛 "Cannot convert argument to a ByteString..."，非常难懂，
  // 这里提前检查并给出能直接照做的提示。
  for (const [name, value] of Object.entries(request.headers || {})) {
    const bad = String(value).match(/[^\x00-\xFF]/);
    if (!bad) continue;
    const hint = name === 'authorization'
      ? 'API_KEY 里混进了非法字符（常见是复制说明文字时带进来的「←」「留空」或中文）。请到连接的环境变量里把 API_KEY 那一行整行删掉，重新只填 sk- 开头的密钥。'
      : '请求头 ' + name + ' 含有非法字符：' + bad[0] + '（U+' + bad[0].codePointAt(0).toString(16) + '）';
    throw new Error(hint);
  }

  const timeout = AbortSignal.timeout(CFG.timeoutMs);
  const combined = signal && AbortSignal.any ? AbortSignal.any([signal, timeout]) : timeout;

  // responses 是非流式的：从发出请求到拿到结果之间可能一两个字都没有
  // （本机代理实测 52~125 秒），而 AIROOM 的房间看门狗 90 秒没输出就判超时。
  // 这里每 20 秒发一条「思考中」心跳，让看门狗看到进度，不至于把正常的长任务杀掉。
  let heartbeat = null;
  if (CFG.style === 'responses' && !silent) {
    const startedAt = Date.now();
    heartbeat = setInterval(() => {
      const waited = Math.round((Date.now() - startedAt) / 1000);
      try {
        notify('session/update', {
          sessionId,
          update: {
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: '（模型还在生成，已等待 ' + waited + ' 秒…）' },
          },
        });
      } catch {}
    }, 20000);
    if (heartbeat.unref) heartbeat.unref();
  }

  let response;
  try {
    response = await fetch(request.url, { method: 'POST', headers: request.headers, body: JSON.stringify(request.body), signal: combined });
  } finally {
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const hint = CFG.style === 'chat' ? ''
      : '\n（这个中转站可能不支持 ' + CFG.style + ' 接口。把 API_STYLE 改成 chat 通常就能用；chat 也是唯一支持工具的风格。）';
    throw new Error('HTTP ' + response.status + ' ' + response.statusText + ' ' + detail.slice(0, 400) + hint);
  }
  // Responses API（Codex 本机代理那条路）：非流式，结果是 output[] 项数组
  if (CFG.style === 'responses') {
    const payload = await response.json();
    if (payload && payload.error) throw new Error(payload.error.message || JSON.stringify(payload.error));
    let text = '';
    const calls = [];
    for (const item of payload.output || []) {
      if (item.type === 'message') {
        for (const part of item.content || []) {
          if (part.type === 'output_text' || part.type === 'text') text += part.text || '';
        }
      } else if (item.type === 'function_call') {
        calls.push({ id: item.call_id || item.id, type: 'function',
          function: { name: item.name, arguments: item.arguments || '{}' } });
      }
    }
    if (!text && payload.status === 'incomplete') throw new Error('模型输出被截断（status=incomplete），可能是输出上限或超时。');
    if (!silent) chunk(sessionId, text);
    return { text, toolCalls: calls };
  }

  const isStream = (response.headers.get('content-type') || '').includes('event-stream') && response.body;
  if (!isStream) {
    const payload = await response.json();
    const text = textOfFull(payload);
    if (!silent) chunk(sessionId, text);
    return { text, toolCalls: [] };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', text = '';
  const calls = new Map();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line || line.startsWith(':') || line.startsWith('event:')) continue;
      if (!line.startsWith('data:')) continue;
      const raw = line.slice(5).trim();
      if (!raw || raw === '[DONE]') continue;
      let payload;
      try { payload = JSON.parse(raw); } catch { continue; }
      if (payload.error) throw new Error(payload.error.message || JSON.stringify(payload.error));
      const trace = reasonOfDelta(payload);
      // 思考流默认只在私聊/工位转发。
      // 房间/会议（结构化协议）下默认不转发：AIROOM 的看门狗把 reasoning 也算成
      // 「有新输出」（engine.ts:6529-6538），转发它会让爱长考的模型永远不超时 ——
      // 界面就一直卡在「正在思考」。
      // 想在房间里也看到，设 API_ROOM_THINKING=1（代价是可能卡住不超时）。
      if (trace && (!silent || SHOW_ROOM_THINKING)) {
        notify('session/update', { sessionId, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: trace } } });
      }
      const piece = textOfDelta(payload);
      if (piece) { text += piece; if (!silent) chunk(sessionId, piece); }
      const deltas = (payload.choices && payload.choices[0] && payload.choices[0].delta && payload.choices[0].delta.tool_calls) || [];
      for (const d of deltas) {
        const i = d.index == null ? 0 : d.index;
        const cur = calls.get(i) || { id: '', name: '', args: '' };
        if (d.id) cur.id = d.id;
        if (d.function && d.function.name) cur.name = d.function.name;
        if (d.function && typeof d.function.arguments === 'string') cur.args += d.function.arguments;
        calls.set(i, cur);
      }
    }
  }
  const toolCalls = [...calls.values()].filter((c) => c.name).map((c) => ({
    id: c.id || ('call_' + Math.random().toString(36).slice(2, 8)),
    type: 'function',
    function: { name: c.name, arguments: c.args || '{}' },
  }));
  return { text, toolCalls };
}

/* ---------------- 一次对话 ---------------- */

/** 把一段旧对话交给模型压成摘要（不显示在聊天里）。 */
async function summarize(oldMessages, signal) {
  const digest = oldMessages.map((m) => {
    const role = m.role === 'assistant' ? '助手' : m.role === 'tool' ? '工具结果' : '用户';
    return role + '：' + String(m.content || '').slice(0, 3000);
  }).join('\n\n');
  const request = buildRequest([{
    role: 'user',
    content: '把下面这段对话压缩成要点摘要。必须保留：做过的决定、动过哪些文件、还没做完的事、关键结论与数字。'
      + '不要寒暄、不要复述过程，直接给摘要。\n\n' + digest,
  }], false, [], true);
  const response = await fetch(request.url, {
    method: 'POST', headers: request.headers, body: JSON.stringify(request.body), signal,
  });
  if (!response.ok) throw new Error('HTTP ' + response.status);
  const type = response.headers.get('content-type') || '';
  if (!type.includes('event-stream') || !response.body) return textOfFull(await response.json());
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', out = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line.startsWith('data:')) continue;
      const raw = line.slice(5).trim();
      if (!raw || raw === '[DONE]') continue;
      let payload; try { payload = JSON.parse(raw); } catch { continue; }
      out += textOfDelta(payload) || '';
    }
  }
  return out;
}

/** 超预算时压缩历史：优先用摘要，摘要失败才退回截断。 */
async function compactHistory(sessionId, messages, signal) {
  const size = () => messages.reduce((sum, m) => sum + String(m.content || '').length + 200, 0);
  if (size() <= CFG.historyChars) return false;

  // 第一条用户消息就是任务本体（AIROOM 的协议要求、"只返回 JSON：{...}"那些），
  // 任何情况下都不能压掉 —— 压掉就会出现"当前消息未包含具体任务"这种失忆。
  const firstUser = messages.findIndex((m) => m.role === 'user');
  if (firstUser < 0) return false;
  const head = messages[firstUser];

  const keepTail = Number(process.env.API_COMPACT_KEEP || 8);
  const start = firstUser + 1;
  const end = Math.max(start, messages.length - keepTail);
  const old = messages.slice(start, end);
  if (!old.length) return false;

  let summary = '';
  if ((process.env.API_COMPACT || '1') !== '0') {
    try { summary = String(await summarize(old, signal)).trim(); } catch (error) {
      log('压缩失败，退回截断：' + String((error && error.message) || error));
    }
  }

  // 尾部不能以孤立的 tool 消息开头（它对应的 assistant.tool_calls 已经被压掉了，接口会报错）
  let tail = messages.slice(end);
  while (tail.length && tail[0].role === 'tool') tail = tail.slice(1);

  const middle = summary
    ? { role: 'user', content: '[早先对话的摘要]\n' + summary.slice(0, 8000) }
    : { role: 'user', content: '（中间 ' + old.length + ' 条工具往来因为太长已省略；任务本身在第一条消息里）' };

  messages.length = 0;
  messages.push(head);
  if (middle) messages.push(middle);
  for (const item of tail) messages.push(item);
  log('上下文已压缩：中间省略 ' + old.length + ' 条，摘要 ' + summary.length + ' 字，尾部保留 ' + tail.length + ' 条');
  return true;
}

function titleOf(toolName, args) {
  switch (toolName) {
    case 'run_command': return '执行命令：' + String(args.command || '').slice(0, 80);
    case 'write_file': return '写入文件：' + String(args.path || '');
    case 'edit_file': return '修改文件：' + String(args.path || '');
    case 'read_file': return '读取文件：' + String(args.path || '');
    case 'delete_file': return '删除：' + String(args.path || '');
    case 'move_file': return '移动：' + String(args.from || '') + ' → ' + String(args.to || '');
    case 'glob': return '找文件：' + String(args.pattern || '');
    case 'grep': return '搜索内容：' + String(args.pattern || '');
    case 'fetch_url': return '抓取网页：' + String(args.url || '').slice(0, 70);
    case 'list_dir': return '列出目录：' + String(args.path || '.');
    case 'update_plan': return '更新计划（' + (Array.isArray(args.steps) ? args.steps.length : 0) + ' 步）';
    default: return toolName;
  }
}

async function runTurn(sessionId, session, parts, structured, keepTools) {
  // 这一轮题目里声明了哪些枚举约束，用来核对模型的取值
  const ENUM_RULES = structured ? enumRulesFromPrompt(parts.text) : {};
  const userContent = parts.images.length
    ? [{ type: 'text', text: parts.text || '(见图片)' }].concat(
        parts.images.map((img) => ({ type: 'image_url', image_url: { url: 'data:' + img.mime + ';base64,' + img.data } })))
    : parts.text;

  const messages = session.history.concat([{ role: 'user', content: userContent }]);
  let answer = '';
  let corrections = 0;

  for (let step = 0; step < CFG.maxSteps; step++) {
    const controller = new AbortController();
    session.aborter = controller;
    try {
      if (await compactHistory(sessionId, messages, controller.signal)) {
        notify('session/update', { sessionId, update: { sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: '上下文太长，已把前面的对话压缩成摘要。' } } });
      }
    } catch {}
    const { text, toolCalls } = await callModel(sessionId, messages, controller.signal, structured, structured, keepTools);
    if (text) answer += text;
    if (!toolCalls.length) {
      // 结构化协议：必须拿到一个能解析的 JSON。拿不到就当场要求它重说，而不是把大白话丢给 AIROOM
      // —— 那会被判成「最后的正式 JSON 回复有语法错误」，进而让整个项目流程暂停。
      let protocolIssue = '';
      if (structured) {
        const json = extractJsonObject(answer);
        if (json) protocolIssue = protocolProblem(json) || enumProblem(json, ENUM_RULES);
      }
      if (structured && protocolIssue && corrections < 2) {
        corrections++;
        log('协议取值不合规，要求模型重写：' + protocolIssue.slice(0, 120));
        messages.push({ role: 'assistant', content: answer || '（空）' });
        messages.push({ role: 'user', content: protocolIssue });
        answer = '';
        continue;
      }
      if (structured && !extractJsonObject(answer)) {
        if (corrections < 2) {
          corrections++;
          log('结构化回复里没有 JSON，要求模型重说（第 ' + corrections + ' 次）');
          messages.push({ role: 'assistant', content: answer || '（空）' });
          messages.push({ role: 'user', content: '你上一条回复不是合法的单个 JSON 对象。请只输出那个 JSON 对象本身：不要解释、不要前后缀、不要 markdown 代码块围栏。' });
          answer = '';
          continue;
        }
      }
      messages.push({ role: 'assistant', content: answer });
      session.history = messages;
      return answer;
    }
    messages.push({ role: 'assistant', content: text || null, tool_calls: toolCalls });
    for (const call of toolCalls) {
      let args = {};
      try { args = JSON.parse(call.function.arguments || '{}'); } catch {}
      const toolName = call.function.name;
      const title = titleOf(toolName, args);
      const allowed = await requestPermission(sessionId, call.id, toolName, args, title);
      let output;
      if (!allowed) {
        output = '[被拒绝] 用户或权限设置不允许这次操作。';
        toolUpdate(sessionId, call.id, title + '（已拒绝）', 'failed', KIND_OF[toolName] || 'other', args);
      } else {
        try { output = await execTool(session, toolName, args); }
        catch (error) { output = '[错误] ' + String((error && error.message) || error); }
        toolUpdate(sessionId, call.id, title, 'completed', KIND_OF[toolName] || 'other', args);
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: String(output) });
      // read_file 读到图片时，把图片本身作为图像内容再发一条，视觉模型才看得到
      const videoMarker = String(output).match(/^\[VIDEO\](\{[\s\S]*\})$/);
      if (videoMarker) {
        try {
          const info = JSON.parse(videoMarker[1]);
          const frames = await extractVideoFrames(info.path);
          if (!frames.length) {
            messages.push({ role: 'user', content: '（视频抽帧失败，可能 ffmpeg 不可用或视频损坏；可以让用户挑几张截图发给你）' });
          } else {
            const parts = [{ type: 'text', text: '（这是视频 ' + path.basename(info.path) + ' 按时间均匀抽的 ' + frames.length + ' 帧，依次为：' + frames.map(x => x.label).join('、') + '。请据这些画面理解镜头和内容）' }];
            for (const frame of frames) parts.push({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + frame.data } });
            messages.push({ role: 'user', content: parts });
            toolUpdate(sessionId, call.id + '-vid', '已抽出 ' + frames.length + ' 帧给你看', 'completed', 'read', { path: info.path });
          }
        } catch (error) {
          messages.push({ role: 'user', content: '（视频处理失败：' + String((error && error.message) || error) + '）' });
        }
      }
      const marker = String(output).match(/^\[IMAGE\](\{[\s\S]*\})$/);
      if (marker) {
        try {
          const info = JSON.parse(marker[1]);
          const data = fs.readFileSync(info.path).toString('base64');
          messages.push({
            role: 'user',
            content: [
              { type: 'text', text: '（这是 ' + path.basename(info.path) + ' 的图片内容，请直接看图回答）' },
              { type: 'image_url', image_url: { url: 'data:' + info.mime + ';base64,' + data } },
            ],
          });
          toolUpdate(sessionId, call.id + '-img', '已把图片作为图像内容提供', 'completed', 'read', { path: info.path });
        } catch (error) {
          messages.push({ role: 'user', content: '（图片读取失败：' + String((error && error.message) || error) + '）' });
        }
      }
    }
  }
  session.history = messages;
  return answer + '\n（到达单次最多 ' + CFG.maxSteps + ' 步工具调用的上限，先停下。）';
}

/* ---------------- 请求分发 ---------------- */

const sessions = new Map();

async function handle(msg) {
  const id = msg && msg.id;
  const method = msg && msg.method;
  const params = (msg && msg.params) || {};

  if (method === 'initialize') {
    // loadSession / resume 都要声明，AIROOM 才会在重开话题时试着恢复
    trace('initialize', 'loadSession=true resume=true');
    return reply(id, {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
      sessionCapabilities: { resume: true },
      authMethods: [],
    });
  }

  if (method === 'session/new') {
    const sessionId = 'api-' + Math.random().toString(36).slice(2, 10);
    const fresh = { history: [], aborter: null, cwd: params.cwd || process.cwd(), currentSessionId: sessionId };
    sessions.set(sessionId, fresh);
    saveSessionToDisk(sessionId, fresh);
    trace('session/new', sessionId + '  cwd=' + fresh.cwd);
    log('新会话 ' + sessionId + '  模型=' + CFG.model + '  风格=' + CFG.style
      + '  工具=' + (useTools() ? '开' : '关') + '  cwd=' + (params.cwd || process.cwd()));
    return reply(id, { sessionId });
  }

  if (method === 'session/load' || method === 'session/resume') {
    const sessionId = String(params.sessionId || '');
    if (!sessionId) return fail(id, -32602, '缺少 sessionId');
    const restored = loadSessionFromDisk(sessionId)
      || { history: [], aborter: null, cwd: params.cwd || process.cwd() };
    restored.currentSessionId = sessionId;
    sessions.set(sessionId, restored);
    trace('session/' + (method === 'session/load' ? 'load' : 'resume'), sessionId + '  历史 ' + restored.history.length + ' 条');
    log('恢复会话 ' + sessionId + '：' + restored.history.length + ' 条历史，cwd=' + restored.cwd);
    return reply(id, { sessionId });
  }

  if (method === 'session/prompt') {
    const sessionId = params.sessionId;
    const session = sessions.get(sessionId) || { history: [], aborter: null, cwd: process.cwd() };
    session.currentSessionId = sessionId;
    sessions.set(sessionId, session);
    const parts = promptParts(params.prompt);
    const localProxy = /127\.0\.0\.1|localhost/.test(CFG.base);
    if (!CFG.base || (!CFG.key && !localProxy) || !CFG.model) {
      // 精确指出缺哪一项 —— 之前三个一起报，会让人误以为全没填。
      const missing = [];
      if (!CFG.base) missing.push('API_BASE（服务地址，例如 https://your-relay.example/v1）');
      if (!CFG.key) missing.push('API_KEY（API 密钥）');
      if (!CFG.model) missing.push('API_MODEL（模型 ID，例如 gpt-6.1-sol）');
      chunk(sessionId, '这条连接还缺 ' + missing.length + ' 项，补齐就能用：\n'
        + missing.map((m) => '· ' + m).join('\n')
        + '\n\n两种补法（任选其一）：'
        + '\n A. 在 AIROOM 的「设置与连接 → 连接与版本 → 手动配置 → 这条连接 → 环境变量」里补，'
        + '点那一节里的「保存连接」（不是对话框底部那个「保存设置」）。'
        + '\n B. 直接编辑本适配器旁边的 api-keys.json，按服务地址填 key —— 这条不受 AIROOM 加密链路影响，最稳。'
        + (CFG.base ? '\n（API_BASE 已有：' + CFG.base + '）' : '')
        + (CFG.model ? '\n（API_MODEL 已有：' + CFG.model + '）' : ''));
      log('缺配置：' + missing.join(', '));
      return reply(id, { stopReason: 'end_turn' });
    }
    if (!parts.text && !parts.images.length) return reply(id, { stopReason: 'end_turn' });
    // AIROOM 的房间 / 会议协议：正文必须是一个干净的 JSON 对象。
    // AIROOM 的项目流程提交用这套标记：只返回 JSON / airoom.project-flow / 只含上述 JSON
    const flowProtocol = /airoom\.project-flow|只返回 JSON|只含上述 JSON/.test(parts.text || '');
    const structured = flowProtocol || /AIROOM_CONTEXT|只返回一个 JSON 对象/.test(parts.text || '');
    try {
      trace('prompt', sessionId + '  带入历史 ' + (session.history || []).length + ' 条' + (structured ? '  [结构化]' : ''));
      // 项目流程：工具要留着（要读材料），但最终回复必须是干净的 JSON
      const answer = await runTurn(sessionId, session, parts, structured, flowProtocol);
      if (structured) {
        const json = extractJsonObject(answer);
        if (json) chunk(sessionId, json);
        else { chunk(sessionId, String(answer)); log('结构化回复里没找到 JSON 对象'); }
      } else if (!String(answer).trim()) chunk(sessionId, '(模型没有返回内容)');
      return reply(id, { stopReason: 'end_turn' });
    } catch (error) {
      const aborted = error && error.name === 'AbortError';
      const message = aborted ? '这次调用被中止了。' : '调用失败：' + String((error && error.message) || error);
      chunk(sessionId, message);
      log(message);
      return reply(id, { stopReason: aborted ? 'cancelled' : 'end_turn' });
    } finally {
      session.aborter = null;
      // 每轮结束都落盘，AIROOM 重开话题时就能接着聊
      saveSessionToDisk(sessionId, session);
    }
  }

  if (method === 'session/cancel') {
    const session = sessions.get(params.sessionId);
    if (session && session.aborter) { try { session.aborter.abort(); } catch {} }
    return;
  }
  if (method === 'session/close') { sessions.delete(params.sessionId); return reply(id, {}); }

  if (id !== undefined) return fail(id, -32601, '不支持的方法：' + method);
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (data) => {
  buffer += data;
  let index;
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { log('非法 JSON 帧'); continue; }
    if (msg.id !== undefined && msg.method === undefined) {
      const resolve = awaiting.get(msg.id);
      if (resolve) { awaiting.delete(msg.id); resolve(msg); }
      continue;
    }
    Promise.resolve(handle(msg)).catch((error) => {
      log('处理出错：' + ((error && error.stack) || error));
      if (msg && msg.id !== undefined) fail(msg.id, -32603, String((error && error.message) || error));
    });
  }
});
process.stdin.on('end', () => process.exit(0));

await loadPlugins();

if (CFG.tools && CFG.style === 'anthropic') log('提示：API_STYLE=anthropic 时不启用工具（anthropic 分支未实现工具调用）。');
log('已启动 v3。base=' + (CFG.base || '(未填)') + '  模型=' + CFG.model
  + '  风格=' + CFG.style + '  工具=' + (useTools() ? '开' : '关') + '  范围=' + CFG.scope
  + '  插件工具=' + pluginToolDefs.length + '  压缩=' + ((process.env.API_COMPACT || '1') !== '0' ? '开' : '关'));
